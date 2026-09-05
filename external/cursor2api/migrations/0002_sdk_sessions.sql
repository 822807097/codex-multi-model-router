CREATE TABLE IF NOT EXISTS sdk_sessions (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sdk_sessions_owner_updated
ON sdk_sessions(owner_hash, updated_at DESC);
