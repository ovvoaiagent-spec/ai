/**
 * Zod-based input validation middleware.
 *
 * Usage:
 *   router.post('/appointments', validate(schemas.appointment), handler)
 *
 * On failure: 400 JSON with { error: 'Validation failed', issues: [...] }
 * On success: req.validated is set to the parsed+coerced data, then next() called.
 *
 * Zod is loaded with a try/catch so the server still starts if it's somehow
 * missing (e.g. npm install hasn't run yet on a fresh clone).
 */

let z;
try { z = require('zod').z || require('zod'); } catch {
  // Fallback: no-op middleware when zod not installed
  z = null;
}

// ─── Schema definitions ───────────────────────────────────────────────────────
function buildSchemas() {
  if (!z) return {};

  const phone = z.string()
    .min(7, 'Phone too short')
    .max(20, 'Phone too long')
    .regex(/^[\d\s\-+().]+$/, 'Invalid phone number format');

  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
  const hhmm    = z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM');

  return {
    // POST /api/appointments
    appointment: z.object({
      name:    z.string().min(2).max(100),
      phone,
      service: z.string().min(2).max(100),
      doctor:  z.string().max(100).optional().default(''),
      staff:   z.string().max(100).optional().default(''),
      date:    isoDate,
      time:    hhmm,
      notes:   z.string().max(1000).optional().default('')
    }),

    // PUT /api/appointments/:id
    appointmentUpdate: z.object({
      name:    z.string().min(2).max(100).optional(),
      phone:   phone.optional(),
      service: z.string().min(2).max(100).optional(),
      doctor:  z.string().max(100).optional(),
      staff:   z.string().max(100).optional(),
      date:    isoDate.optional(),
      time:    hhmm.optional(),
      status:  z.enum(['Pending', 'Confirmed', 'Cancelled']).optional(),
      notes:   z.string().max(1000).optional()
    }),

    // POST /api/nurse-login
    nurseLogin: z.object({
      name:  z.string().min(2).max(100),
      phone: phone
    }),

    // GET /api/appointments query params
    appointmentQuery: z.object({
      date:   isoDate.optional(),
      status: z.enum(['Pending', 'Confirmed', 'Cancelled']).optional(),
      source: z.string().max(50).optional(),
    })
  };
}

const schemas = buildSchemas();

// ─── Middleware factory ───────────────────────────────────────────────────────
function validate(schema, source = 'body') {
  return (req, res, next) => {
    if (!z || !schema) {
      // Zod not available — pass through (non-breaking fallback)
      req.validated = source === 'query' ? req.query : req.body;
      return next();
    }

    const input = source === 'query' ? req.query : req.body;
    const result = schema.safeParse(input);

    if (!result.success) {
      const issues = result.error.issues.map(i => ({
        field: i.path.join('.'),
        message: i.message
      }));
      return res.status(400).json({ error: 'Validation failed', issues });
    }

    req.validated = result.data;
    next();
  };
}

module.exports = { validate, schemas };
