const crypto = require('crypto');

const sessions = new Map(); // token → { name, role, department, expires }

function create(nurse) {
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, {
    name:       nurse.name,
    role:       nurse.role       || '',
    department: nurse.department || '',
    expires:    Date.now() + 12 * 3600 * 1000  // 12-hour session
  });
  return token;
}

function validate(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

module.exports = { create, validate };
