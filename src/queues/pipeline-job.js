// The single definition of the clone-job pipeline: exploration → reconstruction
// → verification (task 3.3.3). Both execution paths share it so the stages can
// never drift apart:
//   • the in-process fallback queue (src/queues/clone-queue.js "memory" backend)
//     — where it mutates the registry entry exactly like the old
//     src/platform/exploration-runner.js launch() did;
//   • the BullMQ worker (src/workers/clone-worker.js) — where entry is null,
//     progress is reported through BullMQ and the result summary travels back
//     as the job's return value.
// Bus-scope tagging (withJobScope) is applied by the WORKER side (across
// processes); the in-process path keeps the old untagged behavior byte-for-byte.
import path from "node:path";
import { runExplorationJob } from "../pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "../platform/verify.js";

const DEFAULT_ARTIFACTS_ROOT = path.join(process.cwd(), "artifacts");
const noop = () => {};

/**
 * Run the full three-stage pipeline for one clone job.
 * @param {object} payload  the queueExploration payload
 *   ({ url, username, password, cookies, storage, policy, sessionId, interactionRecords })
 * @param {object} [opts]
 * @param {object|null} [opts.entry]      registry entry to update (memory path);
 *                                        null on the worker path
 * @param {string|null} [opts.jobId]      pre-decided job id (BullMQ path). The
 *                                        memory path leaves it null so the
 *                                        exploration pipeline generates the id,
 *                                        as it always has.
 * @param {(status: string, data?: object) => void} [opts.report]  status changes
 * @param {string} [opts.artifactsRoot]
 * @param {(tempId: string, jobId: string) => void} [opts.linkJobId]  registry hook:
 *                                        make the entry reachable under BOTH ids
 * @returns {Promise<object>} shaped result summary (consumed by the BullMQ
 *                            return value; the memory path ignores it)
 */
export async function runPipelineJob(payload, {
  entry = null,
  jobId = null,
  report = noop,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
  linkJobId = noop,
} = {}) {
  const { url, username, password, cookies, storage, policy, sessionId = "local", interactionRecords = [] } = payload || {};

  if (entry) {
    entry.startedAt = new Date().toISOString();
    entry.status = "exploring";
  }
  report("exploring");

  // ---- Stage 1: exploration ----
  const { jobId: id, artifactsDir, manifest } = await runExplorationJob({
    url, cookies, storage, username, password,
    config: { policy, sessionId },
    artifactsRoot,
    // BullMQ path pins the id decided at enqueue time; the memory path lets the
    // pipeline generate it (unchanged)
    jobId: jobId || undefined,
  });
  if (entry) {
    linkJobId(entry.tempId, id); // the client still holds the temp handle — make BOTH ids resolve
    entry.jobId = id;
    entry.artifactsDir = artifactsDir;
    entry.status = manifest.status;
    entry.manifest = { status: manifest.status, coverage: manifest.coverage, pages: manifest.pages?.length, metrics: manifest.metrics };
    entry.history.push({ at: new Date().toISOString(), event: "exploration completed: " + manifest.status });
  }

  // ---- Stage 2: reconstruction ----
  if (entry) entry.status = "reconstructing";
  report("reconstructing", { jobId: id, artifactsDir });
  const reconstruction = await reconstructFromArtifacts(artifactsDir, {
    outDir: artifactsDir + "-project",
    interactionRecords,
  });
  if (entry) {
    entry.reconstruction = { passed: reconstruction.report.passed, pages: reconstruction.report.generatedFiles, repairs: reconstruction.report.repairs?.length || 0 };
    entry.history.push({ at: new Date().toISOString(), event: "reconstruction: " + (reconstruction.report.passed ? "passed" : "completed with limitations") });
  }

  // ---- Stage 3: verification ----
  if (entry) entry.status = "verifying";
  report("verifying", { jobId: id });
  const verification = await verifyTask(artifactsDir);
  const passed = !!verification.passed;
  if (entry) {
    entry.verification = { passed: verification.passed, stages: verification.stages?.map((s) => ({ stage: s.stage, passed: s.passed })) };
    entry.status = passed ? "completed" : "completed_with_limitations";
    entry.history.push({ at: new Date().toISOString(), event: "verification " + (verification.passed ? "PASSED" : "completed with failures") });
  }
  const status = passed ? "completed" : "completed_with_limitations";
  report(status, { jobId: id, artifactsDir });

  // shaped summary — mirrors the registry entry fields so the producer-side
  // QueueEvents "completed" handler can merge it 1:1
  return {
    jobId: id,
    artifactsDir,
    status,
    passed,
    manifest: { status: manifest.status, coverage: manifest.coverage, pages: manifest.pages?.length, metrics: manifest.metrics },
    reconstruction: { passed: reconstruction.report.passed, pages: reconstruction.report.generatedFiles, repairs: reconstruction.report.repairs?.length || 0 },
    verification: { passed: verification.passed, stages: verification.stages?.map((s) => ({ stage: s.stage, passed: s.passed })) },
  };
}
