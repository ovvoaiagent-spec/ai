require('dotenv').config();
const express = require('express');
const path = require('path');

const sheetsService = require('./services/sheetsService');
const activityService = require('./services/activityService');
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');

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

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clinic: 'Lavora Clinic',
    service: 'AI Voice Receptionist Backend',
    timestamp: new Date().toISOString()
  });
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
    console.log(`\n🖥️  Dashboard: http://localhost:${PORT}/`);
    console.log(`❤️  Health:    http://localhost:${PORT}/health\n`);
  });
}

start();

module.exports = app;
