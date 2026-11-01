// Per-task diagnostic timeline (task 4.0.7 — Operational Monitoring).
//
// One payload per task id that merges:
//   • lifecycle history  — tasks.js history (legacy t* tasks) or the queue
//     entry history (exploration v2 jobs), ordered by time
//   • bus events         — recent event-bus records tagged with this job id
//     (the ring buffer is capped at 500, so this is bounded by design)
//   • artifacts          — files found in the task/artifact directory with
//     sizes, NO file contents
//
// STACK-TRACE RESTRICTION: the raw `error` field is sanitized here — only
// message text is carried (first line, 300 chars). Stack traces never leave
// the process boundary.
import fs from "node:fs";
import path from "node:path";
import { bus } from "../events.js";

const ARTIFACTS_ROOT = path.join(process.cwd(), "artifacts");
const TASKS_ROOT = path.join(process.cwd(), "platform-data");

// artifact names whitelisted for listing; anything else in the dir is ignored
const ALLOWED_ARTIFACTS = new Set([
  "manifest.json", "exploration.md", "exploration.json", "screenshot.png",
  "index.html", "clone.html", "design-tokens.json", "cloner-runtime.js",
  "clone.json", "snapshot.mhtml", "chat-fixes.css", "interaction-records.json",
  "verify.json", "verification.json", "components.json", "assets",
]);

function sanitizeError(err) {
  if (!err) return null;
  const msg = String(typeof err === "string" ? err : err.message ?? err);
  return { message: msg.split("\n")[0].slice(0, 300) }; // first line only, no stack
}

function listArtifacts(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => ALLOWED_ARTIFACTS.has(d.name))
      .map((d) => {
        const full = path.join(dir, d.name);
        const size = d.isDirectory() ? null : fs.statSync(full).size;
        return { name: d.name, type: d.isDirectory() ? "dir" : "file", size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// merge lifecycle history entries + bus events into one time-ordered timeline
function buildTimeline(history = [], events = []) {
  const items = [];
  for (const h of history) {
    if (h && (h.at || h.t)) items.push({ at: h.at || new Date(h.t).toISOString(), kind: "lifecycle", event: String(h.event || "").slice(0, 200) });
  }
  for (const e of events) {
    if (!e) continue;
    items.push({
      at: new Date(e.t || Date.now()).toISOString(),
      kind: "bus",
      type: String(e.type || "").slice(0, 60),
      msg: String(e?.data?.msg || e?.data?.status || e?.data?.error || "").slice(0, 200),
    });
  }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return items;
}

// bus events tagged with this job id (AsyncLocalStorage scope) or carrying the
// id in the payload — bounded by the ring buffer (cap 500)
function busEventsFor(taskId, cap = 200) {
  const out = [];
  try {
    for (const e of bus.catchUp().events || []) {
      if (e.job === taskId || e?.data?.job === taskId || e?.data?.task === taskId) out.push(e);
      if (out.length >= cap) break;
    }
  } catch {}
  return out;
}

// synchronous base payload: legacy task metadata + artifact listing
function basePayload(taskId) {
  // ---- legacy task (tasks.js) ----
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(TASKS_ROOT, taskId, "task.json"), "utf8")); } catch {}
  const artifactsDir = meta ? path.join(TASKS_ROOT, taskId, "out") : path.join(ARTIFACTS_ROOT, taskId);
  const artifacts = listArtifacts(artifactsDir);

  return {
    taskId,
    kind: meta ? "legacy" : "exploration",
    status: meta?.status ?? null,
    url: meta?.url ?? null, // never credentials — createTask does not persist them
    createdAt: meta?.createdAt ?? null,
    error: sanitizeError(meta?.error ?? null),
    history: meta?.history ?? [], // legacy lifecycle entries — merged into the timeline
    artifacts,
  };
}

// Promise-cached import of the exploration runner (queue entries carry v2
// history without touching the filesystem)
let explorationModPromise = null;

async function getExplorationModule() {
  if (!explorationModPromise) explorationModPromise = import("./exploration-runner.js");
  return explorationModPromise;
}

// The single entrypoint: build the full diagnostic payload for one task id.
// Works for BOTH task kinds:
//   • legacy platform tasks (platform-data/<id>/task.json)
//   • exploration v2 jobs (artifacts/<id>/ + the queue entry)
export async function getJobDiagnostics(taskId) {
  if (!taskId || typeof taskId !== "string" || taskId.length > 128) return null;
  const payload = basePayload(taskId);

  // queue-entry history for v2 jobs (best-effort — module may be unavailable
  // in isolated unit tests; the payload stays valid without it)
  let jobHistory = payload.history || [];
  try {
    const exploration = await getExplorationModule();
    const job = exploration.getExplorationJob?.(taskId);
    if (job) {
      jobHistory = job.history || [];
      payload.kind = payload.kind === "legacy" ? "legacy" : "exploration";
      payload.status = payload.status ?? job.status;
      payload.url = payload.url ?? job.url;
      payload.error = payload.error ?? sanitizeError(job.error);
    }
  } catch {}

  return { ...payload, timeline: buildTimeline(jobHistory, busEventsFor(taskId)) };
}

// list every task id known to the platform (legacy tasks + live exploration
// entries) — bounded for the diagnostics index
export async function listDiagnosticTaskIds(limit = 100) {
  const ids = new Set();
  try {
    for (const d of fs.readdirSync(TASKS_ROOT)) {
      if (fs.existsSync(path.join(TASKS_ROOT, d, "task.json"))) ids.add(d);
    }
  } catch {}
  try {
    const exploration = await getExplorationModule();
    for (const j of exploration.listJobs?.() || []) ids.add(j.jobId);
  } catch {}
  return [...ids].slice(0, Math.max(1, limit));
}
