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

let sheetsService = null;

function init(sheets) {
  sheetsService = sheets;
}

async function addActivity({ actor, actionType, patientName = '', details = '' }) {
  const entry = {
    id: uuidv4(),
    actor,
    actionType,
    patientName,
    details,
    timestamp: new Date().toISOString()
  };

  console.log(`[ACTIVITY] ${actor} | ${actionType} | ${patientName} | ${details}`);

  if (sheetsService) {
    try {
      await sheetsService.appendActivity(entry);
    } catch (err) {
      console.error('[ACTIVITY] Failed to sync:', err.message);
    }
  } else {
    db.appendActivity(entry);
  }

  return entry;
}

function getActivities(limit = 50) {
  try {
    return db.getAllActivities().slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { init, addActivity, getActivities, ACTION_TYPES };
