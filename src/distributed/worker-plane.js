// Distributed worker plane (task 4.2.2): region-scoped worker registration and
// execution-plane job routing THROUGH the existing queue adapter contract
// (src/queues/clone-queue.js). No new transport is invented here — jobs always
// flow over the clone-queue surface (enqueue / onStatus / getJob / cancel /
// whenIdle / close), so every dispatch, retry, dead-letter and status
// semantics the platform already guarantees keep applying unchanged.
//
// Two cooperating layers, one module:
//
//   A. WorkerPlane (control plane) — region workers REGISTER with
//      registerWorker({ workerId, region, capabilities, concurrency, executor })
//      and keep the registration alive with heartbeats. A heartbeat carries
//      the worker's LOAD (reported activeJobs) and refreshes its lease; a
//      worker that stops beating goes "stale" (excluded from routing) and is
//      auto-deregistered ("pruned") after deregisterAfterMs. Draining workers
//      stay registered (finish what they hold) but never receive new jobs.
//
//   B. ExecutionPlane (data plane) — dispatchJob() routes ONE job to the best
//      region worker (region match → capability match → lowest load →
//      deterministic tie-break) and hands it to the PER-REGION queue adapter
//      instance built on the existing contract. The default adapter is the
//      real clone-queue with queue name "clone-jobs:<region>" (BullMQ backend
//      when REDIS_URL is set, in-process memory backend otherwise), so in a
//      real deployment a region's workers simply consume their region queue.
//
// Embedded vs remote execution:
//   • memory backend (no Redis): the adapter runs the job IN THIS PROCESS —
//     the execution plane invokes the selected worker's registered executor
//     (its real pipeline function, e.g. a bound runPipelineJob) and tracks the
//     worker's load for routing. An executor-less worker CANNOT receive
//     embedded jobs (there is no transport to carry them) and is excluded
//     from routing with an explicit reason.
//   • bullmq backend: the run closure is ignored by the adapter contract —
//     the job travels the real transport to the region queue and the region's
//     worker processes execute it (exactly like src/workers/clone-worker.js).
//     An executor-less "remote" worker registration is therefore valid and
//     routable in bullmq mode; per-worker PINNING over a shared broker is
//     intentionally not claimed — routing targets the region's least-loaded
//     worker and the region queue delivers it.
//
// Heartbeat/store defaults reuse the existing worker-infra env (mirrors
// src/workers/worker-health.js) plus one new auto-deregister knob:
//   CLONER_HEARTBEAT_MS              heartbeat interval        (default 15000)
//   CLONER_HEARTBEAT_TTL             lease TTL                 (default 45000 = 3 missed beats)
//   CLONER_WORKER_DEREGISTER_AFTER_MS  prune a stale worker    (default 2 × TTL; <=0 disables)
//   CLONER_WORKER_REGION             default region for workers/jobs that omit one (default "local")
//
// Region names become queue-name suffixes ("clone-jobs:<region>"), so they are
// restricted to [A-Za-z0-9_-]. The dead-letter queue stays the shared
// "clone-jobs-dead" sink for every region (clone-queue.js module constant).
//
// Position in the distributed family (adjacent 4.2.x tasks, all standalone):
//   • 4.2.1 region-registry.js — the HTTP region-node plane (wire contracts,
//     artifact upload). Its coordinator knows REGIONS; this module knows the
//     WORKERS inside them and routes through the queue adapter, not HTTP.
//   • 4.2.7 scheduler.js — resource-aware packing; can CONSUME selectWorker()
//     output as its candidate set.
//   • 4.2.9 failover.js — region-down detection + re-route via the shared
//     queue; this module provides per-worker, per-region dispatch underneath.
// Tests: scripts/test-worker-registration.mjs (72 checks, no services needed).
import { EventEmitter } from "node:events";
import { createCloneQueue, QUEUE_NAME } from "../queues/clone-queue.js";

// ---------------------------------------------------------------------------
// env-derived defaults (read per-construction so tests can pin them)
// ---------------------------------------------------------------------------

const defaultHeartbeatMs = () => Number(process.env.CLONER_HEARTBEAT_MS || 15000);
const defaultHeartbeatTtlMs = () => Number(process.env.CLONER_HEARTBEAT_TTL || 45000);
const defaultDeregisterAfterMs = (ttlMs) =>
  Number(process.env.CLONER_WORKER_DEREGISTER_AFTER_MS || 2 * ttlMs);

// default region for registrations/dispatches that omit one
export function resolveDefaultRegion() {
  return process.env.CLONER_WORKER_REGION || "local";
}

// region names become queue-name suffixes — keep them transport-safe
export const REGION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

const TERMINAL_JOB_STATUSES = new Set(["completed", "completed_with_limitations", "error", "cancelled"]);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

// No online worker satisfied the routing request. `.reasons` explains, per
// candidate, WHY it was excluded — the operator-facing diagnostic surface.
export class NoWorkerAvailableError extends Error {
  constructor(message, { requested = null, reasons = [] } = {}) {
    super(message);
    this.name = "NoWorkerAvailableError";
    this.code = "NO_WORKER_AVAILABLE";
    this.requested = requested;
    this.reasons = reasons;
  }
}

// The dispatch itself was malformed (e.g. no region resolvable). Distinct from
// NoWorkerAvailableError so callers can tell "bad request" from "fleet down".
export class DispatchError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "DispatchError";
    this.code = "DISPATCH_ERROR";
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// A. WorkerPlane — control plane: registration, heartbeats, staleness, routing
// ---------------------------------------------------------------------------

/**
 * Create the worker registry / control plane.
 * @param {object} [opts]
 * @param {string} [opts.defaultRegion]     region used when a worker or a job
 *                                          omits one (default CLONER_WORKER_REGION / "local")
 * @param {number} [opts.heartbeatMs]       per-worker auto-heartbeat interval (default CLONER_HEARTBEAT_MS / 15000; min 25)
 * @param {number} [opts.heartbeatTtlMs]    heartbeat lease TTL (default CLONER_HEARTBEAT_TTL / 45000; min 50)
 * @param {number} [opts.deregisterAfterMs] prune a stale registration after this long without a beat
 *                                          (default CLONER_WORKER_DEREGISTER_AFTER_MS / 2×TTL; <=0 = never prune)
 * @param {() => number} [opts.now]         injectable monotonic clock (ms) — tests freeze/virtual time
 * @returns worker plane (see below)
 */
export function createWorkerPlane({
  defaultRegion = resolveDefaultRegion(),
  heartbeatMs = defaultHeartbeatMs(),
  heartbeatTtlMs = defaultHeartbeatTtlMs(),
  deregisterAfterMs = null,
  now = () => Date.now(),
} = {}) {
  heartbeatMs = Math.max(25, Number(heartbeatMs) || 15000);
  heartbeatTtlMs = Math.max(50, Number(heartbeatTtlMs) || 45000);
  if (deregisterAfterMs === null) deregisterAfterMs = defaultDeregisterAfterMs(heartbeatTtlMs);
  deregisterAfterMs = Number(deregisterAfterMs) || 0; // <=0 disables auto-prune
  if (deregisterAfterMs > 0) deregisterAfterMs = Math.max(heartbeatTtlMs, deregisterAfterMs);

  if (!defaultRegion || !REGION_RE.test(defaultRegion)) {
    throw new TypeError(`worker-plane: invalid defaultRegion "${defaultRegion}" (must match ${REGION_RE})`);
  }

  const events = new EventEmitter();
  events.setMaxListeners(200);

  /** workerId → registration record (see registerWorker) */
  const workers = new Map();
  /** workerId → interval timer driving that worker's auto-heartbeat */
  const hbTimers = new Map();
  /** workerId → execution-plane-side active job count (noteJobStart/End) */
  const internalActive = new Map();

  function emitEvent(ev) {
    events.emit("event", { at: nowIso(), ...ev });
  }

  function stopAutoHeartbeat(workerId) {
    const t = hbTimers.get(workerId);
    if (t) {
      clearInterval(t);
      hbTimers.delete(workerId);
    }
  }

  // load as seen by the router: the LARGER of what the worker reports and
  // what this process has dispatched-but-not-finished through its executor
  function effectiveActive(rec) {
    const reported = Number(rec?.lastLoad?.activeJobs || 0);
    const internal = internalActive.get(rec.workerId) || 0;
    return Math.max(reported, internal);
  }

  function isFresh(rec, at = now()) {
    return at - rec.lastBeatTs <= heartbeatTtlMs;
  }

  // status as an observer should see it RIGHT NOW (independent of the sweep
  // cadence): any registration whose beat expired displays as "stale" —
  // including a draining one that stopped beating
  function liveStatus(rec, at = now()) {
    if (rec.status !== "stale" && !isFresh(rec, at)) return "stale";
    return rec.status;
  }

  function snapshot(rec) {
    return {
      workerId: rec.workerId,
      region: rec.region,
      capabilities: rec.capabilities.slice(),
      concurrency: rec.concurrency,
      status: liveStatus(rec),
      registeredAt: rec.registeredAt,
      lastBeatAt: rec.lastBeatAt,
      beats: rec.beats,
      missedBeats: rec.missedBeats,
      load: {
        activeJobs: effectiveActive(rec),
        capacity: rec.concurrency,
        reported: { ...rec.lastLoad },
      },
      executorBound: typeof rec.executor === "function",
      metadata: { ...rec.metadata },
      drainingSince: rec.drainingSince,
    };
  }

  // ---- registration -------------------------------------------------------

  /**
   * Register (or idempotently re-register) a region worker.
   * @param {object} spec
   * @param {string} spec.workerId        unique identity (re-register = refresh in place)
   * @param {string} [spec.region]        required region (falls back to the plane defaultRegion)
   * @param {string[]} [spec.capabilities] e.g. ["clone:web", "vision"] — routing requires ALL requested
   * @param {number} [spec.concurrency]   routing capacity in active jobs (default 1)
   * @param {({jobId, entry, payload, region, assignedWorkerId, report, linkJobId}) => Promise<any>|any}
   *        [spec.executor]  how the execution plane hands an embedded (memory-backend)
   *                         job to this worker's real pipeline; null/absent = remote worker
   *                         that consumes its region queue itself (routable in bullmq mode)
   * @param {object} [spec.metadata]      free-form operator metadata (echoed in snapshots)
   * @param {boolean} [spec.autoHeartbeat] start the per-worker heartbeat timer (default true)
   * @returns {object} registration snapshot
   */
  function registerWorker({
    workerId,
    region = null,
    capabilities = [],
    concurrency = 1,
    executor = null,
    metadata = {},
    autoHeartbeat = true,
  } = {}) {
    if (!workerId || typeof workerId !== "string") {
      throw new TypeError("worker-plane: workerId must be a non-empty string");
    }
    if (region === null || region === undefined) region = defaultRegion;
    if (!region || typeof region !== "string" || !REGION_RE.test(region)) {
      throw new TypeError(`worker-plane: invalid region "${region}" (must match ${REGION_RE})`);
    }
    if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || !c)) {
      throw new TypeError("worker-plane: capabilities must be an array of non-empty strings");
    }
    if (executor !== null && typeof executor !== "function") {
      throw new TypeError("worker-plane: executor must be a function or null");
    }
    const conc = Number(concurrency);
    if (!Number.isFinite(conc) || conc < 1) {
      throw new TypeError(`worker-plane: concurrency must be a number >= 1 (got ${concurrency})`);
    }
    const caps = [...new Set(capabilities)];
    const meta = metadata && typeof metadata === "object" ? { ...metadata } : {};
    const t = now();

    const existing = workers.get(workerId);
    if (existing) {
      // idempotent re-registration: same identity, refreshed spec + lease
      existing.region = region;
      existing.capabilities = caps;
      existing.concurrency = conc;
      existing.executor = executor;
      existing.metadata = meta;
      existing.status = "online";
      existing.staleOf = null;
      existing.lastBeatTs = t;
      existing.lastBeatAt = new Date(t).toISOString();
      emitEvent({ type: "reregistered", workerId, region });
      if (autoHeartbeat) startAutoHeartbeat(existing);
      else stopAutoHeartbeat(workerId); // explicit opt-out on re-registration
      return snapshot(existing);
    }

    const rec = {
      workerId,
      region,
      capabilities: caps,
      concurrency: conc,
      executor,
      metadata: meta,
      status: "online",
      staleOf: null, // status the worker returns to after a stale recovery
      registeredAt: new Date(t).toISOString(),
      lastBeatTs: t,
      lastBeatAt: new Date(t).toISOString(),
      beats: 0,
      missedBeats: 0,
      lastLoad: { activeJobs: 0 },
      drainingSince: null,
    };
    workers.set(workerId, rec);
    rec.beats = 1; // registration IS the first beat
    emitEvent({ type: "registered", workerId, region, capabilities: caps, concurrency: conc });
    if (autoHeartbeat) startAutoHeartbeat(rec);
    return snapshot(rec);
  }

  function startAutoHeartbeat(rec) {
    stopAutoHeartbeat(rec.workerId);
    const t = setInterval(() => {
      heartbeat(rec.workerId, {}).catch(() => {}); // heartbeat never throws
    }, heartbeatMs);
    t.unref?.();
    hbTimers.set(rec.workerId, t);
  }

  /** Remove a worker from the registry (stops its heartbeat timer). */
  function deregisterWorker(workerId, { reason = "deregistered" } = {}) {
    const rec = workers.get(workerId);
    if (!rec) return null;
    stopAutoHeartbeat(workerId);
    internalActive.delete(workerId);
    workers.delete(workerId);
    emitEvent({ type: "deregistered", workerId, region: rec.region, reason });
    return { ...snapshot(rec), status: "deregistered", deregisterReason: reason };
  }

  // ---- heartbeat / load ---------------------------------------------------

  /**
   * Refresh a worker's lease and (optionally) its reported load. Unknown ids
   * return null — a heartbeat never auto-registers. Never throws.
   * @param {string} workerId
   * @param {{ load?: object, note?: string }} [payload]
   */
  async function heartbeat(workerId, { load = null, note = null } = {}) {
    const rec = workers.get(workerId);
    if (!rec) return null;
    const t = now();
    rec.beats++;
    rec.missedBeats = 0;
    rec.lastBeatTs = t;
    rec.lastBeatAt = new Date(t).toISOString();
    if (load && typeof load === "object") rec.lastLoad = { ...rec.lastLoad, ...load };
    if (rec.status === "stale") {
      rec.status = rec.staleOf || "online";
      rec.staleOf = null;
      emitEvent({ type: "recovered", workerId, region: rec.region });
    }
    // note: a heartbeat while "draining" refreshes the lease but keeps the
    // draining status — draining is lifted by re-registration only.
    if (note) rec.metadata = { ...rec.metadata, lastNote: String(note).slice(0, 300) };
    return snapshot(rec);
  }

  /** Stop accepting NEW jobs; finish what is already routed. */
  function markDraining(workerId, reason = "shutdown") {
    const rec = workers.get(workerId);
    if (!rec) return null;
    if (rec.status === "online") {
      rec.status = "draining";
      rec.drainingSince = nowIso();
      emitEvent({ type: "draining", workerId, region: rec.region, reason });
    }
    return snapshot(rec);
  }

  /** Execution-plane accounting: a job started on this worker (embedded mode). */
  function noteJobStart(workerId) {
    internalActive.set(workerId, (internalActive.get(workerId) || 0) + 1);
  }

  /** Execution-plane accounting: a job finished on this worker. */
  function noteJobEnd(workerId) {
    const n = (internalActive.get(workerId) || 0) - 1;
    if (n <= 0) internalActive.delete(workerId);
    else internalActive.set(workerId, n);
  }

  function getExecutor(workerId) {
    const rec = workers.get(workerId);
    return rec ? rec.executor : null;
  }

  function getActive(workerId) {
    const rec = workers.get(workerId);
    return rec ? effectiveActive(rec) : null;
  }

  // ---- staleness sweep ----------------------------------------------------

  /**
   * Evaluate every registration against the clock: online → stale after the
   * TTL, stale → recovered on a fresh beat, stale (or freshly-expired) →
   * pruned after deregisterAfterMs. Runs automatically on a timer and may be
   * called manually (tests use a virtual clock instead of sleeping).
   */
  function sweep() {
    const t = now();
    for (const rec of [...workers.values()]) {
      const age = t - rec.lastBeatTs;
      if (rec.status === "stale") {
        if (isFresh(rec, t)) {
          rec.status = rec.staleOf || "online";
          rec.staleOf = null;
          emitEvent({ type: "recovered", workerId: rec.workerId, region: rec.region });
        } else if (deregisterAfterMs > 0 && age > deregisterAfterMs) {
          prune(rec, `stale for ${age}ms > deregisterAfterMs ${deregisterAfterMs}ms`);
        }
      } else if (!isFresh(rec, t)) {
        rec.staleOf = rec.status; // remember where to return on recovery
        rec.status = "stale";
        rec.missedBeats++;
        emitEvent({ type: "stale", workerId: rec.workerId, region: rec.region, silenceMs: age });
        if (deregisterAfterMs > 0 && age > deregisterAfterMs) {
          prune(rec, `stale for ${age}ms > deregisterAfterMs ${deregisterAfterMs}ms`);
        }
      }
    }
  }

  function prune(rec, reason) {
    stopAutoHeartbeat(rec.workerId);
    internalActive.delete(rec.workerId);
    workers.delete(rec.workerId);
    emitEvent({ type: "pruned", workerId: rec.workerId, region: rec.region, reason });
  }

  const sweepTimer = setInterval(sweep, Math.max(25, Math.min(heartbeatMs, heartbeatTtlMs) / 2));
  sweepTimer.unref?.();

  // ---- routing ------------------------------------------------------------

  /**
   * Pick the best routable worker: region match → ALL requested capabilities →
   * fresh heartbeat → below capacity → lowest load ratio → newest beat →
   * workerId (deterministic). Throws NoWorkerAvailableError with per-candidate
   * reasons when nothing qualifies.
   */
  function selectWorker({ region = null, capability = null, capabilities = [], requireExecutor = false } = {}) {
    const requestedCaps = [...new Set([capability, ...capabilities].filter(Boolean))];
    const at = now();
    const reasons = [];
    let best = null;

    for (const rec of workers.values()) {
      const why = (reason) => reasons.push({ workerId: rec.workerId, region: rec.region, status: rec.status, reason });
      if (region && rec.region !== region) { why(`region mismatch (worker is in "${rec.region}")`); continue; }
      if (rec.status === "stale") { why("stale heartbeat"); continue; }
      if (rec.status === "draining") { why("draining (not accepting new jobs)"); continue; }
      if (rec.status === "online" && !isFresh(rec, at)) { why("heartbeat expired"); continue; }
      const missing = requestedCaps.filter((c) => !rec.capabilities.includes(c));
      if (missing.length) { why(`missing capabilities: ${missing.join(", ")}`); continue; }
      if (requireExecutor && typeof rec.executor !== "function") {
        why("no executor bound (memory-backend dispatch cannot reach a remote worker)"); continue;
      }
      const active = effectiveActive(rec);
      if (active >= rec.concurrency) { why(`at capacity (${active}/${rec.concurrency})`); continue; }
      const score = (active + 1) / Math.max(1, rec.concurrency);
      if (
        !best ||
        score < best.score ||
        (score === best.score && rec.lastBeatTs > best.rec.lastBeatTs) ||
        (score === best.score && rec.lastBeatTs === best.rec.lastBeatTs && rec.workerId < best.rec.workerId)
      ) {
        best = { rec, score };
      }
    }

    if (!best) {
      throw new NoWorkerAvailableError(
        `no worker available for region=${region || "(any)"} capabilities=[${requestedCaps.join(", ")}]` +
          (reasons.length ? ` — ${reasons.length} candidate(s) excluded` : ""),
        {
          requested: { region, capabilities: requestedCaps, requireExecutor },
          reasons,
        }
      );
    }
    return snapshot(best.rec);
  }

  // ---- observation / lifecycle --------------------------------------------

  function getWorker(workerId) {
    const rec = workers.get(workerId);
    return rec ? snapshot(rec) : null;
  }

  function listWorkers({ region = null, status = null, capability = null, capabilities = [] } = {}) {
    const wanted = [...new Set([capability, ...capabilities].filter(Boolean))];
    const out = [];
    for (const rec of workers.values()) {
      if (region && rec.region !== region) continue;
      const st = liveStatus(rec);
      if (status && st !== status) continue;
      if (wanted.length && !wanted.every((c) => rec.capabilities.includes(c))) continue;
      out.push(snapshot(rec));
    }
    return out;
  }

  function status() {
    const list = listWorkers();
    const counts = { total: list.length, online: 0, draining: 0, stale: 0 };
    const regions = {};
    for (const w of list) {
      counts[w.status] = (counts[w.status] || 0) + 1;
      regions[w.region] = (regions[w.region] || 0) + 1;
    }
    return {
      defaultRegion,
      heartbeatMs,
      heartbeatTtlMs,
      deregisterAfterMs: deregisterAfterMs || 0,
      counts,
      regions,
      workers: list,
    };
  }

  /** Stop every timer and clear the registry. Adapters are NOT owned here. */
  function close() {
    for (const id of [...hbTimers.keys()]) stopAutoHeartbeat(id);
    clearInterval(sweepTimer);
    workers.clear();
    internalActive.clear();
    emitEvent({ type: "closed" });
  }

  return {
    registerWorker,
    deregisterWorker,
    heartbeat,
    markDraining,
    noteJobStart,
    noteJobEnd,
    getExecutor,
    getActive,
    selectWorker,
    getWorker,
    listWorkers,
    status,
    sweep,
    getDefaultRegion: () => defaultRegion,
    onEvent(cb) {
      events.on("event", cb);
      return () => events.off("event", cb);
    },
    on(type, cb) {
      const wrapped = (ev) => {
        if (ev.type === type) cb(ev);
      };
      events.on("event", wrapped);
      return () => events.off("event", wrapped);
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// B. ExecutionPlane — data plane: route jobs to region workers through the
//    EXISTING queue adapter contract (src/queues/clone-queue.js)
// ---------------------------------------------------------------------------

const MAX_ROUTES_DEFAULT = 500;

// completion vocabulary — mirrors the bullmq completed handler in clone-queue.js
function resolveCompletionStatus(result) {
  if (result && typeof result === "object" && typeof result.status === "string") return result.status;
  if (result && typeof result === "object" && "passed" in result) {
    return result.passed ? "completed" : "completed_with_limitations";
  }
  return "completed";
}

/**
 * Create the execution plane.
 * @param {object} opts
 * @param {object} opts.plane                 the control plane (createWorkerPlane) — REQUIRED
 * @param {({region}) => object} [opts.createRegionAdapter]
 *        builds the per-region queue adapter. Default: the REAL clone-queue
 *        adapter with queue name "clone-jobs:<region>" (BullMQ backend when
 *        REDIS_URL / CLONER_REDIS_URL is set, in-process memory otherwise).
 *        Tests inject a factory that pins redisUrl and/or a mock transport.
 * @param {number} [opts.maxRoutes]           bounded route-ledger size (default 500)
 */
export function createExecutionPlane({ plane: control, createRegionAdapter = null, maxRoutes = MAX_ROUTES_DEFAULT } = {}) {
  if (!control || typeof control.selectWorker !== "function") {
    throw new TypeError("execution-plane: a worker plane (createWorkerPlane) is required");
  }
  if (createRegionAdapter !== null && typeof createRegionAdapter !== "function") {
    throw new TypeError("execution-plane: createRegionAdapter must be a function or null");
  }

  const events = new EventEmitter();
  events.setMaxListeners(200);

  const adapters = new Map(); // region → queue adapter (existing clone-queue contract)
  const routes = new Map(); // jobId → route ledger record
  const routeByEntry = new WeakMap(); // adapter entry → route (event attribution)

  // default: the REAL per-region clone-queue adapter
  const defaultAdapterFactory = ({ region }) =>
    createCloneQueue({ queueName: `${QUEUE_NAME}:${region}` });
  const makeAdapter = createRegionAdapter || defaultAdapterFactory;

  function emitEvent(ev) {
    events.emit("event", { at: nowIso(), ...ev });
  }

  function attachStatusFeed(adapter, region) {
    adapter.onStatus(({ jobId, tempId, status, entry, data }) => {
      const route = routeByEntry.get(entry) || routes.get(jobId || tempId) || null;
      if (route) {
        route.status = status;
        if (status === "error") route.error = entry?.error || data?.error || route.error || null;
        if (TERMINAL_JOB_STATUSES.has(status)) route.finishedAt = route.finishedAt || nowIso();
      }
      emitEvent({
        type: "job-status",
        jobId: route?.jobId || jobId || tempId,
        status,
        region,
        workerId: route?.workerId || null,
        data: data ?? null,
      });
    });
  }

  async function regionAdapter(region) {
    let adapter = adapters.get(region);
    if (!adapter) {
      adapter = makeAdapter({ region });
      if (!adapter || typeof adapter.enqueue !== "function") {
        throw new DispatchError(`region adapter for "${region}" does not satisfy the queue adapter contract`);
      }
      adapters.set(region, adapter);
      attachStatusFeed(adapter, region);
    }
    if (adapter.ready) await adapter.ready; // bullmq backend probe (no-op when resolved)
    return adapter;
  }

  // move the ledger key when the pipeline names the job mid-run (linkJobId)
  function rekeyRoute(oldId, newId, route) {
    if (!oldId || !newId || oldId === newId) return;
    if (routes.get(oldId) === route) routes.delete(oldId);
    route.jobId = newId;
    routes.set(newId, route);
  }

  /**
   * Route one job to the best region worker THROUGH the queue adapter contract.
   *
   * @param {object} job
   * @param {object} [job.payload]      job payload (clone payload or arbitrary)
   * @param {string|null} [job.jobId]   explicit job id (idempotent re-dispatch through the adapter)
   * @param {{userId, orgId}|null} [job.owner] access owner passed to the adapter entry
   * @param {string|null} [job.region]  target region (default: the control plane's defaultRegion)
   * @param {string[]} [job.capabilities] worker capabilities the job requires (ALL of them)
   * @returns {{ entry, route, worker, region, backend }}
   * @throws {DispatchError} malformed dispatch (no resolvable region)
   * @throws {NoWorkerAvailableError} no eligible worker (nothing is enqueued)
   */
  async function dispatchJob({ payload = {}, jobId = null, owner = null, region = null, capability = null, capabilities = [] } = {}) {
    const effRegion = region || control.getDefaultRegion();
    if (!effRegion || typeof effRegion !== "string" || !REGION_RE.test(effRegion)) {
      throw new DispatchError(
        `dispatch requires a region (got "${effRegion}") — pass region or set CLONER_WORKER_REGION / plane defaultRegion`
      );
    }

    const adapter = await regionAdapter(effRegion);
    // memory backend = embedded execution: the worker's executor runs here, so
    // only workers WITH an executor are routable; bullmq backend = the job
    // travels the transport to the region queue and a remote worker consumes it.
    const embedded = adapter.backend !== "bullmq";
    const worker = control.selectWorker({
      region: effRegion,
      capability,
      capabilities,
      requireExecutor: embedded,
    });

    const route = {
      jobId: jobId || null,
      tempId: null,
      region: effRegion,
      workerId: worker.workerId,
      backend: adapter.backend,
      status: "queued",
      dispatchedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };

    // the adapter's run closure: execute the job ON the selected region worker
    // (embedded mode). In bullmq mode the adapter ignores this closure.
    const runClosure = async ({ entry, report }) => {
      route.startedAt = nowIso();
      route.status = "running";
      control.noteJobStart(worker.workerId);
      try {
        // live executor lookup — a re-registration may have replaced it
        const executor = control.getExecutor(worker.workerId);
        if (typeof executor !== "function") {
          throw new Error(`worker ${worker.workerId} has no executor bound for embedded dispatch`);
        }
        const ctx = {
          jobId: entry.jobId || entry.tempId,
          entry,
          payload,
          region: effRegion,
          assignedWorkerId: worker.workerId,
          report,
          linkJobId: (tempId, newId) => {
            adapter.linkJobId(tempId, newId);
            rekeyRoute(route.jobId, newId, route);
          },
        };
        const result = await executor(ctx);
        // an intentionally cancelled job must not be overwritten by a late
        // completion — mirrors the adapter's cancel-wins rule (#memDispatch)
        if (entry.cancelRequested) return result;
        // completion vocabulary mirrors the bullmq completed handler
        entry.status = resolveCompletionStatus(result);
        report(entry.status);
        route.result = result ?? null;
        // the pipeline may have named the job directly on the entry
        if (entry.jobId && entry.jobId !== route.jobId) rekeyRoute(route.jobId, entry.jobId, route);
        return result;
      } finally {
        control.noteJobEnd(worker.workerId);
        route.finishedAt = route.finishedAt || nowIso();
      }
    };

    // enqueue is SYNCHRONOUS-returning on the adapter contract; the embedded
    // run closure may already have started by the time this line returns.
    const entry = adapter.enqueue({ payload, run: runClosure, jobId, owner });
    route.entry = entry;
    route.tempId = entry.tempId;
    if (!route.jobId) route.jobId = entry.jobId || entry.tempId;
    routes.set(route.jobId, route);
    routeByEntry.set(entry, route);

    // bounded ledger: drop the oldest routes beyond maxRoutes
    while (routes.size > maxRoutes) {
      const oldest = routes.keys().next().value;
      if (oldest === undefined) break;
      routes.delete(oldest);
    }

    emitEvent({ type: "job-routed", jobId: route.jobId, region: effRegion, workerId: worker.workerId, backend: route.backend });
    return { entry, route, worker, region: effRegion, backend: adapter.backend };
  }

  /** Route ledger lookup (plain copy — no entry reference leaks). */
  function getRoute(jobId) {
    const route = routes.get(jobId) || null;
    if (!route) return null;
    const { entry, ...plain } = route;
    return plain;
  }

  function listRoutes() {
    return [...routes.values()].map(({ entry, ...plain }) => plain);
  }

  /** Cancel through the SAME adapter the job was routed into. */
  async function cancelJob(jobId) {
    const route = routes.get(jobId);
    if (!route) return false;
    const adapter = adapters.get(route.region);
    if (!adapter) return false;
    return adapter.cancel(route.jobId);
  }

  function listRegions() {
    return [...adapters.entries()].map(([region, adapter]) => ({
      region,
      backend: adapter.backend,
      queueName: adapter.queueName || null,
      jobs: adapter.listJobs ? adapter.listJobs().length : null,
    }));
  }

  function adapterFor(region) {
    return adapters.get(region) || null;
  }

  async function whenIdle() {
    await Promise.all([...adapters.values()].map((a) => a.whenIdle ? a.whenIdle() : Promise.resolve()));
  }

  /** Close every region adapter (the control plane's lifecycle is separate). */
  async function close() {
    const list = [...adapters.values()];
    adapters.clear();
    routes.clear();
    await Promise.all(list.map((a) => a.close ? a.close() : Promise.resolve()));
  }

  return {
    dispatchJob,
    dispatch: dispatchJob, // short alias
    getRoute,
    listRoutes,
    cancelJob,
    listRegions,
    adapterFor,
    whenIdle,
    close,
    onEvent(cb) {
      events.on("event", cb);
      return () => events.off("event", cb);
    },
    on(type, cb) {
      const wrapped = (ev) => {
        if (ev.type === type) cb(ev);
      };
      events.on("event", wrapped);
      return () => events.off("event", wrapped);
    },
  };
}
