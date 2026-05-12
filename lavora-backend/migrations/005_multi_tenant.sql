-- Migration 005: Multi-tenant support
--
-- Adds a clinics table and a clinic_id column to every data table.
-- Existing rows are assigned to 'clinic_default' so no data is lost.
-- New indexes on clinic_id make per-tenant queries efficient.
--
-- API key auth already existed; this migration makes the DB schema match it
-- so that row-level isolation is enforced at the data layer, not just in code.

-- ── Clinics registry ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  api_key     TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  active      BOOLEAN DEFAULT TRUE
);

-- Seed the default clinic (existing single-tenant deployment)
INSERT INTO clinics (id, name, api_key)
VALUES (
  'clinic_default',
  'Default Clinic',
  COALESCE(current_setting('app.default_api_key', true), 'REPLACE_WITH_YOUR_API_KEY')
)
ON CONFLICT (id) DO NOTHING;

-- ── Add clinic_id to all data tables ─────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

ALTER TABLE missed_captures
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

ALTER TABLE call_log
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

ALTER TABLE laser_packages
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS clinic_id TEXT NOT NULL DEFAULT 'clinic_default'
  REFERENCES clinics(id);

-- ── Per-tenant indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_apts_clinic       ON appointments (clinic_id);
CREATE INDEX IF NOT EXISTS idx_apts_clinic_date  ON appointments (clinic_id, (data->>'date'));
CREATE INDEX IF NOT EXISTS idx_pkgs_clinic        ON laser_packages (clinic_id);
CREATE INDEX IF NOT EXISTS idx_sessions_clinic    ON whatsapp_sessions (clinic_id);
CREATE INDEX IF NOT EXISTS idx_activity_clinic    ON activity_log (clinic_id);
