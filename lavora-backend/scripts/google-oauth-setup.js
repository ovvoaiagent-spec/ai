/**
 * Lavora Clinic — Google OAuth2 Setup (no gcloud needed)
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com
 *   2. Create a project (any name)
 *   3. Enable: Sheets API, Calendar API, Drive API
 *   4. APIs & Services → Credentials → Create OAuth 2.0 Client ID
 *      → Application type: Web application
 *      → Add redirect URI: http://localhost:8080/callback
 *      → Download JSON → save as credentials/client_secrets.json
 *   5. Run: ~/node20/bin/node scripts/google-oauth-setup.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');

const ROOT         = path.join(__dirname, '..');
const CREDS_DIR    = path.join(ROOT, 'credentials');
const SECRETS_FILE = path.join(CREDS_DIR, 'client_secrets.json');
const TOKENS_FILE  = path.join(CREDS_DIR, 'google-tokens.json');
const ENV_FILE     = path.join(ROOT, '.env');
const ENV_EXAMPLE  = path.join(ROOT, '.env.example');

const REDIRECT_URI  = 'http://localhost:8080/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive'
];

const SHEET_NAME = 'Lavora Clinic — Appointments';
const CAL_NAME   = 'Lavora Clinic Appointments';
const USER_EMAIL = 'ovvoaiagent@gmail.com';

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

function setEnvVar(content, key, value) {
  const rx = new RegExp(`^${key}=.*$`, 'm');
  if (rx.test(content)) return content.replace(rx, `${key}=${value}`);
  return content + `\n${key}=${value}`;
}

function openBrowser(url) {
  exec(`open "${url}"`);
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:8080');
      if (url.pathname !== '/callback') {
        res.end('Not found'); return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px">
          <h2 style="color:red">❌ Authorization denied</h2>
          <p>Please close this tab and try again.</p>
        </body></html>`);
        server.close();
        reject(new Error('User denied access: ' + error));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:#1a2744">✅ Authorization successful!</h2>
        <p style="color:#4a5568">You can close this tab and return to the terminal.</p>
        <p style="margin-top:20px;font-size:14px;color:#718096">
          Lavora Clinic AI Voice Receptionist is now setting up your Google Sheet and Calendar...
        </p>
      </body></html>`);
      server.close();
      resolve(code);
    });

    server.listen(8080, () => {
      console.log('  ⏳ Waiting for Google authorization...');
    });

    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Timeout: no response in 3 minutes')); }, 180000);
  });
}

async function createSheet(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_NAME },
      sheets: TABS.map((tab, i) => ({
        properties: { sheetId: i, title: tab.title, tabColor: tab.color }
      }))
    }
  });
  const id = res.data.spreadsheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: TABS.map((tab, i) => ({
        updateCells: {
          range: { sheetId: i, startRowIndex: 0, endRowIndex: 1,
                   startColumnIndex: 0, endColumnIndex: tab.headers.length },
          rows: [{
            values: tab.headers.map(h => ({
              userEnteredValue: { stringValue: h },
              userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.16, blue: 0.27 },
                textFormat: { foregroundColor: { red:1,green:1,blue:1 }, bold: true, fontSize: 10 },
                horizontalAlignment: 'CENTER'
              }
            }))
          }],
          fields: 'userEnteredValue,userEnteredFormat'
        }
      }))
    }
  });
  return id;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Lavora Clinic — Google OAuth2 Setup                ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Load client secrets ──────────────────────────────────────────────────
  if (!fs.existsSync(SECRETS_FILE)) {
    console.log('❌ Missing: credentials/client_secrets.json\n');
    console.log('To get this file:\n');
    console.log('  1. Open: https://console.cloud.google.com');
    console.log('  2. Create project → any name (e.g. "lavora")');
    console.log('  3. APIs & Services → Enable APIs → enable these 3:');
    console.log('     • Google Sheets API');
    console.log('     • Google Calendar API');
    console.log('     • Google Drive API');
    console.log('  4. APIs & Services → Credentials');
    console.log('     → Create Credentials → OAuth 2.0 Client IDs');
    console.log('     → Application type: Web application');
    console.log('     → Authorized redirect URIs → Add: http://localhost:8080/callback');
    console.log('     → Create → Download JSON');
    console.log('  5. Rename the downloaded file to: client_secrets.json');
    console.log('     Move it to: ~/Desktop/ai/lavora-backend/credentials/');
    console.log('  6. Run this script again\n');
    process.exit(1);
  }

  const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  const creds   = secrets.web || secrets.installed;
  if (!creds) {
    console.error('❌ Invalid client_secrets.json format'); process.exit(1);
  }

  const { client_id, client_secret } = creds;
  ok(`Client ID loaded: ${client_id.slice(0, 20)}...`);

  // ── OAuth2 flow ──────────────────────────────────────────────────────────
  console.log('\n[1/4] Opening Google authorization in your browser...');
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  info(`Auth URL: ${authUrl.slice(0, 60)}...`);
  openBrowser(authUrl);

  const code = await waitForCode();
  ok('Authorization received');

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Save tokens for backend reuse
  const tokenData = {
    type: 'authorized_user',
    client_id,
    client_secret,
    refresh_token: tokens.refresh_token
  };
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokenData, null, 2));
  ok('Tokens saved → credentials/google-tokens.json');

  // ── Create Google Sheet ──────────────────────────────────────────────────
  console.log('\n[2/4] Creating Google Sheet...');
  const sheetId = await createSheet(oauth2);
  ok(`Sheet created: "${SHEET_NAME}"`);
  ok(`Sheet ID: ${sheetId}`);
  ok(`Open: https://docs.google.com/spreadsheets/d/${sheetId}`);

  // ── Create Google Calendar ───────────────────────────────────────────────
  console.log('\n[3/4] Creating Google Calendar...');
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const calRes = await calendar.calendars.insert({
    requestBody: {
      summary: CAL_NAME,
      description: 'Lavora Clinic appointment bookings — AI Voice Receptionist',
      timeZone: 'Asia/Muscat'
    }
  });
  const calendarId = calRes.data.id;
  try { await calendar.calendarList.patch({ calendarId, requestBody: { colorId: 'teal' } }); } catch {}
  ok(`Calendar created: "${CAL_NAME}"`);
  ok(`Calendar ID: ${calendarId}`);

  // ── Write .env ───────────────────────────────────────────────────────────
  console.log('\n[4/4] Writing .env...');
  let envContent = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8')
    : (fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, 'utf8') : '');

  envContent = setEnvVar(envContent, 'GOOGLE_SERVICE_ACCOUNT_JSON_PATH', './credentials/google-tokens.json');
  envContent = setEnvVar(envContent, 'GOOGLE_SHEETS_ID', sheetId);
  envContent = setEnvVar(envContent, 'GOOGLE_CALENDAR_ID', calendarId);
  if (!envContent.match(/^CRM_SECRET_KEY=.+$/m)) {
    envContent = setEnvVar(envContent, 'CRM_SECRET_KEY', require('crypto').randomBytes(32).toString('hex'));
  }
  fs.writeFileSync(ENV_FILE, envContent.trim() + '\n');
  ok('.env updated');

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(56));
  console.log('  ✅ GOOGLE SETUP COMPLETE');
  console.log('═'.repeat(56));
  console.log(`\n  📊 Sheet:    https://docs.google.com/spreadsheets/d/${sheetId}`);
  console.log(`  📅 Calendar: ${calendarId}`);
  console.log('\n  Now update sheetsService.js to use OAuth tokens, then:');
  console.log('  ~/node20/bin/npm start\n');
  console.log('═'.repeat(56) + '\n');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
