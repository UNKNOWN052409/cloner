// Resource-aware scheduler (task 4.2.7): jobs declare what they NEED, workers
// declare what they HAVE, and this module packs jobs onto workers respecting
// both — never overcommitting memory or browser slots — in priority order.
//
// WHY A SCHEDULER (and why it is pure): the 4.0 worker infra runs every
// worker with a flat MAX_CONCURRENT cap (src/workers/clone-worker.js) and the
// queue dispatches FIFO regardless of what a job actually consumes (a heavy
// clone needs a real browser + memory; a light one does not). This module is
// the missing dispatch brain:
//
//   • jobs declare   resources: { memoryMb, browserSlots }   (+ priority)
//   • workers declare capacity: { memoryMb, browserSlots }
//   • dispatch() packs the pending queue onto registered workers:
//       - HARD LIMITS: a placement is only made if the worker's remaining
//         memory AND remaining browser slots both cover the job's needs.
//         Overcommit is impossible by construction (invariant-tested).
//       - PRIORITY: pending jobs are considered highest-priority-first, FIFO
//         (submission order) within the same priority.
//       - BEST-FIT placement: among workers that can take the job, the one
//         with the SMALLEST remaining memory after the placement wins (then
//         smallest remaining slots, then worker id) — this leaves the big
//         contiguous headroom for the big jobs and minimizes fragmentation.
//       - MODE "strict" (default): the dispatch pass stops at the first
//         pending job that does not currently fit anywhere (head-of-line
//         blocking — nothing lower-priority may jump it).
//       - MODE "backfill": the pass skips blocked heads and keeps packing
//         lower-priority jobs into leftover resources (keeps workers busy;
//         a blocked head is still never overtaken by a job that fits where
//         the head could fit — it only uses resources the head cannot use
//         at that moment).
//       - UNFITTABLE: a job whose needs exceed the whole fleet's maximum
//         capacity can never run; it is flagged (event "unfittable"), never
//         blocks the queue, and submit() rejects it eagerly when the fleet
//         is already known.
//   • FAILURE handling: markWorkerDown(id) requeues everything running on
//     that worker (event "requeue", attempts++) and stops offering it work;
//     markWorkerUp(id) returns it to the pool. The caller re-dispatches.
//   • ORACLE-MODE CONTRACT for the 4.2.6 cost-aware scheduler
//     (src/distributed/cost-aware-scheduler.js injects this class as `base`):
//       - assign(job, { candidates }) → { workerId, regionId } | workerId |
//         null — one-shot placement in the caller's candidate order, reserved
//         against this ledger, freed by release(null, { jobId });
//       - listWorkers() → flat descriptors (workerId/regionId/totals/free);
//       - new ResourceScheduler({ workers: [...] }) pre-registers a fleet
//         (native or flat descriptor shapes — see normalizeWorkerSpec).
//
// INTEGRATION (how this becomes live): the scheduler owns NO I/O — it is a
// deterministic, clock-injectable state machine driven by its owner:
//   1. each clone-worker process, on startup, calls registerWorker() with
//      { id: workerId, capacity: { memoryMb: env-derived, browserSlots: MAX_CONCURRENT } };
//   2. enqueue-side clone-queue.submit() carries the job's declared needs
//      (payload.policy.resources, defaulting to one browser slot + baseline
//      memory);
//   3. the dispatcher loop subscribes to "assign" events and enqueues the
//      job onto that specific worker's BullMQ queue, calling release() on
//      the corresponding "completed"/"failed" QueueEvent, and
//      markWorkerDown() from the existing worker-health stale detection.
// Until that wiring lands (integration-owned files), the module stands alone
// and is exercised for real by scripts/test-resource-scheduler.mjs — a
// discrete-event simulation with independent invariant ledgers.
//
// No credentials, no network, no timers of its own: determinism is a feature
// (same inputs → same placements), which is what makes the simulation tests
// and the future live wiring share the exact same code path.

import { EventEmitter } from "node:events";

/** Error with a stable machine-readable code (INVALID_* / DUPLICATE / UNKNOWN_* / UNFITTABLE / WORKER_BUSY). */
export class SchedulerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }
}

const CODES = {
  INVALID_JOB: "INVALID_JOB",
  INVALID_WORKER: "INVALID_WORKER",
  DUPLICATE: "DUPLICATE",
  UNKNOWN_JOB: "UNKNOWN_JOB",
  UNKNOWN_WORKER: "UNKNOWN_WORKER",
  UNFITTABLE: "UNFITTABLE",
  WORKER_BUSY: "WORKER_BUSY",
};

const defaultNow = () => new Date().toISOString();

/** @returns {number} non-negative finite number */
const isNonNegNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** @returns {number} non-negative integer (browser slots cannot be fractional) */
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validate + normalize one job specification.
 * Rules: resources must be an object; memoryMb (number ≥ 0) and browserSlots
 * (integer ≥ 0) each default to 0 when the other is present — but at least
 * ONE of them must be declared (a job that declares no needs is a bug).
 * priority (finite number, default 0; higher = more important) and data
 * (opaque payload passed through untouched) are optional.
 *
 * @param {object} spec
 * @param {string} [spec.id]          caller-chosen id; auto "job-<seq>" when absent
 * @param {number} [spec.priority]
 * @param {{ memoryMb?: number, browserSlots?: number }} spec.resources
 * @param {unknown} [spec.data]       opaque payload (carried, never interpreted)
 * @param {number} seq                monotonic submission counter (FIFO tiebreak)
 * @param {(iso?: string) => string} [now]
 * @returns {{ id: string, priority: number, memoryMb: number, browserSlots: number, data: unknown, seq: number, submittedAt: string }}
 */
export function normalizeJobSpec(spec, seq, now = defaultNow) {
  if (!spec || typeof spec !== "object") throw new SchedulerError(CODES.INVALID_JOB, "job spec must be an object");
  const { id, priority = 0, resources, data = null } = spec;
  if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
    throw new SchedulerError(CODES.INVALID_JOB, "job id must be a non-empty string when provided");
  }
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new SchedulerError(CODES.INVALID_JOB, `job priority must be a finite number, got ${String(priority)}`);
  }
  if (!resources || typeof resources !== "object") {
    throw new SchedulerError(CODES.INVALID_JOB, "job must declare resources: { memoryMb, browserSlots }");
  }
  const { memoryMb, browserSlots } = resources;
  const hasMem = memoryMb !== undefined;
  const hasSlots = browserSlots !== undefined;
  if (!hasMem && !hasSlots) {
    throw new SchedulerError(CODES.INVALID_JOB, "job must declare at least one resource need (memoryMb or browserSlots)");
  }
  if (hasMem && !isNonNegNum(memoryMb)) {
    throw new SchedulerError(CODES.INVALID_JOB, `resources.memoryMb must be a number >= 0, got ${String(memoryMb)}`);
  }
  if (hasSlots && !isNonNegInt(browserSlots)) {
    throw new SchedulerError(CODES.INVALID_JOB, `resources.browserSlots must be an integer >= 0, got ${String(browserSlots)}`);
  }
  return {
    id: id ?? `job-${seq}`,
    priority,
    memoryMb: hasMem ? memoryMb : 0,
    browserSlots: hasSlots ? browserSlots : 0,
    data,
    seq,
    submittedAt: now(),
  };
}

/**
 * Validate + normalize one worker specification. Two shapes are accepted:
 *   • native:  { id, capacity: { memoryMb, browserSlots }, regionId?, data? }
 *   • flat:    { workerId, memoryTotal, browserSlotsTotal, regionId? }
 *     (the descriptor shape the 4.2.6 cost-aware lane passes around)
 * Both capacities are REQUIRED — a worker with undeclared capacity cannot be
 * packed safely, so that is an error, not a default.
 *
 * @param {object} spec
 * @returns {{ id: string, regionId: string|null, capacityMemoryMb: number, capacityBrowserSlots: number }}
 */
export function normalizeWorkerSpec(spec) {
  if (!spec || typeof spec !== "object") throw new SchedulerError(CODES.INVALID_WORKER, "worker spec must be an object");
  const id = spec.id ?? spec.workerId;
  const regionId = typeof spec.regionId === "string" && spec.regionId.length > 0 ? spec.regionId : null;
  const capacity = spec.capacity ?? null;
  const memoryMb = capacity ? capacity.memoryMb : spec.memoryTotal;
  const browserSlots = capacity ? capacity.browserSlots : spec.browserSlotsTotal;
  if (typeof id !== "string" || id.length === 0) throw new SchedulerError(CODES.INVALID_WORKER, "worker id must be a non-empty string");
  if (!capacity && (memoryMb === undefined || browserSlots === undefined)) {
    throw new SchedulerError(CODES.INVALID_WORKER, `worker "${id}" must declare capacity: { memoryMb, browserSlots }`);
  }
  if (!isNonNegNum(memoryMb)) {
    throw new SchedulerError(CODES.INVALID_WORKER, `worker "${id}" capacity.memoryMb must be a number >= 0, got ${String(memoryMb)}`);
  }
  if (!isNonNegInt(browserSlots)) {
    throw new SchedulerError(CODES.INVALID_WORKER, `worker "${id}" capacity.browserSlots must be an integer >= 0, got ${String(browserSlots)}`);
  }
  return { id, regionId, capacityMemoryMb: memoryMb, capacityBrowserSlots: browserSlots };
}

/**
 * Validate + normalize a one-shot assign() job (both field vocabularies:
 * `memory`/`memoryMb`, `jobId`/`id`). Thrown only for malformed input — a
 * well-formed job that fits nowhere returns null from assign(), never throws,
 * so the 4.2.6 wrapper can map null → its own "no_worker_has_capacity".
 *
 * @param {object} job
 * @param {() => string} genId
 * @returns {{ jobId: string, memoryMb: number, browserSlots: number }}
 */
function normalizeAssignJob(job, genId) {
  if (!job || typeof job !== "object") throw new SchedulerError(CODES.INVALID_JOB, "assign(job) requires a job object");
  const jobId = job.jobId ?? job.id ?? genId();
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new SchedulerError(CODES.INVALID_JOB, "assign(job) requires a non-empty jobId");
  }
  const memoryMb = job.memory ?? job.memoryMb ?? 0;
  const browserSlots = job.browserSlots ?? 0;
  if (!isNonNegNum(memoryMb)) throw new SchedulerError(CODES.INVALID_JOB, `assign(job) memory must be a number >= 0, got ${String(memoryMb)}`);
  if (!isNonNegInt(browserSlots)) throw new SchedulerError(CODES.INVALID_JOB, `assign(job) browserSlots must be an integer >= 0, got ${String(browserSlots)}`);
  return { jobId, memoryMb, browserSlots };
}

/**
 * Does `job` fit on `worker` right now? (pure — used by the scheduler and
 * exported for external invariant checkers)
 *
 * @param {{ capacityMemoryMb: number, capacityBrowserSlots: number, usedMemoryMb: number, usedBrowserSlots: number }} worker
 * @param {{ memoryMb: number, browserSlots: number }} job
 * @returns {boolean}
 */
export function fitsCapacity(worker, job) {
  return (
    worker.capacityMemoryMb - worker.usedMemoryMb >= job.memoryMb &&
    worker.capacityBrowserSlots - worker.usedBrowserSlots >= job.browserSlots
  );
}

/**
 * Best worker for `job` among `workers` (pure): smallest remaining memory
 * after placement, then smallest remaining slots after placement, then
 * lexicographic worker id. Returns the worker object or null.
 *
 * @param {Array<object>} workers
 * @param {{ memoryMb: number, browserSlots: number }} job
 * @returns {object|null}
 */
export function bestWorkerFor(workers, job) {
  let best = null;
  for (const w of workers) {
    if (!fitsCapacity(w, job)) continue;
    const remMem = w.capacityMemoryMb - w.usedMemoryMb - job.memoryMb;
    const remSlots = w.capacityBrowserSlots - w.usedBrowserSlots - job.browserSlots;
    if (
      best === null ||
      remMem < best.remMem ||
      (remMem === best.remMem && (remSlots < best.remSlots || (remSlots === best.remSlots && w.id < best.id)))
    ) {
      best = { worker: w, remMem, remSlots };
    }
  }
  return best ? best.worker : null;
}

/**
 * Resource-aware scheduler. See the module header for the full contract.
 * Events (EventEmitter):
 *   "assign"    ({ jobId, workerId, priority, memoryMb, browserSlots, attempts })
 *   "release"   ({ jobId, workerId, completedAt })
 *   "requeue"   ({ jobId, workerId, attempts, reason })
 *   "unfittable"({ jobId, memoryMb, browserSlots })   flag set (fleet max too small)
 *   "fittable"  ({ jobId })                          flag cleared (fleet grew / resources changed)
 *   "worker-down" ({ workerId, requeued: string[] })
 *   "worker-up"   ({ workerId })
 *   "worker-removed" ({ workerId })
 */
export class ResourceScheduler extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {"strict"|"backfill"} [opts.mode]  dispatch mode (default "strict")
   * @param {() => string} [opts.now]          injectable ISO clock (tests/sims)
   * @param {number} [opts.completedHistory]   how many completed records to retain (default 1000)
   * @param {Array<object>} [opts.workers]     workers to register up front
   *                                           (native or flat descriptor shape —
   *                                           see normalizeWorkerSpec)
   */
  constructor({ mode = "strict", now = defaultNow, completedHistory = 1000, workers = [] } = {}) {
    super();
    if (mode !== "strict" && mode !== "backfill") {
      throw new SchedulerError(CODES.INVALID_JOB, `mode must be "strict" or "backfill", got ${String(mode)}`);
    }
    this.mode = mode;
    this.#now = now;
    this.#completedHistory = completedHistory;
    for (const w of workers) this.registerWorker(w);
  }

  #now;
  #completedHistory;
  #seq = 0;
  /** @type {Map<string, object>} workerId → state */
  #workers = new Map();
  /** @type {Map<string, object>} jobId → job state (pending | running | completed-retained) */
  #jobs = new Map();
  /** pending job ids in insertion order — ordering is applied per dispatch pass */
  #pending = [];
  /** @type {Map<string, string>} jobId → workerId for running jobs */
  #running = new Map();
  /** bounded completed log (newest last) */
  #completed = [];
  #stats = { submitted: 0, assigned: 0, completed: 0, requeued: 0, dispatchPasses: 0, unfittableFlags: 0 };

  // ---- fleet management ----

  /**
   * Register (or re-register) a worker. Re-registering an existing id updates
   * its capacity in place ONLY when it is idle (pending/running jobs pin the
   * old capacity); otherwise DUPLICATE is thrown.
   * @param {{ id: string, capacity: { memoryMb: number, browserSlots: number }, data?: unknown }} spec
   * @returns {object} the registered worker snapshot
   */
  registerWorker(spec) {
    const norm = normalizeWorkerSpec(spec);
    const existing = this.#workers.get(norm.id);
    if (existing) {
      if (existing.runningCount > 0) {
        throw new SchedulerError(CODES.DUPLICATE, `worker "${norm.id}" is already registered and has ${existing.runningCount} running job(s)`);
      }
      existing.capacityMemoryMb = norm.capacityMemoryMb;
      existing.capacityBrowserSlots = norm.capacityBrowserSlots;
      if (norm.regionId !== null) existing.regionId = norm.regionId;
      if (spec.data !== undefined) existing.data = spec.data;
      return this.workerSnapshot(norm.id);
    }
    this.#workers.set(norm.id, {
      id: norm.id,
      regionId: norm.regionId,
      capacityMemoryMb: norm.capacityMemoryMb,
      capacityBrowserSlots: norm.capacityBrowserSlots,
      usedMemoryMb: 0,
      usedBrowserSlots: 0,
      runningCount: 0,
      down: false,
      data: spec.data !== undefined ? spec.data : null,
    });
    return this.workerSnapshot(norm.id);
  }

  /**
   * Mark a worker down: everything running on it is requeued (attempts++,
   * event per job) and the worker stops receiving placements until
   * markWorkerUp(). Its usage is zeroed — the work is no longer there.
   * @param {string} workerId
   * @param {{ reason?: string }} [opts]
   * @returns {string[]} requeued job ids
   */
  markWorkerDown(workerId, { reason = "unspecified" } = {}) {
    const w = this.#requireWorker(workerId);
    if (w.down) return [];
    w.down = true;
    const requeued = [];
    for (const [jobId, onWorker] of this.#running) {
      if (onWorker !== workerId) continue;
      this.#running.delete(jobId);
      const job = this.#jobs.get(jobId);
      w.usedMemoryMb -= job.memoryMb;
      w.usedBrowserSlots -= job.browserSlots;
      w.runningCount -= 1;
      job.state = "pending";
      job.attempts += 1;
      this.#pending.push(jobId);
      requeued.push(jobId);
      this.#stats.requeued += 1;
      this.emit("requeue", { jobId, workerId, attempts: job.attempts, reason });
    }
    this.emit("worker-down", { workerId, requeued, reason });
    return requeued;
  }

  /** Return a downed worker to the placement pool. */
  markWorkerUp(workerId) {
    const w = this.#requireWorker(workerId);
    if (!w.down) return this.workerSnapshot(workerId);
    w.down = false;
    this.emit("worker-up", { workerId });
    return this.workerSnapshot(workerId);
  }

  /**
   * Remove a worker from the fleet entirely. Refuses (WORKER_BUSY) while it
   * still runs jobs — call markWorkerDown() first.
   * @param {string} workerId
   */
  removeWorker(workerId) {
    const w = this.#requireWorker(workerId);
    if (w.runningCount > 0) {
      throw new SchedulerError(CODES.WORKER_BUSY, `worker "${workerId}" still has ${w.runningCount} running job(s); markWorkerDown() first`);
    }
    this.#workers.delete(workerId);
    this.emit("worker-removed", { workerId });
  }

  // ---- job lifecycle ----

  /**
   * Submit a job. Rejected eagerly with UNFITTABLE when the fleet is known
   * (≥1 registered worker) and the job could never fit on any of it; accepted
   * with zero workers (fleet unknown — re-checked per dispatch pass).
   * Re-submitting an id that has COMPLETED starts a fresh run (retry path);
   * duplicating a pending/running id is a DUPLICATE error.
   *
   * @param {{ id?: string, priority?: number, resources: { memoryMb?: number, browserSlots?: number }, data?: unknown }} spec
   * @returns {object} the accepted job snapshot
   */
  submit(spec) {
    const seq = ++this.#seq;
    const job = normalizeJobSpec(spec, seq, this.#now);
    if (this.#jobs.has(job.id)) {
      const prev = this.#jobs.get(job.id);
      if (prev.state === "completed") {
        this.#jobs.delete(job.id); // fresh run replaces the retained record
        const idx = this.#completed.findIndex((c) => c.jobId === job.id);
        if (idx >= 0) this.#completed.splice(idx, 1);
      } else {
        throw new SchedulerError(CODES.DUPLICATE, `job "${job.id}" is already ${prev.state}`);
      }
    }
    if (this.#workerCount() > 0 && !this.canEverFit(job)) {
      throw new SchedulerError(
        CODES.UNFITTABLE,
        `job "${job.id}" needs memoryMb=${job.memoryMb}, browserSlots=${job.browserSlots} — no registered worker can ever satisfy it (fleet max: memoryMb=${this.fleetMax().memoryMb}, browserSlots=${this.fleetMax().browserSlots})`,
      );
    }
    const state = { ...job, state: "pending", attempts: 0 };
    this.#jobs.set(job.id, state);
    this.#pending.push(job.id);
    this.#stats.submitted += 1;
    return this.jobSnapshot(job.id);
  }

  /**
   * Report a running job as finished (frees its resources). Two call shapes:
   *   • release(workerId, jobId) — the native form; strict errors on unknown
   *     worker/job (UNKNOWN_WORKER / UNKNOWN_JOB).
   *   • release(null, { jobId, ... }) — the best-effort form the 4.2.6
   *     cost-aware wrapper uses: the worker is resolved from the running map
   *     and an UNKNOWN job is a silent no-op (mirrors the reference base
   *     contract; release must never throw inside a completion handler).
   * release() never auto-dispatches — the caller drives dispatch().
   * @param {string|null} workerId
   * @param {string|{ jobId: string }} jobIdOrInfo
   */
  release(workerId, jobIdOrInfo) {
    if (jobIdOrInfo !== null && typeof jobIdOrInfo === "object") {
      const jobId = jobIdOrInfo.jobId;
      const onWorker = jobId != null ? this.#running.get(jobId) : undefined;
      if (onWorker === undefined) return null; // best-effort form: unknown job is a no-op
      return this.#doRelease(onWorker, jobId);
    }
    return this.#doRelease(workerId, jobIdOrInfo);
  }

  #doRelease(workerId, jobId) {
    const w = this.#requireWorker(workerId);
    const onWorker = this.#running.get(jobId);
    if (onWorker === undefined) {
      throw new SchedulerError(CODES.UNKNOWN_JOB, `job "${jobId}" is not running (cannot release from worker "${workerId}")`);
    }
    if (onWorker !== workerId) {
      throw new SchedulerError(CODES.UNKNOWN_JOB, `job "${jobId}" runs on worker "${onWorker}", not "${workerId}"`);
    }
    const job = this.#jobs.get(jobId);
    this.#running.delete(jobId);
    w.usedMemoryMb -= job.memoryMb;
    w.usedBrowserSlots -= job.browserSlots;
    w.runningCount -= 1;
    job.state = "completed";
    this.#completed.push({ jobId, workerId, completedAt: this.#now(), attempts: job.attempts });
    if (this.#completed.length > this.#completedHistory) this.#completed.shift();
    this.#stats.completed += 1;
    this.emit("release", { jobId, workerId, completedAt: this.#completed[this.#completed.length - 1].completedAt });
    return { jobId, workerId };
  }

  /**
   * ONE-SHOT PLACEMENT — the base-scheduler contract consumed by the 4.2.6
   * cost-aware scheduler in oracle mode (src/distributed/cost-aware-scheduler.js:
   * "base.assign(job, { candidates }) -> { workerId, regionId } | workerId | null").
   * Places `job` on the FIRST candidate (in the caller's cost-preference order —
   * the wrapper owns cross-region preference, this module owns packing) whose
   * remaining memory AND browser slots cover the need, reserving against THIS
   * scheduler's ledger (candidate descriptors are treated as ordering hints
   * only — this ledger is the single source of truth, so overcommit stays
   * impossible). Returns null — never throws — when nothing fits, when the
   * job id is already active, or when candidates name unregistered workers.
   * The reservation is freed by release(null, { jobId }).
   *
   * @param {{ jobId?: string, id?: string, priority?: number, memory?: number, memoryMb?: number, browserSlots?: number }} job
   * @param {{ candidates?: Array<{ workerId?: string, id?: string }> }} [opts]
   * @returns {{ workerId: string, regionId: string|null, jobId: string }|null}
   */
  assign(job, { candidates = null } = {}) {
    const need = normalizeAssignJob(job, () => `assign-${++this.#seq}`);
    if (this.#jobs.get(need.jobId) && this.#jobs.get(need.jobId).state !== "completed") {
      return null; // same id already active — no capacity for a duplicate run
    }
    const order = [];
    if (candidates) {
      const seen = new Set();
      for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const id = c.workerId ?? c.id;
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        const w = this.#workers.get(id);
        if (w) order.push(w); // unregistered candidates are skipped, not errors
      }
    } else {
      order.push(...this.#workers.values());
    }
    for (const w of order) {
      if (w.down || !fitsCapacity(w, need)) continue;
      if (this.#jobs.has(need.jobId)) {
        this.#jobs.delete(need.jobId); // completed record → fresh run replaces it
        const idx = this.#completed.findIndex((c) => c.jobId === need.jobId);
        if (idx >= 0) this.#completed.splice(idx, 1);
      }
      const state = {
        id: need.jobId,
        priority: typeof job.priority === "number" && Number.isFinite(job.priority) ? job.priority : 0,
        memoryMb: need.memoryMb,
        browserSlots: need.browserSlots,
        data: null,
        seq: ++this.#seq,
        submittedAt: this.#now(),
        state: "running",
        attempts: 0,
      };
      this.#jobs.set(need.jobId, state);
      w.usedMemoryMb += need.memoryMb;
      w.usedBrowserSlots += need.browserSlots;
      w.runningCount += 1;
      this.#running.set(need.jobId, w.id);
      this.#stats.assigned += 1;
      this.emit("assign", {
        jobId: need.jobId,
        workerId: w.id,
        priority: state.priority,
        memoryMb: need.memoryMb,
        browserSlots: need.browserSlots,
        attempts: 0,
      });
      return { workerId: w.id, regionId: w.regionId ?? null, jobId: need.jobId };
    }
    return null;
  }

  /**
   * Fleet descriptors in the flat shape the 4.2.6 cost-aware lane consumes
   * (workerId/regionId/totals/free). Live values come from THIS ledger.
   * @returns {Array<object>}
   */
  listWorkers() {
    return [...this.#workers.values()].map((w) => ({
      workerId: w.id,
      regionId: w.regionId ?? null,
      memoryTotal: w.capacityMemoryMb,
      memoryFree: w.capacityMemoryMb - w.usedMemoryMb,
      browserSlotsTotal: w.capacityBrowserSlots,
      browserSlotsFree: w.capacityBrowserSlots - w.usedBrowserSlots,
      down: w.down,
    }));
  }

  /**
   * Run one dispatch pass: pack the pending queue onto available workers.
   * Returns the placements IN ORDER. Emits "assign" per placement AFTER the
   * corresponding state mutation (so listeners observe consistent state).
   * @returns {Array<{ jobId: string, workerId: string, priority: number, memoryMb: number, browserSlots: number, attempts: number }>}
   */
  dispatch() {
    this.#stats.dispatchPasses += 1;

    // pending in dispatch order: priority desc, then submission (FIFO)
    const order = this.#pending
      .map((id) => this.#jobs.get(id))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);

    const fleetMax = this.fleetMax();
    const placements = [];

    for (const job of order) {
      const unfittable = job.memoryMb > fleetMax.memoryMb || job.browserSlots > fleetMax.browserSlots;

      if (unfittable) {
        // Can never run on this fleet — flag it, never let it block others.
        if (!job.unfittable) {
          job.unfittable = true;
          this.#stats.unfittableFlags += 1;
          this.emit("unfittable", { jobId: job.id, memoryMb: job.memoryMb, browserSlots: job.browserSlots });
        }
        continue; // skip (both modes) — but do NOT break: it is not a transient block
      }
      if (job.unfittable) {
        job.unfittable = false; // fleet grew / capacities changed — back in play
        this.emit("fittable", { jobId: job.id });
      }

      const available = [...this.#workers.values()].filter((w) => !w.down);
      const target = bestWorkerFor(available, job);
      if (!target) {
        if (this.mode === "strict") break; // head-of-line blocking: nothing may jump this job
        continue; // backfill: skip and try lower-priority jobs
      }

      // place (mutate BEFORE emitting so listeners see consistent state)
      target.usedMemoryMb += job.memoryMb;
      target.usedBrowserSlots += job.browserSlots;
      target.runningCount += 1;
      job.state = "running";
      this.#pending = this.#pending.filter((id) => id !== job.id);
      this.#running.set(job.id, target.id);
      this.#stats.assigned += 1;

      const placement = {
        jobId: job.id,
        workerId: target.id,
        priority: job.priority,
        memoryMb: job.memoryMb,
        browserSlots: job.browserSlots,
        attempts: job.attempts,
      };
      placements.push(placement);
      this.emit("assign", placement);
    }

    return placements;
  }

  // ---- introspection ----

  /** Fleet-wide maximum single-worker capacity (unfittability threshold). */
  fleetMax() {
    let memoryMb = 0;
    let browserSlots = 0;
    for (const w of this.#workers.values()) {
      if (w.capacityMemoryMb > memoryMb) memoryMb = w.capacityMemoryMb;
      if (w.capacityBrowserSlots > browserSlots) browserSlots = w.capacityBrowserSlots;
    }
    return { memoryMb, browserSlots };
  }

  /**
   * Could this job shape EVER run on the current fleet (ignoring current
   * usage and down flags — capacity only)? With no registered workers the
   * answer is optimistically true (fleet unknown).
   * @param {{ memoryMb: number, browserSlots: number }} job
   * @returns {boolean}
   */
  canEverFit(job) {
    const max = this.fleetMax();
    if (this.#workerCount() === 0) return true;
    return job.memoryMb <= max.memoryMb && job.browserSlots <= max.browserSlots;
  }

  workerSnapshot(workerId) {
    const w = this.#requireWorker(workerId);
    const remMem = w.capacityMemoryMb - w.usedMemoryMb;
    const remSlots = w.capacityBrowserSlots - w.usedBrowserSlots;
    return {
      id: w.id,
      regionId: w.regionId ?? null,
      capacity: { memoryMb: w.capacityMemoryMb, browserSlots: w.capacityBrowserSlots },
      used: { memoryMb: w.usedMemoryMb, browserSlots: w.usedBrowserSlots },
      remaining: { memoryMb: remMem, browserSlots: remSlots },
      runningJobs: w.runningCount,
      down: w.down,
      memoryUtilization: w.capacityMemoryMb > 0 ? w.usedMemoryMb / w.capacityMemoryMb : 0,
      slotUtilization: w.capacityBrowserSlots > 0 ? w.usedBrowserSlots / w.capacityBrowserSlots : 0,
    };
  }

  jobSnapshot(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new SchedulerError(CODES.UNKNOWN_JOB, `unknown job "${jobId}"`);
    return {
      id: job.id,
      priority: job.priority,
      resources: { memoryMb: job.memoryMb, browserSlots: job.browserSlots },
      state: job.state,
      worker: this.#running.get(jobId) ?? null,
      attempts: job.attempts,
      unfittable: !!job.unfittable,
      submittedAt: job.submittedAt,
      seq: job.seq,
    };
  }

  /** Full state snapshot: pending / running / unfittable / workers / totals. */
  snapshot() {
    const pending = [];
    const running = [];
    const unfittable = [];
    for (const id of this.#pending) {
      const j = this.jobSnapshot(id);
      pending.push(j);
      if (j.unfittable) unfittable.push(j.id);
    }
    for (const [id, workerId] of this.#running) running.push({ ...this.jobSnapshot(id), worker: workerId });
    const workers = [...this.#workers.keys()].map((id) => this.workerSnapshot(id));
    return {
      mode: this.mode,
      pending,
      running,
      unfittable,
      workers,
      completedRecent: [...this.#completed],
      totals: {
        pending: pending.length,
        running: running.length,
        completed: this.#stats.completed,
        unfittablePending: unfittable.length,
      },
    };
  }

  /** Lifetime counters (monotonic; useful for dashboards / tests). */
  stats() {
    return { ...this.#stats };
  }

  // ---- internals ----

  #workerCount() {
    return this.#workers.size;
  }

  #requireWorker(workerId) {
    const w = this.#workers.get(workerId);
    if (!w) throw new SchedulerError(CODES.UNKNOWN_WORKER, `unknown worker "${workerId}"`);
    return w;
  }
}

/**
 * Convenience factory.
 * @param {object} [opts] see ResourceScheduler constructor
 */
export function createResourceScheduler(opts = {}) {
  return new ResourceScheduler(opts);
}
