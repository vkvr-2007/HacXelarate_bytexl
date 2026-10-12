-- SignalGuard schema. Applied by `npm run db:migrate` (server/db/migrate.js).

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- A brand is either live (scanned only by live sources) or demo (scanned only by the seeded demo world).
CREATE TABLE IF NOT EXISTS brands (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  mode                  TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'demo')),
  domain                TEXT NOT NULL,
  domains               JSONB NOT NULL DEFAULT '[]',
  description           TEXT NOT NULL DEFAULT '',
  logo_url              TEXT NOT NULL DEFAULT '',
  aliases               JSONB NOT NULL DEFAULT '[]',
  keywords              JSONB NOT NULL DEFAULT '[]',
  official_socials      JSONB NOT NULL DEFAULT '[]',
  official_apps         JSONB NOT NULL DEFAULT '[]',
  sources               JSONB,                         -- null = every configured source
  scan_interval_minutes INTEGER CHECK (scan_interval_minutes IS NULL OR scan_interval_minutes >= 60),
  next_scan_at          TIMESTAMPTZ,
  verification          JSONB,
  verified_at           TIMESTAMPTZ,
  created_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_mode ON brands (lower(name), mode);

CREATE TABLE IF NOT EXISTS allowlist (
  id          BIGSERIAL PRIMARY KEY,
  brand_id    BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  added_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS scans (
  id           BIGSERIAL PRIMARY KEY,
  brand_id     BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  trigger      TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule')),
  requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  queries      JSONB,
  stats        JSONB,
  sources      JSONB,
  excluded     JSONB,
  evaluation   JSONB,
  model        JSONB,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS scans_brand_queued ON scans (brand_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS scans_status ON scans (status) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS findings (
  id              BIGSERIAL PRIMARY KEY,
  brand_id        BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  type            TEXT NOT NULL CHECK (type IN ('social', 'app', 'domain', 'web')),
  platform        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  handle          TEXT NOT NULL DEFAULT '',
  app_id          TEXT NOT NULL DEFAULT '',
  publisher       TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL DEFAULT '',
  icon_url        TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  source_key      TEXT NOT NULL,
  score           INTEGER NOT NULL,
  severity        TEXT NOT NULL,
  probability     REAL,
  signals         JSONB NOT NULL DEFAULT '[]',
  reasons         JSONB NOT NULL DEFAULT '[]',
  features        JSONB,
  evidence        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'confirmed', 'false_positive', 'official', 'resolved')),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scan_id    BIGINT REFERENCES scans(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS findings_brand_score ON findings (brand_id, score DESC);

-- Audit trail: detections, rescoring, review decisions and notes.
CREATE TABLE IF NOT EXISTS finding_events (
  id          BIGSERIAL PRIMARY KEY,
  finding_id  BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  scan_id     BIGINT REFERENCES scans(id) ON DELETE SET NULL,
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('detected', 'rescored', 'status_change', 'note', 'alerted')),
  from_status TEXT,
  to_status   TEXT,
  score       INTEGER,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finding_events_finding ON finding_events (finding_id, created_at);

-- Latest health per source, updated after every scan.
CREATE TABLE IF NOT EXISTS source_health (
  source_key           TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  status               TEXT NOT NULL,
  message              TEXT NOT NULL DEFAULT '',
  last_ok_at           TIMESTAMPTZ,
  last_error_at        TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Response cache shared by worker processes. Used as a fallback when a source fails.
CREATE TABLE IF NOT EXISTS source_cache (
  source_key TEXT NOT NULL,
  cache_key  TEXT NOT NULL,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key, cache_key)
);

CREATE TABLE IF NOT EXISTS ml_feedback (
  id         BIGSERIAL PRIMARY KEY,
  finding_id BIGINT REFERENCES findings(id) ON DELETE SET NULL,
  label      SMALLINT NOT NULL CHECK (label IN (0, 1)),
  features   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
