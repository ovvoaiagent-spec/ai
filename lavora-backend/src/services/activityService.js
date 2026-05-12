const { v4: uuidv4 } = require('uuid');
const db = require('./localDbService');

const ACTION_TYPES = {
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
  RESCHEDULED: 'RESCHEDULED',
  UPDATED: 'UPDATED',
  MISSED_CAPTURE: 'MISSED_CAPTURE',
  CALL_RECEIVED: 'CALL_RECEIVED'
};

async function addActivity({ actor, actionType, patientName = '', details = '', clinicId } = {}) {
  const entry = {
    id: uuidv4(),
    actor,
    actionType,
    patientName,
    details,
    timestamp: new Date().toISOString()
  };
  console.log(`[ACTIVITY] ${actor} | ${actionType} | ${patientName} | ${details}`);
  await db.appendActivity(entry, clinicId);
  return entry;
}

async function getActivities(limit = 50, clinicId) {
  try {
    const all = await db.getAllActivities(clinicId);
    return all.slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { addActivity, getActivities, ACTION_TYPES };
