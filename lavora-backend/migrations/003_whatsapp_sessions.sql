-- Migration 003: Persistent WhatsApp sessions

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  phone       TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
