// Credit ledger — THE free-platform credit ledger (task 4.5.2 zero-dollar-billing).
//
// OWNER DIRECTIVE: payment is $0 — the platform is FREE. This module is the
// "free-grant path": credits are granted freely and UNLIMITED. There is no
// spend gate, no balance gate, no 402/403 anywhere in here — this module can
// never deny a grant. Fair-use quotas (4.0.4, quota-service.js) are a separate
// subsystem and are NOT billing; they do not read this ledger for denial.
//
// Responsibilities:
//   • `credit_ledger_entries` — the single source of truth for credit balances
//     (free claims, Stripe-sourced $0-checkout forwards, admin/system grants).
//   • `grantFreeCredits()` — unlimited free grants, idempotent by caller-supplied
//     eventId (replays cannot double-grant), additive only.
//   • `grant()` — the injected-dependency contract billing-stripe.js documents
//     (org-routes.js pattern): billing webhook events forward here.
//
// Schema policy: in-module idempotent DDL (admin-service.js precedent) —
// additive, no migration-number collision with the integrator's ordered set.
//
// Consumers (all read-only): GET /api/billing/credits computes the balance from
// this table via ledgerBalance(). Nothing subtracts from it: consumption
// enforcement lives in quota-service.js (QUOTA_EXCEEDED), which is quota
// enforcement, not billing.
import { query as dbQuery } from "../database/client.js";

// Per-ENTRY input sanity bound — NOT a balance cap and NOT a paywall: a caller
// needing more simply claims again (unlimited grant count, unlimited balance).
export const MAX_SINGLE_ENTRY_CREDITS = 1_000_000;
// Default amount for an explicit free claim that does not specify one.
export const FREE_CLAIM_DEFAULT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LedgerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LedgerConfigError";
    this.status = 400;
  }
}

let schemaPromise = null;

/** Idempotent DDL — safe to call on every request path. */
export function ensureLedgerSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS credit_ledger_entries (
          id BIGSERIAL PRIMARY KEY,
          event_id TEXT UNIQUE,
          source TEXT NOT NULL DEFAULT 'free',
          user_id UUID,
          org_id UUID,
          credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
          reason TEXT NOT NULL DEFAULT 'free_grant',
          meta JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger_entries(user_id)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_credit_ledger_org ON credit_ledger_entries(org_id)`);
    })().catch((e) => {
      schemaPromise = null; // allow retry on next call
      throw e;
    });
  }
  return schemaPromise;
}

/**
 * Grant credits for FREE. Unlimited: there is no cap on the number of grants
 * or on the resulting balance, and no condition under which this denies.
 * Idempotent by eventId: a replayed eventId inserts nothing and returns
 * { duplicate: true } (webhook/queue replays can never double-grant).
 *
 * @param {object} o
 *   userId / orgId  — at least one required (the scope the credits land in)
 *   amount          — integer 0..MAX_SINGLE_ENTRY_CREDITS (input sanity only)
 *   reason          — short audit reason (default "free_grant")
 *   source          — 'free' | 'stripe' | 'admin' | 'system' (default 'free')
 *   eventId         — optional idempotency key; a fresh UUID per call when absent
 *   meta            — optional JSONB payload
 * @returns { duplicate, granted, entryId, eventId, balance }
 */
export async function grantFreeCredits({ userId = null, orgId = null, amount = FREE_CLAIM_DEFAULT, reason = "free_grant", source = "free", eventId = null, meta = null } = {}) {
  await ensureLedgerSchema();
  if (!userId && !orgId) throw new LedgerConfigError("credit grant requires userId or orgId");
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 0) {
    throw new LedgerConfigError("credit grant amount must be a non-negative integer");
  }
  if (amt > MAX_SINGLE_ENTRY_CREDITS) {
    throw new LedgerConfigError(
      `credit grant amount exceeds the per-entry sanity limit of ${MAX_SINGLE_ENTRY_CREDITS} — the platform is free: claim again as many times as you need (this is input validation, not a paywall)`
    );
  }
  const id = eventId ? String(eventId).slice(0, 255) : `free-${userId || orgId}-${crypto.randomUUID()}`;
  const r = await dbQuery(
    `INSERT INTO credit_ledger_entries (event_id, source, user_id, org_id, credits, reason, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, credits`,
    [
      id,
      String(source || "free").slice(0, 32),
      UUID_RE.test(String(userId || "")) ? userId : null,
      UUID_RE.test(String(orgId || "")) ? orgId : null,
      amt,
      String(reason || "free_grant").slice(0, 120),
      meta ? JSON.stringify(meta) : null,
    ]
  );
  if (!r.rows.length) {
    // replayed eventId — idempotent no-op, never a denial
    return { duplicate: true, granted: 0, entryId: null, eventId: id, balance: await ledgerBalance({ userId: userId || null, orgId: orgId || null }) };
  }
  const row = r.rows[0];
  return { duplicate: false, granted: row.credits, entryId: row.id, eventId: id, balance: await ledgerBalance({ userId: userId || null, orgId: orgId || null }) };
}

/**
 * Injected-dependency contract used by billing-stripe.js forwardToExternalLedger
 * (it looks for grantCredits|grant|addCredits|credit on ./credit-ledger.js).
 * Accepts the Stripe forward shape { userId, orgId, credits, reason, eventId, source, meta }.
 */
export async function grant({ userId = null, orgId = null, credits = 0, amount, reason = "stripe_grant", source = "stripe", eventId = null, meta = null } = {}) {
  const amt = amount === undefined ? credits : amount;
  return grantFreeCredits({ userId, orgId, amount: amt, reason, source, eventId, meta });
}

/** Authoritative balance: SUM over the credit ledger. Never gates anything. */
export async function ledgerBalance({ userId = null, orgId = null } = {}) {
  await ensureLedgerSchema();
  if (userId) {
    const r = await dbQuery("SELECT COALESCE(SUM(credits),0)::int AS balance FROM credit_ledger_entries WHERE user_id = $1", [userId]);
    return r.rows[0].balance;
  }
  if (orgId) {
    const r = await dbQuery("SELECT COALESCE(SUM(credits),0)::int AS balance FROM credit_ledger_entries WHERE org_id = $1", [orgId]);
    return r.rows[0].balance;
  }
  throw new LedgerConfigError("userId or orgId required");
}

/** Recent ledger entries, latest first (the audit trail behind the balance). */
export async function listLedgerEntries({ userId = null, orgId = null, limit = 25 } = {}) {
  await ensureLedgerSchema();
  const lim = Math.max(1, Math.min(Number(limit) || 25, 200));
  const where = userId ? "WHERE user_id = $1" : orgId ? "WHERE org_id = $1" : null;
  if (!where) throw new LedgerConfigError("userId or orgId required");
  const r = await dbQuery(
    `SELECT id, event_id, source, user_id, org_id, credits, reason, meta, created_at
     FROM credit_ledger_entries ${where} ORDER BY id DESC LIMIT ${lim}`,
    [userId || orgId]
  );
  return r.rows;
}

/** Totals by source — the free-platform story in one query (admin/status). */
export async function ledgerStats({ userId = null } = {}) {
  await ensureLedgerSchema();
  const where = userId ? "WHERE user_id = $1" : "";
  const params = userId ? [userId] : [];
  const r = await dbQuery(
    `SELECT source, COUNT(*)::int AS entries, COALESCE(SUM(credits),0)::bigint AS credits
     FROM credit_ledger_entries ${where} GROUP BY source ORDER BY source`,
    params
  );
  return r.rows.map((row) => ({ source: row.source, entries: row.entries, credits: Number(row.credits) }));
}
