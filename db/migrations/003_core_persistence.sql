-- Phase 2: asset trust, per-scan observations, not-seen tracking. Additive only: nothing is dropped or rewritten
-- except the demo brand's synthetic assets, which are marked confirmed (they are labelled demo data).

-- Domain ownership proof (DNS TXT or a file on the domain). Only proven domains exclude results from scans.
CREATE TABLE IF NOT EXISTS domain_proofs (
  id          BIGSERIAL PRIMARY KEY,
  brand_id    BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  token       TEXT NOT NULL,
  method      TEXT CHECK (method IN ('dns_txt', 'well_known_file')),
  verified_at TIMESTAMPTZ,
  verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  evidence    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_id, domain)
);

-- One row per finding per scan, so a rescan never overwrites what an earlier scan saw.
CREATE TABLE IF NOT EXISTS finding_observations (
  id          BIGSERIAL PRIMARY KEY,
  finding_id  BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  scan_id     BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  source_key  TEXT NOT NULL DEFAULT '',
  score       INTEGER NOT NULL,
  severity    TEXT NOT NULL,
  probability REAL,
  signals     JSONB NOT NULL DEFAULT '[]',
  reasons     JSONB NOT NULL DEFAULT '[]',
  features    JSONB,
  evidence    JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finding_id, scan_id)
);
CREATE INDEX IF NOT EXISTS finding_observations_scan ON finding_observations (scan_id);

-- Keep what the findings table already holds as the first observation of the scan that last saw it.
INSERT INTO finding_observations (finding_id, scan_id, source_key, score, severity, probability, signals, reasons, features, evidence, observed_at)
SELECT id, last_scan_id, source_key, score, severity, probability, signals, reasons, features, evidence, last_seen_at
FROM findings WHERE last_scan_id IS NOT NULL
ON CONFLICT (finding_id, scan_id) DO NOTHING;

-- Not-seen tracking: consecutive scans of a healthy source that did not return the finding.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS missed_scans INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS last_missed_scan_id BIGINT REFERENCES scans(id) ON DELETE SET NULL;

ALTER TABLE finding_events DROP CONSTRAINT IF EXISTS finding_events_kind_check;
ALTER TABLE finding_events ADD CONSTRAINT finding_events_kind_check
  CHECK (kind IN ('detected', 'rescored', 'status_change', 'note', 'alerted', 'not_seen', 'seen_again'));

-- The demo brand is synthetic and labelled as such; its assets count as confirmed so the benchmark stays measurable.
UPDATE brands SET
  official_socials = COALESCE((SELECT jsonb_agg(e || '{"trust":"confirmed"}'::jsonb) FROM jsonb_array_elements(official_socials) e), '[]'::jsonb),
  official_apps    = COALESCE((SELECT jsonb_agg(e || '{"trust":"confirmed"}'::jsonb) FROM jsonb_array_elements(official_apps) e), '[]'::jsonb)
WHERE mode = 'demo';
