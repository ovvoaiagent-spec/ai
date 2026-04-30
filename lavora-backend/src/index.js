require('dotenv').config();
const express = require('express');
const path = require('path');

const sheetsService = require('./services/sheetsService');
const activityService = require('./services/activityService');
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const toolRoutes = require('./routes/tools');

const app = express();

// CORS — allow the dashboard to call the API from any origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Capture raw body for ElevenLabs HMAC signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// Serve CRM dashboard at /
app.use(express.static(path.join(__dirname, '../dashboard')));

// Mount routes
app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/tools', toolRoutes); // real-time ElevenLabs tool calls (mid-conversation)

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clinic: 'Lavora Clinic',
    service: 'AI Voice Receptionist Backend',
    timestamp: new Date().toISOString()
  });
});

// Integration status (public) — dashboard polls this to show green/red indicators
app.get('/status', async (_req, res) => {
  const status = {
    server: true,
    sheets: false,
    calendar: false,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  };
  if (process.env.GOOGLE_SHEETS_ID) {
    try {
      await sheetsService.getAllAppointments();
      status.sheets = true;
    } catch {}
  }
  if (process.env.GOOGLE_CALENDAR_ID) {
    try {
      const { google } = require('googleapis');
      const auth = await sheetsService.getAuth();
      const cal = google.calendar({ version: 'v3', auth });
      await cal.calendars.get({ calendarId: process.env.GOOGLE_CALENDAR_ID });
      status.calendar = true;
    } catch {}
  }
  res.json(status);
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  // Wire activity service to sheets for persistence
  activityService.init(sheetsService);

  // Initialize Google Sheets headers
  if (process.env.GOOGLE_SHEETS_ID) {
    try {
      await sheetsService.initializeSheets();
    } catch (err) {
      console.warn('[STARTUP] Sheets init skipped (check credentials):', err.message);
    }
  }

  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║     Lavora Clinic — AI Voice Receptionist Backend    ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`\n📞 Webhooks:`);
    console.log(`   POST /webhook/elevenlabs`);
    console.log(`   POST /webhook/twilio/call-status`);
    console.log(`\n📊 CRM API (requires X-Api-Key header):`);
    console.log(`   GET  /api/appointments`);
    console.log(`   POST /api/appointments`);
    console.log(`   PUT  /api/appointments/:id`);
    console.log(`   DELETE /api/appointments/:id`);
    console.log(`   GET  /api/appointments/today`);
    console.log(`   GET  /api/activity`);
    console.log(`   GET  /api/stats`);
    console.log(`\n🤖 Agent Tools (called live during calls):`);
    console.log(`   POST /tools/check-availability`);
    console.log(`   POST /tools/book-appointment`);
    console.log(`   POST /tools/get-services`);
    console.log(`\n🖥️  Dashboard: http://localhost:${PORT}/`);
    console.log(`❤️  Health:    http://localhost:${PORT}/health\n`);
  });
}

start();

module.exports = app;
