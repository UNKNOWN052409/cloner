#!/usr/bin/env node
// Multi-region failover tests (task 4.2.9) — injected REAL region failures.
//
//   Part A (always runs, zero Redis): the in-memory store backend drives the
//   full failover lifecycle with INJECTED region failures:
//     • region-down via genuine heartbeat loss (beating stops; TTL expires —
//       the exact signal a crashed region produces; nothing is faked)
//     • region-down via ops force-down (planned failover)
//     • job re-route to the least-loaded HEALTHY region, actually RE-EXECUTED
//       through the real clone queue (src/queues/clone-queue.js, memory backend)
//     • terminal jobs never re-routed
//     • artifact re-replication of REAL artifact trees (createArtifactStore),
//       sha256-verified file-by-file, marker manifest written, source intact
//     • partial-failure recovery: mid-copy crash (failAfter/failOn injection —
//       the test-only seams, same posture as clone-queue's bullmqFactory),
//       file-level resume (intact files skipped, not re-copied), corrupted
//       replica repair, blocked-target (replicate INTO a down region is
//       refused) resumed on recovery, dispatch-failure retry, no-healthy-
//       region deferral drained on recovery, capacity-aware target selection
//     • deterministic TTL boundary via injected clock
//
//   Part B (real Redis, CLONER_REDIS_URL / REDIS_URL): heartbeats with a REAL
//   server-side TTL (SETTEX) observed by a SECOND controller instance —
//   cross-process visibility, physical key expiry on the Redis server, and
//   assignment/replica-ledger durability across instances.
//
//   Part C: the real HTTP ops surface (failoverRoutes on a live express app).
//
// Usage: node scripts/test-failover.mjs
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, detail = "") => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

const {
  createFailoverController, createQueueDispatcher, failoverRoutes, sha256File,
  resolveRedisUrl,
} = await import("../src/distributed/failover.js");
const { createCloneQueue } = await import("../src/queues/clone-queue.js");
const { createArtifactStore } = await import("../src/storage/artifact-store.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "failover-test-"));
const cleanupDirs = [TMP];
const regionDir = (name) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// build a REAL artifact tree with the project's real artifact store
function seedArtifacts(root, jobId, extra = {}) {
  const store = createArtifactStore(root, jobId);
  store.writeJson("manifest.json", { jobId, source: "https://failover.test/app", pages: 2, ...extra });
  store.writeText("pages/index.html", "<html><body>index of " + jobId + "</body></html>\n");
  store.writeText("pages/about.html", "<html><body>about " + jobId + "</body></html>\n");
  store.writeBinary("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, jobId.length & 0xff, 0x00, 0x01, 0x02]));
  store.writeText("assets/app.js", "console.log('bundled " + jobId + "');\n".repeat(40));
  return store.dirs.root;
}

const listFiles = (root, rel = "") => {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".failover-replica.json") continue;
    const child = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(root, child));
    else if (ent.isFile()) out.push(child);
  }
  return out.sort();
};

const controllers = [];
function makeController(opts = {}) {
  const c = createFailoverController(opts);
  controllers.push(c);
  return c;
}

async function destroyAll() {
  for (const c of controllers) { try { await c.destroy(); } catch { /* ignore */ } }
}

process.on("exit", () => {
  for (const dir of cleanupDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ============================================================================
console.log("\n-- Part A: memory backend — injected region failures --");
// ============================================================================

// ---- A1: registration + heartbeat + healthy selection ----
{
  const c = makeController({ redisUrl: "" });
  check("A0: no REDIS_URL → memory backend", c.backend === "memory");
  const rootA = regionDir("a1-east");
  const rootB = regionDir("a1-west");
  await c.registerRegion({ regionId: "east", storageRoot: rootA, capacity: 5 });
  await c.registerRegion({ regionId: "west", storageRoot: rootB, capacity: 5 });
  await c.heartbeat("east");
  await c.heartbeat("west");
  let snap = await c.check();
  const east = snap.regions.find((r) => r.regionId === "east");
  const west = snap.regions.find((r) => r.regionId === "west");
  check("A1: both regions healthy after heartbeat + sweep", east?.state === "healthy" && west?.state === "healthy",
    `east=${east?.state} west=${west?.state}`);
  const healthy = await c.healthyRegions();
  check("A1: healthyRegions lists both", healthy.length === 2, JSON.stringify(healthy.map((r) => r.regionId)));
  check("A1: storage roots really created", fs.existsSync(rootA) && fs.existsSync(rootB));

  // heartbeat without registration must be refused (clean error, no silent state)
  let refused = false;
  try { await c.heartbeat("atlantis"); } catch { refused = true; }
  check("A1: heartbeat for unknown region refused with clean error", refused);
}

// ---- A2: region-down detection via REAL heartbeat loss ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 150 });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a2-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a2-west") });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.check(); // both observed healthy

  const events = [];
  c.on("region-down", (e) => events.push({ ...e, regionId: e.regionId }));

  // INJECTED FAILURE: east stops heartbeating (a real crash produces exactly
  // this) while west keeps beating like every healthy region does
  await sleep(150 + 80);
  await c.heartbeat("west");
  const snap = await c.check();
  check("A2: heartbeat loss → east down, west still healthy",
    snap.regions.find((r) => r.regionId === "east")?.state === "down" &&
    snap.regions.find((r) => r.regionId === "west")?.state === "healthy");
  check("A2: region-down event fired exactly once for east", events.length === 1 && events[0].regionId === "east",
    JSON.stringify(events));
  check("A2: sweep action recorded", snap.actions.some((a) => a.type === "region-down" && a.regionId === "east"));
}

// ---- A3: job re-route to healthy region, really re-executed through the real queue ----
{
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 4 });
  await q.ready;
  const executed = [];
  const c = makeController({
    redisUrl: "",
    heartbeatTtlMs: 150,
    // REAL handoff: re-routed executions go through the real clone queue; the
    // run closure comes from the (simulated) target region's worker registry
    dispatch: createQueueDispatcher(q, (job) => {
      const base = job.jobId.split("::")[0];
      return async ({ entry, report }) => {
        executed.push(base);
        report("exploring", { progress: 25 });
        await sleep(15);
        report("reconstructing", { progress: 70 });
        await sleep(5);
        entry.status = "completed"; // the run closure owns the entry (queue contract)
        return { ok: true, rerouted: true };
      };
    }),
  });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a3-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a3-west") });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.check();

  await c.assignJob("task-1", "east", { status: "queued", payload: { url: "https://failover.test" } });
  await c.assignJob("task-2", "east", { status: "running", payload: { url: "https://failover.test/2" } });
  await c.assignJob("task-3", "east", { status: "completed", payload: { url: "https://failover.test/3" } });

  await sleep(150 + 80); // east heartbeat lost (west keeps beating)
  await c.heartbeat("west");
  const snap = await c.check();

  const j1 = await c.getJobAssignment("task-1");
  const j2 = await c.getJobAssignment("task-2");
  const j3 = await c.getJobAssignment("task-3");
  check("A3: queued task re-routed east→west", j1.region === "west" && !j1.pendingReroute, JSON.stringify(j1.reroutes));
  check("A3: running task re-routed east→west", j2.region === "west");
  check("A3: terminal (completed) task NOT re-routed", j3.region === "east", `region=${j3.region}`);
  check("A3: reroute reason records region-down", j1.reroutes[0]?.reason === "region-down:east" && j1.reroutes[0]?.from === "east" && j1.reroutes[0]?.to === "west");

  // re-routed tasks really executed through the real queue, to completion
  await q.whenIdle();
  const entry1 = q.getJob(j1.reroutes[0].queueEntryId);
  const entry2 = q.getJob(j2.reroutes[0].queueEntryId);
  check("A3: re-routed executions ran on the real queue and completed",
    entry1?.status === "completed" && entry2?.status === "completed",
    `t1=${entry1?.status} t2=${entry2?.status}`);
  check("A3: both re-routed tasks actually executed exactly once",
    executed.filter((x) => x === "task-1").length === 1 && executed.filter((x) => x === "task-2").length === 1,
    JSON.stringify(executed));
  check("A3: re-routed queue entry carries failover lineage (id + original url)",
    String(j1.reroutes[0]?.queueEntryId).startsWith("task-1::failover-") && entry1?.url === "https://failover.test",
    `entryId=${j1.reroutes[0]?.queueEntryId} url=${entry1?.url}`);

  // idempotence: a second sweep must not re-route again
  await c.check();
  const j1b = await c.getJobAssignment("task-1");
  check("A3: second sweep is idempotent (no double reroute)", j1b.region === "west" && j1b.reroutes.length === 1);
  await q.close();
}

// ---- A4: artifact re-replication TRIGGER on region-down (terminal jobs included) ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 150 });
  const rootA = regionDir("a4-east");
  const rootB = regionDir("a4-west");
  await c.registerRegion({ regionId: "east", storageRoot: rootA });
  await c.registerRegion({ regionId: "west", storageRoot: rootB });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.check();

  seedArtifacts(rootA, "done-task");
  seedArtifacts(rootA, "run-task");
  await c.assignJob("done-task", "east", { status: "completed", artifactRel: "done-task" });
  await c.assignJob("run-task", "east", { status: "running", artifactRel: "run-task" });

  await sleep(150 + 80); // east heartbeat lost (west keeps beating)
  await c.heartbeat("west");
  const snap = await c.check();

  const replDone = await c.getReplicaLedger("done-task");
  const replRun = await c.getReplicaLedger("run-task");
  check("A4: completed task's artifacts re-replicated on region-down",
    replDone?.replicas?.west?.state === "replicated", JSON.stringify(replDone?.replicas));
  check("A4: running task's artifacts re-replicated on region-down",
    replRun?.replicas?.west?.state === "replicated");
  const copiedDone = listFiles(path.join(rootB, "done-task"));
  const copiedRun = listFiles(path.join(rootB, "run-task"));
  check("A4: every artifact file exists in the healthy region",
    copiedDone.length === 5 && copiedRun.length === 5, JSON.stringify(copiedDone));
  const vDone = await c.verifyReplica("done-task", "west");
  const vRun = await c.verifyReplica("run-task", "west");
  check("A4: sha256 verification of both replicas passes", vDone.ok === true && vRun.ok === true,
    JSON.stringify({ done: vDone, run: vRun }));
  check("A4: source artifacts untouched", listFiles(path.join(rootA, "done-task")).length === 5);
  const marker = JSON.parse(fs.readFileSync(path.join(rootB, "done-task", ".failover-replica.json"), "utf8"));
  check("A4: on-disk replica manifest records source region + file digests",
    marker.sourceRegion === "east" && marker.targetRegion === "west" && marker.files.length === 5 &&
    marker.files.every((f) => f.sha256 === sha256File(path.join(rootB, "done-task", f.rel))),
    `files=${marker.files.length}`);
  check("A4: replication actions recorded in sweep",
    snap.actions.some((a) => a.type === "replication-replicated" && a.jobId === "done-task"));

  // idempotence: next sweep must NOT re-replicate what already has a healthy replica
  const before = (await c.getReplicaLedger("done-task")).replicas.west.attempts;
  await c.check();
  const after = (await c.getReplicaLedger("done-task")).replicas.west.attempts;
  check("A4: sweep is idempotent — healthy replica is not re-copied", before === after, `attempts ${before}→${after}`);
}

// ---- A5: partial-failure recovery — interrupted copy resumes at file level ----
{
  const c = makeController({ redisUrl: "" });
  const rootA = regionDir("a5-east");
  const rootB = regionDir("a5-west");
  await c.registerRegion({ regionId: "east", storageRoot: rootA });
  await c.registerRegion({ regionId: "west", storageRoot: rootB });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("p1", "east", { status: "completed", artifactRel: "p1" });
  seedArtifacts(rootA, "p1");

  // INJECTED mid-copy crash: the real on-disk result of a real crash (partial dir)
  const partial = await c.replicateJobArtifacts("p1", "east", "west", { failAfter: 2 });
  check("A5: interrupted copy reports partial + error", partial.state === "partial" && typeof partial.error === "string" && partial.copied === 2,
    JSON.stringify(partial));
  const ledger = await c.getReplicaLedger("p1");
  check("A5: ledger records partial state", ledger.replicas.west.state === "partial");
  check("A5: on-disk state after crash = partial dir with exactly the copied files",
    listFiles(path.join(rootB, "p1")).length === 2, JSON.stringify(listFiles(path.join(rootB, "p1"))));

  // recovery: resume — intact files must be SKIPPED, not re-copied
  const resumed = await c.replicateJobArtifacts("p1", "east", "west");
  check("A5: resume completes replication", resumed.state === "replicated");
  check("A5: resume is file-level — 2 intact files skipped, 3 copied",
    resumed.skipped === 2 && resumed.copied === 3, JSON.stringify({ copied: resumed.copied, skipped: resumed.skipped }));
  const v = await c.verifyReplica("p1", "west");
  check("A5: resumed replica verifies byte-identical", v.ok === true && v.files === 5, JSON.stringify(v));

  // corrupted-replica repair: delete one file, truncate another → resume repairs both
  fs.rmSync(path.join(rootB, "p1", "pages", "about.html"));
  fs.writeFileSync(path.join(rootB, "p1", "assets", "app.js"), "truncated");
  const repaired = await c.replicateJobArtifacts("p1", "east", "west");
  check("A5: corrupted replica repaired (2 re-copied, 3 skipped)",
    repaired.state === "replicated" && repaired.copied === 2 && repaired.skipped === 3,
    JSON.stringify({ copied: repaired.copied, skipped: repaired.skipped }));
  check("A5: repaired replica verifies clean", (await c.verifyReplica("p1", "west")).ok === true);

  // negative verification is honest
  fs.writeFileSync(path.join(rootB, "p1", "pages", "index.html"), "TAMPERED");
  const bad = await c.verifyReplica("p1", "west");
  check("A5: tampered replica FAILS verification (mismatch named)",
    bad.ok === false && bad.mismatched.includes("pages/index.html"), JSON.stringify(bad));
  fs.writeFileSync(path.join(rootB, "p1", "pages", "index.html"), "<html><body>index of p1</body></html>\n");
}

// ---- A6: automatic recovery by the sweep (partial via failAfter injection) ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 60000 }); // no region-down here — only reconciliation is under test
  const rootA = regionDir("a6-east");
  const rootB = regionDir("a6-west");
  await c.registerRegion({ regionId: "east", storageRoot: rootA });
  await c.registerRegion({ regionId: "west", storageRoot: rootB });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("p2", "east", { status: "completed", artifactRel: "p2" });
  seedArtifacts(rootA, "p2");

  const partial = await c.replicateJobArtifacts("p2", "east", "west", { failAfter: 3 });
  check("A6: failAfter injection aborts mid-copy (partial)", partial.state === "partial" && partial.copied === 3, JSON.stringify(partial));

  const events = [];
  c.on("replication-complete", (e) => events.push(e));
  const snap = await c.check(); // sweep reconciles partials on its own
  const ledger = await c.getReplicaLedger("p2");
  check("A6: sweep auto-resumes the interrupted copy to replicated",
    ledger.replicas.west.state === "replicated", JSON.stringify(ledger.replicas.west));
  check("A6: sweep action records the resume", snap.actions.some((a) => a.type === "replication-resumed-replicated" && a.jobId === "p2"));
  check("A6: resume copied only the missing files (skips the 3 intact ones)",
    snap.actions.find((a) => a.type === "replication-resumed-replicated")?.skipped === 3,
    JSON.stringify(snap.actions));
  check("A6: replication-complete event emitted", events.some((e) => e.jobId === "p2"));
}

// ---- A7: blocked target (replicate INTO a down region) resumed on recovery ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 150 });
  const rootA = regionDir("a7-east");
  const rootB = regionDir("a7-west");
  await c.registerRegion({ regionId: "east", storageRoot: rootA });
  await c.registerRegion({ regionId: "west", storageRoot: rootB });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("p3", "east", { status: "completed", artifactRel: "p3" });
  seedArtifacts(rootA, "p3");

  // INJECTED FAILURE: west goes down (heartbeat loss)
  await sleep(150 + 80);
  await c.check(); // west observed down
  const blocked = await c.replicateJobArtifacts("p3", "east", "west");
  check("A7: replication INTO a down region is refused (blocked), not half-done",
    blocked.state === "blocked" && blocked.reason === "region-down", JSON.stringify(blocked));
  const ledger1 = await c.getReplicaLedger("p3");
  check("A7: ledger records the blocked target", ledger1.replicas.west.state === "blocked");
  check("A7: nothing was copied to the down region", !fs.existsSync(path.join(rootB, "p3", "pages")));

  // west recovers (heartbeats again)
  await c.heartbeat("west");
  const snap = await c.check();
  const ledger2 = await c.getReplicaLedger("p3");
  check("A7: recovery sweep resumes the blocked replica to replicated",
    ledger2.replicas.west.state === "replicated", JSON.stringify(ledger2.replicas.west));
  check("A7: replica on recovered region verifies", (await c.verifyReplica("p3", "west")).ok === true);
  check("A7: sweep recorded the resume action",
    snap.actions.some((a) => a.type === "replication-resumed-replicated" && a.jobId === "p3"));
}

// ---- A8: dispatch failure → retry on next sweep (bounded) ----
{
  let failFirst = true;
  let dispatchCalls = 0;
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 4 });
  await q.ready;
  const c = makeController({
    redisUrl: "",
    heartbeatTtlMs: 150,
    dispatch: async (ctx) => {
      dispatchCalls++;
      if (failFirst) throw new Error("injected dispatch outage (attempt 1)");
      return createQueueDispatcher(q, () => async ({ report }) => { report("completed"); return { ok: true }; })(ctx);
    },
  });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a8-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a8-west") });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("task-9", "east", { status: "queued" });
  await sleep(150 + 80);

  await c.heartbeat("west"); // healthy region keeps beating
  const s1 = await c.check();
  const j1a = await c.getJobAssignment("task-9");
  check("A8: dispatch outage → reroute failed on attempt 1, job stays pending on east",
    j1a.region === "east" && j1a.pendingReroute === true && j1a.rerouteAttempts === 1 &&
    String(j1a.lastRerouteError).includes("injected dispatch outage"),
    JSON.stringify({ region: j1a.region, pending: j1a.pendingReroute, attempts: j1a.rerouteAttempts }));
  check("A8: sweep recorded reroute-failed", s1.actions.some((a) => a.type === "reroute-failed" && a.jobId === "task-9"));

  failFirst = false;
  await c.heartbeat("west"); // still beating on the next sweep
  await c.check();
  const j1b = await c.getJobAssignment("task-9");
  check("A8: retry on next sweep completes the reroute",
    j1b.region === "west" && j1b.pendingReroute === false && j1b.rerouteAttempts === 2,
    JSON.stringify({ region: j1b.region, attempts: j1b.rerouteAttempts }));
  check("A8: dispatcher called exactly twice (1 fail + 1 success)", dispatchCalls === 2, `calls=${dispatchCalls}`);
  await q.close();
}

// ---- A9: no healthy region → deferral, drained on recovery ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 150 });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a9-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a9-west") });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("task-10", "east", { status: "queued" });

  // INJECTED double failure: east heartbeat loss AND ops force-down of west
  await c.forceDown("west");
  await sleep(150 + 80);
  const snap = await c.check();
  const j = await c.getJobAssignment("task-10");
  check("A9: no healthy region → reroute DEFERRED, job stays assigned",
    j.region === "east" && j.pendingReroute === true && j.reroutes.length === 0,
    JSON.stringify({ region: j.region, pending: j.pendingReroute }));
  check("A9: deferral action recorded", snap.actions.some((a) => a.type === "reroute-deferred"));
  check("A9: force-down reflected in region state", snap.regions.find((r) => r.regionId === "west")?.state === "down");

  // recovery: west force-up + heartbeat → backlog drains automatically
  await c.forceUp("west");
  await c.heartbeat("west");
  const snap2 = await c.check();
  const j2 = await c.getJobAssignment("task-10");
  check("A9: reroute backlog drains to the recovered region",
    j2.region === "west" && j2.pendingReroute === false,
    JSON.stringify({ region: j2.region, pending: j2.pendingReroute }));
  check("A9: backlog-drain action recorded",
    snap2.actions.some((a) => a.type === "reroute-backlog-drained" && a.drained === 1));
}

// ---- A10: capacity-aware target selection ----
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 150 });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a10-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a10-west"), capacity: 1 });
  await c.registerRegion({ regionId: "south", storageRoot: regionDir("a10-south") });
  for (const r of ["east", "west", "south"]) await c.heartbeat(r);
  await c.assignJob("busy-1", "west", { status: "running" }); // fills west to capacity 1
  await c.assignJob("task-11", "east", { status: "queued" });
  await c.assignJob("task-12", "east", { status: "running" });

  await sleep(150 + 80); // east heartbeat lost (west + south keep beating)
  await c.heartbeat("west");
  await c.heartbeat("south");
  await c.check();
  const t11 = await c.getJobAssignment("task-11");
  const t12 = await c.getJobAssignment("task-12");
  check("A10: full region (capacity) is never a reroute target — both jobs land on south",
    t11.region === "south" && t12.region === "south",
    `t11=${t11.region} t12=${t12.region}`);
}

// ---- A11: deterministic TTL boundary via injected clock ----
{
  let now = 1_000_000;
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 1000, clock: () => now });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a11-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a11-west") });
  await c.heartbeat("east"); // ts = 1_000_000
  await c.heartbeat("west");
  await c.check();

  const states = [];
  c.on("region-down", (e) => states.push("down:" + e.regionId));
  c.on("region-recovered", (e) => states.push("recovered:" + e.regionId));

  now += 999; // still fresh (age 999 <= ttl 1000)
  let snap = await c.check();
  check("A11: beat aged 999ms inside TTL=1000 stays healthy",
    snap.regions.find((r) => r.regionId === "east")?.state === "healthy");

  now += 2; // age 1001 > ttl → down
  snap = await c.check();
  check("A11: beat aged 1001ms past TTL=1000 is down", snap.regions.find((r) => r.regionId === "east")?.state === "down");
  check("A11: region-down fired once across the boundary", states.filter((s) => s === "down:east").length === 1);

  now += 5000;
  await c.heartbeat("east"); // fresh beat at the new clock
  snap = await c.check();
  check("A11: fresh beat after loss → recovered",
    snap.regions.find((r) => r.regionId === "east")?.state === "healthy" &&
    states.filter((s) => s === "recovered:east").length === 1, JSON.stringify(states));
}

// ---- A12: reroute attempts are bounded; exhaustion is recorded, not silent ----
{
  let calls = 0;
  const c = makeController({
    redisUrl: "",
    heartbeatTtlMs: 150,
    maxRerouteAttempts: 2,
    dispatch: async () => { calls++; throw new Error("dispatch permanently unavailable (injected)"); },
  });
  await c.registerRegion({ regionId: "east", storageRoot: regionDir("a12-east") });
  await c.registerRegion({ regionId: "west", storageRoot: regionDir("a12-west") });
  await c.heartbeat("east");
  await c.heartbeat("west");
  await c.assignJob("task-13", "east", { status: "queued" });
  await sleep(150 + 80);

  await c.heartbeat("west"); // healthy region keeps beating through every sweep
  await c.check(); // attempt 1 → failed, pending
  await c.heartbeat("west");
  await c.check(); // attempt 2 → failed, pending
  await c.heartbeat("west");
  await c.check(); // attempt 3 (> max 2) → exhausted, marked failed
  const j = await c.getJobAssignment("task-13");
  check("A12: reroute exhausts bounded attempts and is recorded as failed",
    j.rerouteFailed?.error?.includes("dispatch permanently unavailable") === true && j.pendingReroute === false &&
    j.rerouteAttempts === 3,
    JSON.stringify({ attempts: j.rerouteAttempts, failed: j.rerouteFailed }));
  check("A12: dispatch attempted exactly maxRerouteAttempts times (exhaustion is bookkeeping, not a dispatch)",
    calls === 2, `calls=${calls}`);
  const status = await c.status();
  check("A12: ops snapshot exposes the failed reroute",
    status.jobs.find((x) => x.jobId === "task-13")?.rerouteFailed != null);
}

// ============================================================================
console.log("\n-- Part B: real Redis backend (cross-process heartbeat loss) --");
// ============================================================================
{
  const redisUrl = resolveRedisUrl();
  let raw = null;
  let reachable = false;
  if (redisUrl) {
    try {
      const mod = await import("ioredis");
      raw = new mod.default(redisUrl, { lazyConnect: true, connectTimeout: 2000, retryStrategy: () => null, enableOfflineQueue: false });
      raw.on("error", () => {});
      await raw.connect();
      reachable = true;
    } catch { reachable = false; }
  }
  if (!reachable) {
    skip("Part B", "Redis unreachable — set CLONER_REDIS_URL/REDIS_URL to run cross-process checks");
  } else {
    try {
      const keys = await raw.keys("cloner:region:*");
      if (keys.length) await raw.del(...keys);

      const rootA = regionDir("b1-east");
      const rootB = regionDir("b1-west");
      // TTL 1000ms on purpose: Redis SETEX granularity is whole seconds, so the
      // physical-expiry assertion below needs the server TTL to equal the window
      const c1 = makeController({ redisUrl, heartbeatTtlMs: 1000 });
      const c2 = makeController({ redisUrl, heartbeatTtlMs: 1000 }); // a SECOND process stand-in
      await c1.ready;
      await c2.ready;
      check("B1: controllers resolved the REAL redis backend", c1.backend === "redis" && c2.backend === "redis",
        `${c1.backend}/${c2.backend}`);

      // both processes know the region topology (deployment config); only the
      // operational state is shared through Redis
      for (const c of [c1, c2]) {
        await c.registerRegion({ regionId: "east", storageRoot: rootA });
        await c.registerRegion({ regionId: "west", storageRoot: rootB });
      }
      await c1.heartbeat("east");
      await c1.heartbeat("west");

      const rawHb = await raw.get("cloner:region:heartbeat:east");
      check("B1: heartbeat is a REAL Redis key (readable by any process)", !!rawHb && JSON.parse(rawHb).regionId === "east");

      const snap = await c2.check(); // c2 observes c1's heartbeats through Redis
      check("B1: second instance sees both regions healthy (cross-process)",
        snap.regions.find((r) => r.regionId === "east")?.state === "healthy" &&
        snap.regions.find((r) => r.regionId === "west")?.state === "healthy");

      // INJECTED FAILURE: c1 stops heartbeating east → REAL server-side TTL expiry
      await sleep(1000 + 300); // past the 1s server-side TTL
      const expired = await raw.get("cloner:region:heartbeat:east");
      check("B1: Redis server physically expired the dead region's heartbeat key", expired === null);
      await c1.heartbeat("west"); // west keeps beating through c1
      const snap2 = await c2.check();
      const eastState = snap2.regions.find((r) => r.regionId === "east")?.state;
      check("B1: second instance detects region-down via heartbeat loss",
        eastState !== "healthy" && eastState !== null &&
        snap2.actions.some((a) => a.type === "region-down" && a.regionId === "east") &&
        snap2.regions.find((r) => r.regionId === "west")?.state === "healthy",
        `east=${eastState} actions=${JSON.stringify(snap2.actions.map((a) => a.type))}`);

      // durable ledger state across instances (re-beat first — the injected
      // failure above expired both heartbeat keys)
      await c1.heartbeat("east");
      await c1.heartbeat("west");
      seedArtifacts(rootA, "b-task");
      await c1.assignJob("b-task", "east", { status: "completed", artifactRel: "b-task" });
      const rep = await c1.replicateJobArtifacts("b-task", "east", "west");
      check("B2: replication through real Redis completes", rep.state === "replicated", JSON.stringify(rep));
      const seenFromC2 = await c2.getReplicaLedger("b-task");
      const assignmentFromC2 = await c2.getJobAssignment("b-task");
      check("B2: replica ledger durable across instances (c2 reads what c1 wrote)",
        seenFromC2?.replicas?.west?.state === "replicated", JSON.stringify(seenFromC2?.replicas));
      check("B2: job assignment durable across instances",
        assignmentFromC2?.region === "east" && assignmentFromC2?.artifactRel === "b-task");

      const v = await c2.verifyReplica("b-task", "west");
      check("B2: second instance verifies the replica on disk", v.ok === true && v.files === 5, JSON.stringify(v));

      await raw.del(...(await raw.keys("cloner:region:*")));
    } finally {
      try { await raw.quit(); } catch { try { raw.disconnect(); } catch { /* ignore */ } }
    }
  }
}

// ============================================================================
console.log("\n-- Part C: real HTTP ops surface (express + failoverRoutes) --");
// ============================================================================
{
  const c = makeController({ redisUrl: "", heartbeatTtlMs: 5000 }); // generous TTL: Part C states are driven via the ops endpoints
  const app = express();
  app.use(express.json());
  app.use("/api/distributed", failoverRoutes({ controller: c }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/distributed`;
  const j = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  };

  try {
    const rootA = regionDir("c1-east");
    const rootB = regionDir("c1-west");

    const list0 = await j("GET", "/regions");
    check("C1: GET /regions on empty registry", list0.status === 200 && list0.json.backend === "memory" && list0.json.regions.length === 0);

    const reg = await j("POST", "/regions", { regionId: "east", storageRoot: rootA, capacity: 4 });
    check("C1: POST /regions registers a real region", reg.status === 201 && reg.json.state === "unknown" && fs.existsSync(rootA));
    await j("POST", "/regions", { regionId: "west", storageRoot: rootB });

    const badHb = await j("POST", "/regions/atlantis/heartbeat", {});
    check("C1: heartbeat for unknown region → 404", badHb.status === 404);
    const hb = await j("POST", "/regions/east/heartbeat", { status: "running" });
    check("C1: POST heartbeat → 202 with snapshot", hb.status === 202 && typeof hb.json.ts === "number" && hb.json.regionId === "east");
    await j("POST", "/regions/west/heartbeat", {});

    // seed a completed task with artifacts on east
    seedArtifacts(rootA, "c-task");
    await c.assignJob("c-task", "east", { status: "completed", artifactRel: "c-task" });

    const tick = await j("POST", "/failover/tick", {});
    check("C1: POST /failover/tick returns sweep", tick.status === 200 && Array.isArray(tick.json.actions) && tick.json.regions.length === 2);

    // INJECTED FAILURE via ops endpoint: force east down → immediate failover sweep
    const down = await j("POST", "/regions/east/down", {});
    check("C1: POST /regions/east/down → region down + failover actions",
      down.status === 200 && down.json.region.state === "down" && down.json.actions.some((a) => a.type === "region-down"),
      JSON.stringify(down.json.actions));
    const replicas = await j("GET", "/replicas");
    check("C1: artifact re-replication visible via GET /replicas",
      replicas.json.replicas.find((r) => r.jobId === "c-task")?.replicas?.west?.state === "replicated",
      JSON.stringify(replicas.json.replicas));
    const jobsList = await j("GET", "/jobs");
    check("C1: GET /jobs exposes assignment ledger", jobsList.status === 200 && jobsList.json.jobs.length === 1);

    const verify = await j("GET", "/replicas/c-task/verify/west");
    check("C1: GET verify endpoint sha256-passes the replica", verify.status === 200 && verify.json.ok === true && verify.json.files === 5);

    const up = await j("POST", "/regions/east/up", {});
    check("C1: POST /regions/east/up clears the manual-down flag",
      up.status === 200 && up.json.manualDown === false,
      JSON.stringify({ state: up.json?.state, manualDown: up.json?.manualDown }));
    await j("POST", "/regions/east/heartbeat", {});
    const afterUp = await j("GET", "/regions");
    check("C1: east healthy again after up + fresh heartbeat",
      afterUp.json.regions.find((r) => r.regionId === "east")?.state === "healthy");

    const manualRep = await j("POST", "/replicas/c-task/replicate", { fromRegion: "east", toRegion: "west" });
    check("C1: manual replicate endpoint → 201 replicated (idempotent re-verify)",
      manualRep.status === 201 && manualRep.json.state === "replicated", JSON.stringify(manualRep.json));
    const badRep = await j("POST", "/replicas/c-task/replicate", { fromRegion: "east" });
    check("C1: replicate without target → 400", badRep.status === 400);
    const status = await j("GET", "/status");
    check("C1: GET /status returns the full ops snapshot",
      status.status === 200 && status.json.config.heartbeatTtlMs === 5000 && Array.isArray(status.json.recentActions));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // guard: the surface can be locked behind middleware (admin deployments)
  const c2 = makeController({ redisUrl: "" });
  const app2 = express();
  app2.use(express.json());
  const opsToken = "failover-ops-test-token"; // test-local guard token (simulates the admin middleware)
  const guard = (req, res, next) => (req.headers["x-ops-token"] === opsToken ? next() : res.status(403).json({ error: "forbidden" }));
  app2.use("/api/distributed", failoverRoutes({ controller: c2, guard }));
  const server2 = app2.listen(0, "127.0.0.1");
  await new Promise((resolve) => server2.once("listening", resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}/api/distributed`;
  try {
    const denied = await fetch(base2 + "/regions");
    const allowed = await fetch(base2 + "/regions", { headers: { "x-ops-token": opsToken } });
    check("C2: guard middleware locks the surface (403 without token, 200 with)",
      denied.status === 403 && allowed.status === 200, `${denied.status}/${allowed.status}`);
  } finally {
    await new Promise((resolve) => server2.close(resolve));
  }
}

// ---- teardown ----
await destroyAll();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\nRESULT: ${failed ? "FAIL" : "PASS"}  (${passed}/${results.length} checks${failed ? `, ${failed} failed` : ""})`);
process.exit(failed ? 1 : 0);
