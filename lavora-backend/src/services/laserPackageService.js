/**
 * Laser Hair Removal Package Service
 * Manages multi-session laser packages: creation, session booking, 24h follow-ups.
 *
 * Package lifecycle:
 *   offer_sent → active (client picks 3/6 sessions) → completed
 *                      ↓ (client picks 1 session)
 *                  cancelled
 *
 * pendingOffer is set on the package whenever we've sent slot options and are
 * waiting for the client to reply "1" or "2".
 */

const db = require('./localDbService');

function normPhone(p) {
  if (!p) return '';
  let s = String(p).replace(/[\s\-().+]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0') && s.length === 9) s = '968' + s.slice(1);
  if (/^\d{8}$/.test(s)) s = '968' + s;
  return s;
}

// Create a package record immediately after session 1 is booked.
// Status is 'offer_sent' until the client replies with their package choice.
async function createPackageOffer({ phone, name, service, language, aptId, date, time }) {
  const pkg = {
    id: `PKG-${Date.now()}`,
    clientName: name,
    phone: normPhone(phone),
    service,
    language: language || 'ar',
    type: null,
    status: 'offer_sent',
    createdAt: new Date().toISOString(),
    followUpSent: false,
    sessions: [{ num: 1, aptId, date, time, status: 'booked', reminderSent: false }],
    pendingOffer: null
  };
  await db.savePackage(pkg);
  return pkg;
}

// Returns the first active (offer_sent or active) package for this phone.
async function getPackageByPhone(phone) {
  const norm = normPhone(phone);
  const all = await db.getAllPackages();
  return all.find(p =>
    p.phone === norm &&
    (p.status === 'offer_sent' || p.status === 'active')
  ) || null;
}

async function getPackageById(id) {
  return db.getPackageById(id);
}

// Client selected package type (3 or 6 sessions). Transitions offer_sent → active.
async function confirmPackageSelection(pkgId, type) {
  return db.updatePackageData(pkgId, { type, status: 'active' });
}

// Client picked single session — no package.
async function cancelPackage(pkgId) {
  return db.updatePackageData(pkgId, { status: 'cancelled' });
}

// Add a booked session to the package. If all sessions are booked, mark completed.
async function addSession(pkgId, sessionNum, aptId, date, time) {
  const pkg = await db.getPackageById(pkgId);
  if (!pkg) throw new Error(`Package ${pkgId} not found`);
  const sessions = [...(pkg.sessions || [])];
  sessions.push({ num: sessionNum, aptId, date, time, status: 'booked', reminderSent: false });
  const allDone = sessions.length >= pkg.type;
  return db.updatePackageData(pkgId, {
    sessions,
    pendingOffer: null,
    status: allDone ? 'completed' : 'active'
  });
}

// Record the slot offer sent for the next session.
async function setPendingOffer(pkgId, sessionNum, slots) {
  return db.updatePackageData(pkgId, {
    pendingOffer: {
      sessionNum,
      slots,
      sentAt: new Date().toISOString(),
      followUpSent: false
    }
  });
}

async function clearPendingOffer(pkgId) {
  return db.updatePackageData(pkgId, { pendingOffer: null });
}

// Returns packages that need a 24h follow-up nudge (no reply after 24 hours).
async function getPendingFollowUps() {
  const all = await db.getAllPackages();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  return all.filter(p => {
    if (p.status === 'offer_sent' && !p.followUpSent) {
      return new Date(p.createdAt).getTime() < cutoff;
    }
    if (p.status === 'active' && p.pendingOffer && !p.pendingOffer.followUpSent) {
      return new Date(p.pendingOffer.sentAt).getTime() < cutoff;
    }
    return false;
  });
}

async function markFollowUpSent(pkgId) {
  const pkg = await db.getPackageById(pkgId);
  if (!pkg) return;
  if (pkg.status === 'offer_sent') {
    await db.updatePackageData(pkgId, { followUpSent: true });
  } else if (pkg.pendingOffer) {
    await db.updatePackageData(pkgId, {
      pendingOffer: { ...pkg.pendingOffer, followUpSent: true }
    });
  }
}

async function getAllPackages() {
  return db.getAllPackages();
}

module.exports = {
  createPackageOffer,
  getPackageByPhone,
  getPackageById,
  confirmPackageSelection,
  cancelPackage,
  addSession,
  setPendingOffer,
  clearPendingOffer,
  getPendingFollowUps,
  markFollowUpSent,
  getAllPackages
};
