require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

// Validate env vars before loading anything else so failures are instant + clear
const { validateEnv } = require('./config/env');

const db             = require('./services/localDbService');
const sheetsService  = require('./services/sheetsService');
const pollingService = require('./services/pollingService');
const jobQueue       = require('./services/jobQueue');
const laserPkgSvc   = require('./services/laserPackageService');
const sessionStore   = require('./services/sessionStore');
const log            = require('./services/logger').child('SERVER');

validateEnv(log);

const { toolsLimiter, apiLimiter, webhookLimiter } = require('./middleware/rateLimiter');
const webhookRoutes  = require('./routes/webhooks');
const whatsappRoutes = require('./routes/whatsapp');
const apiRoutes      = require('./routes/api');
const toolRoutes     = require('./routes/tools');

const app = express();

app.set('trust proxy', 1);   // needed for rate-limiter behind Railway proxy

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

const DASHBOARD_CANDIDATES = [
  path.join(__dirname, '../dashboard'),
  path.join(process.cwd(), 'dashboard'),
  path.join(process.cwd(), '../dashboard')
];
const DASHBOARD_DIR = DASHBOARD_CANDIDATES.find(p => fs.existsSync(p)) || DASHBOARD_CANDIDATES[0];
app.use(express.static(DASHBOARD_DIR));

app.use('/webhook', webhookLimiter, webhookRoutes);
app.use('/webhook', webhookLimiter, whatsappRoutes);
app.use('/api',     apiLimiter,     apiRoutes);
app.use('/tools',   toolsLimiter,   toolRoutes);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clinic: 'Test Clinic',
    storage: process.env.DATABASE_URL ? 'postgresql' : 'local-json',
    sheets: sheetsService.googleConfigured() ? 'configured' : 'not configured',
    calendar: process.env.GOOGLE_CALENDAR_ID ? 'configured' : 'not configured',
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (_req, res) => {
  res.json({
    server: true,
    database: !!process.env.DATABASE_URL,
    job_queue: !!process.env.DATABASE_URL ? 'pg-boss' : 'setInterval',
    validation: 'zod',
    sessions: !!process.env.DATABASE_URL ? 'postgresql' : 'memory',
    sheets: sheetsService.googleConfigured(),
    calendar: !!process.env.GOOGLE_CALENDAR_ID,
    elevenlabs_api: !!process.env.ELEVENLABS_API_KEY,
    elevenlabs_agent: !!process.env.ELEVENLABS_AGENT_ID,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    pipeline: 'elevenlabs-convai'
  });
});

app.get('/', (_req, res) => {
  const indexPath = path.join(DASHBOARD_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(500).send('Dashboard not found.');
  res.sendFile(indexPath);
});

app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, _req, res, _next) => {
  log.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await db.initDb();

  // ── Job queue (pg-boss in prod, setInterval fallback in local dev) ──────────
  await jobQueue.init();
  await sessionStore.hydrate();

  // Session TTL cleanup — every 5 minutes
  await jobQueue.registerRecurring(
    'session-cleanup',
    '*/5 * * * *',
    () => sessionStore.purgeExpired(),
    5 * 60 * 1000
  );

  // Appointment 24h reminders — every hour at :00
  await jobQueue.registerRecurring(
    'appointment-reminders',
    '0 * * * *',
    () => pollingService.sendReminders(),
    pollingService.REMINDER_INTERVAL_MS
  );

  // Laser package 24h follow-ups — every hour at :30 (staggered from reminders)
  await jobQueue.registerRecurring(
    'laser-followups',
    '30 * * * *',
    () => laserPkgSvc.runFollowUpCheck(),
    pollingService.REMINDER_INTERVAL_MS
  );

  // ElevenLabs conversation polling — every 30 seconds
  // Kept as local timer even in production since pg-boss doesn't support sub-minute
  // cron without a custom workaround, and missed polls are not critical.
  if (process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_API_KEY) {
    pollingService.poll();
    setInterval(() => pollingService.poll(), pollingService.POLL_INTERVAL_MS);
    log.info('ElevenLabs polling started (every 30s)');
  } else {
    log.warn('ElevenLabs not configured — conversation polling disabled');
  }

  // Self-ping every 4 minutes to prevent Railway from sleeping (keeps tool calls fast)
  const selfUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    const http = selfUrl.startsWith('https') ? require('https') : require('http');
    http.get(`${selfUrl}/status`, () => {}).on('error', () => {});
  }, 4 * 60 * 1000);

  try { await sheetsService.initializeSheets(); } catch {}

  const server = app.listen(PORT, () => {
    log.info('═══════════════════════════════════════════════════');
    log.info('  Test Clinic — AI Voice Receptionist Backend');
    log.info('═══════════════════════════════════════════════════');
    log.info(`Port      : ${PORT}`);
    log.info(`Database  : ${process.env.DATABASE_URL ? 'PostgreSQL ✅' : 'Local JSON'}`);
    log.info(`Job Queue : ${process.env.DATABASE_URL ? 'pg-boss (PostgreSQL) ✅' : 'setInterval (local fallback)'}`);
    log.info(`Sheets    : ${sheetsService.googleConfigured() ? 'Connected ✅' : 'Not configured'}`);
    log.info(`Calendar  : ${process.env.GOOGLE_CALENDAR_ID ? 'Configured ✅' : 'Not configured'}`);
    log.info(`Twilio    : ${process.env.TWILIO_ACCOUNT_SID ? 'Configured ✅' : 'Missing SID'}`);
    log.info(`ElevenLabs: ${process.env.ELEVENLABS_AGENT_ID ? 'ConvAI configured ✅' : 'AGENT_ID missing ⚠️'}`);
    log.info(`WhatsApp  : ${process.env.WHATSAPP_PHONE_NUMBER_ID ? 'Configured ✅' : 'Not configured'}`);
    log.info(`Pipeline  : ElevenLabs ConvAI (voice) + WhatsApp AI (chat)`);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // Railway sends SIGTERM before killing the container. We stop accepting new
  // connections, wait for in-flight requests to drain, then stop the job queue
  // and close the DB pool cleanly. This prevents dropped bookings on every deploy.
  async function shutdown(signal) {
    log.info(`${signal} received — shutting down gracefully`);

    server.close(async () => {
      log.info('HTTP server closed (no new connections)');
      try {
        await jobQueue.stop();
        if (db.pool) await db.pool.end();
        log.info('Shutdown complete');
      } catch (e) {
        log.warn(`Shutdown error: ${e.message}`);
      }
      process.exit(0);
    });

    // Force exit after 15 seconds if drain takes too long
    setTimeout(() => {
      log.warn('Shutdown timeout — forcing exit');
      process.exit(1);
    }, 15000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();

module.exports = app;
