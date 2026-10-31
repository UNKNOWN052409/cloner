// Structured logger for exploration jobs (spec §16): every line carries job,
// session, worker, page, state and correlation ids plus phase timings. Writes
// NDJSON to the job's artifact dir and mirrors to the console.
import fs from "node:fs";
import path from "node:path";
import { redact } from "../storage/artifact-store.js";

export function createLogger({ jobId, artifactsDir, sessionId = "local", workerId = "w1" }) {
  const logDir = path.join(artifactsDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "job.log");
  const t0 = Date.now();
  const metrics = { navigationMs: 0, domExtractionMs: 0, screenshotMs: 0, assetMs: 0, crashes: 0, timeouts: 0, failedInteractions: 0 };
  let pageId = null;
  let stateId = null;

  function line(level, scope, msg, data = {}) {
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
      msg: redact(String(msg)).slice(0, 300),
      ...(data && typeof data === "object" ? redact(data) : {}),
    };
    try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch {}
    if (level === "error" || level === "warn") {
      const line2 = `  [${(rec.elapsedMs / 1000).toFixed(1)}s][${jobId}] ${level.toUpperCase()} ${scope}: ${rec.msg}`;
      try { console.log(line2); } catch {}
    }
    return rec;
  }

  return {
    info: (scope, msg, data) => line("info", scope, msg, data),
    warn: (scope, msg, data) => line("warn", scope, msg, data),
    error: (scope, msg, data) => line("error", scope, msg, data),
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
