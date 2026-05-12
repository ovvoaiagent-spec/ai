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

const db     = require('./localDbService');
const notify = require('./notificationService');
const log    = require('./logger').child('LASER-PKG');

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

// ─── Message builders (used by whatsapp.js and the follow-up job) ─────────────

function buildPkgSelectionMsg(pkg, isAr) {
  if (isAr) {
    return `🌟 موعدك الأول في ${pkg.service} مؤكد!\n\nهل تودين حجز باقة؟\n1 جلسة واحدة فقط\n2 باقة 3 جلسات\n3 باقة 6 جلسات\n\nاردّي بالرقم للاختيار.`;
  }
  return `🌟 Your first ${pkg.service} session is confirmed!\n\nWould you like a package?\n1 Single session only\n2 3-session package\n3 6-session package\n\nReply with a number to choose.`;
}

function buildNextSessionOffer(sessionNum, totalSessions, slots, isAr, prevDate) {
  if (isAr) {
    const lines = slots.map((s, i) => `${i + 1} ${s.date} — الساعة ${s.time}`).join('\n');
    return `✅ الجلسة ${sessionNum - 1} محجوزة!\n\nالجلسة ${sessionNum}/${totalSessions} — أوقات متاحة (28-30 يوم من ${prevDate}):\n\n${lines}\n\nاردّي بـ 1 أو 2 للتأكيد.`;
  }
  const lines = slots.map((s, i) => `${i + 1} ${s.date} at ${s.time}`).join('\n');
  return `✅ Session ${sessionNum - 1} confirmed!\n\nSession ${sessionNum}/${totalSessions} — available times (28–30 days from ${prevDate}):\n\n${lines}\n\nReply 1 or 2 to confirm.`;
}

function buildFinalSummary(pkg, isAr) {
  if (isAr) {
    const lines = pkg.sessions.map(s => `جلسة ${s.num}: ${s.date} — ${s.time}`).join('\n');
    return `🎉 جميع جلساتك محجوزة!\n\n${pkg.service} — باقة ${pkg.type} جلسات:\n${lines}\n\nسنرسل تذكيراً قبل 24 ساعة من كل جلسة. نتطلع لرؤيتك! 🌿`;
  }
  const lines = pkg.sessions.map(s => `Session ${s.num}: ${s.date} at ${s.time}`).join('\n');
  return `🎉 All sessions booked!\n\n${pkg.service} — ${pkg.type}-session package:\n${lines}\n\nYou'll get a reminder 24 hours before each session. See you soon! 🌿`;
}

// ─── 24-hour follow-up job handler ───────────────────────────────────────────
// Called by the job queue every hour. Finds packages with unanswered offers
// and sends a reminder. Safe to call multiple times — followUpSent flag prevents
// duplicate sends.
async function runFollowUpCheck() {
  const pending = await getPendingFollowUps();
  if (!pending.length) return;

  log.info(`[FOLLOW-UP] ${pending.length} package(s) need a follow-up`);

  for (const pkg of pending) {
    const isAr = (pkg.language || 'ar') !== 'en';
    let msg;

    if (pkg.status === 'offer_sent') {
      msg = buildPkgSelectionMsg(pkg, isAr);
    } else if (pkg.pendingOffer) {
      const prevSession = pkg.sessions[pkg.sessions.length - 1];
      msg = buildNextSessionOffer(
        pkg.pendingOffer.sessionNum,
        pkg.type,
        pkg.pendingOffer.slots,
        isAr,
        prevSession?.date || ''
      );
    }

    if (msg) {
      try {
        await notify.sendMessage(pkg.phone, msg);
        await markFollowUpSent(pkg.id);
        log.info(`[FOLLOW-UP] Sent to ${pkg.phone} (${pkg.id})`);
      } catch (e) {
        log.warn(`[FOLLOW-UP] Failed for ${pkg.id}: ${e.message}`);
      }
    }
  }
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
  getAllPackages,
  runFollowUpCheck,
  buildPkgSelectionMsg,
  buildNextSessionOffer,
  buildFinalSummary
};
