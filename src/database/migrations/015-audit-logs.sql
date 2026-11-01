-- Phase 4.0.9: append-only audit log with hash chain (tamper-evident).
-- Written exclusively by src/platform/audit-service.js; the service exposes
-- no UPDATE/DELETE paths by design. The per-row hash chain
-- (payload_hash = sha256(prev_hash + payload)) makes any out-of-band edit
-- detectable via audit-service.verifyAuditChain().
-- Note: this codebase has a single DB role (table owner), so row-level
-- immutability via GRANT denial is not enforceable here; role separation is
-- a deployment concern (a future read-only audit role must be denied
-- UPDATE/DELETE on this table).
-- Intentionally NO foreign keys: an audit row must survive deletion of the
-- user/task/organization it refers to (audit trail outlives its subjects).
-- Forward-only migration, idempotent (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version INT NOT NULL DEFAULT 1,
  actor_type TEXT NOT NULL DEFAULT 'anonymous'
    CHECK (actor_type IN ('user','service','anonymous')),
  actor_id UUID,
  actor_email TEXT,
  org_id TEXT,
  api_key_id TEXT,
  session_id UUID,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success','failure','denied')),
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  ip TEXT,
  prev_hash TEXT,
  payload_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_org_id ON audit_events(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation_id ON audit_events(correlation_id);
