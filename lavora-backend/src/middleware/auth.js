const nurseSessionStore = require('../services/nurseSessionStore');

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key && key === process.env.CRM_SECRET_KEY) return next();

  const nurseToken = req.headers['x-nurse-token'];
  const session = nurseSessionStore.validate(nurseToken);
  if (session) {
    req.nurseSession = session;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
}

module.exports = { requireApiKey };
