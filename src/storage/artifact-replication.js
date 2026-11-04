// Regional artifact replication (task 4.2.3): copy-on-complete to N configured
// regional roots with a SHA256 manifest per replica + verify, and a delivery
// resolution that serves artifacts from the region nearest the caller — falling
// back to the ORIGIN artifacts tree when no replica is healthy (origin is the
// source of truth; a broken region degrades delivery distance, never delivery
// itself).
//
// Real behavior, env-configured (NO-MOCKS mandate): every replica root is a real
// filesystem root the operator configures (a network mount / sync target / NFS
// export in production). With no regions configured the feature is cleanly
// disabled — replicate is a documented no-op and delivery serves from origin —
// never a crash and never a fake success.
//
// Configuration (env):
//   REPLICATION_REGIONS   comma/semicolon separated region specs:
//                           name=path            → region "name" at abs path
//                           name@lat:lon=path    → same + geo coordinates
//                                                  (decimal degrees, haversine;
//                                                   ":" separator — the comma is
//                                                   the REGION separator)
//                         A spec without "=path" defaults to <base>/replicas/<name>.
//                         Names are lowercased and trimmed; duplicates collapse.
//                         Paths must not contain ",", ";" or "@".
//   REPLICATION_DELIVERY_VERIFY  integrity check run by the delivery resolver
//                         against the candidate replica before serving:
//                         "hash" (default — full SHA256 verify, integrity-first)
//                         "stat" (manifest + size only) | "off" (manifest only).
//
// Replica layout MIRRORS the origin artifacts tree, so the same path logic
// resolves on both sides (see artifact-lifecycle.resolveArtifactPath):
//     origin:  <base>/artifacts/<orgId>/<jobId>/…      (org-scoped jobs)
//     origin:  <base>/artifacts/<jobId>/…              (legacy jobs)
//     region:  <regionRoot>/<orgId>/<jobId>/…          /  <regionRoot>/<jobId>/…
//
// Per-replica manifest: <jobDir>/replication-manifest.json
//   { replication: 1, jobId, orgId, region, replicatedAt, originScope, fileCount,
//     bytes, files: [{ path, size, sha256 }] }   (POSIX-style relative paths;
//     the manifest itself is excluded from files[])
//
// Integration (server.js / clone-worker.js are INTEGRATOR-OWNED — one-liners):
//   1. copy-on-complete, wired once at boot:
//        import { attachReplicationToQueue } from "../storage/artifact-replication.js";
//        attachReplicationToQueue(getCloneQueue());
//      (fires replicateOnComplete when a job reports a terminal SUCCESS status
//      on either queue backend; errors are logged, never thrown into the queue)
//   2. HTTP surface (status + nearest-region delivery), mounted additively:
//        app.use("/api/replication", createReplicationRouter({ authRequired, tenantScope: resolveTenantScope }));
//      GET /api/replication/status/:jobId[?deep=1]      → per-region replication state
//      GET /api/replication/deliver/:jobId/<file>       → serve from nearest region
//        (X-Client-Region header or ?region= names a region; ?lat=&lon= geo hint;
//         ?meta=1 returns the resolution JSON instead of the file bytes)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { authRequired as defaultAuthRequired } from "../auth/auth-middleware.js";
import { isLoopback as defaultIsLoopback } from "../platform/ws-auth.js";
import { resolveArtifactPath, sha256File } from "./artifact-lifecycle.js";

export const REPLICATION_MANIFEST_NAME = "replication-manifest.json";
export const DELIVERY_VERIFY_MODES = ["hash", "stat", "off"];
const TERMINAL_SUCCESS = new Set(["completed", "completed_with_limitations"]);
const EARTH_RADIUS_KM = 6371;

// ---------- environment / region config ----------
// "us-east@40.7:-74=D:/r/us;eu-west@48.85:2.35=D:/r/eu" →
// [{ name: "us-east", root: "D:/r/us", lat: 40.7, lon: -74 }, …]
// Coordinates use ":" (name@lat:lon) so the comma stays unambiguous as the
// REGION separator. A path must not contain , ; or @ (documented in .env.example).
export function parseRegionsEnv(raw) {
  if (typeof raw !== "string") return [];
  const out = [];
  for (const chunkRaw of raw.split(/[,;]/)) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;
    // split the ROOT off first: the documented order is name[@lat:lon]=path, so
    // "@" may only carry coordinates in the part BEFORE "=" (paths stay free of "=")
    const eq = chunk.indexOf("=");
    let left = chunk;
    let root = null;
    if (eq >= 0) { left = chunk.slice(0, eq); root = chunk.slice(eq + 1).trim(); }
    let name = left, lat = null, lon = null;
    const at = left.lastIndexOf("@");
    if (at > 0) {
      name = left.slice(0, at);
      const coords = left.slice(at + 1);
      const m = coords.match(/^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/);
      if (!m) throw new Error(`REPLICATION_REGIONS: bad coordinates "@${coords}" in region "${chunk}" (expected name@lat:lon=path)`);
      lat = Number(m[1]); lon = Number(m[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new Error(`REPLICATION_REGIONS: coordinates out of range in region "${chunk}" (lat ±90, lon ±180)`);
      }
    }
    name = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      throw new Error(`REPLICATION_REGIONS: invalid region name "${name}" (use [a-z0-9._-], max 64 chars)`);
    }
    if (eq >= 0 && !root) throw new Error(`REPLICATION_REGIONS: region "${name}" has an empty root path`);
    if (out.some((r) => r.name === name)) continue; // duplicate name collapses (first wins)
    out.push({ name, root: root || null, lat, lon });
  }
  return out;
}

export function loadRegions({ env = process.env, base = defaultBase() } = {}) {
  const raw = env.REPLICATION_REGIONS || "";
  const regions = parseRegionsEnv(raw).map((r) => ({
    ...r,
    root: path.resolve(r.root || path.join(base, "replicas", r.name)),
  }));
  return { enabled: regions.length > 0, regions };
}

export function deliveryVerifyMode(env = process.env) {
  const mode = String(env.REPLICATION_DELIVERY_VERIFY || "hash").trim().toLowerCase();
  if (!DELIVERY_VERIFY_MODES.includes(mode)) {
    throw new Error(`REPLICATION_DELIVERY_VERIFY: "${mode}" is not one of ${DELIVERY_VERIFY_MODES.join("|")}`);
  }
  return mode;
}

export function defaultBase() {
  return process.cwd();
}

// ---------- geo ----------
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ordered delivery candidates. A client-named region wins when it is configured;
// otherwise candidates sort by haversine distance to the client coordinates
// (regions without coordinates sort last, in configured order); without any hint
// the configured order is preserved verbatim. Never mutates the input.
export function orderRegionsByProximity(regions, { region = null, lat = null, lon = null } = {}) {
  const want = region ? String(region).trim().toLowerCase() : null;
  const list = regions.map((r, i) => ({ r, i }));
  const named = want ? list.filter(({ r }) => r.name === want) : [];
  const rest = want ? list.filter(({ r }) => r.name !== want) : list;
  const hasClientGeo = Number.isFinite(lat) && Number.isFinite(lon);
  rest.sort((a, b) => {
    const da = hasClientGeo && a.r.lat !== null ? haversineKm(lat, lon, a.r.lat, a.r.lon) : Infinity;
    const db = hasClientGeo && b.r.lat !== null ? haversineKm(lat, lon, b.r.lat, b.r.lon) : Infinity;
    if (da !== db) return da - db;
    return a.i - b.i;
  });
  return [...named, ...rest].map(({ r }) => r);
}

// ---------- paths ----------
export function replicaDirFor(regionRoot, { orgId, jobId }) {
  if (!jobId) throw new Error("replicaDirFor: jobId is required");
  if (!regionRoot) throw new Error("replicaDirFor: regionRoot is required");
  return orgId ? path.join(regionRoot, String(orgId), String(jobId)) : path.join(regionRoot, String(jobId));
}

// Walk a job tree → [{ path, size }] with POSIX-style relative paths.
// The replication manifest itself is excluded (it describes the artifact tree,
// not itself — otherwise its own hash could never be stable).
export function listTreeFiles(jobDir) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (e.name === REPLICATION_MANIFEST_NAME && path.relative(jobDir, full).replace(/\\/g, "/") === REPLICATION_MANIFEST_NAME) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        files.push({ path: path.relative(jobDir, full).replace(/\\/g, "/"), size });
      }
    }
  };
  walk(jobDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// ---------- replication manifest ----------
export function buildReplicationManifest({ jobId, orgId, region, sourceDir, clock = Date.now }) {
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error(`buildReplicationManifest: source dir not found: ${sourceDir}`);
  const files = listTreeFiles(sourceDir).map((f) => ({ ...f, sha256: sha256File(path.join(sourceDir, f.path)) }));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const at = typeof clock === "function" ? clock() : clock;
  return {
    replication: 1,
    jobId: String(jobId),
    orgId: orgId ? String(orgId) : null,
    region: String(region),
    replicatedAt: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    originScope: orgId ? "org" : "legacy",
    fileCount: files.length,
    bytes,
    files,
  };
}

// ---------- copy-on-complete ----------
// Copies the job's artifact tree into EVERY configured region (one failing
// region never blocks the others), writes a per-region SHA256 manifest, then
// verifies each replica against it (hashes what LANDED, so copy corruption is
// caught in the same call). Returns per-region results; throws only for a bad
// call (missing jobId / origin tree absent).
export function replicateOnComplete({
  jobId, orgId = null, base = defaultBase(), regions = null, env = process.env,
  clock = Date.now, verify = "hash",
} = {}) {
  if (!jobId) throw new Error("replicateOnComplete: jobId is required");
  const cfg = regions || loadRegions({ env, base });
  if (!cfg.regions.length) {
    return { jobId: String(jobId), orgId, enabled: false, reason: "no regions configured (REPLICATION_REGIONS)", replicated: [], failed: [], manifest: null };
  }
  const resolved = resolveArtifactPath(jobId, { orgId, base });
  if (!fs.existsSync(resolved.path)) {
    throw new Error(`replicateOnComplete: no artifact tree for job "${jobId}" (looked at ${resolved.path})`);
  }
  const manifest = buildReplicationManifest({ jobId, orgId, region: "origin", sourceDir: resolved.path, clock });
  const replicated = [], failed = [];
  for (const region of cfg.regions) {
    const result = replicateToRegion({ region, jobId, orgId, sourceDir: resolved.path, scope: resolved.scope, manifest, clock, verify });
    (result.ok ? replicated : failed).push(result);
  }
  return {
    jobId: String(jobId), orgId, enabled: true,
    origin: { scope: resolved.scope, path: resolved.path, files: manifest.fileCount, bytes: manifest.bytes },
    replicated, failed, manifest,
  };
}

function replicateToRegion({ region, jobId, orgId, sourceDir, scope, manifest, clock, verify }) {
  const dir = replicaDirFor(region.root, { orgId, jobId });
  const result = { region: region.name, root: region.root, dir, ok: false, files: manifest.fileCount, bytes: manifest.bytes, manifestSha256: null, verified: null, error: null, startedAt: new Date(typeof clock === "function" ? clock() : clock).toISOString() };
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // fs.cpSync replaces the destination wholesale — a re-replication of the
    // same job (retry, re-complete) cannot leave stale files behind
    fs.cpSync(sourceDir, dir, { recursive: true, force: true });
    fs.rmSync(path.join(dir, REPLICATION_MANIFEST_NAME), { force: true });
    const replicaManifest = { ...manifest, region: region.name, originScope: scope };
    fs.writeFileSync(path.join(dir, REPLICATION_MANIFEST_NAME), JSON.stringify(replicaManifest, null, 2));
    result.manifestSha256 = sha256(path.join(dir, REPLICATION_MANIFEST_NAME));
    if (verify !== "off") {
      const v = verifyReplica({ jobId, orgId, root: region.root, mode: verify });
      result.verified = v;
      result.ok = v.ok;
      if (!v.ok) result.error = `verify failed: ${v.missing.length} missing, ${v.corrupt.length} corrupt`;
    } else {
      result.ok = true;
    }
  } catch (e) {
    result.error = String(e?.message || e).slice(0, 300);
  }
  return result;
}

export function sha256(file) {
  return sha256File(file);
}

// ---------- verify ----------
// mode "hash": re-hash every manifest-listed file + sizes (full integrity);
// mode "stat": sizes only; mode "off": manifest readability only.
// extra[] lists unlisted on-disk files (informational — they do not fail ok,
// which answers "is the replicated content exactly what the manifest promises").
export function verifyReplica({ jobId, orgId = null, region = null, root = null, base = defaultBase(), mode = "hash", env = process.env }) {
  if (!DELIVERY_VERIFY_MODES.includes(mode)) throw new Error(`verifyReplica: mode "${mode}" not in ${DELIVERY_VERIFY_MODES.join("|")}`);
  let dir = root ? replicaDirFor(root, { orgId, jobId }) : null;
  if (!dir && region) {
    const { regions } = loadRegions({ env, base });
    const r = regions.find((x) => x.name === String(region).toLowerCase());
    if (!r) return { ok: false, region, mode, manifestOk: false, reason: `unknown region "${region}"`, fileCount: 0, bytes: 0, missing: [], corrupt: [], extra: [] };
    dir = replicaDirFor(r.root, { orgId, jobId });
  }
  if (!dir) throw new Error("verifyReplica: provide root or region");
  const out = { jobId: String(jobId), orgId, mode, dir, manifestOk: false, ok: false, fileCount: 0, bytes: 0, missing: [], corrupt: [], extra: [] };
  const manifestPath = path.join(dir, REPLICATION_MANIFEST_NAME);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    out.reason = "replication manifest missing or unreadable";
    return out;
  }
  if (manifest?.replication !== 1 || !Array.isArray(manifest.files) || manifest.jobId !== String(jobId)) {
    out.reason = "replication manifest schema mismatch";
    return out;
  }
  out.manifestOk = true;
  for (const f of manifest.files) {
    const full = path.join(dir, f.path);
    let size = -1;
    try { size = fs.statSync(full).size; } catch { out.missing.push(f.path); continue; }
    if (size !== f.size) { out.corrupt.push({ path: f.path, reason: `size ${size} != manifest ${f.size}` }); continue; }
    if (mode === "hash") {
      const actual = sha256File(full);
      if (actual !== f.sha256) { out.corrupt.push({ path: f.path, reason: `sha256 ${actual} != manifest ${f.sha256}` }); continue; }
    }
    out.fileCount += 1;
    out.bytes += size;
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const f of listTreeFiles(dir)) {
    if (!listed.has(f.path)) out.extra.push(f.path);
  }
  out.ok = out.manifestOk && out.missing.length === 0 && out.corrupt.length === 0;
  return out;
}

export function verifyAllRegions({ jobId, orgId = null, base = defaultBase(), regions = null, env = process.env, mode = "hash" }) {
  const cfg = regions || loadRegions({ env, base });
  return cfg.regions.map((r) => verifyReplica({ jobId, orgId, root: r.root, base, mode, env }));
}

// ---------- status (fast, no deep verify unless asked) ----------
export function replicationStatus({ jobId, orgId = null, base = defaultBase(), regions = null, env = process.env, deep = false, mode = "hash" }) {
  const cfg = regions || loadRegions({ env, base });
  const resolved = resolveArtifactPath(jobId, { orgId, base });
  const originExists = fs.existsSync(resolved.path);
  const regionStates = cfg.regions.map((r) => {
    const dir = replicaDirFor(r.root, { orgId, jobId });
    const manifestPath = path.join(dir, REPLICATION_MANIFEST_NAME);
    let replicated = false, manifestSha256 = null, replicatedAt = null, fileCount = 0, bytes = 0, verifyState = null;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (m?.replication === 1) {
        replicated = true;
        manifestSha256 = sha256File(manifestPath);
        replicatedAt = m.replicatedAt || null;
        fileCount = m.fileCount || (m.files?.length ?? 0);
        bytes = m.bytes || 0;
      }
    } catch { /* not replicated in this region */ }
    if (deep && replicated) verifyState = verifyReplica({ jobId, orgId, root: r.root, base, mode, env });
    return { region: r.name, root: r.root, lat: r.lat, lon: r.lon, replicated, manifestSha256, replicatedAt, fileCount, bytes, verify: verifyState };
  });
  return {
    jobId: String(jobId), orgId,
    enabled: cfg.enabled,
    origin: { scope: resolved.scope, path: resolved.path, exists: originExists },
    regions: regionStates,
    healthy: regionStates.filter((r) => r.replicated && (!r.verify || r.verify.ok)).map((r) => r.region),
  };
}

// ---------- delivery ----------
// Resolves the file the caller asked for from the NEAREST HEALTHY region.
// Candidates are tried in proximity order; each is checked (per verifyMode)
// before serving, and the first healthy replica wins. When no replica is
// healthy the ORIGIN tree serves the file with fallback:true (delivery never
// gets worse than pre-replication). Returns the full decision chain so callers
// (and tests) can see exactly why a region was picked or rejected.
export function resolveDelivery({
  jobId, orgId = null, file = "manifest.json", client = {}, base = defaultBase(),
  regions = null, env = process.env, verifyMode = null, clock = Date.now,
} = {}) {
  if (!jobId) throw new Error("resolveDelivery: jobId is required");
  const mode = verifyMode || deliveryVerifyMode(env);
  const cfg = regions || loadRegions({ env, base });
  const relFile = String(file || "manifest.json").replace(/\\/g, "/").replace(/^\/+/, "");
  const chain = [];
  const ordered = orderRegionsByProximity(cfg.regions, client);
  for (const region of ordered) {
    const dir = replicaDirFor(region.root, { orgId, jobId });
    const manifestPath = path.join(dir, REPLICATION_MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      chain.push({ region: region.name, picked: false, reason: "not replicated" });
      continue;
    }
    if (mode !== "off") {
      const v = verifyReplica({ jobId, orgId, root: region.root, base, mode, env });
      if (!v.ok) {
        chain.push({ region: region.name, picked: false, reason: `verify failed (${v.missing.length} missing, ${v.corrupt.length} corrupt)`, verify: v });
        continue;
      }
      chain.push({ region: region.name, picked: true, verify: v });
      return finish({ served: "replica", region: region.name, root: region.root, dir, file: relFile, verified: true, verify: v, fallback: false, chain, manifestSha256: sha256File(manifestPath) });
    }
    chain.push({ region: region.name, picked: true, verify: null });
    return finish({ served: "replica", region: region.name, root: region.root, dir, file: relFile, verified: false, verify: null, fallback: false, chain, manifestSha256: sha256File(manifestPath) });
  }
  // no healthy replica → origin fallback (also the no-regions-configured path)
  const origin = resolveArtifactPath(jobId, { orgId, base });
  const fallbackReason = cfg.regions.length ? "no healthy replica — origin fallback" : "no regions configured — origin fallback";
  for (const c of chain) c.picked = false;
  chain.push({ region: "origin", picked: true, reason: fallbackReason });
  const r = finish({ served: "origin", region: null, root: origin.path, dir: origin.path, file: relFile, verified: false, verify: null, fallback: cfg.regions.length > 0, chain, fallbackReason, manifestSha256: null });
  r.reason = fallbackReason;
  return r;
}

function finish(d) {
  const filePath = path.resolve(d.dir, d.file);
  // containment: the requested relative path must stay inside the chosen tree
  const rel = path.relative(path.resolve(d.dir), filePath);
  const exists = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  return { ...d, filePath, exists, distanceReason: d.chain?.find?.((c) => c.picked)?.reason || null };
}

// ---------- queue wiring: copy-on-complete ----------
// Subscribes to the queue's status stream and replicates every job that
// reaches a terminal SUCCESS status (works on both the memory and the bullmq
// backend — onStatus is part of the shared surface). jobId is required; orgId
// rides on the entry's owner. Errors are logged, NEVER thrown into the queue.
// Idempotent per job: a jobId already replicated in this process is skipped.
// Returns a detach function.
export function attachReplicationToQueue(queue, { base = defaultBase(), clock = Date.now, log = (m) => console.log(m) } = {}) {
  if (!queue || typeof queue.onStatus !== "function") throw new Error("attachReplicationToQueue: queue with onStatus() required");
  const inFlight = new Set();
  const handler = ({ jobId, status, entry } = {}) => {
    if (!jobId || !TERMINAL_SUCCESS.has(status) || inFlight.has(jobId)) return;
    inFlight.add(jobId);
    const orgId = entry?.owner?.orgId || null;
    Promise.resolve()
      .then(() => replicateOnComplete({ jobId, orgId, base, clock }))
      .then((r) => {
        if (!r.enabled) { log(`[replication] job ${jobId}: disabled (${r.reason})`); return; }
        const ok = r.replicated.map((x) => x.region).join(", ");
        const bad = r.failed.map((x) => `${x.region}: ${x.error}`).join("; ");
        log(`[replication] job ${jobId}: replicated to ${r.replicated.length} region(s) [${ok}]${bad ? ` — FAILED: ${bad}` : ""}`);
      })
      .catch((e) => log(`[replication] job ${jobId}: FAILED ${String(e?.message || e).slice(0, 200)}`))
      .finally(() => inFlight.delete(jobId));
  };
  queue.onStatus(handler);
  return () => queue.off("status", handler);
}

// ---------- HTTP router (delivery + status) ----------
// Mount (INTEGRATOR-OWNED server.js — documented, not added here):
//   app.use("/api/replication", createReplicationRouter({ authRequired, tenantScope: resolveTenantScope }));
// Gate mirrors the platform's credentialed-read posture: Bearer/?token → the
// real authRequired; API requests from loopback without credentials keep the
// local-dashboard legacy posture (userId null); remote anonymous → 401. When an
// org context is present the injected tenant middleware resolves it strictly.
// Job-owner gating is enforced exactly like /api/jobs/:jobId/artifacts/* —
// an owned job is invisible (404) to non-members and to anonymous callers.
export function createReplicationRouter({ authRequired = defaultAuthRequired, tenantScope = null, base = defaultBase(), env = process.env, isLoopback = defaultIsLoopback } = {}) {
  const router = Router();

  const gate = (req, res, next) => {
    const hasBearer = (req.headers.authorization || "").startsWith("Bearer ");
    if (hasBearer) return authRequired(req, res, next); // header-only (hunt G5.3: no ?token= in URLs)
    if (!isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
    req.userId = null; // loopback dashboard legacy posture
    next();
  };
  // soft tenant resolution — only when the caller names an org context
  const softTenant = (req, res, next) => {
    const hasOrgCtx = !!(req.headers["x-org-id"] || req.query?.orgId);
    if (!hasOrgCtx || typeof tenantScope !== "function") return next();
    return tenantScope(req, res, next);
  };
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e?.status || 500;
      res.status(status).json({ error: String(e?.message || "internal error").slice(0, 200) });
    });
  };

  // 404 unless the caller may see the job (same contract as the artifacts route).
  // Also returns the job's own owner org: an org-scoped artifact tree lives under
  // <artifacts>/<orgId>/<jobId>, so a member who forgot the X-Org-Id header still
  // gets correct resolution — the jobId itself implies its scope (gating has
  // already proven the caller may see this job).
  async function loadVisibleJob(jobId, req) {
    try {
      const { getExplorationJob, identityCanAccessJob } = await import("../platform/exploration-runner.js");
      const job = getExplorationJob(jobId);
      const ownerOrgId = job?.owner?.orgId || null;
      if (job?.owner) {
        if (!req.userId) return { visible: false, ownerOrgId };
        const ok = await identityCanAccessJob(jobId, { userId: req.userId, role: req.userRole });
        return { visible: ok, ownerOrgId };
      }
      return { visible: true, ownerOrgId }; // ownerless/absent entries: the pre-Phase-4 posture
    } catch {
      return { visible: true, ownerOrgId: null }; // registry unavailable (standalone mount) — origin-backed delivery still works
    }
  }

  // GET /api/replication/status/:jobId[?deep=1&lat=&lon=&region=]
  router.get("/status/:jobId", gate, softTenant, wrap(async (req, res) => {
    const { jobId } = req.params;
    const { visible, ownerOrgId } = await loadVisibleJob(jobId, req);
    if (!visible) return res.status(404).json({ error: "not found" });
    const deep = req.query.deep === "1" || req.query.deep === "true";
    const status = replicationStatus({ jobId, orgId: req.tenantScope?.orgId || ownerOrgId, base, env, deep });
    const client = { region: req.get("x-client-region") || req.query.region || null, lat: num(req.query.lat), lon: num(req.query.lon) };
    const cfg = loadRegions({ env, base });
    status.deliveryOrder = orderRegionsByProximity(cfg.regions, client).map((r) => r.name);
    res.json(status);
  }));

  // GET /api/replication/deliver/:jobId            → manifest.json (default)
  // GET /api/replication/deliver/:jobId/<file>     → that file, nearest region
  // ?meta=1 returns the resolution JSON instead of bytes (UI/debug/tests).
  const deliver = (req, res) => {
    const { jobId } = req.params;
    const relFile = req.params[0] || "manifest.json";
    loadVisibleJob(jobId, req)
      .then(({ visible, ownerOrgId }) => {
        if (!visible) return res.status(404).json({ error: "not found" });
        const client = {
          region: req.get("x-client-region") || req.query.region || null,
          lat: num(req.query.lat), lon: num(req.query.lon),
        };
        let decision;
        try {
          decision = resolveDelivery({ jobId, orgId: req.tenantScope?.orgId || ownerOrgId, file: relFile, client, base, env });
        } catch (e) {
          return res.status(400).json({ error: String(e.message || e).slice(0, 200) });
        }
        if (!decision.exists) return res.status(404).json({ error: "not found", served: decision.served, region: decision.region, fallback: decision.fallback });
        if (req.query.meta === "1") {
          return res.json({
            jobId, file: relFile, served: decision.served, region: decision.region,
            fallback: decision.fallback, verified: decision.verified, manifestSha256: decision.manifestSha256,
            filePath: decision.filePath, chain: decision.chain, reason: decision.reason || null,
          });
        }
        // double-containment guard (same shape as the artifacts route): the
        // resolved file must stay inside BOTH the chosen tree and itself
        const rel = path.relative(path.resolve(decision.dir), path.resolve(decision.filePath));
        if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(403).json({ error: "forbidden" });
        res.setHeader("X-Served-From", decision.served === "replica" ? `replica:${decision.region}` : "origin");
        if (decision.fallback) res.setHeader("X-Replication-Fallback", "1");
        res.sendFile(decision.filePath);
      })
      .catch((e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) }));
  };
  router.get("/deliver/:jobId", gate, softTenant, deliver);
  router.get("/deliver/:jobId/*", gate, softTenant, deliver);

  return router;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- misc ----------
// Digest helper used by tests and status surfaces (kept local to avoid a second
// streaming-hash import path): sha256 of arbitrary bytes.
export function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
