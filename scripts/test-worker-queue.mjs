#!/usr/bin/env node
// Clone-job queue tests (task 3.3.3) — deterministic, NO Redis required.
//
//   Part A (always runs, zero Redis): the in-process fallback backend — the
//   bounded queue extracted verbatim from src/platform/exploration-runner.js —
//   driven with FAKE pipelines: status sequence (queued → exploring →
//   reconstructing → verifying → completed), immediate-start timing, job
//   registry lookups (temp handle + real id), listJobs shape, MAX_CONCURRENT
//   cap (2, and the MAX_EXPLORATION_JOBS env default), FIFO drain, failed-job
//   eviction (short TTL; temp handle only), rekey semantics, transient-error
//   classification, and that the default adapter picks the memory backend.
//
//   Part B (skip-if-unreachable BullMQ smoke): only when REDIS_URL /
//   CLONER_REDIS_URL is set AND a Redis server answers — enqueue through the
//   bullmq backend, consume with src/workers/clone-worker.js (fake executor),
//   assert job data shape (payload + jobId), cross-process status sync onto the
//   registry, 3-attempt exponential-backoff retry for transient errors, and
//   single-attempt failure for non-transient errors. Unset/unreachable → SKIP
//   lines and exit 0.
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, detail = "") => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (90s)"); process.exit(1); }, 90_000);
watchdog.unref();

const defer = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// ---------------- Part A: memory fallback backend (zero Redis) ----------------
const { createCloneQueue, getCloneQueue, resolveRedisUrl, isTransientError, QUEUE_NAME } =
  await import("../src/queues/clone-queue.js");

console.log(`\n-- Part A: in-process fallback backend (queue=${QUEUE_NAME}) --`);

// A1 — adapter surface + config defaults
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2 });
  await q.ready;
  check("config: no REDIS_URL → memory backend, resolved synchronously", q.backend === "memory");
  check("config: default failed-job TTL is 30 minutes",
    createCloneQueue({ redisUrl: "" }).failedJobTtlMs === 30 * 60 * 1000,
    `got ${createCloneQueue({ redisUrl: "" }).failedJobTtlMs}`);
  check("surface: both backends expose enqueue/onStatus/getJob/listJobs/rekey/close",
    [q.enqueue, q.onStatus, q.getJob, q.listJobs, q.rekey, q.close, q.whenIdle].every((f) => typeof f === "function"));
  check("surface: queue name is clone-jobs", QUEUE_NAME === "clone-jobs");
}

// A2 — happy path: status sequence, registry lookups, listJobs shape
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2 });
  await q.ready;
  const statuses = [];
  q.on("status", (e) => statuses.push(e.status));

  const entry = q.enqueue({
    payload: { url: "http://fixture.local/a", username: "u", password: "p" },
    run: async ({ entry, report }) => {
      entry.status = "exploring"; // as runPipelineJob does at launch
      report("exploring");
      await sleep(15);
      q.linkJobId(entry.tempId, "job-A"); // stage-1 rekey, as runPipelineJob does
      entry.jobId = "job-A";
      entry.status = "reconstructing";
      report("reconstructing");
      await sleep(10);
      entry.status = "verifying";
      report("verifying");
      await sleep(10);
      entry.status = "completed";
      report("completed");
    },
  });

  check("A2: enqueue returns the entry synchronously with a pending- temp handle",
    !!entry?.tempId && entry.tempId.startsWith("pending-") && entry.status === "exploring",
    `tempId=${entry?.tempId} status=${entry?.status}`);
  check("A2: free slot → job starts exploring before enqueue returns (old timing)", entry.status === "exploring");
  check("A2: credentialsProvided derived from the payload", entry.credentialsProvided === true && entry.hasCookies === false);

  await q.whenIdle();

  check("A2: status event sequence queued→exploring→reconstructing→verifying→completed",
    JSON.stringify(statuses) === JSON.stringify(["queued", "exploring", "reconstructing", "verifying", "completed"]),
    statuses.join(" → "));
  check("A2: entry reachable under BOTH the temp handle and the real jobId",
    q.getJob(entry.tempId) === entry && q.getJob("job-A") === entry);
  check("A2: unknown jobId → null", q.getJob("nope") === null);
  const listed = q.listJobs();
  check("A2: listJobs summary shape (jobId/url/status/queuedAt/finishedAt), deduped to one row",
    listed.length === 1 && listed[0].jobId === "job-A" && listed[0].url === "http://fixture.local/a" &&
    listed[0].status === "completed" && typeof listed[0].queuedAt === "string" && listed[0].finishedAt === undefined,
    JSON.stringify(listed[0]));
}

// A3 — 2-concurrent cap + FIFO drain
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2 });
  await q.ready;
  const gates = [defer(), defer(), defer()];
  const started = [];
  const entries = [];
  for (let i = 0; i < 3; i++) {
    entries.push(q.enqueue({
      payload: { url: `http://fixture.local/${i}` },
      run: async ({ entry, report }) => {
        started.push(i);
        entry.status = "exploring";
        report("exploring");
        await gates[i].promise;
        entry.status = "completed";
        report("completed");
      },
    }));
  }
  await sleep(60);
  check("A3: cap 2 — only the first two jobs start, in FIFO order", started.join(",") === "0,1", `started: ${started.join(",")}`);
  check("A3: third job stays queued in the registry", entries[2].status === "queued" && q.getJob(entries[2].tempId)?.status === "queued");
  gates[0].resolve();
  await sleep(60);
  check("A3: freed slot drains the FIFO queue (third job starts)", started.join(",") === "0,1,2" && entries[2].status === "exploring",
    `started: ${started.join(",")} third=${entries[2].status}`);
  gates[1].resolve();
  gates[2].resolve();
  await q.whenIdle();
}

// A4 — MAX_EXPLORATION_JOBS env drives the default cap
{
  const prev = process.env.MAX_EXPLORATION_JOBS;
  process.env.MAX_EXPLORATION_JOBS = "1";
  try {
    const q = createCloneQueue({ redisUrl: "" }); // cap from env
    await q.ready;
    const gate = defer();
    const started = [];
    const runs = [0, 1].map((i) => q.enqueue({
      payload: { url: `http://fixture.local/env${i}` },
      run: async ({ entry, report }) => { started.push(i); entry.status = "exploring"; report("exploring"); await gate.promise; entry.status = "completed"; report("completed"); },
    }));
    await sleep(60);
    check("A4: MAX_EXPLORATION_JOBS=1 caps concurrency at 1", q.maxConcurrent === 1 && started.length === 1, `cap=${q.maxConcurrent} started=${started.length}`);
    check("A4: second job queued", runs[1].status === "queued");
    gate.resolve();
    await q.whenIdle();
  } finally {
    if (prev === undefined) delete process.env.MAX_EXPLORATION_JOBS; else process.env.MAX_EXPLORATION_JOBS = prev;
  }
}

// A5 — failed-job eviction after a short TTL (default 30 min, overridden here)
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2, failedJobTtlMs: 250 });
  await q.ready;

  // scenario 1: failure BEFORE exploration names the job (browser-launch
  // failure — the common case): no alias exists, so the temp handle itself
  // becomes unreachable once the TTL elapses
  const early = q.enqueue({
    payload: { url: "http://fixture.local/boom-early" },
    run: async ({ entry, report }) => {
      entry.status = "exploring";
      report("exploring");
      throw new Error("kaboom");
    },
  });
  await q.whenIdle();
  check("A5: failure marks the entry error with the message + history event",
    early.status === "error" && early.error === "kaboom" && early.history.some((h) => h.event.includes("failed: kaboom")),
    `status=${early.status} error=${early.error}`);
  check("A5: failed job still listed before the TTL elapses", q.getJob(early.tempId)?.status === "error");
  await sleep(450);
  check("A5: temp handle evicted after the TTL", q.getJob(early.tempId) === null);

  // scenario 2: failure AFTER exploration named the job — eviction removes only
  // the tempId registry key; the entry stays reachable under the real jobId
  // (and through the tempId alias, exactly like the old runner)
  const late = q.enqueue({
    payload: { url: "http://fixture.local/boom-late" },
    run: async ({ entry, report }) => {
      entry.status = "exploring";
      report("exploring");
      q.linkJobId(entry.tempId, "job-LATE");
      entry.jobId = "job-LATE";
      throw new Error("reconstruction exploded");
    },
  });
  await q.whenIdle();
  await sleep(450);
  check("A5: eviction removes only the tempId registry key, real jobId survives",
    !q.entries.has(late.tempId) && q.getJob("job-LATE") === late,
    `tempKeyGone=${!q.entries.has(late.tempId)} realIdResolves=${q.getJob("job-LATE") === late}`);
}

// A6 — rekey semantics (tempId key REPLACED by jobId)
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2 });
  await q.ready;
  const entry = q.enqueue({ payload: { url: "http://fixture.local/rekey" }, run: async () => {} });
  await q.whenIdle();
  q.rekey(entry.tempId, "job-REKEY");
  check("A6: rekey replaces the tempId key with the jobId key and updates entry.jobId",
    q.getJob(entry.tempId) === null && q.getJob("job-REKEY") === entry && entry.jobId === "job-REKEY");
}

// A7 — transient-error classification (pure function)
{
  check("A7: ECONNREFUSED is transient",
    isTransientError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" })));
  check("A7: socket hang up is transient", isTransientError(new Error("socket hang up")));
  check("A7: explicit err.transient=true wins", isTransientError(Object.assign(new Error("weird"), { transient: true })));
  check("A7: plain Error is NOT transient", !isTransientError(new Error("bad payload shape")));
  check("A7: null/undefined are not transient", isTransientError(null) === false);
}

// A8 — default wiring: singleton picks memory without env; runner module loads intact
{
  if (!resolveRedisUrl()) {
    check("A8: default adapter (no REDIS_URL env) selects the in-process backend", getCloneQueue().backend === "memory");
  } else {
    skip("A8: default adapter check", "REDIS_URL is set in this environment");
  }
  const runner = await import("../src/platform/exploration-runner.js");
  check("A8: exploration-runner keeps its public API (queueExploration/rekeyJob/getExplorationJob/listJobs)",
    ["queueExploration", "rekeyJob", "getExplorationJob", "listJobs"].every((k) => typeof runner[k] === "function"));
  check("A8: registry lookup on the rewired runner delegates (unknown id → null)", runner.getExplorationJob("no-such-job") === null);
}

// ---------------- Part B: BullMQ smoke path (skip-if-unreachable) ----------------
const redisUrl = resolveRedisUrl();
console.log(`\n-- Part B: BullMQ smoke (redisUrl=${redisUrl || "<unset>"} --`);

if (!redisUrl) {
  skip("B1: bullmq backend selected", "REDIS_URL/CLONER_REDIS_URL not set");
  skip("B2: enqueue → worker pipeline round-trip", "REDIS_URL/CLONER_REDIS_URL not set");
  skip("B3: transient error retried 3x with backoff", "REDIS_URL/CLONER_REDIS_URL not set");
  skip("B4: non-transient error fails on the first attempt", "REDIS_URL/CLONER_REDIS_URL not set");
  console.log("\nRESULT: PASS  (bullmq smoke skipped — no Redis configured)");
  process.exit(results.some((r) => !r) ? 1 : 0);
}

// probe reachability before committing to the smoke path
let reachable = false;
let probeError = "";
try {
  const IORedis = (await import("ioredis")).default;
  const probe = new IORedis(redisUrl, { lazyConnect: true, connectTimeout: 1500, retryStrategy: () => null, enableOfflineQueue: false });
  probe.on("error", () => {}); // swallow pre-connect error events (connect() rejection is the report path)
  await probe.connect();
  await probe.ping();
  await probe.quit();
  reachable = true;
} catch (e) {
  probeError = String(e?.message || e);
}

if (!reachable) {
  skip("B1: bullmq backend selected", `redis unreachable (${probeError})`);
  skip("B2: enqueue → worker pipeline round-trip", `redis unreachable (${probeError})`);
  skip("B3: transient error retried 3x with backoff", `redis unreachable (${probeError})`);
  skip("B4: non-transient error fails on the first attempt", `redis unreachable (${probeError})`);
  console.log("\nRESULT: PASS  (bullmq smoke skipped — redis unreachable)");
  process.exit(results.some((r) => !r) ? 1 : 0);
}

// real smoke — everything below only runs against a reachable Redis
{
  const q = createCloneQueue({ redisUrl, backoffMs: 50, failedJobTtlMs: 60_000 });
  const backend = await q.ready;
  check("B1: reachable Redis → bullmq backend", backend === "bullmq", `backend=${backend}`);

  const statusTrail = { ok: [], transient: [], fatal: [] };
  q.on("status", (e) => {
    const url = e.entry?.url || "";
    if (url.includes("smoke-ok")) statusTrail.ok.push(e.status);
    else if (url.includes("smoke-transient")) statusTrail.transient.push(e.status);
    else if (url.includes("smoke-fatal")) statusTrail.fatal.push(e.status);
  });

  // run closures that must NEVER execute on the bullmq path (tripwire)
  const memTripwire = async () => { throw new Error("memory backend executed a bullmq job"); };
  const okEntry = q.enqueue({ payload: { url: "http://smoke.local/smoke-ok" }, run: memTripwire });
  const transientEntry = q.enqueue({ payload: { url: "http://smoke.local/smoke-transient" }, run: memTripwire });
  const fatalEntry = q.enqueue({ payload: { url: "http://smoke.local/smoke-fatal" }, run: memTripwire });
  check("B2: enqueue is synchronous even on the bullmq backend",
    okEntry.status === "queued" && transientEntry.status === "queued" && fatalEntry.status === "queued");

  const executions = { ok: 0, transient: 0, fatal: 0 };
  const jobDataSeen = {};
  const { startCloneWorker } = await import("../src/workers/clone-worker.js");
  const { worker, close } = startCloneWorker({
    redisUrl,
    concurrency: 2,
    registerSignals: false, // test process manages its own lifecycle
    executor: async (payload, { jobId, job, report }) => {
      const tag = payload.url.includes("smoke-ok") ? "ok" : payload.url.includes("smoke-transient") ? "transient" : "fatal";
      executions[tag]++;
      jobDataSeen[tag] = { dataJobId: job.data?.jobId, dataPayloadUrl: job.data?.payload?.url, jobId };
      if (tag === "ok") {
        report("exploring");
        await sleep(30);
        report("reconstructing");
        await sleep(10);
        report("verifying");
        await sleep(10);
        return {
          jobId, status: "completed", passed: true, artifactsDir: "artifacts/smoke-ok",
          manifest: { status: "completed", coverage: 1, pages: 3 },
          reconstruction: { passed: true, pages: 3, repairs: 0 },
          verification: { passed: true, stages: [{ stage: "functional", passed: true }] },
        };
      }
      if (tag === "transient") throw new Error("connect ECONNRESET smoke");
      throw new Error("fatal: malformed payload");
    },
  });

  // wait for all three jobs to settle (10s cap)
  const deadline = Date.now() + 10_000;
  const settled = () =>
    ["completed", "completed_with_limitations", "error"].includes(okEntry.status) &&
    transientEntry.status === "error" && fatalEntry.status === "error";
  while (Date.now() < deadline && !settled()) await sleep(100);

  check("B2: bullmq job data = payload + jobId (seen by the worker)",
    jobDataSeen.ok?.dataPayloadUrl === "http://smoke.local/smoke-ok" && jobDataSeen.ok?.dataJobId === okEntry.jobId && jobDataSeen.ok?.jobId === okEntry.jobId,
    JSON.stringify(jobDataSeen.ok || null));
  check("B2: ok job reached completed via the worker (tripwire run never fired)",
    okEntry.status === "completed" && executions.ok === 1, `status=${okEntry.status} executions=${executions.ok}`);
  check("B2: worker return value merged into the registry entry (reconstruction/verification/artifactsDir)",
    okEntry.artifactsDir === "artifacts/smoke-ok" && okEntry.reconstruction?.passed === true && okEntry.verification?.passed === true,
    `artifactsDir=${okEntry.artifactsDir} recon=${JSON.stringify(okEntry.reconstruction)}`);
  check("B2: progress reports synced the status trail across processes",
    ["exploring", "reconstructing", "verifying", "completed"].every((s) => statusTrail.ok.includes(s)),
    statusTrail.ok.join(" → "));
  check("B3: transient error retried exactly 3 attempts then marked error",
    executions.transient === 3 && transientEntry.status === "error" && /ECONNRESET/.test(transientEntry.error || ""),
    `executions=${executions.transient} status=${transientEntry.status} error=${transientEntry.error}`);
  check("B4: non-transient error fails on the FIRST attempt (no retries burned)",
    executions.fatal === 1 && fatalEntry.status === "error" && /fatal: malformed payload/.test(fatalEntry.error || ""),
    `executions=${executions.fatal} status=${fatalEntry.status} error=${fatalEntry.error}`);

  await close();
  await q.close();
}

const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
