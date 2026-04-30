/**
 * Data service — local JSON is primary storage (always works).
 * Google Sheets syncs automatically when credentials are configured.
 */

const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');
const db   = require('./localDbService');

const TABS = {
  APPOINTMENTS: 'Appointments',
  MISSED: 'Missed Captures',
  CALL_LOG: 'Call Log',
  ACTIVITY: 'Activity Log'
};

const APT_COLS = {
  ID:0, NAME:1, PHONE:2, SERVICE:3, DOCTOR:4,
  DATE:5, TIME:6, STATUS:7, SOURCE:8, DURATION:9,
  NOTES:10, TIMESTAMP:11, CALENDAR_ID:12
};

let auth   = null;
let sheets = null;

function googleConfigured() {
  return !!(
    process.env.GOOGLE_SHEETS_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  );
}

async function getGoogleClient() {
  if (sheets) return sheets;
  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH);
  if (!fs.existsSync(keyPath)) return null;

  try {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const SCOPES = [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive'
    ];

    if (keyData.type === 'authorized_user') {
      auth = new google.auth.OAuth2(keyData.client_id, keyData.client_secret);
      auth.setCredentials({ refresh_token: keyData.refresh_token });
    } else {
      auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: SCOPES });
    }

    sheets = google.sheets({ version: 'v4', auth });
    return sheets;
  } catch {
    return null;
  }
}

// Fire-and-forget Google Sheets sync — never blocks the main flow
async function syncToSheets(fn) {
  if (!googleConfigured()) return;
  try {
    const client = await getGoogleClient();
    if (client) await fn(client);
  } catch (err) {
    console.warn('[SHEETS SYNC] Non-fatal:', err.message);
  }
}

function aptToRow(apt) {
  return [
    apt.id, apt.name, apt.phone, apt.service, apt.doctor || '',
    apt.date, apt.time, apt.status || 'Pending', apt.source || 'AI Voice',
    apt.callDuration || '', apt.notes || '',
    apt.timestamp || new Date().toISOString(),
    apt.calendarEventId || ''
  ];
}

function rowToApt(row) {
  return {
    id: row[APT_COLS.ID]||'', name: row[APT_COLS.NAME]||'',
    phone: row[APT_COLS.PHONE]||'', service: row[APT_COLS.SERVICE]||'',
    doctor: row[APT_COLS.DOCTOR]||'', date: row[APT_COLS.DATE]||'',
    time: row[APT_COLS.TIME]||'', status: row[APT_COLS.STATUS]||'',
    source: row[APT_COLS.SOURCE]||'', callDuration: row[APT_COLS.DURATION]||'',
    notes: row[APT_COLS.NOTES]||'', timestamp: row[APT_COLS.TIMESTAMP]||'',
    calendarEventId: row[APT_COLS.CALENDAR_ID]||''
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initializeSheets() {
  if (!googleConfigured()) {
    console.log('[SHEETS] Google not configured — using local storage only');
    return;
  }
  const client = await getGoogleClient();
  if (!client) { console.log('[SHEETS] Could not connect to Google Sheets'); return; }
  console.log('[SHEETS] Google Sheets connected ✅');
}

async function appendAppointment(apt) {
  db.appendAppointment(apt);
  syncToSheets(async (client) => {
    await client.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.APPOINTMENTS}!A:M`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [aptToRow(apt)] }
    });
    console.log('[SHEETS] Synced appointment to Google Sheets');
  });
}

async function appendMissedCapture(missed) {
  db.appendMissedCapture(missed);
  syncToSheets(async (client) => {
    await client.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.MISSED}!A:F`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        missed.id, missed.twilioPhone||'',
        JSON.stringify(missed.partialData||{}),
        (missed.missingFields||[]).join(', '),
        missed.timestamp||new Date().toISOString(), 'FALSE'
      ]]}
    });
  });
}

async function appendCallLog(call) {
  db.appendCallLog(call);
  syncToSheets(async (client) => {
    await client.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.CALL_LOG}!A:F`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        call.callSid, call.from, call.to,
        call.duration||'', call.status,
        call.timestamp||new Date().toISOString()
      ]]}
    });
  });
}

async function appendActivity(entry) {
  db.appendActivity(entry);
  syncToSheets(async (client) => {
    await client.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.ACTIVITY}!A:F`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        entry.id, entry.actor, entry.actionType,
        entry.patientName||'', entry.details||'',
        entry.timestamp||new Date().toISOString()
      ]]}
    });
  });
}

async function getAllAppointments()        { return db.getAllAppointments(); }
async function getAppointmentById(id)     { return db.getAppointmentById(id); }
async function checkConflict(d, t, doc)   { return db.checkConflict(d, t, doc); }
async function cancelAppointment(id)      { return db.cancelAppointment(id); }

async function updateAppointment(id, updates) {
  const updated = db.updateAppointment(id, updates);
  syncToSheets(async (client) => {
    // Find row in sheets by ID and update it
    const res = await client.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.APPOINTMENTS}!A:A`
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === id);
    if (rowIdx === -1) return;
    const sheetRow = rowIdx + 1;
    await client.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.APPOINTMENTS}!A${sheetRow}:M${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [aptToRow(updated)] }
    });
    console.log(`[SHEETS] Synced update for ${id}`);
  });
  return updated;
}

module.exports = {
  initializeSheets,
  appendAppointment, appendMissedCapture,
  appendCallLog, appendActivity,
  getAllAppointments, getAppointmentById,
  updateAppointment, cancelAppointment, checkConflict,
  googleConfigured,
  getAuth: async () => { await getGoogleClient(); return auth; },
  reset: () => { auth = null; sheets = null; }
};
