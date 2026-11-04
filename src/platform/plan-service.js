// Plans, entitlements and feature access (task 4.1.4).
//
// Plan catalog (free/pro/team) with JSONB entitlement maps. Effective
// entitlements resolve for a user+org pair with ORG-PLAN-WINS semantics: an
// org-scoped caller (org member) gets the ORG's plan entitlements; personal
// callers get their own plan (defaulting to 'free'). Unknown features deny by
// default — an entitlement lookup for a feature the plan does not define is a
// clean, typed refusal, never an accidental allow.
//
// Surface:
//   PLANS                      — seeded catalog rows (id → entitlements)
//   ensurePlanSchema/seed      — idempotent DDL + seed (in-module, admin-service
//                                precedent — additive, no migration-number churn
//                                on top of 018 which ships the tables)
//   setPlanForUser / setPlanForOrg
//   getPlanForUser / getPlanForOrg
//   resolveEntitlements({ userId, orgId })
//                              → { planId, entitlements, source: 'org'|'user'|'default' }
//   featureAllowed(entitlements, feature, value)
//                              → { allowed, limit } — unknown feature → deny
//   planRouter()               — INTEGRATOR MOUNT LINE:
//       import { planRouter } from "./plan-service.js";
//       app.use("/api/plans", planRouter());
import { Router } from "express";
import { query } from "../database/client.js";
import { authRequired } from "../auth/auth-middleware.js";

// The seeded catalog. Entitlements are the WHOLE truth of a plan; anything a
// plan does not list is denied by default (featureAllowed).
export const PLANS = {
  free: {
    name: "Free",
    description: "Free platform baseline — generous fair-use limits (quotas still enforce).",
    is_default: true,
    entitlements: {
      "max_concurrent_jobs": 1,
      "max_jobs_per_day": 50,
      "storage_gb": 5,
      "github_publish": true,
      "static_export": true,
      "template_gallery": true,
      "api_access": true,
      "priority_support": false,
    },
  },
  pro: {
    name: "Pro",
    description: "Pro — more concurrency, longer history, all product features.",
    is_default: false,
    entitlements: {
      "max_concurrent_jobs": 4,
      "max_jobs_per_day": 500,
      "storage_gb": 100,
      "github_publish": true,
      "static_export": true,
      "template_gallery": true,
      "api_access": true,
      "priority_support": true,
    },
  },
  team: {
    name: "Team",
    description: "Team — org-wide plan; the org's plan overrides members' personal plans.",
    is_default: false,
    entitlements: {
      "max_concurrent_jobs": 10,
      "max_jobs_per_day": 5000,
      "storage_gb": 1000,
      "github_publish": true,
      "static_export": true,
      "template_gallery": true,
      "api_access": true,
      "priority_support": true,
      "org_member_seats": 50,
    },
  },
};

export const PLAN_IDS = Object.keys(PLANS);

let schemaPromise = null;
export function ensurePlanSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
          is_default BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await query(`CREATE TABLE IF NOT EXISTS user_plans (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES plans(id),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await query(`CREATE TABLE IF NOT EXISTS org_plans (
          org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES plans(id),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      // seed — ON CONFLICT keeps operator-edited rows intact
      for (const [id, p] of Object.entries(PLANS)) {
        await query(
          `INSERT INTO plans (id, name, description, entitlements, is_default)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO NOTHING`,
          [id, p.name, p.description, JSON.stringify(p.entitlements), p.is_default]
        );
      }
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

export function validPlanId(id) {
  return PLAN_IDS.includes(String(id));
}

export async function setPlanForUser(userId, planId) {
  await ensurePlanSchema();
  if (!validPlanId(planId)) { const e = new Error(`unknown plan "${planId}" (valid: ${PLAN_IDS.join(", ")})`); e.status = 400; throw e; }
  await query(
    `INSERT INTO user_plans (user_id, plan_id) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET plan_id = $2, updated_at = now()`,
    [userId, planId]
  );
  return getPlanForUser(userId);
}

export async function setPlanForOrg(orgId, planId) {
  await ensurePlanSchema();
  if (!validPlanId(planId)) { const e = new Error(`unknown plan "${planId}" (valid: ${PLAN_IDS.join(", ")})`); e.status = 400; throw e; }
  await query(
    `INSERT INTO org_plans (org_id, plan_id) VALUES ($1,$2)
     ON CONFLICT (org_id) DO UPDATE SET plan_id = $2, updated_at = now()`,
    [orgId, planId]
  );
  return getPlanForOrg(orgId);
}

export async function getPlanForUser(userId) {
  await ensurePlanSchema();
  const r = await query(
    `SELECT up.plan_id, p.entitlements, p.name FROM user_plans up JOIN plans p ON p.id = up.plan_id WHERE up.user_id = $1`,
    [userId]
  );
  return r.rows[0] ? { planId: r.rows[0].plan_id, name: r.rows[0].name, entitlements: r.rows[0].entitlements } : null;
}

export async function getPlanForOrg(orgId) {
  await ensurePlanSchema();
  const r = await query(
    `SELECT op.plan_id, p.entitlements, p.name FROM org_plans op JOIN plans p ON p.id = op.plan_id WHERE op.org_id = $1`,
    [orgId]
  );
  return r.rows[0] ? { planId: r.rows[0].plan_id, name: r.rows[0].name, entitlements: r.rows[0].entitlements } : null;
}

// Effective entitlements for the caller's scope. ORG-PLAN-WINS: when an orgId
// resolves (org-scoped request) and the org has a plan, that plan is the
// effective one regardless of the member's personal plan. With no org (or an
// org without a plan), the user's plan applies; with neither, 'free' (the
// seeded default).
export async function resolveEntitlements({ userId = null, orgId = null } = {}) {
  await ensurePlanSchema();
  if (orgId) {
    const org = await getPlanForOrg(orgId);
    if (org) return { planId: org.planId, name: org.name, entitlements: org.entitlements, source: "org" };
  }
  if (userId) {
    const own = await getPlanForUser(userId);
    if (own) return { planId: own.planId, name: own.name, entitlements: own.entitlements, source: "user" };
  }
  const fallback = PLANS.free;
  return { planId: "free", name: fallback.name, entitlements: fallback.entitlements, source: "default" };
}

// Feature gate. DENY BY DEFAULT: a feature the plan does not define is refused
// (featureAllowed never guesses). Numeric entitlements support an optional
// requested value ("at most N"); boolean entitlements must be exactly true.
export function featureAllowed(entitlements, feature, value = null) {
  const e = entitlements || {};
  if (!(feature in e)) return { allowed: false, reason: `unknown feature "${feature}" for this plan (deny by default)` };
  const limit = e[feature];
  if (typeof limit === "boolean") return { allowed: limit === true, limit };
  if (typeof limit === "number") {
    if (value != null && Number(value) > limit) return { allowed: false, limit, reason: `requested ${value} exceeds plan limit ${limit}` };
    return { allowed: true, limit };
  }
  return { allowed: false, reason: "unsupported entitlement type (deny by default)" };
}

// Plan change flips entitlements (the plan doc's core test): resolve before /
// after a setPlan call and compare.
export function planRouter() {
  const router = Router();
  router.use(authRequired);
  router.use(async (_req, _res, next) => { try { await ensurePlanSchema(); next(); } catch (e) { next(e); } });

  router.get("/", async (_req, res) => {
    const r = await query("SELECT id, name, description, entitlements, is_default FROM plans ORDER BY id");
    res.json({ ok: true, plans: r.rows });
  });

  router.get("/effective", async (req, res) => {
    try {
      const orgId = req.query.orgId || null;
      const eff = await resolveEntitlements({ userId: req.userId, orgId: orgId && req.tenantScope?.orgId ? req.tenantScope.orgId : orgId });
      res.json({ ok: true, effective: eff });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.get("/check", async (req, res) => {
    try {
      const feature = String(req.query.feature || "");
      const value = req.query.value != null ? Number(req.query.value) : null;
      const orgId = req.query.orgId || null;
      const eff = await resolveEntitlements({ userId: req.userId, orgId: orgId && req.tenantScope?.orgId ? req.tenantScope.orgId : orgId });
      res.json({ ok: true, planId: eff.planId, ...featureAllowed(eff.entitlements, feature, value) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  // Plan changes are an operator action (admin) — settable per user or org.
  router.post("/users/:userId", async (req, res) => {
    try {
      if (req.userRole !== "admin") return res.status(403).json({ ok: false, error: "admin role required" });
      const plan = await setPlanForUser(req.params.userId, req.body?.plan);
      res.json({ ok: true, plan });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.post("/orgs/:orgId", async (req, res) => {
    try {
      if (req.userRole !== "admin") return res.status(403).json({ ok: false, error: "admin role required" });
      const plan = await setPlanForOrg(req.params.orgId, req.body?.plan);
      res.json({ ok: true, plan });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  return router;
}
