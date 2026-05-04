const express = require('express');
const crypto = require('crypto');
const https = require('https');
const router = express.Router();

const db = require('../services/localDbService');
const extractionService = require('../services/extractionService');
const activityService = require('../services/activityService');
const log = require('../services/logger').child('WEBHOOK');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function verifyElevenLabsSignature(req) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = req.headers['elevenlabs-signature'] || req.headers['x-elevenlabs-signature'];
  if (!signature) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return signature === `sha256=${expected}` || signature === expected;
}

// ─── POST /webhook/voice ─────────────────────────────────────────────────────
// Twilio calls this when someone dials the clinic number.
// Looks up caller history, then proxies to ElevenLabs with enriched dynamic vars.
router.post('/voice', async (req, res) => {
  const from = req.body.From || req.body.from || '';
  const to   = req.body.To   || req.body.to   || '';
  const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
  const API_KEY  = process.env.ELEVENLABS_API_KEY;

  log.info(`Inbound call from ${from} to ${to}`);

  if (!AGENT_ID || !API_KEY) {
    res.set('Content-Type', 'text/xml');
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Service not configured. Please try again later.</Say></Response>');
  }

  // Build dynamic vars — start with caller identity
  const dynamicVars = { caller_id: from };

  // Look up caller history for personalised greeting
  try {
    const all = await db.getAllAppointments();
    const normalize = p => String(p || '').replace(/[\s\-().]/g, '');
    const history = all.filter(a =>
      a.status !== 'Cancelled' &&
      normalize(a.phone) === normalize(from)
    ).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    if (history.length > 0) {
      const last = history[history.length - 1];
      dynamicVars.is_returning     = 'true';
      dynamicVars.patient_name     = last.name;
      dynamicVars.last_service     = last.service;
      dynamicVars.last_visit_date  = last.date;
      log.info(`Returning patient: ${last.name}, last: ${last.service} on ${last.date}`);
    } else {
      dynamicVars.is_returning = 'false';
      dynamicVars.patient_name = '';
      dynamicVars.last_service = '';
      dynamicVars.last_visit_date = '';
    }
  } catch (err) {
    log.warn(`Could not look up caller history: ${err.message}`);
  }

  // ── Custom pipeline: Twilio Media Streams → Deepgram → Claude → ElevenLabs TTS
  const useCustomPipeline = !!(process.env.ANTHROPIC_API_KEY && process.env.DEEPGRAM_API_KEY);

  if (useCustomPipeline) {
    const SERVER_URL = (process.env.SERVER_URL || 'https://ai-production-5456.up.railway.app')
      .replace(/\/$/, '');
    const wsUrl = SERVER_URL.replace(/^https?:\/\//, 'wss://') + '/media-stream';

    const paramTags = Object.entries(dynamicVars)
      .map(([k, v]) => `      <Parameter name="${k}" value="${escapeXml(String(v))}"/>`)
      .join('\n');

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
${paramTags}
    </Stream>
  </Connect>
</Response>`;

    log.info(`Custom pipeline TwiML for ${from}, is_returning=${dynamicVars.is_returning}`);
    res.set('Content-Type', 'text/xml');
    return res.send(twiml);
  }

  // ── Fallback: ElevenLabs Conversational AI (register-call) ──────────────
  const body = JSON.stringify({
    agent_id: AGENT_ID,
    from_number: from,
    to_number: to,
    direction: 'inbound',
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVars
    }
  });

  const options = {
    hostname: 'api.elevenlabs.io',
    path: '/v1/convai/twilio/register-call',
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  try {
    const twiml = await new Promise((resolve, reject) => {
      const req2 = https.request(options, r => {
        let raw = '';
        r.on('data', c => raw += c);
        r.on('end', () => resolve({ status: r.statusCode, body: raw }));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (twiml.status === 200) {
      log.info(`ElevenLabs TwiML returned for ${from}, is_returning=${dynamicVars.is_returning}`);
      res.set('Content-Type', 'text/xml');
      return res.send(twiml.body);
    }

    log.error(`ElevenLabs returned ${twiml.status}`, { body: twiml.body });
    res.set('Content-Type', 'text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are unable to connect your call right now. Please try again shortly.</Say></Response>');

  } catch (err) {
    log.error(`Error connecting to ElevenLabs: ${err.message}`);
    res.set('Content-Type', 'text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>A technical error occurred. Please try again.</Say></Response>');
  }
});

// ─── POST /webhook/elevenlabs ─────────────────────────────────────────────────
router.post('/elevenlabs', async (req, res) => {
  log.info('ElevenLabs post-call webhook received');

  if (!verifyElevenLabsSignature(req)) {
    log.warn('ElevenLabs signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  try {
    const payload = req.body;
    const data = payload.data || payload;
    const status = data.status || payload.type;

    if (status === 'failed' || status === 'error') {
      log.warn(`Conversation ended with status: ${status} — skipping`);
      return;
    }

    const { fields, missing, isComplete, callDuration, conversationId } = extractionService.extractFromWebhook(payload);

    // Store transcript if available
    const transcript = data.transcript || payload.transcript || null;
    const transcriptText = Array.isArray(transcript)
      ? transcript.map(t => `${t.role}: ${t.message}`).join('\n')
      : (typeof transcript === 'string' ? transcript : '');

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.CALL_RECEIVED,
      patientName: fields.name || 'Unknown',
      details: `Conversation ${conversationId || 'N/A'} | Duration: ${callDuration}s${transcriptText ? ' | Transcript stored' : ''}`
    });

    if (!isComplete) {
      log.info(`Incomplete booking — missing: ${missing.join(', ')}`);

      await db.appendMissedCapture({
        id: `MISS-${Date.now()}`,
        twilioPhone: data.metadata?.caller_id || '',
        partialData: fields,
        missingFields: missing,
        timestamp: new Date().toISOString(),
        transcript: transcriptText
      });

      await activityService.addActivity({
        actor: 'AI Voice',
        actionType: activityService.ACTION_TYPES.MISSED_CAPTURE,
        patientName: fields.name || 'Unknown',
        details: `Missing: ${missing.join(', ')}`
      });

      return;
    }

    const hasConflict = await db.checkConflict(fields.date, fields.time, null);
    if (hasConflict) {
      log.warn(`Conflict for ${fields.date} ${fields.time} — not booking`);
      await db.appendMissedCapture({
        id: `CONF-${Date.now()}`,
        twilioPhone: fields.phone,
        partialData: fields,
        missingFields: ['CONFLICT: slot already taken'],
        timestamp: new Date().toISOString()
      });
      return;
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId,
      name: fields.name,
      phone: fields.phone,
      service: fields.service,
      doctor: '',
      date: fields.date,
      time: fields.time,
      status: 'Pending',
      source: 'AI Voice',
      callDuration,
      notes: `Conversation: ${conversationId || 'N/A'}`,
      transcript: transcriptText,
      timestamp: new Date().toISOString()
    };

    await db.appendAppointment(apt);
    log.info(`Appointment saved: ${aptId}`);

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: fields.name,
      details: `${fields.service} on ${fields.date} at ${fields.time} | ID: ${aptId}`
    });

  } catch (err) {
    log.error(`ElevenLabs webhook processing error: ${err.message}`, { stack: err.stack });
  }
});

// ─── POST /webhook/twilio/call-status ────────────────────────────────────────
router.post('/twilio/call-status', async (req, res) => {
  res.status(200).send('<Response></Response>');

  try {
    const { CallSid, From, To, CallStatus, CallDuration = 0 } = req.body;
    log.info(`Call status: ${CallSid} ${From}→${To} ${CallStatus} ${CallDuration}s`);

    await db.appendCallLog({
      callSid: CallSid,
      from: From,
      to: To,
      duration: CallDuration,
      status: CallStatus,
      timestamp: new Date().toISOString()
    });

    await activityService.addActivity({
      actor: 'Twilio',
      actionType: activityService.ACTION_TYPES.CALL_RECEIVED,
      patientName: From || 'Unknown caller',
      details: `CallSid: ${CallSid} | Status: ${CallStatus} | Duration: ${CallDuration}s`
    });

  } catch (err) {
    log.error(`Twilio call-status error: ${err.message}`);
  }
});

module.exports = router;
