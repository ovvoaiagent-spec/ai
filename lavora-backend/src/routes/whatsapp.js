/**
 * WhatsApp Business API receptionist.
 * Handles webhook verification, incoming messages, Claude AI conversations,
 * and CRM tool execution (book / reschedule / cancel / inquire).
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const db              = require('../services/localDbService');
const googleSync      = require('../services/googleSync');
const activityService = require('../services/activityService');
const log             = require('../services/logger').child('WHATSAPP');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService }         = require('../services/extractionService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN || 'testclinic_verify_2024';
const WA_API          = () => `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// ─── In-memory conversation sessions (per sender phone) ───────────────────────
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle timeout

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL_MS) sessions.delete(phone);
  }
}, 5 * 60 * 1000);

// ─── Webhook verification (GET) — required by Meta ────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log.info('WhatsApp webhook verified successfully');
    return res.status(200).send(challenge);
  }
  log.warn(`WhatsApp webhook verification failed — token mismatch`);
  res.status(403).send('Forbidden');
});

// ─── Incoming messages (POST) ─────────────────────────────────────────────────
router.post('/whatsapp', async (req, res) => {
  // Meta requires 200 within 20 s — acknowledge immediately, process async
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return; // status updates (delivered/read), ignore

    const message = value.messages[0];
    const from    = message.from; // e.g. "96512345678"

    // Mark message as read
    markRead(from, message.id).catch(() => {});

    if (message.type !== 'text') {
      await sendWA(from, 'Sorry, I can only handle text messages right now. Please type your request and I will be happy to help!');
      return;
    }

    const userText = message.text.body?.trim();
    if (!userText) return;

    log.info(`[${from}] → "${userText.substring(0, 100)}"`);

    // Get / create session
    let session = sessions.get(from);
    if (!session) {
      session = { messages: [], lastActivity: Date.now() };
      sessions.set(from, session);
    }
    session.lastActivity = Date.now();
    session.messages.push({ role: 'user', content: userText });

    // Run AI conversation
    const reply = await runConversation(from, session);

    await sendWA(from, reply);

    session.messages.push({ role: 'assistant', content: reply });

    // Keep history bounded
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  } catch (err) {
    log.error(`WhatsApp handler error: ${err.message}`, { stack: err.stack });
  }
});

// ─── Send WhatsApp text message ───────────────────────────────────────────────
async function sendWA(to, text) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    log.warn('WhatsApp not configured — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN missing');
    return;
  }
  try {
    await axios.post(WA_API(), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    log.error(`WhatsApp send failed → ${to}: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function markRead(to, messageId) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) return;
  await axios.post(WA_API(), {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId
  }, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// ─── Claude tool definitions ──────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check whether a specific date/time slot is available.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD or natural language (tomorrow, next Monday)' },
        time: { type: 'string', description: 'Time in HH:MM or natural language (3pm, afternoon)' }
      },
      required: ['date', 'time']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a new appointment. The patient phone is already known from WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Patient full name' },
        phone:   { type: 'string', description: "Patient phone — use the caller's WhatsApp number if they don't provide one" },
        date:    { type: 'string' },
        time:    { type: 'string' },
        service: { type: 'string', description: 'Requested service' }
      },
      required: ['name', 'phone', 'date', 'time', 'service']
    }
  },
  {
    name: 'find_appointment',
    description: 'Look up an existing appointment by phone number.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string' }
      },
      required: ['phone']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'Appointment ID if known' },
        phone:          { type: 'string', description: 'Patient phone if ID not known' }
      }
    }
  },
  {
    name: 'reschedule_appointment',
    description: 'Move an existing appointment to a new date and time.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        phone:          { type: 'string' },
        new_date:       { type: 'string' },
        new_time:       { type: 'string' }
      },
      required: ['new_date', 'new_time']
    }
  },
  {
    name: 'get_services',
    description: 'Return the list of services the clinic offers.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_working_hours',
    description: 'Return clinic working hours.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ─── Agentic conversation loop ────────────────────────────────────────────────
async function runConversation(callerPhone, session) {
  const system   = buildSystemPrompt(callerPhone);
  let   messages = [...session.messages];

  for (let turn = 0; turn < 6; turn++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system,
        tools:      TOOLS,
        messages
      });
    } catch (err) {
      log.error(`Claude API error: ${err.message}`);
      return 'Sorry, I am having technical difficulties. Please call us directly or try again in a moment.';
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text?.trim() || "I'm here to help — how can I assist you?";
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await executeTool(block.name, block.input, callerPhone);
        log.info(`Tool ${block.name} → ${JSON.stringify(result).substring(0, 120)}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'Sorry, I could not process that. Please try again or call us directly.';
}

// ─── Tool execution (direct DB access — no HTTP round-trip) ───────────────────
function normalizePhone(raw) {
  if (!raw) return raw;
  let p = String(raw).replace(/[\s\-().+]/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0') && p.length === 9) p = '968' + p.slice(1);
  if (/^\d{8}$/.test(p)) p = '968' + p;
  return p; // stored without '+' to match WhatsApp format
}

async function findActiveAppointment(phone) {
  const norm = normalizePhone(phone);
  const all  = await db.getAllAppointments();
  const hits  = all.filter(a =>
    a.status !== 'Cancelled' &&
    (normalizePhone(a.phone) === norm || a.phone === phone || a.phone === '+' + norm)
  );
  hits.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return hits[hits.length - 1] || null;
}

async function executeTool(name, input, callerPhone) {
  try {
    switch (name) {

      case 'check_availability': {
        const d = parseDate(input.date) || input.date;
        const t = parseTime(input.time) || input.time;
        const conflict = await db.checkConflict(d, t);
        return conflict
          ? { available: false, result: `${d} at ${t} is already booked. Please choose a different time.` }
          : { available: true,  result: `${d} at ${t} is available.`, date: d, time: t };
      }

      case 'book_appointment': {
        const phone   = normalizePhone(input.phone || callerPhone);
        const d       = parseDate(input.date)       || input.date;
        const t       = parseTime(input.time)       || input.time;
        const service = matchService(input.service) || input.service;

        if (await db.checkConflict(d, t))
          return { success: false, result: 'That slot just got taken. Please suggest a different time.' };

        const aptId = `APT-${Date.now()}`;
        const apt = {
          id: aptId, name: input.name, phone,
          service, doctor: '',
          date: d, time: t,
          status: 'Confirmed', source: 'WhatsApp',
          callDuration: '', notes: '',
          timestamp: new Date().toISOString(),
          calendarEventId: ''
        };

        await db.appendAppointment(apt);
        googleSync.book(apt);

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.BOOKED,
          patientName: input.name,
          details: `${service} on ${d} at ${t} | ID: ${aptId}`
        });

        log.info(`Booked ${aptId} via WhatsApp`);
        return { success: true, result: 'Appointment booked successfully.', appointment_id: aptId, date: d, time: t, service };
      }

      case 'find_appointment': {
        const phone = input.phone || callerPhone;
        const apt   = await findActiveAppointment(phone);
        if (!apt) return { found: false, result: 'No upcoming appointment found for this number.' };
        return { found: true, result: `Found your ${apt.service} on ${apt.date} at ${apt.time}.`, appointment_id: apt.id, service: apt.service, date: apt.date, time: apt.time, status: apt.status };
      }

      case 'cancel_appointment': {
        const apt = input.appointment_id
          ? await db.getAppointmentById(input.appointment_id)
          : await findActiveAppointment(input.phone || callerPhone);

        if (!apt) return { success: false, result: 'Could not find that appointment to cancel.' };

        await db.cancelAppointment(apt.id);
        googleSync.cancel(apt);

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.CANCELLED,
          patientName: apt.name,
          details: `${apt.service} on ${apt.date} at ${apt.time} | ID: ${apt.id}`
        });

        return { success: true, result: 'Appointment cancelled successfully.', service: apt.service, date: apt.date, time: apt.time };
      }

      case 'reschedule_appointment': {
        const apt = input.appointment_id
          ? await db.getAppointmentById(input.appointment_id)
          : await findActiveAppointment(input.phone || callerPhone);

        if (!apt) return { success: false, result: 'Could not find that appointment to reschedule.' };

        const newDate = parseDate(input.new_date) || input.new_date;
        const newTime = parseTime(input.new_time) || input.new_time;

        if (await db.checkConflict(newDate, newTime))
          return { success: false, result: `${newDate} at ${newTime} is already taken. Please suggest another time.` };

        await db.updateAppointment(apt.id, { date: newDate, time: newTime, status: 'Confirmed' });
        const updated = { ...apt, date: newDate, time: newTime };
        googleSync.reschedule(updated);

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.RESCHEDULED,
          patientName: apt.name,
          details: `${apt.service} → ${newDate} ${newTime} | ID: ${apt.id}`
        });

        return { success: true, result: 'Appointment rescheduled.', service: apt.service, date: newDate, time: newTime };
      }

      case 'get_services':
        return {
          result: 'Services available at Test Clinic.',
          services: ['Botox','Fillers','Profhilo','Thread Lifting','Endolift','PRP','Mesotherapy','Exosomes','Stem Cell','Frax Pro','Picoway','RedTouch','Chemical Peels','Laser Hair Removal','Onda Plus','Redustim','Body Wraps','Aesthetic Gynecology','Medical Skin Care','Dermatology','Consultation']
        };

      case 'get_working_hours':
        return { result: 'Test Clinic is open Saturday through Thursday, 9:00 AM to 6:00 PM. Closed on Fridays.' };

      default:
        return { result: 'Unknown tool.' };
    }
  } catch (err) {
    log.error(`executeTool(${name}) error: ${err.message}`);
    return { result: 'Technical issue. Please try again or call us directly.' };
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(callerPhone) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return `You are the AI receptionist for Test Clinic, a premium aesthetic and medical clinic. You are chatting via WhatsApp.

TODAY: ${today}
PATIENT WHATSAPP NUMBER: ${callerPhone}

LANGUAGE RULE:
Detect the language the patient writes in (Arabic or English) and reply in the same language every time.
If they mix both, follow the dominant language. Never ask them to choose a language — just mirror theirs.

YOUR ROLE:
- Book new appointments
- Find, reschedule, or cancel existing appointments
- Answer questions about services, pricing, working hours
- Escalate complex or medical questions to the clinic team

CLINIC INFO:
Name: Test Clinic
Hours: Saturday to Thursday, 9:00 AM to 6:00 PM. Closed Fridays.
Services: Botox, Fillers, Profhilo, Thread Lifting, Endolift, PRP, Mesotherapy, Exosomes, Stem Cell, Frax Pro, Picoway, RedTouch, Chemical Peels, Laser Hair Removal, Onda Plus, Redustim, Body Wraps, Aesthetic Gynecology, Medical Skin Care, Dermatology, Consultation.

BOOKING RULES:
1. Collect: full name, desired service, preferred date, preferred time.
2. Phone is already known: ${callerPhone} — use it unless the patient gives a different number.
3. Always call check_availability before confirming a booking.
4. Appointments only during working hours (Sat–Thu, 9 AM–6 PM).
5. Confirm all details with the patient before calling book_appointment.

STYLE:
- Warm, friendly, professional
- SHORT messages — this is WhatsApp, not email. 2-4 sentences max per reply.
- Plain text only — no asterisks, no bullet points with dashes, no markdown
- One question at a time if you need more info
- Always confirm success clearly (e.g. "Your appointment is confirmed for Monday 12 May at 3:00 PM")

ESCALATION:
If the patient asks a medical question you cannot answer, or has a complaint or emergency, reply:
"For this I recommend speaking directly with our team. Please call us or visit the clinic and they will take great care of you."`;
}

module.exports = router;
