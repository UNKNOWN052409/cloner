// Artifact storage lifecycle (task 4.0.5): per-tenant artifact roots, retention
// tiers, injectable-clock sweeps with STAGED deletion, usage accounting and the
// credential-shred guarantee — on top of the existing artifact store
// (src/storage/artifact-store.js, unmodified) and the existing export pipeline
// (src/platform/exporter.js, unmodified — hooks documented at the bottom).
//
// Layout model:
//   NEW jobs      artifacts/<orgId>/<jobId>/…   (manifest.json carries a `lifecycle` header)
//   LEGACY jobs   artifacts/<jobId>/…           (pre-lifecycle layout — still readable, see
//                                                resolveArtifactPath; never deleted by
//                                                default sweeps, see planSweep)
//
// Safety rules (plan risk note: never delete on age alone):
//   1. Only org-scoped job dirs WITH a valid manifest lifecycle header can be
//      swept, and only when expiresAt <= now (injectable clock) and not pinned.
//   2. Deletion is STAGED: mark manifest `lifecycleState:"staged-delete"` →
//      rename into artifacts/<orgId>/.lifecycle-staging/<job>.<pid>.<ts> →
//      rm. A crash at any point leaves the job recoverable (rename-back is a
//      restore) or already inside staging, where the NEXT sweep finalizes it.
//   3. Orphan detection: job dirs without a readable manifest are REPORTED,
//      never removed unless explicitly allowed — and legacy top-level orphans
//      are never removed at all (could be pre-lifecycle user data).
//   4. Credentials never survive retention: finalizeExport() verifies the ZIP
//      integrity FIRST (fail-closed — on failure nothing is removed) and only
//      then shreds private/ + sensitive-named files, preserving the guarantee
//      from src/platform/exporter.js / src/platform/tasks.js.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createArtifactStore } from "./artifact-store.js";
import { isSensitiveName } from "../platform/exporter.js";
import { query as dbQuery } from "../database/client.js";

export const STAGING_DIRNAME = ".lifecycle-staging";
const DAY_MS = 86_400_000;

// ---------- clock (injectable — tests pin time) ----------
// clock may be () => number, a number, or an ISO string.
export function normClock(clock) {
  if (typeof clock === "function") return Math.floor(clock());
  if (typeof clock === "number" && Number.isFinite(clock)) return Math.floor(clock);
  if (typeof clock === "string") {
    const t = Date.parse(clock);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

export function defaultBase() {
  return process.cwd();
}

// ---------- paths ----------
export function artifactPathFor(orgId, jobId, base = defaultBase()) {
  if (!orgId) throw new Error("artifactPathFor: orgId is required for NEW jobs");
  if (!jobId) throw new Error("artifactPathFor: jobId is required");
  return path.join(base, "artifacts", String(orgId), String(jobId));
}

export function legacyArtifactPath(jobId, base = defaultBase()) {
  if (!jobId) throw new Error("legacyArtifactPath: jobId is required");
  return path.join(base, "artifacts", String(jobId));
}

// Read-side resolution: prefer the org-scoped root, fall back to the legacy
// artifacts/<jobId>/ root (which exploration-runner.js:18 and exporter.js:18
// still write). Returns { path, scope: "org" | "legacy" | "none" }.
export function resolveArtifactPath(jobId, { orgId, base = defaultBase() } = {}) {
  if (orgId) {
    const org = artifactPathFor(orgId, jobId, base);
    if (fs.existsSync(org)) return { path: org, scope: "org" };
  }
  const legacy = legacyArtifactPath(jobId, base);
  if (fs.existsSync(legacy)) return { path: legacy, scope: "legacy" };
  return { path: orgId ? artifactPathFor(orgId, jobId, base) : legacy, scope: "none" };
}

// Drop-in replacement for exporter.js:18 `v2TaskDir(id)` so org-scoped jobs
// export without touching the read-only exporter — the integrator's one-line
// hook is: `function v2TaskDir(id) { return exportV2Dir(id); }`.
export function exportV2Dir(jobId, { orgId, base = defaultBase() } = {}) {
  return resolveArtifactPath(jobId, { orgId, base }).path;
}

// ---------- manifest lifecycle header ----------
export function readManifest(jobDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobDir, "manifest.json"), "utf8"));
  } catch {
    return null; // absent or corrupt → treated as an orphan (never swept)
  }
}

export function writeLifecycle(jobDir, patch) {
  const m = readManifest(jobDir) || {};
  m.lifecycle = { ...(m.lifecycle || {}), ...patch };
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "manifest.json"), JSON.stringify(m, null, 2));
  return m.lifecycle;
}

// ---------- retention tiers ----------
// Per-class defaults (days): temp 1 · failed 7 · everything else follows the
// RETENTION_DAYS env guard (same guard as src/platform/tasks.js sweepExpired:
// garbage/zero/negative → 15). `deleted` projects expire immediately (0d).
export const RETENTION_TIERS = { temp: 1, failed: 7, deleted: 0, completed: null };

export function guardedEnvRetentionDays() {
  const env = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(env) && env > 0 ? env : 15;
}

export function retentionDaysFor(retentionClass, { days } = {}) {
  if (Number.isFinite(days) && days > 0) return days; // explicit call-site override wins
  if (retentionClass === "temp") return RETENTION_TIERS.temp;
  if (retentionClass === "failed") return RETENTION_TIERS.failed;
  if (retentionClass === "deleted") return RETENTION_TIERS.deleted;
  return guardedEnvRetentionDays(); // completed / general
}

export function expiryFor(createdAtMs, retentionClass, { clock = Date.now, days } = {}) {
  const now = normClock(clock);
  const created = Number.isFinite(createdAtMs) ? createdAtMs : now;
  const d = retentionDaysFor(retentionClass, { days });
  return new Date(created + d * DAY_MS).toISOString();
}

// ---------- org-scoped store (wraps createArtifactStore, unmodified) ----------
export function createOrgArtifactStore({ base = defaultBase(), orgId, jobId, retentionClass = "completed", clock = Date.now }) {
  if (!orgId || !jobId) throw new Error("createOrgArtifactStore: orgId and jobId are required");
  const now = normClock(clock);
  const store = createArtifactStore(path.join(base, "artifacts", String(orgId)), String(jobId));
  const dir = store.dirs.root;
  const lifecycle = writeLifecycle(dir, {
    jobId: String(jobId),
    orgId: String(orgId),
    createdAt: new Date(now).toISOString(),
    retentionClass,
    lifecycleState: "active",
    pinned: false,
    expiresAt: expiryFor(now, retentionClass, { clock: now }),
    exportSha256: null,
    credentialsShreddedAt: null,
  });
  return {
    ...store,
    dir,
    lifecycle,
    // pin = never swept (plan step 5: protected projects)
    pin(reason = "") {
      return writeLifecycle(dir, { pinned: true, pinReason: String(reason).slice(0, 200) });
    },
    setRetention(cls, { clock: c = clock, days } = {}) {
      const at = normClock(c); // base the new expiry on NOW, not the creation time
      return writeLifecycle(dir, {
        retentionClass: cls,
        expiresAt: expiryFor(at, cls, { clock: at, days }),
      });
    },
  };
}

// ---------- hashing ----------
export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return h.digest("hex");
}

// ---------- integrity manifest (G5.4: manifest vs disk mismatches) ----------
// The exploration manifest (manifest.json) records WHAT was produced but
// nothing verified the tree afterwards: a modified or missing file exported
// silently (G5.4 hunt — corrupt a page, exportV2Task still ships the ZIP).
// The integrity manifest freezes {relPath → {size, sha256}} for every content
// file at completion time; export (and any other consumer) fails closed when
// the tree no longer matches.
export const INTEGRITY_MANIFEST_NAME = "integrity.json";

// Mutable or derived entries that must never be pinned by the integrity
// manifest: manifest.json carries the lifecycle header (patched by pin /
// setRetention / finalizeExportV2 after completion), export.zip and
// export-staging/ are export byproducts, private/ dies at export time.
function integritySkipEntry(name) {
  return (
    name === "manifest.json" ||
    name === INTEGRITY_MANIFEST_NAME ||
    name === "export.zip" ||
    name === "export-staging" ||
    name === STAGING_DIRNAME ||
    name === "private"
  );
}

export function buildIntegrityManifest(jobDir) {
  const files = {};
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (integritySkipEntry(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        files[r] = { size: st.size, sha256: sha256File(p) };
      }
    }
  };
  walk(jobDir, "");
  return { schemaVersion: 1, createdAt: new Date().toISOString(), fileCount: Object.keys(files).length, files };
}

export function writeIntegrityManifest(jobDir) {
  const m = buildIntegrityManifest(jobDir);
  fs.writeFileSync(path.join(jobDir, INTEGRITY_MANIFEST_NAME), JSON.stringify(m, null, 2));
  return m;
}

// Verify the recorded manifest against the disk. missing/modified FAIL CLOSED
// (ok:false) — they mean a recorded file was tampered with or lost. Extra
// files are REPORTED but tolerated (ok stays true): legitimate post-completion
// stages (verification reports, understanding.json, design-tokens.json in the
// server's run flow) legitimately add unrecorded files, and export.zip itself
// is derived. Planted-extra detection for archives is covered strictly by
// backup-artifacts restore. A job dir without an integrity manifest verifies
// trivially (legacy trees).
export function verifyArtifactIntegrity(jobDir, { manifestFile = INTEGRITY_MANIFEST_NAME } = {}) {
  const out = { ok: true, verified: 0, missing: [], modified: [], extra: [], note: null };
  const mfPath = path.join(jobDir, manifestFile);
  if (!fs.existsSync(mfPath)) {
    out.note = "no integrity manifest (legacy job) — verification skipped";
    return out;
  }
  let mf;
  try {
    mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
  } catch (e) {
    out.ok = false;
    out.note = `integrity manifest unreadable: ${String(e?.message || e)}`;
    return out;
  }
  const listed = mf.files || {};
  for (const [rel, rec] of Object.entries(listed)) {
    const p = path.join(jobDir, ...rel.split("/"));
    if (!fs.existsSync(p)) { out.ok = false; out.missing.push(rel); continue; }
    const st = fs.statSync(p);
    if (!st.isFile() || st.size !== rec.size || sha256File(p) !== rec.sha256) {
      out.ok = false;
      out.modified.push(rel);
      continue;
    }
    out.verified += 1;
  }
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (integritySkipEntry(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !listed[r]) out.extra.push(r); // reported, not fatal (see header)
    }
  };
  walk(jobDir, "");
  return out;
}

// ---------- usage accounting (consumed by 4.0.4 quotas) ----------
// computeUsage(root) — walks an artifacts tree and returns byte/file totals
// split into per-org buckets and the legacy bucket.
export function computeUsage(root = path.join(defaultBase(), "artifacts")) {
  const usage = { root, bytes: 0, files: 0, orgs: {}, legacy: { bytes: 0, files: 0, jobs: 0 } };
  const add = (bucket, n, size) => { bucket.files += n; bucket.bytes += size; };
  let top;
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return usage; }
  for (const t of top) {
    if (!t.isDirectory() || t.name === STAGING_DIRNAME) continue;
    const topDir = path.join(root, t.name);
    if (fs.existsSync(path.join(topDir, "manifest.json"))) {
      // legacy job dir directly under artifacts/
      const { files, bytes } = walkUsage(topDir);
      add(usage.legacy, files, bytes);
      usage.legacy.jobs += 1;
    } else {
      // org scope: children are job dirs (or stray orphans → legacy bucket)
      for (const c of fs.readdirSync(topDir, { withFileTypes: true })) {
        if (!c.isDirectory()) continue;
        const jobDir = path.join(topDir, c.name);
        const manifest = readManifest(jobDir);
        const { files, bytes } = walkUsage(jobDir);
        if (manifest?.lifecycle?.orgId) {
          const orgId = String(manifest.lifecycle.orgId);
          usage.orgs[orgId] ??= { bytes: 0, files: 0, jobs: 0 };
          add(usage.orgs[orgId], files, bytes);
          usage.orgs[orgId].jobs += 1;
        } else {
          add(usage.legacy, files, bytes);
        }
      }
    }
  }
  for (const org of Object.values(usage.orgs)) { usage.bytes += org.bytes; usage.files += org.files; }
  usage.bytes += usage.legacy.bytes;
  usage.files += usage.legacy.files;
  return usage;
}

function walkUsage(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { bytes += fs.statSync(p).size; files += 1; } catch {}
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// ---------- sweep planning (pure — no mutation) ----------
// Classifies every job dir under artifacts/: expired / kept / orphan, plus
// staging leftovers and the untouched-legacy report. Sweeping requires a
// manifest lifecycle header with expiresAt — an age check alone is never enough.
export function planSweep({ base = defaultBase(), clock = Date.now } = {}) {
  const nowMs = normClock(clock);
  const root = path.join(base, "artifacts");
  const plan = {
    now: new Date(nowMs).toISOString(),
    root,
    expired: [],   // { jobId, orgId, dir, scope, expiresAt, reason }
    kept: [],      // { dir, scope, reason }
    orphans: [],   // { dir, scope: "org" | "legacy", reason } — removable only with orphanPolicy
    stagingLeftovers: [], // { dir } — staged by a previous crashed sweep, finalizable
    legacyUntouched: [],  // legacy dirs NOT swept under the default policy
  };
  let top;
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return plan; }

  const stageDir = path.join(root, STAGING_DIRNAME);
  if (fs.existsSync(stageDir)) {
    for (const e of fs.readdirSync(stageDir, { withFileTypes: true })) {
      if (e.isDirectory()) plan.stagingLeftovers.push({ dir: path.join(stageDir, e.name) });
    }
  }

  for (const t of top) {
    if (!t.isDirectory() || t.name === STAGING_DIRNAME) continue;
    const topDir = path.join(root, t.name);
    if (fs.existsSync(path.join(topDir, "manifest.json"))) {
      classifyJob(topDir, { scope: "legacy-manifest", plan, nowMs, root });
    } else {
      let hasJobs = false;
      let entries = [];
      try { entries = fs.readdirSync(topDir, { withFileTypes: true }); } catch { continue; }
      for (const c of entries) {
        if (!c.isDirectory()) continue;
        hasJobs = true;
        classifyJob(path.join(topDir, c.name), { scope: "org", orgId: t.name, plan, nowMs, root });
      }
      if (!hasJobs) plan.orphans.push({ dir: topDir, scope: "legacy", reason: "empty or manifest-less top-level dir" });
    }
  }
  return plan;
}

function classifyJob(jobDir, { scope, orgId = null, plan, nowMs }) {
  const manifest = readManifest(jobDir);
  if (!manifest?.lifecycle) {
    plan.orphans.push({
      dir: jobDir,
      scope: scope === "org" ? "org" : "legacy",
      reason: manifest === null ? "no manifest.json (or unreadable)" : "manifest without lifecycle header",
    });
    return;
  }
  const lc = manifest.lifecycle;
  const jobId = lc.jobId || path.basename(jobDir);
  if (lc.lifecycleState === "staged-delete") {
    // a previous sweep marked it; crash happened after the mark — safe to remove
    plan.expired.push({ jobId, orgId: lc.orgId || orgId, dir: jobDir, scope, expiresAt: lc.expiresAt || null, reason: "lifecycleState=staged-delete (previous sweep interrupted)" });
    return;
  }
  if (lc.pinned === true) {
    plan.kept.push({ dir: jobDir, scope, reason: lc.pinReason ? `pinned (${lc.pinReason})` : "pinned" });
    return;
  }
  if (lc.lifecycleState === "purged") {
    plan.kept.push({ dir: jobDir, scope, reason: "already purged (tombstone)" });
    return;
  }
  const exp = lc.expiresAt ? Date.parse(lc.expiresAt) : NaN;
  if (!Number.isFinite(exp)) {
    plan.kept.push({ dir: jobDir, scope, reason: "no parsable expiresAt" });
    return;
  }
  if (nowMs >= exp) {
    plan.expired.push({ jobId, orgId: lc.orgId || orgId, dir: jobDir, scope, expiresAt: lc.expiresAt, reason: `expired ${lc.expiresAt}` });
  } else {
    plan.kept.push({ dir: jobDir, scope, reason: `expires ${lc.expiresAt}` });
  }
}

// ---------- sweep (staged deletion) ----------
// execute=false → plan only. execute=true → staged removal:
//   mark staged-delete → rename into .lifecycle-staging → rm -rf
// allowLegacy: opt-in sweeping of legacy manifest-bearing dirs (top-level).
//              Legacy dirs WITHOUT a manifest are never removed (rule 3).
// orphanPolicy: "skip" (default) | "remove" — "remove" deletes ORG-scoped
//              orphans only (no manifest = no retention data, so removal must
//              be explicit); legacy orphans are never removed.
export function sweep({ base = defaultBase(), clock = Date.now, execute = false, allowLegacy = false, orphanPolicy = "skip" } = {}) {
  const plan = planSweep({ base, clock });
  if (!execute) return { ...plan, staged: [], executed: [], errors: [] };
  const staged = [], executed = [], errors = [];
  const root = plan.root;
  const stageRoot = path.join(root, STAGING_DIRNAME);

  // 1) finalize leftovers a previous crashed sweep staged (already expired then)
  for (const left of plan.stagingLeftovers) {
    try {
      fs.rmSync(left.dir, { recursive: true, force: true });
      executed.push({ dir: left.dir, stage: "staged-finalized" });
    } catch (e) {
      errors.push({ dir: left.dir, error: String(e?.message || e) });
    }
  }

  // 2) stage expired (legacy scope only when explicitly allowed)
  for (const job of plan.expired) {
    if (job.scope === "legacy-manifest" && !allowLegacy) continue;
    try {
      writeLifecycle(job.dir, { lifecycleState: "staged-delete", stagedDeleteAt: plan.now });
      const target = path.join(stageRoot, `${path.basename(job.dir)}.${process.pid}.${Date.now()}`);
      fs.mkdirSync(stageRoot, { recursive: true });
      fs.renameSync(job.dir, target); // atomic-ish stage; crash here = recoverable by rename-back
      staged.push({ ...job, stagedTo: target });
    } catch (e) {
      errors.push({ dir: job.dir, error: String(e?.message || e) });
    }
  }

  // 3) delete staged
  for (const s of staged) {
    try {
      fs.rmSync(s.stagedTo, { recursive: true, force: true });
      executed.push({ dir: s.dir, jobId: s.jobId, orgId: s.orgId, scope: s.scope, stage: "deleted" });
    } catch (e) {
      errors.push({ dir: s.stagedTo, error: String(e?.message || e) });
    }
  }

  // 4) orphans — explicit policy, org scope only; legacy orphans never removed
  if (orphanPolicy === "remove") {
    for (const o of plan.orphans) {
      if (o.scope !== "org") continue;
      try {
        fs.rmSync(o.dir, { recursive: true, force: true });
        executed.push({ dir: o.dir, stage: "orphan-removed" });
      } catch (e) {
        errors.push({ dir: o.dir, error: String(e?.message || e) });
      }
    }
  }
  plan.legacyUntouched = plan.legacyUntouched.concat(
    plan.expired.filter((j) => j.scope === "legacy-manifest" && !allowLegacy).map((j) => j.dir),
  );
  return { ...plan, staged, executed, errors };
}

// ---------- credential shred + export integrity (guarantee PRESERVED) ----------
// Post-export shred: removes private/ (same contract as tasks.purgeCredentials)
// AND any sensitive-named entry (same predicate as the export filter,
// exporter.isSensitiveName) at any depth. Returns the removed relative paths.
export function shredJobCredentials(jobDir) {
  const removed = [];
  const rmRf = (p) => { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.relative(jobDir, p).replace(/\\/g, "/")); };
  const priv = path.join(jobDir, "private");
  if (fs.existsSync(priv)) rmRf(priv);
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (isSensitiveName(e.name)) { rmRf(p); continue; }
        walk(p);
      } else if (isSensitiveName(e.name)) {
        try { fs.rmSync(p, { force: true }); removed.push(path.relative(jobDir, p).replace(/\\/g, "/")); } catch {}
      }
    }
  };
  walk(jobDir);
  return { shredded: removed.length > 0, removed };
}

// Export integrity: a real, non-empty FILE with its sha256 (exporter.js already
// fails hard on zero-byte archives; this re-checks before ANY removal).
export function verifyExportIntegrity(zipPath) {
  if (!fs.existsSync(zipPath)) return { ok: false, reason: "missing" };
  const st = fs.statSync(zipPath);
  if (!st.isFile() || st.size === 0) return { ok: false, reason: "empty or not a file" };
  return { ok: true, size: st.size, sha256: sha256File(zipPath) };
}

// V2 export finalizer (the hook 4.0.5 adds AROUND the unmodified exporter):
//   verify ZIP integrity (fail-closed — throws, nothing removed) → record digest
//   in the manifest → shred credentials → record shred time.
// Call AFTER exporter.exportV2Task(id) returns its { zipPath }.
export function finalizeExportV2({ jobDir, zipPath }) {
  const integrity = verifyExportIntegrity(zipPath);
  if (!integrity.ok) throw new Error(`export integrity check failed (${integrity.reason}) — working files preserved`);
  writeLifecycle(jobDir, { exportSha256: integrity.sha256, exportSize: integrity.size, exportedAt: new Date().toISOString() });
  const shred = shredJobCredentials(jobDir);
  writeLifecycle(jobDir, { credentialsShreddedAt: new Date().toISOString() });
  return { integrity, shred };
}

// ---------- queue-adapter sweep ----------
// Runs the sweep through the clone-queue adapter (src/queues/clone-queue.js).
//   memory backend (default, no Redis): the run closure executes in-process.
//   bullmq backend: run closures are worker-executed; the payload carries the
//   wire contract { kind:"artifact-sweep", root, execute } for a worker-side
//   executor hook (src/workers/clone-worker.js is outside this task's scope).
export function enqueueSweep(queue, opts = {}) {
  const payload = {
    kind: "artifact-sweep",
    root: opts.base ? String(opts.base) : defaultBase(),
    execute: opts.execute !== false,
  };
  const entry = queue.enqueue({
    payload,
    run: async ({ entry: e, report }) => {
      e.status = "sweeping";
      report("sweeping");
      const result = sweep({
        base: opts.base,
        clock: opts.clock,
        execute: payload.execute,
        allowLegacy: opts.allowLegacy === true,
        orphanPolicy: opts.orphanPolicy || "skip",
      });
      report("swept");
      e.status = "completed"; // memory-backend convention: the run owns terminal status
      report("completed");
      return result;
    },
  });
  // the wire contract stays visible on the registry entry (bullmq mode reads it
  // worker-side; the memory backend ignores it and uses the run closure)
  entry.sweepPayload = payload;
  return entry;
}

// ---------- PostgreSQL retention bookkeeping (uses the compose PG) ----------
// DB rows are staged too: markExpired → purged (deleted_at), so a crash never
// deletes rows in one jump. File removal is the filesystem sweep's job, keyed
// on artifacts.path (org-scoped relative path recorded at write time).

export async function dbMarkExpired({ clock = Date.now, client = null, taskId = null } = {}) {
  const run = client ? client.query.bind(client) : dbQuery;
  const now = new Date(normClock(clock)).toISOString();
  const r = await run(
    `UPDATE artifacts SET lifecycle_state = 'expired'
     WHERE pinned = false AND deleted_at IS NULL AND lifecycle_state = 'active'
       AND expires_at IS NOT NULL AND expires_at <= $1
       AND ($2::uuid IS NULL OR task_id = $2::uuid)
     RETURNING id, task_id, org_id, path`,
    [now, taskId],
  );
  return r.rows;
}

export async function dbPurgeExpired({ clock = Date.now, client = null, taskId = null } = {}) {
  const run = client ? client.query.bind(client) : dbQuery;
  const now = new Date(normClock(clock)).toISOString();
  const r = await run(
    `UPDATE artifacts SET lifecycle_state = 'purged', deleted_at = $1
     WHERE lifecycle_state = 'expired'
       AND ($2::uuid IS NULL OR task_id = $2::uuid)
     RETURNING id, task_id, org_id, path`,
    [now, taskId],
  );
  return r.rows;
}

export async function dbUsageByOrg({ client = null } = {}) {
  const run = client ? client.query.bind(client) : dbQuery;
  const r = await run(
    `SELECT org_id, COUNT(*)::int AS artifacts, COALESCE(SUM(size_bytes), 0)::bigint AS bytes
     FROM artifacts WHERE deleted_at IS NULL GROUP BY org_id ORDER BY org_id NULLS LAST`,
  );
  return r.rows.map((row) => ({
    orgId: row.org_id,
    artifacts: row.artifacts,
    bytes: Number(row.bytes),
  }));
}
