// Exploration job registry + full pipeline runner: exploration → reconstruction
// → verification. Bounded queue + status + lookup. Heavy artifacts live under
// artifacts/<jobId>/ (spec §15).
import fs from "node:fs";
import path from "node:path";
import { runExplorationJob } from "../pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "./verify.js";

const ROOT = path.join(process.cwd(), "artifacts");
const jobs = new Map(); // jobId -> entry
const aliases = new Map(); // tempId -> jobId (clients poll the temp handle)
const running = new Set();
const queue = [];
const MAX_CONCURRENT = Number(process.env.MAX_EXPLORATION_JOBS || 2);

export function queueExploration({ url, username, password, cookies, storage, policy, sessionId = "local", interactionRecords = [] }) {
  const tempId = "pending-" + Date.now().toString(36);
  const entry = {
    tempId,
    jobId: null,
    url,
    status: "queued",
    queuedAt: new Date().toISOString(),
    sessionId,
    credentialsProvided: !!(username && password),
    hasCookies: !!cookies,
    history: [],
  };
  jobs.set(tempId, entry);

  const launch = async () => {
    entry.startedAt = new Date().toISOString();
    entry.status = "exploring";
    try {
      // ---- Stage 1: exploration ----
      const { jobId, artifactsDir, manifest } = await runExplorationJob({
        url, cookies, storage, username, password,
        config: { policy, sessionId },
        artifactsRoot: ROOT,
      });
      entry.jobId = jobId;
      entry.artifactsDir = artifactsDir;
      // the client still holds the temp handle — make BOTH ids resolve to this
      // entry (aliases for tempId lookups, jobs for direct jobId lookups)
      aliases.set(tempId, jobId);
      jobs.set(jobId, entry);
      entry.status = manifest.status;
      entry.manifest = { status: manifest.status, coverage: manifest.coverage, pages: manifest.pages?.length, metrics: manifest.metrics };
      entry.history.push({ at: new Date().toISOString(), event: "exploration completed: " + manifest.status });

      // ---- Stage 2: reconstruction ----
      entry.status = "reconstructing";
      const reconstruction = await reconstructFromArtifacts(artifactsDir, {
        outDir: artifactsDir + "-project",
        interactionRecords,
      });
      entry.reconstruction = { passed: reconstruction.report.passed, pages: reconstruction.report.generatedFiles, repairs: reconstruction.report.repairs?.length || 0 };
      entry.history.push({ at: new Date().toISOString(), event: "reconstruction: " + (reconstruction.report.passed ? "passed" : "completed with limitations") });

      // ---- Stage 3: verification ----
      entry.status = "verifying";
      const verification = await verifyTask(artifactsDir);
      entry.verification = { passed: verification.passed, stages: verification.stages?.map((s) => ({ stage: s.stage, passed: s.passed })) };
      entry.status = verification.passed ? "completed" : "completed_with_limitations";
      entry.history.push({ at: new Date().toISOString(), event: "verification " + (verification.passed ? "PASSED" : "completed with failures") });

    } catch (e) {
      entry.status = "error";
      entry.error = String(e.message || e).slice(0, 300);
      entry.history.push({ at: new Date().toISOString(), event: "failed: " + entry.error });
      running.delete(entry);
      drain();
      setTimeout(() => { if (jobs.get(tempId) === entry) jobs.delete(tempId); }, 30 * 60 * 1000).unref();
      return;
    }
    running.delete(entry);
    drain();
  };

  if (running.size < MAX_CONCURRENT) { running.add(entry); launch(); }
  else queue.push(launch);

  return entry;
}

export function rekeyJob(tempId, jobId) {
  const entry = jobs.get(tempId);
  if (entry) { jobs.delete(tempId); entry.jobId = jobId; jobs.set(jobId, entry); }
}

export function getExplorationJob(jobId) {
  const resolved = aliases.get(jobId) || jobId;
  const entry = jobs.get(resolved);
  if (!entry) return null;
  const { jobId: id, url, status, startedAt, finishedAt, manifest, error, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir } = entry;
  return { jobId: id, url, status, startedAt, finishedAt, manifest: manifest || null, error: error || null, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir };
}

export function listJobs() {
  const seen = new Set();
  const out = [];
  for (const e of jobs.values()) {
    if (seen.has(e)) continue; // same entry keyed under tempId + jobId
    seen.add(e);
    out.push({ jobId: e.jobId || e.tempId, url: e.url, status: e.status, queuedAt: e.queuedAt, finishedAt: e.finishedAt });
  }
  return out;
}

function drain() {
  while (running.size < MAX_CONCURRENT && queue.length) {
    const next = queue.shift();
    running.add(next);
    next();
  }
}
