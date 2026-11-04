// Monetize opt-in capture for clone tasks (task 4.5.5 ad-clone-ui-integration).
//
// The policy-safe default is OFF: a clone task carries ad slots ONLY when its
// owner explicitly opted in. The opt-in travels WITH the task-creation request
// (`monetize: true` in the JSON body of POST /api/tasks or POST
// /api/jobs/explore) and is captured here into a request-scoped
// AsyncLocalStorage context, because:
//
//   • the task-creation routes live in integrator-owned src/platform/server.js
//     (not edited by this task) and destructure a fixed field list — the flag
//     cannot ride their explicit arguments;
//   • the pipeline runs asynchronously from within the same request chain:
//     v1 (runTask → cloneUrl) executes entirely inside the request's async
//     context, and v2 reads the flag synchronously inside
//     exploration-runner.queueExploration (which serializes it into the job
//     payload, so it also survives the BullMQ worker process boundary).
//
// VALIDATION (fail fast, clean error): an opted-in request with NO configured
// ad zone is rejected with HTTP 400 before any task is created — monetize is
// a real feature, not a silent no-op. Zone configuration is env-driven and
// read per call (MONETAG_ZONE_ID_* / ADSTERRA_ZONE_ID_* — see
// src/monetization/ad-providers.js and .env.example).
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — not edited here).
// Mount AFTER express.json() and BEFORE the task routes:
//
//   import { monetizeOptInMiddleware } from "./ads-optin.js";
//   app.use(monetizeOptInMiddleware());
//
// Until the integrator merges that line, scripts/test-ad-rendering.mjs applies
// the identical composition dynamically to the booted server (the sanctioned
// listeners("request") pattern used by scripts/test-ui-onboarding.mjs).
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { configuredCloneAdZones } from "../runtimeTemplate.js";

const storage = new AsyncLocalStorage();

// true only inside a request scope that opted in AND passed validation
export function requestMonetizeOptIn() {
  return storage.getStore()?.monetize === true;
}

// validation error message for the current env posture, or null when at least
// one official zone is configured
export function monetizeConfigError() {
  const zones = configuredCloneAdZones();
  if (zones.length) return null;
  return (
    "monetize opt-in requires ad-zone configuration: set at least one of " +
    "MONETAG_ZONE_ID_HEADER, MONETAG_ZONE_ID_FOOTER, ADSTERRA_ZONE_ID_HEADER, " +
    "ADSTERRA_ZONE_ID_FOOTER (see .env.example) — refusing to create a " +
    "monetized clone with no official ad zones configured"
  );
}

// best-effort audit line (platform-data/ad-optins.json) so opt-ins are
// inspectable alongside the honest ad delivery log; never throws
function recordOptIn(entry) {
  try {
    const file = path.join(process.cwd(), "platform-data", "ad-optins.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let entries = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(raw.entries)) entries = raw.entries;
    } catch { /* first entry */ }
    entries.push(entry);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: entries.slice(-200) }, null, 2));
  } catch { /* the request itself is the source of truth */ }
}

const TASK_ROUTES = new Set(["/api/tasks", "/api/jobs/explore"]);

export function monetizeOptInMiddleware() {
  return function monetizeOptIn(req, res, next) {
    try {
      const optedIn =
        req.method === "POST" &&
        TASK_ROUTES.has((req.path || "").replace(/\/+$/, "") || req.originalUrl?.split("?")[0]) &&
        (req.body?.monetize === true || req.body?.monetize === "true");

      if (!optedIn) return next(); // policy-safe default: no scope, no slots

      const configError = monetizeConfigError();
      if (configError) {
        return res.status(400).json({ error: configError });
      }
      recordOptIn({
        at: new Date().toISOString(),
        route: req.path,
        url: req.body?.url || null,
        actorId: req.userId || null,
      });
      // the whole downstream handler (and everything it starts) sees the opt-in
      return storage.run({ monetize: true }, () => next());
    } catch (e) {
      console.warn(`[ads] monetize opt-in middleware failed open-safe: ${String(e?.message || e).slice(0, 160)}`);
      return next();
    }
  };
}
