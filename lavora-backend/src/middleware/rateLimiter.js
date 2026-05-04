const rateLimit = require('express-rate-limit');

// Tool endpoints called by ElevenLabs mid-call — allow bursts but block abuse
const toolsLimiter = rateLimit({
  windowMs: 60_000,          // 1 minute
  max: 60,                   // 60 calls/min per IP (a single call makes ~5 tool calls)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// API endpoints used by the CRM dashboard
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Webhook endpoints — Twilio/ElevenLabs post here, be generous
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' }
});

module.exports = { toolsLimiter, apiLimiter, webhookLimiter };
