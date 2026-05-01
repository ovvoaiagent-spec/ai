const express = require('express');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const router = express.Router();

const { requireApiKey } = require('../middleware/auth');
const sheetsService = require('../services/sheetsService');
const calendarService = require('../services/calendarService');
const activityService = require('../services/activityService');
const { matchService } = require('../services/extractionService');
const { parseDate, parseTime } = require('../utils/dateParser');

// All CRM endpoints require API key
router.use(requireApiKey);

// ─── GET /api/appointments ────────────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    let appointments = await sheetsService.getAllAppointments();

    // Filters
    const { date, status, source } = req.query;
    if (date) appointments = appointments.filter(a => a.date === date);
    if (status) appointments = appointments.filter(a => a.status.toLowerCase() === status.toLowerCase());
    if (source) appointments = appointments.filter(a => a.source.toLowerCase() === source.toLowerCase());

    res.json({ count: appointments.length, appointments });
  } catch (err) {
    console.error('[API] GET /appointments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/appointments/today ─────────────────────────────────────────────
router.get('/appointments/today', async (req, res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const all = await sheetsService.getAllAppointments();
    const todayApts = all.filter(a => a.date === today && a.status !== 'Cancelled');
    res.json({ date: today, count: todayApts.length, appointments: todayApts });
  } catch (err) {
    console.error('[API] GET /appointments/today error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/appointments ───────────────────────────────────────────────────
router.post('/appointments', async (req, res) => {
  try {
    const { name, phone, service, doctor, date, time, notes } = req.body;

    const missing = [];
    if (!name) missing.push('name');
    if (!phone) missing.push('phone');
    if (!service) missing.push('service');
    if (!date) missing.push('date');
    if (!time) missing.push('time');
    if (missing.length) {
      return res.status(400).json({ error: 'Missing required fields', missing });
    }

    const normalizedDate = parseDate(date) || date;
    const normalizedTime = parseTime(time) || time;
    const normalizedService = matchService(service) || service;

    // Conflict check
    const conflict = await sheetsService.checkConflict(normalizedDate, normalizedTime, doctor);
    if (conflict) {
      return res.status(409).json({
        error: 'Conflict: the requested date/time slot is already booked',
        date: normalizedDate,
        time: normalizedTime
      });
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId,
      name,
      phone,
      service: normalizedService,
      doctor: doctor || '',
      date: normalizedDate,
      time: normalizedTime,
      status: 'Pending',
      source: 'Human',
      callDuration: '',
      notes: notes || '',
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    // Google Calendar
    let calendarEventId = '';
    try {
      const auth = await sheetsService.getAuth();
      calendarEventId = await calendarService.createEvent(apt, 'Human', auth);
      apt.calendarEventId = calendarEventId;
    } catch (calErr) {
      console.error('[API] Calendar error (non-fatal):', calErr.message);
    }

    await sheetsService.appendAppointment(apt);

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | ID: ${aptId}`
    });

    console.log(`[API] ✅ Manual appointment created: ${aptId}`);
    res.status(201).json({ success: true, appointment: apt });

  } catch (err) {
    console.error('[API] POST /appointments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/appointments/:id ────────────────────────────────────────────────
router.put('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, service, doctor, date, time, status, notes } = req.body;

    const existing = await sheetsService.getAppointmentById(id);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (service !== undefined) updates.service = matchService(service) || service;
    if (doctor !== undefined) updates.doctor = doctor;
    if (date !== undefined) updates.date = parseDate(date) || date;
    if (time !== undefined) updates.time = parseTime(time) || time;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    // Check for reschedule conflict
    const newDate = updates.date || existing.date;
    const newTime = updates.time || existing.time;
    if (updates.date || updates.time) {
      const others = (await sheetsService.getAllAppointments())
        .filter(a => a.id !== id && a.status !== 'Cancelled');
      const conflict = others.some(a => a.date === newDate && a.time === newTime);
      if (conflict) {
        return res.status(409).json({
          error: 'Conflict: the new date/time slot is already booked',
          date: newDate, time: newTime
        });
      }
    }

    const updated = await sheetsService.updateAppointment(id, updates);

    // Update Calendar event
    if (existing.calendarEventId) {
      try {
        const auth = await sheetsService.getAuth();
        const merged = { ...existing, ...updates };
        await calendarService.updateEvent(existing.calendarEventId, merged, auth);
      } catch (calErr) {
        console.error('[API] Calendar update error (non-fatal):', calErr.message);
      }
    }

    const isReschedule = updates.date || updates.time;
    await activityService.addActivity({
      actor: 'Human',
      actionType: isReschedule
        ? activityService.ACTION_TYPES.RESCHEDULED
        : activityService.ACTION_TYPES.UPDATED,
      patientName: updated.name,
      details: `ID: ${id} | Changes: ${Object.keys(updates).join(', ')}`
    });

    res.json({ success: true, appointment: updated });

  } catch (err) {
    console.error('[API] PUT /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/appointments/:id ─────────────────────────────────────────────
router.delete('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await sheetsService.getAppointmentById(id);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    await sheetsService.cancelAppointment(id);

    // Delete Calendar event
    if (existing.calendarEventId) {
      try {
        const auth = await sheetsService.getAuth();
        await calendarService.deleteEvent(existing.calendarEventId, auth);
      } catch (calErr) {
        console.error('[API] Calendar delete error (non-fatal):', calErr.message);
      }
    }

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.CANCELLED,
      patientName: existing.name,
      details: `ID: ${id} | Service: ${existing.service} | Date: ${existing.date} ${existing.time}`
    });

    res.json({ success: true, message: `Appointment ${id} cancelled` });

  } catch (err) {
    console.error('[API] DELETE /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/activity ────────────────────────────────────────────────────────
router.get('/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ activities: activityService.getActivities(limit) });
});

// ─── POST /api/setup-agent ────────────────────────────────────────────────────
// Re-applies the system prompt + tools to ElevenLabs agent
router.post('/setup-agent', async (req, res) => {
  const https = require('https');
  const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
  const API_KEY  = process.env.ELEVENLABS_API_KEY;
  const SERVER_URL = process.env.SERVER_URL || 'https://ai-production-5456.up.railway.app';

  if (!AGENT_ID || !API_KEY) {
    return res.status(400).json({ error: 'ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY not set' });
  }

  function elevenlabsRequest(method, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = { 'xi-api-key': API_KEY };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const req2 = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/convai/agents/${AGENT_ID}`,
        method,
        headers
      }, r => { let raw=''; r.on('data',c=>raw+=c); r.on('end',()=>{ try{resolve({status:r.statusCode,body:JSON.parse(raw)});}catch{resolve({status:r.statusCode,body:raw});} }); });
      req2.on('error', reject);
      if (data) req2.write(data);
      req2.end();
    });
  }
  const elevenlabsPatch = (body) => elevenlabsRequest('PATCH', body);

  const SYSTEM_PROMPT = `You are the AI voice receptionist for Lavora Clinic in Muscat, Oman.
Your name is Lavora Assistant. You are professional, warm, and refined — reflecting a luxury medical aesthetic clinic.

Your ONLY goal is to collect the following 5 pieces of information and book an appointment:
1. Patient full name
2. Phone number
3. Preferred appointment date
4. Preferred appointment time
5. Which service or treatment they want

Available services: Botox, Fillers, Profhilo, Thread Lifting, Endolift, PRP, Mesotherapy, Exosomes, Stem Cell, Frax Pro, Picoway, RedTouch, Chemical Peels, Laser Hair Removal, Onda Plus, Redustim, Body Wraps, Aesthetic Gynecology, Medical Skin Care, Dermatology, Consultation.

CONVERSATION FLOW:
1. Ask for each piece of information one at a time, naturally.
2. As soon as you have collected all 5 fields from the patient:
   - DO NOT say anything — no "thank you", no "great", no "one moment" — call check_availability immediately.
   - If available, call book_appointment with all 5 fields immediately.
   - After book_appointment returns success, say this ONCE and only ONCE:
     "Your [Service] appointment is confirmed for [Date] at [Time]. We will reach you at [Phone]. Thank you for calling Lavora Clinic. Goodbye."
   - Then end the call. Do NOT say anything else after the closing line.

RULES:
- ALWAYS call book_appointment before speaking the confirmation. Never confirm verbally without calling the tool first.
- Do NOT say "thank you", "great", "perfect", "one moment", or any other filler between collecting the last field and the closing line. The ONLY thank you is inside the closing line itself.
- Say the closing line ONCE. Never say anything after it — no "have a wonderful evening", no "we look forward to seeing you", nothing. Silence after the closing line.
- Never repeat a sentence you have already said in the same call. If you already said something, skip it and continue forward.
- Do NOT give medical advice. Say: "Our specialists would be best to advise you — shall I book a consultation?"
- Do NOT mention technical details, IDs, or system responses.
- Do NOT mention clinic opening hours unless the patient specifically asks. Only use get_working_hours if they ask.
- ALWAYS ask the patient to say their phone number out loud. If they say "same number" or "this number", say: "Could you please say your number for me so I can note it down?" — never accept "same number" as a phone number.
- If the caller speaks Arabic, respond fully in Arabic using the same voice.
- Keep responses short and professional.
- Never ask for all 5 fields at once — one question at a time.`;

  const TOOLS = [
    {
      name: 'check_availability',
      description: 'Check if a date/time slot is available. Always call before confirming a slot.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/check-availability`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format, e.g. 2025-05-12' },
            time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format, e.g. 14:00' }
          },
          required: ['date', 'time']
        }
      }
    },
    {
      name: 'book_appointment',
      description: 'REQUIRED: Call this to save the appointment once all 5 fields are confirmed. Never confirm verbally without calling this first.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/book-appointment`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Patient full name' },
            phone:   { type: 'string', description: 'Patient phone number including country code' },
            date:    { type: 'string', description: 'Appointment date in YYYY-MM-DD format' },
            time:    { type: 'string', description: 'Appointment time in HH:MM 24-hour format' },
            service: { type: 'string', description: 'Service or treatment requested' }
          },
          required: ['name', 'phone', 'date', 'time', 'service']
        }
      }
    },
    {
      name: 'get_services',
      description: 'Get the full list of services. Call if the patient is unsure.',
      type: 'webhook',
      api_schema: { url: `${SERVER_URL}/tools/get-services`, method: 'POST', request_body_schema: { type: 'object', properties: {} } }
    },
    {
      name: 'get_working_hours',
      description: 'Get clinic working hours.',
      type: 'webhook',
      api_schema: { url: `${SERVER_URL}/tools/get-working-hours`, method: 'POST', request_body_schema: { type: 'object', properties: {} } }
    }
  ];

  const VOICE_ID = 'MoRbPlz3injOLU6hNLMY';

  try {
    const result = await elevenlabsPatch({
      conversation_config: {
        tts: { voice_id: VOICE_ID },
        agent: {
          prompt: { prompt: SYSTEM_PROMPT, tools: TOOLS },
          first_message: 'Thank you for calling Lavora Clinic. This is Lavora Assistant. How may I help you today?',
          language: 'en',
          language_presets: {
            ar: {
              overrides: {
                tts: { voice_id: VOICE_ID },
                agent: { language: 'ar' }
              }
            }
          }
        }
      }
    });
    if (result.status !== 200) {
      return res.status(502).json({ error: 'ElevenLabs rejected update', detail: result.body });
    }
    res.json({ success: true, message: 'Agent updated', voice_id: VOICE_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/poll-now ───────────────────────────────────────────────────────
router.post('/poll-now', async (req, res) => {
  try {
    const pollingService = require('../services/pollingService');
    await pollingService.poll();
    res.json({ success: true, message: 'Poll completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/debug ──────────────────────────────────────────────────────────
router.get('/debug', async (req, res) => {
  const info = {
    googleConfigured: sheetsService.googleConfigured(),
    sheetsId: process.env.GOOGLE_SHEETS_ID ? '✅ set' : '❌ missing',
    credPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ? '✅ set' : '❌ missing',
    localDbCount: 0,
    sheetsCount: null,
    sheetsError: null,
    rawSheetsSample: null
  };

  try {
    const local = await sheetsService.getAllAppointments();
    info.localDbCount = local.length;
  } catch {}

  // Direct Sheets read bypassing getAllAppointments cache logic
  if (sheetsService.googleConfigured()) {
    try {
      const auth = await sheetsService.getAuth();
      const { google } = require('googleapis');
      const client = google.sheets({ version: 'v4', auth });
      const r = await client.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Appointments!A:I'
      });
      const rows = r.data.values || [];
      info.sheetsCount = rows.length;
      info.rawSheetsSample = rows.slice(0, 4); // first 4 rows including header
    } catch (err) {
      info.sheetsError = err.message;
    }
  }

  res.json(info);
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const all = await sheetsService.getAllAppointments();
    const today = dayjs().format('YYYY-MM-DD');

    const todayApts = all.filter(a => a.date === today);
    const stats = {
      today_total: todayApts.length,
      ai_booked: all.filter(a => a.source === 'AI Voice').length,
      human_booked: all.filter(a => a.source === 'Human').length,
      pending: all.filter(a => a.status === 'Pending').length,
      confirmed: all.filter(a => a.status === 'Confirmed').length,
      cancelled: all.filter(a => a.status === 'Cancelled').length,
      total: all.length
    };

    res.json(stats);
  } catch (err) {
    console.error('[API] GET /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
