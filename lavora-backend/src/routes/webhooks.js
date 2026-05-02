const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../services/localDbService');
const extractionService = require('../services/extractionService');
const activityService = require('../services/activityService');

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

// ─── POST /webhook/elevenlabs ─────────────────────────────────────────────────
router.post('/elevenlabs', async (req, res) => {
  console.log('\n[WEBHOOK] ElevenLabs webhook received');

  if (!verifyElevenLabsSignature(req)) {
    console.warn('[WEBHOOK] ElevenLabs signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  try {
    const payload = req.body;
    const data = payload.data || payload;

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

      await db.appendMissedCapture({
        id: `MISS-${Date.now()}`,
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

    const hasConflict = await db.checkConflict(fields.date, fields.time, null);
    if (hasConflict) {
      console.warn(`[WEBHOOK] Conflict detected for ${fields.date} ${fields.time} — not booking`);
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
      notes: `Conversation ID: ${conversationId || 'N/A'}`,
      timestamp: new Date().toISOString()
    };

    await db.appendAppointment(apt);
    console.log(`[WEBHOOK] ✅ Appointment saved: ${aptId}`);

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
    const { CallSid, From, To, CallStatus, CallDuration = 0 } = req.body;

    console.log(`[TWILIO] CallSid=${CallSid} | From=${From} | Status=${CallStatus} | Duration=${CallDuration}s`);

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
    console.error('[TWILIO] Error processing call status:', err.message);
  }
});

module.exports = router;
