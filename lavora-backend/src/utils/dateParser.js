const chrono = require('chrono-node');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

// Returns today's date in Asia/Dubai as 'YYYY-MM-DD'.
// Uses Intl.DateTimeFormat so it works regardless of the server's TZ setting.
function dubaiTodayStr() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// Returns a Date whose getDate()/getMonth()/getFullYear() reflect Dubai's current calendar
// day on any server timezone. Noon UTC is used so the date is stable across all UTC-12..UTC+14.
function dubaiRefDate() {
  return new Date(dubaiTodayStr() + 'T12:00:00Z');
}

const WORD_TO_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  twenty: 20, thirty: 30, forty: 40, forty_five: 45
};

const PERIOD_MAP = {
  morning: 'AM', am: 'AM', 'a.m': 'AM',
  afternoon: 'PM', evening: 'PM', pm: 'PM', 'p.m': 'PM',
  night: 'PM', noon: 'noon'
};

function wordToNumber(word) {
  if (!word) return null;
  const n = parseInt(word);
  if (!isNaN(n)) return n;
  return WORD_TO_NUM[word.toLowerCase()] ?? null;
}

function parseTime(text) {
  if (!text) return null;
  const t = text.trim();

  // Already HH:MM
  if (/^\d{2}:\d{2}$/.test(t)) return t;

  // 10:30 am / 2:30 PM
  const colonMatch = t.match(/(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.?|p\.m\.?)?/i);
  if (colonMatch) {
    let h = parseInt(colonMatch[1]);
    const m = parseInt(colonMatch[2]);
    const p = (colonMatch[3] || '').toLowerCase().replace(/\./g, '');
    if (p === 'pm' && h < 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // 3pm / 10am
  const hourOnly = t.match(/^(\d{1,2})\s*(am|pm|a\.m\.?|p\.m\.?)$/i);
  if (hourOnly) {
    let h = parseInt(hourOnly[1]);
    const p = hourOnly[2].toLowerCase().replace(/\./g, '');
    if (p === 'pm' && h < 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
  }

  // Try chrono-node
  const parsed = chrono.parseDate(t, new Date(), { forwardDate: true });
  if (parsed) {
    return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
  }

  // Natural language: "ten thirty in the morning", "half past three afternoon"
  const lower = t.toLowerCase();

  let hours = null;
  let minutes = 0;
  let period = null;

  for (const [word, per] of Object.entries(PERIOD_MAP)) {
    if (lower.includes(word)) { period = per; break; }
  }
  if (lower.includes('noon')) { return '12:00'; }

  // "half past X"
  const halfPast = lower.match(/half\s+past\s+(\w+)/);
  if (halfPast) {
    hours = wordToNumber(halfPast[1]);
    minutes = 30;
  }

  // "quarter past X"
  const quarterPast = lower.match(/quarter\s+past\s+(\w+)/);
  if (quarterPast && hours === null) {
    hours = wordToNumber(quarterPast[1]);
    minutes = 15;
  }

  // "X thirty" / "X o'clock" / plain word
  if (hours === null) {
    const words = lower.replace(/[',]/g, '').split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const n = wordToNumber(words[i]);
      if (n !== null && n >= 1 && n <= 12) {
        hours = n;
        if (i + 1 < words.length) {
          const next = wordToNumber(words[i + 1]);
          if (next !== null && next < 60) minutes = next;
        }
        break;
      }
    }
  }

  if (hours !== null) {
    if (period === 'PM' && hours < 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  return null;
}

// Arabic day-name → English for chrono-node
const ARABIC_TO_EN = {
  'الأحد': 'Sunday',    'الاحد': 'Sunday',    'احد': 'Sunday',
  'الإثنين': 'Monday',  'الاثنين': 'Monday',  'اثنين': 'Monday',  'إثنين': 'Monday',
  'الثلاثاء': 'Tuesday','ثلاثاء': 'Tuesday',
  'الأربعاء': 'Wednesday','الاربعاء': 'Wednesday','أربعاء': 'Wednesday','اربعاء': 'Wednesday',
  'الخميس': 'Thursday', 'خميس': 'Thursday',
  'الجمعة': 'Friday',   'الجمعه': 'Friday',   'جمعة': 'Friday',   'جمعه': 'Friday',
  'السبت': 'Saturday',  'سبت': 'Saturday',
  'اليوم': 'today',     'النهار': 'today',
};

function parseDate(text) {
  if (!text) return null;
  let t = text.trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // Arabic "after tomorrow" → +2 days
  const dayAfterPattern = /\b(day\s+after\s+tomorrow|after\s+tomorrow)\b/i;
  const arabicDayAfter  = /بعد\s*بكرة|بعد\s*بكره|بعد\s*الغد|بعد\s*بكرا/;
  const needsPlus2 = dayAfterPattern.test(t) || arabicDayAfter.test(t);
  if (needsPlus2) {
    const base = new Date(dubaiTodayStr() + 'T12:00:00Z');
    base.setUTCDate(base.getUTCDate() + 2);
    return dayjs(base).format('YYYY-MM-DD');
  }

  // Arabic "tomorrow" → +1 day
  if (/^(بكرا|بكره|بكرة|بكره)$/.test(t)) {
    const base = new Date(dubaiTodayStr() + 'T12:00:00Z');
    base.setUTCDate(base.getUTCDate() + 1);
    return dayjs(base).format('YYYY-MM-DD');
  }

  // Translate Arabic day names / "today" to English for chrono-node
  for (const [ar, en] of Object.entries(ARABIC_TO_EN)) {
    if (t.includes(ar)) { t = t.replace(ar, en); break; }
  }

  // chrono-node handles most natural language dates — use Dubai time as reference
  const parsed = chrono.parseDate(t, dubaiRefDate(), { forwardDate: true });
  if (parsed) return dayjs(parsed).format('YYYY-MM-DD');

  // Manual month name fallback
  const MONTHS = {
    january: '01', jan: '01', february: '02', feb: '02',
    march: '03', mar: '03', april: '04', apr: '04',
    may: '05', june: '06', jun: '06', july: '07', jul: '07',
    august: '08', aug: '08', september: '09', sep: '09', sept: '09',
    october: '10', oct: '10', november: '11', nov: '11',
    december: '12', dec: '12'
  };

  const lower = t.toLowerCase();
  for (const [name, num] of Object.entries(MONTHS)) {
    const rx = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${name}|${name}\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i');
    const m = lower.match(rx);
    if (m) {
      const day = m[1] || m[2];
      const year = dubaiRefDate().getFullYear();
      return `${year}-${num}-${String(parseInt(day)).padStart(2, '0')}`;
    }
  }

  return null;
}

module.exports = { parseDate, parseTime, dubaiTodayStr };
