// Advanced multi-region failover (task 4.2.9): region-down detection through
// heartbeat loss, job re-route to healthy regions, artifact re-replication,
// and partial-failure recovery — with simulation tests that INJECT real region
// failures (a region simply stops heartbeating; its storage is a real dir).
//
// INTEGRATOR MOUNT LINE (src/platform/server.js is integrator-owned):
//
//   import { failoverRoutes, createFailoverController, createQueueDispatcher } from "../distributed/failover.js";
//   import { getCloneQueue } from "../queues/clone-queue.js";
//   const failover = createFailoverController({
//     dispatch: createQueueDispatcher(getCloneQueue()), // real re-route handoff
//   });
//   failover.start();                                   // periodic heartbeat sweep
//   app.use("/api/distributed", failoverRoutes({ controller: failover, guard: adminGuardOptional }));
//
// Stores (same two-store pattern as src/workers/worker-health.js):
//   • Redis (preferred, cross-process, REAL ioredis SETEX/GET): region
//     heartbeats get a REAL server-side TTL (a crashed region's key expires on
//     the Redis server itself), job assignments / artifact indexes / replica
//     ledgers survive process restarts. Chosen when CLONER_REDIS_URL or
//     REDIS_URL is set AND the server answers; unreachable Redis falls back to
//     memory with a one-line warn (same posture as clone-queue).
//   • In-memory (fallback, no Redis): identical semantics inside one process.
//
// Redis keys (namespace cloner:region:*):
//   cloner:region:heartbeat:<regionId>   JSON {regionId, ts, status, ...}   TTL
//   cloner:region:job:<jobId>            JSON assignment {region, status, reroutes[]}
//   cloner:region:artifacts:<regionId>   JSON [{jobId, rel}] artifact sets homed there
//   cloner:region:replica:<jobId>        JSON ledger {primary, replicas:{region:{state,...}}}
//   cloner:region:manual:<regionId>      JSON {down: true, at}   ops force-down
//   cloner:region:index:jobs / :replicas JSON id indexes for list-all reads
//
// Heartbeat-loss detection: freshness = key exists AND (clock - snap.ts) <=
// heartbeatTtlMs. This is deterministic on BOTH backends (the ts check), and
// on Redis the key ALSO physically expires server-side. Reported states:
//   healthy  — fresh heartbeat
//   down     — heartbeat record exists but is stale, or ops force-down
//   unknown  — no heartbeat record at all (never beaten, or the Redis key
//              physically expired after a long silence)
// The failover machinery treats every not-healthy observation of a previously
// healthy region (and of a region first observed already dead) as down-like,
// so expiry, staleness and controller restarts all trigger failover.
//
// Re-route: non-terminal jobs on a down region are handed to the least-loaded
// healthy region and (via the injected `dispatch` hook — the REAL handoff, e.g.
// createQueueDispatcher over the real clone queue) actually re-executed. Jobs
// already terminal (completed/failed/cancelled) are never re-routed.
//
// Artifact re-replication: on region-down every artifact set homed there
// (terminal jobs included — the payload must survive) is copied to a healthy
// region and sha256-VERIFIED file-by-file; `replicated` means byte-identical.
// Copies are RESUMABLE: an interrupted copy leaves a partial dir (exactly what
// a real crash leaves) and the next attempt skips intact files (sha-match) and
// copies only what is missing/mismatched.
//
// Partial-failure recovery (all automatic on the sweep tick):
//   1. reroute backlog: jobs whose dispatch failed or that found no healthy
//      region (pendingReroute) drain as soon as any region is healthy again.
//   2. interrupted replicas: partial/blocked/failed replica entries resume at
//      file level once source+target are healthy.
//   3. un-replicated payloads: ledgers with zero healthy replicas of a down
//      region's artifacts get a new healthy replica.
//   4. no ping-pong: a recovered region does NOT pull re-routed jobs back.
//
// Env knobs: CLONER_REGION_HEARTBEAT_TTL_MS (default 45000 = 3 missed beats),
// CLONER_FAILOVER_TICK_MS (default 10000), CLONER_REDIS_URL / REDIS_URL.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Router } from "express";

export const KEY_PREFIX = "cloner:region:";
const HB_KEY = (r) => KEY_PREFIX + "heartbeat:" + r;
const JOB_KEY = (j) => KEY_PREFIX + "job:" + j;
const ART_KEY = (r) => KEY_PREFIX + "artifacts:" + r;
const REPL_KEY = (j) => KEY_PREFIX + "replica:" + j;
const MANUAL_KEY = (r) => KEY_PREFIX + "manual:" + r;
const JOB_INDEX_KEY = KEY_PREFIX + "index:jobs";
const REPL_INDEX_KEY = KEY_PREFIX + "index:replicas";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const defaultHeartbeatTtlMs = () => Number(process.env.CLONER_REGION_HEARTBEAT_TTL_MS || 45000);
const defaultTickMs = () => Number(process.env.CLONER_FAILOVER_TICK_MS || 10000);

// same precedence as src/queues/clone-queue.js resolveRedisUrl()
export function resolveRedisUrl() {
  return process.env.CLONER_REDIS_URL || process.env.REDIS_URL || "";
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// recursive file list with POSIX-style rel paths; the replica marker file is
// never part of a set (it describes the replica, it is not user content)
function listFilesRecursive(root, rel = "") {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".failover-replica.json") continue;
    const child = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...listFilesRecursive(root, child));
    else if (ent.isFile()) out.push(child);
  }
  return out.sort();
}

// ---- key/value stores -------------------------------------------------------
// Individual records are independent keys (durable across processes on Redis);
// the id indexes are read-modify-write arrays — multi-writer index updates are
// last-write-wins, individual records never are (documented trade-off).

class MemoryStore {
  async get(key) {
    const raw = this.#map.get(key);
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  async set(key, value, _ttlSec = 0) {
    this.#map.set(key, JSON.stringify(value));
  }
  async del(key) { this.#map.delete(key); }
  #map = new Map();
}

class RedisStore {
  constructor(client) { this.client = client; }
  async get(key) {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  async set(key, value, ttlSec = 0) {
    const json = JSON.stringify(value);
    if (ttlSec > 0) await this.client.setex(key, Math.max(1, Math.ceil(ttlSec)), json);
    else await this.client.set(key, json);
  }
  async del(key) { try { await this.client.del(key); } catch { /* best effort */ } }
}

async function probeRedis(redisUrl, log) {
  try {
    const mod = await import("ioredis");
    const IORedis = mod.default;
    const client = new IORedis(redisUrl, { lazyConnect: true, connectTimeout: 2000, retryStrategy: () => null, enableOfflineQueue: false });
    client.on("error", () => {});
    await client.connect();
    await client.ping();
    return client;
  } catch (e) {
    log?.(`[failover] redis unreachable (${String(e?.message || e).slice(0, 120)}) — in-memory failover store`);
    return null;
  }
}

// ---- controller ---------------------------------------------------------------

export function createFailoverController(opts = {}) {
  return new FailoverController(opts);
}

export class FailoverController extends EventEmitter {
  constructor({
    redis = null,
    redisUrl = resolveRedisUrl(),
    heartbeatTtlMs = defaultHeartbeatTtlMs(),
    tickMs = defaultTickMs(),
    dispatch = null, // async ({jobId, job, fromRegion, toRegion, reason}) — the REAL re-route handoff
    maxRerouteAttempts = 3,
    maxReplicationAttempts = 3,
    maxRerouteBacklog = 500,
    clock = () => Date.now(),
    log = (m) => console.log(m),
  } = {}) {
    super();
    this.setMaxListeners(50);
    this.heartbeatTtlMs = Math.max(50, heartbeatTtlMs);
    this.tickMs = Math.max(100, tickMs);
    this.dispatch = dispatch;
    this.maxRerouteAttempts = maxRerouteAttempts;
    this.maxReplicationAttempts = maxReplicationAttempts;
    this.maxRerouteBacklog = maxRerouteBacklog;
    this.clock = clock;
    this.log = log;
    this.backend = "memory";
    this.#regions = new Map(); // regionId → {regionId, storageRoot, capacity, registeredAt}
    this.#views = new Map(); // regionId → {state, since} (observer-local transition memory)
    this.#timer = null;
    this.recentActions = [];
    this.#redisProbe = this.#resolveBackend(redis, redisUrl);
  }

  #regions;
  #views;
  #timer;
  #store = new MemoryStore();
  #ownRedis = null;
  #sweeping = false;
  #redisProbe;

  get ready() { return this.#redisProbe; }

  async #resolveBackend(redis, redisUrl) {
    if (redis) {
      this.#store = new RedisStore(redis);
      this.backend = "redis";
      return;
    }
    if (!redisUrl) { this.#store = new MemoryStore(); this.backend = "memory"; return; }
    const client = await probeRedis(redisUrl, this.log);
    if (client) {
      this.#ownRedis = client;
      this.#store = new RedisStore(client);
      this.backend = "redis";
    } else {
      this.#store = new MemoryStore();
      this.backend = "memory";
    }
  }

  // ---- region registry ------------------------------------------------------

  async registerRegion({ regionId, storageRoot, capacity = Infinity } = {}) {
    await this.ready;
    if (!regionId || typeof regionId !== "string") throw new Error("registerRegion: regionId is required");
    if (!storageRoot) throw new Error(`registerRegion: storageRoot is required for region '${regionId}'`);
    fs.mkdirSync(storageRoot, { recursive: true }); // real storage, real dir
    const region = { regionId, storageRoot: path.resolve(storageRoot), capacity: Number.isFinite(+capacity) ? +capacity : Infinity, registeredAt: new Date().toISOString() };
    this.#regions.set(regionId, region);
    this.#view(regionId, this.#computeState(regionId));
    this.#emit("region-registered", { regionId, storageRoot: region.storageRoot });
    return this.getRegion(regionId);
  }

  async unregisterRegion(regionId) {
    await this.ready;
    this.#regions.delete(regionId);
    this.#views.delete(regionId);
    await this.#store.del(MANUAL_KEY(regionId));
    await this.#store.del(HB_KEY(regionId));
  }

  // heartbeat — the ONLY liveness signal. Write failure throws: a region that
  // cannot publish its heartbeat is exactly a region that must be seen as down.
  async heartbeat(regionId, snapshot = {}) {
    await this.ready;
    if (!this.#regions.has(regionId)) throw new Error(`heartbeat: unknown region '${regionId}'`);
    const snap = { ...snapshot, status: snapshot.status || "running", regionId, ts: this.clock() };
    await this.#store.set(HB_KEY(regionId), snap, Math.ceil(this.heartbeatTtlMs / 1000));
    return snap;
  }

  async getRegion(regionId) {
    await this.ready;
    const region = this.#regions.get(regionId);
    if (!region) return null;
    const hb = await this.#store.get(HB_KEY(regionId));
    const manual = await this.#store.get(MANUAL_KEY(regionId));
    const ageMs = hb ? this.clock() - Number(hb.ts) : null;
    return {
      ...region,
      state: this.#computeState(regionId, hb, manual),
      lastBeatAt: hb ? new Date(Number(hb.ts)).toISOString() : null,
      beatAgeMs: ageMs,
      status: hb?.status || null,
      manualDown: manual?.down === true,
    };
  }

  async listRegions() {
    await this.ready;
    const out = [];
    for (const id of this.#regions.keys()) out.push(await this.getRegion(id));
    return out.sort((a, b) => a.regionId.localeCompare(b.regionId));
  }

  // force-down (ops lever for planned failover / tests). Behaves exactly like
  // observed heartbeat loss on the next sweep.
  async forceDown(regionId) {
    await this.ready;
    if (!this.#regions.has(regionId)) throw new Error(`forceDown: unknown region '${regionId}'`);
    await this.#store.set(MANUAL_KEY(regionId), { down: true, at: new Date().toISOString() });
    return this.getRegion(regionId);
  }

  async forceUp(regionId) {
    await this.ready;
    if (!this.#regions.has(regionId)) throw new Error(`forceUp: unknown region '${regionId}'`);
    await this.#store.del(MANUAL_KEY(regionId));
    return this.getRegion(regionId);
  }

  #computeState(regionId, hb, manual) {
    if (manual?.down === true) return "down";
    if (!hb) return "unknown";
    const age = this.clock() - Number(hb.ts);
    return Number.isFinite(age) && age >= 0 && age <= this.heartbeatTtlMs ? "healthy" : "down";
  }

  async #stateOf(regionId) {
    const hb = await this.#store.get(HB_KEY(regionId));
    const manual = await this.#store.get(MANUAL_KEY(regionId));
    return this.#computeState(regionId, hb, manual);
  }

  async healthyRegions() {
    const out = [];
    for (const id of this.#regions.keys()) {
      if (await this.#stateOf(id) !== "healthy") continue;
      const load = await this.#regionLoad(id);
      const capacity = this.#regions.get(id).capacity;
      if (Number.isFinite(capacity) && load >= capacity) continue; // full
      out.push({ regionId: id, load, capacity });
    }
    return out.sort((a, b) => a.load - b.load || a.regionId.localeCompare(b.regionId)); // least-loaded first
  }

  async #regionLoad(regionId) {
    const jobs = await this.listJobAssignments();
    return jobs.filter((j) => j.region === regionId && !TERMINAL_STATUSES.has(j.status)).length;
  }

  // ---- job assignment ledger -------------------------------------------------

  async assignJob(jobId, regionId, { status = "queued", payload = null, owner = null, artifactRel = null } = {}) {
    await this.ready;
    if (!jobId) throw new Error("assignJob: jobId is required");
    if (!this.#regions.has(regionId)) throw new Error(`assignJob: unknown region '${regionId}'`);
    const record = {
      jobId, region: regionId, status,
      payload: payload ?? null, owner: owner ?? null,
      artifactRel: artifactRel || null,
      assignedAt: new Date().toISOString(),
      reroutes: [], rerouteAttempts: 0, pendingReroute: false, rerouteFailed: null, lastRerouteError: null,
    };
    await this.#store.set(JOB_KEY(jobId), record);
    await this.#indexAdd(JOB_INDEX_KEY, jobId);
    if (artifactRel) await this.#addArtifactSet(regionId, { jobId, rel: artifactRel });
    return record;
  }

  async getJobAssignment(jobId) {
    await this.ready;
    return this.#store.get(JOB_KEY(jobId));
  }

  async setJobStatus(jobId, status) {
    await this.ready;
    const record = await this.#store.get(JOB_KEY(jobId));
    if (!record) throw new Error(`setJobStatus: unknown job '${jobId}'`);
    record.status = String(status);
    await this.#store.set(JOB_KEY(jobId), record);
    return record;
  }

  async listJobAssignments() {
    await this.ready;
    const ids = await this.#index(JOB_INDEX_KEY);
    const out = [];
    for (const id of ids) {
      const rec = await this.#store.get(JOB_KEY(id));
      if (rec) out.push(rec);
    }
    return out;
  }

  // ---- artifact-set index -----------------------------------------------------

  async #addArtifactSet(regionId, set) {
    const key = ART_KEY(regionId);
    const list = (await this.#store.get(key)) || [];
    if (!list.some((x) => x.jobId === set.jobId)) {
      list.push(set);
      if (list.length > 10000) list.shift(); // bounded
      await this.#store.set(key, list);
    }
  }

  async listArtifactSets(regionId) {
    await this.ready;
    return (await this.#store.get(ART_KEY(regionId))) || [];
  }

  // ---- replica ledger ----------------------------------------------------------

  async getReplicaLedger(jobId) {
    await this.ready;
    return this.#store.get(REPL_KEY(jobId));
  }

  async listReplicaLedgers() {
    await this.ready;
    const ids = await this.#index(REPL_INDEX_KEY);
    const out = [];
    for (const id of ids) {
      const rec = await this.#store.get(REPL_KEY(id));
      if (rec) out.push(rec);
    }
    return out;
  }

  async #saveLedger(ledger) {
    await this.#store.set(REPL_KEY(ledger.jobId), ledger);
    await this.#indexAdd(REPL_INDEX_KEY, ledger.jobId);
  }

  // ---- replication (real fs copy + sha256 verification, resumable) --------------

  /**
   * Copy the artifact set `rel` of `jobId` from region `fromRegionId` to
   * `toRegionId`, then sha256-verify every file. Resumable: intact files
   * (sha-match) are skipped, only missing/mismatched files are copied.
   *
   * opts.failAfter / opts.failOn are TEST-ONLY injection points (same posture
   * as clone-queue's bullmqFactory) that abort the copy mid-flight to produce
   * the on-disk state a real crash leaves behind. Never used by product paths.
   */
  async replicateJobArtifacts(jobId, fromRegionId, toRegionId, opts = {}) {
    await this.ready;
    const from = this.#regions.get(fromRegionId);
    const to = this.#regions.get(toRegionId);
    if (!from) throw new Error(`replicateJobArtifacts: unknown source region '${fromRegionId}'`);
    if (!to) throw new Error(`replicateJobArtifacts: unknown target region '${toRegionId}'`);
    if (fromRegionId === toRegionId) throw new Error("replicateJobArtifacts: source and target region must differ");

    const assignment = await this.getJobAssignment(jobId);
    const rel = assignment?.artifactRel || jobId;
    const srcDir = path.join(from.storageRoot, rel);
    const dstDir = path.join(to.storageRoot, rel);

    const ledger = (await this.getReplicaLedger(jobId)) || { jobId, primary: fromRegionId, replicas: {}, attempts: 0, pendingReplication: false, updatedAt: null };
    ledger.primary = fromRegionId;
    ledger.updatedAt = new Date().toISOString();

    // refuse to replicate INTO a region that is not healthy (down or silent) —
    // the backlog is reconciled automatically once it recovers
    if ((await this.#stateOf(toRegionId)) !== "healthy") {
      ledger.replicas[toRegionId] = { state: "blocked", reason: "region-down", at: new Date().toISOString() };
      await this.#saveLedger(ledger);
      return { state: "blocked", reason: "region-down", jobId, toRegion: toRegionId };
    }

    if (!fs.existsSync(srcDir)) {
      ledger.replicas[toRegionId] = { state: "failed", error: `source artifacts not found: ${rel}`, attempts: (ledger.replicas[toRegionId]?.attempts || 0) + 1, at: new Date().toISOString() };
      ledger.attempts++;
      await this.#saveLedger(ledger);
      this.#emit("replication-failed", { jobId, toRegion: toRegionId, error: "source artifacts not found" });
      throw new Error(`replicateJobArtifacts: source artifacts not found for job '${jobId}' at ${srcDir}`);
    }

    ledger.replicas[toRegionId] = { state: "replicating", startedAt: new Date().toISOString(), attempts: (ledger.replicas[toRegionId]?.attempts || 0) + 1 };
    await this.#saveLedger(ledger);
    this.#emit("replication-triggered", { jobId, fromRegion: fromRegionId, toRegion: toRegionId });

    const files = listFilesRecursive(srcDir);
    const srcHashes = new Map();
    for (const relFile of files) srcHashes.set(relFile, sha256File(path.join(srcDir, relFile)));

    let copied = 0;
    let skipped = 0;
    let bytes = 0;
    try {
      for (const relFile of files) {
        const dstFile = path.join(dstDir, relFile);
        const srcFile = path.join(srcDir, relFile);
        let needCopy = true;
        if (fs.existsSync(dstFile)) {
          try {
            if (sha256File(dstFile) === srcHashes.get(relFile)) { needCopy = false; skipped++; }
          } catch { needCopy = true; } // unreadable partial file → recopy
        }
        if (needCopy) {
          fs.mkdirSync(path.dirname(dstFile), { recursive: true });
          fs.copyFileSync(srcFile, dstFile);
          copied++;
          bytes += fs.statSync(dstFile).size;
        }
        if (opts.failAfter != null && copied === Number(opts.failAfter)) throw new Error(`injected copy failure after ${copied} files (test-only)`);
        if (opts.failOn && relFile === opts.failOn) throw new Error(`injected copy failure on ${relFile} (test-only)`);
      }
    } catch (e) {
      ledger.replicas[toRegionId] = { state: "partial", error: String(e?.message || e), copied, skipped, attempts: ledger.replicas[toRegionId].attempts, at: new Date().toISOString() };
      ledger.attempts++;
      await this.#saveLedger(ledger);
      this.#emit("replication-partial", { jobId, toRegion: toRegionId, copied, skipped, error: String(e?.message || e) });
      return { state: "partial", jobId, copied, skipped, error: String(e?.message || e) };
    }

    // verify pass — `replicated` only when every file is byte-identical
    const missing = [];
    const mismatched = [];
    for (const relFile of files) {
      const dstFile = path.join(dstDir, relFile);
      if (!fs.existsSync(dstFile)) { missing.push(relFile); continue; }
      if (sha256File(dstFile) !== srcHashes.get(relFile)) mismatched.push(relFile);
    }
    if (missing.length || mismatched.length) {
      ledger.replicas[toRegionId] = { state: "partial", error: `verify failed: ${missing.length} missing, ${mismatched.length} mismatched`, files: files.length, attempts: ledger.replicas[toRegionId].attempts, at: new Date().toISOString() };
      ledger.attempts++;
      await this.#saveLedger(ledger);
      this.#emit("replication-partial", { jobId, toRegion: toRegionId, missing: missing.length, mismatched: mismatched.length });
      return { state: "partial", jobId, missing, mismatched };
    }

    // on-disk replica manifest (inspectable by operators; excluded from set comparison)
    fs.writeFileSync(path.join(dstDir, ".failover-replica.json"), JSON.stringify({
      jobId, sourceRegion: fromRegionId, targetRegion: toRegionId, state: "replicated",
      files: files.map((relFile) => ({ rel: relFile, sha256: srcHashes.get(relFile), bytes: fs.statSync(path.join(dstDir, relFile)).size })),
      copiedAt: new Date().toISOString(),
    }, null, 2));

    ledger.replicas[toRegionId] = { state: "replicated", files: files.length, bytes, attempts: ledger.replicas[toRegionId].attempts, at: new Date().toISOString() };
    delete ledger.replicas[toRegionId].error;
    ledger.pendingReplication = false;
    ledger.attempts++;
    await this.#saveLedger(ledger);
    this.#emit("replication-complete", { jobId, toRegion: toRegionId, files: files.length, bytes });
    return { state: "replicated", jobId, files: files.length, copied, skipped, bytes };
  }

  /** Independent on-disk verification of one replica (no copying). */
  async verifyReplica(jobId, regionId) {
    await this.ready;
    const ledger = await this.getReplicaLedger(jobId);
    const region = this.#regions.get(regionId);
    if (!ledger || !region) throw new Error(`verifyReplica: no ledger for job '${jobId}' or unknown region '${regionId}'`);
    const assignment = await this.getJobAssignment(jobId);
    const rel = assignment?.artifactRel || jobId;
    const primary = this.#regions.get(ledger.primary);
    const srcDir = primary ? path.join(primary.storageRoot, rel) : null;
    const dstDir = path.join(region.storageRoot, rel);
    if (!srcDir || !fs.existsSync(srcDir) || !fs.existsSync(dstDir)) {
      return { ok: false, missing: ["(artifact set)"], mismatched: [], files: 0 };
    }
    const srcFiles = listFilesRecursive(srcDir);
    const missing = [];
    const mismatched = [];
    for (const relFile of srcFiles) {
      const dst = path.join(dstDir, relFile);
      if (!fs.existsSync(dst)) { missing.push(relFile); continue; }
      if (sha256File(dst) !== sha256File(path.join(srcDir, relFile))) mismatched.push(relFile);
    }
    return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, files: srcFiles.length };
  }

  // ---- sweep: transitions, re-route, replication reconciliation -----------------

  /** One failover sweep. Deterministic; also the unit the tests drive directly. */
  async check() {
    await this.ready;
    const actions = [];
    if (this.#sweeping) return { at: new Date().toISOString(), backend: this.backend, regions: await this.listRegions(), actions: [{ type: "sweep-skipped", reason: "already running" }] };
    this.#sweeping = true;
    try {
      // 1. region transitions (heartbeat loss / recovery). ANY not-healthy
      //    observation of a previously-healthy region is down-like — including
      //    "unknown" (the Redis heartbeat key physically expired after a long
      //    silence). Also fires once on the first observation of a controller
      //    that starts while a region is already dead. Handlers are idempotent.
      const attemptedThisSweep = new Set();
      for (const id of this.#regions.keys()) {
        const prev = this.#view(id);
        const cur = await this.#stateOf(id);
        const downLike = cur !== "healthy" && (prev.state === "healthy" || (!prev.observed && prev.state !== "healthy"));
        if (downLike) {
          for (const jobId of await this.#handleRegionDown(id, actions)) attemptedThisSweep.add(jobId);
        } else if (cur === "healthy" && prev.state === "down") {
          await this.#handleRegionRecovered(id, actions);
        }
        this.#view(id, cur, true);
      }
      // 2. reroute backlog (dispatch failures, no-healthy-region deferrals) —
      //    drains the moment any region is healthy again; jobs the down-handler
      //    already attempted in THIS sweep are not retried within it
      await this.#drainRerouteBacklog(actions, attemptedThisSweep);
      // 3. replication reconciliation (partials resume, blocked resume on
      //    recovery, payloads with zero healthy replicas get one)
      await this.#reconcileReplications(actions);
    } finally {
      this.#sweeping = false;
    }
    const entry = { at: new Date().toISOString(), backend: this.backend, regions: await this.listRegions(), actions };
    this.recentActions = [...this.recentActions, ...actions].slice(-100);
    return entry;
  }

  // synchronous on purpose — observer-local transition memory, no I/O.
  // `observed` marks "this controller has swept this region at least once",
  // which gates the first-observation down-like rule (restart onto a dead region).
  #view(id, state = undefined, observed = false) {
    let v = this.#views.get(id);
    if (!v) {
      v = { state: "unknown", since: new Date().toISOString(), observed: false };
      this.#views.set(id, v);
    }
    if (state !== undefined) { v.state = state; v.since = new Date().toISOString(); }
    if (observed) v.observed = true;
    return v;
  }

  /** @returns {Promise<Set<string>>} jobIds whose reroute was attempted here */
  async #handleRegionDown(regionId, actions) {
    this.#emit("region-down", { regionId });
    actions.push({ type: "region-down", regionId });
    const attempted = new Set();
    const healthy = await this.healthyRegions();
    const jobs = (await this.listJobAssignments()).filter((j) => j.region === regionId && !TERMINAL_STATUSES.has(j.status));
    if (!healthy.length) {
      // no-healthy-region deferral: real partial-failure recovery happens on the
      // next sweeps as soon as any region is healthy again (backlog drain)
      for (const job of jobs) {
        if (job.rerouteAttempts >= this.maxRerouteAttempts) continue;
        job.pendingReroute = true;
        await this.#store.set(JOB_KEY(job.jobId), job);
      }
      actions.push({ type: "reroute-deferred", regionId, jobs: jobs.length, reason: "no healthy region" });
      this.#emit("reroute-deferred", { regionId, jobs: jobs.length });
    } else {
      for (const job of jobs) {
        const target = (await this.healthyRegions()).find((r) => r.regionId !== regionId);
        if (!target) { actions.push({ type: "reroute-deferred", regionId, jobId: job.jobId, reason: "no healthy region" }); continue; }
        // attempted regardless of outcome — a failed attempt must not be
        // retried again within the same sweep (the drain is for older backlog)
        await this.#reroute(job, target.regionId, `region-down:${regionId}`, actions);
        attempted.add(job.jobId);
      }
    }

    // artifact re-replication TRIGGER: every set homed in the down region needs
    // at least one healthy replica — terminal jobs included (payload survival)
    const sets = await this.listArtifactSets(regionId);
    for (const set of sets) {
      const ledger = (await this.getReplicaLedger(set.jobId)) || { jobId: set.jobId, primary: regionId, replicas: {}, attempts: 0, pendingReplication: false };
      const replicas = ledger.replicas || {};
      const hasHealthyReplica = await (async () => {
        for (const [rid, rep] of Object.entries(replicas)) {
          if (rep.state === "replicated" && (await this.#stateOf(rid)) === "healthy") return true;
        }
        return false;
      })();
      if (hasHealthyReplica) { actions.push({ type: "replication-skip", jobId: set.jobId, reason: "healthy replica already exists" }); continue; }
      const target = (await this.healthyRegions()).find((r) => r.regionId !== regionId);
      if (!target) { ledger.pendingReplication = true; await this.#saveLedger(ledger); actions.push({ type: "replication-deferred", jobId: set.jobId, reason: "no healthy region" }); continue; }
      const result = await this.replicateJobArtifacts(set.jobId, regionId, target.regionId);
      actions.push({ type: "replication-" + result.state, jobId: set.jobId, toRegion: target.regionId, copied: result.copied, skipped: result.skipped });
    }
    return attempted;
  }

  async #handleRegionRecovered(regionId, actions) {
    this.#emit("region-recovered", { regionId });
    actions.push({ type: "region-recovered", regionId });
    // backlog drain + partial/blocked replica resume happen in the sweeps below;
    // re-routed jobs deliberately do NOT move back (no ping-pong)
  }

  async #reroute(job, toRegion, reason, actions) {
    job.rerouteAttempts++;
    job.reroutes.push({ from: job.region, to: toRegion, at: new Date().toISOString(), reason, attempt: job.rerouteAttempts });
    if (job.rerouteAttempts > this.maxRerouteAttempts) {
      job.pendingReroute = false;
      job.rerouteFailed = { error: job.lastRerouteError || `exceeded ${this.maxRerouteAttempts} reroute attempts`, at: new Date().toISOString() };
      await this.#store.set(JOB_KEY(job.jobId), job);
      this.#emit("reroute-failed", { jobId: job.jobId, attempts: job.rerouteAttempts, error: job.rerouteFailed.error });
      actions.push({ type: "reroute-failed", jobId: job.jobId, attempts: job.rerouteAttempts });
      return false;
    }
    const fromRegion = job.region;
    try {
      if (this.dispatch) {
        const result = await this.dispatch({ jobId: job.jobId, job, fromRegion, toRegion, reason });
        // record which queue entry actually carries the re-routed execution
        const last = job.reroutes[job.reroutes.length - 1];
        if (last) last.queueEntryId = result?.queueEntryId ?? null;
      }
      job.region = toRegion;
      job.pendingReroute = false;
      job.lastRerouteError = null;
      await this.#store.set(JOB_KEY(job.jobId), job);
      this.#emit("job-rerouted", { jobId: job.jobId, fromRegion, toRegion, reason });
      actions.push({ type: "job-rerouted", jobId: job.jobId, fromRegion, toRegion, reason });
      return true;
    } catch (e) {
      job.pendingReroute = true;
      job.lastRerouteError = String(e?.message || e);
      await this.#store.set(JOB_KEY(job.jobId), job);
      this.#emit("reroute-failed", { jobId: job.jobId, attempt: job.rerouteAttempts, error: job.lastRerouteError });
      actions.push({ type: "reroute-failed", jobId: job.jobId, attempt: job.rerouteAttempts, error: job.lastRerouteError });
      return false;
    }
  }

  async #drainRerouteBacklog(actions, skipJobIds = null) {
    const jobs = await this.listJobAssignments();
    const pending = jobs.filter((j) => j.pendingReroute && !TERMINAL_STATUSES.has(j.status));
    if (!pending.length) return;
    const healthy = await this.healthyRegions();
    if (!healthy.length) return;
    let drained = 0;
    for (const job of pending.slice(0, this.maxRerouteBacklog)) {
      if (skipJobIds?.has(job.jobId)) continue; // already attempted in this sweep
      const target = (await this.healthyRegions()).find((r) => r.regionId !== job.region);
      if (!target) continue;
      const ok = await this.#reroute(job, target.regionId, "backlog-drain", actions);
      if (ok) drained++;
    }
    if (drained) actions.push({ type: "reroute-backlog-drained", drained });
  }

  async #reconcileReplications(actions) {
    const ledgers = await this.listReplicaLedgers();
    for (const ledger of ledgers) {
      const assignment = await this.getJobAssignment(ledger.jobId);
      const rel = assignment?.artifactRel || ledger.jobId;
      const primary = this.#regions.get(ledger.primary);
      const sourceReadable = !!primary && fs.existsSync(path.join(primary.storageRoot, rel));
      // resume partial / blocked / failed replicas where source+target are usable
      for (const [rid, rep] of Object.entries(ledger.replicas)) {
        const retryable = rep.state === "partial" || rep.state === "blocked" || rep.state === "failed";
        if (!retryable) continue;
        if (rep.state === "failed" && (rep.attempts || 0) >= this.maxReplicationAttempts) continue;
        if ((await this.#stateOf(rid)) !== "healthy") continue; // target must be up
        if (!sourceReadable) continue; // source storage gone → nothing to copy from
        const result = await this.replicateJobArtifacts(ledger.jobId, ledger.primary, rid);
        actions.push({ type: "replication-resumed-" + result.state, jobId: ledger.jobId, toRegion: rid, copied: result.copied, skipped: result.skipped });
      }
      // payload survival: a primary with no healthy replica gets one
      const hasHealthyReplica = await (async () => {
        for (const [rid, rep] of Object.entries(ledger.replicas)) {
          if (rep.state === "replicated" && (await this.#stateOf(rid)) === "healthy") return true;
        }
        return false;
      })();
      if (hasHealthyReplica || ledger.pendingReplication !== true) continue;
      if (!sourceReadable) continue;
      const healthy = (await this.healthyRegions()).filter((r) => r.regionId !== ledger.primary);
      if (!healthy.length) continue;
      const target = healthy[0];
      const result = await this.replicateJobArtifacts(ledger.jobId, ledger.primary, target.regionId);
      actions.push({ type: "replication-" + result.state, jobId: ledger.jobId, toRegion: target.regionId, copied: result.copied, skipped: result.skipped });
    }
  }

  // ---- periodic loop + snapshot --------------------------------------------------

  start(intervalMs = this.tickMs) {
    if (this.#timer) return;
    this.#timer = setInterval(() => { this.check().catch((e) => this.log(`[failover] sweep error: ${String(e?.message || e)}`)); }, Math.max(100, intervalMs));
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  async destroy() {
    this.stop();
    if (this.#ownRedis) {
      try { await this.#ownRedis.quit(); } catch { try { this.#ownRedis.disconnect(); } catch { /* ignore */ } }
      this.#ownRedis = null;
    }
  }

  async status() {
    const [regions, jobs, replicas] = await Promise.all([this.listRegions(), this.listJobAssignments(), this.listReplicaLedgers()]);
    return {
      backend: this.backend,
      at: new Date().toISOString(),
      config: { heartbeatTtlMs: this.heartbeatTtlMs, tickMs: this.tickMs, maxRerouteAttempts: this.maxRerouteAttempts, maxReplicationAttempts: this.maxReplicationAttempts, dispatchWired: !!this.dispatch },
      regions, jobs, replicas,
      recentActions: this.recentActions,
    };
  }

  #emit(event, payload) {
    this.emit(event, { at: new Date().toISOString(), ...payload });
  }

  async #index(key) {
    const list = await this.#store.get(key);
    return Array.isArray(list) ? list : [];
  }

  async #indexAdd(key, id) {
    const list = await this.#index(key);
    if (!list.includes(id)) {
      list.push(id);
      if (list.length > 100000) list.shift();
      await this.#store.set(key, list);
    }
  }
}

// ---- real re-route handoff ----------------------------------------------------

/**
 * Build the dispatch hook from a REAL clone queue (src/queues/clone-queue.js).
 * A re-routed execution is a genuinely NEW queue job in the target region's
 * queue — linked back to the original task id via payload.failsFromTask — so
 * the queue's duplicate-submission guard can never swallow it. In production
 * each region runs its own queue; here `queue` is whatever queue object the
 * integrator wires (region-local or the platform singleton).
 */
export function createQueueDispatcher(queue, resolveRun = null) {
  if (!queue || typeof queue.enqueue !== "function") throw new Error("createQueueDispatcher: queue.enqueue is required");
  return async ({ jobId, job, fromRegion, toRegion, reason }) => {
    const suffix = `failover-${job.rerouteAttempts}-${Date.now().toString(36)}`;
    const newQueueId = `${jobId}::${suffix}`;
    const payload = { ...(job.payload || {}), region: toRegion, failedOn: jobId, failoverReason: reason };
    const entry = queue.enqueue({
      payload,
      // the run closure comes from the TARGET region's worker registry when one
      // is wired (resolveRun), or was carried on the ledger record (job.run)
      run: (resolveRun ? resolveRun(job, { fromRegion, toRegion }) : null) || job.run || null,
      jobId: newQueueId,
      owner: job.owner ?? null,
    });
    return { queueEntryId: entry.jobId || entry.tempId, newQueueId };
  };
}

// ---- admin/ops HTTP surface ----------------------------------------------------

/**
 * Routes under the integrator's chosen prefix (recommended /api/distributed).
 * `guard` (optional middleware) is applied to ALL routes — pass your admin
 * guard to restrict; without it the surface is open (single-tenant/local mode).
 */
export function failoverRoutes({ controller, guard = null } = {}) {
  if (!controller) throw new Error("failoverRoutes: controller is required");
  const router = Router();
  if (guard) router.use(guard);

  const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
  const bad = (res, msg) => res.status(400).json({ error: msg });

  router.get("/status", async (_req, res) => {
    res.json(await controller.status());
  });

  router.get("/regions", async (_req, res) => {
    res.json({ backend: controller.backend, regions: await controller.listRegions() });
  });

  router.post("/regions", async (req, res) => {
    const { regionId, storageRoot, capacity } = req.body || {};
    if (!regionId || !storageRoot) return bad(res, "regionId and storageRoot are required");
    try {
      const region = await controller.registerRegion({ regionId, storageRoot, capacity });
      res.status(201).json(region);
    } catch (e) {
      bad(res, String(e?.message || e));
    }
  });

  router.post("/regions/:regionId/heartbeat", async (req, res) => {
    try {
      const snap = await controller.heartbeat(req.params.regionId, req.body || {});
      res.status(202).json(snap);
    } catch (e) {
      notFound(res, `region '${req.params.regionId}'`);
    }
  });

  router.post("/regions/:regionId/down", async (req, res) => {
    try {
      const region = await controller.forceDown(req.params.regionId);
      const sweep = await controller.check();
      res.json({ region, actions: sweep.actions });
    } catch (e) {
      notFound(res, `region '${req.params.regionId}'`);
    }
  });

  router.post("/regions/:regionId/up", async (req, res) => {
    try {
      const region = await controller.forceUp(req.params.regionId);
      res.json(region);
    } catch (e) {
      notFound(res, `region '${req.params.regionId}'`);
    }
  });

  router.post("/failover/tick", async (_req, res) => {
    res.json(await controller.check());
  });

  router.get("/jobs", async (_req, res) => {
    res.json({ jobs: await controller.listJobAssignments() });
  });

  router.post("/replicas/:jobId/replicate", async (req, res) => {
    const { toRegion, fromRegion } = req.body || {};
    if (!toRegion || !fromRegion) return bad(res, "fromRegion and toRegion are required");
    try {
      const result = await controller.replicateJobArtifacts(req.params.jobId, fromRegion, toRegion);
      res.status(result.state === "replicated" ? 201 : 409).json(result);
    } catch (e) {
      res.status(422).json({ error: String(e?.message || e) });
    }
  });

  router.get("/replicas", async (_req, res) => {
    res.json({ replicas: await controller.listReplicaLedgers() });
  });

  router.get("/replicas/:jobId/verify/:regionId", async (req, res) => {
    try {
      res.json(await controller.verifyReplica(req.params.jobId, req.params.regionId));
    } catch (e) {
      notFound(res, `replica '${req.params.jobId}' in '${req.params.regionId}'`);
    }
  });

  return router;
}

// small poll helper for tests/observers: wait until `fn` returns truthy
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
