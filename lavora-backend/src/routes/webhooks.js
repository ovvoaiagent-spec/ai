const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const sheetsService = require('../services/sheetsService');
const calendarService = require('../services/calendarService');
const extractionService = require('../services/extractionService');
const activityService = require('../services/activityService');
const { extractPhone } = require('../services/extractionService');

// ─── ElevenLabs Signature Verification ───────────────────────────────────────
function verifyElevenLabsSignature(req) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured

  const signature = req.headers['elevenlabs-signature'] || req.headers['x-elevenlabs-signature'];
  if (!signature) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return signature === `sha256=${expected}` || signature === expected;
}

// ─── POST /webhook/elevenlabs ─────────────────────────────────────────────────
router.post('/elevenlabs', async (req, res) => {
  console.log('\n[WEBHOOK] ElevenLabs webhook received');

  if (!verifyElevenLabsSignature(req)) {
    console.warn('[WEBHOOK] ElevenLabs signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately — ElevenLabs expects fast 200
  res.status(200).json({ received: true });

  try {
    const payload = req.body;
    const data = payload.data || payload;

    // Only process completed conversations
    const status = data.status || payload.type;
    if (status === 'failed' || status === 'error') {
      console.log('[WEBHOOK] Conversation ended with error — skipping');
      return;
    }

    const { fields, missing, isComplete, callDuration, conversationId } = extractionService.extractFromWebhook(payload);

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.CALL_RECEIVED,
      patientName: fields.name || 'Unknown',
      details: `Conversation ${conversationId || 'N/A'} | Duration: ${callDuration}s`
    });

    if (!isComplete) {
      console.log(`[WEBHOOK] Incomplete booking — missing: ${missing.join(', ')}`);

      const missedId = `MISS-${Date.now()}`;
      await sheetsService.appendMissedCapture({
        id: missedId,
        twilioPhone: data.metadata?.caller_id || '',
        partialData: fields,
        missingFields: missing,
        timestamp: new Date().toISOString()
      });

      await activityService.addActivity({
        actor: 'AI Voice',
        actionType: activityService.ACTION_TYPES.MISSED_CAPTURE,
        patientName: fields.name || 'Unknown',
        details: `Missing: ${missing.join(', ')}`
      });

      return;
    }

    // Conflict check
    const hasConflict = await sheetsService.checkConflict(fields.date, fields.time, null);
    if (hasConflict) {
      console.warn(`[WEBHOOK] Conflict detected for ${fields.date} ${fields.time} — not booking`);
      const missedId = `CONF-${Date.now()}`;
      await sheetsService.appendMissedCapture({
        id: missedId,
        twilioPhone: fields.phone,
        partialData: fields,
        missingFields: ['CONFLICT: slot already taken'],
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Create appointment record
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
      notes: `Conversation ID: ${conversationId || 'N/A'}`,
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    // Create Google Calendar event
    let calendarEventId = '';
    try {
      const auth = await sheetsService.getAuth();
      calendarEventId = await calendarService.createEvent(apt, 'AI Voice', auth);
      apt.calendarEventId = calendarEventId;
      console.log(`[WEBHOOK] ✅ Calendar event created: ${calendarEventId}`);
    } catch (calErr) {
      console.error('[WEBHOOK] Calendar error (non-fatal):', calErr.message);
    }

    // Write to Google Sheets
    await sheetsService.appendAppointment(apt);
    console.log(`[WEBHOOK] ✅ Appointment saved to Sheets: ${aptId}`);

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: fields.name,
      details: `${fields.service} on ${fields.date} at ${fields.time} | ID: ${aptId}`
    });

    console.log(`[WEBHOOK] ✅ Full pipeline complete for ${fields.name}`);

  } catch (err) {
    console.error('[WEBHOOK] ElevenLabs processing error:', err.message, err.stack);
  }
});

// ─── POST /webhook/twilio/call-status ────────────────────────────────────────
router.post('/twilio/call-status', async (req, res) => {
  console.log('\n[TWILIO] Call status webhook received');
  res.status(200).send('<Response></Response>');

  try {
    const {
      CallSid, From, To,
      CallStatus, CallDuration = 0
    } = req.body;

    console.log(`[TWILIO] CallSid=${CallSid} | From=${From} | Status=${CallStatus} | Duration=${CallDuration}s`);

    await sheetsService.appendCallLog({
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
    console.error('[TWILIO] Error processing call status:', err.message);
  }
});

module.exports = router;
