const https = require('https');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const db = require('./localDbService');
const activityService = require('./activityService');
const sms = require('./smsService');
const log = require('./logger').child('POLL');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService } = require('./extractionService');

const PROCESSED_FILE = path.join(__dirname, '../../data/processed-conversations.json');
const POLL_INTERVAL_MS  = 30 * 1000;        // conversation polling: every 30s
const REMINDER_INTERVAL_MS = 60 * 60 * 1000; // reminder check: every hour

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY  = process.env.ELEVENLABS_API_KEY;

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')); }
  catch { return []; }
}

function saveProcessed(ids) {
  fs.mkdirSync(path.dirname(PROCESSED_FILE), { recursive: true });
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(ids.slice(-1000)));
}

function elevenlabsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: urlPath,
      method: 'GET',
      headers: { 'xi-api-key': API_KEY }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function getVal(dc, key) {
  return dc?.[key]?.value || null;
}

// ── Conversation polling ──────────────────────────────────────────────────────
async function processConversation(conv) {
  const convId = conv.conversation_id;
  try {
    const detail = await elevenlabsGet(`/v1/convai/conversations/${convId}`);
    const dc = detail.analysis?.data_collection_results || {};
    const action = getVal(dc, 'appointment_action');

    if (action && action !== 'booked') {
      log.debug(`Conv ${convId} — action=${action}, skipping`);
      return;
    }

    let name    = getVal(dc, 'patient_full_name');
    let phone   = getVal(dc, 'patient_phone_number');
    let dateRaw = getVal(dc, 'appointment_date_time');
    let service = getVal(dc, 'appointment_service');
    const reason = getVal(dc, 'reason_for_call') || '';

    if (!service || service === 'other' || service === 'consultation') {
      service = matchService(reason) || matchService(
        (detail.transcript || []).map(t => t.message || '').join(' ')
      ) || service;
    } else {
      service = matchService(service) || service;
    }

    let date = null, time = null;
    if (dateRaw) {
      const isoMatch = dateRaw.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (isoMatch) { date = isoMatch[1]; time = isoMatch[2]; }
      else { date = parseDate(dateRaw); time = parseTime(dateRaw); }
    }

    if (!name || !phone || !date || !service) {
      log.debug(`Conv ${convId} — incomplete: name=${name}, phone=${phone}, date=${date}, service=${service}`);
      return;
    }

    const existing = await db.getAllAppointments();
    const duplicate = existing.some(a =>
      a.name === name && a.date === date && a.time === time && a.status !== 'Cancelled'
    );
    if (duplicate) {
      log.debug(`Conv ${convId} — duplicate, skipping`);
      return;
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId, name, phone, service, doctor: '',
      date, time: time || '',
      status: 'Confirmed', source: 'AI Voice',
      callDuration: detail.metadata?.call_duration_secs || '',
      notes: `Conversation: ${convId}`,
      timestamp: new Date().toISOString()
    };

    await db.appendAppointment(apt);
    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${service} on ${date} at ${time} | Polled | ID: ${aptId}`
    });

    log.info(`Appointment saved from poll: ${name} | ${service} | ${date} ${time}`);

  } catch (err) {
    log.error(`Error processing conv ${convId}: ${err.message}`);
  }
}

async function poll() {
  if (!AGENT_ID || !API_KEY) return;
  try {
    const data = await elevenlabsGet(`/v1/convai/conversations?agent_id=${AGENT_ID}&page_size=10`);
    const conversations = data.conversations || [];
    const processed = loadProcessed();
    const newIds = [];

    for (const conv of conversations) {
      if (conv.status !== 'done') continue;
      if (processed.includes(conv.conversation_id)) continue;
      newIds.push(conv.conversation_id);
      await processConversation(conv);
    }

    if (newIds.length > 0) {
      saveProcessed([...processed, ...newIds]);
      log.info(`Processed ${newIds.length} new conversation(s)`);
    }
  } catch (err) {
    log.error(`Poll error: ${err.message}`);
  }
}

// ── Appointment reminders ─────────────────────────────────────────────────────
// Runs every hour. Sends an SMS reminder for appointments happening tomorrow
// that haven't been reminded yet.
const remindedSet = new Set(); // in-memory — resets on restart, harmless (just re-sends once)

async function sendReminders() {
  try {
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
    const all = await db.getAllAppointments();
    const due = all.filter(a =>
      a.date === tomorrow &&
      a.status !== 'Cancelled' &&
      a.phone &&
      !a.phone.includes('caller_id') &&
      !remindedSet.has(a.id)
    );

    for (const apt of due) {
      sms.sendReminder(apt);
      remindedSet.add(apt.id);
      log.info(`Reminder queued for ${apt.name} — ${apt.service} on ${apt.date} ${apt.time}`);
    }

    if (due.length > 0) {
      log.info(`Reminders sent for ${due.length} appointment(s) on ${tomorrow}`);
    }
  } catch (err) {
    log.error(`Reminder job error: ${err.message}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function start() {
  if (!AGENT_ID || !API_KEY) {
    log.warn('ElevenLabs not configured — conversation polling disabled');
  } else {
    log.info('Starting conversation polling (every 30s)');
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }

  log.info('Starting appointment reminder job (every hour)');
  sendReminders();
  setInterval(sendReminders, REMINDER_INTERVAL_MS);
}

module.exports = { start, poll, sendReminders };
