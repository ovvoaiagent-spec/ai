const https = require('https');
const fs = require('fs');
const path = require('path');
const sheetsService = require('./sheetsService');
const calendarService = require('./calendarService');
const activityService = require('./activityService');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService } = require('./extractionService');

const PROCESSED_FILE = path.join(__dirname, '../../data/processed-conversations.json');
const POLL_INTERVAL_MS = 60 * 1000; // every 60 seconds

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY  = process.env.ELEVENLABS_API_KEY;

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')); }
  catch { return []; }
}

function saveProcessed(ids) {
  fs.mkdirSync(path.dirname(PROCESSED_FILE), { recursive: true });
  // keep last 1000 IDs
  const trimmed = ids.slice(-1000);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(trimmed));
}

function elevenlabsGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path,
      method: 'GET',
      headers: { 'xi-api-key': API_KEY }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getVal(dc, key) {
  return dc?.[key]?.value || null;
}

async function processConversation(conv) {
  const convId = conv.conversation_id;
  try {
    const detail = await elevenlabsGet(`/v1/convai/conversations/${convId}`);
    const dc = detail.analysis?.data_collection_results || {};
    const action = getVal(dc, 'appointment_action');

    // Only process booked appointments
    if (action !== 'booked') {
      console.log(`[POLL] Conv ${convId} — action=${action}, skipping`);
      return;
    }

    // Extract fields from ElevenLabs data collection
    let name    = getVal(dc, 'patient_full_name');
    let phone   = getVal(dc, 'patient_phone_number');
    let dateRaw = getVal(dc, 'appointment_date_time');
    let service = getVal(dc, 'appointment_service');
    const reason = getVal(dc, 'reason_for_call') || '';

    // Use reason_for_call to get real service if appointment_service is generic
    if (!service || service === 'other' || service === 'consultation') {
      service = matchService(reason) || matchService(
        (detail.transcript || []).map(t => t.message || '').join(' ')
      ) || service;
    } else {
      service = matchService(service) || service;
    }

    // Parse date and time from ISO or natural language
    let date = null, time = null;
    if (dateRaw) {
      // ISO format: 2026-05-04T09:00:00+04:00
      const isoMatch = dateRaw.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (isoMatch) {
        date = isoMatch[1];
        time = isoMatch[2];
      } else {
        date = parseDate(dateRaw);
        time = parseTime(dateRaw);
      }
    }

    if (!name || !phone || !date || !service) {
      console.log(`[POLL] Conv ${convId} — incomplete: name=${name}, phone=${phone}, date=${date}, service=${service}`);
      return;
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId,
      name,
      phone,
      service,
      doctor: '',
      date,
      time: time || '',
      status: 'Confirmed',
      source: 'AI Voice',
      callDuration: detail.metadata?.call_duration_secs || '',
      notes: `Conversation ID: ${convId}`,
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    // Check for duplicate (same name + date + time)
    const existing = await sheetsService.getAllAppointments();
    const duplicate = existing.some(a =>
      a.name === name && a.date === date && a.time === time && a.status !== 'Cancelled'
    );
    if (duplicate) {
      console.log(`[POLL] Conv ${convId} — duplicate appointment, skipping`);
      return;
    }

    // Save to calendar
    try {
      const auth = await sheetsService.getAuth();
      const calEventId = await calendarService.createEvent(apt, 'AI Voice', auth);
      if (calEventId) apt.calendarEventId = calEventId;
    } catch (e) {
      console.warn('[POLL] Calendar error (non-fatal):', e.message);
    }

    // Save to DB + Sheets
    await sheetsService.appendAppointment(apt);

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${service} on ${date} at ${time} | Polled from ElevenLabs | ID: ${aptId}`
    });

    console.log(`[POLL] ✅ Appointment saved: ${name} | ${service} | ${date} ${time}`);

  } catch (err) {
    console.error(`[POLL] Error processing ${convId}:`, err.message);
  }
}

async function poll() {
  if (!AGENT_ID || !API_KEY) return;
  try {
    const data = await elevenlabsGet(
      `/v1/convai/conversations?agent_id=${AGENT_ID}&page_size=10`
    );
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
      console.log(`[POLL] Processed ${newIds.length} new conversation(s)`);
    }
  } catch (err) {
    console.error('[POLL] Poll error:', err.message);
  }
}

function start() {
  if (!AGENT_ID || !API_KEY) {
    console.log('[POLL] ElevenLabs not configured — polling disabled');
    return;
  }
  console.log('[POLL] Starting ElevenLabs conversation polling (every 60s)');
  poll(); // run immediately on start
  setInterval(poll, POLL_INTERVAL_MS);
}

module.exports = { start, poll };
