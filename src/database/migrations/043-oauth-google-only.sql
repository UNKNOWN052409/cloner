-- Migration 043 (task 4.5.1 google-only-oauth): retire GitHub OAuth.
--
-- OWNER DIRECTIVE: OAuth is GOOGLE-ONLY. GitHub OAuth sign-in was removed
-- from every product path (src/platform/oauth-real.js answers the legacy
-- /api/auth/oauth/github/* routes with 410 Gone + doc pointer at
-- docs/oauth.md). GitHub remains in the product for CODE PUBLISHING via
-- personal access tokens only (src/platform/github-publish-real.js).
--
-- This migration is FORWARD-ONLY and UNLINKS (does not delete) the
-- github-oauth identity rows created by the earlier dual-provider build
-- (migration 040):
--   * oauth_accounts rows with provider='github' are removed. The local
--     users rows they pointed at are preserved — every user keeps the
--     account and signs in with the primary email + password path. (An
--     OAuth-only user whose password_hash is NULL cannot sign in until an
--     admin sets a password; that is the documented consequence of
--     unlinking, not data loss — no identity data was deleted beyond the
--     link row itself.)
--   * oauth_states rows for provider='github' (stale CSRF/PKCE state from
--     the retired flow) are purged.
--   * The provider CHECK constraint from 040 ('github','google') is
--     tightened to 'google'-only so a github link can never be recreated.
--
-- Idempotent: deletes are no-ops on an already-clean table and the
-- constraint swap checks pg_constraint before dropping/adding.

-- 1. Unlink every github-oauth account row (forward-only, users preserved).
DELETE FROM oauth_accounts WHERE provider = 'github';

-- 2. Purge stale state rows from the retired flow.
DELETE FROM oauth_states WHERE provider = 'github';

-- 3. Tighten the provider CHECK to google-only.
--    Drop whatever provider CHECK 040 left behind (its name was
--    auto-generated, so match by definition), then add a stable one if
--    missing. The new constraint is excluded from the drop pass so re-runs
--    are safe.
DO $$
DECLARE
  c TEXT;
BEGIN
  IF to_regclass('public.oauth_accounts') IS NOT NULL THEN
    FOR c IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'oauth_accounts'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%provider%'
         AND conname <> 'oauth_accounts_provider_google_only'
    LOOP
      EXECUTE format('ALTER TABLE oauth_accounts DROP CONSTRAINT %I', c);
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'oauth_accounts'::regclass
         AND conname = 'oauth_accounts_provider_google_only'
    ) THEN
      ALTER TABLE oauth_accounts
        ADD CONSTRAINT oauth_accounts_provider_google_only CHECK (provider = 'google');
    END IF;
  END IF;
END $$;
