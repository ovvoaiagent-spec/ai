# Lavora Clinic — AI Voice Receptionist Backend

> Where Science, Beauty, and Longevity Meet

A production-ready backend that connects ElevenLabs Conversational AI + Twilio phone calls to Google Sheets, Google Calendar, and a CRM REST API — fully real-time, no double bookings.

---

## Architecture

```
Incoming Call (Twilio)
        │
        ▼
ElevenLabs AI Agent ──────────────────────────────────┐
  (collects 5 fields)                                  │
        │                                              │
        ▼ POST /webhook/elevenlabs                     │
  Extract Fields                                       │
  ├── name, phone, date, time, service                 │
  ├── Conflict check                                   │
  ├── → Google Sheets (Appointments tab)               │
  └── → Google Calendar (Sage green event)             │
                                                       │
Twilio POST /webhook/twilio/call-status                │
  └── → Google Sheets (Call Log tab)                   │
                                                       │
CRM Dashboard (polls every 30s) ◄──────────────────────┘
  GET /api/appointments
  GET /api/stats
  GET /api/activity
```

---

## Prerequisites

- Node.js 18+
- A Google Cloud project with Sheets API + Calendar API enabled
- A Google Service Account with credentials JSON
- ElevenLabs account with a Conversational AI agent
- Twilio account with a phone number connected to your ElevenLabs agent
- ngrok (for local testing)

---

## Step 1 — Google Service Account Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select existing)
3. Enable APIs:
   - **Google Sheets API**
   - **Google Calendar API**
4. Go to **IAM & Admin → Service Accounts** → Create a service account
5. Download the JSON key file
6. Place it at: `credentials/google-service-account.json`

### Share your Google Sheet with the service account

1. Create a new Google Sheet at [sheets.google.com](https://sheets.google.com)
2. Copy the Sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/**SHEET_ID**/edit`
3. Click **Share** → paste the service account email (found in the JSON file as `client_email`) → give **Editor** access

### Set up Sheet tabs

Create these 4 tabs in your Google Sheet (exact names matter):
- `Appointments`
- `Missed Captures`
- `Call Log`
- `Activity Log`

The server will auto-add headers on first startup.

### Share your Google Calendar with the service account

1. Open [calendar.google.com](https://calendar.google.com)
2. Click the three dots next to your calendar → **Settings and sharing**
3. Under **Share with specific people** → add the service account email → **Make changes to events**
4. Copy the Calendar ID from **Integrate calendar** section

---

## Step 2 — Environment Setup

```bash
cp .env.example .env
```

Fill in all values in `.env`:

```env
ELEVENLABS_API_KEY=your_key
ELEVENLABS_AGENT_ID=your_agent_id
ELEVENLABS_WEBHOOK_SECRET=your_webhook_secret

TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+968xxxxxxxx

GOOGLE_SERVICE_ACCOUNT_JSON_PATH=./credentials/google-service-account.json
GOOGLE_SHEETS_ID=your_sheet_id
GOOGLE_CALENDAR_ID=your_calendar_id@group.calendar.google.com

PORT=3000
CRM_SECRET_KEY=generate-a-long-random-string-here
```

---

## Step 3 — Install & Run

```bash
npm install
npm start
```

For development with auto-reload:
```bash
npm run dev
```

---

## Step 4 — Local Testing with ngrok

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Your public URL will look like: `https://abc123.ngrok.io`

---

## Step 5 — Connect ElevenLabs Webhook

1. Go to your ElevenLabs dashboard → your agent → **Webhooks**
2. Set webhook URL to:
   ```
   https://YOUR_NGROK_URL/webhook/elevenlabs
   ```
3. Copy the webhook secret and paste it into `.env` as `ELEVENLABS_WEBHOOK_SECRET`

### ElevenLabs Agent System Prompt

In your agent configuration, set this as the system prompt:

```
You are the AI voice receptionist for Lavora Clinic in Muscat, Oman.
Your name is Lavora Assistant. You are professional, warm, and refined —
reflecting a luxury medical aesthetic clinic.

Your ONLY goal during a booking call is to collect exactly these 5 pieces
of information, confirm them back to the caller, then end the call politely:
1. Full name
2. Phone number (confirm even if you already have it)
3. Preferred appointment date
4. Preferred appointment time (clinic hours: Sat–Thu, 9AM–6PM, closed Friday)
5. Which service or treatment they want

Do NOT give medical advice. If asked a medical question, say:
'That is a great question. Our specialists would be the best people to
advise you — shall I book you a consultation?'

When you have all 5 fields, read them back clearly and say:
'I have noted your appointment request. Our team will confirm shortly
via WhatsApp or SMS. Thank you for calling Lavora Clinic.'

If the caller speaks Arabic, respond in Arabic.
```

### Configure Data Collection in ElevenLabs

In your agent's **Data Collection** settings, add these 5 fields:
| Key | Description |
|-----|-------------|
| `patient_full_name` | Full name in English |
| `patient_phone` | Phone number |
| `appointment_date` | Date in YYYY-MM-DD format |
| `appointment_time` | Time in HH:MM format |
| `service_requested` | Service from clinic list |

---

## Step 6 — Connect Twilio Webhook

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers → your number
2. Under **Voice & Fax** → **A call comes in** → Webhook:
   ```
   https://YOUR_NGROK_URL/webhook/twilio/call-status
   ```

---

## Step 7 — Run the Test Suite

```bash
npm test
```

This simulates a full ElevenLabs webhook call and verifies the entire pipeline.

---

## Deploy to Railway (one-click)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add all environment variables from `.env` in the Railway dashboard
4. Upload `credentials/google-service-account.json` as a file or paste its contents as an env var:
   ```
   GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account",...}
   ```
   Then update `sheetsService.js` to use `JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)` instead of a file path.
5. Railway auto-deploys on every push

## Deploy to Render

1. Connect your GitHub repo at [render.com](https://render.com)
2. Choose **Web Service** → Node → Build: `npm install`, Start: `npm start`
3. Add environment variables in the dashboard
4. Done — Render gives you a public HTTPS URL

---

## API Reference

All endpoints require `X-Api-Key: YOUR_CRM_SECRET_KEY` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/appointments` | List all (`?date=&status=&source=`) |
| POST | `/api/appointments` | Create manually |
| PUT | `/api/appointments/:id` | Edit/reschedule |
| DELETE | `/api/appointments/:id` | Cancel |
| GET | `/api/appointments/today` | Today's schedule |
| GET | `/api/activity` | Last 50 actions |
| GET | `/api/stats` | Dashboard counts |
| GET | `/health` | Health check (public) |

### Example: Create appointment manually

```bash
curl -X POST https://your-server/api/appointments \
  -H "X-Api-Key: your-crm-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maryam Al-Habsi",
    "phone": "+96891234567",
    "service": "Botox",
    "doctor": "Dr. Neda",
    "date": "2025-05-20",
    "time": "11:00",
    "notes": "First visit"
  }'
```

---

## Google Sheets Structure

| Tab | Purpose |
|-----|---------|
| `Appointments` | All bookings (AI + Human) |
| `Missed Captures` | Incomplete calls needing follow-up |
| `Call Log` | Raw Twilio call records |
| `Activity Log` | Every action with actor + timestamp |

---

## Calendar Colors

- 🟢 **Sage green** — AI Voice bookings
- 🟡 **Gold/Yellow** — Human CRM bookings
