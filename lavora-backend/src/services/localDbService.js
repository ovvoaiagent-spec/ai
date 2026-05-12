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

// ── Init: create tables on startup ───────────────────────────────────────────
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS missed_captures (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS call_log (
      id         SERIAL PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id         SERIAL PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS laser_packages (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ── Appointments ──────────────────────────────────────────────────────────────
async function getAllAppointments() {
  if (pool) {
    const res = await pool.query('SELECT data FROM appointments ORDER BY created_at ASC');
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.appointments);
}

async function getAppointmentById(id) {
  if (pool) {
    const res = await pool.query('SELECT data FROM appointments WHERE id = $1', [id]);
    return res.rows[0]?.data || null;
  }
  return readFile(FILES.appointments).find(a => a.id === id) || null;
}

async function appendAppointment(apt) {
  if (pool) {
    await pool.query(
      'INSERT INTO appointments (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      [apt.id, apt]
    );
  } else {
    const all = readFile(FILES.appointments);
    all.push(apt);
    writeFile(FILES.appointments, all);
  }
  console.log(`[DB] Appointment saved: ${apt.id}`);
}

async function updateAppointment(id, updates) {
  if (pool) {
    const res = await pool.query(
      `UPDATE appointments SET data = data || $1::jsonb WHERE id = $2 RETURNING data`,
      [JSON.stringify(updates), id]
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

async function cancelAppointment(id) {
  return updateAppointment(id, { status: 'Cancelled' });
}

async function hardDeleteAppointment(id) {
  if (pool) {
    await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
    return;
  }
  const all = readFile(FILES.appointments).filter(a => a.id !== id);
  writeFile(FILES.appointments, all);
}

async function checkConflict(date, time, doctor = null) {
  if (pool) {
    const doctorClause = doctor ? `AND data->>'doctor' = $3` : '';
    const params = doctor ? [date, time, doctor] : [date, time];
    const res = await pool.query(
      `SELECT 1 FROM appointments
       WHERE data->>'status' != 'Cancelled'
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
async function appendMissedCapture(missed) {
  if (pool) {
    await pool.query(
      'INSERT INTO missed_captures (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [missed.id, missed]
    );
    return;
  }
  const all = readFile(FILES.missed);
  all.push(missed);
  writeFile(FILES.missed, all);
}

// ── Call Log ──────────────────────────────────────────────────────────────────
async function appendCallLog(call) {
  if (pool) {
    await pool.query('INSERT INTO call_log (data) VALUES ($1)', [call]);
    return;
  }
  const all = readFile(FILES.callLog);
  all.push(call);
  writeFile(FILES.callLog, all);
}

// ── Activity Log ──────────────────────────────────────────────────────────────
async function getAllActivities() {
  if (pool) {
    const res = await pool.query(
      'SELECT data FROM activity_log ORDER BY created_at DESC LIMIT 200'
    );
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.activity);
}

async function appendActivity(entry) {
  if (pool) {
    await pool.query('INSERT INTO activity_log (data) VALUES ($1)', [entry]);
    return;
  }
  const all = readFile(FILES.activity);
  all.unshift(entry);
  if (all.length > 200) all.splice(200);
  writeFile(FILES.activity, all);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function getStats() {
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
    `, [today]);
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
async function getAllPackages() {
  if (pool) {
    const res = await pool.query('SELECT data FROM laser_packages ORDER BY created_at ASC');
    return res.rows.map(r => r.data);
  }
  return readFile(FILES.laserPackages);
}

async function getPackageById(id) {
  if (pool) {
    const res = await pool.query('SELECT data FROM laser_packages WHERE id = $1', [id]);
    return res.rows[0]?.data || null;
  }
  return readFile(FILES.laserPackages).find(p => p.id === id) || null;
}

async function savePackage(pkg) {
  if (pool) {
    await pool.query(
      'INSERT INTO laser_packages (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      [pkg.id, JSON.stringify(pkg)]
    );
  } else {
    const all = readFile(FILES.laserPackages);
    const idx = all.findIndex(p => p.id === pkg.id);
    if (idx === -1) all.push(pkg);
    else all[idx] = pkg;
    writeFile(FILES.laserPackages, all);
  }
}

async function updatePackageData(id, updates) {
  if (pool) {
    const res = await pool.query('SELECT data FROM laser_packages WHERE id = $1', [id]);
    if (!res.rows.length) throw new Error(`Package ${id} not found`);
    const updated = { ...res.rows[0].data, ...updates };
    await pool.query('UPDATE laser_packages SET data = $1 WHERE id = $2', [JSON.stringify(updated), id]);
    return updated;
  }
  const all = readFile(FILES.laserPackages);
  const idx = all.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Package ${id} not found`);
  all[idx] = { ...all[idx], ...updates };
  writeFile(FILES.laserPackages, all);
  return all[idx];
}

module.exports = {
  initDb,
  getAllAppointments, getAppointmentById,
  appendAppointment, updateAppointment,
  cancelAppointment, hardDeleteAppointment, checkConflict,
  appendMissedCapture, appendCallLog,
  getAllActivities, appendActivity, getStats,
  getAllPackages, getPackageById, savePackage, updatePackageData
};
