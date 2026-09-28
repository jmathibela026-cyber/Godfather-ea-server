-- Full schema, safe to run every time the server starts (IF NOT EXISTS everywhere).
-- This replaces running schema.sql / schema_users.sql / schema_runs.sql / schema_v2.sql
-- by hand — migrate.js runs this automatically on boot.

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  mentor_hash TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bots (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  image_path  TEXT,
  file_path   TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'mt5' CHECK (platform IN ('mt4', 'mt5')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS license_keys (
  id          BIGSERIAL PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'unused'
              CHECK (status IN ('unused', 'redeemed', 'revoked')),
  bot_id      BIGINT NOT NULL REFERENCES bots(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,
  redeemed_by BIGINT REFERENCES users(id),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_license_keys_bot ON license_keys(bot_id);

CREATE TABLE IF NOT EXISTS user_bots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  bot_id      BIGINT NOT NULL REFERENCES bots(id),
  key_id      BIGINT NOT NULL UNIQUE REFERENCES license_keys(id),
  symbols     JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bot_id)
);

CREATE TABLE IF NOT EXISTS bot_runs (
  id           BIGSERIAL PRIMARY KEY,
  user_bot_id  BIGINT NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
  status       TEXT NOT NULL
               CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
  instance_id  TEXT,
  settings     JSONB NOT NULL DEFAULT '{}',
  stop_mode    TEXT CHECK (stop_mode IN ('close_all', 'leave_open')),
  stop_reason  TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_user_bot
  ON bot_runs(user_bot_id) WHERE status IN ('starting', 'running', 'stopping');

CREATE TABLE IF NOT EXISTS mt_accounts (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  login        TEXT NOT NULL,
  server       TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform)
);
