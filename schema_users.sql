-- Run this after schema.sql (bots.user_id points at users.id)

CREATE TABLE users (
  id          BIGSERIAL PRIMARY KEY,
  mentor_hash TEXT NOT NULL UNIQUE,   -- HMAC of the Mentor ID; plaintext is never stored
  email       TEXT NOT NULL,          -- stored lowercase
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,       -- HMAC of the session token
  user_id     BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

ALTER TABLE bots ADD CONSTRAINT bots_user_fk FOREIGN KEY (user_id) REFERENCES users(id);
