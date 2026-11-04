// Worker pool manager (task 4.2.4): owns a bounded set of clone workers for
// ONE pool in ONE region and makes scale changes safe.
//
//   • lifecycle — startWorker/addWorkers/scaleTo/removeWorkers/drainAll with a
//     hard maxWorkers cap (per-pool). addWorkers never exceeds the cap and
//     reports `capped: true` with the shortfall instead of throwing.
//   • SAFE DRAIN (the scale-down contract) — removeWorkers picks the LEAST
//     BUSY running slot (fewest active jobs, newest first on ties), marks it
//     "draining" IMMEDIATELY (so observers see it leaving), then waits for its
//     in-flight jobs to reach 0 before closing the handle. A worker is never
//     closed mid-job unless the drain grace (drainTimeoutMs) expires, in
//     which case the removal is reported as `forced: true` — visible, not
//     silent. While one slot drains, the remaining running workers keep
//     consuming the queue, so no capacity is lost during the handover.
//   • observability — stats() aggregates size/running/draining/activeJobs/
//     capacity/utilization for the autoscaler's metrics feed, plus events:
//     "worker-added" | "worker-draining" | "worker-removed" | "capped".
//
// Worker handle contract (what workerFactory must return — exactly the surface
// of src/workers/clone-worker.js #startCloneWorker):
//   { workerId, close(): Promise, getActiveJobsCount?(): Promise<number>,
//     isRunning?(): boolean, concurrency?: number, health?... }
//
// The DEFAULT factory is the REAL one: it spawns an actual clone worker via
// startCloneWorker (real BullMQ worker on the real Redis from REDIS_URL /
// CLONER_REDIS_URL) and fails with a clean error when the env is absent.
// Tests inject their own factory to simulate worker processes — that
// simulation lives in the test file only, never in product paths.
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const drainTimeoutDefault = () => Number(process.env.CLONER_DRAIN_TIMEOUT_MS || 30_000);

/**
 * REAL worker factory: spawn a clone worker bound to this pool.
 * registerSignals is false ON PURPOSE — SIGTERM/SIGINT handling belongs to the
 * pool operator (drainAll()), not to each pool-managed worker process.
 */
export async function defaultPoolWorkerFactory({ workerId, concurrency, redisUrl } = {}) {
  const url = redisUrl || process.env.CLONER_REDIS_URL || process.env.REDIS_URL || "";
  if (!url) {
    throw new Error("worker-pool: cannot spawn a real clone worker without REDIS_URL / CLONER_REDIS_URL — set the env or provide workerFactory");
  }
  const [{ startCloneWorker }, { resolveRedisUrl }] = await Promise.all([
    import("./clone-worker.js"),
    import("../queues/clone-queue.js"),
  ]);
  return startCloneWorker({ redisUrl: resolveRedisUrl() || url, workerId, concurrency, registerSignals: false });
}

/**
 * Create a worker pool manager.
 * @param {object} [opts]
 * @param {string} [opts.poolId]             pool identity, e.g. "clone-workers-eu1"
 * @param {string} [opts.region]             region tag (informational + event payloads)
 * @param {number} [opts.minWorkers]         floor for scaleTo(); removeWorkers is the
 *                                           raw primitive (drainAll goes to 0)
 * @param {number} [opts.maxWorkers]         HARD per-pool cap — addWorkers never exceeds it
 * @param {number|null} [opts.concurrency]   concurrency passed to the factory per worker
 * @param {Function} [opts.workerFactory]    async ({ poolId, region, index, workerId, concurrency }) => handle
 * @param {number} [opts.drainTimeoutMs]     max wait for a draining worker to go idle (env CLONER_DRAIN_TIMEOUT_MS)
 * @param {number} [opts.drainPollMs]        poll interval while waiting for a drain
 * @param {object} [opts.logger]             { log, warn } (default console)
 * @returns {WorkerPoolManager}
 */
export function createWorkerPoolManager({
  poolId = "clone-workers",
  region = "default",
  minWorkers = 1,
  maxWorkers = 8,
  concurrency = null,
  workerFactory = defaultPoolWorkerFactory,
  drainTimeoutMs = drainTimeoutDefault(),
  drainPollMs = 100,
  logger = console,
} = {}) {
  if (!Number.isInteger(minWorkers) || minWorkers < 0) throw new Error("worker-pool: minWorkers must be an integer >= 0");
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error("worker-pool: maxWorkers must be an integer >= 1");
  if (minWorkers > maxWorkers) throw new Error("worker-pool: minWorkers must be <= maxWorkers");
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) throw new Error("worker-pool: drainTimeoutMs must be >= 0");
  if (typeof workerFactory !== "function") throw new Error("worker-pool: workerFactory must be a function");

  const manager = new EventEmitter();
  const slots = new Map(); // slotId → slot
  let nextIndex = 0;
  let closed = false;

  const runningSlots = () => [...slots.values()].filter((s) => s.status === "running");
  const capacityOf = (slot) => {
    const c = Number(slot.handle?.concurrency);
    return Number.isFinite(c) && c > 0 ? c : 1;
  };

  async function activeJobsOf(slot) {
    const h = slot.handle;
    if (!h || typeof h.getActiveJobsCount !== "function") return 0;
    try {
      const n = await h.getActiveJobsCount();
      return Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
    } catch (e) {
      logger.warn?.(`[worker-pool:${poolId}] getActiveJobsCount(${slot.workerId}) failed: ${e?.message || e}`);
      return 0;
    }
  }

  // wait until the slot reports 0 active jobs, or the drain grace expires
  async function quiesce(slot) {
    const deadline = Date.now() + drainTimeoutMs;
    for (;;) {
      const active = await activeJobsOf(slot);
      if (active === 0) return { forced: false, waitedMs: drainTimeoutMs - Math.max(0, deadline - Date.now()) };
      if (Date.now() >= deadline) return { forced: true, waitedMs: drainTimeoutMs };
      await sleep(Math.max(1, drainPollMs));
    }
  }

  async function startWorker() {
    if (closed) throw new Error(`worker-pool:${poolId} is closed`);
    if (slots.size >= maxWorkers) return null; // addWorkers emits the full 'capped' event
    const index = ++nextIndex;
    const workerId = `${poolId}-w${index}`;
    const handle = await workerFactory({ poolId, region, index, workerId, concurrency });
    const slot = {
      slotId: `${poolId}-s${index}`,
      workerId: handle?.workerId || workerId,
      index,
      status: "running",
      startedAt: new Date().toISOString(),
      handle,
    };
    slots.set(slot.slotId, slot);
    manager.emit("worker-added", { poolId, region, slotId: slot.slotId, workerId: slot.workerId, size: slots.size });
    return slot;
  }

  /**
   * Start up to n additional workers, never exceeding maxWorkers.
   * @returns {{ started: object[], requested: number, capped: boolean, shortfall: number }}
   */
  async function addWorkers(n = 1, { reason = "manual" } = {}) {
    const requested = Math.max(0, Math.floor(Number(n) || 0));
    const started = [];
    for (let i = 0; i < requested; i++) {
      const slot = await startWorker();
      if (!slot) break; // capped
      started.push(slot);
    }
    const shortfall = requested - started.length;
    if (shortfall > 0) {
      manager.emit("capped", { poolId, region, requested, started: started.length, shortfall, size: slots.size, maxWorkers, reason });
      logger.log?.(`[worker-pool:${poolId}] addWorkers(${requested}) capped at maxWorkers=${maxWorkers} (shortfall ${shortfall})`);
    }
    return { started, requested, capped: shortfall > 0, shortfall };
  }

  /**
   * Safely remove up to n running workers (least busy first, drain-then-close).
   * @returns {{ removed: Array<{ slotId, workerId, forced, waitedMs }>, requested: number, shortfall: number }}
   */
  async function removeWorkers(n = 1, { reason = "manual" } = {}) {
    const requested = Math.max(0, Math.floor(Number(n) || 0));
    const removed = [];
    while (removed.length < requested) {
      const candidates = runningSlots();
      if (!candidates.length) break;
      // least busy first; newest first on ties (keep warm long-lived workers)
      const loads = await Promise.all(candidates.map(async (s) => ({ s, active: await activeJobsOf(s) })));
      loads.sort((a, b) => a.active - b.active || b.s.index - a.s.index);
      const { s: slot, active } = loads[0];

      slot.status = "draining"; // visible immediately — this worker is leaving
      manager.emit("worker-draining", { poolId, region, slotId: slot.slotId, workerId: slot.workerId, activeJobs: active, reason });
      logger.log?.(`[worker-pool:${poolId}] draining ${slot.workerId} (activeJobs=${active}, reason=${reason})`);

      const { forced, waitedMs } = await quiesce(slot);
      if (forced) logger.warn?.(`[worker-pool:${poolId}] drain grace (${drainTimeoutMs}ms) expired for ${slot.workerId} — force-closing`);
      try {
        if (typeof slot.handle?.close === "function") await slot.handle.close();
      } catch (e) {
        logger.warn?.(`[worker-pool:${poolId}] close(${slot.workerId}) failed: ${e?.message || e}`);
      }
      slots.delete(slot.slotId);
      removed.push({ slotId: slot.slotId, workerId: slot.workerId, forced, waitedMs });
      manager.emit("worker-removed", { poolId, region, slotId: slot.slotId, workerId: slot.workerId, forced, waitedMs, reason });
    }
    return { removed, requested, shortfall: requested - removed.length };
  }

  /**
   * Move the pool to exactly n running workers (clamped to [minWorkers, maxWorkers]).
   */
  async function scaleTo(n, opts = {}) {
    const target = Math.min(maxWorkers, Math.max(minWorkers, Math.floor(Number(n) || 0)));
    const current = slots.size;
    if (target > current) {
      const res = await addWorkers(target - current, opts);
      return { target, added: res.started.length, removed: 0, capped: res.capped };
    }
    if (target < current) {
      const res = await removeWorkers(current - target, opts);
      return { target, added: 0, removed: res.removed.length, forced: res.removed.filter((r) => r.forced).length };
    }
    return { target, added: 0, removed: 0 };
  }

  /** Start workers until the pool reaches minWorkers (constructor does this once). */
  async function ensureMin() {
    if (slots.size < minWorkers) await addWorkers(minWorkers - slots.size, { reason: "ensure-min" });
    return slots.size;
  }

  /**
   * Aggregate snapshot for the autoscaler / admin surfaces.
   * utilization is null when capacity is unknown (no workers) — "not
   * measured", never silently 0.
   */
  function stats() {
    const all = [...slots.values()];
    const running = all.filter((s) => s.status === "running");
    const capacity = running.reduce((acc, s) => acc + capacityOf(s), 0);
    const runningActive = running.reduce((acc, s) => acc + (s.lastActiveJobs ?? 0), 0);
    return {
      poolId,
      region,
      size: all.length,
      running: running.length,
      draining: all.filter((s) => s.status === "draining").length,
      capacity,
      activeJobs: runningActive,
      utilization: capacity > 0 ? runningActive / capacity : null,
      minWorkers,
      maxWorkers,
    };
  }

  async function refreshActiveJobs() {
    await Promise.all(runningSlots().map(async (s) => { s.lastActiveJobs = await activeJobsOf(s); }));
    return stats();
  }

  /** Drain EVERYTHING (explicit shutdown — ignores minWorkers). */
  async function drainAll(opts = {}) {
    return removeWorkers(slots.size, { reason: "drain-all", ...opts });
  }

  async function close(opts = {}) {
    if (closed) return;
    closed = true;
    const res = await drainAll(opts);
    return { removed: res.removed.length, forced: res.removed.filter((r) => r.forced).length };
  }

  function listWorkers() {
    return [...slots.values()].map(({ handle, ...rest }) => ({ ...rest, concurrency: capacityOf({ handle }) }));
  }

  // constructor contract: the pool boots at minWorkers. The factory may be
  // async; failures here are fatal config errors (surfaced to the creator).
  const ready = (async () => {
    if (minWorkers > 0) await addWorkers(minWorkers, { reason: "initial" });
  })();

  const api = Object.assign(manager, {
    poolId,
    region,
    ready,
    addWorkers,
    removeWorkers,
    scaleTo,
    ensureMin,
    drainAll,
    close,
    stats,
    refreshActiveJobs,
    listWorkers,
  });
  // live getters MUST be defined with defineProperty — Object.assign would
  // INVOKE them once and freeze their value at construction time
  Object.defineProperties(api, {
    size: { get() { return slots.size; }, enumerable: true },
    isClosed: { get() { return closed; }, enumerable: true },
  });
  return api;
}
