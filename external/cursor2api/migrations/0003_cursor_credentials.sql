CREATE TABLE IF NOT EXISTS cursor_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  cursor_api_key_ciphertext TEXT NOT NULL,
  cursor_api_key_iv TEXT NOT NULL,
  cursor_api_key_hint TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  disabled_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_cursor_credentials_account_status
ON cursor_credentials(account_id, status);

CREATE TABLE IF NOT EXISTS cursor_credential_models (
  credential_id TEXT NOT NULL REFERENCES cursor_credentials(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  disabled_reason TEXT,
  disabled_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_cursor_credential_models_disabled
ON cursor_credential_models(credential_id, disabled_at);
