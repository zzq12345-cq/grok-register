-- D1 (SQLite) schema for Grok Imagine on Cloudflare Workers

-- Tokens table for storing SSO credentials
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  sso TEXT NOT NULL,
  sso_rw TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  cf_clearance TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  last_used INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  nsfw_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_nsfw ON tokens(nsfw_enabled);

-- Settings table for app configuration
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Request logs for debugging
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  ip TEXT NOT NULL,
  action TEXT NOT NULL,
  token_id TEXT NOT NULL,
  duration REAL NOT NULL,
  status INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp);

-- Default settings
INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  (
    'global',
    '{"admin_password":"admin","admin_username":"admin"}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  );
