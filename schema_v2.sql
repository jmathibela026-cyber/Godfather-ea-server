-- Run AFTER schema.sql, schema_runs.sql and schema_users.sql.
-- Bots become a catalog you upload; users connect to a bot by redeeming a key.

-- Old test data that doesn't fit the new model
DELETE FROM bot_runs;
DELETE FROM license_keys WHERE bot_id IS NULL;

-- 1. Bots: owned by you, not by a user
ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_user_fk;
ALTER TABLE bots DROP COLUMN user_id;
ALTER TABLE bots ADD COLUMN author     TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN image_path TEXT;
ALTER TABLE bots ADD COLUMN platform   TEXT NOT NULL DEFAULT 'mt5' CHECK (platform IN ('mt4', 'mt5'));  -- .ex5 = mt5, .ex4 = mt4

-- 2. Keys belong to a bot from the moment you create them
ALTER TABLE license_keys DROP CONSTRAINT IF EXISTS license_keys_bot_id_key;
ALTER TABLE license_keys DROP CONSTRAINT IF EXISTS license_keys_status_check;
UPDATE license_keys SET status = 'redeemed' WHERE status = 'bound';
ALTER TABLE license_keys ADD CONSTRAINT license_keys_status_check
  CHECK (status IN ('unused', 'redeemed', 'revoked'));
ALTER TABLE license_keys ALTER COLUMN bot_id SET NOT NULL;
ALTER TABLE license_keys RENAME COLUMN bound_at TO redeemed_at;
ALTER TABLE license_keys ADD COLUMN redeemed_by BIGINT REFERENCES users(id);

-- 3. A user's connection to a bot (created when they redeem a key)
CREATE TABLE user_bots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  bot_id      BIGINT NOT NULL REFERENCES bots(id),
  key_id      BIGINT NOT NULL UNIQUE REFERENCES license_keys(id),
  symbols     JSONB NOT NULL DEFAULT '[]',   -- the symbols saved on the Quotes screen
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bot_id)
);

-- 4. Runs now belong to a user's connection, not to the shared bot
DROP INDEX IF EXISTS one_active_run_per_bot;
ALTER TABLE bot_runs DROP CONSTRAINT IF EXISTS bot_runs_bot_id_fkey;
ALTER TABLE bot_runs RENAME COLUMN bot_id TO user_bot_id;
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_user_bot_fk
  FOREIGN KEY (user_bot_id) REFERENCES user_bots(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX one_active_run_per_user_bot
  ON bot_runs(user_bot_id) WHERE status IN ('starting', 'running', 'stopping');

-- 5. The user's MetaTrader accounts: one MT5 and one MT4 per user (password stored encrypted)
CREATE TABLE mt_accounts (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  login        TEXT NOT NULL,
  server       TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform)
);
