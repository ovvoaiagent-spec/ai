-- Migration 002: Laser packages table

CREATE TABLE IF NOT EXISTS laser_packages (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
