const { google } = require('googleapis');
const path = require('path');

// Tab names
const TABS = {
  APPOINTMENTS: 'Appointments',
  MISSED: 'Missed Captures',
  CALL_LOG: 'Call Log',
  ACTIVITY: 'Activity Log'
};

// Column headers for each tab
const HEADERS = {
  [TABS.APPOINTMENTS]: [
    'ID', 'Patient Name', 'Phone', 'Service', 'Doctor Assigned',
    'Date', 'Time', 'Status', 'Source', 'Call Duration', 'Notes',
    'Timestamp', 'Calendar Event ID'
  ],
  [TABS.MISSED]: [
    'ID', 'Phone (Twilio)', 'Partial Data', 'Missing Fields', 'Timestamp', 'Resolved'
  ],
  [TABS.CALL_LOG]: [
    'CallSid', 'From', 'To', 'Duration (s)', 'Status', 'Timestamp'
  ],
  [TABS.ACTIVITY]: [
    'ID', 'Actor', 'Action Type', 'Patient Name', 'Details', 'Timestamp'
  ]
};

// Column indices for Appointments (0-based)
const APT_COLS = {
  ID: 0, NAME: 1, PHONE: 2, SERVICE: 3, DOCTOR: 4,
  DATE: 5, TIME: 6, STATUS: 7, SOURCE: 8, DURATION: 9,
  NOTES: 10, TIMESTAMP: 11, CALENDAR_ID: 12
};

let auth = null;
let sheets = null;
const SPREADSHEET_ID = () => process.env.GOOGLE_SHEETS_ID;

async function getClient() {
  if (sheets) return sheets;

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH);
  auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar'
    ]
  });

  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

async function getValues(range) {
  const client = await getClient();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID(),
    range
  });
  return res.data.values || [];
}

async function appendValues(range, rows) {
  const client = await getClient();
  await client.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID(),
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

async function updateRow(range, row) {
  const client = await getClient();
  await client.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID(),
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

// Initialize sheet headers if sheets are empty
async function initializeSheets() {
  try {
    const client = await getClient();
    const meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID() });
    const existingTabs = meta.data.sheets.map(s => s.properties.title);

    for (const [tabName, headers] of Object.entries(HEADERS)) {
      if (!existingTabs.includes(tabName)) {
        console.log(`[SHEETS] Tab "${tabName}" not found — skipping header init (create it manually)`);
        continue;
      }
      const existing = await getValues(`${tabName}!A1:Z1`);
      if (!existing || existing.length === 0) {
        await appendValues(`${tabName}!A1`, [headers]);
        console.log(`[SHEETS] Initialized headers for tab: ${tabName}`);
      }
    }
    console.log('[SHEETS] Sheet initialization complete');
  } catch (err) {
    console.error('[SHEETS] Init error (non-fatal):', err.message);
  }
}

async function appendAppointment(apt) {
  const row = [
    apt.id, apt.name, apt.phone, apt.service, apt.doctor || '',
    apt.date, apt.time, apt.status || 'Pending', apt.source || 'AI Voice',
    apt.callDuration || '', apt.notes || '',
    apt.timestamp || new Date().toISOString(),
    apt.calendarEventId || ''
  ];
  await appendValues(`${TABS.APPOINTMENTS}!A:M`, [row]);
  console.log(`[SHEETS] Appointment appended: ${apt.id}`);
}

async function appendMissedCapture(missed) {
  const row = [
    missed.id,
    missed.twilioPhone || '',
    JSON.stringify(missed.partialData || {}),
    (missed.missingFields || []).join(', '),
    missed.timestamp || new Date().toISOString(),
    'FALSE'
  ];
  await appendValues(`${TABS.MISSED}!A:F`, [row]);
  console.log(`[SHEETS] Missed capture appended: ${missed.id}`);
}

async function appendCallLog(call) {
  const row = [
    call.callSid, call.from, call.to,
    call.duration || '', call.status,
    call.timestamp || new Date().toISOString()
  ];
  await appendValues(`${TABS.CALL_LOG}!A:F`, [row]);
  console.log(`[SHEETS] Call log appended: ${call.callSid}`);
}

async function appendActivity(entry) {
  const row = [
    entry.id, entry.actor, entry.actionType,
    entry.patientName || '', entry.details || '',
    entry.timestamp || new Date().toISOString()
  ];
  await appendValues(`${TABS.ACTIVITY}!A:F`, [row]);
}

async function getAllAppointments() {
  const rows = await getValues(`${TABS.APPOINTMENTS}!A:M`);
  if (rows.length <= 1) return []; // only header or empty
  return rows.slice(1).map(rowToAppointment);
}

function rowToAppointment(row) {
  return {
    id: row[APT_COLS.ID] || '',
    name: row[APT_COLS.NAME] || '',
    phone: row[APT_COLS.PHONE] || '',
    service: row[APT_COLS.SERVICE] || '',
    doctor: row[APT_COLS.DOCTOR] || '',
    date: row[APT_COLS.DATE] || '',
    time: row[APT_COLS.TIME] || '',
    status: row[APT_COLS.STATUS] || '',
    source: row[APT_COLS.SOURCE] || '',
    callDuration: row[APT_COLS.DURATION] || '',
    notes: row[APT_COLS.NOTES] || '',
    timestamp: row[APT_COLS.TIMESTAMP] || '',
    calendarEventId: row[APT_COLS.CALENDAR_ID] || ''
  };
}

async function findRowIndex(id) {
  const rows = await getValues(`${TABS.APPOINTMENTS}!A:A`);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id) return i + 1; // 1-based Sheets row (row 1 is header)
  }
  return null;
}

async function getAppointmentById(id) {
  const all = await getAllAppointments();
  return all.find(a => a.id === id) || null;
}

async function updateAppointment(id, updates) {
  const rowIndex = await findRowIndex(id);
  if (!rowIndex) throw new Error(`Appointment ${id} not found`);

  const existing = await getValues(`${TABS.APPOINTMENTS}!A${rowIndex}:M${rowIndex}`);
  const current = existing[0] || new Array(13).fill('');

  const merged = [...current];
  if (updates.name !== undefined) merged[APT_COLS.NAME] = updates.name;
  if (updates.phone !== undefined) merged[APT_COLS.PHONE] = updates.phone;
  if (updates.service !== undefined) merged[APT_COLS.SERVICE] = updates.service;
  if (updates.doctor !== undefined) merged[APT_COLS.DOCTOR] = updates.doctor;
  if (updates.date !== undefined) merged[APT_COLS.DATE] = updates.date;
  if (updates.time !== undefined) merged[APT_COLS.TIME] = updates.time;
  if (updates.status !== undefined) merged[APT_COLS.STATUS] = updates.status;
  if (updates.notes !== undefined) merged[APT_COLS.NOTES] = updates.notes;
  if (updates.calendarEventId !== undefined) merged[APT_COLS.CALENDAR_ID] = updates.calendarEventId;

  await updateRow(`${TABS.APPOINTMENTS}!A${rowIndex}:M${rowIndex}`, merged);
  console.log(`[SHEETS] Appointment updated: ${id}`);
  return rowToAppointment(merged);
}

async function cancelAppointment(id) {
  return updateAppointment(id, { status: 'Cancelled' });
}

async function checkConflict(date, time, doctor = null) {
  const appointments = await getAllAppointments();
  return appointments.some(apt => {
    if (apt.status === 'Cancelled') return false;
    const sameSlot = apt.date === date && apt.time === time;
    if (!doctor) return sameSlot;
    return sameSlot && apt.doctor === doctor;
  });
}

module.exports = {
  initializeSheets,
  appendAppointment,
  appendMissedCapture,
  appendCallLog,
  appendActivity,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  cancelAppointment,
  checkConflict,
  getAuth: async () => {
    await getClient();
    return auth;
  }
};
