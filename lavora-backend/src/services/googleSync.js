/**
 * Fire-and-forget Google sync with exponential-backoff retry.
 * PostgreSQL is always written first — this runs in the background.
 */

const sheetsService   = require('./sheetsService');
const calendarService = require('./calendarService');
const db  = require('./localDbService');
const log = require('./logger').child('GOOGLE');

function sheetsOn()   { return sheetsService.googleConfigured(); }
function calendarOn() { return !!(process.env.GOOGLE_CALENDAR_ID); }

async function getAuth() {
  return sheetsService.getAuth();
}

// Retry with exponential back-off (3 attempts: 2s, 4s, 8s)
async function withRetry(label, fn, maxAttempts = 3) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        log.error(`${label} failed after ${maxAttempts} attempts: ${err.message}`);
        return;
      }
      log.warn(`${label} attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

function safe(label, fn) {
  withRetry(label, fn).catch(err => log.error(`${label} unexpected error: ${err.message}`));
}

// ── Book ──────────────────────────────────────────────────────────────────────
function book(apt) {
  safe('book', async () => {
    if (sheetsOn()) await sheetsService.appendAppointment(apt);

    if (calendarOn()) {
      const auth = await getAuth();
      const eventId = await calendarService.createEvent(apt, apt.source || 'AI Voice', auth);
      if (eventId) {
        await db.updateAppointment(apt.id, { calendarEventId: eventId });
        log.info(`Calendar event created: ${eventId}`);
      }
    }
  });
}

// ── Cancel ────────────────────────────────────────────────────────────────────
function cancel(apt) {
  safe('cancel', async () => {
    if (sheetsOn()) await sheetsService.cancelAppointment(apt.id);

    if (calendarOn() && apt.calendarEventId) {
      const auth = await getAuth();
      await calendarService.deleteEvent(apt.calendarEventId, auth);
      log.info(`Calendar event deleted: ${apt.calendarEventId}`);
    }
  });
}

// ── Reschedule ────────────────────────────────────────────────────────────────
function reschedule(apt) {
  safe('reschedule', async () => {
    if (sheetsOn()) {
      await sheetsService.updateAppointment(apt.id, {
        date: apt.date, time: apt.time, status: apt.status
      });
    }

    if (calendarOn() && apt.calendarEventId) {
      const auth = await getAuth();
      await calendarService.updateEvent(apt.calendarEventId, apt, auth);
      log.info(`Calendar event updated: ${apt.calendarEventId}`);
    }
  });
}

module.exports = { book, cancel, reschedule };
