const { parseDate, parseTime } = require('../utils/dateParser');

const SERVICES = [
  'Botox', 'Fillers', 'Profhilo', 'Thread Lifting', 'Endolift',
  'PRP', 'Mesotherapy', 'Exosomes', 'Stem Cell',
  'Frax Pro', 'Picoway', 'RedTouch', 'Chemical Peels',
  'Laser Hair Removal'
];

const SERVICE_KEYWORDS = {
  'laser': 'Laser Hair Removal',
  'hair removal': 'Laser Hair Removal',
  'botox': 'Botox',
  'filler': 'Fillers',
  'fillers': 'Fillers',
  'profhilo': 'Profhilo',
  'thread': 'Thread Lifting',
  'endolift': 'Endolift',
  'prp': 'PRP',
  'meso': 'Mesotherapy',
  'mesotherapy': 'Mesotherapy',
  'exosome': 'Exosomes',
  'stem cell': 'Stem Cell',
  'peel': 'Chemical Peels',
  'chemical': 'Chemical Peels',
  'frax': 'Frax Pro',
  'pico': 'Picoway',
  'redtouch': 'RedTouch',
  // Arabic keywords
  'إزالة الشعر': 'Laser Hair Removal',
  'ليزر': 'Laser Hair Removal',
  'بوتوكس': 'Botox',
  'فيلر': 'Fillers',
  'برو فيلو': 'Profhilo',
  'خيوط': 'Thread Lifting',
  'انديليفت': 'Endolift',
  'بلازما': 'PRP',
  'ميزو': 'Mesotherapy',
  'إكسوسومز': 'Exosomes',
  'خلايا جذعية': 'Stem Cell',
  'فراكس': 'Frax Pro',
  'بيكاواي': 'Picoway',
  'ريد تاتش': 'RedTouch',
  'تقشير': 'Chemical Peels'
};

function matchService(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  // exact match first
  for (const svc of SERVICES) {
    if (lower.includes(svc.toLowerCase())) return svc;
  }
  // keyword match
  for (const [kw, svc] of Object.entries(SERVICE_KEYWORDS)) {
    if (lower.includes(kw)) return svc;
  }
  return text; // return raw if no match
}

function extractPhone(text) {
  if (!text) return null;
  // international: +968XXXXXXXX, 00968XXXXXXXX, local: 9XXXXXXX
  const match = text.match(/(\+968|00968|968)?[\s-]?([79]\d{7})|(\+\d{7,15})/);
  if (match) return match[0].replace(/[\s-]/g, '');
  // any digit string 8+ digits
  const generic = text.match(/\d[\d\s-]{7,}\d/);
  return generic ? generic[0].replace(/[\s-]/g, '') : null;
}

function extractNameFromTranscript(messages) {
  const patterns = [
    /my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i,
    /I(?:'m| am) ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i,
    /(?:this is|it's|it is) ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i,
    /name(?:'s| is):?\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*)/i,
    /call me ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i
  ];
  for (const msg of messages) {
    for (const rx of patterns) {
      const m = msg.match(rx);
      if (m) return m[1].trim();
    }
  }
  return null;
}

function extractPhoneFromTranscript(messages) {
  for (const msg of messages) {
    const phone = extractPhone(msg);
    if (phone) return phone;
  }
  return null;
}

function extractDateFromTranscript(messages) {
  for (const msg of messages) {
    const d = parseDate(msg);
    if (d) return d;
  }
  return null;
}

function extractTimeFromTranscript(messages) {
  for (const msg of messages) {
    const t = parseTime(msg);
    if (t) return t;
  }
  return null;
}

function extractServiceFromTranscript(messages) {
  for (const msg of messages) {
    const svc = matchService(msg);
    if (svc && svc !== msg) return svc;
  }
  return null;
}

function getUserMessages(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter(t => t.role === 'user' || t.speaker === 'user')
    .map(t => t.message || t.text || t.content || '');
}

function getDataCollectionValue(dcResults, key) {
  if (!dcResults || !dcResults[key]) return null;
  const entry = dcResults[key];
  return entry.value || entry.collected_value || entry || null;
}

function extractFromWebhook(payload) {
  console.log('[EXTRACT] Processing ElevenLabs webhook payload...');

  // Navigate nested payload: { data: { ... } } or flat
  const data = payload.data || payload;
  const transcript = data.transcript || [];
  const analysis = data.analysis || {};
  const dcResults = analysis.data_collection_results || analysis.collected_data || {};
  const callDuration = data.metadata?.call_duration_secs || data.call_duration_secs || 0;

  const userMessages = getUserMessages(transcript);
  const fullTranscript = transcript.map(t => `${t.role || t.speaker}: ${t.message || t.text || t.content || ''}`).join('\n');

  console.log(`[EXTRACT] Transcript lines: ${transcript.length}, User messages: ${userMessages.length}`);

  // 1. Try structured data_collection_results first
  let name = getDataCollectionValue(dcResults, 'patient_full_name')
    || getDataCollectionValue(dcResults, 'full_name')
    || getDataCollectionValue(dcResults, 'name');

  let phone = getDataCollectionValue(dcResults, 'patient_phone')
    || getDataCollectionValue(dcResults, 'phone')
    || getDataCollectionValue(dcResults, 'phone_number');

  let date = getDataCollectionValue(dcResults, 'appointment_date')
    || getDataCollectionValue(dcResults, 'date');

  let time = getDataCollectionValue(dcResults, 'appointment_time')
    || getDataCollectionValue(dcResults, 'time');

  let service = getDataCollectionValue(dcResults, 'service_requested')
    || getDataCollectionValue(dcResults, 'service')
    || getDataCollectionValue(dcResults, 'treatment');

  // 2. Fall back to transcript parsing
  if (!name) name = extractNameFromTranscript(userMessages);
  if (!phone) phone = extractPhoneFromTranscript(userMessages);
  if (!date) date = extractDateFromTranscript(userMessages);
  if (!time) time = extractTimeFromTranscript(userMessages);
  if (!service) service = extractServiceFromTranscript(userMessages);

  // 3. Normalize extracted values
  if (date) date = parseDate(date) || date;
  if (time) time = parseTime(time) || time;
  if (service) service = matchService(service) || service;

  const extracted = { name, phone, date, time, service };

  const missing = [];
  if (!name) missing.push('patient_full_name');
  if (!phone) missing.push('patient_phone');
  if (!date) missing.push('appointment_date');
  if (!time) missing.push('appointment_time');
  if (!service) missing.push('service_requested');

  console.log(`[EXTRACT] Extracted: name=${name}, phone=${phone}, date=${date}, time=${time}, service=${service}`);
  if (missing.length) console.log(`[EXTRACT] Missing fields: ${missing.join(', ')}`);

  return {
    fields: extracted,
    missing,
    isComplete: missing.length === 0,
    callDuration,
    conversationId: data.conversation_id || null,
    fullTranscript
  };
}

module.exports = { extractFromWebhook, matchService, extractPhone };
