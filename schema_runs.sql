-- Run this after schema.sql

CREATE TABLE bot_runs (
  id           BIGSERIAL PRIMARY KEY,
  bot_id       BIGINT NOT NULL REFERENCES bots(id),
  status       TEXT NOT NULL
               CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
  instance_id  TEXT,                       -- container / VM id from the runner
  settings     JSONB NOT NULL DEFAULT '{}',-- the user's pre-start answers (never secrets)
  stop_mode    TEXT CHECK (stop_mode IN ('close_all', 'leave_open')),
  stop_reason  TEXT,                       -- 'user', 'license_invalid', ...
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at   TIMESTAMPTZ
);

-- A bot can only have one active run at a time (blocks double-clicks on Start)
CREATE UNIQUE INDEX one_active_run_per_bot
  ON bot_runs(bot_id)
  WHERE status IN ('starting', 'running', 'stopping');
