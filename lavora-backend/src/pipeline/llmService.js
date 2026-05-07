/**
 * Claude LLM service for the custom voice pipeline.
 * Handles full conversation turns including inline tool execution.
 * Loops automatically until the model produces a pure-text response.
 */

const Anthropic   = require('@anthropic-ai/sdk');
const dayjs       = require('dayjs');
const db          = require('../services/localDbService');
const googleSync  = require('../services/googleSync');
const sms         = require('../services/smsService');
const activityService = require('../services/activityService');
const log         = require('../services/logger').child('LLM');
const { matchService }    = require('../services/extractionService');
const { parseDate, parseTime } = require('../utils/dateParser');

// ── Tool schema definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check if a date/time slot is available. Always call before confirming.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time: { type: 'string', description: 'Time in HH:MM 24-hour format' }
      },
      required: ['date', 'time']
    }
  },
  {
    name: 'book_appointment',
    description: 'Save the appointment after all 5 fields are confirmed and slot is available.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Patient full name' },
        phone:   { type: 'string', description: 'Patient phone number with country code' },
        date:    { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time:    { type: 'string', description: 'Time in HH:MM 24-hour format' },
        service: { type: 'string', description: 'Service or treatment name' }
      },
      required: ['name', 'phone', 'date', 'time', 'service']
    }
  },
  {
    name: 'find_appointment',
    description: 'Look up existing appointments by phone number.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Patient phone number' }
      },
      required: ['phone']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an appointment by ID.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'Appointment ID (APT-...)' }
      },
      required: ['appointment_id']
    }
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new date and time.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'Appointment ID (APT-...)' },
        new_date: { type: 'string', description: 'New date in YYYY-MM-DD' },
        new_time: { type: 'string', description: 'New time in HH:MM 24-hour' }
      },
      required: ['appointment_id', 'new_date', 'new_time']
    }
  },
  {
    name: 'get_services',
    description: 'Return the full list of available services.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_working_hours',
    description: 'Return clinic working hours.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Phone normaliser (mirrors tools.js) ─────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return raw;
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (p.startsWith('00'))                        p = '+' + p.slice(2);
  if (p.startsWith('0') && !p.startsWith('00')) p = '+968' + p.slice(1);
  if (/^\d{8}$/.test(p))                        p = '+968' + p;
  return p;
}

// ── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(name, input, context) {
  log.info(`Tool call: ${name}`, { input });

  switch (name) {

    case 'check_availability': {
      const date = parseDate(input.date) || input.date;
      const time = parseTime(input.time) || input.time;
      const conflict = await db.checkConflict(date, time, null);
      return conflict
        ? { available: false, message: `The slot on ${date} at ${time} is already booked. Please suggest a different time.` }
        : { available: true, date, time };
    }

    case 'book_appointment': {
      const date    = parseDate(input.date)   || input.date;
      const time    = parseTime(input.time)   || input.time;
      const service = matchService(input.service) || input.service;
      const phone   = normalizePhone(input.phone || context.caller_id);

      if (await db.checkConflict(date, time, null)) {
        return { success: false, error: 'That time slot is no longer available. Please choose a different time.' };
      }

      const aptId = `APT-${Date.now()}`;
      const apt = {
        id: aptId, name: input.name, phone,
        service, doctor: '', date, time,
        status: 'Confirmed', source: 'AI Voice',
        callDuration: '',
        notes: `Pipeline session: ${context.sessionId || 'unknown'}`,
        timestamp: new Date().toISOString(), calendarEventId: ''
      };

      await db.appendAppointment(apt);
      googleSync.book(apt);
      sms.sendBookingConfirmation(apt);
      await activityService.addActivity({
        actor: 'AI Voice',
        actionType: activityService.ACTION_TYPES.BOOKED,
        patientName: input.name,
        details: `${service} on ${date} at ${time} | ID: ${aptId}`
      });

      return { success: true, appointment_id: aptId, date, time, service, name: input.name, phone };
    }

    case 'find_appointment': {
      const normalized = normalizePhone(input.phone);
      const all = await db.getAllAppointments();
      const matches = all
        .filter(a => a.status !== 'Cancelled' && normalizePhone(a.phone) === normalized)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      const apt = matches[matches.length - 1];
      return apt
        ? { found: true, appointment_id: apt.id, name: apt.name, service: apt.service, date: apt.date, time: apt.time }
        : { found: false, message: 'No upcoming appointment found for this number.' };
    }

    case 'cancel_appointment': {
      const apt = await db.getAppointmentById(input.appointment_id);
      if (!apt) return { success: false, error: 'Appointment not found.' };
      await db.cancelAppointment(apt.id);
      googleSync.cancel(apt);
      sms.sendCancellationConfirmation(apt);
      await activityService.addActivity({
        actor: 'AI Voice',
        actionType: activityService.ACTION_TYPES.CANCELLED,
        patientName: apt.name,
        details: `ID: ${apt.id} | ${apt.service} on ${apt.date}`
      });
      return { success: true, service: apt.service, date: apt.date, time: apt.time };
    }

    case 'reschedule_appointment': {
      const apt = await db.getAppointmentById(input.appointment_id);
      if (!apt) return { success: false, error: 'Appointment not found.' };

      const newDate = parseDate(input.new_date) || input.new_date;
      const newTime = parseTime(input.new_time) || input.new_time;

      if (await db.checkConflict(newDate, newTime, null)) {
        return { success: false, error: `The slot on ${newDate} at ${newTime} is already booked. Please choose a different time.` };
      }

      await db.updateAppointment(apt.id, { date: newDate, time: newTime, status: 'Confirmed' });
      const rescheduled = { ...apt, date: newDate, time: newTime };
      googleSync.reschedule(rescheduled);
      sms.sendRescheduleConfirmation(rescheduled);
      await activityService.addActivity({
        actor: 'AI Voice',
        actionType: activityService.ACTION_TYPES.RESCHEDULED,
        patientName: apt.name,
        details: `ID: ${apt.id} | ${apt.date} → ${newDate} ${newTime}`
      });
      return { success: true, service: apt.service, date: newDate, time: newTime };
    }

    case 'get_services':
      return {
        services: ['Botox','Fillers','Profhilo','Thread Lifting','Endolift','PRP','Mesotherapy',
          'Exosomes','Stem Cell','Frax Pro','Picoway','RedTouch','Chemical Peels',
          'Laser Hair Removal','Onda Plus','Redustim','Body Wraps',
          'Aesthetic Gynecology','Medical Skin Care','Dermatology','Consultation']
      };

    case 'get_working_hours':
      return { hours: 'Saturday to Thursday, 9:00 AM to 6:00 PM. Closed on Fridays.' };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Confirmation text builders (bypass LLM to guarantee correct output) ─────

function buildBookingConfirmation(booking, lang) {
  const { service, date, time, phone } = booking;
  const d = require('dayjs')(date);
  const t = require('dayjs')(`2000-01-01T${time}:00`);
  if (lang === 'ar') {
    return `تم تأكيد موعدك لـ ${service} بتاريخ ${d.format('D/M/YYYY')} الساعة ${time}. سنتواصل معك على ${phone}. شكراً على اتصالك بعيادة لافورا. مع السلامة.`;
  }
  return `Your ${service} appointment is confirmed for ${d.format('MMMM D')} at ${t.format('h:mm A')}. We will reach you at ${phone}. Thank you for calling Lavora Clinic. Goodbye.`;
}

function buildCancelConfirmation(result, lang) {
  const { service, date } = result;
  const d = require('dayjs')(date);
  if (lang === 'ar') {
    return `تم إلغاء موعدك لـ ${service} بتاريخ ${d.format('D/M/YYYY')}. شكراً على اتصالك بعيادة لافورا. مع السلامة.`;
  }
  return `Your ${service} appointment on ${d.format('MMMM D')} has been cancelled. Thank you for calling Lavora Clinic. Goodbye.`;
}

function buildRescheduleConfirmation(result, lang) {
  const { service, date, time } = result;
  const d = require('dayjs')(date);
  const t = require('dayjs')(`2000-01-01T${time}:00`);
  if (lang === 'ar') {
    return `تم تغيير موعدك لـ ${service} إلى ${d.format('D/M/YYYY')} الساعة ${time}. شكراً على اتصالك بعيادة لافورا. مع السلامة.`;
  }
  return `Your ${service} appointment has been rescheduled to ${d.format('MMMM D')} at ${t.format('h:mm A')}. Thank you for calling Lavora Clinic. Goodbye.`;
}

// ── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  const today = dayjs().format('YYYY-MM-DD');
  const { caller_id, is_returning, patient_name, last_service, last_visit_date } = context;

  const callerCtx = is_returning === 'true'
    ? `The caller is a RETURNING PATIENT. Name: ${patient_name}. Last service: ${last_service} on ${last_visit_date}. Greet them by name.`
    : 'This is a NEW PATIENT. Do not mention any prior visits.';

  const langInstruction = context.language === 'ar'
    ? 'SESSION LANGUAGE: Arabic. Respond ONLY in Arabic script. Keep service names as-is (Botox, Fillers, etc.). When listing services, name 4-5 and add "وغيرها". NEVER start a response with "عذرا" or any apology — go straight to the answer. Example: if asked about services, say "نقدم في عيادة لافورا: بوتوكس، فيلر، ليزر إزالة الشعر، وغيرها. بأي خدمة يمكنني مساعدتك؟"'
    : 'SESSION LANGUAGE: English.';

  const langStep = context.language === 'ar'
    ? '1. Language already chosen: Arabic. Skip asking — proceed directly to step 2.'
    : '1. Ask the patient if they prefer Arabic or English. Switch FULLY to their chosen language for ALL remaining responses.';

  return `You are the AI voice receptionist for Lavora Clinic in Muscat, Oman.
Your name is Lavora Assistant. You speak in a professional, warm, refined tone.
Today is ${today}. The caller's phone number is ${caller_id}.
${langInstruction}
${callerCtx}

CONVERSATION FLOW — follow this order exactly:
${langStep}
2. Ask what service or treatment they want.
3. Ask for their preferred appointment day.
4. Ask for their preferred appointment time.
5. Ask for their full name.
6. Ask: "Would you like us to contact you on ${caller_id}, or a different number?"
   - Same number → use ${caller_id}.
   - Different number → use the number they provide.
7. Call check_availability. Say nothing — just call the tool.
8. check_availability returns { "available": true } → call book_appointment immediately as your very next action. No text. No confirmation. Just call the tool.
   check_availability returns { "available": false } → tell the patient that slot is taken and ask for a different time.
9. book_appointment returns { "success": true } → say nothing. The system sends the confirmation automatically.

For CANCELLATIONS: call find_appointment → confirm with patient → cancel_appointment.
For RESCHEDULING: call find_appointment → get new date/time → check_availability → reschedule_appointment.

TOOL CALL RULES:
- check_availability and book_appointment are always called in the SAME conversation turn, one after the other.
  First: call check_availability and wait for its result.
  Then: if available is true, call book_appointment immediately — do not say anything between the two tool calls.
- A result of { "available": true } means the slot IS free. Do not announce this — just call book_appointment.
- A result of { "success": true } means booking SUCCEEDED. Say nothing — the system handles the confirmation.

Available services (English name / Arabic name):
Botox (بوتوكس), Fillers (فيلر), Profhilo (برو فيلو), Thread Lifting (خيوط الشد), Endolift (انديليفت), PRP (حقن البلازما / PRP), Mesotherapy (ميزوثيرابي), Exosomes (إكسوسومز), Stem Cell (خلايا جذعية), Frax Pro (فراكس برو), Picoway (بيكاواي), RedTouch (ريد تاتش), Chemical Peels (تقشير كيميائي), Laser Hair Removal (إزالة الشعر بالليزر), Onda Plus (أوندا بلاس), Redustim (ريدوستيم), Body Wraps (لفائف الجسم), Aesthetic Gynecology (طب نسائي تجميلي), Medical Skin Care (عناية طبية بالبشرة), Dermatology (أمراض الجلد), Consultation (استشارة).
When booking, always pass the English service name to the tool.

RULES:
- Keep every response to ONE or TWO short sentences. Ask one question at a time.
- No markdown, no lists, no formatting of any kind. Plain spoken sentences only.
- Never start a response with "sorry", "I apologize", "عذرا", or any apology unless there is an actual error.
- Never repeat a sentence already said in this call.
- Do not give medical advice. Say: "Our specialists can advise — shall I book a consultation?"
- Do not mention IDs, technical details, or system errors.
- If a tool returns an error, say: "Our team will confirm the details with you shortly."`;
}

// ── Main chat function ───────────────────────────────────────────────────────

/**
 * Run one full conversation turn (with automatic tool execution loop).
 * Returns { text: string, history: array }.
 */
async function chat(history, context) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(context);

  // Work on a mutable copy so we can append tool results mid-loop
  const msgs = [...history];

  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   msgs,
      tools:      TOOLS,
    });

    // Append the assistant turn
    msgs.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(b => b.type === 'tool_use');

    // Pure text response — we're done.
    // NOTE: do NOT short-circuit on stop_reason === 'end_turn' alone;
    // Claude can return tool_use blocks with stop_reason 'end_turn' and
    // skipping them would silently drop bookings/cancellations.
    if (toolUses.length === 0) {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(' ')
        .trim();
      return { text, history: msgs };
    }

    // Execute all tool calls in parallel, then add results
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        let result;
        try {
          result = await executeTool(tu.name, tu.input, context);
          log.info(`Tool ${tu.name} result: ${JSON.stringify(result)}`);
        } catch (err) {
          log.error(`Tool ${tu.name} threw: ${err.message}`);
          result = { error: err.message };
        }
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result)
        };
      })
    );

    // Intercept terminal tool successes — generate confirmation text directly
    // so Claude cannot hallucinate "not available" after a successful booking.
    const lang = context.language || 'en';
    for (const tu of toolUses) {
      const tr = toolResults.find(r => r.tool_use_id === tu.id);
      if (!tr) continue;
      let result;
      try { result = JSON.parse(tr.content); } catch { continue; }
      if (tu.name === 'book_appointment' && result.success) {
        msgs.push({ role: 'user', content: toolResults });
        return { text: buildBookingConfirmation(result, lang), history: msgs };
      }
      if (tu.name === 'cancel_appointment' && result.success) {
        msgs.push({ role: 'user', content: toolResults });
        return { text: buildCancelConfirmation(result, lang), history: msgs };
      }
      if (tu.name === 'reschedule_appointment' && result.success) {
        msgs.push({ role: 'user', content: toolResults });
        return { text: buildRescheduleConfirmation(result, lang), history: msgs };
      }
    }

    msgs.push({ role: 'user', content: toolResults });
  }

  // Fallback if somehow we exhaust rounds
  log.warn('LLM tool loop exhausted max rounds');
  return { text: 'Our team will confirm the details with you shortly. Thank you for calling Lavora Clinic.', history: msgs };
}

module.exports = { chat };
