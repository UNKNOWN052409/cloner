// Session recovery (task 4.5.3): import an exported package (the one-click
// export ZIP + its context.json) and resume the pipeline from where the export
// left off.
//
// Flow (all REAL — no mock file formats, no simulated zips):
//   1. POST /api/recovery/import  (auth + tenant-scoped) — accepts the raw
//      export ZIP (application/zip). The package is extracted, context.json is
//      validated structurally, its canonical-integrity digest is re-verified
//      (any post-export modification → reject), and EVERY evidence pointer is
//      validated hash-for-hash against the extracted files (fail-closed: one
//      missing or tampered file rejects the whole package; nothing is
//      materialized on failure).
//   2. A recoverable task shell is recreated: exploration artifacts land under
//      the caller's tenant scope (artifacts/<orgId>/<newJobId>/ for org
//      callers, artifacts/<newJobId>/ legacy root for personal scope), the
//      manifest is re-keyed to the new job id with a recovery lifecycle header,
//      and the project tree is restored when reconstruction was already
//      complete at export time.
//   3. POST /api/recovery/:jobId/resume (owner-scoped) — re-derives the CURRENT
//      partial state from disk and re-runs the remaining stages
//      (exploration → reconstruction → verification) to completion. Session
//      credentials were shredded at export (spec §10) — resumed exploration
//      runs from the recorded URL WITHOUT cookies/storage, which the resume
//      plan states explicitly. The URL is re-validated through the same
//      SSRF guard (src/security/url-guard.js) a fresh job would go through —
//      the imported context is untrusted input, never trusted routing data.
//
// Router mount (src/platform/server.js is INTEGRATOR-OWNED):
//   app.use("/api/recovery", createRecoveryRouter({ authRequired, tenantScope: resolveTenantScope }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import express, { Router } from "express";
import { authRequired as defaultAuthRequired } from "../auth/auth-middleware.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { normClock, writeLifecycle, expiryFor, writeIntegrityManifest, INTEGRITY_MANIFEST_NAME } from "../storage/artifact-lifecycle.js";
import {
  CONTEXT_FILE,
  validateContextStructure, verifyContextIntegrity, validateEvidenceHashes,
  derivePartialState, buildResumePlan, ContextValidationError,
} from "./export-context.js";

export class RecoveryError extends Error {
  constructor(message, { status = 400, detail = null } = {}) {
    super(message);
    this.name = "RecoveryError";
    this.status = status;
    this.detail = detail;
  }
}

// ---------- paths + shell registry (platform-data/recovery/<jobId>.json) ----------

export function recoveryDir(base = process.cwd()) {
  return path.join(base, "platform-data", "recovery");
}
export function recoveryShellPath(jobId, base = process.cwd()) {
  return path.join(recoveryDir(base), `${jobId}.json`);
}
export function loadRecoveryShell(jobId, base = process.cwd()) {
  try { return JSON.parse(fs.readFileSync(recoveryShellPath(jobId, base), "utf8")); } catch { return null; }
}
export function saveRecoveryShell(shell, base = process.cwd()) {
  fs.mkdirSync(recoveryDir(base), { recursive: true });
  fs.writeFileSync(recoveryShellPath(shell.jobId, base), JSON.stringify(shell, null, 2));
  return shell;
}
export function listRecoveryShells(base = process.cwd()) {
  let names;
  try { names = fs.readdirSync(recoveryDir(base)); } catch { return []; }
  return names.filter((n) => n.endsWith(".json")).map((n) => { try { return JSON.parse(fs.readFileSync(path.join(recoveryDir(base), n), "utf8")); } catch { return null; } }).filter(Boolean);
}
export function deleteRecoveryShell(jobId, base = process.cwd()) {
  try { fs.rmSync(recoveryShellPath(jobId, base), { force: true }); return true; } catch { return false; }
}

// ids are generated here (never taken from the imported context — a context
// must not be able to squat an existing job id)
function makeRecoveryJobId() {
  return "rec-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function safeOrgId(orgId) {
  const s = String(orgId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new RecoveryError("orgId must match [A-Za-z0-9_-]{1,64}", { status: 400 });
  return s;
}

// ---------- ZIP extraction (real system tools — same posture as exporter.makeZip) ----------

export function extractZip(zipPath, destDir) {
  const q = (s) => s.replace(/'/g, "''");
  const win = process.platform === "win32";
  const cmd = win ? "powershell" : "unzip";
  const args = win
    ? ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Path '${q(zipPath)}' -DestinationPath '${q(destDir)}' -Force`]
    : ["-q", zipPath, "-d", destDir];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new RecoveryError(`package extraction failed (${win ? "PowerShell Expand-Archive" : "unzip"}): ${[err.message, String(stderr || "")].filter(Boolean).join(" — ").slice(0, 300)}`, { status: 400 }));
      else resolve(destDir);
    });
  });
}

// ---------- access control (mirrors exploration-runner.identityCanAccessJob) ----------

// admin → yes; anonymous → no; personal shell → owner only; org shell → current
// member of the owning org (membership re-checked live). Never throws.
export async function canAccessShell(shell, identity) {
  try {
    if (!shell) return false;
    if (!identity?.userId) return false;
    if (identity.role === "admin") return true;
    const owner = shell.owner || null;
    if (!owner) return false; // recovery shells are always owned — fail closed
    if (owner.orgId) {
      const { getOrgMember } = await import("../database/tenant-repository.js");
      const member = await getOrgMember(owner.orgId, identity.userId);
      return !!member;
    }
    return owner.userId === identity.userId;
  } catch {
    return false;
  }
}

function publicShell(shell) {
  const { context, ...rest } = shell;
  return {
    ...rest,
    sourceTask: shell.sourceTask || null,
    partialState: context?.partialState || null,
    resumePlan: context?.resumePlan || null,
    evidenceCount: context?.evidence?.pointers?.length ?? 0,
  };
}

// orgId of a shell (owner.orgId first, fallback to the flat field)
function orgIdOf(shell) {
  return shell?.owner?.orgId || shell?.orgId || null;
}

// ---------- import ----------

// Import one exported package. Fails closed: structural problems, a modified
// context, or any evidence hash mismatch abort BEFORE anything is materialized.
export async function importRecoveryPackage({ zipPath, base = process.cwd(), orgId = null, owner = null, clock = null } = {}) {
  const nowMs = normClock(clock);
  if (!owner?.userId) throw new RecoveryError("recovery import requires an owner identity", { status: 401 });
  if (orgId != null) orgId = safeOrgId(orgId);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-recovery-"));
  try {
    await extractZip(zipPath, tmp);
    const ctxFile = path.join(tmp, CONTEXT_FILE);
    if (!fs.existsSync(ctxFile)) throw new RecoveryError(`package has no ${CONTEXT_FILE} at its root — not a context export`, { status: 400 });
    let context;
    try { context = JSON.parse(fs.readFileSync(ctxFile, "utf8")); } catch (e) {
      throw new RecoveryError(`${CONTEXT_FILE} is not valid JSON: ${String(e.message).slice(0, 120)}`, { status: 400 });
    }
    validateContextStructure(context); // throws ContextValidationError (400)
    const integrity = verifyContextIntegrity(context);
    if (!integrity.ok) throw new RecoveryError(`${CONTEXT_FILE} rejected: ${integrity.reason}`, { status: 400 });

    // hash-for-hash validation of every pointer against the extracted tree —
    // ALL failures collected, then one rejection; nothing materialized on failure
    const evidence = validateEvidenceHashes(context, (rel) => path.join(tmp, rel));

    // materialize the shell under the caller's tenant scope
    const jobId = makeRecoveryJobId();
    const artifactsRoot = orgId ? path.join(base, "artifacts", orgId) : path.join(base, "artifacts");
    const artifactsDir = path.join(artifactsRoot, jobId);
    const projectDir = artifactsDir + "-project";
    fs.mkdirSync(artifactsDir, { recursive: true });

    // exploration evidence tree = everything except context.json + the project tree
    for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (entry.name === CONTEXT_FILE || entry.name === "project") continue;
      fs.cpSync(path.join(tmp, entry.name), path.join(artifactsDir, entry.name), { recursive: true });
    }
    // project tree restored only when reconstruction had completed at export —
    // otherwise the resume plan re-runs reconstruction from the evidence
    let projectRestored = false;
    const projectSrc = path.join(tmp, "project");
    if (context.partialState?.reconstruction?.completed === true && fs.existsSync(path.join(projectSrc, "index.html"))) {
      fs.cpSync(projectSrc, projectDir, { recursive: true });
      projectRestored = true;
    }

    // re-key the manifest to the NEW job id + recovery lifecycle header
    // (the original manifest bytes were already hash-validated above)
    const manifestFile = path.join(artifactsDir, "manifest.json");
    if (fs.existsSync(manifestFile)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        m.jobId = jobId;
        fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
      } catch { /* a corrupt manifest stays corrupt — partialState already records exploration state */ }
    }
    writeLifecycle(artifactsDir, {
      jobId,
      orgId: orgId || null,
      recoveredFrom: context.task?.jobId || null,
      recoveredAt: new Date(nowMs).toISOString(),
      lifecycleState: "active",
      retentionClass: "completed",
      pinned: false,
      expiresAt: expiryFor(nowMs, "completed", { clock: nowMs }),
    });

    const shell = {
      jobId,
      kind: "recovery-shell",
      status: "recoverable",
      url: context.task?.originalUrl || null,
      owner: { userId: owner.userId || null, orgId: orgId || null },
      sourceTask: { jobId: context.task?.jobId || null, originalUrl: context.task?.originalUrl || null, exportedAt: context.exportedAt || null, explorationStatus: context.task?.explorationStatus || null },
      artifactsDir,
      projectDir,
      projectRestored,
      orgId: orgId || null,
      context, // full exported context (pointers are hashes — safe to keep)
      evidence,
      createdAt: new Date(nowMs).toISOString(),
      history: [{ at: new Date(nowMs).toISOString(), event: `imported from export of ${context.task?.jobId || "?"} (${evidence.validated}/${evidence.total} evidence pointers validated)` }],
    };
    saveRecoveryShell(shell, base);
    return { jobId, shell: publicShell(shell), evidence, context };
  } catch (e) {
    if (e instanceof RecoveryError || e instanceof ContextValidationError) throw e;
    throw new RecoveryError(`recovery import failed: ${String(e?.message || e).slice(0, 300)}`, { status: 500 });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ---------- resume ----------

// Re-run the remaining pipeline stages to completion. State is re-derived from
// disk at resume time (the context markers describe the EXPORT, not now).
export async function resumeRecoveryJob({ jobId, identity, base = process.cwd(), clock = null } = {}) {
  const shell = loadRecoveryShell(jobId, base);
  if (!shell) throw new RecoveryError("recovery shell not found", { status: 404 });
  if (!(await canAccessShell(shell, identity))) throw new RecoveryError("recovery shell not found", { status: 404 }); // no existence leak
  if (["completed", "completed_with_limitations"].includes(shell.status)) {
    throw new RecoveryError(`recovery shell already finished (${shell.status})`, { status: 409 });
  }
  const nowMs = normClock(clock);
  const artifactsDir = shell.artifactsDir;
  const projectDir = shell.projectDir || artifactsDir + "-project";
  const hist = (event) => { shell.history.push({ at: new Date(nowMs + shell.history.length).toISOString(), event }); };

  shell.status = "resuming";
  hist("resume started");
  let ran = [];

  try {
    // ---- stage: exploration (only when the evidence tree has no terminal manifest) ----
    let partial = derivePartialState({ artifactsDir, projectDir });
    if (!partial.exploration.completed) {
      const url = shell.context?.task?.originalUrl || shell.url;
      if (!/^https?:\/\//i.test(String(url || ""))) throw new RecoveryError("cannot resume exploration — no http(s) originalUrl in the exported context", { status: 400 });
      const guard = await validatePublicUrl(url);
      if (!guard.ok) throw new RecoveryError(`cannot resume exploration — url rejected: ${guard.error}`, { status: 400 });
      // session credentials were shredded at export (spec §10) — resume WITHOUT them
      const { runExplorationJob } = await import("../pipeline/exploration-pipeline.js");
      const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(artifactsDir, "manifest.json"), "utf8")); } catch { return null; } })();
      const budgets = manifest?.configuration?.budgets || null;
      shell.status = "exploring";
      hist(`exploration re-run from ${url} (no session credentials — shredded at export)`);
      const artifactsRoot = path.dirname(artifactsDir);
      await runExplorationJob({
        url,
        artifactsRoot,
        jobId,
        config: { policy: budgets ? { budgets } : undefined, sessionId: "recovery" },
      });
      // the pipeline wrote a FRESH manifest.json (no lifecycle header) — restore
      // the recovery provenance so the org sweep/retention machinery still sees it
      writeLifecycle(artifactsDir, {
        jobId,
        orgId: orgIdOf(shell),
        recoveredFrom: shell.sourceTask?.jobId || null,
        recoveredAt: new Date(nowMs + shell.history.length).toISOString(),
        lifecycleState: "active",
        retentionClass: "completed",
        pinned: false,
        expiresAt: expiryFor(nowMs, "completed", { clock: nowMs }),
      });
      ran.push("exploration");
      partial = derivePartialState({ artifactsDir, projectDir });
      hist(`exploration re-run finished: ${partial.exploration.status}`);
    }

    // ---- stage: reconstruction ----
    if (!partial.reconstruction.completed) {
      const { reconstructFromArtifacts } = await import("../reconstruction/reconstruction-pipeline.js");
      shell.status = "reconstructing";
      hist("reconstruction re-run");
      await reconstructFromArtifacts(artifactsDir, { outDir: projectDir });
      ran.push("reconstruction");
      partial = derivePartialState({ artifactsDir, projectDir });
      hist("reconstruction re-run finished");
    }

    // ---- stage: verification ----
    if (!partial.verification.completed) {
      const { verifyTask } = await import("../reconstruction/verify.js");
      shell.status = "verifying";
      hist("verification re-run");
      const verification = await verifyTask(artifactsDir);
      ran.push("verification");
      hist(`verification re-run ${verification.passed ? "PASSED" : "completed with failures"}`);
    }

    // ---- terminal state ----
    partial = derivePartialState({ artifactsDir, projectDir });
    // resume legitimately changed the tree (reconstruction reports, verification
    // report) — re-pin the G5.4 integrity manifest when one is managed, so the
    // recovered job stays exportable (exportV2Task refuses a drifted tree)
    if (fs.existsSync(path.join(artifactsDir, INTEGRITY_MANIFEST_NAME))) writeIntegrityManifest(artifactsDir);
    shell.status = partial.verification.completed && partial.verification.passed ? "completed" : "completed_with_limitations";
    shell.partialStateAfterResume = partial;
    shell.resumePlan = buildResumePlan(partial, { originalUrl: shell.context?.task?.originalUrl || null });
    shell.resumeRanStages = ran;
    shell.finishedAt = new Date(nowMs + shell.history.length).toISOString();
    hist(`resume finished: ${shell.status} (stages re-run: ${ran.join(", ") || "none"})`);
    saveRecoveryShell(shell, base);
    return { jobId: shell.jobId, status: shell.status, ranStages: ran, partialState: partial, history: shell.history.slice(-6) };
  } catch (e) {
    shell.status = "error";
    shell.error = String(e?.message || e).slice(0, 300);
    hist(`resume failed: ${shell.error}`);
    saveRecoveryShell(shell, base);
    if (e instanceof RecoveryError) throw e;
    throw new RecoveryError(`resume failed: ${shell.error}`, { status: 500 });
  }
}

// ---------- router (integrator mount line in the header comment) ----------

export function createRecoveryRouter({ authRequired = defaultAuthRequired, tenantScope = null, base = process.cwd() } = {}) {
  const router = Router();
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e?.status || 500;
      res.status(status).json({ error: String(e?.message || "internal error").slice(0, 300), ...(e?.detail ? { detail: e.detail } : {}) });
    });
  };
  // tenant scope applies only when the caller asks for an org-scoped import;
  // personal scope (orgId absent) is the authenticated user's own workspace.
  // A malformed org id is a CLIENT error (400) with the most precise reason —
  // checked BEFORE the membership verdict, so traversal-shaped ids can never be
  // confused with (or ride on top of) an authorization denial.
  const orgScope = (req, res, next) => {
    const orgId = req.query.orgId ? String(req.query.orgId) : null;
    if (orgId != null) {
      try { safeOrgId(orgId); } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    return tenantScope ? tenantScope(req, res, next) : next();
  };

  router.post("/import", authRequired, orgScope, express.raw({ type: ["application/zip", "application/octet-stream", "application/x-zip-compressed"], limit: "1024mb" }), wrap(async (req, res) => {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new RecoveryError("ZIP body required — send the exported package as application/zip", { status: 400 });
    }
    const tmpZip = path.join(os.tmpdir(), `recovery-import-${process.pid}-${crypto.randomBytes(4).toString("hex")}.zip`);
    try {
      fs.writeFileSync(tmpZip, req.body);
      const orgId = req.query.orgId ? String(req.query.orgId) : null;
      const out = await importRecoveryPackage({ zipPath: tmpZip, base, orgId, owner: { userId: req.userId } });
      res.status(201).json({ ok: true, jobId: out.jobId, status: out.shell.status, sourceTask: out.shell.sourceTask, evidence: out.evidence, projectRestored: out.shell.projectRestored, resumePlan: out.shell.resumePlan, partialState: out.shell.partialState });
    } finally {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    }
  }));

  router.get("/", authRequired, wrap(async (req, res) => {
    const identity = { userId: req.userId, role: req.userRole };
    const out = [];
    for (const shell of listRecoveryShells(base)) {
      if (await canAccessShell(shell, identity)) out.push(publicShell(shell));
    }
    res.json(out);
  }));

  router.get("/:jobId", authRequired, wrap(async (req, res) => {
    const shell = loadRecoveryShell(req.params.jobId, base);
    if (!shell || !(await canAccessShell(shell, { userId: req.userId, role: req.userRole }))) throw new RecoveryError("recovery shell not found", { status: 404 });
    res.json(publicShell(shell));
  }));

  router.post("/:jobId/resume", authRequired, wrap(async (req, res) => {
    const out = await resumeRecoveryJob({ jobId: req.params.jobId, identity: { userId: req.userId, role: req.userRole }, base });
    res.json({ ok: true, ...out });
  }));

  return router;
}
