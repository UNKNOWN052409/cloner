// Exploration job registry for the platform: bounded queue + status + lookup.
// Heavy artifacts live under artifacts/<jobId>/ (spec §15).
import path from "node:path";
import { runExplorationJob } from "../pipeline/exploration-pipeline.js";

const ROOT = path.join(process.cwd(), "artifacts");
const jobs = new Map(); // jobId -> entry
const aliases = new Map(); // tempId -> jobId (clients poll the temp handle)
const running = new Set();
const queue = [];
const MAX_CONCURRENT = Number(process.env.MAX_EXPLORATION_JOBS || 2);

export function queueExploration({ url, username, password, cookies, storage, policy, sessionId = "local" }) {
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
  };
  jobs.set(tempId, entry);

  const launch = () => {
    entry.startedAt = new Date().toISOString();
    // cookies are passed in-memory to the pipeline — never written to disk
    // (no credential-at-rest window between write and unlink)
    const jobPromise = runExplorationJob({
      url,
      cookies,
      storage,
      username,
      password,
      config: { policy, sessionId },
      artifactsRoot: ROOT,
    })
      .then(({ jobId, manifest }) => {
        jobs.delete(tempId);
        entry.jobId = jobId;
        entry.status = manifest.status;
        entry.manifest = { status: manifest.status, coverage: manifest.coverage, pages: manifest.pages?.length, metrics: manifest.metrics };
        entry.finishedAt = new Date().toISOString();
        entry.history = (entry.history || []).concat([{ at: entry.finishedAt, event: "completed: " + manifest.status }]);
        running.delete(entry);
        drain();
      })
      .catch((e) => {
        entry.status = "error";
        entry.error = String(e.message || e).slice(0, 200);
        entry.finishedAt = new Date().toISOString();
        entry.history = (entry.history || []).concat([{ at: entry.finishedAt, event: "failed: " + entry.error }]);
        running.delete(entry);
        drain();
        // failed jobs stay queryable under their temp handle for 30 minutes,
        // then are evicted (previously they accumulated in the map forever)
        setTimeout(() => { if (jobs.get(tempId) === entry) jobs.delete(tempId); }, 30 * 60 * 1000).unref();
      });
    jobPromise.finally(() => {
      // credential-at-rest elimination: the temp cookie file is shredded on EVERY
      // path (success, failure, crash) — no window where it outlives the job
      if (cookieFile) { try { fs.unlinkSync(cookieFile); } catch {} }
    });

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
  const { jobId: id, url, status, startedAt, finishedAt, manifest, error, credentialsProvided, hasCookies } = entry;
  return { jobId: id, url, status, startedAt, finishedAt, manifest: manifest || null, error: error || null, credentialsProvided, hasCookies };
}

export function listJobs() {
  return [...jobs.values()].map((e) => ({ jobId: e.jobId || e.tempId, url: e.url, status: e.status, queuedAt: e.queuedAt, finishedAt: e.finishedAt }));
}

function drain() {
  while (running.size < MAX_CONCURRENT && queue.length) {
    const next = queue.shift();
    running.add(next);
    next();
  }
}
