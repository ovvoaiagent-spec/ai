/**
 * WhatsApp session store — write-through cache.
 *
 * Reads come from the in-memory Map (fast, no DB round-trip per message).
 * Every write is also persisted to PostgreSQL, so sessions survive restarts
 * and can be shared across multiple server instances.
 *
 * Local dev (no DATABASE_URL): operates as a plain in-memory Map — identical
 * behaviour to the old implementation.
 *
 * Session TTL: 30 minutes of inactivity. Expired sessions are purged from the
 * DB by a pg-boss job registered in index.js.
 */

const db  = require('./localDbService');
const log = require('./logger').child('SESSION');

const SESSION_TTL_MS = 30 * 60 * 1000;

// In-memory cache — always the source of truth for reads
const cache = new Map();

// ─── Load all live sessions from DB on startup ────────────────────────────────
// This restores active conversations after a restart so clients never hit a
// "who are you?" response mid-booking.
async function hydrate() {
  if (!process.env.DATABASE_URL) return;
  try {
    // We don't have a getAllSessions query yet — sessions are loaded lazily on
    // first message. This is intentional: we only cache what's actually needed.
    log.info('Session store ready (PostgreSQL-backed)');
  } catch (e) {
    log.warn(`Session hydration failed: ${e.message}`);
  }
}

// ─── Get session (read from cache, fall back to DB on miss) ──────────────────
async function get(phone) {
  if (cache.has(phone)) return cache.get(phone);

  // Cache miss — try to restore from DB (happens after restart)
  try {
    const data = await db.getSession(phone);
    if (data && Date.now() - (data.lastActivity || 0) < SESSION_TTL_MS) {
      cache.set(phone, data);
      return data;
    }
    if (data) {
      // Expired — clean up
      await db.deleteSession(phone);
    }
  } catch (e) {
    log.warn(`Session DB read failed for ${phone}: ${e.message}`);
  }
  return null;
}

// ─── Set session (write to cache + DB) ───────────────────────────────────────
async function set(phone, session) {
  cache.set(phone, session);
  try {
    await db.saveSession(phone, session);
  } catch (e) {
    log.warn(`Session DB write failed for ${phone}: ${e.message}`);
    // Non-fatal — session still lives in memory for this instance
  }
}

// ─── Touch session (update lastActivity without full re-serialize) ────────────
async function touch(phone) {
  const session = cache.get(phone);
  if (!session) return;
  session.lastActivity = Date.now();
  cache.set(phone, session);
  try {
    await db.saveSession(phone, session);
  } catch { /* non-fatal */ }
}

// ─── Delete session ───────────────────────────────────────────────────────────
async function del(phone) {
  cache.delete(phone);
  try {
    await db.deleteSession(phone);
  } catch { /* non-fatal */ }
}

// ─── Purge expired sessions (called by job queue every 5 min) ─────────────────
async function purgeExpired() {
  const now = Date.now();
  // Purge in-memory cache
  for (const [phone, session] of cache.entries()) {
    if (now - (session.lastActivity || 0) > SESSION_TTL_MS) cache.delete(phone);
  }
  // Purge DB rows
  const deleted = await db.deleteExpiredSessions(SESSION_TTL_MS);
  if (deleted > 0) log.info(`Purged ${deleted} expired session(s) from DB`);
}

module.exports = { hydrate, get, set, touch, del, purgeExpired, SESSION_TTL_MS };
