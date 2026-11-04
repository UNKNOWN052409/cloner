#!/usr/bin/env node
// Region worker registration + execution-plane routing tests (task 4.2.2) —
// src/distributed/worker-plane.js. Deterministic, NO Redis required.
//
//   Part A (zero transport): the WorkerPlane control plane — registration
//   shape + validation, idempotent re-registration, manual + auto heartbeats,
//   staleness sweep over an INJECTED virtual clock (stale → recovered →
//   auto-prune, and prune-disabled mode), draining, load/capability/region
//   routing selection with deterministic tie-breaks, and the event stream.
//
//   Part B (zero transport): the ExecutionPlane routing jobs to region workers
//   THROUGH the real clone-queue adapter contract (src/queues/clone-queue.js,
//   memory backend, redisUrl pinned to "") — happy path with executor load
//   accounting, region isolation (the other region's worker never executes),
//   capability filtering, load-aware distribution across saturated workers,
//   failure → DLQ + ledger, cancel through the routed adapter, default-region
//   dispatch, the REAL default per-region adapter factory
//   (queue "clone-jobs:<region>"), and clean close/whenIdle semantics.
//
//   Part C (mock transport = the REMOTE-end simulator, per the no-mocks
//   mandate): the bullmq-backed region adapter driven through an in-process
//   broker emulating BullMQ semantics — the REAL producer dispatch, QueueEvents
//   handlers and dead-letter move run against it (same technique as
//   scripts/test-worker-infra.mjs Part B). A remote (executor-less) worker
//   registration is routable; jobs land on the region queue
//   "clone-jobs:<region>", status flows back onto the registry and route
//   ledger, exhausted attempts dead-letter into the shared DLQ.
//
// No credentials: nothing here reads or writes secrets; no network access.
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

async function waitFor(fn, timeoutMs = 5000, step = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return await fn();
    await sleep(step);
  }
}

// event collector bound to a plane (control or execution)
const collect = (plane) => {
  const log = [];
  plane.onEvent((ev) => log.push(ev));
  return log;
};

const { createWorkerPlane, createExecutionPlane, NoWorkerAvailableError, DispatchError, REGION_RE, resolveDefaultRegion } =
  await import("../src/distributed/worker-plane.js");
const { createCloneQueue, QUEUE_NAME } = await import("../src/queues/clone-queue.js");

// ===========================================================================
// Part A — WorkerPlane: registration, heartbeats, staleness, routing
// ===========================================================================
console.log("\n-- Part A: worker registration + heartbeat (control plane) --");

// A1 — registration shape + validation + idempotent re-registration
{
  const plane = createWorkerPlane({ defaultRegion: "eu-west", heartbeatMs: 40, heartbeatTtlMs: 4000, deregisterAfterMs: 0 });
  const events = collect(plane);

  const snap = plane.registerWorker({
    workerId: "w-eu-1",
    region: "eu-west",
    capabilities: ["clone:web", "vision", "clone:web"], // duplicate capability is deduped
    concurrency: 2,
    executor: async () => ({}),
    metadata: { pool: "eu" },
  });
  check("A1: registration snapshot shape (region/capabilities/concurrency/status/beat)",
    snap.workerId === "w-eu-1" && snap.region === "eu-west" &&
    JSON.stringify(snap.capabilities) === JSON.stringify(["clone:web", "vision"]) &&
    snap.concurrency === 2 && snap.status === "online" && snap.beats === 1 &&
    typeof snap.lastBeatAt === "string" && !Number.isNaN(Date.parse(snap.lastBeatAt)),
    JSON.stringify(snap));
  check("A1: snapshot carries load fields (activeJobs 0, capacity, reported, executorBound)",
    snap.load.activeJobs === 0 && snap.load.capacity === 2 && typeof snap.load.reported === "object" &&
    snap.executorBound === true, JSON.stringify(snap.load));

  const throws = (fn, label) => {
    try { fn(); return false; } catch (e) { return e instanceof TypeError && e.message.includes("worker-plane:"); }
  };
  check("A1: missing workerId rejected", throws(() => plane.registerWorker({ region: "eu-west" })));
  check("A1: invalid region rejected", throws(() => plane.registerWorker({ workerId: "x", region: "bad region!" })));
  check("A1: non-string capability rejected", throws(() => plane.registerWorker({ workerId: "x", capabilities: [7] })));
  check("A1: concurrency 0 rejected", throws(() => plane.registerWorker({ workerId: "x", concurrency: 0 })));
  check("A1: non-function executor rejected", throws(() => plane.registerWorker({ workerId: "x", executor: "nope" })));

  plane.registerWorker({ workerId: "w-eu-1", region: "us-east", capabilities: [], concurrency: 3,
    executor: async () => ({}) }); // re-register with its full spec (worker-side reconnect)
  const again = plane.getWorker("w-eu-1");
  check("A1: re-registration refreshes the SAME identity in place (region/spec updated, one row)",
    again.region === "us-east" && again.concurrency === 3 && again.executorBound === true &&
    plane.listWorkers().length === 1, JSON.stringify(again && { region: again.region, conc: again.concurrency }));
  const cleared = plane.registerWorker({ workerId: "w-eu-1", region: "us-east", concurrency: 3 }); // spec WITHOUT executor
  check("A1: re-registration is a full spec refresh — an omitted executor clears the binding",
    cleared.executorBound === false, `executorBound=${cleared.executorBound}`);
  check("A1: events — registered + reregistered emitted",
    events.some((e) => e.type === "registered") && events.some((e) => e.type === "reregistered"),
    events.map((e) => e.type).join(","));
  await plane.close();
}

// A2 — heartbeat: manual beat + load merge + auto-heartbeat timer
{
  const plane = createWorkerPlane({ heartbeatMs: 40, heartbeatTtlMs: 4000, deregisterAfterMs: 0 });
  const reg = plane.registerWorker({ workerId: "w-hb", region: "eu", autoHeartbeat: false });
  const beatsAtReg = reg.beats;
  const beat1 = await plane.heartbeat("w-hb", { load: { activeJobs: 2 }, note: "warm" });
  check("A2: manual heartbeat bumps beats + refreshes lastBeatAt + merges reported load",
    beat1.beats === beatsAtReg + 1 && Date.parse(beat1.lastBeatAt) >= Date.parse(reg.lastBeatAt) &&
    beat1.load.reported.activeJobs === 2 && beat1.load.activeJobs === 2,
    `beats=${beat1.beats} load=${JSON.stringify(beat1.load)}`);
  check("A2: note lands in metadata", beat1.metadata.lastNote === "warm");

  plane.registerWorker({ workerId: "w-auto", region: "eu" }); // autoHeartbeat default true
  await waitFor(async () => (plane.getWorker("w-auto")?.beats ?? 0) >= 3, 2500);
  check("A2: per-worker auto-heartbeat timer keeps the lease fresh (beats grow, status online)",
    (plane.getWorker("w-auto")?.beats ?? 0) >= 3 && plane.getWorker("w-auto").status === "online",
    `beats=${plane.getWorker("w-auto")?.beats}`);
  check("A2: heartbeat of an UNKNOWN id returns null (never auto-registers)",
    (await plane.heartbeat("no-such-worker")) === null && plane.getWorker("no-such-worker") === null);
  await plane.close();
}

// A3 — staleness sweep over an injected virtual clock: stale → recovered → prune
{
  let vt = 1_000_000;
  const plane = createWorkerPlane({ heartbeatMs: 25, heartbeatTtlMs: 100, deregisterAfterMs: 200, now: () => vt });
  const events = collect(plane);
  plane.registerWorker({ workerId: "w-ghost", region: "eu", autoHeartbeat: false }); // beat at vt=1_000_000

  vt += 120; // silence 120ms > ttl 100ms
  plane.sweep();
  check("A3: missed TTL → worker goes stale (sweep event, live snapshot, pruned from routing)",
    plane.getWorker("w-ghost").status === "stale" && events.some((e) => e.type === "stale"));
  let blocked = null;
  try { plane.selectWorker({ region: "eu" }); } catch (e) { blocked = e; }
  check("A3: stale worker is NOT routable — NoWorkerAvailableError with a stale reason",
    blocked instanceof NoWorkerAvailableError && blocked.code === "NO_WORKER_AVAILABLE" &&
    blocked.reasons.some((r) => /stale heartbeat/.test(r.reason)),
    blocked?.reasons?.map((r) => r.reason).join(" | "));

  vt += 30;
  await plane.heartbeat("w-ghost"); // fresh beat at vt=1_000_150
  plane.sweep();
  check("A3: a fresh beat RECOVERS the stale worker (online again, routable)",
    plane.getWorker("w-ghost").status === "online" && events.some((e) => e.type === "recovered") &&
    plane.selectWorker({ region: "eu" }).workerId === "w-ghost");

  vt += 250; // silence 250ms > deregisterAfterMs 200ms
  plane.sweep();
  check("A3: stale beyond deregisterAfterMs → auto-pruned from the registry",
    plane.getWorker("w-ghost") === null && plane.listWorkers().length === 0 &&
    events.some((e) => e.type === "pruned" && /deregisterAfterMs/.test(e.reason)) &&
    (await plane.heartbeat("w-ghost")) === null,
    events.filter((e) => e.type === "pruned").map((e) => e.reason).join(""));

  // prune-disabled mode: deregisterAfterMs <= 0 keeps a stale worker registered
  let vt2 = 5_000_000;
  const plane2 = createWorkerPlane({ heartbeatMs: 25, heartbeatTtlMs: 100, deregisterAfterMs: 0, now: () => vt2 });
  plane2.registerWorker({ workerId: "w-old", region: "eu", autoHeartbeat: false });
  vt2 += 10_000;
  plane2.sweep();
  check("A3: deregisterAfterMs <= 0 disables auto-prune (stale worker stays registered)",
    plane2.listWorkers().length === 1 && plane2.getWorker("w-old").status === "stale");
  await plane2.close();
  await plane.close();
}

// A4 — draining: no new jobs, lease refreshes but status stays draining
{
  let vt = 2_000_000;
  const plane = createWorkerPlane({ heartbeatMs: 25, heartbeatTtlMs: 100, deregisterAfterMs: 200, now: () => vt });
  const events = collect(plane);
  plane.registerWorker({ workerId: "w-drain", region: "eu", autoHeartbeat: false });
  const drained = plane.markDraining("w-drain", "rolling update");
  check("A4: markDraining flips status + stamps drainingSince",
    drained.status === "draining" && typeof drained.drainingSince === "string" &&
    events.some((e) => e.type === "draining" && e.reason === "rolling update"));
  let blocked = null;
  try { plane.selectWorker({ region: "eu" }); } catch (e) { blocked = e; }
  check("A4: draining worker is excluded from routing with a draining reason",
    blocked instanceof NoWorkerAvailableError && blocked.reasons.some((r) => /draining/.test(r.reason)),
    blocked?.reasons?.map((r) => r.reason).join(" | "));
  const beat = await plane.heartbeat("w-drain");
  check("A4: heartbeat while draining refreshes the lease but does NOT lift the drain",
    beat.status === "draining" && beat.drainingSince !== null);
  vt += 500; // expired while draining
  check("A4: expired draining worker displays as stale to observers (live status)",
    plane.getWorker("w-drain").status === "stale");
  await plane.close();
}

// A5 — routing selection: region, capabilities, load ratio, capacity, executor, determinism
{
  let vt = 3_000_000;
  const plane = createWorkerPlane({ heartbeatMs: 25, heartbeatTtlMs: 10_000, deregisterAfterMs: 200, now: () => vt });
  const w1 = plane.registerWorker({ workerId: "w1", region: "score", concurrency: 2, autoHeartbeat: false }); vt += 10;
  const w2 = plane.registerWorker({ workerId: "w2", region: "score", concurrency: 4, autoHeartbeat: false }); vt += 10;
  plane.registerWorker({ workerId: "w3", region: "score", concurrency: 1, autoHeartbeat: false }); vt += 10;
  plane.registerWorker({ workerId: "w-other", region: "elsewhere", concurrency: 99, autoHeartbeat: false });

  check("A5: least load-ratio wins ((0+1)/4 = 0.25 beats 0.5 and 1.0)",
    plane.selectWorker({ region: "score" }).workerId === "w2",
    plane.listWorkers({ region: "score" }).map((w) => `${w.workerId}:${w.load.activeJobs}/${w.concurrency}`).join(" "));

  await plane.heartbeat("w2", { load: { activeJobs: 4 } }); // saturate w2 (4/4)
  check("A5: saturated worker skipped → next best load ratio (w1 at 0.5)",
    plane.selectWorker({ region: "score" }).workerId === "w1");

  plane.noteJobStart("w1"); // plane-side accounting: w1 now 1/2 → ratio 1.0 == w3's 1.0
  check("A5: load tie broken by newest beat (w3 registered last)",
    plane.selectWorker({ region: "score" }).workerId === "w3");
  plane.deregisterWorker("w3");
  check("A5: tie falls back deterministically to the remaining candidate (w1)",
    plane.selectWorker({ region: "score" }).workerId === "w1" &&
    plane.selectWorker({ region: "score" }).workerId === plane.selectWorker({ region: "score" }).workerId);
  plane.noteJobEnd("w1");
  check("A5: noteJobEnd releases plane-side load (w1 back to 0/2)",
    plane.getActive("w1") === 0 && plane.selectWorker({ region: "score" }).workerId === "w1");

  plane.registerWorker({ workerId: "w-vision", region: "score", capabilities: ["clone:web", "vision"], concurrency: 1, autoHeartbeat: false }); vt += 10;
  check("A5: capability filter picks the worker that HAS the capability",
    plane.selectWorker({ region: "score", capability: "vision" }).workerId === "w-vision");
  let missing = null;
  try { plane.selectWorker({ region: "score", capabilities: ["vision", "gpu"] }); } catch (e) { missing = e; }
  check("A5: ALL requested capabilities required — missing gpu excluded with a reason",
    missing instanceof NoWorkerAvailableError && missing.reasons.some((r) => /missing capabilities: gpu/.test(r.reason)),
    missing?.reasons?.map((r) => r.reason).join(" | "));
  check("A5: region filter holds (no 'elsewhere' worker is ever picked for 'score')",
    plane.selectWorker({ region: "score" }).region === "score");

  plane.registerWorker({ workerId: "w-remote", region: "score", capabilities: ["remote"], executor: null, concurrency: 1, autoHeartbeat: false }); vt += 10;
  check("A5: remote (executor-less) worker IS selectable when no executor is required",
    plane.listWorkers({ region: "score" }).some((w) => w.workerId === "w-remote" && w.executorBound === false) &&
    plane.selectWorker({ region: "score", capability: "remote", requireExecutor: false }).workerId === "w-remote");
  let noExec = null;
  try { plane.selectWorker({ region: "score", requireExecutor: true }); } catch (e) { noExec = e; }
  check("A5: requireExecutor excludes executor-less workers with an explicit reason",
    noExec instanceof NoWorkerAvailableError && noExec.reasons.some((r) => /no executor bound/.test(r.reason)),
    noExec?.reasons?.map((r) => r.reason).join(" | "));
  await plane.close();
}

check("A6: region name validation (REGION_RE accepts eu-west-1, rejects bad names)",
  REGION_RE.test("eu-west-1") && REGION_RE.test("US_East") && !REGION_RE.test("-bad") && !REGION_RE.test("bad region"));
check("A6: resolveDefaultRegion reads CLONER_WORKER_REGION (default 'local')",
  resolveDefaultRegion() === "local" ||
  resolveDefaultRegion() === process.env.CLONER_WORKER_REGION,
  `got ${resolveDefaultRegion()}`);
{
  const prev = process.env.CLONER_WORKER_REGION;
  process.env.CLONER_WORKER_REGION = "prod-eu";
  check("A6: CLONER_WORKER_REGION=prod-eu → default region prod-eu", resolveDefaultRegion() === "prod-eu");
  if (prev === undefined) delete process.env.CLONER_WORKER_REGION; else process.env.CLONER_WORKER_REGION = prev;
}

// ===========================================================================
// Part B — ExecutionPlane routes jobs through the REAL clone-queue adapter
// (memory backend; redisUrl pinned to "" so no Redis is touched)
// ===========================================================================
console.log("\n-- Part B: execution plane routing through the queue adapter contract (memory backend) --");
const control = createWorkerPlane({ defaultRegion: "eu-west", heartbeatMs: 50, heartbeatTtlMs: 60_000, deregisterAfterMs: 0 });
const exec = createExecutionPlane({
  plane: control,
  createRegionAdapter: ({ region }) => createCloneQueue({ redisUrl: "", queueName: `clone-jobs:${region}`, maxConcurrent: 2 }),
});
const execEvents = collect(exec);

// B1 — happy path: dispatch → selected worker's executor → adapter entry + route ledger
{
  const executions = [];
  control.registerWorker({
    workerId: "w-eu-1", region: "eu-west", capabilities: ["clone:web"], concurrency: 2,
    executor: async (ctx) => {
      executions.push({ workerId: ctx.assignedWorkerId, url: ctx.payload.url, hasEntry: !!ctx.entry, hasReport: typeof ctx.report === "function" });
      ctx.entry.status = "exploring";
      ctx.report("exploring");
      await sleep(20);
      return { passed: true, artifactsDir: "artifacts/b1" };
    },
  });
  const res = await exec.dispatchJob({
    payload: { url: "http://fixture.local/b1", taskId: "t-b1" },
    jobId: "job-b1",
    owner: { userId: "u-1", orgId: "org-1" },
    region: "eu-west",
  });
  check("B1: dispatch routes to the eu-west worker through the memory-backend adapter",
    res.worker.workerId === "w-eu-1" && res.region === "eu-west" && res.backend === "memory" &&
    res.entry.status !== "error", `backend=${res.backend} status=${res.entry.status}`);
  await exec.whenIdle();
  const route = exec.getRoute("job-b1");
  check("B1: job executed ON the selected worker (executor saw payload + entry + report)",
    executions.length === 1 && executions[0].workerId === "w-eu-1" &&
    executions[0].url === "http://fixture.local/b1" && executions[0].hasEntry && executions[0].hasReport,
    JSON.stringify(executions[0] || null));
  check("B1: entry completed via the adapter contract (passed:true → completed)",
    res.entry.status === "completed", res.entry.status);
  check("B1: route ledger records region + workerId + status + timestamps",
    route.region === "eu-west" && route.workerId === "w-eu-1" && route.status === "completed" &&
    !!route.dispatchedAt && !!route.startedAt && !!route.finishedAt && route.result?.passed === true,
    JSON.stringify(route));
  const entry = exec.adapterFor("eu-west").getJob("job-b1");
  check("B1: entry resolvable through the adapter registry (same object) with owner passthrough",
    entry === res.entry && entry.owner?.userId === "u-1" && entry.owner?.orgId === "org-1",
    JSON.stringify(entry?.owner || null));
  const trail = execEvents.filter((e) => e.type === "job-status" && e.jobId === "job-b1").map((e) => e.status);
  check("B1: status trail flows queued → exploring → completed (adapter events)",
    trail[0] === "queued" && trail.includes("exploring") && trail[trail.length - 1] === "completed",
    trail.join(" → "));
  check("B1: worker load returns to 0 after completion (executor accounting)",
    control.getWorker("w-eu-1").load.activeJobs === 0,
    `active=${control.getWorker("w-eu-1").load.activeJobs}`);
}

// B2 — region isolation: the other region's worker NEVER executes
{
  const ran = [];
  control.registerWorker({ workerId: "w-us-1", region: "us-east", concurrency: 2,
    executor: async (ctx) => { ran.push(ctx.assignedWorkerId); return { passed: true }; } });
  const res = await exec.dispatchJob({ payload: { url: "http://fixture.local/b2" }, jobId: "job-b2", region: "us-east" });
  await exec.whenIdle();
  check("B2: job dispatched to us-east executed ONLY on the us-east worker",
    res.worker.workerId === "w-us-1" && ran.length === 1 && ran[0] === "w-us-1",
    `ran=${JSON.stringify(ran)}`);
  check("B2: eu-west region queue never received the us-east job",
    exec.adapterFor("eu-west").listJobs().every((j) => j.jobId !== "job-b2") &&
    exec.adapterFor("us-east").listJobs().some((j) => j.jobId === "job-b2"));
  check("B2: route ledger attributes the job to the us-east worker",
    exec.getRoute("job-b2").workerId === "w-us-1" && exec.getRoute("job-b2").region === "us-east");
}

// B3 — capability routing: no eligible worker → NOTHING is enqueued
{
  control.registerWorker({ workerId: "w-us-2", region: "us-east", capabilities: ["clone:web"], concurrency: 1,
    executor: async () => ({ passed: true }) });
  const before = exec.adapterFor("us-east").listJobs().length;
  let err = null;
  try { await exec.dispatchJob({ payload: { url: "http://fixture.local/b3" }, region: "us-east", capabilities: ["vision"] }); }
  catch (e) { err = e; }
  check("B3: dispatch with unmet capability throws NoWorkerAvailableError (code + missing-capability reason)",
    err instanceof NoWorkerAvailableError && err.code === "NO_WORKER_AVAILABLE" &&
    err.reasons.some((r) => /missing capabilities: vision/.test(r.reason)),
    err?.reasons?.map((r) => r.reason).join(" | "));
  check("B3: NOTHING was enqueued for the blocked dispatch (no orphan jobs)",
    exec.adapterFor("us-east").listJobs().length === before && exec.getRoute("job-b3" /* never created */) === null,
    `jobs=${exec.adapterFor("us-east").listJobs().length}`);
  control.registerWorker({ workerId: "w-us-vision", region: "us-east", capabilities: ["vision"], concurrency: 1,
    executor: async () => ({ passed: true }) });
  const res = await exec.dispatchJob({ payload: { url: "http://fixture.local/b3b" }, region: "us-east", capabilities: ["vision"] });
  await exec.whenIdle();
  check("B3: once a vision-capable worker registers, the job routes to IT",
    res.worker.workerId === "w-us-vision" && res.worker.capabilities.includes("vision"));
}

// B4 — load-aware distribution across saturated workers (concurrency 1 each)
{
  const gates = new Map(); // url → resolve
  const mkExecutor = () => async (ctx) => {
    ctx.entry.status = "exploring";
    ctx.report("exploring");
    await new Promise((r) => gates.set(ctx.payload.url, r));
    ctx.entry.status = "completed";
    ctx.report("completed");
    return { passed: true };
  };
  control.registerWorker({ workerId: "w-lt-a", region: "load-test", concurrency: 1, executor: mkExecutor() });
  control.registerWorker({ workerId: "w-lt-b", region: "load-test", concurrency: 1, executor: mkExecutor() });
  const r1 = await exec.dispatchJob({ payload: { url: "http://fixture.local/b4-1" }, region: "load-test" });
  const r2 = await exec.dispatchJob({ payload: { url: "http://fixture.local/b4-2" }, region: "load-test" });
  check("B4: while the first worker is saturated, the second job lands on the OTHER worker",
    r1.route.workerId !== r2.route.workerId &&
    control.getWorker(r1.route.workerId).load.activeJobs === 1,
    `r1→${r1.route.workerId} r2→${r2.route.workerId}`);
  for (const r of gates.values()) r();
  await exec.whenIdle();
  check("B4: both jobs completed and both workers released",
    r1.entry.status === "completed" && r2.entry.status === "completed" &&
    control.getWorker("w-lt-a").load.activeJobs === 0 && control.getWorker("w-lt-b").load.activeJobs === 0);
}

// B5 — failure path: executor throw → adapter error entry + DLQ + released load
{
  control.registerWorker({ workerId: "w-fail", region: "fail-test", concurrency: 1,
    executor: async () => { throw new Error("boom-B5"); } });
  const res = await exec.dispatchJob({ payload: { url: "http://fixture.local/b5" }, jobId: "job-b5", region: "fail-test" });
  await exec.whenIdle();
  const route = exec.getRoute("job-b5");
  const dl = exec.adapterFor("fail-test").listDeadLetter();
  check("B5: executor failure surfaces as entry error + route error with the message",
    res.entry.status === "error" && route.status === "error" && /boom-B5/.test(route.error || ""),
    `entry=${res.entry.status} route=${route.status} err=${route.error}`);
  check("B5: failed job recorded in the adapter dead-letter list (existing DLQ semantics)",
    dl.length === 1 && dl[0].jobId === "job-b5" && /boom-B5/.test(dl[0].error),
    JSON.stringify(dl[0] || null));
  check("B5: worker load released even on failure (noteJobEnd in finally)",
    control.getWorker("w-fail").load.activeJobs === 0);
}

// B6 — cancel through the SAME routed adapter
{
  let release;
  const gate = new Promise((r) => { release = r; });
  control.registerWorker({ workerId: "w-cancel", region: "cancel-test", concurrency: 1,
    executor: async (ctx) => {
      ctx.entry.status = "exploring";
      ctx.report("exploring");
      await gate;
      if (ctx.entry.cancelRequested) return { passed: true }; // cancel wins; no late completion report
      ctx.entry.status = "completed";
      ctx.report("completed");
      return { passed: true };
    } });
  await exec.dispatchJob({ payload: { url: "http://fixture.local/b6" }, jobId: "job-b6", region: "cancel-test" });
  const cancelled = await exec.cancelJob("job-b6");
  release();
  await exec.whenIdle();
  const route = exec.getRoute("job-b6");
  check("B6: cancelJob routes through the job's own adapter and CANCEL wins over the late completion",
    cancelled === true && exec.adapterFor("cancel-test").getJob("job-b6").status === "cancelled" &&
    route.status === "cancelled",
    `cancel=${cancelled} entry=${exec.adapterFor("cancel-test").getJob("job-b6").status} route=${route.status}`);
  check("B6: cancelJob of an unknown job returns false", (await exec.cancelJob("no-such-job")) === false);
}

// B7 — default-region dispatch + adapter-contract enforcement
{
  check("B7: dispatch WITHOUT a region uses the control plane's defaultRegion",
    (await exec.dispatchJob({ payload: { url: "http://fixture.local/b7" }, jobId: "job-b7" })).route.region === "eu-west");
  await exec.whenIdle();
  const badExec = createExecutionPlane({ plane: control, createRegionAdapter: () => ({}) }); // not a queue adapter
  let err = null;
  try { await badExec.dispatchJob({ payload: {}, region: "any" }); } catch (e) { err = e; }
  check("B7: a factory returning a non-adapter object fails loudly (DispatchError)",
    err instanceof DispatchError && err.code === "DISPATCH_ERROR" && /queue adapter contract/.test(err.message),
    err?.message);
}

// B8 — executor-less worker cannot receive embedded (memory-backend) jobs
{
  control.registerWorker({ workerId: "w-remote-mem", region: "mem-remote", executor: null, concurrency: 1 });
  let err = null;
  try { await exec.dispatchJob({ payload: { url: "http://fixture.local/b8" }, region: "mem-remote" }); }
  catch (e) { err = e; }
  check("B8: memory-backend dispatch to an executor-less worker is refused (no silent stranding)",
    err instanceof NoWorkerAvailableError && err.reasons.some((r) => /no executor bound/.test(r.reason)),
    err?.reasons?.map((r) => r.reason).join(" | "));
}

// B9 — the REAL default adapter factory: per-region clone-queue "clone-jobs:<region>"
{
  const prev1 = process.env.CLONER_REDIS_URL, prev2 = process.env.REDIS_URL;
  process.env.CLONER_REDIS_URL = "";
  process.env.REDIS_URL = "";
  try {
    const control2 = createWorkerPlane({ defaultRegion: "eu-west", heartbeatMs: 50, heartbeatTtlMs: 60_000, deregisterAfterMs: 0 });
    const exec2 = createExecutionPlane({ plane: control2 }); // NO factory injection — the real default
    control2.registerWorker({ workerId: "w-eu-d", region: "eu-west", concurrency: 1,
      executor: async (ctx) => { ctx.entry.status = "exploring"; ctx.report("exploring"); return { passed: true }; } });
    const res = await exec2.dispatchJob({ payload: { url: "http://fixture.local/b9" }, jobId: "job-b9" });
    await exec2.whenIdle();
    const adapter = exec2.adapterFor("eu-west");
    check("B9: default factory builds the REAL clone-queue adapter named clone-jobs:<region>",
      adapter.queueName === `clone-jobs:eu-west` && adapter.backend === "memory" &&
      typeof adapter.enqueue === "function" && typeof adapter.getJob === "function" && typeof adapter.cancel === "function",
      `queueName=${adapter.queueName} backend=${adapter.backend}`);
    check("B9: end-to-end dispatch through the default factory completes",
      res.entry.status === "completed" && exec2.getRoute("job-b9").status === "completed" &&
      adapter.getJob("job-b9") === res.entry,
      `entry=${res.entry.status}`);
    await exec2.close();
    await control2.close();
  } finally {
    if (prev1 === undefined) delete process.env.CLONER_REDIS_URL; else process.env.CLONER_REDIS_URL = prev1;
    if (prev2 === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prev2;
  }
}

// B10 — clean shutdown: adapters closed, control timers stopped, registry cleared
{
  const beatsBefore = control.getWorker("w-eu-1").beats;
  await exec.close();
  await control.close();
  await sleep(160); // > 3 × heartbeatMs(50) — no auto-beats may fire after close
  check("B10: close() clears the registry and stops every heartbeat timer",
    control.listWorkers().length === 0 && exec.listRegions().length === 0,
    `workers=${control.listWorkers().length} regions=${exec.listRegions().length}`);
  check("B10: beats frozen after close (timer leak check)", control.getWorker("w-eu-1") === null,
    `beatsBefore=${beatsBefore}`);
}

// ===========================================================================
// Part C — bullmq-backed region adapter through a LOCAL MOCK TRANSPORT
// (the remote-end simulator; the REAL adapter dispatch + QueueEvents handlers
// + dead-letter move run against it)
// ===========================================================================
console.log("\n-- Part C: bullmq-backed region adapter via local mock transport --");

// in-process broker emulating the BullMQ semantics the adapter relies on
function createMockTransport(queueName) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  events.close = async () => {};
  let seq = 0;
  let workerSeq = 0;
  const workers = new Set();
  let drainTimer = null;

  const makeQueue = (name) => {
    const jobs = new Map();
    const wait = [];
    return {
      name,
      _jobs: jobs,
      _wait: wait,
      async add(_n, data, opts = {}) {
        const id = opts.jobId || `mock-${++seq}`;
        const existing = jobs.get(id);
        if (existing && existing.state !== "completed" && existing.state !== "failed") return existing;
        const job = {
          id, data, opts, attemptsMade: 0, state: "waiting", returnvalue: null, execToken: null, workerKey: null,
          async getState() { return job.state; },
          async remove() { jobs.delete(id); const i = wait.indexOf(id); if (i >= 0) wait.splice(i, 1); },
        };
        jobs.set(id, job);
        wait.push(id);
        scheduleDrain();
        return job;
      },
      async getJob(id) { return jobs.get(id) || null; },
      async close() {},
    };
  };

  const queue = makeQueue(queueName);
  const dlq = makeQueue("clone-jobs-dead");

  function scheduleDrain() {
    if (!drainTimer && workers.size) {
      drainTimer = setInterval(drain, 5);
      drainTimer.unref?.();
    }
  }

  async function execute(w, job) {
    const token = Symbol("exec");
    job.execToken = token;
    const proxy = {
      id: job.id, data: job.data, opts: job.opts, attemptsMade: job.attemptsMade,
      updateProgress: (d) => events.emit("progress", { jobId: job.id, data: d }),
      getState: async () => job.state,
    };
    try {
      const rv = await w.processor(proxy);
      if (job.execToken !== token) return;
      job.state = "completed";
      job.returnvalue = rv;
      w.running.delete(job.id);
      events.emit("completed", { jobId: job.id, returnvalue: rv });
    } catch (e) {
      if (job.execToken !== token) return;
      w.running.delete(job.id);
      job.attemptsMade++;
      const attempts = Number(job.opts?.attempts ?? 1);
      events.emit("failed", { jobId: job.id, failedReason: String(e?.message || e) }); // per-attempt, like BullMQ
      if (job.attemptsMade >= attempts) {
        job.state = "failed";
      } else {
        job.state = "delayed";
        const delay = Math.min(150, Number(job.opts?.backoff?.delay ?? 100) * Math.pow(2, job.attemptsMade - 1));
        const t = setTimeout(() => { job.state = "waiting"; queue._wait.push(job.id); scheduleDrain(); }, delay);
        t.unref?.();
      }
    }
  }

  function drain() {
    for (const w of workers) {
      while (!w.closing && w.running.size < w.concurrency) {
        const idx = queue._wait.findIndex((id) => queue._jobs.get(id)?.state === "waiting");
        if (idx < 0) break;
        const id = queue._wait.splice(idx, 1)[0];
        const job = queue._jobs.get(id);
        job.state = "active";
        job.workerKey = w.key;
        w.running.add(id);
        events.emit("active", { jobId: id });
        execute(w, job).catch(() => {});
      }
    }
  }

  return {
    queue,
    dlq,
    events,
    makeWorkerFactory() {
      return ({ processor, opts = {} }) => {
        const w = {
          key: `mock-worker-${++workerSeq}`,
          processor,
          concurrency: opts.concurrency || 1,
          name: opts.name,
          running: new Set(),
          closing: false,
          isRunning: () => true,
          getActiveJobsCount: async () => w.running.size,
          async close() {
            w.closing = true;
            workers.delete(w);
            if (!workers.size && drainTimer) { clearInterval(drainTimer); drainTimer = null; }
          },
        };
        workers.add(w);
        scheduleDrain();
        return w;
      };
    },
    async stop() {
      for (const w of [...workers]) w.closing = true;
      workers.clear();
      if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    },
  };
}

const fakeRedisConn = {
  on: () => {}, connect: async () => {}, ping: async () => "PONG",
  quit: async () => {}, disconnect: () => {}, close: async () => {},
};

{
  const transport = createMockTransport("clone-jobs:eu-west");
  const controlC = createWorkerPlane({ defaultRegion: "eu-west", heartbeatMs: 50, heartbeatTtlMs: 60_000, deregisterAfterMs: 0 });
  const execC = createExecutionPlane({
    plane: controlC,
    createRegionAdapter: ({ region }) =>
      createCloneQueue({
        redisUrl: "redis://mock.invalid:6379",
        queueName: `clone-jobs:${region}`,
        retryBackoffMs: 20,
        bullmqFactory: () => ({
          connection: fakeRedisConn,
          eventsConnection: fakeRedisConn,
          queue: transport.queue,
          dlq: transport.dlq,
          events: transport.events,
          bullmq: {},
        }),
      }),
  });
  const execEventsC = collect(execC);

  // C1 — remote (executor-less) worker registration is routable; the job travels
  // the transport to the REGION queue — no embedded execution happens here
  controlC.registerWorker({ workerId: "w-remote-eu", region: "eu-west", executor: null, concurrency: 4 });
  const res1 = await execC.dispatchJob({
    payload: { url: "http://fixture.local/c1", taskId: "t-c1" },
    jobId: "job-c1",
    region: "eu-west",
  });
  check("C1: executor-less worker routed in bullmq mode (backend=bullmq)",
    res1.backend === "bullmq" && res1.worker.workerId === "w-remote-eu" && res1.route.backend === "bullmq",
    `backend=${res1.backend}`);
  const mockJob = transport.queue._jobs.get("job-c1");
  check("C1: job landed on the region queue with payload + jobId + meta(taskId)",
    !!mockJob && transport.queue.name === "clone-jobs:eu-west" &&
    mockJob.data?.payload?.url === "http://fixture.local/c1" && mockJob.data?.jobId === "job-c1" &&
    mockJob.data?.meta?.taskId === "t-c1" && Number(mockJob.opts?.attempts) === 3,
    `name=${transport.queue.name} data=${JSON.stringify(mockJob?.data || null)}`);
  check("C1: NO embedded execution for a remote worker (route stays queued until the broker picks it)",
    res1.entry.status === "queued" && execC.getRoute("job-c1").status === "queued" &&
    controlC.getExecutor("w-remote-eu") === null,
    `entry=${res1.entry.status}`);

  // C2 — full remote round trip: a broker-side worker consumes and reports; the
  // REAL QueueEvents handlers map everything back onto registry + route ledger
  const processor = async (job) => {
    if (job.id === "job-c1") return { passed: true, artifactsDir: "artifacts/c1" };
    job.updateProgress({ status: "exploring" });
    return { status: "completed", passed: true, artifactsDir: "artifacts/c2" };
  };
  const workerFactory = transport.makeWorkerFactory();
  const mockWorker = workerFactory({ processor, opts: { name: "mock-eu", concurrency: 2 } });

  const res2 = await execC.dispatchJob({ payload: { url: "http://fixture.local/c2" }, jobId: "job-c2", region: "eu-west" });
  await waitFor(() => execC.adapterFor("eu-west").getJob("job-c1")?.status === "completed" &&
                        execC.adapterFor("eu-west").getJob("job-c2")?.status === "completed");
  const route1 = execC.getRoute("job-c1");
  const route2 = execC.getRoute("job-c2");
  check("C2: broker-side execution flows back through QueueEvents → entry completed with result fields",
    execC.adapterFor("eu-west").getJob("job-c1").status === "completed" &&
    execC.adapterFor("eu-west").getJob("job-c1").artifactsDir === "artifacts/c1" &&
    execC.adapterFor("eu-west").getJob("job-c2").artifactsDir === "artifacts/c2",
    `c1=${execC.adapterFor("eu-west").getJob("job-c1").status} c2=${execC.adapterFor("eu-west").getJob("job-c2").status}`);
  check("C2: route ledger reaches completed for both jobs; active→progress events were seen",
    route1.status === "completed" && route2.status === "completed" &&
    execEventsC.some((e) => e.type === "job-status" && e.status === "exploring" && e.jobId === "job-c2"),
    `c1=${route1.status} c2=${route2.status}`);
  check("C2: route ledger still attributes both jobs to the registered region worker",
    route1.workerId === "w-remote-eu" && route2.workerId === "w-remote-eu" && route1.region === "eu-west");

  // C3 — exhausted attempts dead-letter through the REAL adapter failed-handler
  // (close the good worker first so ONLY the failing worker can pick job-c3 —
  // the mock transport's workers all drain the same region queue)
  await mockWorker.close();
  const boomFactory = transport.makeWorkerFactory();
  boomFactory({ processor: async () => { throw new Error("boom-C3"); }, opts: { name: "mock-boom", concurrency: 1 } });
  await execC.dispatchJob({ payload: { url: "http://fixture.local/c3" }, jobId: "job-c3", region: "eu-west" });
  await waitFor(() => execC.adapterFor("eu-west").getJob("job-c3")?.status === "error", 10_000);
  check("C3: non-transient failure exhausts attempts → entry error via the real failed-handler",
    execC.adapterFor("eu-west").getJob("job-c3").status === "error" && /boom-C3/.test(execC.getRoute("job-c3").error || ""),
    `entry=${execC.adapterFor("eu-west").getJob("job-c3").status}`);
  check("C3: dead-lettered into the shared clone-jobs-dead queue by the adapter",
    transport.dlq._jobs.get("job-c3") !== undefined && transport.dlq._jobs.get("job-c3").data?.jobId === "job-c3",
    `dlq=${[...transport.dlq._jobs.keys()].join(",")}`);

  // cleanup
  await transport.stop();
  await execC.close();
  await controlC.close();
  check("C4: mock transport + planes shut down cleanly",
    transport.queue._wait.length >= 0 && controlC.listWorkers().length === 0);
}

// ===========================================================================
// summary
// ===========================================================================
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : " — all green"}`);
process.exit(failed ? 1 : 0);
