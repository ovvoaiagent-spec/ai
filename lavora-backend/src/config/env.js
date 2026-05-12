/**
 * Environment variable validation.
 * Called at the very start of index.js before anything else.
 *
 * REQUIRED vars crash the process with a clear message.
 * OPTIONAL vars log a warning but allow startup to continue.
 *
 * This prevents the server from starting in a partially-configured state
 * where some features silently fail hours after deployment.
 */

const REQUIRED = [
  { key: 'ANTHROPIC_API_KEY',  description: 'Claude AI — required for WhatsApp and voice agents' }
];

const OPTIONAL = [
  { key: 'DATABASE_URL',               description: 'PostgreSQL — defaults to local JSON files' },
  { key: 'WHATSAPP_PHONE_NUMBER_ID',   description: 'WhatsApp Cloud API — WhatsApp bot disabled without this' },
  { key: 'WHATSAPP_ACCESS_TOKEN',      description: 'WhatsApp Cloud API — WhatsApp bot disabled without this' },
  { key: 'ELEVENLABS_AGENT_ID',        description: 'ElevenLabs ConvAI — voice agent disabled without this' },
  { key: 'ELEVENLABS_API_KEY',         description: 'ElevenLabs ConvAI — voice agent disabled without this' },
  { key: 'GOOGLE_CALENDAR_ID',         description: 'Google Calendar sync — disabled without this' },
  { key: 'GOOGLE_SERVICE_ACCOUNT_JSON',description: 'Google Calendar sync — disabled without this' }
];

function validateEnv(log) {
  const missing = REQUIRED.filter(v => !process.env[v.key]);

  if (missing.length) {
    log.error('═══════════════════════════════════════════════════════');
    log.error('  STARTUP FAILED — missing required environment variables');
    log.error('═══════════════════════════════════════════════════════');
    missing.forEach(v => log.error(`  ✗ ${v.key} — ${v.description}`));
    log.error('');
    log.error('  Set these in Railway → Variables or your .env file.');
    log.error('═══════════════════════════════════════════════════════');
    process.exit(1);
  }

  const warnings = OPTIONAL.filter(v => !process.env[v.key]);
  if (warnings.length) {
    log.warn('Optional env vars not set (features disabled):');
    warnings.forEach(v => log.warn(`  ⚠  ${v.key} — ${v.description}`));
  }
}

module.exports = { validateEnv };
