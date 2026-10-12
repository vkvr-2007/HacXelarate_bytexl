-- Phase 3: show whether a worker is alive, and keep a record of every alert delivery attempt.
CREATE TABLE IF NOT EXISTS workers (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('worker', 'cron', 'api')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scan_id BIGINT
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  brand_id    BIGINT REFERENCES brands(id) ON DELETE CASCADE,
  scan_id     BIGINT REFERENCES scans(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'findings' CHECK (kind IN ('findings', 'test')),
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  finding_ids JSONB NOT NULL DEFAULT '[]',
  retry_of    BIGINT REFERENCES alert_deliveries(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_deliveries_brand ON alert_deliveries (brand_id, created_at DESC);
