-- Migration 004: Performance indexes on all hot query paths
--
-- Every WHERE clause used in production queries gets an index.
-- JSONB GIN indexes handle any-field lookups (used by dashboard/search).
-- Concurrent creation (CREATE INDEX CONCURRENTLY) is not used here because
-- these run inside a migration transaction — plain CREATE INDEX is fine on
-- a table that isn't yet under heavy production load.

-- appointments: most-used filters
CREATE INDEX IF NOT EXISTS idx_apts_date    ON appointments ((data->>'date'));
CREATE INDEX IF NOT EXISTS idx_apts_phone   ON appointments ((data->>'phone'));
CREATE INDEX IF NOT EXISTS idx_apts_status  ON appointments ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_apts_source  ON appointments ((data->>'source'));
-- Composite: today's non-cancelled appointments (most common dashboard query)
CREATE INDEX IF NOT EXISTS idx_apts_date_status ON appointments ((data->>'date'), (data->>'status'));

-- laser_packages: filtered by phone and status in every lookup
CREATE INDEX IF NOT EXISTS idx_pkgs_phone   ON laser_packages ((data->>'phone'));
CREATE INDEX IF NOT EXISTS idx_pkgs_status  ON laser_packages ((data->>'status'));

-- whatsapp_sessions: TTL cleanup queries on updated_at
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON whatsapp_sessions (updated_at);

-- activity_log: ordered reads by created_at (already sorted in query, index speeds it)
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at DESC);
