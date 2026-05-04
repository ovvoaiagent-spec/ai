/**
 * Configures your ElevenLabs Conversational AI agent via the API.
 * Run once after setting up your server URL:
 *   node scripts/setup-agent.js https://your-server.com
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;
const SERVER_URL = (process.argv[2] || process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');

if (!AGENT_ID || !API_KEY) {
  console.error('❌ Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in .env');
  process.exit(1);
}

const SYSTEM_PROMPT = `You are the AI voice receptionist for Lavora Clinic in Muscat, Oman.
Your name is Lavora Assistant. You are professional, warm, and refined — reflecting a luxury medical aesthetic clinic.

STEP 1 — LANGUAGE: Ask if the patient prefers Arabic or English. Switch fully to their chosen language immediately.

STEP 2 — INTENT: Ask what they would like to do:
  A) Book a new appointment
  B) Cancel an appointment
  C) Reschedule an appointment

━━━ FLOW A: NEW BOOKING ━━━
A1. Ask what service or treatment they want.
A2. Ask for their preferred appointment day.
A3. Ask for their preferred appointment time.
A4. Ask for their full name.
A5. Ask: "Would you like us to contact you on the number you are calling from, or a different number?"
    - If they say "this number", "same number", or similar: the system will use their calling number automatically. Do NOT ask for a phone number.
    - If they give a different number: note it down, then call book_appointment with that number in the phone field.
A6. Call check_availability immediately — no words, no filler.
A7. If available, call book_appointment immediately. If using their calling number, do NOT pass a phone field — the system fills it in automatically. If they gave a different number, pass that number as the phone field.
A8. After book_appointment returns success, say this ONCE and only ONCE:
    "Your [Service] appointment is confirmed for [Date] at [Time]. Thank you for calling Lavora Clinic. Goodbye."
A9. End the call. Say nothing else.

━━━ FLOW B: CANCELLATION ━━━
B1. Call find_appointment to look up their appointment by caller number.
B2. Read back the appointment details: "I found your [Service] appointment on [Date] at [Time]. Shall I cancel this?"
B3. If they confirm, call cancel_appointment with the appointment_id.
B4. After cancel_appointment returns success, say ONCE:
    "Your [Service] appointment on [Date] at [Time] has been cancelled. Thank you for calling Lavora Clinic. Goodbye."
B5. End the call. Say nothing else.

━━━ FLOW C: RESCHEDULE ━━━
C1. Call find_appointment to look up their appointment by caller number.
C2. Read back: "I found your [Service] appointment on [Date] at [Time]. What is your preferred new day?"
C3. Ask for their preferred new time.
C4. Call check_availability for the new date and time.
C5. If available, call reschedule_appointment with appointment_id, new_date, and new_time.
C6. After reschedule_appointment returns success, say ONCE:
    "Your [Service] appointment has been rescheduled to [New Date] at [New Time]. Thank you for calling Lavora Clinic. Goodbye."
C7. End the call. Say nothing else.

Available services: Botox, Fillers, Profhilo, Thread Lifting, Endolift, PRP, Mesotherapy, Exosomes, Stem Cell, Frax Pro, Picoway, RedTouch, Chemical Peels, Laser Hair Removal, Onda Plus, Redustim, Body Wraps, Aesthetic Gynecology, Medical Skin Care, Dermatology, Consultation.

RULES:
- ALWAYS call the relevant tool before speaking any confirmation. Never confirm verbally without calling the tool first.
- Do NOT say "thank you", "great", "perfect", or any filler between the last question and the closing line.
- Say the closing line ONCE. Nothing after it — no extra farewell.
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
      url: `${SERVER_URL}/tools/check-availability`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format', dynamic_variable: '', constant_value: '' },
          time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' }
        },
        required: ['date', 'time']
      }
    }
  },
  {
    name: 'book_appointment',
    description: 'Save a new appointment. Call only after check_availability confirms the slot is free.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/book-appointment`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Patient full name', dynamic_variable: '', constant_value: '' },
          phone:   { type: 'string', dynamic_variable: 'caller_id', constant_value: '' },
          date:    { type: 'string', description: 'Appointment date in YYYY-MM-DD format', dynamic_variable: '', constant_value: '' },
          time:    { type: 'string', description: 'Appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' },
          service: { type: 'string', description: 'Service or treatment requested', dynamic_variable: '', constant_value: '' }
        },
        required: ['name', 'phone', 'date', 'time', 'service']
      }
    }
  },
  {
    name: 'find_appointment',
    description: 'Look up the most recent active appointment for a phone number. Call this at the start of cancel or reschedule flows.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/find-appointment`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', dynamic_variable: 'caller_id', constant_value: '' }
        },
        required: ['phone']
      }
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment. Call after the patient confirms they want to cancel.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/cancel-appointment`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string', description: 'The appointment ID returned by find_appointment', dynamic_variable: '', constant_value: '' },
          phone:          { type: 'string', dynamic_variable: 'caller_id', constant_value: '' }
        },
        required: []
      }
    }
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new date and time. Call only after check_availability confirms the new slot is free.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/reschedule-appointment`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string', description: 'The appointment ID returned by find_appointment', dynamic_variable: '', constant_value: '' },
          phone:          { type: 'string', dynamic_variable: 'caller_id', constant_value: '' },
          new_date:       { type: 'string', description: 'New appointment date in YYYY-MM-DD format', dynamic_variable: '', constant_value: '' },
          new_time:       { type: 'string', description: 'New appointment time in HH:MM 24-hour format', dynamic_variable: '', constant_value: '' }
        },
        required: ['new_date', 'new_time']
      }
    }
  },
  {
    name: 'get_services',
    description: 'Get the full list of services. Call if the patient is unsure what they want.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/get-services`,
      method: 'POST',
      request_body_schema: { type: 'object', properties: {} }
    }
  },
  {
    name: 'get_working_hours',
    description: 'Get clinic working hours. Call if the patient asks about opening times.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/get-working-hours`,
      method: 'POST',
      request_body_schema: { type: 'object', properties: {} }
    }
  }
];

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body && Object.keys(body).length > 0;
    const data = hasBody ? JSON.stringify(body) : null;
    const headers = { 'xi-api-key': API_KEY };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path,
      method,
      headers
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  console.log('\n🤖 Lavora Clinic — ElevenLabs Agent Setup');
  console.log('─'.repeat(50));
  console.log(`Agent ID:   ${AGENT_ID}`);
  console.log(`Server URL: ${SERVER_URL}`);
  console.log('─'.repeat(50));

  console.log('\n[1/2] Fetching current agent config...');
  const current = await apiCall('GET', `/v1/convai/agents/${AGENT_ID}`, {});
  if (current.status !== 200) {
    console.error(`❌ Could not fetch agent: HTTP ${current.status}`);
    process.exit(1);
  }
  console.log(`✅ Agent found: "${current.body.name || AGENT_ID}"`);

  const VOICE_ID = 'MoRbPlz3injOLU6hNLMY';
  console.log(`\n[2/2] Applying system prompt + ${TOOLS.length} tools (voice: ${VOICE_ID})...`);

  const patch = {
    conversation_config: {
      tts: { voice_id: VOICE_ID },
      agent: {
        prompt: {
          prompt: SYSTEM_PROMPT,
          tools: TOOLS
        },
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
  };

  const result = await apiCall('PATCH', `/v1/convai/agents/${AGENT_ID}`, patch);
  if (result.status !== 200) {
    console.error(`❌ Failed to update agent: HTTP ${result.status}`);
    console.error(JSON.stringify(result.body, null, 2));
    process.exit(1);
  }

  console.log('\n✅ Agent configured successfully!\n');
  console.log('Tools registered:');
  TOOLS.forEach(t => console.log(`  • ${t.name} → ${t.api_schema.url}`));
  console.log('\n📋 The agent now handles:');
  console.log('  📅 New bookings   — book_appointment');
  console.log('  ❌ Cancellations  — cancel_appointment');
  console.log('  🔄 Reschedules    — reschedule_appointment');
  console.log('  All changes appear in the CRM dashboard instantly.\n');
}

run().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
