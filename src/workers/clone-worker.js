// BullMQ worker for the "clone-jobs" queue (task 3.3.3). Consumes the jobs the
// clone-queue adapter enqueues in bullmq mode and executes the SAME pipeline the
// in-process fallback runs — the shared definition in
// src/queues/pipeline-job.js (runPipelineJob = runExplorationJob →
// reconstructFromArtifacts → verifyTask).
//
//   • bounded concurrency: MAX_CONCURRENT env (falls back to
//     MAX_EXPLORATION_JOBS, then 2 — the same cap the in-process queue uses)
//   • retry: 3 attempts with exponential backoff on TRANSIENT errors
//     (classified by isTransientError in clone-queue.js); non-transient
//     failures are wrapped in BullMQ's UnrecoverableError so they fail on the
//     first attempt instead of burning retries
//   • job scope: the processor wraps execution in withJobScope(job.id) so every
//     bus emission inside carries THIS job's id — log tagging stays correct
//     across processes and for concurrent jobs
//   • graceful shutdown: SIGTERM/SIGINT drain (stop accepting, finish active)
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

const workerConcurrency = () =>
  Number(process.env.MAX_CONCURRENT || process.env.MAX_EXPLORATION_JOBS || 2);

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
 * @returns {{ worker: import("bullmq").Worker, close: () => Promise<void>, concurrency: number }}
 */
export function startCloneWorker({
  concurrency,
  redisUrl = resolveRedisUrl(),
  connection = null,
  executor = null,
  registerSignals = true,
} = {}) {
  if (!connection && !redisUrl) throw new Error("clone-worker: no REDIS_URL / CLONER_REDIS_URL configured");
  const conc = Number(concurrency || workerConcurrency());
  const runJob = executor || defaultExecutor;
  const ownConnection = connection || buildConnection(redisUrl);

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { payload = {}, jobId } = job.data || {};
      // AsyncLocalStorage scope: every bus emission inside the pipeline is
      // tagged with THIS job's id, so log tagging stays correct across
      // processes and interleaved concurrent jobs (e.job filters hold).
      return withJobScope(jobId || job.id, async () => {
        try {
          const result = await runJob(payload, {
            jobId: jobId || job.id,
            job,
            report: (status, data = {}) => {
              Promise.resolve(job.updateProgress({ status, ...data })).catch(() => {});
            },
          });
          return JSON.stringify(result ?? { ok: true });
        } catch (e) {
          if (!isTransientError(e)) {
            // non-transient (bad payload, programming error, …): fail now —
            // UnrecoverableError tells BullMQ to skip the remaining attempts
            throw new UnrecoverableError(String(e?.message || e));
          }
          throw e; // transient: BullMQ retries per the job's attempts/backoff
        }
      });
    },
    {
      connection: ownConnection,
      concurrency: conc,
      // NOTE: attempts (3) + exponential backoff are set on each job by the
      // enqueue side (clone-queue.js) — BullMQ reads them from the job, so the
      // worker only decides WHICH failures deserve a retry (transient only,
      // see isTransientError + UnrecoverableError above)
    },
  );

  worker.on("completed", (job) => console.log(`[clone-worker] job ${job.id} completed`));
  worker.on("failed", (job, err) => {
    const attempt = job?.attemptsMade ?? "?";
    const tries = job?.opts?.attempts ?? "?";
    console.warn(`[clone-worker] job ${job?.id} failed (attempt ${attempt}/${tries}): ${err?.message || err}`);
  });
  worker.on("error", (e) => console.error(`[clone-worker] worker error: ${e?.message || e}`));

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    // worker.close() stops accepting new jobs and drains the active ones;
    // connections built here (not passed in) are ours to tear down
    await worker.close();
    if (!connection) {
      try { await ownConnection.quit(); } catch {}
    }
  }

  if (registerSignals) {
    const drain = (sig) => {
      if (closing) return;
      console.log(`[clone-worker] ${sig} received — draining (finishing active jobs, no new ones)`);
      close().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once("SIGTERM", () => drain("SIGTERM"));
    process.once("SIGINT", () => drain("SIGINT"));
  }

  return { worker, close, concurrency: conc };
}

async function defaultExecutor(payload, { jobId, report }) {
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
  const { worker, concurrency } = startCloneWorker({ redisUrl });
  worker.waitUntilReady().then(() => {
    console.log(`[clone-worker] ready — queue=${QUEUE_NAME} concurrency=${concurrency}`);
  }).catch((e) => {
    console.error(`[clone-worker] failed to start: ${e?.message || e}`);
    process.exit(1);
  });
}
