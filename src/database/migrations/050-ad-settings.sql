-- Migration 050 — ad settings + serving ledger (task 4.5.4 ad-provider-core).
--
-- Three additive tables backing src/monetization/ad-providers.js and
-- src/monetization/ad-slots.js:
--
--   ad_slot_settings   per-slot operator overrides: enabled flag, provider
--                      pin, and the frequency cap (max serves per viewer
--                      session, per slot, within a rolling window). NULL
--                      columns fall back to the env defaults.
--   ad_serving_events  delivery ledger: one row per ad actually served. Used
--                      ONLY to enforce the configured frequency cap. Viewer
--                      identity is a salted SHA-256 of a random cookie id —
--                      never an IP, never an email, no PII. Rows older than
--                      24 hours are purged.
--   ad_delivery_log    honest decision log: which slot, which network, which
--                      outcome (served / not_configured / no_provider_available /
--                      frequency_capped / disabled_by_settings /
--                      cap_check_unavailable). This is what makes "zero ad
--                      output + honest log" auditable.
--
-- Forward-only, idempotent (IF NOT EXISTS). No network tags are stored here —
-- tags are rendered from env at request time by the official-tag builders in
-- ad-providers.js.

CREATE TABLE IF NOT EXISTS ad_slot_settings (
  slot_key                     TEXT PRIMARY KEY,
  enabled                      BOOLEAN NOT NULL DEFAULT TRUE,
  provider_override            TEXT     NULL CHECK (provider_override IS NULL OR provider_override IN ('monetag','adsterra')),
  frequency_cap_max            INT      NULL CHECK (frequency_cap_max IS NULL OR frequency_cap_max >= 0),
  frequency_cap_window_seconds INT      NULL CHECK (frequency_cap_window_seconds IS NULL OR frequency_cap_window_seconds > 0),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_serving_events (
  id           BIGSERIAL PRIMARY KEY,
  slot_key     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  served_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_serving_session_slot
  ON ad_serving_events (session_hash, slot_key, served_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_serving_served_at
  ON ad_serving_events (served_at);

CREATE TABLE IF NOT EXISTS ad_delivery_log (
  id         BIGSERIAL PRIMARY KEY,
  slot_key   TEXT,
  provider   TEXT,
  outcome    TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_delivery_created_at
  ON ad_delivery_log (created_at DESC);
