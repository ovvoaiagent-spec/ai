/**
 * Fire-and-forget Google sync layer.
 * PostgreSQL (localDbService) is always written first — this runs in the background.
 * If Google fails for any reason, the CRM dashboard still has the data.
 */

const sheetsService  = require('./sheetsService');
const calendarService = require('./calendarService');
const db = require('./localDbService');

function safe(label, fn) {
  fn().catch(err => console.warn(`[GOOGLE SYNC] ${label} (non-fatal):`, err.message));
}

function sheetsOn()   { return sheetsService.googleConfigured(); }
function calendarOn() { return !!(process.env.GOOGLE_CALENDAR_ID); }

async function getAuth() {
  return sheetsService.getAuth();
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
        console.log(`[GOOGLE SYNC] Calendar event created: ${eventId}`);
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
      console.log(`[GOOGLE SYNC] Calendar event deleted: ${apt.calendarEventId}`);
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
      console.log(`[GOOGLE SYNC] Calendar event updated: ${apt.calendarEventId}`);
    }
  });
}

module.exports = { book, cancel, reschedule };
