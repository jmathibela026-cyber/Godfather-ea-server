-- PostgreSQL schema for the EA App license system

CREATE TABLE bots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  name        TEXT NOT NULL,
  file_path   TEXT NOT NULL,          -- where the uploaded .ex4/.ex5 is stored
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE license_keys (
  id          BIGSERIAL PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,   -- HMAC of the key; plaintext is never stored
  status      TEXT NOT NULL DEFAULT 'unused'
              CHECK (status IN ('unused', 'bound', 'revoked')),
  bot_id      BIGINT UNIQUE REFERENCES bots(id),  -- one key per bot, one bot per key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  bound_at    TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,            -- NULL = never expires
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_license_keys_bot ON license_keys(bot_id);
