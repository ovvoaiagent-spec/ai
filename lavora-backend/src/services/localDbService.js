/**
 * Storage layer — uses PostgreSQL when DATABASE_URL is set (Railway production),
 * falls back to local JSON files for local development.
 * All functions are async so callers work identically regardless of backend.
 */

const fs   = require('fs');
const path = require('path');

// ── PostgreSQL setup ──────────────────────────────────────────────────────────
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });
  console.log('[DB] PostgreSQL connected');
} else {
  console.log('[DB] Using local JSON files (set DATABASE_URL for PostgreSQL)');
}

// ── Local JSON fallback ───────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  appointments  : path.join(DATA_DIR, 'appointments.json'),
  missed        : path.join(DATA_DIR, 'missed-captures.json'),
  callLog       : path.join(DATA_DIR, 'call-log.json'),
  activity      : path.join(DATA_DIR, 'activity-log.json'),
  laserPackages : path.join(DATA_DIR, 'laser-packages.json')
};

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function writeFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Init: run migrations ──────────────────────────────────────────────────────
async function initDb() {
  const { runMigrations } = require('./migrationRunner');
  await runMigrations(pool); // pool is null in local dev — migrationRunner handles it gracefully
}

const DEFAULT_CLINIC = 'clinic_default';

// ── Appointments ──────────────────────────────────────────────────────────────
async function getAllAppointments(clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM appointments WHERE clinic_id = $1 ORDER BY created_at ASC',
      [clinicId]
    );
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.appointments);
}

async function getAppointmentById(id, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM appointments WHERE id = $1 AND clinic_id = $2',
      [id, clinicId]
    );
    return res.rows[0]?.data || null;
  }
  return readFile(FILES.appointments).find(a => a.id === id) || null;
}

async function appendAppointment(apt, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query(
      'INSERT INTO appointments (id, data, clinic_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2',
      [apt.id, apt, clinicId]
    );
  } else {
    const all = readFile(FILES.appointments);
    all.push(apt);
    writeFile(FILES.appointments, all);
  }
  console.log(`[DB] Appointment saved: ${apt.id}`);
}

async function updateAppointment(id, updates, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      `UPDATE appointments SET data = data || $1::jsonb WHERE id = $2 AND clinic_id = $3 RETURNING data`,
      [JSON.stringify(updates), id, clinicId]
    );
    if (res.rows.length === 0) throw new Error(`Appointment ${id} not found`);
    return res.rows[0].data;
  }
  const all = readFile(FILES.appointments);
  const idx = all.findIndex(a => a.id === id);
  if (idx === -1) throw new Error(`Appointment ${id} not found`);
  all[idx] = { ...all[idx], ...updates };
  writeFile(FILES.appointments, all);
  return all[idx];
}

async function cancelAppointment(id, clinicId = DEFAULT_CLINIC) {
  return updateAppointment(id, { status: 'Cancelled' }, clinicId);
}

async function hardDeleteAppointment(id, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query('DELETE FROM appointments WHERE id = $1 AND clinic_id = $2', [id, clinicId]);
    return;
  }
  const all = readFile(FILES.appointments).filter(a => a.id !== id);
  writeFile(FILES.appointments, all);
}

async function checkConflict(date, time, doctor = null, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const doctorClause = doctor ? `AND data->>'doctor' = $4` : '';
    const params = doctor ? [date, time, clinicId, doctor] : [date, time, clinicId];
    const res = await pool.query(
      `SELECT 1 FROM appointments
       WHERE clinic_id = $3
         AND data->>'status' != 'Cancelled'
         AND data->>'date' = $1
         AND data->>'time' = $2
         ${doctorClause}
       LIMIT 1`,
      params
    );
    return res.rows.length > 0;
  }
  return readFile(FILES.appointments).some(apt => {
    if (apt.status === 'Cancelled') return false;
    const sameSlot = apt.date === date && apt.time === time;
    return doctor ? sameSlot && apt.doctor === doctor : sameSlot;
  });
}

// ── Missed Captures ───────────────────────────────────────────────────────────
async function appendMissedCapture(missed, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query(
      'INSERT INTO missed_captures (id, data, clinic_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [missed.id, missed, clinicId]
    );
    return;
  }
  const all = readFile(FILES.missed);
  all.push(missed);
  writeFile(FILES.missed, all);
}

// ── Call Log ──────────────────────────────────────────────────────────────────
async function appendCallLog(call, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query('INSERT INTO call_log (data, clinic_id) VALUES ($1, $2)', [call, clinicId]);
    return;
  }
  const all = readFile(FILES.callLog);
  all.push(call);
  writeFile(FILES.callLog, all);
}

// ── Activity Log ──────────────────────────────────────────────────────────────
async function getAllActivities(clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM activity_log WHERE clinic_id = $1 ORDER BY created_at DESC LIMIT 200',
      [clinicId]
    );
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.activity);
}

async function appendActivity(entry, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query('INSERT INTO activity_log (data, clinic_id) VALUES ($1, $2)', [entry, clinicId]);
    return;
  }
  const all = readFile(FILES.activity);
  all.unshift(entry);
  if (all.length > 200) all.splice(200);
  writeFile(FILES.activity, all);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function getStats(clinicId = DEFAULT_CLINIC) {
  const today = new Date().toISOString().slice(0, 10);
  if (pool) {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE data->>'date' = $1 AND data->>'status' != 'Cancelled') AS today_total,
        COUNT(*) FILTER (WHERE data->>'source' = 'AI Voice')  AS ai_booked,
        COUNT(*) FILTER (WHERE data->>'source' = 'Human')     AS human_booked,
        COUNT(*) FILTER (WHERE data->>'status' = 'Pending')   AS pending,
        COUNT(*) FILTER (WHERE data->>'status' = 'Confirmed') AS confirmed,
        COUNT(*) FILTER (WHERE data->>'status' = 'Cancelled') AS cancelled,
        COUNT(*)                                               AS total
      FROM appointments
      WHERE clinic_id = $2
    `, [today, clinicId]);
    const r = res.rows[0];
    return {
      today_total:  parseInt(r.today_total),
      ai_booked:    parseInt(r.ai_booked),
      human_booked: parseInt(r.human_booked),
      pending:      parseInt(r.pending),
      confirmed:    parseInt(r.confirmed),
      cancelled:    parseInt(r.cancelled),
      total:        parseInt(r.total)
    };
  }
  const all = readFile(FILES.appointments);
  return {
    today_total:  all.filter(a => a.date === today && a.status !== 'Cancelled').length,
    ai_booked:    all.filter(a => a.source === 'AI Voice').length,
    human_booked: all.filter(a => a.source === 'Human').length,
    pending:      all.filter(a => a.status === 'Pending').length,
    confirmed:    all.filter(a => a.status === 'Confirmed').length,
    cancelled:    all.filter(a => a.status === 'Cancelled').length,
    total:        all.length
  };
}

// ── Laser Packages ────────────────────────────────────────────────────────────
async function getAllPackages(clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM laser_packages WHERE clinic_id = $1 ORDER BY created_at ASC',
      [clinicId]
    );
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.laserPackages);
}

async function getPackageById(id, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM laser_packages WHERE id = $1 AND clinic_id = $2',
      [id, clinicId]
    );
    return res.rows[0]?.data || null;
  }
  return readFile(FILES.laserPackages).find(p => p.id === id) || null;
}

async function savePackage(pkg, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query(
      'INSERT INTO laser_packages (id, data, clinic_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2',
      [pkg.id, JSON.stringify(pkg), clinicId]
    );
  } else {
    const all = readFile(FILES.laserPackages);
    const idx = all.findIndex(p => p.id === pkg.id);
    if (idx === -1) all.push(pkg);
    else all[idx] = pkg;
    writeFile(FILES.laserPackages, all);
  }
}

async function updatePackageData(id, updates, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM laser_packages WHERE id = $1 AND clinic_id = $2',
      [id, clinicId]
    );
    if (!res.rows.length) throw new Error(`Package ${id} not found`);
    const updated = { ...res.rows[0].data, ...updates };
    await pool.query(
      'UPDATE laser_packages SET data = $1 WHERE id = $2 AND clinic_id = $3',
      [JSON.stringify(updated), id, clinicId]
    );
    return updated;
  }
  const all = readFile(FILES.laserPackages);
  const idx = all.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Package ${id} not found`);
  all[idx] = { ...all[idx], ...updates };
  writeFile(FILES.laserPackages, all);
  return all[idx];
}

// ── WhatsApp Sessions ─────────────────────────────────────────────────────────
async function getSession(phone, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM whatsapp_sessions WHERE phone = $1 AND clinic_id = $2',
      [phone, clinicId]
    );
    return res.rows[0]?.data || null;
  }
  return null; // local dev uses in-memory Map in sessionStore.js
}

async function saveSession(phone, data, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query(
      `INSERT INTO whatsapp_sessions (phone, data, clinic_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone) DO UPDATE SET data = $2, updated_at = NOW()`,
      [phone, JSON.stringify(data), clinicId]
    );
  }
}

async function deleteSession(phone, clinicId = DEFAULT_CLINIC) {
  if (pool) {
    await pool.query(
      'DELETE FROM whatsapp_sessions WHERE phone = $1 AND clinic_id = $2',
      [phone, clinicId]
    );
  }
}

async function deleteExpiredSessions(ttlMs) {
  if (pool) {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const res = await pool.query(
      'DELETE FROM whatsapp_sessions WHERE updated_at < $1 RETURNING phone',
      [cutoff]
    );
    return res.rows.length;
  }
  return 0;
}

// ── Clinics ───────────────────────────────────────────────────────────────────
async function getAllClinics() {
  if (pool) {
    const res = await pool.query(
      'SELECT id, name, api_key, created_at, active FROM clinics ORDER BY created_at ASC'
    );
    return res.rows;
  }
  return [{ id: DEFAULT_CLINIC, name: 'Default Clinic', api_key: '***', active: true }];
}

async function createClinic({ id, name, api_key }) {
  if (pool) {
    await pool.query(
      'INSERT INTO clinics (id, name, api_key) VALUES ($1, $2, $3)',
      [id, name, api_key]
    );
    return { id, name, api_key, active: true };
  }
  throw new Error('Clinic management requires PostgreSQL');
}

module.exports = {
  pool,  // exposed so migrationRunner can receive it directly
  initDb,
  getAllAppointments, getAppointmentById,
  appendAppointment, updateAppointment,
  cancelAppointment, hardDeleteAppointment, checkConflict,
  appendMissedCapture, appendCallLog,
  getAllActivities, appendActivity, getStats,
  getAllPackages, getPackageById, savePackage, updatePackageData,
  getSession, saveSession, deleteSession, deleteExpiredSessions,
  getAllClinics, createClinic
};
