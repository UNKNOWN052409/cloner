-- Migration 013: API keys (task 4.0.6)
-- SHA-256-hashed keys at rest; raw key material is NEVER stored in any column.
-- prefix (e.g. "ck_live_a1b2") is stored in clear text for UI display only —
-- it is not sufficient to reconstruct or authenticate with the key.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'api key',
  key_hash TEXT NOT NULL UNIQUE,      -- sha256 hex of the full raw key
  prefix TEXT NOT NULL,               -- first ~12 chars, display only
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,             -- NULL = never expires
  revoked_at TIMESTAMPTZ,             -- NULL = active
  last_used_at TIMESTAMPTZ,           -- updated on successful auth (throttled)
  last_used_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
