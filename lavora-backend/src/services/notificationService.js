/**
 * Outbound WhatsApp notifications via Meta Business API.
 * All messages sent in the client's language (apt.language = "ar" | "en").
 * Defaults to Arabic if not set.
 */

const axios  = require('axios');
const log    = require('./logger').child('NOTIFY');
const { getSettings } = require('./settingsService');

function clinicLine(ar) {
  const s = getSettings();
  return ar
    ? `📍 ${s.clinic?.nameAr || 'عيادة تيست'}، ${s.clinic?.addressAr || 'الغبرة، مسقط'}`
    : `📍 ${s.clinic?.name || 'Test Clinic'}, ${s.clinic?.address || 'Al Ghubrah, Muscat'}`;
}

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
  const phone = String(to).replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
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

function isAr(apt) {
  return (apt.language || 'ar') !== 'en';
}

// ── Booking confirmation ──────────────────────────────────────────────────────
function sendBookingConfirmation(apt) {
  const doctorLine = apt.doctor ? (isAr(apt) ? `\n👩‍⚕️ ${apt.doctor}` : `\n👩‍⚕️ ${apt.doctor}`) : '';
  const text = isAr(apt)
    ? `✅ تم الحجز، ${apt.name}!\n\n📅 ${apt.date}\n🕐 ${apt.time}\n💆 ${apt.service}${doctorLine}\n${clinicLine(true)}`
    : `✅ Booking Confirmed, ${apt.name}!\n\n📅 ${apt.date}\n🕐 ${apt.time}\n💆 ${apt.service}${doctorLine}\n${clinicLine(false)}`;
  safe('booking-confirmation', () => sendWA(apt.phone, text));
}

// ── Cancellation confirmation ─────────────────────────────────────────────────
function sendCancellationConfirmation(apt) {
  const text = isAr(apt)
    ? `❌ تم إلغاء الموعد.\nموعد ${apt.service} بتاريخ ${apt.date} الساعة ${apt.time} تم إلغاؤه.`
    : `❌ Appointment Cancelled.\nYour ${apt.service} appointment on ${apt.date} at ${apt.time} has been cancelled.`;
  safe('cancellation-confirmation', () => sendWA(apt.phone, text));
}

// ── Reschedule confirmation ───────────────────────────────────────────────────
function sendRescheduleConfirmation(apt) {
  const text = isAr(apt)
    ? `🔄 تم تعديل الموعد.\nموعدك لـ ${apt.service} نُقل إلى ${apt.date} الساعة ${apt.time}.`
    : `🔄 Appointment Rescheduled.\nYour ${apt.service} appointment has been moved to ${apt.date} at ${apt.time}.`;
  safe('reschedule-confirmation', () => sendWA(apt.phone, text));
}

// ── 24-hour reminder ──────────────────────────────────────────────────────────
function sendReminder(apt) {
  const doctorLine = apt.doctor ? `\n👩‍⚕️ ${apt.doctor}` : '';
  const text = isAr(apt)
    ? `👋 أهلاً ${apt.name}، تذكير من ${getSettings().clinic?.nameAr||'عيادة تيست'}.\n\n📅 غداً — ${apt.date} الساعة ${apt.time}\n💆 ${apt.service}${doctorLine}\n${clinicLine(true)}\n\nنتطلع لرؤيتك! 🌿`
    : `👋 Hello ${apt.name}, a reminder from ${getSettings().clinic?.name||'Test Clinic'}.\n\n📅 Tomorrow — ${apt.date} at ${apt.time}\n💆 ${apt.service}${doctorLine}\n${clinicLine(false)}\n\nWe look forward to seeing you! 🌿`;
  safe('reminder', () => sendWA(apt.phone, text));
}

module.exports = {
  sendBookingConfirmation,
  sendCancellationConfirmation,
  sendRescheduleConfirmation,
  sendReminder
};
