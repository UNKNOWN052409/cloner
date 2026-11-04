// Region registry + region plane (task 4.2.1).
//
// The distributed topology: a COORDINATOR (this process — the platform server)
// knows every REGION (id, endpoint URL, capabilities). Each region runs one or
// more WORKERS (id, capabilities, concurrency, heartbeat) and serves the shared
// 4.2.1 wire contracts (src/distributed/contracts.js) over HTTP:
//
//   GET  /v1/contract              → { contractVersion, regionId, capabilities }
//   GET  /v1/health                → liveness probe (no auth, like /healthz)
//   POST /v1/executions            → run a job on this region (auth: Bearer)
//   POST /v1/artifacts/:jobId      → upload an artifact (digest headers, auth)
//   GET  /v1/artifacts/:jobId      → per-job artifact manifest
//   GET  /v1/artifacts/:jobId/:name→ download an artifact (digest header)
//   POST /v1/workers               → register a worker with this region (auth)
//   POST /v1/heartbeat             → worker heartbeat (auth)
//
// REAL-WORLD POSTURE (no-mocks mandate): the node is a real http server, the
// client uses real fetch over the configured endpoints, auth uses real HMAC
// tokens from the env secret, and region nodes store uploaded artifacts in
// real files. Nothing is simulated inside the product code — the two-region
// setup in scripts/test-region-registry.mjs boots two REAL region nodes on
// loopback ports and drives them with the same client production uses.
//
// Exports:
//   createRegionRegistry(opts)   — coordinator-side region + worker registry
//   getRegionRegistry()          — singleton (bootstraps from CLONER_REGIONS)
//   createRegionNode(opts)       — run one region's HTTP plane
//   createRegionClient(opts)     — coordinator-side HTTP client to a region
//   createRegionDispatcher(opts) — select region → reserve worker → dispatch
//   regionRouter(opts)           — Express admin surface for the integrator
//
// Mount line for src/platform/server.js (INTEGRATOR-OWNED — not added here):
//   import { regionRouter, getRegionRegistry } from "../distributed/region-registry.js";
//   app.use("/api/regions", regionRouter({ registry: getRegionRegistry() }));
//
// Env (documented in .env.example):
//   CLONER_REGION_SECRET   — HMAC secret for region↔region tokens (required
//                            for any cross-region call; absent → clean error)
//   CLONER_REGIONS         — optional JSON bootstrap:
//                            [{"id":"region-a","endpoint":"http://127.0.0.1:9501","capabilities":["clone:url"]}]
//   CLONER_REGION_ID       — this coordinator's issuer id (default "local")
//   CLONER_REGION_ARTIFACTS_ROOT — where region nodes store uploads
//                            (default <cwd>/artifacts-regions/<regionId>)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Router } from "express";
import * as contracts from "./contracts.js";
import {
  CONTRACT_VERSION, ID_PATTERN, CAP_PATTERN, ARTIFACT_NAME_PATTERN, JOB_ID_PATTERN,
  RegionAuthError, RegionContractError,
  normalizeCapabilities, resolveRegionSecret, requireRegionSecret, bearerFromHeader,
  validateExecutionRequest, validateExecutionResult,
  validateArtifactEnvelope, verifyArtifactEnvelope, makeArtifactManifest, validateArtifactManifest,
  digestArtifact,
} from "./contracts.js";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Registry (coordinator side)
// ---------------------------------------------------------------------------

export function createRegionRegistry({
  staleAfterMs = 15_000,
  bootstrapFromEnv = true,
} = {}) {
  const regions = new Map(); // id → region record

  function assertValidRegionId(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new RegionContractError("bad_region_id", `region id must match ${ID_PATTERN}, got ${JSON.stringify(id)}`);
    }
  }

  function normalizeEndpoint(endpoint) {
    if (typeof endpoint !== "string" || !endpoint) throw new RegionContractError("bad_endpoint", "endpoint required (http(s) URL)");
    let u;
    try { u = new URL(endpoint); } catch { throw new RegionContractError("bad_endpoint", `endpoint is not a URL: ${JSON.stringify(endpoint)}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new RegionContractError("bad_endpoint", `endpoint must be http(s), got ${u.protocol}`);
    }
    // no path/query/fragment on region endpoints — keep the contract surface canonical
    return `${u.protocol}//${u.host}`.replace(/\/$/, "");
  }

  function getRegionRecord(id) {
    const r = regions.get(id);
    if (!r) throw new RegionContractError("unknown_region", `unknown region ${JSON.stringify(id)} (registered: ${[...regions.keys()].join(", ") || "none"})`);
    return r;
  }

  function workerStats(rec, { required = null } = {}) {
    let online = 0;
    let capacity = 0;
    let inFlight = 0;
    for (const w of rec.workers.values()) {
      if (workerOnline(w)) {
        online += 1;
        // when required capabilities are given, only workers covering ALL of
        // them contribute free capacity
        const covers = !required || [...required].every((c) => w.capabilities.has(c));
        if (covers) capacity += Math.max(0, w.concurrency - w.inFlight);
      }
      inFlight += w.inFlight;
    }
    return { workers: rec.workers.size, online, capacity, inFlight };
  }

  function workerOnline(w, at = Date.now()) {
    return w.status === "online" && at - w.lastSeenAt < staleAfterMs;
  }

  const registry = {
    staleAfterMs,

    // registerRegion — upsert with an explicit `replace` flag; a plain
    // duplicate registration is an error so two operators don't silently
    // overwrite each other's endpoint.
    registerRegion({ id, endpoint, capabilities, weight = 1, replace = false }) {
      assertValidRegionId(id);
      const ep = normalizeEndpoint(endpoint);
      const caps = normalizeCapabilities(capabilities);
      if (!caps.ok) throw new RegionContractError(caps.code, caps.error);
      const w = Number(weight);
      if (!Number.isFinite(w) || w <= 0) throw new RegionContractError("bad_weight", "weight must be a positive number");
      const existing = regions.get(id);
      if (existing && !replace) {
        throw new RegionContractError("duplicate_region", `region ${id} already registered (pass replace:true to update)`);
      }
      const rec = existing || { id, workers: new Map(), registeredAt: nowIso() };
      rec.endpoint = ep;
      rec.capabilities = new Set(caps.value);
      rec.weight = w;
      regions.set(id, rec);
      return registry.describeRegion(id);
    },

    deregisterRegion(id) {
      assertValidRegionId(id);
      if (!regions.has(id)) throw new RegionContractError("unknown_region", `unknown region ${JSON.stringify(id)}`);
      regions.delete(id);
      return { ok: true, id };
    },

    hasRegion: (id) => regions.has(id),
    regionIds: () => [...regions.keys()],

    getRegion(id) {
      getRegionRecord(id);
      return registry.describeRegion(id);
    },

    describeRegion(id) {
      const rec = getRegionRecord(id);
      const stats = workerStats(rec);
      return {
        id: rec.id,
        endpoint: rec.endpoint,
        capabilities: [...rec.capabilities],
        weight: rec.weight,
        registeredAt: rec.registeredAt,
        stats,
      };
    },

    listRegions() {
      return [...regions.values()]
        .map((r) => r.id)
        .sort()
        .map((id) => registry.describeRegion(id));
    },

    // ---- worker definitions per region ----
    registerWorker(regionId, { id, capabilities, concurrency = 1, endpoint = null, status = "online" } = {}, { replace = false } = {}) {
      const rec = getRegionRecord(regionId);
      if (typeof id !== "string" || !id || id.length > 128) throw new RegionContractError("bad_worker_id", "worker id required (<=128 chars)");
      const caps = normalizeCapabilities(capabilities);
      if (!caps.ok) throw new RegionContractError(caps.code, caps.error);
      const c = Number(concurrency);
      if (!Number.isInteger(c) || c < 1 || c > 256) throw new RegionContractError("bad_concurrency", "concurrency must be an integer 1..256");
      if (!["online", "draining"].includes(status)) throw new RegionContractError("bad_status", "worker status must be online|draining");
      if (rec.workers.has(id) && !replace) {
        throw new RegionContractError("duplicate_worker", `worker ${id} already registered in region ${regionId} (pass replace:true to update)`);
      }
      const worker = rec.workers.get(id) || { regionId, id, inFlight: 0 };
      worker.capabilities = new Set(caps.value);
      worker.concurrency = c;
      worker.endpoint = endpoint;
      worker.status = status;
      worker.lastSeenAt = Date.now();
      worker.registeredAt = worker.registeredAt || nowIso();
      rec.workers.set(id, worker);
      return registry.describeWorker(regionId, id);
    },

    deregisterWorker(regionId, workerId) {
      const rec = getRegionRecord(regionId);
      if (!rec.workers.has(workerId)) throw new RegionContractError("unknown_worker", `unknown worker ${JSON.stringify(workerId)} in region ${JSON.stringify(regionId)}`);
      rec.workers.delete(workerId);
      return { ok: true, regionId, workerId };
    },

    describeWorker(regionId, workerId) {
      const rec = getRegionRecord(regionId);
      const w = rec.workers.get(workerId);
      if (!w) throw new RegionContractError("unknown_worker", `unknown worker ${JSON.stringify(workerId)} in region ${JSON.stringify(regionId)}`);
      return {
        regionId, id: w.id,
        capabilities: [...w.capabilities],
        concurrency: w.concurrency,
        inFlight: w.inFlight,
        status: w.status,
        online: workerOnline(w),
        endpoint: w.endpoint,
        registeredAt: w.registeredAt,
        lastSeenAt: new Date(w.lastSeenAt).toISOString(),
      };
    },

    listWorkers(regionId) {
      const rec = getRegionRecord(regionId);
      return [...rec.workers.keys()].sort().map((wid) => registry.describeWorker(regionId, wid));
    },

    heartbeatWorker(regionId, workerId, { status } = {}) {
      const rec = getRegionRecord(regionId);
      const w = rec.workers.get(workerId);
      if (!w) throw new RegionContractError("unknown_worker", `heartbeat for unknown worker ${JSON.stringify(workerId)} in region ${JSON.stringify(regionId)} — register first`);
      if (status !== undefined) {
        if (!["online", "draining"].includes(status)) throw new RegionContractError("bad_status", "worker status must be online|draining");
        w.status = status;
      }
      w.lastSeenAt = Date.now();
      return registry.describeWorker(regionId, workerId);
    },

    // acquireWorker — reserve one slot on a capable online worker in the
    // region. Returns null when no worker qualifies (busy/capability/stale).
    // The reservation is released via release() or the reservation.release()
    // handle; release is idempotent and never drives inFlight below zero.
    acquireWorker(regionId, { required = [] } = {}) {
      const rec = getRegionRecord(regionId);
      const req = new Set(Array.isArray(required) ? required : []);
      const candidates = [...rec.workers.values()]
        .filter((w) => workerOnline(w))
        .filter((w) => [...req].every((c) => w.capabilities.has(c)))
        .filter((w) => w.inFlight < w.concurrency)
        .sort((a, b) => (a.inFlight - b.inFlight) || a.id.localeCompare(b.id));
      const w = candidates[0];
      if (!w) return null;
      w.inFlight += 1;
      let released = false;
      return {
        regionId, workerId: w.id,
        release() {
          if (released) return false;
          released = true;
          w.inFlight = Math.max(0, w.inFlight - 1);
          return true;
        },
      };
    },

    releaseWorker(regionId, workerId) {
      const rec = getRegionRecord(regionId);
      const w = rec.workers.get(workerId);
      if (!w) throw new RegionContractError("unknown_worker", `unknown worker ${JSON.stringify(workerId)} in region ${JSON.stringify(regionId)}`);
      w.inFlight = Math.max(0, w.inFlight - 1);
      return registry.describeWorker(regionId, workerId);
    },

    // selectRegion — regions covering `required`, ranked deterministically:
    // free worker capacity desc → weight desc → id asc. Capacity counts only
    // online workers that THEMSELVES cover the required capabilities (a
    // region advertising a capability its workers lack must not win on
    // phantom capacity). With requireOnlineWorker the region must currently
    // have such a worker with a free slot (used by the dispatcher; plain
    // capability listing may pass requireOnlineWorker:false).
    selectRegion({ required = [], requireOnlineWorker = false } = {}) {
      const req = Array.isArray(required) ? required : [];
      const reqSet = new Set(req);
      const rows = [];
      for (const rec of regions.values()) {
        if (!req.every((c) => rec.capabilities.has(c))) continue;
        const stats = workerStats(rec, { required: reqSet });
        if (requireOnlineWorker && stats.capacity < 1) continue;
        rows.push({ ...registry.describeRegion(rec.id), _free: stats.capacity });
      }
      rows.sort((a, b) => (b._free - a._free) || (b.weight - a.weight) || a.id.localeCompare(b.id));
      return rows.map(({ _free, ...rest }) => rest);
    },

    snapshot() {
      return {
        contractVersion: CONTRACT_VERSION,
        generatedAt: nowIso(),
        regions: registry.listRegions(),
      };
    },
  };

  if (bootstrapFromEnv) bootstrapRegionsFromEnv(registry);
  return registry;
}

// CLONER_REGIONS — optional JSON bootstrap: a list of region descriptors.
// Parse problems throw a clean, env-naming error (fail loudly at boot, not at
// the first dispatch).
export function bootstrapRegionsFromEnv(registry, env = process.env) {
  const raw = env.CLONER_REGIONS;
  if (!raw || !raw.trim()) return [];
  let list;
  try { list = JSON.parse(raw); }
  catch (e) { throw new RegionContractError("bad_env", `CLONER_REGIONS is not valid JSON: ${e.message}`); }
  if (!Array.isArray(list)) throw new RegionContractError("bad_env", "CLONER_REGIONS must be a JSON array of {id, endpoint, capabilities}");
  const registered = [];
  for (const item of list) {
    registered.push(registry.registerRegion({ replace: true, ...item }));
  }
  return registered;
}

let singleton = null;
export function getRegionRegistry() {
  if (!singleton) singleton = createRegionRegistry();
  return singleton;
}
// test hook — reset the singleton between suites
export function resetRegionRegistry() { singleton = null; }

// ---------------------------------------------------------------------------
// Region node — one region's HTTP plane (REAL http server, REAL files)
// ---------------------------------------------------------------------------

// Body reader with a hard cap; returns a Buffer.
function readBody(req, { maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`body exceeds ${maxBytes} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// Safe job directory under the region's artifacts root: jobId is validated by
// the contract patterns, so this can never traverse (charset excludes "/" and "..").
function jobDir(artifactsRoot, jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) throw new RegionContractError("bad_job_id", "jobId must be a safe id");
  return path.join(artifactsRoot, jobId);
}

function writeManifestAtomic(dir, manifest) {
  const target = path.join(dir, contracts.MANIFEST_NAME);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, target);
}

export function createRegionNode({
  regionId,
  capabilities = [],
  port = 0,
  host = "127.0.0.1",
  // Where uploaded artifacts are stored (real files).
  artifactsRoot = null,
  // executor(request, ctx) → { status, error?, meta? }. ctx gives the
  // executor the artifact store + stage reporting; the node assembles the
  // contract-valid ExecutionResult around whatever the executor returns.
  executor = null,
  // Optional registry: worker self-registrations and heartbeats arriving over
  // HTTP are recorded here (so a remote coordinator sees workers per region).
  registry = null,
  registerWorkersRemotely = true,
  issuerCheck = null, // optional (issuer) => boolean; default: accept any signed issuer
} = {}) {
  if (typeof regionId !== "string" || !ID_PATTERN.test(regionId)) {
    throw new RegionContractError("bad_region_id", `region id must match ${ID_PATTERN}, got ${JSON.stringify(regionId)}`);
  }
  const caps = normalizeCapabilities(capabilities);
  if (!caps.ok) throw new RegionContractError(caps.code, caps.error);
  const root = artifactsRoot
    || (process.env.CLONER_REGION_ARTIFACTS_ROOT
      ? path.join(process.env.CLONER_REGION_ARTIFACTS_ROOT, regionId)
      : path.join(process.cwd(), "artifacts-regions", regionId));
  fs.mkdirSync(root, { recursive: true });

  const startedAt = Date.now();
  const executions = { total: 0, byStatus: {} };
  const stageLog = []; // bounded ring of { jobId, stage, at }

  function auth(req) {
    const secret = requireRegionSecret(); // clean "no_secret" error when env missing
    const token = bearerFromHeader(req.headers.authorization);
    const claims = contracts.verifyRegionToken(token, secret, { audience: regionId });
    if (issuerCheck && !issuerCheck(claims.iss)) throw new RegionAuthError("bad_issuer", `issuer ${JSON.stringify(claims.iss)} is not accepted by this region`);
    return claims;
  }

  async function handleExecutions(req, res) {
    auth(req);
    const raw = await readBody(req, { maxBytes: 8 * 1024 * 1024 });
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); }
    catch { throw new RegionContractError("bad_body", "execution request is not valid JSON"); }
    const request = validateExecutionRequest(parsed);
    if (request.regionId !== regionId) {
      throw new RegionContractError("wrong_region", `request targets ${request.regionId}, this region is ${regionId}`);
    }
    contracts.assertCompatible(request.contractVersion);
    if (typeof executor !== "function") throw new RegionContractError("no_executor", "this region node has no executor configured");

    const started = Date.now();
    executions.total += 1;
    const artifacts = [];
    const store = {
      async save(name, buf, contentType = "text/plain; charset=utf-8") {
        const env = validateArtifactEnvelope({
          contractVersion: CONTRACT_VERSION, regionId, jobId: request.jobId, name,
          sha256: digestArtifact(buf), bytes: buf.length, contentType, createdAt: nowIso(),
        });
        const dir = jobDir(root, request.jobId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, env.name), buf);
        // refresh the per-job manifest (real file, atomic-ish rename)
        const manifestPath = path.join(dir, contracts.MANIFEST_NAME);
        let manifest = { contractVersion: CONTRACT_VERSION, regionId, jobId: request.jobId, artifacts: [], createdAt: nowIso() };
        try { manifest = validateArtifactManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))); }
        catch { /* first artifact for this job */ }
        manifest.artifacts = manifest.artifacts.filter((a) => a.name !== env.name);
        manifest.artifacts.push(env);
        writeManifestAtomic(dir, manifest);
        artifacts.push(env);
        return env;
      },
    };
    const report = (stage) => {
      stageLog.push({ jobId: request.jobId, stage: String(stage).slice(0, 64), at: nowIso() });
      if (stageLog.length > 500) stageLog.shift();
    };
    let inner;
    try {
      inner = (await executor(request, { artifactStore: store, report, regionId, startedAt: new Date(started).toISOString() })) || {};
    } catch (e) {
      inner = { status: "error", error: String(e.message || e).slice(0, 300) };
    }
    const result = validateExecutionResult({
      contractVersion: CONTRACT_VERSION,
      jobId: request.jobId, taskId: request.taskId, regionId,
      workerId: `node-${regionId}-${process.pid}`,
      status: contracts.EXECUTION_STATUSES.includes(inner.status) ? inner.status : "completed",
      artifacts,
      durationMs: Date.now() - started,
      error: inner.error || null,
      meta: inner.meta && typeof inner.meta === "object" ? inner.meta : {},
    });
    executions.byStatus[result.status] = (executions.byStatus[result.status] || 0) + 1;
    sendJson(res, 200, result); // transport always 200 — the contract STATUS carries the outcome
  }

  async function handleArtifactUpload(req, res, jobId) {
    auth(req);
    const name = String(req.headers["x-artifact-name"] || "");
    if (!ARTIFACT_NAME_PATTERN.test(name)) throw new RegionContractError("bad_artifact_name", "x-artifact-name must be a safe basename");
    const sha = String(req.headers["x-artifact-sha256"] || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new RegionContractError("bad_digest", "x-artifact-sha256 must be a 64-char hex digest");
    const contentType = String(req.headers["x-artifact-content-type"] || "application/octet-stream");
    const buf = await readBody(req);
    const dir = jobDir(root, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const envelope = {
      contractVersion: CONTRACT_VERSION, regionId, jobId, name,
      sha256: digestArtifact(buf), bytes: buf.length, contentType, createdAt: nowIso(),
    };
    // verify BEFORE persisting — a tampered upload never lands on disk
    verifyArtifactEnvelope(envelope, buf);
    if (sha !== envelope.sha256) throw new RegionContractError("artifact_digest_mismatch", "x-artifact-sha256 does not match the body");
    fs.writeFileSync(path.join(dir, name), buf);
    const manifestPath = path.join(dir, contracts.MANIFEST_NAME);
    let manifest;
    try { manifest = validateArtifactManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))); }
    catch { manifest = makeArtifactManifest({ regionId, jobId, artifacts: [] }); }
    manifest.artifacts = manifest.artifacts.filter((a) => a.name !== name);
    manifest.artifacts.push(envelope);
    writeManifestAtomic(dir, manifest);
    sendJson(res, 201, { stored: true, envelope, manifestName: contracts.MANIFEST_NAME });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = `${req.method} ${url.pathname}`;
    Promise.resolve().then(async () => {
      if (route === "GET /v1/health") {
        let onlineWorkers = 0;
        if (registry) { try { onlineWorkers = registry.listWorkers(regionId).filter((w) => w.online).length; } catch { /* region not registered yet */ } }
        return sendJson(res, 200, {
          ok: true, regionId, contractVersion: CONTRACT_VERSION,
          capabilities: caps.value, uptimeMs: Date.now() - startedAt, onlineWorkers,
        });
      }
      if (route === "GET /v1/contract") {
        return sendJson(res, 200, { contractVersion: CONTRACT_VERSION, regionId, capabilities: caps.value });
      }
      if (route === "POST /v1/executions") return handleExecutions(req, res);
      const artifactMatch = /^\/v1\/artifacts\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (artifactMatch && req.method === "POST" && !artifactMatch[2]) return handleArtifactUpload(req, res, artifactMatch[1]);
      if (artifactMatch && req.method === "GET" && !artifactMatch[2]) {
        auth(req);
        const jobId = artifactMatch[1];
        const manifestPath = path.join(jobDir(root, jobId), contracts.MANIFEST_NAME);
        if (!fs.existsSync(manifestPath)) return sendJson(res, 404, { error: "no artifacts for job", code: "not_found" });
        return sendJson(res, 200, JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      }
      if (artifactMatch && req.method === "GET" && artifactMatch[2]) {
        auth(req);
        const [, jobId, name] = artifactMatch;
        if (!ARTIFACT_NAME_PATTERN.test(name)) throw new RegionContractError("bad_artifact_name", "artifact name must be a safe basename");
        const file = path.join(jobDir(root, jobId), name);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: "artifact not found", code: "not_found" });
        const buf = fs.readFileSync(file);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-artifact-sha256": digestArtifact(buf),
          "x-artifact-name": name,
          "content-length": buf.length,
        });
        return void res.end(buf);
      }
      if (route === "POST /v1/workers") {
        auth(req);
        const raw = await readBody(req, { maxBytes: 64 * 1024 });
        const def = JSON.parse(raw.toString("utf8") || "{}");
        if (!registry) return sendJson(res, 501, { error: "this node has no registry attached", code: "no_registry" });
        if (!registerWorkersRemotely) return sendJson(res, 403, { error: "remote worker registration disabled", code: "disabled" });
        const described = registry.registerWorker(regionId, { ...def, id: def.id }, { replace: true });
        return sendJson(res, 201, { ok: true, worker: described });
      }
      if (route === "POST /v1/heartbeat") {
        auth(req);
        const raw = await readBody(req, { maxBytes: 16 * 1024 });
        const body = JSON.parse(raw.toString("utf8") || "{}");
        if (!registry) return sendJson(res, 501, { error: "this node has no registry attached", code: "no_registry" });
        const described = registry.heartbeatWorker(regionId, body.workerId, { status: body.status });
        return sendJson(res, 200, { ok: true, worker: described });
      }
      return sendJson(res, 404, { error: "unknown route", code: "not_found" });
    }).catch((e) => {
      const status = e instanceof RegionAuthError ? 401 : (e?.status || (e instanceof RegionContractError ? 400 : 500));
      sendJson(res, status, { error: String(e.message || e).slice(0, 240), code: e.code || "internal" });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        regionId,
        endpoint: `http://${host}:${bound}`,
        capabilities: caps.value,
        artifactsRoot: root,
        contractVersion: CONTRACT_VERSION,
        stageLog,
        executions,
        close: () => new Promise((r) => server.close(r)),
        server,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Client — coordinator side, REAL fetch over the region's endpoint
// ---------------------------------------------------------------------------

export class RegionProtocolError extends Error {
  constructor(message, { status = 0, code = "protocol" } = {}) {
    super(message);
    this.name = "RegionProtocolError";
    this.status = status;
    this.code = code;
  }
}

export function createRegionClient({
  issuer = process.env.CLONER_REGION_ID || "local",
  secret = null, // lazily resolved from env per call by default
  tokenTtlMs = 60_000,
} = {}) {
  const getSecret = () => (secret !== null ? secret : requireRegionSecret());
  const mint = ({ audience, sub }) => contracts.mintRegionToken(
    { iss: issuer, aud: audience, sub, capabilities: [], ttlMs: tokenTtlMs },
    getSecret(),
  );

  async function call(region, method, pathname, { body, headers = {}, timeoutMs = 120_000, audience, sub = "coordinator", raw = false } = {}) {
    if (!region || typeof region.endpoint !== "string") throw new RegionProtocolError("region endpoint unknown", { code: "bad_region" });
    const token = mint({ audience: audience || region.id, sub });
    const ctl = AbortSignal.timeout(timeoutMs);
    let resp;
    try {
      resp = await fetch(`${region.endpoint}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...headers },
        body,
        signal: ctl,
      });
    } catch (e) {
      throw new RegionProtocolError(`region ${region.id} unreachable at ${region.endpoint}: ${e.message}`, { code: "unreachable" });
    }
    if (!resp.ok) {
      let detail = {};
      try { detail = await resp.json(); } catch { /* non-JSON error body */ }
      throw new RegionProtocolError(
        `region ${region.id} ${method} ${pathname} → HTTP ${resp.status}: ${detail.error || "request failed"}`,
        { status: resp.status, code: detail.code || `http_${resp.status}` },
      );
    }
    if (raw) return resp;
    return resp.json();
  }

  return {
    issuer,
    // handshake → validate the peer's contract version (fails closed on major mismatch)
    async handshake(region) {
      const data = await call(region, "GET", "/v1/contract", { timeoutMs: 10_000 });
      contracts.assertCompatible(data.contractVersion);
      if (data.regionId !== region.id) {
        throw new RegionProtocolError(`region endpoint answered as ${data.regionId}, registry says ${region.id}`, { code: "region_mismatch" });
      }
      return data;
    },
    async health(region) { return call(region, "GET", "/v1/health", { timeoutMs: 10_000 }); },
    async dispatchExecution(region, request, { timeoutMs = 120_000 } = {}) {
      const validated = validateExecutionRequest({
        ...request, regionId: region.id, contractVersion: CONTRACT_VERSION,
        issuedBy: request.issuedBy || issuer, // coordinator stamps its own identity by default
      });
      const data = await call(region, "POST", "/v1/executions", {
        body: JSON.stringify(validated), headers: { "content-type": "application/json" }, timeoutMs,
      });
      const result = validateExecutionResult(data); // contract violations → RegionContractError
      if (result.jobId !== validated.jobId) {
        throw new RegionProtocolError(`region answered with jobId ${result.jobId}, expected ${validated.jobId}`, { code: "job_mismatch" });
      }
      return result;
    },
    async uploadArtifact(region, jobId, name, buf, { contentType = "application/octet-stream" } = {}) {
      const data = await call(region, "POST", `/v1/artifacts/${encodeURIComponent(jobId)}`, {
        body: buf,
        headers: {
          "content-type": "application/octet-stream",
          "x-artifact-name": name,
          "x-artifact-sha256": digestArtifact(buf),
          "x-artifact-content-type": contentType,
        },
      });
      return validateArtifactEnvelope(data.envelope);
    },
    async fetchArtifactManifest(region, jobId) {
      return validateArtifactManifest(await call(region, "GET", `/v1/artifacts/${encodeURIComponent(jobId)}`));
    },
    async downloadArtifact(region, jobId, name) {
      const resp = await call(region, "GET", `/v1/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}`, { raw: true });
      const buf = Buffer.from(await resp.arrayBuffer());
      const sha = String(resp.headers.get("x-artifact-sha256") || "");
      if (sha && sha !== digestArtifact(buf)) {
        throw new RegionContractError("artifact_digest_mismatch", `downloaded artifact ${name}: digest mismatch in transit`);
      }
      return buf;
    },
    async registerRemoteWorker(region, workerDef) {
      const data = await call(region, "POST", "/v1/workers", {
        body: JSON.stringify(workerDef), headers: { "content-type": "application/json" }, sub: workerDef?.id || "worker",
      });
      return data.worker;
    },
    async heartbeat(region, workerId, { status } = {}) {
      const data = await call(region, "POST", "/v1/heartbeat", {
        body: JSON.stringify({ workerId, status }), headers: { "content-type": "application/json" }, sub: workerId,
      });
      return data.worker;
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — selectRegion → reserve worker → execute → release (finally)
// ---------------------------------------------------------------------------

export function createRegionDispatcher({ registry, client }) {
  if (!registry || !client) throw new RegionContractError("bad_args", "createRegionDispatcher requires { registry, client }");
  return {
    async dispatch({
      jobId, taskId, url, required = [], options = {}, deadlineMs = null, timeoutMs = 120_000, issuedBy = null,
    }) {
      const candidates = registry.selectRegion({ required, requireOnlineWorker: true });
      if (!candidates.length) {
        const known = registry.listRegions().map((r) => `${r.id}(${r.capabilities.join("+")})`).join(", ") || "none";
        throw new RegionProtocolError(
          `no region can satisfy required capabilities [${required.join(", ")}] with a free online worker — registered: ${known}`,
          { code: "no_region" },
        );
      }
      let lastErr = null;
      for (const region of candidates) {
        const reservation = registry.acquireWorker(region.id, { required });
        if (!reservation) continue; // raced away — try the next candidate
        try {
          const result = await client.dispatchExecution(region, {
            jobId, taskId, url, regionId: region.id,
            issuedBy: issuedBy || "dispatcher",
            requiredCapabilities: required, options, deadlineMs, contractVersion: CONTRACT_VERSION,
          }, { timeoutMs });
          return { result, region: { id: region.id, endpoint: region.endpoint }, workerId: reservation.workerId };
        } catch (e) {
          lastErr = e;
          // a region that is unreachable/protocol-broken is skipped; the next
          // candidate gets the job (failover across the candidate list)
          continue;
        } finally {
          reservation.release();
        }
      }
      throw lastErr || new RegionProtocolError("dispatch failed on every candidate region", { code: "dispatch_failed" });
    },
  };
}

// ---------------------------------------------------------------------------
// Express admin surface for the integrator (mount line documented above)
// ---------------------------------------------------------------------------

export function regionRouter({ registry = null, authRequired = null } = {}) {
  const reg = registry || getRegionRegistry();
  const router = Router();
  const guard = authRequired || ((_req, _res, next) => next());
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      const status = e?.status || (e instanceof RegionContractError ? 400 : 500);
      res.status(status).json({ error: String(e?.message || "internal error").slice(0, 200) });
    });
  };

  router.get("/", guard, wrap(async (_req, res) => { res.json(reg.snapshot()); }));

  router.post("/", guard, wrap(async (req, res) => {
    const { id, endpoint, capabilities, weight, replace } = req.body || {};
    res.status(201).json(reg.registerRegion({ id, endpoint, capabilities, weight, replace: replace === true }));
  }));

  router.get("/:regionId", guard, wrap(async (req, res) => { res.json(reg.getRegion(req.params.regionId)); }));

  router.delete("/:regionId", guard, wrap(async (req, res) => { res.json(reg.deregisterRegion(req.params.regionId)); }));

  router.get("/:regionId/workers", guard, wrap(async (req, res) => { res.json(reg.listWorkers(req.params.regionId)); }));

  router.post("/:regionId/workers", guard, wrap(async (req, res) => {
    const def = req.body || {};
    res.status(201).json(reg.registerWorker(req.params.regionId, def, { replace: req.body?.replace === true }));
  }));

  router.delete("/:regionId/workers/:workerId", guard, wrap(async (req, res) => {
    res.json(reg.deregisterWorker(req.params.regionId, req.params.workerId));
  }));

  return router;
}
