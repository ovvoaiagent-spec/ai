/**
 * Local JSON file database — primary storage.
 * Works immediately with no external credentials.
 * Google Sheets is an optional sync layer on top.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  appointments : path.join(DATA_DIR, 'appointments.json'),
  missed       : path.join(DATA_DIR, 'missed-captures.json'),
  callLog      : path.join(DATA_DIR, 'call-log.json'),
  activity     : path.join(DATA_DIR, 'activity-log.json')
};

// ── File helpers ─────────────────────────────────────────────────────────────
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Appointments ─────────────────────────────────────────────────────────────
function getAllAppointments() {
  return read(FILES.appointments);
}

function getAppointmentById(id) {
  return getAllAppointments().find(a => a.id === id) || null;
}

function appendAppointment(apt) {
  const all = getAllAppointments();
  all.push(apt);
  write(FILES.appointments, all);
  console.log(`[LOCAL DB] Appointment saved: ${apt.id}`);
}

function updateAppointment(id, updates) {
  const all = getAllAppointments();
  const idx = all.findIndex(a => a.id === id);
  if (idx === -1) throw new Error(`Appointment ${id} not found`);
  all[idx] = { ...all[idx], ...updates };
  write(FILES.appointments, all);
  console.log(`[LOCAL DB] Appointment updated: ${id}`);
  return all[idx];
}

function cancelAppointment(id) {
  return updateAppointment(id, { status: 'Cancelled' });
}

function checkConflict(date, time, doctor = null) {
  return getAllAppointments().some(apt => {
    if (apt.status === 'Cancelled') return false;
    const sameSlot = apt.date === date && apt.time === time;
    if (!doctor) return sameSlot;
    return sameSlot && apt.doctor === doctor;
  });
}

// ── Missed Captures ───────────────────────────────────────────────────────────
function appendMissedCapture(missed) {
  const all = read(FILES.missed);
  all.push(missed);
  write(FILES.missed, all);
}

// ── Call Log ──────────────────────────────────────────────────────────────────
function appendCallLog(call) {
  const all = read(FILES.callLog);
  all.push(call);
  write(FILES.callLog, all);
}

// ── Activity Log ──────────────────────────────────────────────────────────────
function getAllActivities() {
  return read(FILES.activity);
}

function appendActivity(entry) {
  const all = getAllActivities();
  all.unshift(entry);
  if (all.length > 200) all.splice(200);
  write(FILES.activity, all);
}

// ── Stats ────────────────────────────────────────────────────────────────────
function getStats() {
  const all = getAllAppointments();
  const today = new Date().toISOString().slice(0, 10);
  return {
    today_total: all.filter(a => a.date === today && a.status !== 'Cancelled').length,
    ai_booked  : all.filter(a => a.source === 'AI Voice').length,
    human_booked: all.filter(a => a.source === 'Human').length,
    pending    : all.filter(a => a.status === 'Pending').length,
    confirmed  : all.filter(a => a.status === 'Confirmed').length,
    cancelled  : all.filter(a => a.status === 'Cancelled').length,
    total      : all.length
  };
}

module.exports = {
  getAllAppointments, getAppointmentById,
  appendAppointment, updateAppointment,
  cancelAppointment, checkConflict,
  appendMissedCapture, appendCallLog,
  getAllActivities, appendActivity, getStats
};
