// Per-task monetize flag — read/update API (task 4.5.5 ad-clone-integration).
//
// POLICY (the ask, verbatim intent): generated clones get ad slots ONLY when
// the task owner OPTED IN for that clone. The flag defaults to OFF — the
// policy-safe default — and is settable via this API. Ad markup lives ONLY
// inside generated clones: the platform itself never renders ad inventory
// (backend-only feature, no platform screens).
//
// WHAT THIS MODULE OWNS
//   • the durable per-task flag store (platform-data/ad-config.json),
//   • the policy validation on opt-in (a clone may NOT be monetized while no
//     official ad zone is configured — clean 400, mirroring ads-optin.js),
//   • artifact re-application: flipping the flag on an ALREADY-GENERATED
//     clone rewrites that clone's html files (withAdSlots in, withoutAdSlots
//     out — both idempotent, both cloner-namespaced). The served preview and
//     the exported artifact therefore always match the owner's current choice.
//
// WHAT THIS MODULE DOES NOT OWN
//   • task creation-time opt-in (rides the request scope via ads-optin.js and
//     the generation hooks in cloneUrl.js / pipeline-job.js);
//   • ad provider markup (src/monetization/ad-providers.js, official tags
//     only) and slot serving (src/monetization/ad-slots.js);
//   • integrator-owned src/platform/server.js — see the mount line below.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — not edited here).
// Mount AFTER express.json() and after the auth middleware is available:
//
//   import { adConfigRouter } from "./monetization/ad-config-api.js";
//   app.use("/api/ad-config", adConfigRouter());
//
//   ROUTES  GET /api/ad-config/tasks/:id   loopback-anonymous (legacy dashboard
//                                          posture) or Bearer; an authenticated
//                                          NON-owner gets 404 (no existence leak)
//           PUT /api/ad-config/tasks/:id   owner or admin (body { monetize:
//                                          boolean }); loopback-anonymous may
//                                          only touch ownerless local tasks
//
// Until the integrator merges that line, scripts/test-ad-rendering.mjs applies
// the identical composition dynamically to the booted server (the sanctioned
// listeners("request") pattern used by the other platform suites).
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { taskDir, outDir, loadTask, updateTask } from "../platform/tasks.js";
import {
  configuredCloneAdZones,
  resolveCloneAdConfig,
  withAdSlots,
  withoutAdSlots,
} from "../runtimeTemplate.js";
import { monetizeConfigError } from "../platform/ads-optin.js";
import { validateSession } from "../auth/auth-service.js";
import { authenticateCookie, isLoopback } from "../platform/ws-auth.js";

// ---------------------------------------------------------------------------
// durable flag store — platform-data/ad-config.json (tiny, sync-written like
// the sibling task store; atomic tmp+rename so a crash never leaves a torn
// file). Only explicit API writes land here; creation-time opt-ins stay
// readable through the derived sources below.
// ---------------------------------------------------------------------------

function storePath() {
  return path.join(process.cwd(), "platform-data", "ad-config.json");
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    if (raw && typeof raw === "object" && raw.tasks && typeof raw.tasks === "object") {
      return { version: 1, tasks: raw.tasks };
    }
  } catch { /* first write or torn legacy file → empty store */ }
  return { version: 1, tasks: {} };
}

function writeStore(store) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// task resolution — v1 (platform-data/<id>/task.json) and v2 (exploration
// registry). The exploration-runner import is lazy: the registry pulls the
// queue stack, and callers that only handle v1 tasks must not pay for it.
// ---------------------------------------------------------------------------

async function resolveTaskContext(taskId) {
  const meta = loadTask(taskId);
  if (meta) {
    return {
      kind: "v1",
      exists: true,
      owner: meta.userId || null,
      meta,
      // v1 clone site = the out dir only (snapshot/evidence files are not
      // clone pages and never carry ad markup)
      cloneDirs: [outDir(taskId)],
    };
  }
  try {
    const { getExplorationJob } = await import("../platform/exploration-runner.js");
    const job = getExplorationJob(taskId);
    if (job) {
      const cloneDirs = [];
      if (job.artifactsDir) cloneDirs.push(`${job.artifactsDir}-project`); // the generated site
      const owner = job.owner || {};
      return {
        kind: "v2",
        exists: true,
        owner: owner.userId || null,
        job,
        cloneDirs,
      };
    }
  } catch { /* registry unavailable — treat as unknown */ }
  return { kind: null, exists: false, owner: null, cloneDirs: [] };
}

// Deterministic artifact evidence: does the clone's own index.html carry the
// cloner ad-zone marker? (Written at generation time exactly when the owner
// had opted in.) Returns true/false, or null when no generated index.html
// exists yet — "unknown", never a guess.
function artifactAdState(cloneDirs) {
  for (const dir of cloneDirs || []) {
    try {
      const file = path.join(dir, "index.html");
      if (!fs.existsSync(file)) continue;
      const html = fs.readFileSync(file, "utf8");
      return html.includes("data-cloner-ad-zone");
    } catch { /* unreadable artifact → try the next root */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// read — resolve the CURRENT per-task flag from real sources, in priority
// order: explicit API store → task.json field → v2 job-history marker →
// generated-artifact evidence → default OFF. Every step is a real, recorded
// fact; nothing here is inferred from timestamps or fuzzy joins.
// ---------------------------------------------------------------------------

export async function getTaskMonetizeState(taskId) {
  const ctx = await resolveTaskContext(taskId);
  const store = readStore();
  const rec = ctx.exists ? store.tasks[taskId] : null;

  let monetize = null;
  let source = "default-off";
  let updatedAt = null;
  let updatedBy = null;

  if (rec) {
    monetize = rec.monetize === true;
    source = "api";
    updatedAt = rec.updatedAt || null;
    updatedBy = rec.updatedBy || null;
  } else if (ctx.kind === "v1" && typeof ctx.meta.monetize === "boolean") {
    monetize = ctx.meta.monetize;
    source = "task";
  } else if (
    ctx.kind === "v2" &&
    Array.isArray(ctx.job?.history) &&
    ctx.job.history.some((h) => String(h?.event || "").startsWith("monetize: opted in"))
  ) {
    // pipeline-job.js writes that exact event when the v2 owner opted in
    monetize = true;
    source = "job-history";
  } else if (ctx.exists) {
    const seen = artifactAdState(ctx.cloneDirs);
    if (seen !== null) {
      monetize = seen;
      source = "artifacts";
    }
  }

  return {
    taskId,
    exists: ctx.exists === true,
    taskKind: ctx.kind,
    monetize: monetize === true, // policy-safe default when every source is silent
    source,
    updatedAt,
    updatedBy,
    owner: ctx.owner,
    zonesConfigured: configuredCloneAdZones().length > 0,
  };
}

// ---------------------------------------------------------------------------
// write — validate, persist, and re-apply to the generated artifacts
// ---------------------------------------------------------------------------

// Walk one clone dir and rewrite every .html file (bounded depth — clone
// trees are shallow; v2 pages may nest, e.g. account/login.html). Generated
// framework SOURCE trees are skipped: v1's scaffold/ holds component
// templates, not the served clone pages, and ad slots belong only in the
// delivered pages. Returns { scanned, changed, files }.
const SKIP_DIRS = new Set(["scaffold", "node_modules", "_reference"]);
function applyToCloneDir(dir, adConfig) {
  const out = { scanned: 0, changed: 0, files: [] };
  if (!dir) return out;
  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && !SKIP_DIRS.has(e.name)) walk(full, depth + 1);
        continue;
      }
      if (!/\.html?$/i.test(e.name)) continue;
      out.scanned += 1;
      try {
        const html = fs.readFileSync(full, "utf8");
        const next = adConfig ? withAdSlots(html, adConfig, { page: e.name }) : withoutAdSlots(html);
        if (next !== html) {
          fs.writeFileSync(full, next);
          out.changed += 1;
          out.files.push(path.relative(dir, full).replace(/\\/g, "/"));
        }
      } catch (e) {
        // one unreadable file never blocks the rest of the clone
        console.warn(`[ads] ad-config apply failed for ${e.name || full}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  };
  walk(dir, 0);
  return out;
}

// Set the per-task monetize flag. Permission and policy are validated HERE;
// the HTTP layer only maps the returned status. Never throws.
export async function setTaskMonetize(taskId, monetize, { actorId = null, actorRole = null } = {}) {
  const ctx = await resolveTaskContext(taskId);
  if (!ctx.exists) return { ok: false, status: 404, error: "task not found" };

  const isOwner = ctx.owner != null && actorId != null && String(actorId) === String(ctx.owner);
  const isAdmin = actorRole === "admin";
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: "only the task owner or an admin may change the monetize flag" };
  }

  if (monetize === true) {
    const configError = monetizeConfigError();
    if (configError) return { ok: false, status: 400, error: configError };
  }

  // 1. durable store (the API's own record of the choice)
  const store = readStore();
  store.tasks[taskId] = {
    monetize: monetize === true,
    updatedAt: new Date().toISOString(),
    updatedBy: String(actorId || "admin"),
    source: "api",
  };
  writeStore(store);

  // 2. the task's own history (human-auditable, same channel as every other
  //    task lifecycle event)
  const eventText = `ad monetize ${monetize === true ? "opted IN" : "opted OUT"} via ad-config API`;
  try {
    if (ctx.kind === "v1") updateTask(taskId, { monetize: monetize === true }, eventText);
    else if (ctx.kind === "v2" && Array.isArray(ctx.job?.history)) {
      ctx.job.history.push({ at: new Date().toISOString(), event: eventText });
    }
  } catch (e) {
    // store is already authoritative; a history write must not fail the flag
    console.warn(`[ads] ad-config history note failed for ${taskId}: ${String(e?.message || e).slice(0, 120)}`);
  }

  // 3. re-apply to an ALREADY-GENERATED clone so the served/exported artifact
  //    matches the flag immediately (withAdSlots / withoutAdSlots — both
  //    idempotent, both cloner-namespaced)
  const adConfig = monetize === true ? resolveCloneAdConfig() : null;
  let artifacts = { scanned: 0, changed: 0, files: [] };
  if (ctx.cloneDirs.length) {
    for (const dir of ctx.cloneDirs) {
      const r = applyToCloneDir(dir, adConfig);
      artifacts.scanned += r.scanned;
      artifacts.changed += r.changed;
      artifacts.files.push(...r.files);
    }
  }

  const state = await getTaskMonetizeState(taskId);
  return { ok: true, state, artifacts };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

export function adConfigRouter() {
  const router = Router();
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      res.status(500).json({ error: String((e && e.message) || "internal error").slice(0, 300) });
    });
  };

  // Identity resolution with EXACTLY the platform's G5.5 semantics
  // (src/platform/server.js localOrAuthed): Authorization header first, then
  // the real cloner_session cookie (browser navigations and cookie-carrying
  // fetches cannot set headers), then the loopback-anonymous legacy posture.
  // Returns "ok" with req.userId/userRole set, or "denied" (response sent).
  async function resolveIdentity(req, res) {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) {
      try {
        const session = await validateSession(header.slice(7));
        if (!session) {
          res.status(401).json({ error: "invalid or expired session" });
          return "denied";
        }
        req.userId = session.userId;
        req.userEmail = session.email;
        req.userRole = session.role;
        return "ok";
      } catch {
        res.status(500).json({ error: "auth check failed" });
        return "denied";
      }
    }
    try {
      const cookieIdentity = await authenticateCookie(req);
      if (cookieIdentity) {
        req.userId = cookieIdentity.userId;
        req.userEmail = cookieIdentity.email;
        req.userRole = cookieIdentity.role;
        return "ok";
      }
    } catch { /* invalid cookie → fall through to the anonymous rules */ }
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.status(401).json({ error: "authentication required" });
      return "denied";
    }
    req.userId = null; // loopback dashboard legacy posture
    return "ok";
  }

  // GET: identity resolved with the platform's G5.5 semantics (Bearer →
  // cloner_session cookie → loopback-anonymous). An authenticated NON-owner
  // gets 404 — no existence leak across tenants.
  router.get("/tasks/:id", wrap(async (req, res) => {
    if ((await resolveIdentity(req, res)) === "denied") return;
    await readHandler(req, res);
  }));

  async function readHandler(req, res) {
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(404).json({ error: "task not found" });
    const state = await getTaskMonetizeState(id);
    if (!state.exists) return res.status(404).json({ error: "task not found" });
    if (req.userId) {
      const isOwner = state.owner != null && String(req.userId) === String(state.owner);
      if (!isOwner && req.userRole !== "admin") return res.status(404).json({ error: "task not found" });
    }
    res.json(state);
  }

  // PUT: same identity resolution. An anonymous (loopback) caller may only
  // touch ownerless local tasks (dashboard legacy posture — the same rule as
  // the platform's destructive surfaces).
  router.put("/tasks/:id", express.json({ limit: "8kb" }), wrap(async (req, res) => {
    if ((await resolveIdentity(req, res)) === "denied") return;
    await putHandler(req, res);
  }));

  async function putHandler(req, res) {
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(404).json({ error: "task not found" });

    const body = req.body || {};
    if (typeof body.monetize !== "boolean") {
      return res.status(400).json({ error: "body must be { monetize: boolean }" });
    }

    // ownership pre-check for the loopback-anonymous posture (ownerless tasks
    // only); setTaskMonetize re-checks owner/admin for identified callers
    if (!req.userId) {
      const state = await getTaskMonetizeState(id);
      if (!state.exists) return res.status(404).json({ error: "task not found" });
      if (state.owner != null) {
        return res.status(403).json({ error: "authentication required to change the monetize flag of an owned task" });
      }
    }

    const r = await setTaskMonetize(id, body.monetize, { actorId: req.userId, actorRole: req.userRole });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, ...r.state, artifacts: r.artifacts });
  }

  router.use((err, _req, res, _next) => {
    res.status(500).json({ error: String((err && err.message) || "internal error").slice(0, 300) });
  });

  return router;
}
