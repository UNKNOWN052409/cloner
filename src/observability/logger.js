// Structured logger for exploration jobs (spec §16): every line carries job,
// session, worker, page, state and correlation ids plus phase timings. Writes
// NDJSON to the job's artifact dir and mirrors to the console.
//
// Log contract (observability realignment): per clone job the pipeline emits
// EXACTLY ONE summary line per stage — logger.stage(stageId, status, numbers),
// scope "stage", enforced once-per-stageId below — plus warnings/errors. All
// chatty per-page/per-step detail goes through debug() and is DROPPED unless
// CLONER_LOG_LEVEL=debug (default threshold info). No credential values ever
// reach a line: msg + data run through redact() before anything is written.
import fs from "node:fs";
import path from "node:path";
import { redact } from "../storage/artifact-store.js";

// severity ranks; "stage" summaries rank as info so they survive the default
// threshold. Unknown levels rank as info (never silently dropped).
const LEVELS = { debug: 10, info: 20, stage: 20, warn: 30, error: 40 };
function levelThreshold() {
  const v = LEVELS[String(process.env.CLONER_LOG_LEVEL || "info").toLowerCase()];
  return v == null ? LEVELS.info : v;
}

// free-text credential scrub: redactText() (artifact-store) covers JWTs and
// URL query params, but an inline `password=…` / `api_key: …` message shape
// passed straight through — the log contract forbids that, so the logger
// scrubs it itself before anything is written or mirrored.
const INLINE_SECRET_RE = /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|credential)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;)"']+)/gi;
function scrubInlineSecrets(text) {
  return text.replace(INLINE_SECRET_RE, "$1=[REDACTED]");
}

export function createLogger({ jobId, artifactsDir, sessionId = "local", workerId = "w1" }) {
  const logDir = path.join(artifactsDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "job.log");
  const t0 = Date.now();
  const metrics = { navigationMs: 0, domExtractionMs: 0, screenshotMs: 0, assetMs: 0, crashes: 0, timeouts: 0, failedInteractions: 0 };
  let pageId = null;
  let stateId = null;
  const threshold = levelThreshold();
  const emittedStages = new Set(); // log contract: exactly ONE summary per stage

  function line(level, scope, msg, data = {}) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return null; // demoted (debug noise)
    const rec = {
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      level,
      jobId,
      sessionId,
      workerId,
      pageId,
      stateId,
      correlationId: `${jobId}:${scope}`,
      scope,
      // every log line is credential-scrubbed before it lands in job.log
      msg: scrubInlineSecrets(redact(String(msg))).slice(0, 300),
      ...(data && typeof data === "object" ? redact(data) : {}),
    };
    try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch {}
    // console mirror: stage summaries + warnings/errors always (that is the
    // whole visible log at the default level); everything else only in debug mode
    const mirror = level === "stage" || level === "warn" || level === "error" || threshold <= LEVELS.debug;
    if (mirror) {
      const line2 = level === "stage"
        ? `  [${(rec.elapsedMs / 1000).toFixed(1)}s][${jobId}] STAGE ${rec.msg}`
        : `  [${(rec.elapsedMs / 1000).toFixed(1)}s][${jobId}] ${level.toUpperCase()} ${scope}: ${rec.msg}`;
      try { console.log(line2); } catch {}
    }
    return rec;
  }

  // THE stage summary line (log contract): `exploration: completed — routes=4
  // pages=4 states=6 …`. Exactly one per stageId — repeat calls are ignored so
  // a crash path + success path can never double-print a stage.
  function stage(stageId, status, numbers = {}) {
    if (emittedStages.has(stageId)) return null;
    emittedStages.add(stageId);
    const nums = Object.entries(numbers || {})
      .filter(([, v]) => v != null && Number.isFinite(Number(v)))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return line("stage", "stage", `${stageId}: ${status}${nums ? " — " + nums : ""}`, { stage: stageId, status, ...(numbers || {}) });
  }

  return {
    debug: (scope, msg, data) => line("debug", scope, msg, data),
    info: (scope, msg, data) => line("info", scope, msg, data),
    warn: (scope, msg, data) => line("warn", scope, msg, data),
    error: (scope, msg, data) => line("error", scope, msg, data),
    stage,
    // duration metrics accumulate across pages (per-page overwrite made the
    // manifest reflect only the last page); counters go through bump()
    metric: (name, value) => { if (name in metrics && Number.isFinite(Number(value))) metrics[name] += Number(value); return metrics; },
    bump: (name, n = 1) => { if (name in metrics) metrics[name] += n; return metrics; },
    metrics: () => ({ ...metrics }),
    setPage: (id) => { pageId = id; },
    setState: (id) => { stateId = id; },
    file,
  };
}
