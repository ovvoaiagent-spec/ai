/**
 * Data service — Google Sheets is the primary source of truth when credentials
 * are configured (reads always come from Sheets so data survives server restarts).
 * Local JSON is a write-through cache and fallback when Sheets is unreachable.
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
  DATE:5, TIME:6, STATUS:7, SOURCE:8
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
    apt.date, apt.time, apt.status || 'Pending', apt.source || 'AI Voice'
  ];
}

function rowToApt(row) {
  return {
    id: row[APT_COLS.ID]||'', name: row[APT_COLS.NAME]||'',
    phone: row[APT_COLS.PHONE]||'', service: row[APT_COLS.SERVICE]||'',
    doctor: row[APT_COLS.DOCTOR]||'', date: row[APT_COLS.DATE]||'',
    time: row[APT_COLS.TIME]||'', status: row[APT_COLS.STATUS]||'',
    source: row[APT_COLS.SOURCE]||''
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

  // Set / refresh headers on each startup so column changes propagate automatically
  const headers = {
    [TABS.APPOINTMENTS]: [['ID','Patient Name','Phone','Service','Doctor','Date','Time','Status','Source']],
    [TABS.MISSED]:       [['ID','Twilio Phone','Partial Data','Missing Fields','Timestamp','Resolved']],
    [TABS.CALL_LOG]:     [['Call SID','From','To','Duration','Status','Timestamp']],
    [TABS.ACTIVITY]:     [['ID','Actor','Action','Patient Name','Details','Timestamp']]
  };

  for (const [tab, values] of Object.entries(headers)) {
    try {
      await client.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
    } catch {
      // Tab may not exist yet — silently skip
    }
  }

  console.log('[SHEETS] Google Sheets connected ✅');
}

async function appendAppointment(apt) {
  db.appendAppointment(apt);
  syncToSheets(async (client) => {
    await client.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${TABS.APPOINTMENTS}!A:I`,
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

// When Google Sheets is configured it is the source of truth for reads.
// Local DB is used as a write-cache so the system works without credentials too.

async function getAllAppointments() {
  if (googleConfigured()) {
    try {
      const client = await getGoogleClient();
      if (client) {
        const res = await client.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: `${TABS.APPOINTMENTS}!A:I`
        });
        const rows = (res.data.values || []).slice(1); // skip header row
        return rows.filter(r => r[0]).map(rowToApt);
      }
    } catch (err) {
      console.warn('[SHEETS] getAllAppointments fallback to local:', err.message);
    }
  }
  return db.getAllAppointments();
}

async function getAppointmentById(id) {
  const all = await getAllAppointments();
  return all.find(a => a.id === id) || null;
}

async function checkConflict(d, t, doc) {
  const all = await getAllAppointments();
  return all.some(apt => {
    if (apt.status === 'Cancelled') return false;
    const sameSlot = apt.date === d && apt.time === t;
    return doc ? sameSlot && apt.doctor === doc : sameSlot;
  });
}

async function cancelAppointment(id) {
  return updateAppointment(id, { status: 'Cancelled' });
}

async function updateAppointment(id, updates) {
  // Fetch the current record — from Sheets if available, else local DB
  const existing = await getAppointmentById(id);
  if (!existing) throw new Error(`Appointment ${id} not found`);
  const updated = { ...existing, ...updates };

  // Keep local DB in sync (best-effort)
  try { db.updateAppointment(id, updates); } catch { db.appendAppointment(updated); }

  // Write back to Sheets
  syncToSheets(async (client) => {
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
      range: `${TABS.APPOINTMENTS}!A${sheetRow}:I${sheetRow}`,
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
