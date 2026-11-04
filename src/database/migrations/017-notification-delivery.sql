-- Phase 4.2.16: email/webhook notification delivery.
-- notification_preferences — per-user channel + per-event channel overrides.
-- notification_deliveries  — append-only delivery log (audit/debug surface for
--                            the user; drives dedupe on retries). No UPDATE or
--                            DELETE paths exist in the service by design.
-- Forward-only migration, idempotent (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_address TEXT,                -- NULL = use the account email
  webhook_url TEXT,                  -- NULL = webhook channel off
  webhook_secret TEXT,               -- HMAC-SHA256 key for X-Cloner-Signature
  event_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
                                     -- { "task.failed": {"email": false} }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','webhook')),
  status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped','rate_limited')),
  recipient TEXT,                    -- email address or webhook URL
  subject TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,               -- e.g. the task id that caused the event
  dedupe_key TEXT,                   -- retry-safe emission key (nullable)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_deliveries_user
  ON notification_deliveries(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_dedupe
  ON notification_deliveries(user_id, event, dedupe_key);
