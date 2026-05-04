require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('./services/localDbService');
const sheetsService = require('./services/sheetsService');
const pollingService = require('./services/pollingService');
const log = require('./services/logger').child('SERVER');

const { toolsLimiter, apiLimiter, webhookLimiter } = require('./middleware/rateLimiter');
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const toolRoutes = require('./routes/tools');

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
app.use('/api',     apiLimiter,     apiRoutes);
app.use('/tools',   toolsLimiter,   toolRoutes);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clinic: 'Lavora Clinic',
    storage: process.env.DATABASE_URL ? 'postgresql' : 'local-json',
    sheets: sheetsService.googleConfigured() ? 'configured' : 'not configured',
    calendar: process.env.GOOGLE_CALENDAR_ID ? 'configured' : 'not configured',
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (_req, res) => {
  const customPipeline = !!(process.env.ANTHROPIC_API_KEY && process.env.DEEPGRAM_API_KEY);
  res.json({
    server: true,
    database: !!process.env.DATABASE_URL,
    sheets: sheetsService.googleConfigured(),
    calendar: !!process.env.GOOGLE_CALENDAR_ID,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    pipeline: customPipeline ? 'custom' : 'elevenlabs'
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
  try { await sheetsService.initializeSheets(); } catch {}
  pollingService.start();

  const server = app.listen(PORT, () => {
    log.info('═══════════════════════════════════════════════════');
    log.info('  Lavora Clinic — AI Voice Receptionist Backend');
    log.info('═══════════════════════════════════════════════════');
    log.info(`Port      : ${PORT}`);
    log.info(`Database  : ${process.env.DATABASE_URL ? 'PostgreSQL ✅' : 'Local JSON'}`);
    log.info(`Sheets    : ${sheetsService.googleConfigured() ? 'Connected ✅' : 'Not configured'}`);
    log.info(`Calendar  : ${process.env.GOOGLE_CALENDAR_ID ? 'Configured ✅' : 'Not configured'}`);
    log.info(`Twilio    : ${process.env.TWILIO_ACCOUNT_SID ? 'Configured ✅' : 'Missing SID'}`);
    log.info(`SMS/Remind: ✅ active`);

    const pipelineReady = !!(process.env.ANTHROPIC_API_KEY && process.env.DEEPGRAM_API_KEY);
    log.info(`Pipeline  : ${pipelineReady ? 'Custom (Deepgram+Claude+ElevenLabs) ✅' : 'ElevenLabs ConvAI (fallback)'}`);

    if (pipelineReady) {
      const pipeline = require('./pipeline');
      pipeline.attach(server);
    }
  });
}

start();

module.exports = app;
