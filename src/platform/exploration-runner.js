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
import { withJobScope } from "../events.js";
import { requestMonetizeOptIn } from "./ads-optin.js"; // task 4.5.5
import { withSpan, injectTraceparent } from "../observability/trace-context.js"; // task 4.2.10

const ROOT = path.join(process.cwd(), "artifacts");

// 4.0.12 quality gate: the API layer passes the CALLER's identity so the
// registry entry carries its owner ({ userId, orgId }) — every read surface
// gates on it. userId/orgId may be null (anonymous local dashboard, legacy
// posture: personal scope, no org).
export function queueExploration({ url, username, password, cookies, storage, policy, sessionId = "local", interactionRecords = [], monetize, userId = null, orgId = null, instructions = null }) {
  // task 4.5.5: monetize is a PER-TASK OWNER OPT-IN (policy-safe default OFF).
  // Callers may pass it explicitly; otherwise the task-creation request scope
  // captured by ads-optin.js monetizeOptInMiddleware() supplies it. The flag
  // rides the payload, so it also survives the BullMQ worker process hop.
  const optedIn = monetize === true || requestMonetizeOptIn() === true;
  const queue = getCloneQueue();
  // task 4.2.10 tracing: the producer span opens HERE (the API enqueue point)
  // and the job continues the trace on the worker side through
  // payload.traceparent (injected below) → tracedExecutor (clone-worker.js).
  // A null sink (CLONER_TRACING=0) degrades to zero-op spans.
  return withSpan("api.enqueue-clone-task", { "job.url": url || null }, (span) => {
    // instructions ride the payload (audit F fix: server.js has always passed
    // them; this signature previously dropped them, so they never reached the
    // pipeline — reconstruction cloned full scope silently)
    const payload = { url, username, password, cookies, storage, policy, sessionId, interactionRecords, monetize: optedIn, instructions, ...injectTraceparent() };
    // returns the entry synchronously (status "queued"; with a free slot the job
    // is already "exploring" by the time this returns — same as before the
    // adapter rewiring)
    return queue.enqueue({
      payload,
      owner: { userId: userId || null, orgId: orgId || null },
      // 4.0.12 QA fix: tag every bus emission of an IN-PROCESS run with this
      // job's handle. The BullMQ worker path applies withJobScope in the worker
      // process (clone-worker.js); without the same tag here, memory-backend
      // exploration events went out over the WS broadcast with NO task id —
      // fanning out to every authenticated socket (cross-tenant leak, live AND
      // via catchup replay) and depending on the stale v1 currentTaskId global.
      // The registry resolves both the tempId (before linkJobId) and the real
      // jobId (after), so the WS gate can always resolve ownership.
      run: ({ entry, report }) => withJobScope(entry.tempId, () => runPipelineJob(payload, {
        entry,
        report,
        artifactsRoot: ROOT,
        linkJobId: (tempId, jobId) => queue.linkJobId(tempId, jobId),
      })),
    });
  });
}

export function rekeyJob(tempId, jobId) {
  getCloneQueue().rekey(tempId, jobId);
}

export function getExplorationJob(jobId) {
  const entry = getCloneQueue().getEntry(jobId);
  if (!entry) return null;
  // `owner` is access metadata (ws-auth + API gates) — never shipped to clients
  const { jobId: id, url, status, startedAt, finishedAt, manifest, error, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir, owner } = entry;
  return { jobId: id, url, status, startedAt, finishedAt, manifest: manifest || null, error: error || null, credentialsProvided, hasCookies, reconstruction, verification, history, artifactsDir, owner: owner || null };
}

// 4.0.12 quality gate: does `identity` ({ userId, role }) access this job?
// Rules:
//   • platform-admin role → yes (operator visibility, same as the admin surface)
//   • anonymous identity → no (fail closed)
//   • entry has no owner (legacy) → visible to authenticated users only
//     (single-tenant per-process registry, unchanged pre-Phase-4 semantics)
//   • entry owned by org O → yes iff the caller is a CURRENT member of O
//     (membership re-checked live — a removed member loses access immediately)
//   • entry owned by user U → yes iff caller.userId === U
// Never throws — any error denies.
export async function identityCanAccessJob(jobId, identity) {
  try {
    if (!identity?.userId) return false;
    const entry = getCloneQueue().getEntry(jobId);
    if (!entry) return false;
    if (identity.role === "admin") return true;
    const owner = entry.owner;
    if (!owner) return true; // legacy entry — authenticated users, as before
    if (owner.orgId) {
      const { getOrgMember } = await import("../database/tenant-repository.js");
      const member = await getOrgMember(owner.orgId, identity.userId);
      return !!member;
    }
    return owner.userId === identity.userId;
  } catch {
    return false; // fail closed on any lookup failure
  }
}

export function listJobs() {
  return getCloneQueue().listJobs();
}

// 4.0.12 quality gate: the jobs list an identity may see.
//   • legacy/anonymous (no identity) → ownerless entries only: the local
//     dashboard created its jobs anonymously, so exactly those are visible —
//     owned jobs (created with credentials) never leak to anonymous callers
//   • authenticated → own jobs + owned-by-their-org jobs (+ legacy ownerless
//     entries, whose semantics above apply on the detail path)
export async function listJobsFor(identity) {
  const all = listJobs();
  if (!identity?.userId) {
    const out = [];
    for (const j of all) {
      const entry = getCloneQueue().getEntry(j.jobId);
      if (!entry?.owner) out.push(j);
    }
    return out;
  }
  const out = [];
  for (const j of all) {
    if (await identityCanAccessJob(j.jobId, identity)) out.push(j);
  }
  return out;
}
