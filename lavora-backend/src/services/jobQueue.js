/**
 * Durable job queue — pg-boss backed in production, setInterval fallback in local dev.
 *
 * pg-boss stores all jobs and schedules in PostgreSQL, so:
 *   - Jobs survive server restarts
 *   - Failed jobs are retried automatically
 *   - No duplicate runs when deploying (pg-boss uses DB-level locking)
 *   - All job history visible in the pgboss.job table
 *
 * Local dev (no DATABASE_URL): falls back to plain setInterval so nothing breaks.
 */

const log = require('./logger').child('JOBS');

let boss = null;
let pgBossAvailable = false;

// Try to require pg-boss — may not be installed in local dev
try {
  require('pg-boss');
  pgBossAvailable = true;
} catch {
  pgBossAvailable = false;
}

// ─── Fallback in-memory scheduler (local dev only) ────────────────────────────
const localTimers = [];

function localRecurring(name, handler, intervalMs) {
  handler().catch(e => log.error(`[LOCAL-JOB] ${name}: ${e.message}`));
  const id = setInterval(() => {
    handler().catch(e => log.error(`[LOCAL-JOB] ${name}: ${e.message}`));
  }, intervalMs);
  localTimers.push(id);
  log.info(`[LOCAL-JOB] ${name} scheduled every ${intervalMs / 1000}s`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!process.env.DATABASE_URL || !pgBossAvailable) {
    log.info('Job queue: local mode (setInterval fallback). Set DATABASE_URL for pg-boss.');
    return false;
  }

  const PgBoss = require('pg-boss');
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 3
  });

  boss.on('error', err => log.error(`pg-boss error: ${err.message}`));

  await boss.start();
  log.info('Job queue: pg-boss started (PostgreSQL-backed)');
  return true;
}

// ─── Register a recurring job (cron) ─────────────────────────────────────────
// cronExpr: standard 5-part cron  e.g. '0 * * * *' = every hour on the hour
// localMs:  fallback interval for local dev
async function registerRecurring(name, cronExpr, handler, localMs) {
  if (boss) {
    // Worker must be registered before schedule so pg-boss knows how to run it
    await boss.work(name, { teamConcurrency: 1 }, async (job) => {
      log.info(`[JOB] ${name} running (id: ${job.id})`);
      try {
        await handler(job.data || {});
        log.info(`[JOB] ${name} completed`);
      } catch (err) {
        log.error(`[JOB] ${name} failed: ${err.message}`);
        throw err; // pg-boss will retry according to retryLimit
      }
    });

    // schedule() is idempotent — safe to call on every startup
    await boss.schedule(name, cronExpr, {}, { tz: 'Asia/Muscat' });
    log.info(`[JOB] Registered: ${name} (cron: ${cronExpr})`);
  } else {
    localRecurring(name, handler, localMs);
  }
}

// ─── Send a one-time job, optionally delayed ──────────────────────────────────
// delaySeconds: 0 = immediate, >0 = run after N seconds
async function sendOnce(name, data = {}, delaySeconds = 0) {
  if (!boss) {
    // Local dev: execute immediately (no delay support)
    log.info(`[LOCAL-JOB] ${name} fired immediately (no delay in local mode)`);
    return null;
  }
  const opts = delaySeconds > 0 ? { startAfter: delaySeconds } : {};
  const jobId = await boss.send(name, data, opts);
  log.info(`[JOB] Sent: ${name} (delay: ${delaySeconds}s, id: ${jobId})`);
  return jobId;
}

// ─── Register a one-time job worker ──────────────────────────────────────────
async function registerOnce(name, handler) {
  if (!boss) return;
  await boss.work(name, { teamConcurrency: 1 }, async (job) => {
    log.info(`[JOB] ${name} running (id: ${job.id})`);
    try {
      await handler(job.data || {});
    } catch (err) {
      log.error(`[JOB] ${name} (once) failed: ${err.message}`);
      throw err;
    }
  });
}

// ─── Graceful stop ────────────────────────────────────────────────────────────
async function stop() {
  localTimers.forEach(clearInterval);
  if (boss) {
    await boss.stop();
    log.info('Job queue stopped');
  }
}

module.exports = { init, registerRecurring, registerOnce, sendOnce, stop };
