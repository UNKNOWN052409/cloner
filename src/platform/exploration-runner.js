// Exploration job queueing + registry facade (task 3.3.3 rewiring).
//
// Queue mechanics moved to src/queues/clone-queue.js — the adapter runs the
// in-process bounded queue (running Set + FIFO + MAX_CONCURRENT, extracted
// verbatim, still the default with no REDIS_URL) or the Redis-backed BullMQ
// pipeline (queue "clone-jobs", executed by src/workers/clone-worker.js). The
// three-stage pipeline itself is the shared definition in
// src/queues/pipeline-job.js so both paths execute identical stages.
//
// This module keeps what the API polls (src/platform/server.js): the public
// surface queueExploration / rekeyJob / getExplorationJob / listJobs is
// unchanged, and the job-id → entry registry lives behind the adapter for
// status tracking.
import path from "node:path";
import { getCloneQueue } from "../queues/clone-queue.js";
import { runPipelineJob } from "../queues/pipeline-job.js";

const ROOT = path.join(process.cwd(), "artifacts");

export function queueExploration({ url, username, password, cookies, storage, policy, sessionId = "local", interactionRecords = [] }) {
  const payload = { url, username, password, cookies, storage, policy, sessionId, interactionRecords };
  const queue = getCloneQueue();
  // returns the entry synchronously (status "queued"; with a free slot the job
  // is already "exploring" by the time this returns — same as before the
  // adapter rewiring)
  return queue.enqueue({
    payload,
    run: ({ entry, report }) => runPipelineJob(payload, {
      entry,
      report,
      artifactsRoot: ROOT,
      linkJobId: (tempId, jobId) => queue.linkJobId(tempId, jobId),
    }),
  });
}

export function rekeyJob(tempId, jobId) {
  getCloneQueue().rekey(tempId, jobId);
}

export function getExplorationJob(jobId) {
  const entry = getCloneQueue().getEntry(jobId);
  if (!entry) return null;
  const { jobId: id, url, status, startedAt, finishedAt, manifest, error, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir } = entry;
  return { jobId: id, url, status, startedAt, finishedAt, manifest: manifest || null, error: error || null, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir };
}

export function listJobs() {
  return getCloneQueue().listJobs();
}
