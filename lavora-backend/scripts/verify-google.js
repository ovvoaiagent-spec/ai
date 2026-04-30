/**
 * Tests your Google credentials before going live.
 * Run: node scripts/verify-google.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const { google } = require('googleapis');

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;

async function run() {
  console.log('\n🔍 Lavora Clinic — Google Credentials Verifier');
  console.log('─'.repeat(50));

  let passed = 0;
  let failed = 0;

  async function check(label, fn) {
    process.stdout.write(`  ▶ ${label}... `);
    try {
      const result = await fn();
      console.log(`✅ ${result || 'OK'}`);
      passed++;
    } catch (err) {
      console.log(`❌ FAILED — ${err.message}`);
      failed++;
    }
  }

  // 1. Check .env values present
  await check('.env — GOOGLE_SERVICE_ACCOUNT_JSON_PATH set', () => {
    if (!KEY_PATH) throw new Error('Not set in .env');
    return KEY_PATH;
  });
  await check('.env — GOOGLE_SHEETS_ID set', () => {
    if (!SHEETS_ID) throw new Error('Not set in .env');
    return SHEETS_ID;
  });
  await check('.env — GOOGLE_CALENDAR_ID set', () => {
    if (!CALENDAR_ID) throw new Error('Not set in .env');
    return CALENDAR_ID;
  });

  // 2. Check credentials file exists
  let auth;
  await check('Service account JSON file exists', () => {
    const fs = require('fs');
    const fullPath = path.resolve(KEY_PATH);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
    const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!content.client_email) throw new Error('Invalid JSON: missing client_email');
    return content.client_email;
  });

  // 3. Create auth client
  await check('Google auth client created', async () => {
    auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(KEY_PATH),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ]
    });
    await auth.getAccessToken();
    return 'Token obtained';
  });

  if (!auth) {
    console.log('\n❌ Cannot continue without valid auth. Fix above errors first.\n');
    process.exit(1);
  }

  // 4. Test Sheets access
  await check('Google Sheets — can read spreadsheet', async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
    const tabs = res.data.sheets.map(s => s.properties.title);
    return `"${res.data.properties.title}" (tabs: ${tabs.join(', ')})`;
  });

  // 5. Check required tabs exist
  const REQUIRED_TABS = ['Appointments', 'Missed Captures', 'Call Log', 'Activity Log'];
  await check('Google Sheets — required tabs exist', async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
    const existing = res.data.sheets.map(s => s.properties.title);
    const missing = REQUIRED_TABS.filter(t => !existing.includes(t));
    if (missing.length) throw new Error(`Missing tabs: ${missing.join(', ')} — create them in your Google Sheet`);
    return `All ${REQUIRED_TABS.length} tabs found`;
  });

  // 6. Test Sheets write (append a test row then verify it was written)
  await check('Google Sheets — can write to Appointments tab', async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: 'Appointments!A:A',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [['VERIFY_TEST — safe to delete', new Date().toISOString()]] }
    });
    return 'Row written successfully';
  });

  // 7. Test Calendar access
  await check('Google Calendar — can access calendar', async () => {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.calendars.get({ calendarId: CALENDAR_ID });
    return `"${res.data.summary}"`;
  });

  // 8. Test Calendar write (create + delete a test event)
  await check('Google Calendar — can create/delete events', async () => {
    const calendar = google.calendar({ version: 'v3', auth });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const end = new Date(tomorrow);
    end.setHours(11, 0, 0, 0);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: '[VERIFY TEST — safe to delete]',
        start: { dateTime: tomorrow.toISOString(), timeZone: 'Asia/Muscat' },
        end: { dateTime: end.toISOString(), timeZone: 'Asia/Muscat' }
      }
    });

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event.data.id });
    return 'Event created and deleted';
  });

  console.log('\n' + '─'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✅ All Google integrations are working!\n');
    console.log('  You are ready to:\n');
    console.log('  1. Start the server:  npm start');
    console.log('  2. Configure agent:   node scripts/setup-agent.js https://YOUR_PUBLIC_URL');
    console.log('  3. Call your number and test a live booking\n');
  } else {
    console.log('  ⚠️  Fix the failed checks above before going live.\n');
    console.log('  Common fixes:');
    console.log('  • Share your Google Sheet with the service account email (Editor access)');
    console.log('  • Share your Google Calendar with the service account email (Make changes to events)');
    console.log('  • Enable Sheets API and Calendar API in Google Cloud Console\n');
  }
  console.log('─'.repeat(50) + '\n');
}

run().catch(err => {
  console.error('\n❌ Fatal error:', err.message, '\n');
  process.exit(1);
});
