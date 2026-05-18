const fs   = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');

const DEFAULTS = {
  clinic: {
    name:      'Test Clinic',
    nameAr:    'عيادة تيست',
    address:   'Al Ghubrah, Muscat',
    addressAr: 'الغبرة، مسقط',
    phone:     ''
  },
  hours: {
    open:       '08:00',
    close:      '23:00',
    restStart:  '14:00',
    restEnd:    '15:00'
  },
  workDays: ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday'],
  holidays: [],
  doctors: [
    { name: 'Dr. Soraya',  specialty: 'Dermatology & Cosmetic Specialist',        department: 'beauty' },
    { name: 'Dr. Neda',    specialty: 'Dermatology & Cosmetic Specialist',        department: 'beauty' },
    { name: 'Dr. Leila',   specialty: 'Gynecology Specialist',                    department: 'gynecology' },
    { name: 'Dr. Hussein', specialty: 'Dermatology, Cosmetic & Laser Specialist', department: 'beauty' },
    { name: 'Dr. Amani',   specialty: 'Dermatology & Cosmetic Specialist',        department: 'beauty' }
  ],
  services: [
    { name: 'Botox',              department: 'beauty', priceOMR: 80  },
    { name: 'Fillers',            department: 'beauty', priceOMR: 120 },
    { name: 'Profhilo',           department: 'beauty', priceOMR: 150 },
    { name: 'Thread Lifting',     department: 'beauty', priceOMR: 200 },
    { name: 'Endolift',           department: 'beauty', priceOMR: 300 },
    { name: 'PRP',                department: 'beauty', priceOMR: 100 },
    { name: 'Mesotherapy',        department: 'beauty', priceOMR: 80  },
    { name: 'Exosomes',           department: 'beauty', priceOMR: 150 },
    { name: 'Stem Cell',          department: 'beauty', priceOMR: 400 },
    { name: 'Frax Pro',           department: 'beauty', priceOMR: 200 },
    { name: 'Picoway',            department: 'beauty', priceOMR: 180 },
    { name: 'RedTouch',           department: 'beauty', priceOMR: 200 },
    { name: 'Chemical Peels',     department: 'beauty', priceOMR: 60  },
    { name: 'Laser Hair Removal', department: 'laser',  priceOMR: 80  }
  ],
  staff: [
    { name: 'Sara',   role: 'Laser Technician',    department: 'laser'      },
    { name: 'Huda',   role: 'Laser Technician',    department: 'laser'      },
    { name: 'Maryam', role: 'Beauty Nurse',         department: 'beauty'     },
    { name: 'Fatima', role: 'Beauty Nurse',         department: 'beauty'     },
    { name: 'Noura',  role: 'Slimming Specialist',  department: 'slimming'   },
    { name: 'Layla',  role: 'Gynecology Nurse',     department: 'gynecology' }
  ],
  departmentCapacity: { beauty: 1, slimming: 4, laser: 3, gynecology: 1 },
  departmentCloseHour: { beauty: 20, slimming: 20, laser: 23, gynecology: 20 }
};

let _cache = null;

function getSettings() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    _cache = deepMerge(DEFAULTS, raw);
  } catch {
    _cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return _cache;
}

function saveSettings(data) {
  _cache = null;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  _cache = data;
  return data;
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (Array.isArray(override[key])) {
      result[key] = override[key];
    } else if (override[key] && typeof override[key] === 'object') {
      result[key] = deepMerge(base[key] || {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
