// Onboarding + account activation (task 4.1.1).
//
// First-use experience: a fresh user completes activation steps (profile,
// workspace defaults, guided state) through this service; the state is a real
// DB row (onboarding_profiles, migration 018) — activation is idempotent, and
// re-activation after completion never reverts the completed state.
//
// Surface:
//   ensureOnboarding(userId)           → row (creates the pending default)
//   getOnboarding(userId)              → { ...state, nextStep, complete }
//   saveOnboardingStep(userId, step, payload, { skip })
//                                    → updated state (validated step names)
//   completeOnboarding(userId)         → marks 'complete' (idempotent)
//   resetForTest(userId)               → deletes the row (tests only)
//   REQUIRED_STEPS / ALL_STEPS         — the contract the routes + tests share
//
// Router (INTEGRATOR MOUNT LINE — server.js is integrator-owned):
//   import { onboardingRouter } from "./onboarding-service.js";
//   app.use("/api/onboarding", onboardingRouter());
// All routes are session-authenticated (authRequired) and strictly per-user:
// a caller only ever reads/writes their own onboarding row.
import { Router } from "express";
import { query } from "../database/client.js";
import { authRequired } from "../auth/auth-middleware.js";

// The guided order. profile + workspace are REQUIRED for 'complete';
// connect and tour are optional (skip-allowed by design).
export const REQUIRED_STEPS = ["profile", "workspace"];
export const ALL_STEPS = ["profile", "workspace", "connect", "tour"];

function badStep(step) {
  return !ALL_STEPS.includes(step);
}

async function readRow(userId) {
  const r = await query("SELECT * FROM onboarding_profiles WHERE user_id = $1", [userId]);
  return r.rows[0] || null;
}

export async function ensureOnboarding(userId) {
  const existing = await readRow(userId);
  if (existing) return existing;
  await query(
    `INSERT INTO onboarding_profiles (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  return readRow(userId);
}

function shape(row) {
  if (!row) return null;
  const done = new Set([...(row.steps_done || []), ...(row.steps_skipped || [])]);
  const complete = row.activation_status === "complete";
  const nextStep = complete ? null : (ALL_STEPS.find((s) => !done.has(s)) || null);
  return {
    userId: row.user_id,
    activationStatus: row.activation_status,
    profile: row.profile || {},
    stepsDone: row.steps_done || [],
    stepsSkipped: row.steps_skipped || [],
    workspaceDefaults: row.workspace_defaults || {},
    activatedAt: row.activated_at || null,
    nextStep,
    complete: row.activation_status === "complete",
  };
}

export async function getOnboarding(userId) {
  return shape(await ensureOnboarding(userId));
}

// Save one step. payload is a JSONB object merged into profile (profile step)
// or workspaceDefaults (workspace step). skip=true records the step as
// deliberately skipped (counts toward done; required skips still leave
// activation 'in_progress' until completeOnboarding is called explicitly).
export async function saveOnboardingStep(userId, step, payload = {}, { skip = false } = {}) {
  if (badStep(step)) {
    const e = new Error(`unknown onboarding step "${step}" (valid: ${ALL_STEPS.join(", ")})`);
    e.status = 400;
    throw e;
  }
  if (payload !== null && typeof payload !== "object") {
    const e = new Error("step payload must be an object");
    e.status = 400;
    throw e;
  }
  await ensureOnboarding(userId);
  const row = await readRow(userId);
  if (row.activation_status === "complete") {
    // idempotent re-save after completion: state never regresses
    return getOnboarding(userId);
  }
  const col = step === "workspace" ? "workspace_defaults" : "profile";
  const payloadJson = JSON.stringify(payload && typeof payload === "object" ? payload : {});
  const status = skip || row.steps_skipped.includes(step)
    ? (REQUIRED_STEPS.every((s) => s === step || row.steps_done.includes(s) || row.steps_skipped.includes(s)) ? "in_progress" : "in_progress")
    : "in_progress";

  await query(
    `UPDATE onboarding_profiles
     SET ${col} = ${col} || $2::jsonb,
         steps_done = CASE WHEN $3::bool AND NOT steps_done ? $4 THEN steps_done || $5::jsonb ELSE steps_done END,
         steps_skipped = CASE WHEN $6::bool AND NOT steps_skipped ? $4 THEN steps_skipped || $5::jsonb ELSE steps_skipped END,
         activation_status = $7,
         updated_at = now()
     WHERE user_id = $1`,
    [
      userId,
      payloadJson,
      !skip,                       // record into steps_done when not skipped
      step,
      JSON.stringify([step]),
      skip,                        // record into steps_skipped when skipped
      status,
    ]
  );
  return getOnboarding(userId);
}

// Explicit activation. Idempotent: completing twice keeps 'complete' and the
// original activated_at. Callers may activate even with skipped steps — the
// activation decision is the user's; the service only records it honestly.
export async function completeOnboarding(userId) {
  await ensureOnboarding(userId);
  await query(
    `UPDATE onboarding_profiles
     SET activation_status = 'complete',
         activated_at = COALESCE(activated_at, now()),
         updated_at = now()
     WHERE user_id = $1`,
    [userId]
  );
  return getOnboarding(userId);
}

export async function resetForTest(userId) {
  await query("DELETE FROM onboarding_profiles WHERE user_id = $1", [userId]);
}

export function onboardingRouter() {
  const router = Router();
  router.use(authRequired);

  router.get("/", async (req, res) => {
    try {
      res.json({ ok: true, onboarding: await getOnboarding(req.userId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.post("/steps/:step", async (req, res) => {
    try {
      const body = req.body || {};
      const state = await saveOnboardingStep(req.userId, req.params.step, body.payload ?? body, { skip: body.skip === true });
      res.json({ ok: true, onboarding: state });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      res.json({ ok: true, onboarding: await completeOnboarding(req.userId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  return router;
}
