/**
 * Full automated Google setup for Lavora Clinic backend.
 *
 * What this script does automatically:
 *  1. Creates a GCP project "lavora-clinic-voice"
 *  2. Enables Google Sheets API + Google Calendar API
 *  3. Creates a service account "lavora-backend"
 *  4. Downloads the JSON key → credentials/google-service-account.json
 *  5. Creates a Google Sheet with all 4 required tabs + headers
 *  6. Creates a Google Calendar "Lavora Clinic Appointments"
 *  7. Shares the Sheet and Calendar with the service account (Editor access)
 *  8. Writes your .env file with all values filled in
 *
 * Prerequisites (the ONE thing you must do first):
 *   Run in terminal:
 *     ~/google-cloud-sdk/bin/gcloud auth login
 *     ~/google-cloud-sdk/bin/gcloud auth application-default login
 *
 * Then run this script:
 *   ~/node20/bin/node scripts/google-autosetup.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const CREDS_DIR = path.join(ROOT, 'credentials');
const CREDS_FILE = path.join(CREDS_DIR, 'google-service-account.json');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const PROJECT_ID = 'lavora-clinic-voice';
const SA_NAME = 'lavora-backend';
const SA_DISPLAY = 'Lavora Backend Service';
const SHEET_NAME = 'Lavora Clinic — Appointments';
const CALENDAR_NAME = 'Lavora Clinic Appointments';
const GCLOUD = `${process.env.HOME}/google-cloud-sdk/bin/gcloud`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : ['pipe','pipe','pipe'], ...opts }).trim();
  } catch (e) {
    if (opts.safe) return null;
    throw new Error(e.stderr || e.stdout || e.message);
  }
}

function step(n, total, label) {
  console.log(`\n[${n}/${total}] ${label}...`);
}

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); }

function apiCall(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Lavora Clinic — Google Auto-Setup Script           ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const TOTAL = 10;

  // ── Step 0: Check gcloud auth ───────────────────────────────────────────────
  step(0, TOTAL, 'Checking gcloud authentication');
  let token;
  try {
    token = run(`${GCLOUD} auth print-access-token 2>/dev/null`, { silent: true });
    if (!token || token.length < 20) throw new Error('no token');
    ok('Authenticated with Google');
  } catch {
    fail('Not authenticated. Run these two commands first, then re-run this script:\n\n' +
      `   ${GCLOUD} auth login\n` +
      `   ${GCLOUD} auth application-default login\n`);
    process.exit(1);
  }

  let adcToken;
  try {
    adcToken = run(`${GCLOUD} auth application-default print-access-token 2>/dev/null`, { silent: true });
    ok('Application Default Credentials found');
  } catch {
    fail('Application Default Credentials not set. Run:\n\n' +
      `   ${GCLOUD} auth application-default login\n`);
    process.exit(1);
  }

  // ── Step 1: Create / select GCP project ────────────────────────────────────
  step(1, TOTAL, `Setting up GCP project "${PROJECT_ID}"`);
  const existingProjects = run(`${GCLOUD} projects list --filter="projectId=${PROJECT_ID}" --format="value(projectId)" 2>/dev/null`, { silent: true, safe: true });

  if (existingProjects && existingProjects.includes(PROJECT_ID)) {
    ok(`Project already exists: ${PROJECT_ID}`);
  } else {
    try {
      run(`${GCLOUD} projects create ${PROJECT_ID} --name="Lavora Clinic Voice" 2>/dev/null`, { silent: true });
      ok(`Project created: ${PROJECT_ID}`);
    } catch (e) {
      if (e.message.includes('already exists')) {
        ok(`Project already exists: ${PROJECT_ID}`);
      } else {
        warn(`Could not create project: ${e.message}`);
        warn('Using default project instead...');
        const defaultProj = run(`${GCLOUD} config get-value project 2>/dev/null`, { silent: true, safe: true });
        if (!defaultProj) {
          fail('No project available. Please create one at console.cloud.google.com');
          process.exit(1);
        }
        ok(`Using existing project: ${defaultProj}`);
      }
    }
  }

  run(`${GCLOUD} config set project ${PROJECT_ID} 2>/dev/null`, { silent: true, safe: true });

  // ── Step 2: Enable APIs ────────────────────────────────────────────────────
  step(2, TOTAL, 'Enabling Google Sheets API and Calendar API');
  const apis = ['sheets.googleapis.com', 'calendar.googleapis.com', 'iam.googleapis.com'];
  for (const api of apis) {
    try {
      run(`${GCLOUD} services enable ${api} --project=${PROJECT_ID} 2>/dev/null`, { silent: true });
      ok(`Enabled: ${api}`);
    } catch (e) {
      warn(`Could not enable ${api}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log('  ⏳ Waiting 10s for APIs to propagate...');
  await sleep(10000);

  // ── Step 3: Create service account ────────────────────────────────────────
  step(3, TOTAL, `Creating service account "${SA_NAME}"`);
  const SA_EMAIL = `${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com`;
  try {
    run(`${GCLOUD} iam service-accounts create ${SA_NAME} --display-name="${SA_DISPLAY}" --project=${PROJECT_ID} 2>/dev/null`, { silent: true });
    ok(`Service account created: ${SA_EMAIL}`);
  } catch (e) {
    if (e.message.includes('already exists')) {
      ok(`Service account already exists: ${SA_EMAIL}`);
    } else {
      fail(`Could not create service account: ${e.message}`);
      process.exit(1);
    }
  }

  // ── Step 4: Download service account key ──────────────────────────────────
  step(4, TOTAL, 'Downloading service account key');
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  try {
    run(`${GCLOUD} iam service-accounts keys create "${CREDS_FILE}" --iam-account="${SA_EMAIL}" --project=${PROJECT_ID} 2>/dev/null`, { silent: true });
    ok(`Key saved → credentials/google-service-account.json`);
  } catch (e) {
    fail(`Could not download key: ${e.message}`);
    process.exit(1);
  }

  // Parse the key to get the service account email
  const keyData = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  ok(`Service account email: ${keyData.client_email}`);

  // Get a fresh ADC token for API calls
  token = run(`${GCLOUD} auth print-access-token 2>/dev/null`, { silent: true });

  // ── Step 5: Create Google Sheet ────────────────────────────────────────────
  step(5, TOTAL, `Creating Google Sheet "${SHEET_NAME}"`);
  let sheetId;

  const TABS = [
    {
      title: 'Appointments',
      headers: ['ID','Patient Name','Phone','Service','Doctor Assigned','Date','Time','Status','Source','Call Duration','Notes','Timestamp','Calendar Event ID'],
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

  const createSheetResp = await apiCall('POST',
    'https://sheets.googleapis.com/v4/spreadsheets',
    {
      properties: { title: SHEET_NAME },
      sheets: TABS.map((tab, i) => ({
        properties: {
          sheetId: i,
          title: tab.title,
          tabColor: tab.color
        }
      }))
    },
    token
  );

  if (createSheetResp.status !== 200) {
    fail(`Could not create sheet: ${JSON.stringify(createSheetResp.body)}`);
    process.exit(1);
  }

  sheetId = createSheetResp.body.spreadsheetId;
  ok(`Sheet created: ${SHEET_NAME}`);
  ok(`Sheet ID: ${sheetId}`);

  // Add headers to each tab
  const headerRequests = TABS.map((tab, i) => ({
    updateCells: {
      range: { sheetId: i, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: tab.headers.length },
      rows: [{
        values: tab.headers.map(h => ({
          userEnteredValue: { stringValue: h },
          userEnteredFormat: {
            backgroundColor: { red: 0.13, green: 0.16, blue: 0.27 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER'
          }
        }))
      }],
      fields: 'userEnteredValue,userEnteredFormat'
    }
  }));

  await apiCall('POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    { requests: headerRequests },
    token
  );
  ok('Headers added to all 4 tabs (Appointments, Missed Captures, Call Log, Activity Log)');

  // ── Step 6: Share Sheet with service account ────────────────────────────────
  step(6, TOTAL, `Sharing Sheet with service account`);
  const shareSheetResp = await apiCall('POST',
    `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`,
    { type: 'user', role: 'writer', emailAddress: keyData.client_email },
    token
  );
  if (shareSheetResp.status === 200 || shareSheetResp.status === 201) {
    ok(`Sheet shared with ${keyData.client_email} (Editor)`);
  } else {
    warn(`Sheet share response: ${shareSheetResp.status} — ${JSON.stringify(shareSheetResp.body)}`);
  }

  // ── Step 7: Create Google Calendar ────────────────────────────────────────
  step(7, TOTAL, `Creating Google Calendar "${CALENDAR_NAME}"`);
  let calendarId;

  const createCalResp = await apiCall('POST',
    'https://www.googleapis.com/calendar/v3/calendars',
    {
      summary: CALENDAR_NAME,
      description: 'Lavora Clinic appointment bookings — managed by AI Voice Receptionist',
      timeZone: 'Asia/Muscat'
    },
    token
  );

  if (createCalResp.status !== 200 && createCalResp.status !== 201) {
    fail(`Could not create calendar: ${JSON.stringify(createCalResp.body)}`);
    process.exit(1);
  }

  calendarId = createCalResp.body.id;
  ok(`Calendar created: ${CALENDAR_NAME}`);
  ok(`Calendar ID: ${calendarId}`);

  // Set calendar color to teal
  await apiCall('PATCH',
    `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    { colorId: 'teal' },
    token
  );

  // ── Step 8: Share Calendar with service account ────────────────────────────
  step(8, TOTAL, `Sharing Calendar with service account`);
  const shareCalResp = await apiCall('POST',
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`,
    { role: 'writer', scope: { type: 'user', value: keyData.client_email } },
    token
  );
  if (shareCalResp.status === 200 || shareCalResp.status === 201) {
    ok(`Calendar shared with ${keyData.client_email} (Make changes to events)`);
  } else {
    warn(`Calendar share response: ${shareCalResp.status}`);
  }

  // ── Step 9: Read existing .env or use example ──────────────────────────────
  step(9, TOTAL, 'Writing .env file');
  let envContent = '';
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  } else if (fs.existsSync(ENV_EXAMPLE)) {
    envContent = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  }

  function setEnvVar(content, key, value) {
    const rx = new RegExp(`^${key}=.*$`, 'm');
    if (rx.test(content)) return content.replace(rx, `${key}=${value}`);
    return content + `\n${key}=${value}`;
  }

  envContent = setEnvVar(envContent, 'GOOGLE_SERVICE_ACCOUNT_JSON_PATH', './credentials/google-service-account.json');
  envContent = setEnvVar(envContent, 'GOOGLE_SHEETS_ID', sheetId);
  envContent = setEnvVar(envContent, 'GOOGLE_CALENDAR_ID', calendarId);

  // Generate a CRM secret key if not already set
  if (!envContent.match(/^CRM_SECRET_KEY=.+$/m)) {
    const secret = require('crypto').randomBytes(32).toString('hex');
    envContent = setEnvVar(envContent, 'CRM_SECRET_KEY', secret);
    ok(`CRM_SECRET_KEY generated: ${secret}`);
  }

  fs.writeFileSync(ENV_FILE, envContent.trim() + '\n');
  ok('.env file written');

  // ── Step 10: Summary ───────────────────────────────────────────────────────
  step(10, TOTAL, 'All done!');

  console.log('\n' + '═'.repeat(56));
  console.log('  ✅ GOOGLE SETUP COMPLETE');
  console.log('═'.repeat(56));
  console.log(`\n  Google Sheet:     https://docs.google.com/spreadsheets/d/${sheetId}`);
  console.log(`  Google Calendar:  ${calendarId}`);
  console.log(`  Service Account:  ${keyData.client_email}`);
  console.log(`  Credentials:      credentials/google-service-account.json`);
  console.log(`  .env updated:     ✅`);

  console.log('\n  Next steps:');
  console.log('  1. Fill in the missing .env values (ElevenLabs, Twilio keys)');
  console.log('  2. Verify everything works:   ~/node20/bin/npm run verify-google');
  console.log('  3. Start the server:          ~/node20/bin/npm start');
  console.log('  4. Configure agent tools:     ~/node20/bin/npm run setup-agent https://YOUR_URL');
  console.log('\n' + '═'.repeat(56) + '\n');
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  if (err.message.includes('PERMISSION_DENIED') || err.message.includes('UNAUTHENTICATED')) {
    console.error('\nFix: Run these commands then try again:');
    console.error(`  ~/google-cloud-sdk/bin/gcloud auth login`);
    console.error(`  ~/google-cloud-sdk/bin/gcloud auth application-default login\n`);
  }
  process.exit(1);
});
