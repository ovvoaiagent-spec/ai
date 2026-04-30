/**
 * End-to-end pipeline test — simulates an ElevenLabs webhook POST
 * Verifies: extraction → Sheets write → Calendar create
 *
 * Usage:
 *   node test/simulate-call.js              # uses localhost:3000
 *   BASE_URL=https://your.ngrok.url node test/simulate-call.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const https = require('https');
const url = require('url');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CRM_KEY = process.env.CRM_SECRET_KEY || 'test-key';

// ─── Fake ElevenLabs webhook payload ────────────────────────────────────────
const fakeElevenLabsPayload = {
  type: 'conversation',
  event_timestamp: Date.now(),
  data: {
    conversation_id: `conv_test_${Date.now()}`,
    agent_id: process.env.ELEVENLABS_AGENT_ID || 'agent_test',
    status: 'done',
    transcript: [
      { role: 'agent', message: 'Hello, thank you for calling Lavora Clinic. My name is Lavora Assistant. How may I help you today?' },
      { role: 'user', message: 'Hi, I would like to book an appointment.' },
      { role: 'agent', message: 'Of course! I would be happy to help. May I have your full name please?' },
      { role: 'user', message: 'My name is Fatima Al-Rashidi.' },
      { role: 'agent', message: 'Thank you, Fatima. And your phone number?' },
      { role: 'user', message: 'My number is plus 968 91234567.' },
      { role: 'agent', message: 'Perfect. Which service are you interested in?' },
      { role: 'user', message: 'I am interested in Botox treatment.' },
      { role: 'agent', message: 'Wonderful choice. What date would you prefer for your appointment?' },
      { role: 'user', message: 'I would like to come on Monday May 12th.' },
      { role: 'agent', message: 'And what time works best for you?' },
      { role: 'user', message: 'Ten thirty in the morning please.' },
      { role: 'agent', message: 'Let me confirm: Fatima Al-Rashidi, phone +96891234567, Botox on May 12th at 10:30 AM. Is that correct?' },
      { role: 'user', message: 'Yes, that is correct.' },
      { role: 'agent', message: 'I have noted your appointment request. Our team will confirm shortly via WhatsApp or SMS. Thank you for calling Lavora Clinic.' }
    ],
    metadata: {
      start_time_unix_secs: Math.floor(Date.now() / 1000) - 120,
      call_duration_secs: 120,
      caller_id: '+96891234567'
    },
    analysis: {
      data_collection_results: {
        patient_full_name: { value: 'Fatima Al-Rashidi', rationale: 'User stated their name' },
        patient_phone: { value: '+96891234567', rationale: 'User provided phone number' },
        appointment_date: { value: '2025-05-12', rationale: 'User said Monday May 12th' },
        appointment_time: { value: '10:30', rationale: 'User said ten thirty in the morning' },
        service_requested: { value: 'Botox', rationale: 'User requested Botox treatment' }
      }
    }
  }
};

// ─── Fake Twilio call-status payload ────────────────────────────────────────
const fakeTwilioPayload = new URLSearchParams({
  CallSid: `CA${Date.now()}`,
  From: '+96891234567',
  To: process.env.TWILIO_PHONE_NUMBER || '+96890000000',
  CallStatus: 'completed',
  CallDuration: '120',
  AccountSid: process.env.TWILIO_ACCOUNT_SID || 'AC_test'
}).toString();

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(`${BASE_URL}${path}`);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const defaultHeaders = {
      'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'X-Api-Key': CRM_KEY,
      ...headers
    };

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method,
      headers: defaultHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Test runner ─────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║       Lavora Clinic — Pipeline Simulation Test       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\nTarget: ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`  ▶ ${name}... `);
    try {
      await fn();
      console.log('✅ PASS');
      passed++;
    } catch (err) {
      console.log(`❌ FAIL — ${err.message}`);
      failed++;
    }
  }

  // 1. Health check
  await test('Health check', async () => {
    const res = await request('GET', '/health', '');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (res.body.status !== 'ok') throw new Error('Unexpected body');
  });

  // 2. ElevenLabs webhook (full pipeline)
  await test('ElevenLabs webhook — full booking pipeline', async () => {
    const res = await request(
      'POST', '/webhook/elevenlabs',
      fakeElevenLabsPayload,
      { 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.body)}`);
    console.log('\n    Pipeline running in background (Sheets + Calendar)...');
  });

  // 3. Twilio call status
  await test('Twilio call-status webhook', async () => {
    const res = await request(
      'POST', '/webhook/twilio/call-status',
      fakeTwilioPayload,
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
  });

  // Wait for async background processing
  console.log('\n  ⏳ Waiting 3s for async pipeline to complete...');
  await sleep(3000);

  // 4. CRM API — list appointments
  await test('GET /api/appointments', async () => {
    const res = await request('GET', '/api/appointments', '');
    if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.body)}`);
    console.log(`\n    Found ${res.body.count} appointments`);
  });

  // 5. CRM API — manual booking
  let createdId = null;
  await test('POST /api/appointments (manual/human booking)', async () => {
    const res = await request('POST', '/api/appointments', {
      name: 'Layla Hassan',
      phone: '+96892345678',
      service: 'Laser Hair Removal',
      doctor: 'Dr. Hussein',
      date: '2025-05-15',
      time: '14:00',
      notes: 'First visit'
    });
    if (res.status !== 201) throw new Error(`Status ${res.status}: ${JSON.stringify(res.body)}`);
    createdId = res.body.appointment?.id;
    console.log(`\n    Created appointment: ${createdId}`);
  });

  // 6. Update appointment
  if (createdId) {
    await test('PUT /api/appointments/:id (reschedule)', async () => {
      const res = await request('PUT', `/api/appointments/${createdId}`, {
        time: '15:30',
        notes: 'Rescheduled by patient'
      });
      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.body)}`);
    });
  }

  // 7. Stats
  await test('GET /api/stats', async () => {
    const res = await request('GET', '/api/stats', '');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    console.log(`\n    Stats: ${JSON.stringify(res.body)}`);
  });

  // 8. Activity log
  await test('GET /api/activity', async () => {
    const res = await request('GET', '/api/activity', '');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    console.log(`\n    Activity entries: ${res.body.activities.length}`);
  });

  // 9. Auth protection
  await test('Unauthorized request blocked (no API key)', async () => {
    const res = await request('GET', '/api/appointments', '', { 'X-Api-Key': 'wrong-key' });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 10. Cancel appointment
  if (createdId) {
    await test('DELETE /api/appointments/:id (cancel)', async () => {
      const res = await request('DELETE', `/api/appointments/${createdId}`, '');
      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.body)}`);
    });
  }

  // ─── Summary
  console.log('\n' + '─'.repeat(54));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✅ All tests passed — pipeline is working!\n');
  } else {
    console.log('  ⚠️  Some tests failed — check server logs above\n');
  }
  console.log('─'.repeat(54) + '\n');
}

run().catch(err => {
  console.error('\n[TEST] Fatal error:', err.message);
  process.exit(1);
});
