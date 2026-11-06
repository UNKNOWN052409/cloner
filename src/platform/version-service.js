// Project versions, snapshots and rollback (task 4.1.3).
//
// Immutable version records per exported project. `snapshotProject(taskId,
// projectId)` hashes an on-disk project tree (files + sha256 + size) into a
// NEW project_versions row (migration 018) — rows are never mutated, only
// appended. `rollback(taskId, version, destDir)` materializes the recorded
// files from the version STORE (a real content store under
// artifacts/versions/<taskId>/<version>/) into a fresh working directory;
// rollback is never destructive to the live tree (it writes a NEW dir).
//
// Byte-exact guarantee: the manifest hashes are sha256 over the exact stored
// bytes; restore verifies every file against the manifest before reporting
// success (a drifted store file fails the rollback loudly, never silently).
//
// Surface:
//   snapshotProject({ taskId, projectDir, userId, orgId, note })
//   listVersions(taskId)                  → rows (version desc)
//   getVersion(taskId, version)
//   rollback(taskId, version, destDir)    → { ok, files } — byte-identical tree
//   verifyVersion(taskId, version)        → re-hash the store vs manifest
//   versionsRouter({ guard })             — INTEGRATOR MOUNT LINE:
//       import { versionsRouter } from "./version-service.js";
//       app.use("/api/versions", versionsRouter({ guard: localOrAuthed("read:task") }));
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { query } from "../database/client.js";

const ROOT = path.join(process.cwd(), "artifacts");
export function versionsStoreDir(taskId) {
  return path.join(ROOT, "versions", String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

// Collect every regular file under dir (relative, POSIX separators, sorted for
// determinism). Skips the export machinery's own staging dirs and private/.
export function collectProjectFiles(projectDir) {
  const files = [];
  const SKIP = new Set(["export-staging", "private", "node_modules"]);
  (function walk(rel) {
    for (const ent of fs.readdirSync(path.join(projectDir, rel), { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) files.push(r);
    }
  })("");
  return files.sort();
}

// Record a new immutable version from an on-disk project tree. The store copy
// is byte-identical to the source (fs.copyFileSync per file).
export async function snapshotProject({ taskId, projectDir, userId = null, orgId = null, note = null } = {}) {
  if (!taskId) throw new Error("taskId required");
  if (!projectDir || !fs.existsSync(projectDir)) throw new Error(`project dir not found: ${projectDir}`);
  const files = collectProjectFiles(projectDir);
  if (!files.length) throw new Error("project dir is empty — nothing to version");

  // next version number under a transaction; per-task advisory lock keeps
  // concurrent snapshots monotonic (G5.4-style serialization)
  const { withTransaction } = await import("../database/client.js");
  const record = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["project-versions:" + taskId]);
    const cur = await client.query(
      "SELECT COALESCE(MAX(version),0)::int AS v FROM project_versions WHERE task_id = $1",
      [taskId]
    );
    const version = cur.rows[0].v + 1;

    const manifest = { files: [], fileCount: 0, totalBytes: 0 };
    for (const rel of files) {
      const src = path.join(projectDir, rel);
      const size = fs.statSync(src).size;
      const sha = sha256File(src);
      manifest.files.push({ path: rel, sha256: sha, size });
      manifest.fileCount += 1;
      manifest.totalBytes += size;
    }

    // store the bytes first — a manifest row must never reference missing data
    const store = path.join(versionsStoreDir(taskId), String(version));
    fs.mkdirSync(store, { recursive: true });
    for (const rel of files) {
      const dst = path.join(store, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(projectDir, rel), dst);
    }

    const ins = await client.query(
      `INSERT INTO project_versions (task_id, user_id, org_id, version, note, created_by, manifest)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [taskId, userId, orgId, version, note, userId, JSON.stringify(manifest)]
    );
    return ins.rows[0];
  });
  return {
    id: record.id,
    taskId: record.task_id,
    version: record.version,
    note: record.note,
    manifest: record.manifest,
    createdAt: record.created_at,
  };
}

export async function listVersions(taskId) {
  const r = await query(
    `SELECT id, task_id, user_id, org_id, version, note, created_by, manifest, created_at
     FROM project_versions WHERE task_id = $1 ORDER BY version DESC`,
    [taskId]
  );
  return r.rows.map((row) => ({
    id: row.id, taskId: row.task_id, version: row.version, note: row.note,
    manifest: row.manifest, createdBy: row.created_by, createdAt: row.created_at,
  }));
}

// Recent versions across ALL tasks, newest first — the bare GET /api/versions
// prefix the product UI's final page polls (platform-ui/pages/final.js). Same
// row shape as listVersions so consumers render either identically; the row
// count is bounded (manifests can be large) and the limit is caller-clamped.
export async function listAllVersions({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const r = await query(
    `SELECT id, task_id, user_id, org_id, version, note, created_by, manifest, created_at
     FROM project_versions ORDER BY created_at DESC, version DESC LIMIT $1`,
    [lim]
  );
  return r.rows.map((row) => ({
    id: row.id, taskId: row.task_id, version: row.version, note: row.note,
    manifest: row.manifest, createdBy: row.created_by, createdAt: row.created_at,
  }));
}

export async function getVersion(taskId, version) {
  const r = await query(
    `SELECT * FROM project_versions WHERE task_id = $1 AND version = $2`,
    [taskId, version]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, taskId: row.task_id, version: row.version, note: row.note, manifest: row.manifest, createdAt: row.created_at };
}

// Materialize version V of task T into destDir. Writes into a FRESH directory
// only (never merges into an existing tree — rollback is non-destructive by
// construction). Every restored file is hash-verified against the manifest.
export async function rollback(taskId, version, destDir) {
  const rec = await getVersion(taskId, version);
  if (!rec) throw new Error(`version ${version} of task ${taskId} not found`);
  const store = path.join(versionsStoreDir(taskId), String(version));
  if (!fs.existsSync(store)) throw new Error(`version store missing on disk: ${store}`);
  if (destDir && fs.existsSync(destDir) && fs.readdirSync(destDir).length) {
    throw new Error(`rollback destination must be empty or absent (non-destructive rollback): ${destDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const restored = [];
  for (const f of rec.manifest.files) {
    const src = path.join(store, f.path);
    if (!fs.existsSync(src)) throw new Error(`store file missing: ${f.path}`);
    const sha = sha256File(src);
    if (sha !== f.sha256) throw new Error(`store drift for ${f.path} (sha256 mismatch) — rollback refused`);
    const dst = path.join(destDir, f.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    restored.push(f.path);
  }
  return { ok: true, version: rec.version, files: restored, totalBytes: rec.manifest.totalBytes };
}

// Re-hash the stored bytes vs the recorded manifest (integrity check).
export async function verifyVersion(taskId, version) {
  const rec = await getVersion(taskId, version);
  if (!rec) return { ok: false, error: "version not found" };
  const store = path.join(versionsStoreDir(taskId), String(version));
  const problems = [];
  for (const f of rec.manifest.files) {
    const p = path.join(store, f.path);
    if (!fs.existsSync(p)) { problems.push("missing:" + f.path); continue; }
    if (sha256File(p) !== f.sha256) problems.push("modified:" + f.path);
  }
  return { ok: problems.length === 0, problems };
}

// ── HTTP surface ────────────────────────────────────────────────────────────
// guard = the platform's localOrAuthed-style gate (injected; same contract as
// server.js). Ownership: task-scoped — the caller must pass the SAME access
// gate the task detail route uses; the router resolves the gate per call.
export function versionsRouter({ guard } = {}) {
  const router = Router();
  const g = guard || ((req, res, next) => next());
  const resolveUser = (req) => req.userId || null;

  // List versions of a project (task) + snapshot the CURRENT project tree.
  router.get("/tasks/:taskId", g, async (req, res) => {
    try {
      res.json({ ok: true, versions: await listVersions(req.params.taskId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  // Recent versions across all tasks — GET /api/versions (the bare prefix the
  // product UI's final page polls; previously 404 while the router was
  // unmounted). Same { ok, versions } shape as the per-task listing.
  router.get("/", g, async (req, res) => {
    try {
      res.json({ ok: true, versions: await listAllVersions({ limit: req.query?.limit }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  // Create a version from the current project tree on disk.
  router.post("/tasks/:taskId", g, express_json, async (req, res) => {
    try {
      const projectDir = req.body?.projectDir;
      if (!projectDir) return res.status(400).json({ ok: false, error: "projectDir required" });
      const v = await snapshotProject({
        taskId: req.params.taskId,
        projectDir,
        userId: resolveUser(req),
        orgId: req.tenantScope?.orgId || null,
        note: String(req.body?.note || "").slice(0, 200) || null,
      });
      res.json({ ok: true, version: v });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  // Rollback: materialize version V into a new dir under destDir (body.destDir).
  router.post("/tasks/:taskId/rollback", g, express_json, async (req, res) => {
    try {
      const version = Number(req.body?.version);
      if (!Number.isInteger(version) || version < 1) return res.status(400).json({ ok: false, error: "version (integer >= 1) required" });
      const base = req.body?.destDir;
      if (!base) return res.status(400).json({ ok: false, error: "destDir required" });
      const dest = path.join(base, `rollback-v${version}-${Date.now().toString(36)}`);
      const r = await rollback(req.params.taskId, version, dest);
      res.json({ ok: true, restoredDir: dest, ...r });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
import express from "express";
const express_json = express.json({ limit: "64kb" });
