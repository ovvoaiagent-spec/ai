/**
 * Outbound WhatsApp notifications via Meta Business API.
 * Replaces Twilio SMS for booking confirmations, cancellations,
 * reschedule confirmations, and 24-hour reminders.
 */

const axios = require('axios');
const log   = require('./logger').child('NOTIFY');

function getConfig() {
  return {
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    token:   process.env.WHATSAPP_ACCESS_TOKEN
  };
}

async function sendWA(to, text) {
  const { phoneId, token } = getConfig();
  if (!phoneId || !token) {
    log.warn('WhatsApp not configured — notification skipped');
    return;
  }

  // Normalize phone: strip non-digits, remove leading 00 or +
  let phone = String(to).replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');

  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: text, preview_url: false }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    log.info(`WhatsApp notification sent → ${phone}`);
  } catch (err) {
    log.warn(`WhatsApp notification failed → ${phone}: ${err.response?.data?.error?.message || err.message}`);
  }
}

function safe(label, fn) {
  fn().catch(err => log.warn(`${label} failed (non-fatal): ${err.message}`));
}

// ── Booking confirmation ──────────────────────────────────────────────────────
function sendBookingConfirmation(apt) {
  safe('booking-confirmation', () => sendWA(apt.phone,
    `✅ Test Clinic — Booking Confirmed\n` +
    `Name: ${apt.name}\n` +
    `Service: ${apt.service}\n` +
    `Date: ${apt.date} at ${apt.time}\n\n` +
    `To cancel or reschedule, reply to this message.`
  ));
}

// ── Cancellation confirmation ─────────────────────────────────────────────────
function sendCancellationConfirmation(apt) {
  safe('cancellation-confirmation', () => sendWA(apt.phone,
    `❌ Test Clinic — Appointment Cancelled\n` +
    `Your ${apt.service} appointment on ${apt.date} at ${apt.time} has been cancelled.\n\n` +
    `To book a new appointment, reply to this message.`
  ));
}

// ── Reschedule confirmation ───────────────────────────────────────────────────
function sendRescheduleConfirmation(apt) {
  safe('reschedule-confirmation', () => sendWA(apt.phone,
    `🔄 Test Clinic — Appointment Rescheduled\n` +
    `Your ${apt.service} appointment has been moved to ${apt.date} at ${apt.time}.\n\n` +
    `To cancel or reschedule again, reply to this message.`
  ));
}

// ── 24-hour reminder ──────────────────────────────────────────────────────────
function sendReminder(apt) {
  safe('reminder', () => sendWA(apt.phone,
    `⏰ Test Clinic — Appointment Reminder\n` +
    `Hi ${apt.name}, this is a reminder that you have a ${apt.service} appointment tomorrow at ${apt.time}.\n\n` +
    `To cancel or reschedule, reply to this message.`
  ));
}

module.exports = {
  sendBookingConfirmation,
  sendCancellationConfirmation,
  sendRescheduleConfirmation,
  sendReminder
};
