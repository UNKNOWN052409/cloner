#!/usr/bin/env node
// P2 concurrency/distributed validation (realignment R-P2.2): boots the distributed
// worker plane IN-PROCESS on loopback with the existing modules — region-registry →
// loopback-HTTP dispatcher → job-leases → failover re-route on a fake dead worker →
// cost-aware ranking → autoscaler. NO Redis required; Redis/PG probes hit local services.
//   node scripts/test-distributed-plane.mjs  → PASS/FAIL counts, exit 1 on failure
import fs from "node:fs"; import os from "node:os";
import path from "node:path"; import { fileURLToPath } from "node:url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")); // cwd-relative artifact roots
process.env.CLONER_QUEUE_BACKEND = "memory"; // ExecutionPlane rides clone-queue memory mode (deterministic, no Redis)
process.env.CLONER_REGION_SECRET = "dp-test-secret-0123456789abcdef"; // region-node HTTP auth (contracts requires >=16 chars)
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (label, fn) => Promise.resolve().then(fn)
  .catch((e) => check(`section ${label} completed`, false, String(e?.stack || e).split("\n").slice(0, 3).join(" | ")));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-test-"));
const PID = process.pid;
const { createRegionRegistry, createRegionNode, createRegionClient, createRegionDispatcher } = await import("../src/distributed/region-registry.js");
const { createWorkerPlane, createExecutionPlane, NoWorkerAvailableError } = await import("../src/distributed/worker-plane.js");
const { createLeaseManager, createMemoryLeaseBackend } = await import("../src/distributed/job-leases.js");
const { createFailoverController, createQueueDispatcher } = await import("../src/distributed/failover.js");
const { ResourceScheduler } = await import("../src/distributed/scheduler.js");
const { createCostAwareScheduler } = await import("../src/distributed/cost-aware-scheduler.js");
const { createWorkerPoolManager } = await import("../src/workers/worker-pool-manager.js");
const { createAutoscaler } = await import("../src/workers/autoscaler.js");
const { createCloneQueue } = await import("../src/queues/clone-queue.js");
const reg = createRegionRegistry({ bootstrapFromEnv: false }); // shared across section 1
// == 1. region-registry: control plane + loopback HTTP plane + dead-node failover
await section("region-registry", async () => {
  reg.registerRegion({ id: "r-a", endpoint: "http://127.0.0.1:9501", capabilities: ["clone:url"] });
  reg.registerRegion({ id: "r-b", endpoint: "http://127.0.0.1:9502", capabilities: ["clone:url"], weight: 2 });
  reg.registerWorker("r-a", { id: "wa", capabilities: ["clone:url"], concurrency: 2 });
  reg.registerWorker("r-b", { id: "wb", capabilities: ["clone:url"], concurrency: 1 });
  const capBefore = reg.getRegion("r-a").stats.capacity;
  const resv = reg.acquireWorker("r-a", { required: ["clone:url"] });  const reserved = capBefore === 2 && resv?.workerId === "wa" && reg.getRegion("r-a").stats.inFlight === 1;
  resv.release();
  check("registry: workers online with free capacity; acquireWorker reserves a slot; release frees it",
    reserved && reg.getRegion("r-a").stats.inFlight === 0, `before=${capBefore} after=${JSON.stringify(reg.getRegion("r-a").stats)}`);
  const sat1 = reg.acquireWorker("r-a");
  const sat2 = reg.acquireWorker("r-a"); // saturate r-a (concurrency 2)
  const ranked = reg.selectRegion({ required: ["clone:url"], requireOnlineWorker: true });
  check("registry: selectRegion ranks by free capacity (r-a full → r-b first); duplicate registration without replace throws",
    ranked[0]?.id === "r-b" && (() => { try { reg.registerRegion({ id: "r-a", endpoint: "http://127.0.0.1:1" }); return false; } catch (e) { return e.code === "duplicate_region"; } })(),
    `order=${ranked.map((r) => r.id).join(",")}`);
  sat1.release(); sat2.release();
  // loopback HTTP region nodes + dispatcher, with failover on a dead node
  const execHits = { "r-a": 0, "r-b": 0 };
  const mkNode = (id) => createRegionNode({
    regionId: id, capabilities: ["clone:url"], port: 0, artifactsRoot: path.join(tmpRoot, `region-${id}`),
    executor: async () => { execHits[id] += 1; return { status: "completed", meta: { ranOn: id } }; },
  });
  const nA = await mkNode("r-a"); const nB = await mkNode("r-b");
  // NOTE: registerRegion(replace:true) is a full descriptor upsert — capabilities must be re-passed
  reg.registerRegion({ id: "r-a", endpoint: nA.endpoint, capabilities: ["clone:url"], replace: true });
  reg.registerRegion({ id: "r-b", endpoint: nB.endpoint, capabilities: ["clone:url"], replace: true });
  const client = createRegionClient({ issuer: "dp-test" }); const dispatcher = createRegionDispatcher({ registry: reg, client });
  const hs = await client.handshake(reg.getRegion("r-b"));
  const out1 = await dispatcher.dispatch({ jobId: `dp-http-1-${PID}`, taskId: "t1", url: "https://example.internal/", required: ["clone:url"] });  check("region-node: loopback HTTP handshake answers the wire contract; dispatcher executes over real fetch",
    hs.regionId === "r-b" && out1.result.status === "completed" && execHits["r-a"] === 1 && out1.region.id === "r-a",
    `handshake=${hs.regionId}/${hs.contractVersion} status=${out1.result.status} ranOn=r-a worker=${out1.workerId}`);
  await nA.close(); // fake dead region node
  const out2 = await dispatcher.dispatch({ jobId: `dp-http-2-${PID}`, taskId: "t2", url: "https://example.internal/", required: ["clone:url"] });
  check("dispatcher: dead node skipped — job failed over to the healthy candidate region",
    out2.result.status === "completed" && execHits["r-b"] === 1 && out2.region.id === "r-b", `ranOn=r-b (${execHits["r-b"]} executions)`);
  await nB.close();
});
// == 2. worker-plane control plane (staleness, prune, routing exclusion) ====
await section("worker-plane", async () => {
  let t = Date.now();
  const plane = createWorkerPlane({ defaultRegion: "r1", heartbeatMs: 25, heartbeatTtlMs: 100, deregisterAfterMs: 200, now: () => t });
  const events = []; plane.onEvent((e) => events.push(e.type));
  plane.registerWorker({ workerId: "wp-a", region: "r1", capabilities: ["clone:web"], concurrency: 1, executor: async () => ({}) });
  plane.registerWorker({ workerId: "wp-b", region: "r2", capabilities: ["clone:web"], concurrency: 1, executor: async () => ({}) });
  let noCap = null;
  try { plane.selectWorker({ region: "r1", capabilities: ["clone:web", "vision"] }); } catch (e) { noCap = e; }
  check("worker-plane: selectWorker matches region+capability; missing capability → NoWorkerAvailableError with reason",
    plane.selectWorker({ region: "r1", capabilities: ["clone:web"] }).workerId === "wp-a"
      && noCap instanceof NoWorkerAvailableError && JSON.stringify(noCap.reasons).includes("missing capabilities"), noCap?.reasons?.[0]?.reason || "no error");
  t += 150; plane.sweep(); // ttl 100 passed without a beat
  let excl = null;
  try { plane.selectWorker({ region: "r1" }); } catch (x) { excl = x; }
  await plane.heartbeat("wp-a");
  check("worker-plane: silent worker goes stale, is excluded from routing, and heartbeat recovers it",
    plane.getWorker("wp-a").status === "online" && excl?.reasons?.[0]?.reason === "stale heartbeat",
    `excl=${excl?.reasons?.[0]?.reason || "no exclusion"} now=${plane.getWorker("wp-a").status}`);
  t += 250; plane.sweep(); // 250ms silent > deregisterAfterMs 200
  check("worker-plane: stale worker pruned after deregisterAfterMs", !plane.getWorker("wp-a") && events.includes("pruned"), `events=${[...new Set(events)].join(",")}`);
  plane.close();
});
// == 3. E2E: dispatch → lease → execute → release, then failover on a dead worker
await section("e2e-plane-lease", async () => {
  const sharedLeases = createMemoryLeaseBackend(); // ONE coordination store; two managers = two workers
  const leases = {
    "ep-a": createLeaseManager({ backend: sharedLeases, workerId: "ep-a", region: "r1", ttlMs: 400 }),
    "ep-b": createLeaseManager({ backend: sharedLeases, workerId: "ep-b", region: "r1", ttlMs: 400 }),
  };
  const execLog = []; const hangJob = `dp-e2e-2-${PID}`;
  const executorFor = (wid) => async (ctx) => {
    const g = await leases[wid].acquire(ctx.jobId);
    if (!g.acquired) return { status: "error", error: `lease ${g.reason}` };
    execLog.push({ job: ctx.jobId, worker: wid });
    if (ctx.jobId === hangJob) await new Promise(() => {}); // fake dead worker: holds the lease, never finishes/renews
    await leases[wid].renew(ctx.jobId);
    const own = await leases[wid].validateOwnership(ctx.jobId, wid, g.lease.epoch);
    if (!own.valid) return { status: "error", error: `fenced: ${own.reason}` };
    await leases[wid].release(ctx.jobId);
    return { status: "completed", meta: { worker: wid } };
  };
  // pinned clock → registration beats tie exactly → workerId is the deterministic tiebreak (ep-a first)
  const plane = createWorkerPlane({ defaultRegion: "r1", heartbeatMs: 25, heartbeatTtlMs: 60000, now: () => 5_000_000 });
  plane.registerWorker({ workerId: "ep-a", region: "r1", capabilities: ["clone:web"], concurrency: 2, executor: executorFor("ep-a") });
  plane.registerWorker({ workerId: "ep-b", region: "r1", capabilities: ["clone:web"], concurrency: 2, executor: executorFor("ep-b") });
  const exec = createExecutionPlane({ plane });
  const d1 = await exec.dispatchJob({ jobId: `dp-e2e-1-${PID}`, payload: { url: "https://example.internal/x" }, region: "r1", capabilities: ["clone:web"] });
  await exec.whenIdle();
  const leaseGone = (await leases["ep-a"].getLease(`dp-e2e-1-${PID}`)).lease === null;
  check("e2e: dispatch → lease acquire → execute → release on the memory clone-queue adapter",
    d1.worker.workerId === "ep-a" && d1.route.status === "completed"
      && execLog.some((x) => x.job === d1.route.jobId && x.worker === "ep-a") && leaseGone,
    `worker=${d1.worker.workerId} status=${d1.route.status} leaseReleased=${leaseGone}`);
  await exec.dispatchJob({ jobId: hangJob, payload: {}, region: "r1", capabilities: ["clone:web"] }); // lands on ep-a, hangs
  await sleep(60);
  const held = await leases["ep-a"].getLease(hangJob);  check("e2e: dead worker HOLDS the job lease while running (exactly-one-owner)",
    held.lease?.owner === "ep-a" && held.lease?.active === true && held.lease?.epoch === 1, `owner=${held.lease?.owner}`);
  await sleep(500); // ttl 400 expires — the owner never renewed
  const st = await leases["ep-b"].steal(hangJob, null, { ttl: 5000 });  const fence = await leases["ep-a"].validateOwnership(hangJob, "ep-a", 1);
  const deadRenew = await leases["ep-a"].renew(hangJob);
  check("e2e: failover — healthy worker STEALS the expired lease (epoch 1→2, owner ep-b)",
    st.acquired === true && st.stolen === true && st.lease.epoch === 2 && st.lease.owner === "ep-b", `stolen=${st.stolen} epoch=${st.lease?.epoch} owner=${st.lease?.owner}`);
  check("e2e: zombie worker FENCED out after the steal (its renew and ownership check both fail)",
    fence.valid === false && fence.reason === "not-owner" && deadRenew.renewed === false, `fence=${fence.reason} renew=${deadRenew.reason}`);
  await leases["ep-b"].release(hangJob);
  plane.close();
});
// == 4. job-leases semantics (memory backend, deterministic injected clock) ==
await section("job-leases-memory", async () => {
  let t = 1_000_000;
  const shared = createMemoryLeaseBackend({ now: () => t });
  const a = createLeaseManager({ backend: shared, workerId: "l-a", region: "r1", ttlMs: 5000, now: () => t });
  const b = createLeaseManager({ backend: shared, workerId: "l-b", region: "r1", ttlMs: 5000, now: () => t });
  const g = await a.acquire("job-m1");
  const blk = await b.acquire("job-m1");
  check("leases: acquire grants exactly one owner (epoch 1, ttl honored); live lease blocks others (held)",
    g.acquired && g.lease.owner === "l-a" && g.lease.epoch === 1 && g.lease.ttlMs === 5000 && blk.acquired === false && blk.reason === "held",
    `epoch=${g.lease?.epoch} blk=${blk.reason}`);
  t += 3000; const rn = await a.renew("job-m1");
  const rnB = await b.renew("job-m1");
  check("leases: owner-only renew extends before expiry; non-owner renew rejected (not-owner)",
    rn.renewed && rn.lease.epoch === 1 && rnB.renewed === false && rnB.reason === "not-owner", `renew=${rn.renewed} other=${rnB.reason}`);
  t += 6000; // past ttl — nobody renewed
  const st = await b.steal("job-m1"); const relWrong = await a.release("job-m1");
  check("leases: expired lease stolen by another worker (epoch bump 1→2); non-owner release rejected",
    st.acquired && st.stolen && st.lease.epoch === 2 && relWrong.released === false && relWrong.reason === "not-owner", `epoch=${st.lease?.epoch} rel=${relWrong.reason}`);
  const relB = await b.release("job-m1");
  const again = await a.acquire("job-m1");
  check("leases: owner release frees the job; a fresh acquire starts a NEW lease (epoch 1)",
    relB.released && again.acquired && again.lease.epoch === 1, `epoch=${again.lease?.epoch}`);
  t += 6000; // expire again — the SAME owner re-acquires
  const re = await a.acquire("job-m1"); const stale = await a.validateOwnership("job-m1", "l-a", 1);
  const bOut = await b.validateOwnership("job-m1", "l-b", 2);
  check("leases: same-owner re-acquire after expiry gets a NEW epoch and the old one is fenced (stale-epoch); non-owner write fenced",
    re.acquired && re.lease.epoch === 2 && stale.valid === false && stale.reason === "stale-epoch" && bOut.valid === false && bOut.reason === "not-owner",
    `epoch=${re.lease?.epoch} fence=${stale.reason}/${bOut.reason}`);
});
// == 5. job-leases postgres backend — the REAL distributed path (127.0.0.1:5433) ==
await section("job-leases-postgres", async () => {
  const a = createLeaseManager({ backend: "postgres", workerId: `pg-a-${PID}`, region: "region-a" });
  const b = createLeaseManager({ backend: "postgres", workerId: `pg-b-${PID}`, region: "region-b" });
  const j = `dp-pg-1-${PID}`;
  const g = await a.acquire(j);
  const blk = await b.acquire(j);
  const relWrong = await b.release(j);
  check("leases/PG: acquire grants a fresh lease on the real job_leases table; live lease blocks the other region (held); non-owner release rejected",
    g.acquired && g.lease.owner === `pg-a-${PID}` && g.lease.epoch === 1 && blk.acquired === false && blk.reason === "held"
      && relWrong.released === false && relWrong.reason === "not-owner", `owner=${g.lease?.owner} blk=${blk.reason} rel=${relWrong.reason}`);
  await a.release(j);
  const again = await b.acquire(j);
  check("leases/PG: re-acquire after release starts a fresh lease", again.acquired && again.lease.owner === `pg-b-${PID}`, `owner=${again.lease?.owner}`);
  await b.release(j);
  const jr = `dp-pg-race-${PID}`;
  const [r1, r2] = await Promise.all([a.acquire(jr), b.acquire(jr)]); // true concurrent race
  const winners = [r1, r2].filter((r) => r.acquired);
  check("leases/PG: concurrent acquire race — exactly ONE winner, loser sees 'held'",
    winners.length === 1 && (r1.acquired === false ? r1.reason === "held" : r2.reason === "held"), `winners=${winners.length}`);
  await a.release(jr); await b.release(jr);
  const je = `dp-pg-exp-${PID}`;
  await a.acquire(je, null, { ttl: 300 }); await sleep(450); // short real-clock TTL; DB now() is the authority
  const post = await b.acquire(je);
  check("leases/PG: expired lease taken over after TTL (epoch bump)", post.acquired && post.lease.epoch === 2, `acquired=${post.acquired} epoch=${post.lease?.epoch}`);
  await b.release(je); await a.close(); await b.close();
});
// == 6. failover controller (memory store): heartbeat loss → re-route + replication
await section("failover", async () => {
  const RUNS = new Map();
  let reran = 0;
  let payloadRunSurvived = null; // does a run closure carried on job.payload survive the ledger round-trip?
  RUNS.set("dp-f1", () => { reran += 1; return { passed: true }; });
  let ft = 1_000_000;
  const fover = createFailoverController({
    heartbeatTtlMs: 500, tickMs: 3_600_000, clock: () => ft, log: () => {},
    dispatch: createQueueDispatcher(createCloneQueue({ queueName: `clone-jobs:dp-fover-${PID}` }),
      (job) => { payloadRunSurvived = job?.payload?.run != null; return RUNS.get(job?.jobId) || null; }),
  });
  await fover.registerRegion({ regionId: "regionA", storageRoot: path.join(tmpRoot, "fover-a"), capacity: 10 });
  await fover.registerRegion({ regionId: "regionB", storageRoot: path.join(tmpRoot, "fover-b"), capacity: 10 });
  await fover.heartbeat("regionA"); await fover.heartbeat("regionB");
  await fover.assignJob("dp-f1", "regionA", { status: "running", payload: { url: "https://example.internal/" }, artifactRel: "dp-f1" });
  await fover.assignJob("dp-done", "regionA", { status: "completed" }); // terminal — must never re-route
  fs.mkdirSync(path.join(tmpRoot, "fover-a", "dp-f1"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "fover-a", "dp-f1", "index.html"), "<html>dp-f1 payload</html>");
  ft += 2000; await fover.heartbeat("regionB"); // B beats now; A is silent past its 500ms TTL
  const sweep = await fover.check();
  const types = sweep.actions.map((x) => x.type); const reroute = sweep.actions.find((x) => x.type === "job-rerouted" && x.jobId === "dp-f1");
  const job = await fover.getJobAssignment("dp-f1");
  check("failover: heartbeat loss detected on regionA, non-terminal job re-routed to regionB; terminal job never re-routed",
    types.includes("region-down") && !!reroute && reroute.toRegion === "regionB" && job.region === "regionB"
      && (await fover.getJobAssignment("dp-done")).region === "regionA", `actions=${types.join(",")}`);
  await sleep(150); // the memory queue runs the re-routed entry
  const disp = await fover.status();
  check("failover: re-route handoff executed through the real queue dispatcher (run re-attached via resolveRun)",
    reran === 1 && disp.config.dispatchWired === true, `reran=${reran}`);
  check("failover: payload.run closure does NOT survive the ledger round-trip (audit #30) — resolveRun is the working seam",
    payloadRunSurvived === false, `payload.run present at dispatch=${payloadRunSurvived}`);
  const replica = await fover.verifyReplica("dp-f1", "regionB");
  check("failover: artifact set re-replicated to regionB with sha256-verified files",
    replica.ok === true && replica.files === 1 && fs.existsSync(path.join(tmpRoot, "fover-b", "dp-f1", "index.html")), `ok=${replica.ok} files=${replica.files}`);
  await fover.check(); // second sweep while A still down
  check("failover: no ping-pong — job stays on the region it was re-routed to", (await fover.getJobAssignment("dp-f1")).region === "regionB");
  ft += 2000; await fover.heartbeat("regionA"); await fover.heartbeat("regionB");
  const rec = await fover.check();
  check("failover: region recovery observed on the sweep", rec.actions.some((x) => x.type === "region-recovered" && x.regionId === "regionA"), rec.actions.map((x) => x.type).join(","));
  await fover.destroy();
  // SHIPPED server.js resolveRun shape ({ run: fn }) — what actually happens to the re-routed entry:
  let ft2 = 2_000_000;
  const q2 = createCloneQueue({ queueName: `clone-jobs:dp-fover2-${PID}` });
  const fover2 = createFailoverController({
    heartbeatTtlMs: 500, tickMs: 3_600_000, clock: () => ft2, log: () => {},
    dispatch: createQueueDispatcher(q2, () => ({ run: () => ({ passed: true }) })), // exact server.js:144 shape
  });
  await fover2.registerRegion({ regionId: "regionA", storageRoot: path.join(tmpRoot, "fover2-a") });
  await fover2.registerRegion({ regionId: "regionB", storageRoot: path.join(tmpRoot, "fover2-b") });
  await fover2.heartbeat("regionA"); await fover2.heartbeat("regionB");
  await fover2.assignJob("dp-f2", "regionA", { status: "running" });
  ft2 += 2000; await fover2.heartbeat("regionB");
  await fover2.check(); await q2.whenIdle();
  const entry2 = [...q2.entries.values()][0];
  check("failover: SHIPPED server.js resolveRun shape ({run:fn}) — re-routed entry ERRORS instead of re-executing (memory-mode wiring gap)",
    entry2?.status === "error" && /not a function/i.test(entry2?.error || ""), `status=${entry2?.status} error=${String(entry2?.error || "").slice(0, 60)}`);
  await fover2.destroy();
  // Redis-mode contract probe (local redis reachable at 127.0.0.1:6379)
  const rfo = createFailoverController({ redisUrl: "redis://127.0.0.1:6379", heartbeatTtlMs: 500, log: () => {} });
  await rfo.registerRegion({ regionId: "regionR", storageRoot: path.join(tmpRoot, "fover-r") });
  await rfo.heartbeat("regionR", { status: "running" });
  const rg = await rfo.getRegion("regionR");
  check("failover: Redis-mode contract (real server-side heartbeat TTL) when a redisUrl is configured",
    rfo.backend === "redis" && rg.state === "healthy", `backend=${rfo.backend} state=${rg.state}`);
  await rfo.destroy();
});
// == 7. resource scheduler: packing, unfittable, worker-down requeue =========
await section("resource-scheduler", async () => {
  const sched = new ResourceScheduler({ mode: "strict" });
  sched.registerWorker({ id: "s-a", capacity: { memoryMb: 100, browserSlots: 2 } });
  sched.registerWorker({ id: "s-b", regionId: "r2", capacity: { memoryMb: 100, browserSlots: 2 } });
  sched.submit({ id: "j1", resources: { memoryMb: 60, browserSlots: 1 } });
  sched.submit({ id: "j2", resources: { memoryMb: 60, browserSlots: 1 } });
  const placements = sched.dispatch();
  check("scheduler: best-fit packing, no overcommit (j1→s-a, j2→s-b)",
    placements.length === 2 && placements[0].workerId === "s-a" && placements[1].workerId === "s-b"
      && sched.workerSnapshot("s-a").used.memoryMb === 60 && sched.workerSnapshot("s-b").used.memoryMb === 60,
    placements.map((p) => `${p.jobId}→${p.workerId}`).join(","));
  let unf = null;
  try { sched.submit({ id: "j3", resources: { memoryMb: 200, browserSlots: 1 } }); } catch (e) { unf = e; }
  check("scheduler: unfittable job rejected eagerly (fleet max too small)", unf?.code === "UNFITTABLE", unf?.code || "no error");
  const requeued = sched.markWorkerDown("s-a", { reason: "crashed" });
  sched.release("s-b", "j2");
  const p2 = sched.dispatch();
  check("scheduler: worker-down requeues its running job (attempts++); requeued job re-placed after capacity freed",
    requeued.includes("j1") && sched.jobSnapshot("j1").attempts === 1 && p2.some((p) => p.jobId === "j1" && p.workerId === "s-b"),
    `requeued=${requeued.join(",")} p2=${p2.map((p) => `${p.jobId}→${p.workerId}`).join(",")}`);
});
// == 8. cost-aware scheduler: cheapest-region ranking, deferral, SLA beats cost
await section("cost-aware-scheduler", async () => {
  const depths = {}; const PEAK = Date.UTC(2026, 10, 9, 12, 0, 0); // 12:00 UTC — inside the 10–16 peak window
  let casT = Date.UTC(2026, 10, 9, 18, 0, 0); // off-peak for the cheapest-region check
  const cas = createCostAwareScheduler({
    base: { assign: (_job, { candidates }) => candidates[0]?.workerId ?? null },
    regions: [{ id: "eu" }, { id: "us" }],
    workers: [{ workerId: "w-eu", regionId: "eu" }, { workerId: "w-us", regionId: "us" }],
    regionPricing: { eu: { hourlyRate: 1, fixedPerJob: 0 }, us: { hourlyRate: 3, fixedPerJob: 0 } },
    regionSignals: { getQueueDepth: (r) => depths[r] ?? 0, getAvgRuntimeMs: () => 60000 },
    clock: () => casT,
    config: { peakWindows: [{ startHour: 10, endHour: 16 }], minSavingsFraction: 0.1, maxDeferralMs: 86_400_000 },
  });
  const d1 = cas.schedule({ jobId: "cj-1", memoryMb: 10, browserSlots: 1, estimatedRuntimeMs: 60_000 });
  check("cost-scheduler: cheapest region wins for a slack job (off-peak → no deferral)",
    d1.decision === "run" && d1.regionId === "eu" && d1.workerId === "w-eu", `${d1.decision} ${d1.regionId} reason=${d1.reason}`);
  casT = PEAK; const d2 = cas.schedule({ jobId: "cj-2", memoryMb: 10, browserSlots: 1, estimatedRuntimeMs: 60_000 });
  check("cost-scheduler: non-urgent job inside a peak window defers to the off-peak window",
    d2.decision === "defer" && d2.reason === "off_peak_deferral" && new Date(d2.startAt).getUTCHours() === 16, `startAt=${new Date(d2.startAt).toISOString()}`);
  casT = d2.startAt;
  const released = cas.poll(d2.startAt);
  check("cost-scheduler: poll() releases the deferred job and it now runs off-peak",
    released.length === 1 && released[0].decision.decision === "run" && released[0].decision.regionId === "eu", `${released[0]?.decision?.decision}@${released[0]?.decision?.regionId}`);
  casT = PEAK; const du = cas.schedule({ jobId: "cj-3", urgency: "urgent", estimatedRuntimeMs: 60_000 });
  check("cost-scheduler: urgent jobs run at peak — never deferred", du.decision === "run" && du.regionId === "eu" && du.reason === "urgent_region_selected", `${du.decision} reason=${du.reason}`);
  depths.eu = 1000; // eu backlog blows its SLA (delay ≫ urgentMaxDelayMs)
  const ds = cas.schedule({ jobId: "cj-4", urgency: "urgent", estimatedRuntimeMs: 60_000 });
  check("cost-scheduler: SLA beats cost — expensive-but-fast region chosen when the cheap one is congested",
    ds.decision === "run" && ds.regionId === "us" && ds.workerId === "w-us", `${ds.decision} ${ds.regionId}`);
});
// == 9. autoscaler + worker pool: scale on queue depth, cap, idle drain ======
await section("autoscaler", async () => {
  const pool = createWorkerPoolManager({
    poolId: "dp-pool", minWorkers: 1, maxWorkers: 3,
    workerFactory: async ({ workerId }) => ({ workerId, concurrency: 1, close: async () => {}, getActiveJobsCount: async () => 0 }),
  });
  await pool.ready;
  let metrics = { queueDepth: 0, oldestJobAgeMs: 0, activeJobs: 0, workerCount: pool.stats().size, workerUtilization: 0, regionalWorkerCount: pool.stats().size };
  let at = 1_000_000;
  const scaler = createAutoscaler({
    poolManager: pool, getMetrics: async () => metrics, clock: { now: () => at },
    policy: {
      minWorkers: 1, maxWorkers: 3, maxWorkersPerRegion: null, evaluateIntervalMs: 1000,
      scaleUp: { queueDepthPerWorker: 4, oldestJobAgeMs: 30_000, utilization: 0.8, sustainMs: 0, cooldownMs: 0, step: 2 },
      scaleDown: { utilization: 0.25, queueDepth: 0, sustainMs: 0, cooldownMs: 0, step: 1 },
      idle: { idleAfterMs: 0 },
    },
  });
  check("autoscaler: pool boots at minWorkers", pool.stats().size === 1, `size=${pool.stats().size}`);
  metrics = { ...metrics, queueDepth: 12 };
  const up = await scaler.evaluate();
  check("autoscaler: queue depth 12 on 1 worker (≥4 per worker) → scale-up applied to the pool",
    up.action === "scale-up" && up.applied?.changed === 2 && pool.stats().size === 3, `delta=${up.delta} size=${pool.stats().size}`);
  metrics = { ...metrics, queueDepth: 48, workerCount: pool.stats().size };
  const capped = await scaler.evaluate();
  check("autoscaler: hard maxWorkers cap — further demand holds at 'pool-max', never overprovisions",
    capped.action === "hold" && capped.reasons.includes("pool-max") && pool.stats().size === 3, capped.reasons.join(","));
  metrics = { queueDepth: 0, oldestJobAgeMs: 0, activeJobs: 0, workerCount: 3, workerUtilization: 0, regionalWorkerCount: 3 };
  at += 60_000; const down = await scaler.evaluate();
  check("autoscaler: fully idle pool drains toward minWorkers (scale-down applied)",
    down.action === "scale-down" && pool.stats().size === 2, `delta=${down.delta} size=${pool.stats().size}`);
  await pool.close();
});
// == summary ================================================================
fs.rmSync(tmpRoot, { recursive: true, force: true });
const pass = results.filter(Boolean).length; const fail = results.length - pass;
console.log(`\n== distributed plane: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
