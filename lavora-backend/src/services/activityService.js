const { v4: uuidv4 } = require('uuid');

const ACTION_TYPES = {
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
  RESCHEDULED: 'RESCHEDULED',
  UPDATED: 'UPDATED',
  MISSED_CAPTURE: 'MISSED_CAPTURE',
  CALL_RECEIVED: 'CALL_RECEIVED'
};

// In-memory ring buffer (last 100 entries)
const LOG = [];
const MAX_LOG = 100;

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

  LOG.unshift(entry);
  if (LOG.length > MAX_LOG) LOG.pop();

  console.log(`[ACTIVITY] ${actor} | ${actionType} | ${patientName} | ${details}`);

  if (sheetsService) {
    try {
      await sheetsService.appendActivity(entry);
    } catch (err) {
      console.error('[ACTIVITY] Failed to sync to Sheets:', err.message);
    }
  }

  return entry;
}

function getActivities(limit = 50) {
  return LOG.slice(0, limit);
}

module.exports = { init, addActivity, getActivities, ACTION_TYPES };
