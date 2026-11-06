// BullMQ worker for the "clone-jobs" queue (task 3.3.3, hardened in 4.0.3).
// Consumes the jobs the clone-queue adapter enqueues in bullmq mode and
// executes the SAME pipeline the in-process fallback runs — the shared
// definition in src/queues/pipeline-job.js (runPipelineJob = runExplorationJob
// → reconstructFromArtifacts → verifyTask).
//
//   • bounded concurrency: MAX_CONCURRENT env (falls back to
//     MAX_EXPLORATION_JOBS, then 2 — the same cap the in-process queue uses)
//   • retry: 3 attempts with exponential backoff on TRANSIENT errors
//     (classified by isTransientError in clone-queue.js); non-transient
//     failures are wrapped in BullMQ's UnrecoverableError so they fail on the
//     first attempt instead of burning retries. Jobs that exhaust every
//     attempt are dead-lettered into the "-dead" queue by the producer side
//     (src/queues/clone-queue.js #attachQueueEvents).
//   • job scope: the processor wraps execution in withJobScope(job.id) so every
//     bus emission inside carries THIS job's id — log tagging stays correct
//     across processes and for concurrent jobs
//   • worker identity (4.0.3): CLONER_WORKER_ID (default clone-worker-<pid>)
//     tags the BullMQ worker name, every progress payload and the heartbeat
//   • stage persistence (4.0.3): when the job carries a taskId (job.data.meta
//     or payload.taskId), each pipeline stage is written to the task_stages
//     table (canonical names: exploration / reconstruction / verification)
//     — best-effort, a DB hiccup never fails the clone job
//   • stalled-job recovery (4.0.3): BullMQ's stalled check is configured via
//     CLONER_STALLED_INTERVAL_MS / CLONER_LOCK_DURATION_MS /
//     CLONER_MAX_STALLED_COUNT; a stalled job's lock expires and BullMQ moves
//     it back to wait for another worker to pick up
//   • health + heartbeat (4.0.3): src/workers/worker-health.js runs alongside
//     (Redis heartbeat when reachable, in-memory otherwise) and is returned as
//     `health` for queue-depth visibility
//   • graceful shutdown: SIGTERM/SIGINT drain (stop accepting, finish active,
//     heartbeat flips to "draining" and stops)
//
// Run standalone:  node src/workers/clone-worker.js   (requires REDIS_URL or
// CLONER_REDIS_URL; run with the project root as cwd — artifacts/ is relative)
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, UnrecoverableError } from "bullmq";
import IORedis from "ioredis";
import { withJobScope } from "../events.js";
import { runPipelineJob } from "../queues/pipeline-job.js";
import { QUEUE_NAME, isTransientError, resolveRedisUrl } from "../queues/clone-queue.js";
import { createWorkerHealth, defaultWorkerId } from "./worker-health.js";
import { tracedExecutor } from "../observability/trace-context.js"; // task 4.2.10

const workerConcurrency = () =>
  Number(process.env.MAX_CONCURRENT || process.env.MAX_EXPLORATION_JOBS || 2);

const stalledInterval = () => Number(process.env.CLONER_STALLED_INTERVAL_MS || 30_000);
const lockDuration = () => Number(process.env.CLONER_LOCK_DURATION_MS || 30_000);
const maxStalledCount = () => Number(process.env.CLONER_MAX_STALLED_COUNT || 2);

// report status (pipeline-job vocabulary) → canonical task_stages.stage name
// (the five stages of src/queues/pipeline-job.js — ADR-0001)
const CANONICAL_STAGE = {
  exploring: "exploration",
  validating: "artifact_validation",
  reconstructing: "reconstruction",
  verifying: "verification",
  exporting: "export",
};

// Best-effort stage persister: one task_stages row per canonical stage
// (in_progress on begin, completed/failed on finish). All DB failures are
// logged and swallowed — observability must never fail the clone job. Only
// real task ids (tasks.id is a UUID) are persisted; anything else skips the
// DB entirely.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createStagePersister(taskId) {
  if (!taskId || !UUID_RE.test(String(taskId)) || process.env.CLONER_PERSIST_STAGES === "0") return null;
  let repo;
  try {
    repo = await import("../database/task-repository.js");
  } catch (e) {
    console.warn(`[clone-worker] task_stages persistence unavailable: ${e?.message || e}`);
    return null;
  }
  const state = { current: null };
  return {
    async begin(reportStatus) {
      const stage = CANONICAL_STAGE[reportStatus];
      if (!stage) return;
      try {
        await repo.setStage(taskId, stage, "in_progress");
        state.current = stage;
      } catch (e) {
        console.warn(`[clone-worker] task_stages setStage(${stage}) failed: ${e?.message || e}`);
      }
    },
    async finish(result = null, error = null) {
      const stage = state.current;
      if (!stage) return;
      state.current = null;
      try {
        await repo.completeStage(taskId, stage, result, error);
      } catch (e) {
        console.warn(`[clone-worker] task_stages completeStage(${stage}) failed: ${e?.message || e}`);
      }
    },
  };
}

/**
 * Start a BullMQ worker for the clone-jobs queue.
 * @param {object} [opts]
 * @param {number} [opts.concurrency]      override MAX_CONCURRENT (mainly for tests)
 * @param {string} [opts.redisUrl]         default: REDIS_URL / CLONER_REDIS_URL
 * @param {object} [opts.connection]       pre-built ioredis connection (optional)
 * @param {(payload: object, ctx: { jobId: string, job: object, report: Function }) => Promise<object>} [opts.executor]
 *                                         pipeline override (tests inject fakes;
 *                                         default = the shared runPipelineJob)
 * @param {boolean} [opts.registerSignals] install SIGTERM/SIGINT drain (default true)
 * @param {string} [opts.workerId]         override CLONER_WORKER_ID (tests)
 * @param {number} [opts.stalledInterval]  stalled-check interval ms (default CLONER_STALLED_INTERVAL_MS / 30000)
 * @param {number} [opts.lockDuration]     job lock duration ms (default CLONER_LOCK_DURATION_MS / 30000)
 * @param {number} [opts.maxStalledCount]  stalled re-dispatches before failure (default 2)
 * @param {object|null} [opts.healthRedis] pre-built ioredis client for the heartbeat store
 * @param {boolean} [opts.registerHealth]  run the worker-health heartbeat (default true)
 * @param {() => Promise<object>|object|null} [opts.getQueueCounts]
 *                                         queue-depth source for health (pass a Queue)
 * @returns {{ worker: import("bullmq").Worker, close: () => Promise<void>, concurrency: number,
 *             workerId: string, health: object, stalledCount: { n: number } }}
 */
export function startCloneWorker({
  concurrency,
  redisUrl = resolveRedisUrl(),
  connection = null,
  executor = null,
  registerSignals = true,
  workerId = defaultWorkerId(),
  stalledInterval: stalledMs = stalledInterval(),
  lockDuration: lockMs = lockDuration(),
  maxStalledCount: maxStalled = maxStalledCount(),
  healthRedis = null,
  registerHealth = true,
  getQueueCounts = null,
  workerFactory = null,
} = {}) {
  if (!connection && !redisUrl && !workerFactory) throw new Error("clone-worker: no REDIS_URL / CLONER_REDIS_URL configured");
  const conc = Number(concurrency || workerConcurrency());
  // task 4.2.10 tracing: the DEFAULT executor continues the producer's trace
  // (payload.traceparent, W3C) and derives a stage span per report() transition
  // (stage.exploration / reconstruction / verification). A caller-injected
  // executor (tests) is NOT wrapped here — callers that want tracing wrap
  // their own (double-wrapping would emit every span twice).
  const runJob = executor || defaultExecutorTraced;
  // connection is built lazily: with a workerFactory (mock transport) no
  // ioredis client is ever created
  let ownConnection = null;
  const getConnection = () => connection || (ownConnection ||= buildConnection(redisUrl));
  const stalledCount = { n: 0 };

  // the processor is the REAL code under test — the transport (real BullMQ or
  // the injected mock) is only responsible for invoking it with attempt/backoff
  const processor = async (job) => {
    const { payload = {}, jobId, meta = {} } = job.data || {};
    // AsyncLocalStorage scope: every bus emission inside the pipeline is
    // tagged with THIS job's id, so log tagging stays correct across
    // processes and interleaved concurrent jobs (e.job filters hold).
    return withJobScope(jobId || job.id, async () => {
      // 4.0.3: persist pipeline progress into task_stages when the job
      // carries task metadata (enqueue side packs meta.taskId; the raw
      // payload.taskId is honored too)
      const taskId = meta.taskId || payload?.taskId || null;
      const persister = await createStagePersister(taskId);
      try {
        const result = await runJob(payload, {
          jobId: jobId || job.id,
          job,
          report: (status, data = {}) => {
            // progress payload carries the worker id (4.0.3 tagging)
            Promise.resolve(job.updateProgress({ status, workerId, ...data })).catch(() => {});
            if (persister) {
              persister.finish().then(() => persister.begin(status)).catch(() => {});
            }
          },
        });
        if (persister) {
          await persister.finish({ status: result?.status, passed: result?.passed, artifactsDir: result?.artifactsDir }).catch(() => {});
        }
        return JSON.stringify(result ?? { ok: true });
      } catch (e) {
        if (persister) {
          await persister.finish(null, String(e?.message || e)).catch(() => {});
        }
        if (!isTransientError(e)) {
          // non-transient (bad payload, programming error, …): fail now —
          // UnrecoverableError tells BullMQ to skip the remaining attempts
          throw new UnrecoverableError(String(e?.message || e));
        }
        throw e; // transient: BullMQ retries per the job's attempts/backoff
      }
    });
  };

  let worker;
  let ownConnectionCreated = false;
  if (workerFactory) {
    // test-only injection hook (task 4.0.3): the factory receives the REAL
    // processor + worker options and returns a transport-specific worker
    // ({ close(), isRunning(), getActiveJobsCount(), name, ... })
    worker = workerFactory({ queueName: QUEUE_NAME, processor, opts: { concurrency: conc, name: workerId, stalledInterval: stalledMs, lockDuration: lockMs, maxStalledCount: maxStalled } });
  } else {
    ownConnection = getConnection();
    ownConnectionCreated = !connection;
    worker = new Worker(
      QUEUE_NAME,
      processor,
      {
        connection: ownConnection,
        concurrency: conc,
        name: workerId, // BullMQ worker name — shows up in the workers set / UI
        // NOTE: attempts (3) + exponential backoff are set on each job by the
        // enqueue side (clone-queue.js) — BullMQ reads them from the job, so the
        // worker only decides WHICH failures deserve a retry (transient only,
        // see isTransientError + UnrecoverableError above)
      //
      // stalled-job recovery (4.0.3): a worker that dies mid-job stops
      // renewing its job lock; once the lock expires the stalled check moves
      // the job back to wait and another worker re-executes it.
      // NOTE: BullMQ's stalled check takes a mutex key whose TTL is the
      // checking worker's stalledInterval — workers with DIFFERENT
      // stalledIntervals block each other's checks (measured via redis
      // MONITOR). Keep CLONER_STALLED_INTERVAL_MS uniform across workers.
      stalledInterval: stalledMs,
      lockDuration: lockMs,
      maxStalledCount: maxStalled,
      },
    );
  }

  worker.on("completed", (job) => console.log(`[clone-worker:${workerId}] job ${job.id} completed`));
  worker.on("failed", (job, err) => {
    const attempt = job?.attemptsMade ?? "?";
    const tries = job?.opts?.attempts ?? "?";
    console.warn(`[clone-worker:${workerId}] job ${job?.id} failed (attempt ${attempt}/${tries}): ${err?.message || err}`);
  });
  worker.on("stalled", (jobIds) => {
    // BullMQ moved these jobs back to wait after their lock expired — they
    // will be re-executed by this or another worker (stalled-job recovery)
    stalledCount.n += Array.isArray(jobIds) ? jobIds.length : 1;
    console.warn(`[clone-worker:${workerId}] stalled jobs recovered back to wait: ${Array.isArray(jobIds) ? jobIds.join(",") : jobIds}`);
  });
  worker.on("error", (e) => console.error(`[clone-worker:${workerId}] worker error: ${e?.message || e}`));

  // health + heartbeat (4.0.3): Redis store when a redisUrl is available
  // (cross-process liveness via cloner:worker:heartbeat:<workerId>), in-memory
  // otherwise. Heartbeat needs its OWN connection — the worker connection
  // issues blocking commands and must not be shared.
  const health = createWorkerHealth({
    workerId,
    worker,
    concurrency: conc,
    redis: healthRedis || null,
    redisUrl: healthRedis ? "" : redisUrl,
    getQueueCounts,
    register: false, // started explicitly below, respecting registerHealth
  });
  if (registerHealth) health.start();

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    health.markDraining("worker close"); // publish draining before teardown
    // worker.close() stops accepting new jobs and drains the active ones;
    // connections built here (not passed in) are ours to tear down
    await worker.close();
    await health.stop();
    if (ownConnectionCreated && ownConnection) {
      try { await ownConnection.quit(); } catch {}
    }
  }

  if (registerSignals) {
    const drain = (sig) => {
      if (closing) return;
      console.log(`[clone-worker:${workerId}] ${sig} received — draining (finishing active jobs, no new ones)`);
      close().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once("SIGTERM", () => drain("SIGTERM"));
    process.once("SIGINT", () => drain("SIGINT"));
  }

  return { worker, close, concurrency: conc, workerId, health, stalledCount };
}

// task 4.2.10: the traced default — startCloneWorker falls back to this so the
// production worker path always continues the producer trace + emits stage
// spans, while injected test executors stay unwrapped.
const defaultExecutorTraced = tracedExecutor(defaultExecutor);

async function defaultExecutor(payload, { jobId, report }) {
  // G5.5 human-journey fix (the worker-side executor hook documented in
  // artifact-lifecycle.js enqueueSweep): the boot/hourly artifact-lifecycle
  // sweep travels as { kind:"artifact-sweep", root, execute } — the old code
  // fed it into the CLONE pipeline (runExplorationJob on url=undefined), so on
  // a bullmq deployment every sweep dead-lettered and retention never ran.
  if (payload && payload.kind === "artifact-sweep") {
    report("sweeping", { kind: "artifact-sweep" });
    const { sweep } = await import("../storage/artifact-lifecycle.js");
    const result = sweep({
      base: payload.root,
      execute: payload.execute !== false,
      allowLegacy: false,
      orphanPolicy: "skip",
    });
    report("swept", { kind: "artifact-sweep" });
    return result ?? { ok: true };
  }
  return runPipelineJob(payload, { jobId, report });
}

function buildConnection(redisUrl) {
  // workers use blocking commands → maxRetriesPerRequest must be null
  return new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

// standalone entry: node src/workers/clone-worker.js
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    console.error("[clone-worker] REDIS_URL (or CLONER_REDIS_URL) is required to run the worker");
    process.exit(1);
  }
  const workerId = defaultWorkerId();
  const { worker, concurrency } = startCloneWorker({ redisUrl });
  worker.waitUntilReady().then(() => {
    console.log(`[clone-worker:${workerId}] ready — queue=${QUEUE_NAME} concurrency=${concurrency}`);
  }).catch((e) => {
    console.error(`[clone-worker] failed to start: ${e?.message || e}`);
    process.exit(1);
  });
}
