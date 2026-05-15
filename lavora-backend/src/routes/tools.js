/**
 * Real-time tool endpoints — called by the ElevenLabs agent MID-CONVERSATION.
 */

const express = require('express');
const router = express.Router();

const db             = require('../services/localDbService');
const googleSync     = require('../services/googleSync');
const activityService = require('../services/activityService');
const sms            = require('../services/notificationService');
const laserPkgSvc    = require('../services/laserPackageService');
const log            = require('../services/logger').child('TOOL');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService } = require('../services/extractionService');
const { getSettings } = require('../services/settingsService');

const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function isDayClosed(dateStr) {
  const s = getSettings();
  if (s.holidays && s.holidays.includes(dateStr)) return true;
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return !(s.workDays || []).includes(DOW_NAMES[dow]);
}

function isLaserService(service) {
  const s = (service || '').toLowerCase();
  return ['laser hair removal', 'laser hair', 'full body laser', 'partial laser'].some(k => s.includes(k));
}

function normalizePhone(raw) {
  if (!raw) return raw;
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('0') && !p.startsWith('00')) p = '+968' + p.slice(1);
  if (/^\d{8}$/.test(p)) p = '+968' + p;
  return p;
}

function verifyToolSecret(req, res) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true;
  const incoming = req.headers['x-tool-secret'] || req.headers['xi-api-key'];
  if (incoming !== secret) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

async function findActiveAppointment(phone) {
  const normalized = normalizePhone(phone);
  const all = await db.getAllAppointments();
  const matches = all.filter(a =>
    a.status !== 'Cancelled' &&
    (normalizePhone(a.phone) === normalized || a.phone === phone)
  );
  matches.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return matches[matches.length - 1] || null;
}

// ─── check_availability ───────────────────────────────────────────────────────
router.post('/check-availability', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  const { date, time } = req.body;
  if (!date || !time) return res.json({ result: 'I need both a date and a time to check availability.' });

  const normalizedDate = parseDate(date) || date;
  const normalizedTime = parseTime(time) || time;
  log.info(`check_availability → ${normalizedDate} ${normalizedTime}`);

  try {
    if (isDayClosed(normalizedDate)) {
      return res.json({ result: `The clinic is closed on that day. Please suggest a different date.`, available: false });
    }
    const conflict = await db.checkConflict(normalizedDate, normalizedTime);
    if (conflict) {
      res.json({ result: `That slot on ${normalizedDate} at ${normalizedTime} is already booked. Please suggest a different date or time.`, available: false });
    } else {
      res.json({ result: `The slot on ${normalizedDate} at ${normalizedTime} is available.`, available: true, date: normalizedDate, time: normalizedTime });
    }
  } catch (err) {
    log.error(`check_availability error: ${err.message}`);
    res.json({ result: 'Unable to check availability right now. Please proceed and the team will confirm.' });
  }
});

// ─── book_appointment ─────────────────────────────────────────────────────────
router.post('/book-appointment', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  const { name, phone, date, time, service } = req.body;

  const missing = [];
  if (!name)    missing.push('full name');
  if (!phone)   missing.push('phone number');
  if (!date)    missing.push('date');
  if (!time)    missing.push('time');
  if (!service) missing.push('service');
  if (missing.length) return res.json({ result: `I still need: ${missing.join(', ')}.` });

  const normalizedDate    = parseDate(date) || date;
  const normalizedTime    = parseTime(time) || time;
  const normalizedService = matchService(service) || service;
  const normalizedPhone   = normalizePhone(phone);

  log.info(`book_appointment → ${name} | ${normalizedService} | ${normalizedDate} ${normalizedTime}`);

  try {
    if (isDayClosed(normalizedDate)) {
      return res.json({ result: 'The clinic is closed on that day. Please ask for a different date.', success: false });
    }
    if (await db.checkConflict(normalizedDate, normalizedTime)) {
      return res.json({ result: 'That slot is no longer available. Please suggest a different time.', success: false });
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId, name, phone: normalizedPhone,
      service: normalizedService, doctor: '',
      date: normalizedDate, time: normalizedTime,
      status: 'Confirmed', source: 'AI Voice',
      callDuration: '', notes: '',
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    await db.appendAppointment(apt);
    googleSync.book(apt);
    sms.sendBookingConfirmation(apt);

    await activityService.addActivity({
      actor: 'AI Voice', actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | ID: ${aptId}`
    });

    // Laser package offer — send WhatsApp message after voice call books laser
    if (isLaserService(normalizedService)) {
      try {
        const pkg = await laserPkgSvc.createPackageOffer({
          phone: normalizedPhone, name, service: normalizedService,
          language: 'ar', aptId, date: normalizedDate, time: normalizedTime
        });
        const { buildPkgSelectionMsg } = laserPkgSvc;
        const msg = buildPkgSelectionMsg(pkg, true);
        await sms.sendMessage(normalizedPhone, msg);
        log.info(`Laser package offer sent to ${normalizedPhone}`);
      } catch (e) {
        log.warn(`Laser package offer failed: ${e.message}`);
      }
    }

    log.info(`Booked: ${aptId}`);
    res.json({ result: 'Booking saved successfully.', success: true, appointment_id: aptId, date: normalizedDate, time: normalizedTime, service: normalizedService });

  } catch (err) {
    log.error(`book_appointment error: ${err.message}`);
    res.json({ result: 'Technical issue saving the appointment. Our team will confirm within the hour.', success: false });
  }
});

// ─── find_appointment ─────────────────────────────────────────────────────────
router.post('/find-appointment', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  const { phone } = req.body;
  if (!phone) return res.json({ result: 'I need a phone number to look up the appointment.', found: false });

  log.info(`find_appointment → ${phone}`);
  try {
    const apt = await findActiveAppointment(phone);
    if (!apt) return res.json({ result: 'I could not find any upcoming appointment for this number.', found: false });
    res.json({ result: `I found your ${apt.service} appointment on ${apt.date} at ${apt.time}.`, found: true, appointment_id: apt.id, name: apt.name, service: apt.service, date: apt.date, time: apt.time, phone: apt.phone, status: apt.status });
  } catch (err) {
    log.error(`find_appointment error: ${err.message}`);
    res.json({ result: 'Unable to look up the appointment right now.', found: false });
  }
});

// ─── cancel_appointment ───────────────────────────────────────────────────────
router.post('/cancel-appointment', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  const { appointment_id, phone } = req.body;
  log.info(`cancel_appointment → id=${appointment_id}, phone=${phone}`);

  try {
    const apt = appointment_id
      ? await db.getAppointmentById(appointment_id)
      : await findActiveAppointment(phone);

    if (!apt) return res.json({ result: 'Could not find that appointment to cancel.', success: false });

    await db.cancelAppointment(apt.id);
    googleSync.cancel(apt);
    sms.sendCancellationConfirmation(apt);   // SMS to patient

    await activityService.addActivity({
      actor: 'AI Voice', actionType: activityService.ACTION_TYPES.CANCELLED,
      patientName: apt.name,
      details: `${apt.service} on ${apt.date} at ${apt.time} | Cancelled via voice | ID: ${apt.id}`
    });

    log.info(`Cancelled: ${apt.id}`);
    res.json({ result: 'Appointment cancelled successfully.', success: true, service: apt.service, date: apt.date, time: apt.time });

  } catch (err) {
    log.error(`cancel_appointment error: ${err.message}`);
    res.json({ result: 'Technical issue cancelling. Our team will follow up.', success: false });
  }
});

// ─── reschedule_appointment ───────────────────────────────────────────────────
router.post('/reschedule-appointment', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  const { appointment_id, phone, new_date, new_time } = req.body;
  if (!new_date || !new_time) return res.json({ result: 'I need a new date and time to reschedule.', success: false });

  const normalizedDate = parseDate(new_date) || new_date;
  const normalizedTime = parseTime(new_time) || new_time;
  log.info(`reschedule_appointment → new=${normalizedDate} ${normalizedTime}`);

  try {
    const apt = appointment_id
      ? await db.getAppointmentById(appointment_id)
      : await findActiveAppointment(phone);

    if (!apt) return res.json({ result: 'Could not find that appointment to reschedule.', success: false });

    if (isDayClosed(normalizedDate)) {
      return res.json({ result: 'The clinic is closed on that day. Please ask for a different date.', success: false });
    }
    if (await db.checkConflict(normalizedDate, normalizedTime)) {
      return res.json({ result: `The slot on ${normalizedDate} at ${normalizedTime} is already booked. Please suggest a different time.`, success: false, available: false });
    }

    // Cancel old appointment, create new one so both appear in history
    await db.cancelAppointment(apt.id);
    googleSync.cancel(apt);

    const newAptId = `APT-${Date.now()}`;
    const newApt = {
      ...apt,
      id: newAptId,
      date: normalizedDate,
      time: normalizedTime,
      status: 'Confirmed',
      notes: (apt.notes ? apt.notes + ' | ' : '') + `Rescheduled from ${apt.date} ${apt.time}`,
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };
    await db.appendAppointment(newApt);
    googleSync.book(newApt);
    sms.sendRescheduleConfirmation(newApt);

    await activityService.addActivity({
      actor: 'AI Voice', actionType: activityService.ACTION_TYPES.RESCHEDULED,
      patientName: apt.name,
      details: `${apt.service} rescheduled ${apt.date} ${apt.time} → ${normalizedDate} ${normalizedTime} | Old: ${apt.id} New: ${newAptId}`
    });

    log.info(`Rescheduled: ${apt.id} → ${newAptId}`);
    res.json({ result: 'Appointment rescheduled successfully.', success: true, service: apt.service, date: normalizedDate, time: normalizedTime, phone: apt.phone, new_appointment_id: newAptId });

  } catch (err) {
    log.error(`reschedule_appointment error: ${err.message}`);
    res.json({ result: 'Technical issue rescheduling. Our team will follow up.', success: false });
  }
});

// ─── get_services ─────────────────────────────────────────────────────────────
router.post('/get-services', (_req, res) => {
  const s = getSettings();
  const services = (s.services || []).map(sv => sv.name);
  res.json({ result: `Here are the available services at ${s.clinic?.name || 'Test Clinic'}.`, services });
});

// ─── get_working_hours ────────────────────────────────────────────────────────
router.post('/get-working-hours', (_req, res) => {
  const s   = getSettings();
  const wds = (s.workDays || []).join(', ');
  const h   = s.hours || {};
  res.json({
    result: `${s.clinic?.name || 'Test Clinic'} is open ${wds}, ${h.open || '08:00'} to ${h.close || '23:00'} (rest break ${h.restStart || '14:00'}–${h.restEnd || '15:00'}, no appointments during this time).`,
    hours: `${wds}: ${h.open || '08:00'} – ${h.close || '23:00'}`,
    rest_break: `${h.restStart || '14:00'} – ${h.restEnd || '15:00'}`,
    closed_days: 'Days not listed in workDays'
  });
});

module.exports = router;
