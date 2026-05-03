/**
 * Pure Google Sheets sync layer.
 * Does NOT write to localDbService — callers handle that separately.
 */

const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');

const TABS = {
  APPOINTMENTS: 'Appointments',
  MISSED: 'Missed Captures',
  CALL_LOG: 'Call Log',
  ACTIVITY: 'Activity Log'
};

const APT_COLS = { ID:0, NAME:1, PHONE:2, SERVICE:3, DOCTOR:4, DATE:5, TIME:6, STATUS:7, SOURCE:8 };

let auth   = null;
let sheets = null;

function googleConfigured() {
  return !!(process.env.GOOGLE_SHEETS_ID && (
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ||
    process.env.GOOGLE_TOKENS_JSON
  ));
}

async function getGoogleClient() {
  if (sheets) return sheets;

  try {
    const SCOPES = [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive'
    ];

    // OAuth tokens (Railway env var)
    if (process.env.GOOGLE_TOKENS_JSON) {
      const keyData = JSON.parse(process.env.GOOGLE_TOKENS_JSON);
      auth = new google.auth.OAuth2(keyData.client_id, keyData.client_secret);
      auth.setCredentials({ refresh_token: keyData.refresh_token });
      sheets = google.sheets({ version: 'v4', auth });
      return sheets;
    }

    // Service account key file
    const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || '');
    if (!fs.existsSync(keyPath)) return null;
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

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

// ── Init ──────────────────────────────────────────────────────────────────────
async function initializeSheets() {
  if (!googleConfigured()) {
    console.log('[SHEETS] Not configured — skipping');
    return;
  }
  const client = await getGoogleClient();
  if (!client) { console.log('[SHEETS] Could not connect'); return; }

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
    } catch {}
  }
  console.log('[SHEETS] Google Sheets connected ✅');
}

// ── Write operations (Sheets only) ────────────────────────────────────────────
async function appendAppointment(apt) {
  const client = await getGoogleClient();
  if (!client) return;
  await client.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${TABS.APPOINTMENTS}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [aptToRow(apt)] }
  });
  console.log('[SHEETS] Appointment appended');
}

async function updateAppointment(id, updates) {
  const client = await getGoogleClient();
  if (!client) return;

  const res = await client.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${TABS.APPOINTMENTS}!A:I`
  });
  const rows = res.data.values || [];
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIdx === -1) return;

  const existing = rowToApt(rows[rowIdx]);
  const updated = { ...existing, ...updates };
  const sheetRow = rowIdx + 1;

  await client.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${TABS.APPOINTMENTS}!A${sheetRow}:I${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [aptToRow(updated)] }
  });
  console.log(`[SHEETS] Appointment updated: ${id}`);
}

async function cancelAppointment(id) {
  return updateAppointment(id, { status: 'Cancelled' });
}

async function appendMissedCapture(missed) {
  const client = await getGoogleClient();
  if (!client) return;
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
}

async function appendCallLog(call) {
  const client = await getGoogleClient();
  if (!client) return;
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
}

async function appendActivity(entry) {
  const client = await getGoogleClient();
  if (!client) return;
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
}

module.exports = {
  initializeSheets, googleConfigured,
  appendAppointment, updateAppointment, cancelAppointment,
  appendMissedCapture, appendCallLog, appendActivity,
  getAuth: async () => { await getGoogleClient(); return auth; },
  reset: () => { auth = null; sheets = null; }
};
