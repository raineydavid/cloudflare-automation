CREATE TABLE IF NOT EXISTS api_keys (
  hash       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  prefix     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_subject ON api_keys (subject);
CREATE TABLE IF NOT EXISTS credits (
  subject       TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage (
  id      TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  kind    TEXT NOT NULL,
  cents   INTEGER NOT NULL,
  byok    INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_subject ON usage (subject, at);
CREATE TABLE IF NOT EXISTS byok (
  subject    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  sealed     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject, provider)
);
