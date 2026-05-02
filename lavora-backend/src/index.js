require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('./services/localDbService');
const activityService = require('./services/activityService');
const pollingService = require('./services/pollingService');
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const toolRoutes = require('./routes/tools');

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

const DASHBOARD_CANDIDATES = [
  path.join(__dirname, '../dashboard'),
  path.join(process.cwd(), 'dashboard'),
  path.join(process.cwd(), '../dashboard')
];
const DASHBOARD_DIR = DASHBOARD_CANDIDATES.find(p => fs.existsSync(p)) || DASHBOARD_CANDIDATES[0];
console.log('[STATIC] Dashboard dir:', DASHBOARD_DIR, '| exists:', fs.existsSync(DASHBOARD_DIR));
app.use(express.static(DASHBOARD_DIR));

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/tools', toolRoutes);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    clinic: 'Lavora Clinic',
    service: 'AI Voice Receptionist Backend',
    storage: process.env.DATABASE_URL ? 'postgresql' : 'local-json',
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (_req, res) => {
  res.json({
    server: true,
    database: !!process.env.DATABASE_URL,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  });
});

app.get('/', (_req, res) => {
  const indexPath = path.join(DASHBOARD_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(500).send(
      `Dashboard not found.<br>Tried: ${DASHBOARD_CANDIDATES.join('<br>')}`
    );
  }
  res.sendFile(indexPath);
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await db.initDb();

  pollingService.start();

  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║     Lavora Clinic — AI Voice Receptionist Backend    ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`   Storage: ${process.env.DATABASE_URL ? 'PostgreSQL ✅' : 'Local JSON (no DATABASE_URL set)'}`);
    console.log(`\n📞 Webhooks:`);
    console.log(`   POST /webhook/elevenlabs`);
    console.log(`   POST /webhook/twilio/call-status`);
    console.log(`\n📊 CRM API:`);
    console.log(`   GET  /api/appointments`);
    console.log(`   POST /api/appointments`);
    console.log(`   PUT  /api/appointments/:id`);
    console.log(`   DELETE /api/appointments/:id`);
    console.log(`\n🤖 Agent Tools:`);
    console.log(`   POST /tools/check-availability`);
    console.log(`   POST /tools/book-appointment\n`);
  });
}

start();

module.exports = app;
