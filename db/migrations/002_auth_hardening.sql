-- Account lifecycle, revocable sessions, shared login throttling and an audit log for security events.

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

-- Failed sign-ins, kept in Postgres so the limit holds across serverless instances.
CREATE TABLE IF NOT EXISTS login_failures (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures (ip, created_at);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures (email, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  target     TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at DESC);
