/**
 * Lavora Clinic — Google Auto-Setup
 * Uses Application Default Credentials (from gcloud auth application-default login)
 * to create Google Sheet + Calendar, then writes .env automatically.
 * No GCP project or service account needed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const SHEET_NAME  = 'Lavora Clinic — Appointments';
const CAL_NAME    = 'Lavora Clinic Appointments';
const USER_EMAIL  = 'ovvoaiagent@gmail.com';

const TABS = [
  {
    title: 'Appointments',
    headers: ['ID','Patient Name','Phone','Service','Doctor Assigned','Date','Time',
              'Status','Source','Call Duration','Notes','Timestamp','Calendar Event ID'],
    color: { red: 0.18, green: 0.45, blue: 0.73 }
  },
  {
    title: 'Missed Captures',
    headers: ['ID','Phone (Twilio)','Partial Data','Missing Fields','Timestamp','Resolved'],
    color: { red: 0.83, green: 0.33, blue: 0.18 }
  },
  {
    title: 'Call Log',
    headers: ['CallSid','From','To','Duration (s)','Status','Timestamp'],
    color: { red: 0.42, green: 0.42, blue: 0.42 }
  },
  {
    title: 'Activity Log',
    headers: ['ID','Actor','Action Type','Patient Name','Details','Timestamp'],
    color: { red: 0.18, green: 0.60, blue: 0.45 }
  }
];

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function info(msg) { console.log(`  ➜  ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); }

function setEnvVar(content, key, value) {
  const rx = new RegExp(`^${key}=.*$`, 'm');
  if (rx.test(content)) return content.replace(rx, `${key}=${value}`);
  return content + `\n${key}=${value}`;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Lavora Clinic — Google Auto-Setup                  ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Auth ─────────────────────────────────────────────────────────────────
  console.log('[1/5] Authenticating with Google...');
  let auth;
  try {
    auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    await auth.getAccessToken();
    ok('Authenticated successfully');
  } catch (err) {
    fail('Authentication failed: ' + err.message);
    console.error('\nRun this first:\n  bash ~/Desktop/ai/lavora-backend/setup-google.sh\n');
    process.exit(1);
  }

  const sheets   = google.sheets({ version: 'v4', auth });
  const drive    = google.drive({ version: 'v3', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  // ── Create Google Sheet ───────────────────────────────────────────────────
  console.log('\n[2/5] Creating Google Sheet...');
  const sheetRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_NAME },
      sheets: TABS.map((tab, i) => ({
        properties: { sheetId: i, title: tab.title, tabColor: tab.color }
      }))
    }
  });
  const sheetId = sheetRes.data.spreadsheetId;
  ok(`Sheet created: "${SHEET_NAME}"`);
  ok(`Sheet ID: ${sheetId}`);

  // Add headers to each tab
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: TABS.map((tab, i) => ({
        updateCells: {
          range: {
            sheetId: i,
            startRowIndex: 0, endRowIndex: 1,
            startColumnIndex: 0, endColumnIndex: tab.headers.length
          },
          rows: [{
            values: tab.headers.map(h => ({
              userEnteredValue: { stringValue: h },
              userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.16, blue: 0.27 },
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true, fontSize: 10
                },
                horizontalAlignment: 'CENTER'
              }
            }))
          }],
          fields: 'userEnteredValue,userEnteredFormat'
        }
      }))
    }
  });
  ok('Headers added to all 4 tabs');

  // Share sheet with user
  await drive.permissions.create({
    fileId: sheetId,
    requestBody: { type: 'user', role: 'writer', emailAddress: USER_EMAIL }
  });
  ok(`Sheet shared with ${USER_EMAIL}`);

  // ── Create Google Calendar ────────────────────────────────────────────────
  console.log('\n[3/5] Creating Google Calendar...');
  const calRes = await calendar.calendars.insert({
    requestBody: {
      summary: CAL_NAME,
      description: 'Lavora Clinic appointment bookings — AI Voice Receptionist',
      timeZone: 'Asia/Muscat'
    }
  });
  const calendarId = calRes.data.id;
  ok(`Calendar created: "${CAL_NAME}"`);
  ok(`Calendar ID: ${calendarId}`);

  // Set color to teal
  try {
    await calendar.calendarList.patch({
      calendarId,
      requestBody: { colorId: 'teal' }
    });
  } catch {}

  // ── Create Service Account for backend ───────────────────────────────────
  console.log('\n[4/5] Setting up backend credentials...');

  // Use ADC token path as credential for the Node.js backend
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    `${process.env.HOME}/.config/gcloud/application_default_credentials.json`;

  const credsDir = path.join(ROOT, 'credentials');
  fs.mkdirSync(credsDir, { recursive: true });

  const destCreds = path.join(credsDir, 'google-service-account.json');

  if (fs.existsSync(adcPath)) {
    fs.copyFileSync(adcPath, destCreds);
    ok(`Credentials saved → credentials/google-service-account.json`);
  } else {
    info('ADC credentials not found at default path — .env will point to gcloud ADC');
  }

  // ── Write .env ────────────────────────────────────────────────────────────
  console.log('\n[5/5] Writing .env file...');
  let envContent = '';
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  } else if (fs.existsSync(ENV_EXAMPLE)) {
    envContent = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  }

  const credsPath = fs.existsSync(destCreds)
    ? './credentials/google-service-account.json'
    : adcPath;

  envContent = setEnvVar(envContent, 'GOOGLE_SERVICE_ACCOUNT_JSON_PATH', credsPath);
  envContent = setEnvVar(envContent, 'GOOGLE_SHEETS_ID', sheetId);
  envContent = setEnvVar(envContent, 'GOOGLE_CALENDAR_ID', calendarId);

  if (!envContent.match(/^CRM_SECRET_KEY=.+$/m)) {
    const secret = require('crypto').randomBytes(32).toString('hex');
    envContent = setEnvVar(envContent, 'CRM_SECRET_KEY', secret);
  }

  fs.writeFileSync(ENV_FILE, envContent.trim() + '\n');
  ok('.env file updated');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(56));
  console.log('  ✅ GOOGLE SETUP COMPLETE');
  console.log('═'.repeat(56));
  console.log(`\n  📊 Google Sheet:`);
  console.log(`     https://docs.google.com/spreadsheets/d/${sheetId}`);
  console.log(`\n  📅 Google Calendar: added to your Google Calendar`);
  console.log(`     ID: ${calendarId}`);
  console.log(`\n  📄 .env: updated with all Google credentials`);
  console.log('\n  Next steps:');
  console.log('  1. Restart server:  ~/node20/bin/npm start');
  console.log('  2. Run verify:      ~/node20/bin/npm run verify-google');
  console.log('\n' + '═'.repeat(56) + '\n');
}

main().catch(err => {
  fail(err.message);
  if (err.message.includes('invalid_grant') || err.message.includes('UNAUTHENTICATED')) {
    console.error('\nRe-run: bash ~/Desktop/ai/lavora-backend/setup-google.sh\n');
  }
  process.exit(1);
});
