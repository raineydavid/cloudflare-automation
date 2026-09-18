CREATE TABLE IF NOT EXISTS accounts (
  subject    TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  hash       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS auth_codes (
  hash       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  audience   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS login_tokens_expiry ON login_tokens (expires_at);
CREATE INDEX IF NOT EXISTS auth_codes_expiry ON auth_codes (expires_at);
