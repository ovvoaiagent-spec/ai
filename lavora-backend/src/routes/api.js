const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const { requireApiKey } = require('../middleware/auth');
const db = require('../services/localDbService');
const googleSync = require('../services/googleSync');
const activityService = require('../services/activityService');
const sms = require('../services/smsService');
const log = require('../services/logger').child('API');
const { matchService } = require('../services/extractionService');
const { parseDate, parseTime } = require('../utils/dateParser');

router.use(requireApiKey);

// ─── GET /api/appointments ────────────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    let appointments = await db.getAllAppointments();

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
    const all = await db.getAllAppointments();
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

    const conflict = await db.checkConflict(normalizedDate, normalizedTime, doctor);
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
      timestamp: new Date().toISOString()
    };

    await db.appendAppointment(apt);
    googleSync.book(apt);
    sms.sendBookingConfirmation(apt);

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | ID: ${aptId}`
    });

    log.info(`Manual appointment created: ${aptId}`);
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

    const existing = await db.getAppointmentById(id);
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

    const newDate = updates.date || existing.date;
    const newTime = updates.time || existing.time;
    if (updates.date || updates.time) {
      const others = (await db.getAllAppointments()).filter(a => a.id !== id && a.status !== 'Cancelled');
      const conflict = others.some(a => a.date === newDate && a.time === newTime);
      if (conflict) {
        return res.status(409).json({
          error: 'Conflict: the new date/time slot is already booked',
          date: newDate, time: newTime
        });
      }
    }

    const updated = await db.updateAppointment(id, updates);
    if (updates.date || updates.time) {
      googleSync.reschedule(updated);
      sms.sendRescheduleConfirmation(updated);
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

    const existing = await db.getAppointmentById(id);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    await db.cancelAppointment(id);
    googleSync.cancel(existing);
    sms.sendCancellationConfirmation(existing);

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
router.get('/activity', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ activities: await activityService.getActivities(limit) });
});

// ─── POST /api/setup-agent ────────────────────────────────────────────────────
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

  const SYSTEM_PROMPT = `You are the AI voice receptionist for Lavora Clinic in Muscat, Oman.
Your name is Lavora Assistant. You are professional, warm, and refined — reflecting a luxury medical aesthetic clinic.

CONVERSATION FLOW — follow this exact order:
1. The first message asks the patient if they prefer Arabic or English. Switch fully to their chosen language immediately.
2. Ask what service or treatment they want.
3. Ask for their preferred appointment day.
4. Ask for their preferred appointment time.
5. Ask for their full name.
6. Ask: "Would you like us to contact you on the number you are calling from, or a different number?"
   - If they say "this number", "same number", or "yes": use {{caller_id}} as their phone number.
   - If they give a different number: use that number.
7. You now have all 5 fields. Call check_availability immediately — no words, no filler.
8. If available, call book_appointment immediately with all 5 fields.
9. After book_appointment returns success, say this ONCE and only ONCE:
   "Your [Service] appointment is confirmed for [Date] at [Time]. We will reach you at [Phone]. Thank you for calling Lavora Clinic. Goodbye."
10. End the call. Say nothing else.

Available services: Botox, Fillers, Profhilo, Thread Lifting, Endolift, PRP, Mesotherapy, Exosomes, Stem Cell, Frax Pro, Picoway, RedTouch, Chemical Peels, Laser Hair Removal, Onda Plus, Redustim, Body Wraps, Aesthetic Gynecology, Medical Skin Care, Dermatology, Consultation.

RULES:
- ALWAYS call book_appointment before speaking the confirmation. Never confirm verbally without calling the tool first.
- Do NOT say "thank you", "great", "perfect", or any filler between step 6 and the closing line.
- Say the closing line ONCE. Nothing after it — no "have a wonderful day", no extra farewell.
- Never repeat a sentence already said in this call.
- Do NOT give medical advice. Say: "Our specialists would be best to advise you — shall I book a consultation?"
- Do NOT mention technical details, IDs, or system responses.
- Do NOT mention clinic opening hours unless the patient specifically asks.
- Keep responses short and professional. One question at a time.`;

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
            date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format, e.g. 2025-05-12', dynamic_variable: '', constant_value: '' },
            time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format, e.g. 14:00', dynamic_variable: '', constant_value: '' }
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
            name:    { type: 'string', description: 'Patient full name', dynamic_variable: '', constant_value: '' },
            phone:   { type: 'string', description: 'Patient phone number including country code', dynamic_variable: '', constant_value: '' },
            date:    { type: 'string', description: 'Appointment date in YYYY-MM-DD format', dynamic_variable: '', constant_value: '' },
            time:    { type: 'string', description: 'Appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' },
            service: { type: 'string', description: 'Service or treatment requested', dynamic_variable: '', constant_value: '' }
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
    const result = await elevenlabsRequest('PATCH', {
      conversation_config: {
        tts: { voice_id: VOICE_ID },
        agent: {
          prompt: { prompt: SYSTEM_PROMPT, tools: TOOLS },
          first_message: 'Thank you for calling Lavora Clinic. This is Lavora Assistant. Do you prefer Arabic or English?',
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

// ─── GET /api/debug ───────────────────────────────────────────────────────────
router.get('/debug', async (req, res) => {
  try {
    const all = await db.getAllAppointments();
    res.json({
      storage: process.env.DATABASE_URL ? 'postgresql' : 'local-json',
      appointmentCount: all.length,
      sample: all.slice(-3)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/test-llm ───────────────────────────────────────────────────────
router.post('/test-llm', async (req, res) => {
  try {
    const llm = require('../pipeline/llmService');
    const context = {
      caller_id: '+96899999999',
      is_returning: 'false',
      patient_name: '', last_service: '', last_visit_date: '',
      sessionId: 'test'
    };
    const history = [
      { role: 'user', content: 'English please' },
      { role: 'assistant', content: 'What service would you like?' },
      { role: 'user', content: 'Botox' },
      { role: 'assistant', content: 'What day and time?' },
      { role: 'user', content: 'May 15th at 3pm' },
      { role: 'assistant', content: 'What is your full name?' },
      { role: 'user', content: 'Test User' },
      { role: 'assistant', content: 'Shall I contact you on +96899999999?' },
      { role: 'user', content: 'Yes same number' }
    ];
    const result = await llm.chat(history, context);
    res.json({ response: result.text, turns: result.history.length });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

// ─── GET /api/test-tts ───────────────────────────────────────────────────────
router.get('/test-tts', async (req, res) => {
  const https = require('https');
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'MoRbPlz3injOLU6hNLMY';
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  const body = JSON.stringify({
    text: 'Hello, this is a test.',
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 }
  });

  const reqOptions = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  const r = https.request(reqOptions, (elevenRes) => {
    let bytes = 0;
    elevenRes.on('data', c => { bytes += c.length; });
    elevenRes.on('end', () => {
      if (elevenRes.statusCode === 200) {
        res.json({ ok: true, status: 200, bytes, voice_id: voiceId });
      } else {
        res.status(502).json({ ok: false, status: elevenRes.statusCode, bytes });
      }
    });
  });
  r.on('error', (err) => res.status(500).json({ ok: false, error: err.message }));
  r.write(body);
  r.end();
});

// ─── GET /api/test-deepgram ──────────────────────────────────────────────────
router.get('/test-deepgram', async (req, res) => {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'DEEPGRAM_API_KEY not set' });

  try {
    const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
    const deepgram = createClient(apiKey);

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, opened: false, error: 'timed out waiting for Open event' }), 5000);

      let opened = false;
      const conn = deepgram.listen.live({
        encoding: 'mulaw', sample_rate: 8000,
        language: 'multi', model: 'nova-2',
        smart_format: true, interim_results: false,
        endpointing: 300, utterance_end_ms: 1000, vad_events: true, punctuate: true,
      });

      conn.on(LiveTranscriptionEvents.Open, () => {
        opened = true;
        clearTimeout(timer);
        try { conn.finish(); } catch {}
        resolve({ ok: true, opened: true, model: 'nova-2-general', language: 'multi' });
      });

      conn.on(LiveTranscriptionEvents.Error, (err) => {
        clearTimeout(timer);
        try { conn.finish(); } catch {}
        resolve({ ok: false, opened, error: err?.message || String(err) });
      });

      conn.on(LiveTranscriptionEvents.Close, () => {
        if (!opened) {
          clearTimeout(timer);
          resolve({ ok: false, opened: false, error: 'connection closed before opening' });
        }
      });
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    res.json(await db.getStats());
  } catch (err) {
    console.error('[API] GET /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
