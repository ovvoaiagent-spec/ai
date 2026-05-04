/**
 * Outbound SMS / WhatsApp notifications via Twilio.
 * All calls are fire-and-forget — failures are logged but never crash the caller.
 */

const log = require('./logger').child('SMS');

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER || '+14173029310';

  if (!accountSid || !authToken) return null;

  const twilio = require('twilio');
  return { client: twilio(accountSid, authToken), from };
}

function safe(label, fn) {
  fn().catch(err => log.warn(`${label} failed (non-fatal): ${err.message}`));
}

// ── Booking confirmation ──────────────────────────────────────────────────────
function sendBookingConfirmation(apt) {
  safe('booking-confirmation', async () => {
    const twilio = getTwilioClient();
    if (!twilio) return;

    const body =
      `✅ Lavora Clinic — Booking Confirmed\n` +
      `Name: ${apt.name}\n` +
      `Service: ${apt.service}\n` +
      `Date: ${apt.date} at ${apt.time}\n` +
      `To cancel or reschedule, call +14173029310.`;

    await twilio.client.messages.create({
      body,
      from: twilio.from,
      to: apt.phone
    });

    log.info(`Booking confirmation sent to ${apt.phone}`);
  });
}

// ── Cancellation confirmation ─────────────────────────────────────────────────
function sendCancellationConfirmation(apt) {
  safe('cancellation-confirmation', async () => {
    const twilio = getTwilioClient();
    if (!twilio) return;

    const body =
      `❌ Lavora Clinic — Appointment Cancelled\n` +
      `Your ${apt.service} appointment on ${apt.date} at ${apt.time} has been cancelled.\n` +
      `To book again, call +14173029310.`;

    await twilio.client.messages.create({ body, from: twilio.from, to: apt.phone });
    log.info(`Cancellation confirmation sent to ${apt.phone}`);
  });
}

// ── Reschedule confirmation ───────────────────────────────────────────────────
function sendRescheduleConfirmation(apt) {
  safe('reschedule-confirmation', async () => {
    const twilio = getTwilioClient();
    if (!twilio) return;

    const body =
      `🔄 Lavora Clinic — Appointment Rescheduled\n` +
      `Your ${apt.service} appointment has been moved to ${apt.date} at ${apt.time}.\n` +
      `To cancel, call +14173029310.`;

    await twilio.client.messages.create({ body, from: twilio.from, to: apt.phone });
    log.info(`Reschedule confirmation sent to ${apt.phone}`);
  });
}

// ── Reminder (24h before) ─────────────────────────────────────────────────────
function sendReminder(apt) {
  safe('reminder', async () => {
    const twilio = getTwilioClient();
    if (!twilio) return;

    const body =
      `⏰ Lavora Clinic — Reminder\n` +
      `Hi ${apt.name}, you have a ${apt.service} appointment tomorrow at ${apt.time}.\n` +
      `To cancel or reschedule, call +14173029310.`;

    await twilio.client.messages.create({ body, from: twilio.from, to: apt.phone });
    log.info(`Reminder sent to ${apt.phone} for ${apt.date} ${apt.time}`);
  });
}

module.exports = {
  sendBookingConfirmation,
  sendCancellationConfirmation,
  sendRescheduleConfirmation,
  sendReminder
};
