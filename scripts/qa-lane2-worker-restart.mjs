#!/usr/bin/env node
// LANE 2 (4.0.12) probe — (b) worker restart recovers a queued job, with a STUB
// job pushed through the REAL queue adapter (src/queues/clone-queue.js) on the
// compose Redis:
//   phase 1  adapter (bullmq backend) enqueues two stub jobs with NO worker
//            running — the "worker down" state: both must stay queued
//   phase 2  a worker starts (startCloneWorker, REAL BullMQ worker + REAL
//            processor plumbing, stub executor) — both queued jobs execute and
//            the results map back onto the registry entries via QueueEvents
//   phase 3  RESTART: worker stops → two more jobs are enqueued while NO worker
//            runs → a fresh worker starts → both are recovered and complete
// Uses the REAL default queue name ("clone-jobs"); every job runs the stub
// executor, so nothing external is contacted. SKIPs loudly when the compose
// redis is unreachable (same convention as test-worker-infra Part C).
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REDIS = process.env.QA_LANE2_REDIS || "redis://127.0.0.1:6379";
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const waitFor = async (fn, ms = 20000, step = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return await fn();
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

// ---- redis reachability (loud SKIP per repo convention) ----
let IORedis;
try { IORedis = (await import("ioredis")).default; } catch { IORedis = null; }
let probe = null;
try {
  probe = new IORedis(REDIS, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  await probe.connect();
  await probe.ping();
} catch (e) {
  console.log("=".repeat(78));
  console.log(`SKIP  worker-restart — compose redis unreachable at ${REDIS} (${String(e?.message || e).slice(0, 120)})`);
  console.log("SKIP  start it with: docker compose up -d redis");
  console.log("=".repeat(78));
  process.exit(0);
}
try { probe.disconnect(); } catch {}

const { createCloneQueue } = await import("../src/queues/clone-queue.js");
const { startCloneWorker } = await import("../src/workers/clone-worker.js");

const q = createCloneQueue({ redisUrl: REDIS });
await q.ready;
check("setup: adapter selected the bullmq backend on compose redis", q.backend === "bullmq", `backend=${q.backend}`);

// stub executor — the pipeline stand-in: reports, yields, returns the shaped
// summary the QueueEvents "completed" handler maps onto the registry entry
const executor = async (payload, { jobId, report }) => {
  report("exploring");
  await sleep(50);
  return { status: "completed", passed: true, artifactsDir: `artifacts/qa-lane2-${jobId}`, url: payload?.url };
};
const started = [];
async function startWorker(id) {
  const w = startCloneWorker({ redisUrl: REDIS, executor, registerSignals: false, registerHealth: false, workerId: id });
  started.push(w);
  return w;
}
async function stopAll() {
  for (const w of started.splice(0)) { try { await w.close(); } catch {} }
}

try {
  // ---- phase 1: jobs queued while NO worker runs ---------------------------
  const jobs = [];
  for (let i = 1; i <= 2; i++) {
    const e = q.enqueue({ payload: { url: `https://stub.invalid/qa-lane2-${crypto.randomBytes(3).toString("hex")}` }, jobId: `qa-lane2-noWorker-${Date.now().toString(36)}-${i}` });
    jobs.push(e);
  }
  check("setup: two stub jobs enqueued through the adapter (bullmq mode)", jobs.every((e) => !!e.jobId), jobs.map((j) => j.jobId).join(","));
  await sleep(1000); // no worker → nothing may execute
  check("(b) queued job WAITS while no worker is running (worker-down state)",
    jobs.every((e) => e.status === "queued"), jobs.map((j) => `${j.jobId}=${j.status}`).join(","));

  // ---- phase 2: worker starts → queued jobs execute ------------------------
  const w1 = await startWorker("qa-lane2-w1");
  const phase2 = await Promise.all(jobs.map((e) => waitFor(() => e.status === "completed")));
  check("(b) worker start EXECUTES the queued jobs and maps results onto the registry",
    phase2.every(Boolean), jobs.map((j) => `${j.jobId}=${j.status}`).join(","));

  // ---- phase 3: RESTART — worker stops, jobs queue up, fresh worker recovers
  await w1.close(); // graceful stop: stops accepting, drains (nothing active)
  const stamp = Date.now().toString(36);
  const afterStop = [];
  for (let i = 1; i <= 2; i++) {
    const e = q.enqueue({ payload: { url: `https://stub.invalid/qa-lane2-post-${i}` }, jobId: `qa-lane2-restart-${stamp}-${i}` });
    afterStop.push(e);
  }
  await sleep(800); // no worker alive → the new jobs must wait
  check("(b) jobs enqueued after the worker STOPPED stay queued", afterStop.every((e) => e.status === "queued"),
    afterStop.map((j) => `${j.jobId}=${j.status}`).join(","));
  const w2 = await startWorker("qa-lane2-w2"); // the RESTARTED worker
  const phase3 = await Promise.all(afterStop.map((e) => waitFor(() => e.status === "completed")));
  check("(b) RESTARTED worker recovers the queued jobs (all complete)", phase3.every(Boolean),
    afterStop.map((j) => `${j.jobId}=${j.status}`).join(","));

  // queue depth via a temporary Queue (Worker exposes no getJobCounts)
  const { Queue } = await import("bullmq");
  const IORedisMod = (await import("ioredis")).default;
  const countConn = new IORedisMod(REDIS, { maxRetriesPerRequest: null });
  const qCount = new Queue("clone-jobs", { connection: countConn });
  let counts = null;
  try { counts = await qCount.getJobCounts(); } finally {
    try { await qCount.close(); } catch {}
    try { countConn.quit(); } catch {}
  }
  check("(b) queue drained after recovery (no stranded waiting jobs)", (counts?.waiting ?? 0) === 0 && (counts?.active ?? 0) === 0, JSON.stringify(counts));
} finally {
  await stopAll();
  try { await q.close(); } catch {}
}

const failed = results.filter((r) => !r).length;
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"}  (${results.length - failed}/${results.length} checks passed)`);
process.exit(failed === 0 ? 0 : 1);
