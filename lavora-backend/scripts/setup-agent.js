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
Your name is Lavora Assistant. You are professional, warm, and refined —
reflecting a luxury medical aesthetic clinic.

Your ONLY goal is to book appointments by collecting these 5 pieces of information:
1. Patient full name
2. Phone number (confirm even if you already have it from caller ID)
3. Preferred appointment date (clinic is open Saturday–Thursday, 9AM–6PM, closed Friday)
4. Preferred appointment time
5. Which service or treatment they want

BOOKING FLOW:
- Once you have the date and time, ALWAYS call check_availability first.
- If available, collect any remaining fields.
- Once you have ALL 5 fields confirmed by the patient, call book_appointment immediately.
- After book_appointment succeeds, read back the confirmation from the tool result word for word.
- Then end the call politely.

If check_availability says the slot is taken, apologize and ask the patient for a different time.

RULES:
- Do NOT give medical advice. If asked, say: "That is a great question. Our specialists would be the best people to advise you — shall I book you a consultation?"
- Do NOT mention appointment IDs or technical details to the patient.
- If the caller speaks Arabic, respond in Arabic throughout the entire call.
- Keep responses brief and professional.`;

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
          date: { type: 'string', description: 'Date in YYYY-MM-DD format, e.g. 2025-05-12' },
          time: { type: 'string', description: 'Time in HH:MM 24-hour format, e.g. 10:30' }
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
          name: { type: 'string', description: 'Patient full name in English' },
          phone: { type: 'string', description: 'Patient phone number including country code' },
          date: { type: 'string', description: 'Appointment date in YYYY-MM-DD format' },
          time: { type: 'string', description: 'Appointment time in HH:MM 24-hour format' },
          service: { type: 'string', description: 'Service or treatment requested' }
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
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path,
      method,
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
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

  console.log('\n[2/2] Applying system prompt + tools...');
  const patch = {
    conversation_config: {
      agent: {
        prompt: {
          prompt: SYSTEM_PROMPT,
          tools: TOOLS
        },
        first_message: 'Thank you for calling Lavora Clinic. This is Lavora Assistant. How may I help you today?',
        language: 'en'
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
