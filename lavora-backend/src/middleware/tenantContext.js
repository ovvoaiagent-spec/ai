/**
 * Multi-tenant context middleware.
 *
 * Resolves the clinic_id from the request's API key and attaches it to req.
 * All DB queries use req.clinicId so data is automatically scoped to that clinic.
 *
 * Single-tenant fallback: if the DB has no clinics table yet (local dev / pre-
 * migration), req.clinicId defaults to 'clinic_default' — the same value used
 * as the DEFAULT in the migration — so existing queries continue to work.
 *
 * This middleware runs after requireApiKey, so the key is already validated.
 */

const log = require('../services/logger').child('TENANT');

// In-memory cache: apiKey → clinicId (refreshed every 5 min)
const keyCache = new Map();
let lastCacheRefresh = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveClinics(pool) {
  if (!pool) return;
  if (Date.now() - lastCacheRefresh < CACHE_TTL_MS) return;
  try {
    const res = await pool.query('SELECT id, api_key FROM clinics WHERE active = TRUE');
    keyCache.clear();
    for (const row of res.rows) keyCache.set(row.api_key, row.id);
    lastCacheRefresh = Date.now();
  } catch {
    // clinics table may not exist yet (before migration 005) — use default
  }
}

function tenantContext(pool) {
  return async (req, _res, next) => {
    await resolveClinics(pool);

    const apiKey = req.headers['x-api-key'] || req.query.key || '';
    req.clinicId = keyCache.get(apiKey) || 'clinic_default';

    next();
  };
}

module.exports = { tenantContext };
