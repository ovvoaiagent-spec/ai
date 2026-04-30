const { google } = require('googleapis');
const dayjs = require('dayjs');

const CLINIC_LOCATION = 'Lavora Clinic, November Street, Al Marafah Street, Al Ghubrah Ash Shamaliyyah, Muscat, Oman';
const EVENT_DURATION_MINUTES = 60;
const COLOR_AI = '2';     // Sage green
const COLOR_HUMAN = '5';  // Banana (gold/yellow)

let calendar = null;
const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID;

async function getClient(auth) {
  if (calendar) return calendar;
  calendar = google.calendar({ version: 'v3', auth });
  return calendar;
}

async function createEvent(apt, source = 'AI Voice', auth) {
  if (!auth || !CALENDAR_ID()) {
    console.log('[CALENDAR] Skipping event creation — Google Calendar not configured');
    return null;
  }
  const cal = await getClient(auth);

  const startDt = dayjs(`${apt.date}T${apt.time}:00`);
  const endDt = startDt.add(EVENT_DURATION_MINUTES, 'minute');

  const event = {
    summary: `${apt.service} — ${apt.name}`,
    description: [
      `Phone: ${apt.phone}`,
      `Doctor: ${apt.doctor || 'TBD'}`,
      `Booked via: ${source}`,
      apt.notes ? `Notes: ${apt.notes}` : ''
    ].filter(Boolean).join('\n'),
    location: CLINIC_LOCATION,
    colorId: source === 'AI Voice' ? COLOR_AI : COLOR_HUMAN,
    start: {
      dateTime: startDt.toISOString(),
      timeZone: 'Asia/Muscat'
    },
    end: {
      dateTime: endDt.toISOString(),
      timeZone: 'Asia/Muscat'
    }
  };

  const res = await cal.events.insert({
    calendarId: CALENDAR_ID(),
    requestBody: event
  });

  console.log(`[CALENDAR] Event created: ${res.data.id} — "${event.summary}"`);
  return res.data.id;
}

async function updateEvent(eventId, apt, auth) {
  if (!eventId || !auth || !CALENDAR_ID()) return null;
  const cal = await getClient(auth);

  const startDt = dayjs(`${apt.date}T${apt.time}:00`);
  const endDt = startDt.add(EVENT_DURATION_MINUTES, 'minute');

  const patch = {
    summary: `${apt.service} — ${apt.name}`,
    description: [
      `Phone: ${apt.phone}`,
      `Doctor: ${apt.doctor || 'TBD'}`,
      `Booked via: ${apt.source || 'Human'}`,
      apt.notes ? `Notes: ${apt.notes}` : ''
    ].filter(Boolean).join('\n'),
    start: {
      dateTime: startDt.toISOString(),
      timeZone: 'Asia/Muscat'
    },
    end: {
      dateTime: endDt.toISOString(),
      timeZone: 'Asia/Muscat'
    }
  };

  const res = await cal.events.patch({
    calendarId: CALENDAR_ID(),
    eventId,
    requestBody: patch
  });

  console.log(`[CALENDAR] Event updated: ${eventId}`);
  return res.data.id;
}

async function deleteEvent(eventId, auth) {
  if (!eventId || !auth || !CALENDAR_ID()) return;
  const cal = await getClient(auth);
  await cal.events.delete({
    calendarId: CALENDAR_ID(),
    eventId
  });
  console.log(`[CALENDAR] Event deleted: ${eventId}`);
}

module.exports = { createEvent, updateEvent, deleteEvent };
