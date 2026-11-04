// Autoscaler (task 4.2.4): periodically evaluates the scaling policy against
// real queue/worker metrics and applies the decision to a worker pool manager.
//
//   metrics (default, REAL)          policy (pure)                 apply
//   ┌────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────┐
//   │ BullMQ queue on Redis  │ → │ scaling-policy.js        │ → │ worker-pool-manager  │
//   │ + pool utilization     │   │ computeScaleDecision     │   │ add/removeWorkers    │
//   └────────────────────────┘   └──────────────────────────┘   └──────────────────────┘
//
// The default metrics source reads the REAL queue (BullMQ `getJobCounts` +
// oldest waiting job age over REDIS_URL / CLONER_REDIS_URL) and the REAL pool
// (getActiveJobsCount per running worker). When no metrics source exists
// (no Redis env and no getMetrics injected) evaluate() fails with a CLEAN
// error — the autoscaler never invents numbers, and there is no simulated
// backend in product code. Tests inject `getMetrics` and a simulated worker
// factory (remote-end simulation lives in the test file only).
//
// Determinism seam: the decision logic (scaling-policy.js) is pure and takes
// `now` from the injected `clock`, and evaluate() is callable manually — so
// simulations drive thousands of ticks without timers. start()/stop() wrap
// the same evaluate() in a real setInterval for production.
import { EventEmitter } from "node:events";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUE_NAME, resolveRedisUrl } from "../queues/clone-queue.js";
import {
  computeScaleDecision,
  commitAppliedAction,
  initialPolicyState,
  parsePolicyFromEnv,
  validateScalingPolicy,
} from "./scaling-policy.js";

const HISTORY_LIMIT = 200;

/**
 * Build the default REAL metrics provider: BullMQ queue depth/age + pool
 * utilization. Created lazily so an unreachable Redis only affects evaluate().
 * @param {object} opts
 * @param {object} opts.poolManager    the pool being scaled (worker + utilization source)
 * @param {string} opts.redisUrl       Redis connection for the BullMQ Queue
 * @param {string} [opts.queueName]    BullMQ queue to measure (default "clone-jobs")
 * @param {object} [opts.clock]        { now(): number }
 */
export function createQueueMetricsProvider({ poolManager, redisUrl, queueName = QUEUE_NAME, clock = { now: () => Date.now() } }) {
  if (!redisUrl) throw new Error("autoscaler: createQueueMetricsProvider requires a redisUrl");
  let queue = null;
  let connection = null;

  async function ensureQueue() {
    if (queue) return queue;
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    queue = new Queue(queueName, { connection });
    return queue;
  }

  async function metrics() {
    const q = await ensureQueue();
    // NOTE: BullMQ's getJobCounts is variadic — passing an ARRAY silently
    // returns a shape without the requested keys (found by Part D of the
    // autoscaling suite against the real compose Redis)
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
    // oldest WAITING job age: retried jobs keep their original timestamp,
    // which is exactly the "how long has backlog been starving" signal
    const oldestWaiting = await q.getWaiting(0, 0);
    const oldestTs = oldestWaiting?.[0]?.timestamp;
    const oldestJobAgeMs = Number.isFinite(oldestTs) ? Math.max(0, clock.now() - oldestTs) : 0;

    // pool side: probe every running worker's active count, then aggregate
    await poolManager.refreshActiveJobs();
    const pool = poolManager.stats();

    return {
      queueDepth: counts.waiting,
      oldestJobAgeMs,
      activeJobs: pool.activeJobs,
      workerCount: pool.running,
      workerUtilization: pool.utilization,
      // single-pool default: this pool IS the region. Multi-pool regions must
      // pass a getMetrics that sums regionalWorkerCount across their pools.
      regionalWorkerCount: pool.size,
    };
  }

  async function close() {
    try { if (queue) await queue.close(); } catch { /* best-effort */ }
    try { if (connection) await connection.quit(); } catch { try { connection?.disconnect(); } catch {} }
    queue = null;
    connection = null;
  }

  return { metrics, close };
}

/**
 * Create the autoscaler (an EventEmitter — emits "decision" for applied actions).
 * @param {object} opts
 * @param {object} [opts.policy]        validated scaling policy (default: parsePolicyFromEnv())
 * @param {object} opts.poolManager     worker-pool-manager instance to scale (required)
 * @param {Function|null} [opts.getMetrics] async () => metrics — overrides the default
 *        REAL provider (tests inject deterministic simulators here)
 * @param {string} [opts.redisUrl]      default resolveRedisUrl(); "" forces the no-source error
 * @param {string} [opts.queueName]     BullMQ queue measured by the default provider
 * @param {object} [opts.clock]         { now(): number } — inject a simulated clock for determinism
 * @param {number|null} [opts.intervalMs] tick interval (default policy.evaluateIntervalMs)
 * @param {boolean} [opts.autoStart]    begin the interval loop immediately (default false)
 * @param {object} [opts.logger]        { log, warn, error }
 */
export function createAutoscaler({
  policy = null,
  poolManager,
  getMetrics = null,
  redisUrl = resolveRedisUrl(),
  queueName = QUEUE_NAME,
  clock = { now: () => Date.now() },
  intervalMs = null,
  autoStart = false,
  logger = console,
} = {}) {
  if (!poolManager) throw new Error("autoscaler: poolManager is required");
  const pol = policy || parsePolicyFromEnv();
  const { ok, errors } = validateScalingPolicy(pol);
  if (!ok) throw new Error(`autoscaler: invalid scaling policy — ${errors.join("; ")}`);

  const tickMs = Math.max(100, Number(intervalMs ?? pol.evaluateIntervalMs));
  const state = { current: initialPolicyState() };
  const history = [];
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  let ownProvider = null; // the REAL queue metrics provider (ours to close)
  let timer = null;
  let stopped = true;
  let inflight = null;
  let evaluationCount = 0; // completed ticks (history is a bounded window)

  function metricsSource() {
    if (getMetrics) return getMetrics;
    if (!ownProvider) {
      if (!redisUrl) return null; // no source → evaluate() throws the clean error
      ownProvider = createQueueMetricsProvider({ poolManager, redisUrl, queueName, clock });
    }
    return ownProvider.metrics;
  }

  /**
   * ONE evaluation tick: measure → decide → apply → record. Re-entrant calls
   * while a tick is running return the in-flight evaluation.
   */
  async function evaluate() {
    if (inflight) return inflight;
    const run = (async () => {
      const source = metricsSource();
      if (!source) {
        throw new Error("autoscaler: no metrics source — set REDIS_URL / CLONER_REDIS_URL or pass getMetrics (no metrics are invented)");
      }
      const metrics = await source();
      const now = clock.now();
      const decision = computeScaleDecision({ policy: pol, metrics, state: state.current, now });

      let applied = null;
      if (decision.action === "scale-up" && decision.delta > 0) {
        const res = await poolManager.addWorkers(decision.delta, { reason: decision.reasons.join("+") });
        applied = { operation: "addWorkers", requested: decision.delta, changed: res.started.length, capped: res.capped };
      } else if (decision.action === "scale-down" && decision.delta > 0) {
        const res = await poolManager.removeWorkers(decision.delta, { reason: decision.reasons.join("+") });
        applied = {
          operation: "removeWorkers",
          requested: decision.delta,
          changed: res.removed.length,
          forced: res.removed.filter((r) => r.forced).length,
        };
      }

      // bookkeeping: cooldowns/lastAction advance ONLY for applied actions
      state.current = applied ? commitAppliedAction(decision.nextState, decision.action, now) : decision.nextState;

      const entry = {
        at: now,
        atIso: new Date(now).toISOString(),
        metrics,
        action: decision.action,
        delta: decision.delta,
        desired: decision.desired,
        reasons: decision.reasons,
        signals: decision.signals,
        sustained: decision.sustained,
        applied,
        poolSize: poolManager.size,
      };
      history.push(entry);
      evaluationCount++;
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

      if (applied) {
        logger.log?.(`[autoscaler] ${decision.action} by ${decision.delta} → pool=${poolManager.size} (reasons: ${decision.reasons.join(", ")})`);
        emitter.emit("decision", entry);
      }
      return entry;
    })().finally(() => { inflight = null; });
    inflight = run;
    return run;
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { evaluate().catch((e) => logger.error?.(`[autoscaler] evaluate failed: ${e?.message || e}`)); }, tickMs);
    timer.unref?.();
    evaluate().catch((e) => logger.error?.(`[autoscaler] evaluate failed: ${e?.message || e}`)); // first tick immediately
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    stopped = true;
  }

  async function close() {
    stop();
    if (ownProvider) {
      await ownProvider.close();
      ownProvider = null;
    }
  }

  function snapshot() {
    return {
      policy: pol,
      state: state.current,
      tickMs,
      running: !stopped,
      pool: poolManager.stats(),
      recentHistory: history.slice(-20),
      totalEvaluations: evaluationCount, // every completed tick, ever
      historyEntries: history.length, // bounded window actually retained
    };
  }

  const autoscaler = Object.assign(emitter, {
    policy: pol,
    evaluate,
    start,
    stop,
    close,
    snapshot,
    history: () => [...history],
    state: () => state.current,
  });
  // live getter must be defined with defineProperty — Object.assign would
  // INVOKE it once at construction (stopped=true) and freeze the value
  Object.defineProperty(autoscaler, "isRunning", {
    get() { return !stopped; },
    enumerable: true,
  });

  if (autoStart) start();
  return autoscaler;
}
