-- Migration 040 (task G1.4): real OAuth (GitHub + Google) — account linking
-- and server-side state storage for the authorization-code flows.
--
-- oauth_accounts: one row per (provider, provider_account_id) link to a local
-- user. Stores IDENTITY only — never the IdP access/refresh tokens. Password
-- users and OAuth users converge on the same users row when the verified
-- e-mail matches (link-by-email upsert in src/platform/oauth-real.js).
--
-- oauth_states: single-use CSRF state + PKCE code_verifier, issued by
-- GET /api/auth/oauth/:provider/start and consumed atomically (DELETE …
-- RETURNING) by the callback. TTL enforced with expires_at (default 10 min).
--
-- users.password_hash: OAuth-only accounts have no password, so the NOT NULL
-- from 001-initial.sql is relaxed. NULL hash = "cannot password-login"
-- (auth-service.loginUser fails bcrypt.compare against null → invalid
-- credentials). Guarded DO block keeps the migration idempotent.
-- Forward-only, idempotent (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_account_id TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  provider_avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  browser_redirect BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- Self-healing for environments where an earlier revision of this same
-- migration file was applied before browser_redirect existed (the migration
-- id is then already recorded in _migrations and never re-runs). Idempotent.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS browser_redirect BOOLEAN NOT NULL DEFAULT false;

-- OAuth-only users may exist with no password credential at all.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'password_hash' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;
