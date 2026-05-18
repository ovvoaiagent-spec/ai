const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const { requireApiKey } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenantContext');
const { validate, schemas } = require('../middleware/validate');
const nurseSessionStore  = require('../services/nurseSessionStore');
const db = require('../services/localDbService');
const googleSync = require('../services/googleSync');
const activityService = require('../services/activityService');
const sms = require('../services/notificationService');
const laserPkgSvc = require('../services/laserPackageService');
const log = require('../services/logger').child('API');
const { matchService } = require('../services/extractionService');
const { parseDate, parseTime } = require('../utils/dateParser');
const settingsService = require('../services/settingsService');

const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function isDayClosed(dateStr) {
  const s = settingsService.getSettings();
  if (s.holidays && s.holidays.includes(dateStr)) return true;
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return !(s.workDays || []).includes(DOW_NAMES[dow]);
}

// ─── POST /api/nurse-login (no auth required) ─────────────────────────────────
router.post('/nurse-login', validate(schemas.nurseLogin), (req, res) => {
  const { name, phone } = req.validated;

  const s = settingsService.getSettings();
  const normalizePhone = p => String(p).replace(/\D/g, '').slice(-8);
  const nurse = (s.staff || []).find(m =>
    m.phone && m.name &&
    m.name.toLowerCase().trim() === name.toLowerCase().trim() &&
    normalizePhone(m.phone) === normalizePhone(phone)
  );

  if (!nurse) return res.status(401).json({ error: 'Name or phone number not recognised. Please check with your manager.' });

  const token = nurseSessionStore.create(nurse);
  log.info(`Nurse login: ${nurse.name}`);
  res.json({ token, name: nurse.name, role: nurse.role || '', department: nurse.department || '' });
});

router.use(requireApiKey);
router.use(tenantContext(db.pool));

// ─── GET /api/appointments ────────────────────────────────────────────────────
router.get('/appointments', validate(schemas.appointmentQuery, 'query'), async (req, res) => {
  try {
    let appointments = await db.getAllAppointments(req.clinicId);

    const { date, status, source } = req.validated;
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
    const all = await db.getAllAppointments(req.clinicId);
    const todayApts = all.filter(a => a.date === today && a.status !== 'Cancelled');
    res.json({ date: today, count: todayApts.length, appointments: todayApts });
  } catch (err) {
    console.error('[API] GET /appointments/today error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/appointments ───────────────────────────────────────────────────
router.post('/appointments', validate(schemas.appointment), async (req, res) => {
  try {
    const { name, phone, service, doctor, staff, date, time, notes } = req.validated;

    const normalizedDate = parseDate(date) || date;
    const normalizedTime = parseTime(time) || time;
    const normalizedService = matchService(service) || service;

    if (isDayClosed(normalizedDate)) {
      return res.status(400).json({ error: 'Clinic is closed on that day', date: normalizedDate });
    }

    const conflict = await db.checkConflict(normalizedDate, normalizedTime, doctor, req.clinicId);
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
      staff:  staff  || '',
      date: normalizedDate,
      time: normalizedTime,
      status: 'Pending',
      source: 'Human',
      callDuration: '',
      notes: notes || '',
      timestamp: new Date().toISOString()
    };

    await db.appendAppointment(apt, req.clinicId);
    googleSync.book(apt);
    sms.sendBookingConfirmation(apt);

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | ID: ${aptId}`,
      clinicId: req.clinicId
    });

    log.info(`Manual appointment created: ${aptId}`);
    res.status(201).json({ success: true, appointment: apt });

  } catch (err) {
    console.error('[API] POST /appointments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/appointments/:id ────────────────────────────────────────────────
router.put('/appointments/:id', validate(schemas.appointmentUpdate), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, service, doctor, staff, date, time, status, notes } = req.validated;

    const existing = await db.getAppointmentById(id, req.clinicId);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    // Nurses may only update staff + status (Confirmed/Pending)
    if (req.nurseSession) {
      const updates = {};
      if (staff  !== undefined) updates.staff  = staff;
      if (status !== undefined && ['Confirmed','Pending'].includes(status)) updates.status = status;
      if (!Object.keys(updates).length) return res.status(403).json({ error: 'Nurses may only update staff and status fields' });
      const updated = await db.updateAppointment(id, updates, req.clinicId);
      await activityService.addActivity({
        actor: req.nurseSession.name,
        actionType: activityService.ACTION_TYPES.UPDATED,
        patientName: updated.name,
        details: `Session completed by ${req.nurseSession.name} | ID: ${id}`,
        clinicId: req.clinicId
      });
      return res.json({ success: true, appointment: updated });
    }

    const updates = {};
    if (name    !== undefined) updates.name    = name;
    if (phone   !== undefined) updates.phone   = phone;
    if (service !== undefined) updates.service = matchService(service) || service;
    if (doctor  !== undefined) updates.doctor  = doctor;
    if (staff   !== undefined) updates.staff   = staff;
    if (date    !== undefined) updates.date    = parseDate(date) || date;
    if (time    !== undefined) updates.time    = parseTime(time) || time;
    if (status  !== undefined) updates.status  = status;
    if (notes   !== undefined) updates.notes   = notes;

    const newDate = updates.date || existing.date;
    const newTime = updates.time || existing.time;
    const isReschedule = !!(updates.date || updates.time);

    if (isReschedule) {
      if (isDayClosed(newDate)) {
        return res.status(400).json({ error: 'Clinic is closed on that day', date: newDate });
      }

      const others = (await db.getAllAppointments(req.clinicId)).filter(a => a.id !== id && a.status !== 'Cancelled');
      const conflict = others.some(a => a.date === newDate && a.time === newTime);
      if (conflict) {
        return res.status(409).json({
          error: 'Conflict: the new date/time slot is already booked',
          date: newDate, time: newTime
        });
      }

      // Cancel old appointment, create new one so history is preserved
      await db.cancelAppointment(id, req.clinicId);
      googleSync.cancel(existing);

      const newAptId = `APT-${Date.now()}`;
      const newApt = {
        ...existing,
        ...updates,
        id: newAptId,
        date: newDate,
        time: newTime,
        status: updates.status || 'Confirmed',
        notes: (existing.notes ? existing.notes + ' | ' : '') + `Rescheduled from ${existing.date} ${existing.time}`,
        timestamp: new Date().toISOString(),
        calendarEventId: ''
      };
      await db.appendAppointment(newApt, req.clinicId);
      googleSync.book(newApt);
      sms.sendRescheduleConfirmation(newApt);

      await activityService.addActivity({
        actor: 'Human',
        actionType: activityService.ACTION_TYPES.RESCHEDULED,
        patientName: newApt.name,
        details: `${existing.service} → ${newDate} ${newTime} | Old: ${id} New: ${newAptId}`,
        clinicId: req.clinicId
      });

      return res.json({ success: true, appointment: newApt, cancelled_id: id });
    }

    // Non-reschedule update (name, notes, status, doctor, etc.)
    const updated = await db.updateAppointment(id, updates, req.clinicId);
    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.UPDATED,
      patientName: updated.name,
      details: `ID: ${id} | Changes: ${Object.keys(updates).join(', ')}`,
      clinicId: req.clinicId
    });

    res.json({ success: true, appointment: updated });

  } catch (err) {
    console.error('[API] PUT /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/appointments/:id ─────────────────────────────────────────────
router.delete('/appointments/:id', async (req, res) => {
  if (req.nurseSession) return res.status(403).json({ error: 'Nurses cannot cancel appointments' });
  try {
    const { id } = req.params;

    const existing = await db.getAppointmentById(id, req.clinicId);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    await db.hardDeleteAppointment(id, req.clinicId);
    googleSync.cancel(existing);
    sms.sendCancellationConfirmation(existing);

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.CANCELLED,
      patientName: existing.name,
      details: `ID: ${id} | Service: ${existing.service} | Date: ${existing.date} ${existing.time}`,
      clinicId: req.clinicId
    });

    res.json({ success: true, message: `Appointment ${id} deleted` });

  } catch (err) {
    console.error('[API] DELETE /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/activity ────────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ activities: await activityService.getActivities(limit, req.clinicId) });
});

// ─── POST /api/setup-agent ────────────────────────────────────────────────────
router.post('/setup-agent', async (req, res) => {
  const https = require('https');
  const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
  const API_KEY  = process.env.ELEVENLABS_API_KEY;
  const SERVER_URL = process.env.SERVER_URL || 'https://ai-production-5456.up.railway.app';

  if (!API_KEY) {
    return res.status(400).json({ error: 'ELEVENLABS_API_KEY not set' });
  }

  function elevenlabsRequest(method, body, path) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = { 'xi-api-key': API_KEY };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const req2 = https.request({
        hostname: 'api.elevenlabs.io',
        path: path || `/v1/convai/agents/${AGENT_ID}`,
        method,
        headers
      }, r => { let raw=''; r.on('data',c=>raw+=c); r.on('end',()=>{ try{resolve({status:r.statusCode,body:JSON.parse(raw)});}catch{resolve({status:r.statusCode,body:raw});} }); });
      req2.on('error', reject);
      if (data) req2.write(data);
      req2.end();
    });
  }

  const s = settingsService.getSettings();
  const beautyDoctors = (s.doctors || [])
    .filter(d => d.department === 'beauty')
    .map(d => d.name);
  const beautyDoctorList = beautyDoctors.join(', ');

  const SYSTEM_PROMPT = `You are Lavora Assistant, the AI voice receptionist for Lavora Clinic in Muscat, Oman.
You are professional, warm, and refined.
You have access to these variables: caller_id={{caller_id}}, is_returning={{is_returning}}, patient_name={{patient_name}}.

════════════════════════════════════════
LANGUAGE — LOCK IN FROM FIRST RESPONSE
════════════════════════════════════════

You support Omani Arabic and English only.

Step 1: Detect or ask the caller's language.
Step 2: Once language is confirmed, use it for the ENTIRE call. Never switch. Never mix.

NEW caller (is_returning = false):
Say: "Do you prefer Arabic or English? تفضل عربي ولا إنجليزي؟"
Wait for answer. Lock language. Never ask again.

RETURNING caller (is_returning = true):
Detect language from their first words. Then greet:
English → "Welcome back, {{patient_name}}! How can I help you today?"
Arabic  → "أهلاً وسهلاً {{patient_name}}! كيف أقدر أساعدك اليوم؟"

Omani Arabic rules: use "بكرا" not "غداً", "زين" for OK, "وش" for what, "يعطيك العافية" for goodbye.


════════════════════════════════════════
DATE RULE — NEVER BREAK THIS
════════════════════════════════════════

NEVER convert a date to a number format like 2025-06-01 yourself.
Always pass the caller's exact words to the tool. Examples:

Caller says "tomorrow"         → pass "tomorrow"
Caller says "بكرا"             → pass "بكرا"
Caller says "after tomorrow"   → pass "after tomorrow"
Caller says "بعد بكرا"         → pass "بعد بكرا"
Caller says "next Monday"      → pass "next Monday"
Caller says "الإثنين الجاي"   → pass "الإثنين الجاي"

The backend handles all date conversion. If you compute the date yourself, it will be wrong.


════════════════════════════════════════
BOOKING — FOLLOW THESE STEPS IN ORDER
════════════════════════════════════════

STEP 1 — SERVICE
Ask what service or treatment they want.
If unsure, call get_services and read out the list.

STEP 2 — DATE
Ask for their preferred appointment day.
Accept any natural phrasing. Pass it as-is to tools.

STEP 3 — TIME
Ask for their preferred appointment time.

STEP 4 — NAME
New caller:
  English → "What is your full name?"
  Arabic  → "وش اسمك الكامل؟"
Returning caller: use {{patient_name}}. Do NOT ask.

STEP 5 — PHONE NUMBER (NEVER SKIP)
New caller:
  English → "Shall we use the number you're calling from, or a different number?"
  Arabic  → "نستخدم رقمك اللي اتصلت منه، ولا رقم ثاني؟"
Returning caller:
  English → "Shall we use your number on file?"
  Arabic  → "نستخدم رقمك المسجل؟"

If they say yes or same → use {{caller_id}}.
If they give a different number → use that number.

STEP 6 — CHECK AVAILABILITY
Call check_availability immediately.
Pass the date exactly as the caller said it. Say nothing before calling.

If available = true:
  Go to STEP 7.

If slot is taken:
  English → "That slot is taken. Which other time works for you?"
  Arabic  → "هذا الوقت محجوز. أي وقت ثاني يناسبك؟"
  Go back to STEP 3.

If clinic is closed that day:
  English → "The clinic is closed that day. Which other day works for you?"
  Arabic  → "العيادة مسكرة هذا اليوم. أي يوم ثاني يناسبك؟"
  Go back to STEP 2.

STEP 7 — BOOK APPOINTMENT
Call book_appointment immediately after check_availability returns available.
Say nothing between the two calls.

If success = true:
  English → "Your [Service] appointment is confirmed for [Date] at [Time]. We will reach you at [Phone]. Thank you for calling Lavora Clinic. Goodbye!"
  Arabic  → "تم تأكيد موعدك لـ [الخدمة] يوم [التاريخ] الساعة [الوقت]. نتواصل معك على [الرقم]. يعطيك العافية، مع السلامة!"
  Then call end_call immediately.

If success = false:
  English → "I was unable to save your appointment. Our team will call you back to confirm. Thank you for calling, goodbye!"
  Arabic  → "ما قدرت أحجز الموعد. فريقنا بيتصل فيك للتأكيد. يعطيك العافية، مع السلامة!"
  Then call end_call immediately.


════════════════════════════════════════
CANCELLATION — FOLLOW THESE STEPS
════════════════════════════════════════

STEP 1: Call find_appointment with the caller's phone number.
STEP 2: Read back the appointment details and confirm with the caller.
STEP 3: Call cancel_appointment with the appointment ID.
STEP 4:
  English → "Your appointment has been cancelled. Thank you for calling, goodbye!"
  Arabic  → "تم إلغاء موعدك. يعطيك العافية، مع السلامة!"
Then call end_call immediately.


════════════════════════════════════════
RESCHEDULING — FOLLOW THESE STEPS
════════════════════════════════════════

STEP 1: Call find_appointment with the caller's phone number.
STEP 2: Ask for the new preferred day.
STEP 3: Ask for the new preferred time.
STEP 4: Call check_availability. Pass the date exactly as the caller said it.
STEP 5: If available, call reschedule_appointment.
STEP 6:
  English → "Your appointment has been rescheduled to [Date] at [Time]. Thank you for calling, goodbye!"
  Arabic  → "تم تحويل موعدك إلى [التاريخ] الساعة [الوقت]. يعطيك العافية، مع السلامة!"
Then call end_call immediately.


════════════════════════════════════════
AVAILABLE SERVICES
════════════════════════════════════════

Always use the English name when calling tools.

Botox (بوتوكس), Fillers (فيلر), Profhilo (برو فيلو), Thread Lifting (خيوط الشد), Endolift (انديليفت), PRP (حقن البلازما), Mesotherapy (ميزوثيرابي), Exosomes (إكسوسومز), Stem Cell (خلايا جذعية), Frax Pro (فراكس برو), Picoway (بيكاواي), RedTouch (ريد تاتش), Chemical Peels (تقشير كيميائي), Laser Hair Removal (إزالة الشعر بالليزر), Onda Plus (أوندا بلاس), Redustim (ريدوستيم), Body Wraps (لفائف الجسم), Aesthetic Gynecology (طب نسائي تجميلي), Medical Skin Care (عناية طبية بالبشرة), Dermatology (أمراض الجلد), Consultation (استشارة).


════════════════════════════════════════
BEHAVIOR RULES — ALWAYS APPLY
════════════════════════════════════════

Ask only ONE question per response.
Keep every response to 1 or 2 short spoken sentences.
No bullet points, no lists, no formatting — plain spoken sentences only.
Never start a response with sorry, I apologize, عذرا, or any apology.
Never repeat something already said in this call.
Never give medical advice. Instead say:
  English → "Our specialists can best advise you — shall I book a consultation?"
  Arabic  → "دكاترتنا يقدرون يساعدونك — تبي أحجز لك استشارة؟"
Never mention appointment IDs, system errors, or technical details.
Always read the result field from every tool response before deciding what to say.
After any goodbye, your very next action must be to call end_call. No exceptions.`;

  const TOOLS = [
    {
      name: 'check_availability',
      description: 'Check if a date/time slot is available. Always call before booking.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/check-availability`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: "Appointment date — pass the caller's exact words, e.g. 'tomorrow', 'بكرا', 'after tomorrow', 'بعد بكرا', 'next Monday', 'May 20'. Never convert to YYYY-MM-DD yourself.", dynamic_variable: '', constant_value: '' },
            time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' }
          },
          required: ['date', 'time']
        }
      }
    },
    {
      name: 'book_appointment',
      description: 'Save the appointment. Call immediately after check_availability returns available — no text between the two calls.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/book-appointment`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Patient full name', dynamic_variable: '', constant_value: '' },
            phone:   { type: 'string', description: 'Patient phone number with country code', dynamic_variable: '', constant_value: '' },
            date:    { type: 'string', description: "Appointment date — pass the caller's exact words, e.g. 'tomorrow', 'بكرا', 'after tomorrow', 'بعد بكرا', 'next Monday'. Never convert yourself.", dynamic_variable: '', constant_value: '' },
            time:    { type: 'string', description: 'Appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' },
            service: { type: 'string', description: 'Service name in English', dynamic_variable: '', constant_value: '' }
          },
          required: ['name', 'phone', 'date', 'time', 'service']
        }
      }
    },
    {
      name: 'find_appointment',
      description: 'Look up an existing appointment by phone number. Use for cancellations and rescheduling.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/find-appointment`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Patient phone number', dynamic_variable: '', constant_value: '' }
          },
          required: ['phone']
        }
      }
    },
    {
      name: 'cancel_appointment',
      description: 'Cancel an existing appointment by ID.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/cancel-appointment`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'Appointment ID from find_appointment', dynamic_variable: '', constant_value: '' }
          },
          required: ['appointment_id']
        }
      }
    },
    {
      name: 'reschedule_appointment',
      description: 'Reschedule an existing appointment to a new date and time.',
      type: 'webhook',
      api_schema: {
        url: `${SERVER_URL}/tools/reschedule-appointment`, method: 'POST',
        request_body_schema: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'Appointment ID from find_appointment', dynamic_variable: '', constant_value: '' },
            new_date: { type: 'string', description: "New date — pass the caller's exact words, e.g. 'tomorrow', 'بكرا', 'after tomorrow', 'بعد بكرا', 'next Monday'. Never convert yourself.", dynamic_variable: '', constant_value: '' },
            new_time: { type: 'string', description: 'New time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' }
          },
          required: ['appointment_id', 'new_date', 'new_time']
        }
      }
    },
    {
      name: 'get_services',
      description: 'Return the full list of available services. Call if the patient is unsure what they want.',
      type: 'webhook',
      api_schema: { url: `${SERVER_URL}/tools/get-services`, method: 'POST', request_body_schema: { type: 'object', properties: {} } }
    },
    {
      name: 'get_working_hours',
      description: 'Return clinic working hours.',
      type: 'webhook',
      api_schema: { url: `${SERVER_URL}/tools/get-working-hours`, method: 'POST', request_body_schema: { type: 'object', properties: {} } }
    },
    {
      name: 'end_call',
      description: 'End the phone call. Call this immediately after saying the final goodbye/confirmation message. Never leave the line open after saying goodbye.',
      type: 'system'
    }
  ];

  const VOICE_ID = 'MoRbPlz3injOLU6hNLMY';

  try {
    const agentBody = {
      name: 'Lavora Receptionist',
      conversation_config: {
        tts: {
          model_id: 'eleven_flash_v2',
          voice_id: VOICE_ID,
          optimize_streaming_latency: 4,
          stability: 0.5,
          speed: 1.0,
          similarity_boost: 0.8
        },
        turn: {
          turn_timeout: 2.5,
          turn_eagerness: 'eager',
          speculative_turn: true
        },
        agent: {
          prompt: { prompt: SYSTEM_PROMPT, tools: TOOLS },
          first_message: 'أهلاً بك في لافورا كلينيك — Welcome to Lavora Clinic. Do you prefer Arabic or English?',
          language: 'en'
        }
      }
    };

    // Try PATCH on existing agent; if it fails for any reason, create a fresh one instead
    if (AGENT_ID) {
      const patch = await elevenlabsRequest('PATCH', agentBody);
      if (patch.status === 200) {
        return res.json({ success: true, message: 'Agent updated', agent_id: AGENT_ID, voice_id: VOICE_ID });
      }
      // Fall through to create a new agent regardless of error type
    }

    // Create a brand-new agent (bypasses broken stale tool IDs on old agent)
    const create = await elevenlabsRequest('POST', agentBody, '/v1/convai/agents/create');
    if (create.status !== 200 && create.status !== 201) {
      return res.status(502).json({ error: 'ElevenLabs agent creation failed', detail: create.body });
    }
    const newAgentId = create.body?.agent_id || create.body?.id;
    res.json({
      success: true,
      new_agent_id: newAgentId,
      voice_id: VOICE_ID,
      action_required: 'Go to Railway → your service → Variables → set ELEVENLABS_AGENT_ID = ' + newAgentId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ping ───────────────────────────────────────────────────────────
router.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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

// ─── GET /api/test-stt ────────────────────────────────────────────────────────
// Tests which Deepgram configs open successfully on this account.
// nova-2+ar returning 400 = Arabic not in plan; nova-3+multi opening = upgrade path.
router.get('/test-stt', async (req, res) => {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not set' });

  function testDg(cfg) {
    return new Promise((resolve) => {
      const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
      const timer = setTimeout(() => resolve({ opened: false, error: 'timeout' }), 6000);
      let opened = false;
      const dg = createClient(apiKey);
      const conn = dg.listen.live(cfg);
      conn.on(LiveTranscriptionEvents.Open,  () => { opened = true; clearTimeout(timer); try{conn.finish();}catch{} resolve({ opened: true }); });
      conn.on(LiveTranscriptionEvents.Error, (e) => { clearTimeout(timer); try{conn.finish();}catch{} resolve({ opened: false, error: e?.message?.slice(0,120)||String(e) }); });
      conn.on(LiveTranscriptionEvents.Close, () => { if (!opened) { clearTimeout(timer); resolve({ opened: false, error: 'closed before open' }); } });
    });
  }

  const base = { encoding: 'mulaw', sample_rate: 8000, smart_format: false, interim_results: true };
  const [nova2_multi, nova2_ar, nova3_multi, nova3_ar] = await Promise.all([
    testDg({ ...base, model: 'nova-2', language: 'multi' }),
    testDg({ ...base, model: 'nova-2', language: 'ar'    }),
    testDg({ ...base, model: 'nova-3', language: 'multi' }),
    testDg({ ...base, model: 'nova-3', language: 'ar'    }),
  ]);

  res.json({
    note: 'opened:true means the config works on your account. nova-2+ar=400 means Arabic not in plan.',
    nova2_multi, nova2_ar, nova3_multi, nova3_ar
  });
});

// ─── GET /api/debug ───────────────────────────────────────────────────────────
router.get('/debug', async (req, res) => {
  try {
    const all = await db.getAllAppointments(req.clinicId);
    res.json({
      storage: process.env.DATABASE_URL ? 'postgresql' : 'local-json',
      clinicId: req.clinicId,
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




// ─── GET /api/stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    res.json(await db.getStats(req.clinicId));
  } catch (err) {
    console.error('[API] GET /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/test-register-call ─────────────────────────────────────────────
// Diagnostic: tests ElevenLabs register-call FROM this server (Railway env)
router.get('/test-register-call', async (req, res) => {
  const https = require('https');
  const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
  const API_KEY  = process.env.ELEVENLABS_API_KEY;

  if (!AGENT_ID || !API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing env vars',
      has_agent_id: !!AGENT_ID,
      has_api_key: !!API_KEY,
      agent_id_preview: AGENT_ID ? AGENT_ID.slice(0, 12) + '...' : null
    });
  }

  const body = JSON.stringify({
    agent_id: AGENT_ID,
    from_number: '+15550001234',
    to_number: '+15550005678',
    direction: 'inbound',
    conversation_initiation_client_data: { dynamic_variables: { caller_id: '+15550001234' } }
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.elevenlabs.io',
        path: '/v1/convai/twilio/register-call',
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, resp => {
        let raw = '';
        resp.on('data', c => raw += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: raw }));
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    res.json({
      ok: result.status === 200,
      elevenlabs_status: result.status,
      elevenlabs_response: result.body.slice(0, 500),
      agent_id_preview: AGENT_ID.slice(0, 12) + '...',
      api_key_preview: API_KEY.slice(0, 8) + '...'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/settings ───────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  try {
    res.json(settingsService.getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/settings ───────────────────────────────────────────────────────
router.put('/settings', (req, res) => {
  if (req.nurseSession) return res.status(403).json({ error: 'Forbidden for nurse accounts' });
  try {
    const saved = settingsService.saveSettings(req.body);
    log.info('Settings updated via API');
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/test-whatsapp ───────────────────────────────────────────────────
// Diagnostic: checks env vars and sends a test message via WhatsApp API
router.get('/test-whatsapp', async (req, res) => {
  const axios = require('axios');
  const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token       = process.env.WHATSAPP_ACCESS_TOKEN;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const to          = req.query.to; // e.g. ?to=96512345678

  const config = {
    has_phone_number_id: !!phoneId,
    has_access_token:    !!token,
    has_verify_token:    !!verifyToken,
    has_anthropic_key:   !!anthropicKey,
    phone_id_preview:    phoneId ? phoneId.slice(0, 6) + '...' : null,
    token_preview:       token   ? token.slice(0, 8)   + '...' : null,
  };

  if (!phoneId || !token) {
    return res.status(500).json({ ok: false, error: 'Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN', config });
  }

  if (!to) {
    return res.json({ ok: true, config, note: 'Add ?to=PHONENUMBER to send a test message' });
  }

  try {
    const result = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: 'Test Clinic bot is online and working!' } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, config, whatsapp_response: result.data });
  } catch (err) {
    res.status(500).json({ ok: false, config, error: err.response?.data || err.message });
  }
});

// ─── GET /api/packages ────────────────────────────────────────────────────────
router.get('/packages', async (req, res) => {
  try {
    const all = await db.getAllPackages(req.clinicId);
    const { status } = req.query;
    const filtered = status ? all.filter(p => p.status === status) : all;
    res.json({ count: filtered.length, packages: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/packages ───────────────────────────────────────────────────────
router.post('/packages', async (req, res) => {
  try {
    const { clientName, phone, service = 'Laser Hair Removal', type, notes } = req.body;
    if (!clientName || !phone || !type) {
      return res.status(400).json({ error: 'clientName, phone, and type (1/3/6) are required' });
    }
    if (![1, 3, 6].includes(Number(type))) {
      return res.status(400).json({ error: 'type must be 1, 3, or 6' });
    }
    const pkg = {
      id: `PKG-${Date.now()}`,
      clientName,
      phone,
      service,
      language: 'en',
      type: Number(type),
      status: 'active',
      createdAt: new Date().toISOString(),
      followUpSent: false,
      sessions: [],
      pendingOffer: null,
      notes: notes || ''
    };
    await db.savePackage(pkg, req.clinicId);
    log.info(`Package created manually: ${pkg.id} for ${clientName}`);
    res.status(201).json({ success: true, package: pkg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/clinics ─────────────────────────────────────────────────────────
router.get('/clinics', async (req, res) => {
  try {
    const clinics = await db.getAllClinics();
    res.json({ count: clinics.length, clinics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/clinics ────────────────────────────────────────────────────────
router.post('/clinics', async (req, res) => {
  try {
    const { id, name, api_key } = req.body;
    if (!id || !name || !api_key) {
      return res.status(400).json({ error: 'id, name, and api_key are required' });
    }
    const clinic = await db.createClinic({ id, name, api_key });
    log.info(`Clinic created: ${id}`);
    res.status(201).json({ success: true, clinic });
  } catch (err) {
    if (err.message?.includes('unique') || err.code === '23505') {
      return res.status(409).json({ error: 'Clinic ID or API key already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
