// The single definition of the clone-job pipeline: exploration → artifact
// validation → reconstruction → verification → export (task 3.3.3; the export
// and validation stages are folded from the retired 5-stage orchestrator —
// ADR-0001). Both execution paths share it so the stages can never drift apart:
//   • the in-process fallback queue (src/queues/clone-queue.js "memory" backend)
//     — where it mutates the registry entry exactly like the old
//     src/platform/exploration-runner.js launch() did;
//   • the BullMQ worker (src/workers/clone-worker.js) — where entry is null,
//     progress is reported through BullMQ and the result summary travels back
//     as the job's return value.
// Bus-scope tagging (withJobScope) is applied by the WORKER side (across
// processes); the in-process path keeps the old untagged behavior byte-for-byte.
//
// Stage observability (log contract + viewer contract): the post-exploration
// stages share ONE logger and ONE workflow emitter, both bound to the job id —
// artifact_validation and export summaries are emitted HERE, reconstruction and
// verification summaries inside their modules (which adopt these handles), so
// artifacts/<id>/logs/job.log carries exactly one summary line per stage for
// all five stages. The shared emitter's open-todo map also lets the crash path
// below close every still-open viewer todo.
import fs from "node:fs";
import path from "node:path";
import { runExplorationJob } from "../pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "../reconstruction/verify.js";
import { exportV2Task } from "../platform/exporter.js";
import { resolveCloneAdConfig } from "../runtimeTemplate.js"; // task 4.5.5 ad-slot emission hook
import { writeIntegrityManifest } from "../storage/artifact-lifecycle.js";
import { createLogger } from "../observability/logger.js";
import { createWorkflowEmitter } from "../observability/workflow-events.js";

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
  const { url, username, password, cookies, storage, policy, sessionId = "local", interactionRecords = [], monetize = false, instructions = "", frameworkPreference = null, storageStateFile = null, sessionSidecarFile = null } = payload || {};

  // task 4.5.5: ad slots ONLY for a clone whose owner opted in (monetize, the
  // policy-safe default is OFF). resolveCloneAdConfig() returns null when no
  // official zone is configured — the generator then emits zero ad markup, and
  // the history carries the honest note.
  const adConfig = monetize ? resolveCloneAdConfig() : null;
  if (monetize && entry) {
    entry.history.push({
      at: new Date().toISOString(),
      event: adConfig
        ? `monetize: opted in — emitting official ad zones (${adConfig.zones.map((z) => z.key).join(", ")})`
        : "monetize: opted in but no ad zone is configured — zero ad markup emitted",
    });
  }

  if (entry) {
    entry.startedAt = new Date().toISOString();
    entry.status = "exploring";
  }
  report("exploring");

  // ---- Stage 1: exploration ----
  const { jobId: id, artifactsDir, manifest } = await runExplorationJob({
    url, cookies, storage, username, password,
    // session reuse: a prior job's verified auth/session.json (+ sessionStorage
    // sidecar) seeds this context so NO second login happens — Tradovate-style
    // sites kick the older concurrent session on a repeated login
    storageStateFile, sessionSidecarFile,
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

  // ---- job-level observability (stages 2–5) ----
  // ONE logger + ONE workflow emitter bound to the real job id, appended into
  // the job's own logs/job.log (exploration's summary is already in there from
  // its own logger instance). reconstruction/verifyTask adopt these handles.
  const logger = createLogger({ jobId: id, artifactsDir });
  const wf = createWorkflowEmitter({ jobId: id });

  // ---- Stage 2: artifact validation (ADR-0001) — fail fast before reconstruction ----
  report("validating", { jobId: id });
  wf.stage("artifact_validation", "running", 0);
  if (!manifest.pages?.length) {
    if (manifest.status === "paused-human-required") {
      // MFA/captcha human pause (auth hook): the job ends honestly PAUSED, not
      // failed — reconstruction/verification/export have nothing to run on.
      if (entry) {
        entry.status = "paused-human-required";
        entry.history.push({ at: new Date().toISOString(), event: "exploration paused — human required for the authentication challenge" });
      }
      logger.stage("artifact_validation", "paused", { pages: 0 });
      wf.stage("artifact_validation", "paused");
      report("paused", { jobId: id, reason: "human-required" });
      return {
        jobId: id,
        artifactsDir,
        status: "paused-human-required",
        passed: false,
        manifest: { status: manifest.status, coverage: manifest.coverage, pages: 0, metrics: manifest.metrics },
        reconstruction: null,
        verification: null,
        export: null,
      };
    }
    if (entry) {
      entry.history.push({ at: new Date().toISOString(), event: "artifact validation failed: exploration produced no pages" });
    }
    logger.stage("artifact_validation", "failed", { pages: 0 });
    wf.stage("artifact_validation", "failed");
    throw new Error("exploration produced no pages — nothing to reconstruct");
  }
  logger.stage("artifact_validation", "completed", { pages: manifest.pages.length });
  wf.stage("artifact_validation", "completed", 1);

  // ---- Stages 3–5: reconstruction → verification → export ----
  // inFlightStage drives the crash-path summary: each module emits its success
  // summary only AFTER its last fallible step, so a throw here means that stage
  // never printed — the catch can emit its failed line exactly once.
  let inFlightStage = null;
  let reconstruction = null;
  let verification = null;
  let passed = false;
  let exportResult = null;
  try {
    // ---- Stage 3: reconstruction ----
    inFlightStage = "reconstruction";
    if (entry) entry.status = "reconstructing";
    report("reconstructing", { jobId: id, artifactsDir });
    reconstruction = await reconstructFromArtifacts(artifactsDir, {
      outDir: artifactsDir + "-project",
      interactionRecords,
      adConfig, // task 4.5.5: null unless the task owner opted in AND zones are configured
      instructions, // user instructions → blueprint scope (ADR-0003; audit F fix)
      frameworkPreference,
      wf, logger, // shared stage observability (log contract + viewer contract)
    });
    if (entry) {
      entry.reconstruction = { passed: reconstruction.report.passed, pages: reconstruction.report.generatedFiles, repairs: reconstruction.report.repairs?.length || 0 };
      entry.history.push({ at: new Date().toISOString(), event: "reconstruction: " + (reconstruction.report.passed ? "passed" : "completed with limitations") });
    }

    // ---- Stage 4: verification ----
    inFlightStage = "verification";
    if (entry) entry.status = "verifying";
    report("verifying", { jobId: id });
    verification = await verifyTask(artifactsDir, null, { wf, logger });
    passed = !!verification.passed;
    if (entry) {
      entry.verification = { passed: verification.passed, stages: verification.stages?.map((s) => ({ stage: s.stage, passed: s.passed })) };
      entry.status = passed ? "completed" : "completed_with_limitations";
      entry.history.push({ at: new Date().toISOString(), event: "verification " + (verification.passed ? "PASSED" : "completed with failures") });
    }

    // ---- Stage 5: export (ADR-0001) — the lifecycle ends with the deliverable ZIP ----
    // exportV2Task works off the filesystem (manifest.json + <id>-project/), so it
    // runs on BOTH queue paths; it is fail-closed on integrity and credentials.
    inFlightStage = "export";
    // Re-pin the byte-level integrity manifest before the fail-closed export:
    // the post-exploration stages legitimately append to the job tree (job.log
    // stage summaries, blueprint.json, design-tokens.json, understanding.json,
    // reports/flow-matrix.json, _reference/verification.json) and exploration's
    // freeze predates them — the recorded logs/job.log digest would read as
    // "modified" tampering otherwise. Same re-pin move export-context.js makes
    // after its context.json write; the recomputed digests are what get verified.
    try {
      writeIntegrityManifest(artifactsDir);
    } catch (e) {
      logger.warn("pipeline", `integrity manifest not re-pinned: ${String(e?.message || e).slice(0, 120)}`);
    }
    if (fs.existsSync(path.join(artifactsDir + "-project", "index.html"))) {
      report("exporting", { jobId: id });
      wf.stage("export", "running", 0);
      const exportTodo = wf.todoAdd("export:zip", "package export.zip", "export");
      exportResult = await exportV2Task(id);
      wf.todoDone(exportTodo);
      wf.stage("export", "completed", 1);
      logger.stage("export", "completed", { bytes: exportResult.size });
      if (entry) {
        entry.export = { size: exportResult.size };
        entry.history.push({ at: new Date().toISOString(), event: `export: export.zip staged (${exportResult.size} bytes)` });
      }
    } else {
      exportResult = { skipped: "no reconstructed project — verification already recorded the outcome" };
      const exportTodo = wf.todoAdd("export:zip", "package export.zip", "export");
      wf.todoDone(exportTodo, "no reconstructed project — verification already recorded the outcome");
      wf.stage("export", "completed-with-errors", 1);
      logger.stage("export", "skipped", {});
      if (entry) {
        entry.history.push({ at: new Date().toISOString(), event: "export skipped: no reconstructed project" });
      }
    }
  } catch (e) {
    // crash-path stage summary (log contract): the in-flight stage failed —
    // emit its honest failure line (its own success summary is provably not out
    // yet, see inFlightStage above) and close every still-open viewer todo with
    // the reason, then rethrow so the queue path records the job error as before
    const stage = inFlightStage || "export";
    logger.stage(stage, "failed", {});
    wf.stage(stage, "failed");
    wf.closeOpenTodos(`${stage} stage failed: ${String(e?.message || e).slice(0, 80)}`);
    throw e;
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
    export: exportResult,
  };
}
