// Pipeline orchestrator (spec §4): connects exploration → reconstruction →
// verification → export in a single task lifecycle with persistent stage
// transitions. Uses the existing engine modules, does not duplicate logic.
import { createTask, getTask, updateTask, addTaskEvent, setStage, completeStage, addArtifact } from "../database/task-repository.js";
import { runExplorationJob } from "../pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "../platform/verify.js";
import { exportTask } from "../platform/exporter.js";
import { createLogger } from "../observability/logger.js";

const STAGES = ["exploration", "artifact_validation", "reconstruction", "verification", "export"];
const RETRYABLE = new Set(["exploration", "reconstruction"]);
const MAX_RETRIES = 2;

export async function executePipeline(taskId, userId, { cookies, storage, username, password, options = {} }) {
  const logger = createLogger({ jobId: taskId, artifactsDir: "artifacts/" + taskId, sessionId: "local" });
  const ctx = { taskId, userId, cookies, storage, username, password, options, artifactsDir: null, explorationResult: null, reconstructionResult: null, verificationResult: null, exportResult: null };

  try {
    // ---- Stage 1: Exploration ----
    await enterStage(taskId, "exploration");
    logger.info("orchestrator", "starting exploration", { url: ctx.options?.url });
    const exploration = await runExplorationJob({
      url: ctx.options.url || ctx.options.sourceUrl,
      cookies, storage, username, password,
      config: { policy: options.policy },
      artifactsRoot: "artifacts",
      jobId: taskId,
    });
    ctx.artifactsDir = exploration.artifactsDir;
    ctx.explorationResult = exploration.manifest;
    await completeStage(taskId, "exploration", { routes: exploration.manifest.discoveredRoutes, pages: exploration.manifest.pages?.length });

    // ---- Stage 2: Artifact validation ----
    await enterStage(taskId, "artifact_validation");
    if (!exploration.manifest.pages?.length) throw new Error("exploration produced no pages");
    await completeStage(taskId, "artifact_validation", { pages: exploration.manifest.pages.length });

    // ---- Stage 3: Reconstruction ----
    await enterStage(taskId, "reconstruction");
    const reconstruction = await reconstructFromArtifacts(exploration.artifactsDir, {
      outDir: exploration.artifactsDir + "-project",
      interactionRecords: options.interactionRecords || [],
    });
    ctx.reconstructionResult = reconstruction.report;
    if (!reconstruction.report.passed && reconstruction.report.limitations?.length) {
      logger.warn("orchestrator", "reconstruction completed with limitations", { limitations: reconstruction.report.limitations });
    }
    await completeStage(taskId, "reconstruction", { pages: reconstruction.report.generatedFiles, limitations: reconstruction.report.limitations?.length });

    // ---- Stage 4: Verification ----
    await enterStage(taskId, "verification");
    const verification = await verifyTask(exploration.artifactsDir);
    ctx.verificationResult = verification;
    await completeStage(taskId, "verification", { passed: verification.passed, stages: verification.stages?.map((s) => s.stage) });
    if (!verification.passed) {
      logger.warn("orchestrator", "verification failed — task marked completed_with_limitations");
    }

    // ---- Stage 5: Export ----
    await enterStage(taskId, "export");
    const { exportTask } = await import("../platform/exporter.js");
    const exportResult = await exportTask(taskId);
    ctx.exportResult = exportResult;
    await completeStage(taskId, "export", { size: exportResult.size });

    // ---- Mark complete ----
    await updateTask(taskId, userId, {
      status: verification.passed ? "completed" : "completed_with_limitations",
      current_stage: "completed",
      progress: 100,
      completed_at: new Date().toISOString(),
    });
    await addTaskEvent(taskId, "pipeline.completed", { verification: verification.passed });
    logger.info("orchestrator", "pipeline completed", { taskId, verification: verification.passed });
    return { taskId, status: "completed", verification: verification.passed };

  } catch (e) {
    const stage = STAGES.find((s) => {
      try { return require("fs").existsSync(`artifacts/${taskId}/.${s}.in_progress`); } catch { return false; }
    }) || "unknown";
    logger.error("orchestrator", `pipeline failed at stage: ${stage}`, { error: e.message?.slice(0, 200) });
    await updateTask(taskId, userId, { status: "failed", error: String(e.message || e).slice(0, 300) });
    await addTaskEvent(taskId, "pipeline.failed", { stage, error: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

async function enterStage(taskId, stage) {
  await setStage(taskId, stage, "in_progress");
  await updateTask(taskId, null, { current_stage: stage, status: stage });
  await addTaskEvent(taskId, "stage.started", { stage });
}

export { STAGES };
