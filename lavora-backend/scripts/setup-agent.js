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
    description: 'Check if a specific date and time slot is available for booking. Always call this before confirming a slot with the patient.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/check-availability`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format, e.g. 2025-05-12', dynamic_variable: '', constant_value: '' },
          time: { type: 'string', description: 'Time in HH:MM 24-hour format, e.g. 10:30', dynamic_variable: '', constant_value: '' }
        },
        required: ['date', 'time']
      }
    }
  },
  {
    name: 'book_appointment',
    description: 'Book the appointment once all 5 fields are confirmed by the patient. This saves to Google Sheets and Google Calendar immediately.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/book-appointment`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Patient full name in English', dynamic_variable: '', constant_value: '' },
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
    description: 'Get the full list of services offered at Lavora Clinic. Call this if the patient is unsure what service they want.',
    type: 'webhook',
    api_schema: {
      url: `${SERVER_URL}/tools/get-services`,
      method: 'POST',
      request_body_schema: { type: 'object', properties: {} }
    }
  },
  {
    name: 'get_working_hours',
    description: 'Get the clinic working hours. Call this if the patient asks about opening hours or if the requested time might be outside working hours.',
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
    console.error(JSON.stringify(current.body, null, 2));
    process.exit(1);
  }
  console.log(`✅ Agent found: "${current.body.name || AGENT_ID}"`);

  const VOICE_ID = 'MoRbPlz3injOLU6hNLMY';
  console.log(`\n[2/2] Applying system prompt + tools (voice: ${VOICE_ID})...`);

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
  console.log('\n📋 Next steps:');
  console.log('  1. Make sure your server is publicly reachable (ngrok or deployed)');
  console.log('  2. Call your Twilio number and say "I want to book a Botox appointment"');
  console.log('  3. The agent will check availability and book live during the call');
  console.log('  4. Check your Google Sheet and Calendar for the new entry\n');
}

run().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
