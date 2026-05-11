/**
 * WhatsApp Business API — Lara, AI receptionist for Test Clinic.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const db              = require('../services/localDbService');
const googleSync      = require('../services/googleSync');
const activityService = require('../services/activityService');
const notify          = require('../services/notificationService');
const log             = require('../services/logger').child('WHATSAPP');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService }         = require('../services/extractionService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN || 'testclinic_verify_2024';
const WA_API          = () => `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// ─── In-memory conversation sessions ─────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL_MS) sessions.delete(phone);
  }
}, 5 * 60 * 1000);

// ─── Webhook verification (GET) ───────────────────────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ─── Incoming messages (POST) ─────────────────────────────────────────────────
router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const from    = message.from;

    markRead(from, message.id).catch(() => {});

    if (message.type !== 'text') {
      await sendWA(from, 'آسف، أقدر أتعامل مع الرسائل النصية فقط. Sorry, I can only handle text messages right now.');
      return;
    }

    const userText = message.text.body?.trim();
    if (!userText) return;

    log.info(`[${from}] → "${userText.substring(0, 100)}"`);

    let session = sessions.get(from);
    if (!session) {
      // New session: silently look up patient in CRM
      const profile = await lookupPatientProfile(from);
      session = { messages: [], lastActivity: Date.now(), profile };
      sessions.set(from, session);
    }
    session.lastActivity = Date.now();
    session.messages.push({ role: 'user', content: userText });

    const reply = await runConversation(from, session);

    await sendWA(from, reply);

    session.messages.push({ role: 'assistant', content: reply });

    if (session.messages.length > 24) session.messages = session.messages.slice(-24);

  } catch (err) {
    log.error(`WhatsApp handler error: ${err.message}`, { stack: err.stack });
  }
});

// ─── Silent patient CRM lookup ────────────────────────────────────────────────
async function lookupPatientProfile(whatsappPhone) {
  try {
    const norm = normalizePhone(whatsappPhone);
    const all  = await db.getAllAppointments();
    const mine = all.filter(a =>
      normalizePhone(a.phone) === norm || a.phone === whatsappPhone || a.phone === '+' + norm
    );
    if (!mine.length) return null;

    mine.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const latest   = mine[0];
    const upcoming = mine.filter(a => a.status !== 'Cancelled' && a.date >= new Date().toISOString().split('T')[0]);
    upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    return {
      name:               latest.name,
      lastService:        latest.service,
      lastDate:           latest.date,
      lastDoctor:         latest.doctor || null,
      upcomingAppointment: upcoming[0] || null,
      totalVisits:        mine.length
    };
  } catch {
    return null;
  }
}

// ─── WhatsApp send helpers ────────────────────────────────────────────────────
async function sendWA(to, text) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    log.warn('WhatsApp not configured — notification skipped');
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
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
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

// ─── Department helpers ───────────────────────────────────────────────────────
const LASER_SERVICES    = ['laser hair removal', 'laser hair', 'full body laser', 'partial laser'];
const SLIMMING_SERVICES = ['body wrap', 'body wraps', 'redustim', 'onda plus', 'onda', 'slimming'];
const GYNO_SERVICES     = ['gynecology', 'gynaecology', 'gynecolog', 'vaginal', 'pelvic', 'intimate', 'vaginoplasty', 'labiaplasty'];

function getDepartment(service) {
  const s = (service || '').toLowerCase();
  if (GYNO_SERVICES.some(k => s.includes(k)))    return 'gynecology';
  if (LASER_SERVICES.some(k => s.includes(k)))   return 'laser';
  if (SLIMMING_SERVICES.some(k => s.includes(k))) return 'slimming';
  return 'beauty';
}

const DEPT_CAPACITY  = { laser: 3, slimming: 4, beauty: 1, gynecology: 1 };
const DEPT_CLOSE_HH  = { laser: 23, slimming: 20, beauty: 20, gynecology: 20 };
const DEPT_SLOT_MINS = { gynecology: 30 };
const OPEN_HH        = 8;
const REST_START_HH  = 14;
const REST_END_HH    = 15;

function timeToMinutes(t) {
  const [h, m] = (t || '').split(':').map(Number);
  return h * 60 + (m || 0);
}

function formatCloseTime(hh) {
  if (hh === 23) return '11:00 PM';
  return hh > 12 ? `${hh - 12}:00 PM` : `${hh}:00 AM`;
}

function validateSlot(dateStr, timeStr, department) {
  const date = new Date(dateStr + 'T00:00:00');
  const dow  = date.getDay();
  if (dow === 5) return 'friday_closed';

  const mins      = timeToMinutes(timeStr);
  const openMins  = OPEN_HH * 60;
  const restStart = REST_START_HH * 60;
  const restEnd   = REST_END_HH * 60;
  const closeHH   = DEPT_CLOSE_HH[department] || 20;
  const closeMins = closeHH * 60;

  if (mins < openMins)                     return 'before_open';
  if (mins >= restStart && mins < restEnd) return 'rest_time';
  if (mins >= closeMins)                   return `after_close:${closeHH}`;
  return null;
}

async function countSlotBookings(date, time, department) {
  const all     = await db.getAllAppointments();
  const reqMins = timeToMinutes(time);
  const slotWin = DEPT_SLOT_MINS[department] || 0;

  return all.filter(a => {
    if (a.status === 'Cancelled') return false;
    if (a.date !== date)          return false;
    if (getDepartment(a.service) !== department) return false;
    if (slotWin === 0) return a.time === time;
    return Math.abs(timeToMinutes(a.time) - reqMins) < slotWin;
  }).length;
}

// Returns up to maxSlots available time strings for a given date + service
async function getAvailableSlots(dateStr, service, maxSlots = 4) {
  const dept      = getDepartment(service);
  const closeHH   = DEPT_CLOSE_HH[dept];
  const stepMins  = dept === 'gynecology' ? 30 : 60;
  const available = [];

  const date = new Date(dateStr + 'T00:00:00');
  if (date.getDay() === 5) return [];

  for (let totalMins = OPEN_HH * 60; totalMins < closeHH * 60; totalMins += stepMins) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    if (h >= REST_START_HH && h < REST_END_HH) continue;
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const booked  = await countSlotBookings(dateStr, timeStr, dept);
    if (booked < DEPT_CAPACITY[dept]) {
      available.push(timeStr);
      if (available.length >= maxSlots) break;
    }
  }
  return available;
}

// ─── Claude tool definitions ──────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check if a date/time/service slot is available, enforcing department capacity and time rules.',
    input_schema: {
      type: 'object',
      properties: {
        date:    { type: 'string', description: 'Date in YYYY-MM-DD or natural language' },
        time:    { type: 'string', description: 'Time in HH:MM or natural language' },
        service: { type: 'string', description: 'Service name — determines department and capacity' }
      },
      required: ['date', 'time', 'service']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment in the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string' },
        phone:   { type: 'string', description: "Patient phone — use WhatsApp number if not provided" },
        date:    { type: 'string' },
        time:    { type: 'string' },
        service: { type: 'string' },
        doctor:  { type: 'string', description: 'Doctor name (required for Beauty and Gynecology, empty for Slimming/Laser)' }
      },
      required: ['name', 'phone', 'date', 'time', 'service']
    }
  },
  {
    name: 'find_appointment',
    description: 'Find upcoming appointment by phone number.',
    input_schema: {
      type: 'object',
      properties: { phone: { type: 'string' } },
      required: ['phone']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        phone:          { type: 'string' }
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
    name: 'get_available_slots',
    description: 'Get up to 4 available time slots for a given date and service. Use this to proactively offer times to the client — never ask them to guess.',
    input_schema: {
      type: 'object',
      properties: {
        date:    { type: 'string', description: 'Date in YYYY-MM-DD or natural language' },
        service: { type: 'string', description: 'Service name — determines department rules' }
      },
      required: ['date', 'service']
    }
  },
  {
    name: 'get_services',
    description: 'Return clinic services by department.',
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
  const system   = buildSystemPrompt(callerPhone, session.profile);
  let   messages = [...session.messages];

  for (let turn = 0; turn < 8; turn++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system,
        tools:      TOOLS,
        messages
      });
    } catch (err) {
      log.error(`Claude API error: ${err.message}`);
      return 'عذراً، حدث خطأ تقني. Sorry, technical issue — please try again or call us directly.';
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text?.trim() || "كيف أقدر أساعدك؟ How can I help you?";
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await executeTool(block.name, block.input, callerPhone);
        log.info(`Tool ${block.name} → ${JSON.stringify(result).substring(0, 140)}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'عذراً، ما قدرت أكمل طلبك. Sorry, could not process that — please try again.';
}

// ─── Tool execution ───────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return raw;
  let p = String(raw).replace(/[\s\-().+]/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0') && p.length === 9) p = '968' + p.slice(1);
  if (/^\d{8}$/.test(p)) p = '968' + p;
  return p;
}

async function findActiveAppointment(phone) {
  const norm = normalizePhone(phone);
  const all  = await db.getAllAppointments();
  const hits = all.filter(a =>
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
        const d    = parseDate(input.date) || input.date;
        const t    = parseTime(input.time) || input.time;
        const svc  = input.service || '';
        const dept = getDepartment(svc);
        const cap  = DEPT_CAPACITY[dept];

        const err = validateSlot(d, t, dept);
        if (err === 'friday_closed') return { available: false, result: 'Clinic is closed on Fridays.' };
        if (err === 'before_open')   return { available: false, result: 'Clinic opens at 8:00 AM.' };
        if (err === 'rest_time')     return { available: false, result: 'No appointments 2:00 PM–3:00 PM (rest break). Next available: 1:00 PM or 3:00 PM onward.' };
        if (err?.startsWith('after_close')) return { available: false, result: `${dept} department closes at ${formatCloseTime(DEPT_CLOSE_HH[dept])}. Please suggest an earlier time.` };

        const booked = await countSlotBookings(d, t, dept);
        if (booked >= cap) return { available: false, result: `That slot is fully booked (${dept}). Please suggest a different time.`, slots_taken: booked, capacity: cap };

        return { available: true, result: `${d} at ${t} is available.`, date: d, time: t, department: dept, slots_remaining: cap - booked };
      }

      case 'book_appointment': {
        const phone   = normalizePhone(input.phone || callerPhone);
        const d       = parseDate(input.date)       || input.date;
        const t       = parseTime(input.time)       || input.time;
        const service = matchService(input.service) || input.service;
        const doctor  = input.doctor || '';
        const dept    = getDepartment(service);
        const cap     = DEPT_CAPACITY[dept];

        const err = validateSlot(d, t, dept);
        if (err === 'friday_closed') return { success: false, result: 'Clinic is closed on Fridays.' };
        if (err === 'rest_time')     return { success: false, result: 'No appointments 2:00 PM–3:00 PM (rest break).' };
        if (err === 'before_open')   return { success: false, result: 'Clinic opens at 8:00 AM.' };
        if (err?.startsWith('after_close')) return { success: false, result: `${dept} department closes at ${formatCloseTime(DEPT_CLOSE_HH[dept])}.` };

        const booked = await countSlotBookings(d, t, dept);
        if (booked >= cap) return { success: false, result: `That slot is fully booked for ${dept}. Please suggest a different time.` };

        const aptId = `APT-${Date.now()}`;
        const apt = {
          id: aptId, name: input.name, phone,
          service, doctor,
          date: d, time: t,
          status: 'Confirmed', source: 'WhatsApp',
          callDuration: '', notes: '',
          timestamp: new Date().toISOString(),
          calendarEventId: ''
        };

        await db.appendAppointment(apt);
        googleSync.book(apt);

        // Send immediate reminder if appointment is within 24 hours
        const aptDateTime = new Date(`${d}T${t}:00`);
        const hoursUntil  = (aptDateTime - Date.now()) / 3600000;
        if (hoursUntil > 0 && hoursUntil <= 24) {
          notify.sendReminder(apt);
          await db.updateAppointment(aptId, { reminderSent: true });
        }

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.BOOKED,
          patientName: input.name,
          details: `${service}${doctor ? ' with ' + doctor : ''} on ${d} at ${t} | ID: ${aptId}`
        });

        log.info(`Booked ${aptId} via WhatsApp — ${service}${doctor ? ' / ' + doctor : ''}`);
        return { success: true, result: 'Appointment booked successfully.', appointment_id: aptId, date: d, time: t, service, doctor };
      }

      case 'find_appointment': {
        const phone = input.phone || callerPhone;
        const apt   = await findActiveAppointment(phone);
        if (!apt) return { found: false, result: 'No upcoming appointment found for this number.' };
        return { found: true, result: `Appointment found: ${apt.service}${apt.doctor ? ' with ' + apt.doctor : ''} on ${apt.date} at ${apt.time}.`, appointment_id: apt.id, service: apt.service, doctor: apt.doctor || '', date: apt.date, time: apt.time, status: apt.status, name: apt.name };
      }

      case 'cancel_appointment': {
        const apt = input.appointment_id
          ? await db.getAppointmentById(input.appointment_id)
          : await findActiveAppointment(input.phone || callerPhone);

        if (!apt) return { success: false, result: 'Could not find that appointment.' };

        await db.cancelAppointment(apt.id);
        googleSync.cancel(apt);
        notify.sendCancellationConfirmation(apt);

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.CANCELLED,
          patientName: apt.name,
          details: `${apt.service} on ${apt.date} at ${apt.time} | ID: ${apt.id}`
        });

        return { success: true, result: 'Appointment cancelled.', service: apt.service, date: apt.date, time: apt.time };
      }

      case 'reschedule_appointment': {
        const apt = input.appointment_id
          ? await db.getAppointmentById(input.appointment_id)
          : await findActiveAppointment(input.phone || callerPhone);

        if (!apt) return { success: false, result: 'Could not find that appointment.' };

        const newDate = parseDate(input.new_date) || input.new_date;
        const newTime = parseTime(input.new_time) || input.new_time;
        const dept    = getDepartment(apt.service);

        const err = validateSlot(newDate, newTime, dept);
        if (err === 'friday_closed') return { success: false, result: 'Clinic is closed on Fridays.' };
        if (err === 'rest_time')     return { success: false, result: 'No appointments 2:00 PM–3:00 PM (rest break).' };
        if (err?.startsWith('after_close')) return { success: false, result: `${dept} closes at ${formatCloseTime(DEPT_CLOSE_HH[dept])}.` };

        const booked = await countSlotBookings(newDate, newTime, dept);
        if (booked >= DEPT_CAPACITY[dept]) return { success: false, result: `That slot is fully booked. Please suggest another time.` };

        await db.updateAppointment(apt.id, { date: newDate, time: newTime, status: 'Confirmed', reminderSent: false });
        const updated = { ...apt, date: newDate, time: newTime };
        googleSync.reschedule(updated);
        notify.sendRescheduleConfirmation(updated);

        await activityService.addActivity({
          actor: 'WhatsApp AI', actionType: activityService.ACTION_TYPES.RESCHEDULED,
          patientName: apt.name,
          details: `${apt.service} → ${newDate} ${newTime} | ID: ${apt.id}`
        });

        return { success: true, result: 'Appointment rescheduled.', service: apt.service, doctor: apt.doctor || '', date: newDate, time: newTime };
      }

      case 'get_available_slots': {
        const d      = parseDate(input.date) || input.date;
        const svc    = input.service || '';
        const dept   = getDepartment(svc);
        const slots  = await getAvailableSlots(d, svc);
        const date   = new Date(d + 'T00:00:00');
        if (date.getDay() === 5) return { available: false, slots: [], result: 'Clinic is closed on Fridays. Please choose another day.' };
        if (!slots.length)       return { available: false, slots: [], result: `No available slots for ${dept} on ${d}. Please try a different date.` };
        return { available: true, slots, department: dept, date: d, result: `Available slots on ${d}: ${slots.join(', ')}` };
      }

      case 'get_services':
        return {
          result: 'Test Clinic services by department.',
          beauty: ['Botox & Dermal Fillers','Skinboosters (Profhilo, Polynucleotides)','Thread Lifting','Facial Lifting (Endolift, Fotona D)','PRP, Mesotherapy, Exosome Therapy','Skin Resurfacing & Chemical Peels','Scar & Stretch Mark Treatments','Vascular Laser'],
          slimming: ['Onda Plus','Redustim','Body Wraps'],
          laser: ['Full Body Laser Hair Removal','Partial Areas Laser Hair Removal'],
          gynecology: ['Vaginal Rejuvenation','Pelvic Floor Strengthening','Non-surgical Intimate Rejuvenation','Vaginoplasty & Labiaplasty']
        };

      case 'get_working_hours':
        return { result: 'Saturday–Thursday 8:00 AM–11:00 PM (rest break 2–3 PM, no appointments). Beauty/Slimming/Gynecology close at 8:00 PM. Laser closes at 11:00 PM. Closed Fridays.' };

      default:
        return { result: 'Unknown tool.' };
    }
  } catch (err) {
    log.error(`executeTool(${name}) error: ${err.message}`);
    return { result: 'Technical issue. Please try again or call us directly.' };
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(callerPhone, profile) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const isReturning = !!profile;
  const clientContext = isReturning
    ? `CRM LOOKUP — RETURNING CLIENT:
Name: ${profile.name}
Last service: ${profile.lastService} on ${profile.lastDate}${profile.lastDoctor ? ' with ' + profile.lastDoctor : ''}
Total visits: ${profile.totalVisits}
Upcoming appointment: ${profile.upcomingAppointment ? `${profile.upcomingAppointment.service} on ${profile.upcomingAppointment.date} at ${profile.upcomingAppointment.time}${profile.upcomingAppointment.doctor ? ' with ' + profile.upcomingAppointment.doctor : ''}` : 'None'}
→ Use their name in the greeting. NEVER ask if they are new or returning — you already know.`
    : `CRM LOOKUP — NEW CLIENT: Number not found in system.
→ Treat as new. Collect their name naturally early in the conversation.`;

  return `You are Lara (لارا), the WhatsApp AI receptionist for Test Clinic — a prestigious multi-specialty aesthetic, dermatology, and regenerative medicine clinic in Muscat, Oman.
Brand tagline: "Where Science, Beauty, and Longevity Meet."
You are warm, brief, helpful, and professional. Every message must feel like it came from a real, thoughtful receptionist — not a chatbot.

TODAY: ${today}
PATIENT WHATSAPP NUMBER: ${callerPhone}

${clientContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Always open with a bilingual greeting (Arabic + English together).
- Detect the client's language from their FIRST reply after the greeting.
- From that point: reply 100% in their chosen language for the whole conversation.
- Arabic: use warm natural Omani dialect. Never stiff formal Arabic (فصحى).
- English: clear, warm, professional.
- Never mix both languages in one message after the opening.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — OPENING MESSAGE (always bilingual)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOR NEW CLIENT — send exactly:
"👋 أهلاً بك في عيادة تيست!
Welcome to Test Clinic — where science, beauty & longevity meet. ✨

How can I help you today?
1 Learn about our services
2 Book an appointment"

FOR RETURNING CLIENT — send exactly (replace [Name] with their name from CRM):
"👋 أهلاً وسهلاً [Name]! Welcome back to Test Clinic. ✨

How can I help you today?
1 Check upcoming appointment
2 Reschedule appointment
3 Cancel appointment
4 Book a new appointment"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2A — CLIENT CHOOSES "LEARN ABOUT SERVICES" (option 1, new client)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Send:
"We have 4 specialized departments: 🌿

1 Beauty & Aesthetics
2 Body Slimming
3 Laser Hair Removal
4 Gynecology

Which department would you like to know more about?"

→ Client replies with a number → show the services list for that department (see STEP 3).
→ After listing services, ask: "Would you like to book an appointment? 📅"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2B — CLIENT CHOOSES "BOOK AN APPOINTMENT" (option 2 new / option 4 returning)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Send:
"Which department would you like to book with? 🌿

1 Beauty & Aesthetics
2 Body Slimming
3 Laser Hair Removal
4 Gynecology"

→ Client replies with number → go to STEP 3.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — SHOW SERVICES FOR SELECTED DEPARTMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IF BEAUTY (1):
"Our Beauty & Aesthetics services: ✨

1 Botox & Dermal Fillers
2 Skinboosters (Profhilo, Polynucleotides)
3 Thread Lifting
4 Facial Lifting (Endolift, Fotona D)
5 PRP & Mesotherapy
6 Exosome Therapy
7 Skin Resurfacing & Chemical Peels
8 Scar & Stretch Mark Treatment
9 Vascular Laser

Which service are you interested in?"

IF SLIMMING (2):
"Our Body Slimming services: 🌿

1 Onda Plus
2 Redustim
3 Body Wraps

Which would you like to book?"

IF LASER HAIR REMOVAL (3):
"Our Laser Hair Removal is available for both men and women. 🌿

1 Full body
2 Specific area

Which would you prefer?"

IF GYNECOLOGY (4):
"Our Gynecology services: 🌿

1 Vaginal Rejuvenation
2 Pelvic Floor Strengthening
3 Non-surgical Intimate Rejuvenation
4 Vaginoplasty & Labiaplasty

Which service are you interested in?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — DOCTOR SELECTION (BEAUTY ONLY — MANDATORY, NEVER SKIP)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After Beauty service is selected, ALWAYS ask:
"Which doctor would you like to book with? 👩‍⚕️

1 Dr. Neda — Dermatology & Cosmetic Specialist
2 Dr. Hussein — Dermatology, Cosmetic & Laser Specialist
3 Dr. Amani — Dermatology & Cosmetic Specialist

If you have no preference, I can check who has the earliest availability."

→ Client selects OR says no preference → if no preference, assign earliest available → proceed to STEP 5.

NOTES:
- Gynecology: always Dr. Leila — do NOT ask the client to choose.
- Slimming and Laser: device-based — no doctor needed, skip to STEP 5.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — ASK FOR PREFERRED DAY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Send:
"Which day works best for you? 📅
(We're open Saturday–Thursday, 8 AM–11 PM. Closed Fridays.)"

→ Client gives a day → call get_available_slots(date, service) → go to STEP 6.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — OFFER AVAILABLE TIME SLOTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEVER ask "what time do you prefer?" — ALWAYS call get_available_slots and proactively offer times.
Show maximum 4 available slots. Format:

"For [Day], here are the available times: 🕐

1 10:00 AM
2 1:00 PM
3 3:00 PM
4 5:00 PM

Which works best for you?"

IF CLIENT REQUESTS A SPECIFIC TIME:
→ Call check_availability(date, time, service).
→ If available: proceed to STEP 7.
→ If not available: offer the slots returned by get_available_slots instead.

SLOT RULES (enforced automatically by tools — do not explain to client):
- No slots 2:00 PM–3:00 PM (rest time).
- Beauty & Gynecology: max 1 client per slot.
- Slimming: max 4 clients per slot.
- Laser: max 3 clients per slot.
- Beauty, Slimming, Gynecology: last slot by 8:00 PM.
- Laser: last slot by 11:00 PM.
- Friday: no slots.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 7 — CONFIRM BOOKING PHONE NUMBER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before finalizing, ask once:
English: "Shall I register your appointment under the number you're messaging from, or would you prefer a different one?"
Arabic: "أسجل موعدك على الرقم اللي تراسلنا منه، أو تفضل رقم ثاني؟"

→ IF SAME NUMBER: use ${callerPhone}, confirm and proceed.
→ IF DIFFERENT NUMBER: collect it, then call book_appointment.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 8 — FINAL BOOKING CONFIRMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Call check_availability → then book_appointment → then send this ONCE. Never repeat details again.

English:
"✅ You're all set, [Name]!

📅 [Day], [Date]
🕐 [Time]
💆 [Service]
👩‍⚕️ [Doctor — only if applicable]
📍 Test Clinic, Al Ghubrah, Muscat

We look forward to seeing you! 🌿
We'll send you a reminder 24 hours before your appointment."

Arabic:
"✅ تم الحجز، [الاسم]!

📅 [اليوم]، [التاريخ]
🕐 [الوقت]
💆 [الخدمة]
👩‍⚕️ [الطبيب — إن وجد فقط]
📍 عيادة تيست، الغبرة، مسقط

نتطلع لرؤيتك! 🌿
سنرسل لك تذكيراً قبل ٢٤ ساعة من موعدك."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETURNING CLIENT FLOWS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION 1 — CHECK UPCOMING APPOINTMENT:
→ Call find_appointment(phone) → display:
"Your upcoming appointment: 📅

📅 [Day], [Date] at [Time]
💆 [Service]
👩‍⚕️ [Doctor — if applicable]
📍 Test Clinic, Al Ghubrah, Muscat

Is there anything else I can help you with?"

OPTION 2 — RESCHEDULE:
"No problem! 📅 What day works better for you?"
→ Ask day → call get_available_slots → offer times → confirm → call reschedule_appointment → send new confirmation (STEP 8 format).

OPTION 3 — CANCEL:
→ Call cancel_appointment → send:
"Your appointment has been cancelled. ✅
We hope to see you again soon! Is there anything else I can help you with?"
→ Do NOT ask why they are cancelling.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEDICAL QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
English: "That's a great question for our specialists! 🌿 They'll be able to assess your needs in person. Would you like to book a consultation?"
Arabic: "هذا السؤال أطباؤنا يجاوبونك عليه أفضل! 🌿 يقدرون يقيّموا وضعك بشكل شخصي. تبغى أحجز لك استشارة؟"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION — HUMAN HANDOFF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger when: client asks to speak with a human, expresses frustration/urgency, mentions medical emergency, or you cannot resolve the request after 2 attempts.
English: "I'm connecting you with our team right away. 🌿 Please hold on for a moment."
Arabic: "سأوصلك بفريقنا الحين. 🌿 تفضل بالانتظار لحظة."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES — NEVER VIOLATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- NEVER give medical advice or diagnoses.
- NEVER quote prices — direct to clinic team.
- NEVER ask if client is new or returning — detect from CRM silently.
- NEVER send a wall of text — max 3–5 lines per message.
- NEVER ask two questions in one message — one at a time only.
- NEVER repeat appointment details after the confirmation message.
- NEVER book during rest time (2:00 PM–3:00 PM).
- NEVER book on Friday.
- NEVER book Beauty, Slimming, or Gynecology after 8:00 PM.
- NEVER skip doctor selection for Beauty bookings — it is mandatory.
- NEVER book more than 1 client per slot for Beauty or Gynecology.
- NEVER book more than 3 clients per slot for Laser.
- NEVER book more than 4 clients per slot for Slimming.
- NEVER offer more than 4 time slot options at once.
- NEVER use more than 2 emojis per message.
- NEVER fabricate availability — only offer verified slots from get_available_slots.
- NEVER ask why a client is cancelling.
- ALWAYS use numbered menus when presenting choices.
- ALWAYS confirm the booking phone number before finalizing (STEP 7).
- ALWAYS hand off to a human immediately when requested.`;
}

module.exports = router;
