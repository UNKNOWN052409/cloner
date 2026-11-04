// Worker health + heartbeat (task 4.0.3 step 8): heartbeat tracking, live
// worker snapshot and queue-depth visibility for the BullMQ clone workers.
//
// Two heartbeat stores, chosen by what is available:
//   • Redis (preferred, cross-process): SETEX on
//       cloner:worker:heartbeat:<workerId>   (JSON snapshot, TTL = heartbeatTtlMs)
//     Any observer (admin surface, tests, another worker) can check liveness
//     with isHeartbeatFresh() — a crashed worker's key simply expires, which
//     is also how a "stalled worker" is detected from the outside.
//   • In-memory (fallback, no Redis): the same snapshot lands on
//     lastBeatAt/beats inside this process — health() still works, tests still
//     observe beats, nothing touches the network.
//
// All options are env-overridable so operators can tune without code:
//   CLONER_WORKER_ID       worker identity (default clone-worker-<pid>)
//   CLONER_HEARTBEAT_MS    heartbeat interval   (default 15000)
//   CLONER_HEARTBEAT_TTL   heartbeat key TTL    (default 45000 = 3 missed beats)
//
// Heartbeat write failures never throw — health reporting must never take the
// worker down. Every write is best-effort with a one-line warn.
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export const HEARTBEAT_KEY_PREFIX = "cloner:worker:heartbeat:";

const defaultHeartbeatMs = () => Number(process.env.CLONER_HEARTBEAT_MS || 15000);
const defaultHeartbeatTtl = () => Number(process.env.CLONER_HEARTBEAT_TTL || 45000);

export function defaultWorkerId() {
  return process.env.CLONER_WORKER_ID || `clone-worker-${process.pid}`;
}

export function heartbeatKey(workerId) {
  return HEARTBEAT_KEY_PREFIX + workerId;
}

// Read + parse one worker's heartbeat key. Returns the parsed snapshot or
// null (missing / unreadable / malformed). Never throws.
export async function readHeartbeat(redis, workerId) {
  if (!redis) return null;
  try {
    const raw = await redis.get(heartbeatKey(workerId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Liveness check: the heartbeat key exists AND was written within ttlMs.
// An expired/absent key means the worker is considered dead/stalled.
export async function isHeartbeatFresh(redis, workerId, ttlMs = defaultHeartbeatTtl()) {
  const snap = await readHeartbeat(redis, workerId);
  if (!snap) return false;
  const age = Date.now() - Number(snap.ts || 0);
  return Number.isFinite(age) && age >= 0 && age <= ttlMs;
}

// Wait until a heartbeat becomes fresh or the deadline passes (poll helper for
// tests and observers). Returns the final fresh state.
export async function waitForHeartbeat(redis, workerId, { timeoutMs = 5000, intervalMs = 100, ttlMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isHeartbeatFresh(redis, workerId, ttlMs)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Create a health/heartbeat tracker bound to one worker.
 * @param {object} [opts]
 * @param {string} [opts.workerId]       default CLONER_WORKER_ID / clone-worker-<pid>
 * @param {object|null} [opts.worker]    BullMQ worker (or anything exposing
 *                                       isRunning() / getActiveJobsCount()) — optional
 * @param {number} [opts.concurrency]    configured worker concurrency
 * @param {object|null} [opts.redis]     ioredis client for the Redis heartbeat store;
 *                                       created internally when only redisUrl is given;
 *                                       null → in-memory heartbeat only
 * @param {string} [opts.redisUrl]       used to build the redis client when `redis` is absent
 * @param {number} [opts.heartbeatMs]    interval (default CLONER_HEARTBEAT_MS / 15000)
 * @param {number} [opts.heartbeatTtlMs] redis key TTL (default CLONER_HEARTBEAT_TTL / 45000)
 * @param {() => Promise<object>|object|null} [opts.getQueueCounts]
 *                                       queue-depth source, e.g. queue.getJobCounts()
 * @param {boolean} [opts.register]      start the heartbeat immediately (default true)
 * @returns {{ workerId: string, start: () => void, stop: () => Promise<void>,
 *              markDraining: (reason?: string) => void, health: () => Promise<object> }}
 */
export function createWorkerHealth({
  workerId = defaultWorkerId(),
  worker = null,
  concurrency = null,
  redis = null,
  redisUrl = "",
  heartbeatMs = defaultHeartbeatMs(),
  heartbeatTtlMs = defaultHeartbeatTtl(),
  getQueueCounts = null,
  register = true,
  region = process.env.CLONER_WORKER_REGION || null, // G2.2: per-worker deployment region
} = {}) {
  const state = {
    workerId,
    status: "running", // running | draining | stopped
    startedAt: new Date().toISOString(),
    startedTs: Date.now(),
    lastBeatAt: null,
    beats: 0,
    redisWrites: 0,
    redisErrors: 0,
    drainingSince: null,
    stoppedAt: null,
  };

  let ownRedis = null; // redis client WE built from redisUrl (ours to close)
  let timer = null;
  let lastError = "";

  async function ensureRedis() {
    // G5.1 hunt fix (BUG #11): a FAILED first connect used to disable the
    // heartbeat store for the WHOLE worker lifetime (state.redisTried was
    // never reset) — a child spawned while the platform/queue saturates Redis
    // connections at boot (reproduced in the G5.5 journey: worker processed
    // jobs for 4+ minutes with ZERO heartbeat keys, so /api/admin/workers
    // reported no workers) stayed invisible to the operator forever. The
    // connection attempt is now retried on the NEXT beat (one attempt per
    // beat, 15s apart — bounded by the beat interval, no hot loop).
    if (redis) return redis;
    if (ownRedis) return ownRedis;
    if (!redisUrl) return null;
    try {
      const mod = await import("ioredis");
      const IORedis = mod.default;
      const client = new IORedis(redisUrl, { lazyConnect: true, connectTimeout: 2000, retryStrategy: () => null, enableOfflineQueue: false });
      client.on("error", () => {});
      await client.connect();
      await client.ping();
      ownRedis = client;
      return client;
    } catch (e) {
      lastError = String(e?.message || e);
      try { if (ownRedis) { await ownRedis.quit().catch(() => ownRedis.disconnect()); } } catch { /* best-effort */ }
      ownRedis = null;
      return null;
    }
  }

  function snapshot() {
    return {
      workerId: state.workerId,
      status: state.status,
      ts: Date.now(),
      startedAt: state.startedAt,
      pid: process.pid,
      host: os.hostname(),
      // G2.2: deployment region for the admin workers panel (optional; unset
      // regions surface as "(unspecified)" rollups in /api/admin/workers)
      region,
      concurrency,
      drainingSince: state.drainingSince,
    };
  }

  async function beat() {
    state.lastBeatAt = new Date().toISOString();
    state.beats++;
    const client = await ensureRedis();
    if (!client) return;
    try {
      // let the health() queue-depth read ride along in the stored snapshot
      let counts = null;
      if (getQueueCounts) {
        try { counts = await getQueueCounts(); } catch {}
      }
      const snap = { ...snapshot(), queueCounts: counts };
      await client.setex(heartbeatKey(state.workerId), Math.max(1, Math.ceil(heartbeatTtlMs / 1000)), JSON.stringify(snap));
      state.redisWrites++;
    } catch (e) {
      state.redisErrors++;
      lastError = String(e?.message || e);
      // never throw — heartbeat is best-effort
    }
  }

  function start() {
    if (timer) return;
    state.status = state.status === "stopped" ? "running" : state.status;
    timer = setInterval(() => { beat().catch(() => {}); }, Math.max(25, heartbeatMs));
    timer.unref?.();
    beat().catch(() => {}); // first beat immediately
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    if (ownRedis) {
      try { await ownRedis.quit(); } catch { try { ownRedis.disconnect(); } catch {} }
      ownRedis = null;
    }
  }

  function markDraining(reason = "shutdown") {
    if (state.status === "running") {
      state.status = "draining";
      state.drainingSince = new Date().toISOString();
      beat().catch(() => {}); // publish the draining state at once
    }
    return state.status;
  }

  async function activeJobs() {
    if (!worker) return null;
    try {
      if (typeof worker.getActiveJobsCount === "function") return await worker.getActiveJobsCount();
    } catch {}
    return null;
  }

  async function health() {
    let queueDepth = null;
    if (getQueueCounts) {
      try { queueDepth = await getQueueCounts(); } catch { queueDepth = null; }
    }
    let running = null;
    if (worker) {
      try { running = typeof worker.isRunning === "function" ? worker.isRunning() : null; } catch {}
    }
    return {
      workerId: state.workerId,
      status: state.status,
      startedAt: state.startedAt,
      uptimeMs: Date.now() - state.startedTs,
      lastBeatAt: state.lastBeatAt,
      beats: state.beats,
      heartbeatIntervalMs: heartbeatMs,
      heartbeatTtlMs,
      activeJobs: await activeJobs(),
      concurrency,
      workerRunning: running,
      queueDepth,
      heartbeatStore: redis || ownRedis ? "redis" : "memory",
      redisWrites: state.redisWrites,
      redisErrors: state.redisErrors,
      lastError: lastError || null,
      drainingSince: state.drainingSince,
      stoppedAt: state.stoppedAt,
    };
  }

  if (register) start();

  return { workerId: state.workerId, start, stop, markDraining, health, beat, snapshot };
}
