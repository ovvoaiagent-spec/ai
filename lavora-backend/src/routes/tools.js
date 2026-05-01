/**
 * Real-time tool endpoints — called by the ElevenLabs agent MID-CONVERSATION.
 * The agent uses these to check availability and confirm bookings live,
 * before the call ends, so the patient gets an immediate confirmation.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const sheetsService = require('../services/sheetsService');
const calendarService = require('../services/calendarService');
const activityService = require('../services/activityService');
const { parseDate, parseTime } = require('../utils/dateParser');
const { matchService } = require('../services/extractionService');

// Lightweight auth — ElevenLabs sends the secret we configure in agent tools
function verifyToolSecret(req, res) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured
  const incoming = req.headers['x-tool-secret'] || req.headers['xi-api-key'];
  if (incoming !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── Tool: check_availability ─────────────────────────────────────────────────
// Agent calls this before confirming a slot with the patient.
router.post('/check-availability', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;

  const { date, time } = req.body;
  if (!date || !time) {
    return res.json({ result: 'I need both a date and a time to check availability.' });
  }

  const normalizedDate = parseDate(date) || date;
  const normalizedTime = parseTime(time) || time;

  console.log(`[TOOL] check_availability → date=${normalizedDate}, time=${normalizedTime}`);

  try {
    const conflict = await sheetsService.checkConflict(normalizedDate, normalizedTime);
    if (conflict) {
      res.json({
        result: `That slot on ${normalizedDate} at ${normalizedTime} is already booked. Please suggest a different date or time to the patient.`,
        available: false
      });
    } else {
      res.json({
        result: `The slot on ${normalizedDate} at ${normalizedTime} is available. You can proceed to confirm the booking.`,
        available: true,
        date: normalizedDate,
        time: normalizedTime
      });
    }
  } catch (err) {
    console.error('[TOOL] check_availability error:', err.message);
    res.json({ result: 'I was unable to check availability right now. Please proceed with the booking and the team will confirm.' });
  }
});

// ─── Tool: book_appointment ───────────────────────────────────────────────────
// Agent calls this once it has all 5 fields confirmed by the patient.
// Writes to Google Sheets AND creates a Google Calendar event immediately.
router.post('/book-appointment', async (req, res) => {
  if (!verifyToolSecret(req, res)) return;

  const { name, phone, date, time, service } = req.body;

  const missing = [];
  if (!name) missing.push('full name');
  if (!phone) missing.push('phone number');
  if (!date) missing.push('appointment date');
  if (!time) missing.push('appointment time');
  if (!service) missing.push('service');

  if (missing.length) {
    return res.json({
      result: `I still need the following information before I can book: ${missing.join(', ')}. Please ask the patient for these details.`
    });
  }

  const normalizedDate = parseDate(date) || date;
  const normalizedTime = parseTime(time) || time;
  const normalizedService = matchService(service) || service;

  console.log(`[TOOL] book_appointment → ${name} | ${normalizedService} | ${normalizedDate} ${normalizedTime}`);

  try {
    // Final conflict check
    const conflict = await sheetsService.checkConflict(normalizedDate, normalizedTime);
    if (conflict) {
      return res.json({
        result: `That slot is no longer available. Please inform the patient and suggest a different time.`,
        success: false
      });
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId,
      name,
      phone,
      service: normalizedService,
      doctor: '',
      date: normalizedDate,
      time: normalizedTime,
      status: 'Confirmed',
      source: 'AI Voice',
      callDuration: '',
      notes: 'Booked live during call via AI tool',
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    // Create Google Calendar event immediately
    let calendarEventId = '';
    try {
      const auth = await sheetsService.getAuth();
      calendarEventId = await calendarService.createEvent(apt, 'AI Voice', auth);
      apt.calendarEventId = calendarEventId;
      console.log(`[TOOL] ✅ Calendar event created: ${calendarEventId}`);
    } catch (calErr) {
      console.error('[TOOL] Calendar error (non-fatal):', calErr.message);
    }

    // Write to Google Sheets
    await sheetsService.appendAppointment(apt);
    console.log(`[TOOL] ✅ Appointment written to Sheets: ${aptId}`);

    await activityService.addActivity({
      actor: 'AI Voice',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | Live tool booking | ID: ${aptId}`
    });

    res.json({
      result: `Booking saved successfully.`,
      success: true,
      appointment_id: aptId,
      date: normalizedDate,
      time: normalizedTime,
      service: normalizedService
    });

  } catch (err) {
    console.error('[TOOL] book_appointment error:', err.message);
    res.json({
      result: 'There was a technical issue saving the appointment. Please tell the patient: "I have noted your request and our team will confirm within the hour." Then end the call politely.',
      success: false,
      error: err.message
    });
  }
});

// ─── Tool: get_services ───────────────────────────────────────────────────────
// Agent can call this to list available services if the patient is unsure.
router.post('/get-services', (_req, res) => {
  res.json({
    result: 'Here are the available services at Lavora Clinic.',
    services: [
      'Botox', 'Fillers', 'Profhilo', 'Thread Lifting', 'Endolift',
      'PRP', 'Mesotherapy', 'Exosomes', 'Stem Cell',
      'Frax Pro', 'Picoway', 'RedTouch', 'Chemical Peels',
      'Laser Hair Removal', 'Onda Plus', 'Redustim', 'Body Wraps',
      'Aesthetic Gynecology', 'Vaginoplasty', 'Labiaplasty',
      'Medical Skin Care', 'Dermatology', 'Consultation'
    ]
  });
});

// ─── Tool: get_working_hours ──────────────────────────────────────────────────
router.post('/get-working-hours', (_req, res) => {
  res.json({
    result: 'Lavora Clinic is open Saturday through Thursday, 9:00 AM to 6:00 PM. The clinic is closed on Fridays.',
    hours: 'Saturday–Thursday: 9:00 AM – 6:00 PM',
    closed: 'Friday'
  });
});

module.exports = router;
