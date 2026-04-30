const express = require('express');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const router = express.Router();

const { requireApiKey } = require('../middleware/auth');
const sheetsService = require('../services/sheetsService');
const calendarService = require('../services/calendarService');
const activityService = require('../services/activityService');
const { matchService } = require('../services/extractionService');
const { parseDate, parseTime } = require('../utils/dateParser');

// All CRM endpoints require API key
router.use(requireApiKey);

// ─── GET /api/appointments ────────────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    let appointments = await sheetsService.getAllAppointments();

    // Filters
    const { date, status, source } = req.query;
    if (date) appointments = appointments.filter(a => a.date === date);
    if (status) appointments = appointments.filter(a => a.status.toLowerCase() === status.toLowerCase());
    if (source) appointments = appointments.filter(a => a.source.toLowerCase() === source.toLowerCase());

    res.json({ count: appointments.length, appointments });
  } catch (err) {
    console.error('[API] GET /appointments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/appointments/today ─────────────────────────────────────────────
router.get('/appointments/today', async (req, res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const all = await sheetsService.getAllAppointments();
    const todayApts = all.filter(a => a.date === today && a.status !== 'Cancelled');
    res.json({ date: today, count: todayApts.length, appointments: todayApts });
  } catch (err) {
    console.error('[API] GET /appointments/today error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/appointments ───────────────────────────────────────────────────
router.post('/appointments', async (req, res) => {
  try {
    const { name, phone, service, doctor, date, time, notes } = req.body;

    const missing = [];
    if (!name) missing.push('name');
    if (!phone) missing.push('phone');
    if (!service) missing.push('service');
    if (!date) missing.push('date');
    if (!time) missing.push('time');
    if (missing.length) {
      return res.status(400).json({ error: 'Missing required fields', missing });
    }

    const normalizedDate = parseDate(date) || date;
    const normalizedTime = parseTime(time) || time;
    const normalizedService = matchService(service) || service;

    // Conflict check
    const conflict = await sheetsService.checkConflict(normalizedDate, normalizedTime, doctor);
    if (conflict) {
      return res.status(409).json({
        error: 'Conflict: the requested date/time slot is already booked',
        date: normalizedDate,
        time: normalizedTime
      });
    }

    const aptId = `APT-${Date.now()}`;
    const apt = {
      id: aptId,
      name,
      phone,
      service: normalizedService,
      doctor: doctor || '',
      date: normalizedDate,
      time: normalizedTime,
      status: 'Pending',
      source: 'Human',
      callDuration: '',
      notes: notes || '',
      timestamp: new Date().toISOString(),
      calendarEventId: ''
    };

    // Google Calendar
    let calendarEventId = '';
    try {
      const auth = await sheetsService.getAuth();
      calendarEventId = await calendarService.createEvent(apt, 'Human', auth);
      apt.calendarEventId = calendarEventId;
    } catch (calErr) {
      console.error('[API] Calendar error (non-fatal):', calErr.message);
    }

    await sheetsService.appendAppointment(apt);

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.BOOKED,
      patientName: name,
      details: `${normalizedService} on ${normalizedDate} at ${normalizedTime} | ID: ${aptId}`
    });

    console.log(`[API] ✅ Manual appointment created: ${aptId}`);
    res.status(201).json({ success: true, appointment: apt });

  } catch (err) {
    console.error('[API] POST /appointments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/appointments/:id ────────────────────────────────────────────────
router.put('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, service, doctor, date, time, status, notes } = req.body;

    const existing = await sheetsService.getAppointmentById(id);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (service !== undefined) updates.service = matchService(service) || service;
    if (doctor !== undefined) updates.doctor = doctor;
    if (date !== undefined) updates.date = parseDate(date) || date;
    if (time !== undefined) updates.time = parseTime(time) || time;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    // Check for reschedule conflict
    const newDate = updates.date || existing.date;
    const newTime = updates.time || existing.time;
    if (updates.date || updates.time) {
      const others = (await sheetsService.getAllAppointments())
        .filter(a => a.id !== id && a.status !== 'Cancelled');
      const conflict = others.some(a => a.date === newDate && a.time === newTime);
      if (conflict) {
        return res.status(409).json({
          error: 'Conflict: the new date/time slot is already booked',
          date: newDate, time: newTime
        });
      }
    }

    const updated = await sheetsService.updateAppointment(id, updates);

    // Update Calendar event
    if (existing.calendarEventId) {
      try {
        const auth = await sheetsService.getAuth();
        const merged = { ...existing, ...updates };
        await calendarService.updateEvent(existing.calendarEventId, merged, auth);
      } catch (calErr) {
        console.error('[API] Calendar update error (non-fatal):', calErr.message);
      }
    }

    const isReschedule = updates.date || updates.time;
    await activityService.addActivity({
      actor: 'Human',
      actionType: isReschedule
        ? activityService.ACTION_TYPES.RESCHEDULED
        : activityService.ACTION_TYPES.UPDATED,
      patientName: updated.name,
      details: `ID: ${id} | Changes: ${Object.keys(updates).join(', ')}`
    });

    res.json({ success: true, appointment: updated });

  } catch (err) {
    console.error('[API] PUT /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/appointments/:id ─────────────────────────────────────────────
router.delete('/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await sheetsService.getAppointmentById(id);
    if (!existing) return res.status(404).json({ error: `Appointment ${id} not found` });

    await sheetsService.cancelAppointment(id);

    // Delete Calendar event
    if (existing.calendarEventId) {
      try {
        const auth = await sheetsService.getAuth();
        await calendarService.deleteEvent(existing.calendarEventId, auth);
      } catch (calErr) {
        console.error('[API] Calendar delete error (non-fatal):', calErr.message);
      }
    }

    await activityService.addActivity({
      actor: 'Human',
      actionType: activityService.ACTION_TYPES.CANCELLED,
      patientName: existing.name,
      details: `ID: ${id} | Service: ${existing.service} | Date: ${existing.date} ${existing.time}`
    });

    res.json({ success: true, message: `Appointment ${id} cancelled` });

  } catch (err) {
    console.error('[API] DELETE /appointments/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/activity ────────────────────────────────────────────────────────
router.get('/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ activities: activityService.getActivities(limit) });
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const all = await sheetsService.getAllAppointments();
    const today = dayjs().format('YYYY-MM-DD');

    const todayApts = all.filter(a => a.date === today);
    const stats = {
      today_total: todayApts.length,
      ai_booked: all.filter(a => a.source === 'AI Voice').length,
      human_booked: all.filter(a => a.source === 'Human').length,
      pending: all.filter(a => a.status === 'Pending').length,
      confirmed: all.filter(a => a.status === 'Confirmed').length,
      cancelled: all.filter(a => a.status === 'Cancelled').length,
      total: all.length
    };

    res.json(stats);
  } catch (err) {
    console.error('[API] GET /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
