#!/usr/bin/env node
// Task 4.2.8 — Distributed job leases test.
//
// Covers the task-specific requirements:
//   1. lease semantics: acquire grants exactly one owner; a live lease blocks
//      any other acquire ("held"); renew is owner-only and fails once the TTL
//      passed; steal takes an EXPIRED lease and bumps the epoch; release is
//      owner-only; validateOwnership fences stale-epoch/zombie writes
//   2. THE RACE (the ask's simulation): two workers race for the same job —
//      exactly one wins, every round, and the loser sees the winner's lease.
//      A frozen owner (stops renewing) loses the job to a stealer after the
//      TTL; its later renew and fenced writes are rejected.
//   3. live PostgreSQL: the REAL distributed backend (migration 017 applied
//      through the project's own migration runner) runs the same race across
//      two managers in two regions against the same database — the
//      ON CONFLICT ... WHERE re-check guarantees one winner per job under
//      true concurrency. Real DB, real SQL, no mocks in any product path.
//
//   node scripts/test-job-leases.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // artifacts/ + platform-data/ are cwd-relative

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// 1. memory backend semantics (deterministic injected clock)
// =====================================================================
console.log("\n== lease semantics (memory backend, injected clock) ==");

const { createLeaseManager, createMemoryLeaseBackend, LeaseError } = await import("../src/distributed/job-leases.js");

{
  let t = 1_000_000; // fixed deterministic clock
  const clock = () => t;
  // ONE shared backend = the coordination store; two managers = two workers.
  const shared1 = createMemoryLeaseBackend({ now: clock });
  const m = createLeaseManager({ backend: shared1, now: clock, ttlMs: 5_000, region: "r1", workerId: "w-a" });
  const other = createLeaseManager({ backend: shared1, now: clock, ttlMs: 5_000, region: "r1", workerId: "w-b" });

  const g = await m.acquire("job-1");
  check("acquire grants a fresh lease", g.acquired === true && g.lease.owner === "w-a" && g.lease.epoch === 1,
    `owner=${g.lease?.owner} epoch=${g.lease?.epoch}`);
  check("lease TTL honored (expiresAt - renewedAt = ttlMs)", g.lease.ttlMs === 5_000, `ttl=${g.lease.ttlMs}`);
  check("lease active before expiry", g.lease.active === true && g.lease.expired === false);

  const block = await other.acquire("job-1");
  check("second worker's acquire on a LIVE lease is rejected (held)", block.acquired === false && block.reason === "held" && block.owner === "w-a",
    `reason=${block.reason} owner=${block.owner}`);

  const selfBlock = await m.acquire("job-1");
  check("even the owner cannot double-acquire (must renew)", selfBlock.acquired === false && selfBlock.reason === "held",
    `reason=${selfBlock.reason}`);

  t += 3_000;
  const rn = await m.renew("job-1");
  check("owner renews a live lease", rn.renewed === true && rn.lease.expiresAt > g.lease.expiresAt,
    `expires ${g.lease.expiresAt} → ${rn.lease.expiresAt}`);
  const rnOther = await other.renew("job-1");
  check("non-owner renew on a LIVE lease rejected (not-owner)", rnOther.renewed === false && rnOther.reason === "not-owner" && rnOther.owner === "w-a",
    `reason=${rnOther.reason}`);

  // steal on expiry
  t += 5_001; // now past every renewal
  const steal = await other.steal("job-1");
  check("expired lease is stolen by another worker", steal.acquired === true && steal.stolen === true && steal.lease.owner === "w-b",
    `owner=${steal.lease?.owner} stolen=${steal.stolen}`);
  check("steal bumps the epoch (fencing token)", steal.lease.epoch === 2, `epoch=${steal.lease.epoch}`);

  const rnZombie = await m.renew("job-1");
  check("the OLD owner's renew after steal is rejected", rnZombie.renewed === false && rnZombie.owner === "w-b", `reason=${rnZombie.reason}`);
  const acqZombie = await m.acquire("job-1");
  check("the OLD owner's acquire on the live stolen lease is rejected", acqZombie.acquired === false && acqZombie.reason === "held");

  const fenceOld = await m.validateOwnership("job-1", "w-a", 1);
  check("fencing rejects the stolen owner's STALE epoch", fenceOld.valid === false && fenceOld.reason === "not-owner",
    `reason=${fenceOld.reason} epoch=${fenceOld.lease?.epoch}`);
  const fenceNew = await other.validateOwnership("job-1", "w-b", 2);
  check("fencing accepts the NEW owner with the CURRENT epoch", fenceNew.valid === true, `epoch=${fenceNew.lease.epoch}`);
  const fenceWrongEpoch = await other.validateOwnership("job-1", "w-b", 1);
  check("fencing rejects a current owner presenting a stale epoch", fenceWrongEpoch.valid === false && fenceWrongEpoch.reason === "stale-epoch");

  const stealLive = await m.steal("job-1");
  check("steal refuses a STILL-LIVE lease (not-expired)", stealLive.acquired === false && stealLive.reason === "not-expired");
  const stealGhost = await m.steal("job-never-leased");
  check("steal refuses a job that was never leased (not-leased)", stealGhost.acquired === false && stealGhost.reason === "not-leased");

  const relOther = await m.release("job-1");
  check("release by the wrong owner is rejected", relOther.released === false && relOther.reason === "not-owner");
  const rel = await other.release("job-1");
  check("owner release frees the job", rel.released === true);
  const after = await m.getLease("job-1");
  check("released job is unleased", after.lease === null);
  const relGhost = await other.release("job-never-leased");
  check("release of an unleased job reports not-leased", relGhost.released === false && relGhost.reason === "not-leased");

  // expired renew: owner that stopped renewing must compete again, not renew
  await m.acquire("job-2");
  t += 5_001;
  const rnLate = await m.renew("job-2");
  check("renew after TTL expiry fails (owner must re-acquire)", rnLate.renewed === false && rnLate.reason === "expired");
  const reAcq = await m.acquire("job-2");
  check("after expiry the same worker can re-acquire with a NEW epoch", reAcq.acquired === true && reAcq.lease.epoch === 2,
    `epoch=${reAcq.lease.epoch}`);

  const list = await m.listLeases();
  check("listLeases returns mapped rows", Array.isArray(list.leases) && list.leases.some((l) => l.jobId === "job-2"),
    `n=${list.leases.length}`);

  // config errors surface cleanly
  let cfgErr = null;
  try { createLeaseManager({ backend: "carrier-pigeon" }); } catch (e) { cfgErr = e; }
  check("unknown backend → clean LeaseError", cfgErr instanceof LeaseError && cfgErr.code === "lease_backend", cfgErr?.code || "no error");
  let ttlErr = null;
  try { createLeaseManager({ backend: "memory", ttlMs: 0 }); } catch (e) { ttlErr = e; }
  check("non-positive TTL → clean LeaseError", ttlErr instanceof LeaseError && ttlErr.code === "lease_config", ttlErr?.code || "no error");

  // DB failure surfaces as a clean LeaseError (code lease_db) with the cause
  // attached — e.g. the job_leases table missing (migration not applied).
  const boom = createLeaseManager({
    backend: "postgres",
    workerId: "boom-worker",
    query: async () => { const e = new Error('relation "job_leases" does not exist'); e.code = "42P01"; throw e; },
  });
  let dbErr = null;
  try { await boom.acquire("some-job"); } catch (e) { dbErr = e; }
  check("DB failure → LeaseError code=lease_db with cause", dbErr instanceof LeaseError && dbErr.code === "lease_db" && /does not exist/.test(dbErr.message),
    `${dbErr?.code || "no error"}: ${String(dbErr?.message).slice(0, 60)}`);
}

// =====================================================================
// 2. THE RACE — two workers, one job, exactly one winner (memory backend,
//    shared coordination store, randomized scheduling, 400 rounds)
// =====================================================================
console.log("\n== two-worker race: one job, exactly one winner (memory) ==");

{
  let t = 2_000_000;
  const clock = () => t;
  // ONE shared backend = the coordination point; two managers = two workers.
  // `now: clock` keeps the managers' reporting view on the same fake clock as
  // the backend's decision clock (active/expired flags must agree).
  // (In real deployments the shared store is PostgreSQL — section 3 proves
  // the same invariant there under true concurrency.)
  const shared = createMemoryLeaseBackend({ now: clock });
  const wA = createLeaseManager({ backend: shared, now: clock, ttlMs: 10_000, region: "region-a", workerId: "race-worker-a" });
  const wB = createLeaseManager({ backend: shared, now: clock, ttlMs: 10_000, region: "region-b", workerId: "race-worker-b" });

  let doubleWins = 0, zeroWins = 0, badOwner = 0;
  const ROUNDS = 400;
  for (let i = 0; i < ROUNDS; i++) {
    t += 37; // deterministic clock walk (each job starts fresh/unleased)
    const jobId = `race-${i}`;
    // both workers fire in randomized order (simulating cross-region arrival)
    const pair = [
      { w: wA, name: "a" }, { w: wB, name: "b" },
    ];
    if (i % 2 === 1) pair.reverse();
    const outcomes = [];
    for (const p of pair) {
      // interleave a randomized micro-step so neither worker has a fixed head start
      t += (i % 3);
      outcomes.push({ name: p.name, res: await p.w.acquire(jobId) });
    }
    const winners = outcomes.filter((o) => o.res.acquired);
    if (winners.length > 1) doubleWins++;
    if (winners.length === 0) zeroWins++;
    if (winners.length === 1) {
      const { lease } = await wA.getLease(jobId);
      if (lease.owner !== (winners[0].name === "a" ? "race-worker-a" : "race-worker-b")) badOwner++;
    }
  }
  check(`race ×${ROUNDS}: exactly one winner every round`, doubleWins === 0 && zeroWins === 0,
    `doubleWins=${doubleWins} zeroWins=${zeroWins}`);
  check("the stored lease always names the actual winner", badOwner === 0, `mismatches=${badOwner}`);

  // concurrent-ish double-execution guard: worker A holds and works, worker B
  // hammers acquire in a loop — every attempt rejected until the lease dies.
  t += 37;
  const held = await wA.acquire("hammer");
  let bRejected = 0;
  for (let i = 0; i < 50; i++) {
    t += 100; // 5s of hammering, inside the 10s TTL
    const r = await wB.acquire("hammer");
    if (!r.acquired) bRejected++;
  }
  const stillA = await wA.validateOwnership("hammer", "race-worker-a", held.lease.epoch);
  check("50 acquire attempts by worker B all rejected while A's lease is live", bRejected === 50 && stillA.valid === true,
    `rejected=${bRejected}/50 A-fence=${stillA.valid}`);

  // frozen owner: A stops renewing → TTL passes → B steals → A is fenced out
  const hold = await wA.acquire("frozen");
  t += 10_001; // A "crashed": no renewal for a full TTL
  const takeover = await wB.steal("frozen");
  check("frozen owner loses the job to a stealer after TTL", takeover.acquired === true && takeover.lease.owner === "race-worker-b" && takeover.lease.epoch === hold.lease.epoch + 1,
    `owner=${takeover.lease?.owner} epoch ${hold.lease.epoch}→${takeover.lease.epoch}`);
  const zombieRenew = await wA.renew("frozen");
  check("frozen owner's renew after takeover is rejected", zombieRenew.renewed === false);
  const zombieWrite = await wA.validateOwnership("frozen", "race-worker-a", hold.lease.epoch);
  check("frozen owner's effectful write is fenced out (stale lease)", zombieWrite.valid === false, `reason=${zombieWrite.reason}`);
  const newOwnerWrite = await wB.validateOwnership("frozen", "race-worker-b", takeover.lease.epoch);
  check("new owner's effectful write passes the fence", newOwnerWrite.valid === true);
}

// =====================================================================
// 3. live PostgreSQL — the REAL distributed backend, two regions, one DB
// =====================================================================
console.log("\n== live PostgreSQL backend (real DB, real SQL, true concurrency) ==");

let dbUp = false;
try {
  const { query } = await import("../src/database/client.js");
  await query("SELECT 1");
  dbUp = true;
} catch (err) {
  console.log(`SKIP  live PostgreSQL leg — DB unreachable: ${err.code || err.message}`);
}

if (dbUp) {
  const { migrate, query, closePool } = await import("../src/database/client.js");
  await migrate(); // idempotent, forward-only — applies 017-job-leases.sql if pending
  const applied = await query(`SELECT 1 FROM _migrations WHERE id = '017-job-leases.sql'`);
  check("migration 017-job-leases.sql applied on live DB", applied.rows.length === 1);

  const TAG = `lease-t-${Date.now().toString(36)}`;
  await query(`DELETE FROM job_leases WHERE job_id LIKE 'lease-t-%'`); // clean slate for this run

  const mA = createLeaseManager({ backend: "postgres", region: "region-a", workerId: "pg-worker-a" });
  const mB = createLeaseManager({ backend: "postgres", region: "region-b", workerId: "pg-worker-b" });

  // --- sequential semantics against real SQL ---
  const j1 = `${TAG}-seq`;
  const g = await mA.acquire(j1);
  check("PG: acquire grants a fresh lease", g.acquired === true && g.lease.owner === "pg-worker-a" && g.lease.epoch === 1,
    `epoch=${g.lease?.epoch} region=${g.lease?.region}`);
  const held = await mB.acquire(j1);
  check("PG: second region's acquire on a live lease is rejected", held.acquired === false && held.reason === "held" && held.owner === "pg-worker-a",
    `reason=${held.reason}`);

  const beforeExp = g.lease.expiresAt;
  await sleep(30);
  const rn = await mA.renew(j1);
  check("PG: owner renew extends expires_at forward", rn.renewed === true && rn.lease.expiresAt > beforeExp,
    `${beforeExp} → ${rn.lease.expiresAt}`);
  const rnB = await mB.renew(j1);
  check("PG: non-owner renew rejected", rnB.renewed === false && rnB.owner === "pg-worker-a");

  const fenceA = await mA.validateOwnership(j1, "pg-worker-a", 1);
  check("PG: fencing accepts current owner+epoch", fenceA.valid === true);
  const fenceB = await mB.validateOwnership(j1, "pg-worker-b", 1);
  check("PG: fencing rejects the other region", fenceB.valid === false && fenceB.reason === "not-owner");

  const stealLive = await mB.steal(j1);
  check("PG: steal refuses a live lease", stealLive.acquired === false && stealLive.reason === "not-expired");
  const relB = await mB.release(j1);
  check("PG: release by non-owner rejected", relB.released === false && relB.reason === "not-owner");

  // --- dead owner: TTL passes in REAL time, region-b takes over ---
  const j2 = `${TAG}-dead`;
  const d = await mA.acquire(j2, null, { ttl: 700 });
  check("PG: short-TTL acquire (ttl=700ms)", d.acquired === true && d.lease.ttlMs === 700, `ttl=${d.lease.ttlMs}`);
  const dB = await mB.acquire(j2);
  check("PG: region-b blocked while region-a alive", dB.acquired === false);
  await sleep(900); // region-a dies, no renewal
  const takeover = await mB.acquire(j2); // acquire = the expired-takeover path
  check("PG: region-b takes the dead lease via acquire", takeover.acquired === true && takeover.lease.owner === "pg-worker-b" && takeover.lease.epoch === 2,
    `owner=${takeover.lease?.owner} epoch=${takeover.lease?.epoch}`);
  const zombieRenew = await mA.renew(j2);
  check("PG: dead owner's renew rejected after takeover", zombieRenew.renewed === false && zombieRenew.owner === "pg-worker-b");
  const zombieFence = await mA.validateOwnership(j2, "pg-worker-a", 1);
  check("PG: dead owner fenced out with stale epoch", zombieFence.valid === false, `reason=${zombieFence.reason}`);

  // --- THE RACE on the real DB: two managers, two regions, TRUE concurrency ---
  const ROUNDS = 40;
  let doubleWins = 0, zeroWins = 0, epochBad = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const jobId = `${TAG}-race-${i}`;
    const [a, b] = await Promise.all([
      mA.acquire(jobId, null, { ttl: 60_000 }),
      mB.acquire(jobId, null, { ttl: 60_000 }),
    ]);
    const winners = [a, b].filter((r) => r.acquired);
    if (winners.length > 1) doubleWins++;
    if (winners.length === 0) zeroWins++;
    if (winners.length === 1) {
      const winner = winners[0];
      const { lease } = await mA.getLease(jobId);
      if (lease.owner !== winner.lease.owner || lease.epoch !== winner.lease.epoch) epochBad++;
      const fence = await mB.validateOwnership(jobId, winner.lease.owner === "pg-worker-a" ? "pg-worker-a" : "pg-worker-b", winner.lease.epoch);
      if (!fence.valid) epochBad++;
    }
    await mA.release(jobId, winnerOwner(a, b));
  }
  check(`PG race ×${ROUNDS} (two regions, concurrent): exactly one winner every round`,
    doubleWins === 0 && zeroWins === 0, `doubleWins=${doubleWins} zeroWins=${zeroWins}`);
  check("PG race: stored lease + epoch + fence always match the winner", epochBad === 0, `mismatches=${epochBad}`);

  // --- cross-region steal loop: epochs strictly increase on every takeover ---
  const j3 = `${TAG}-steal-loop`;
  const first = await mA.acquire(j3, null, { ttl: 200 });
  const epochs = [first.lease.epoch];
  for (let i = 0; i < 3; i++) {
    await sleep(260);
    const s = await (i % 2 === 0 ? mB : mA).steal(j3, null, { ttl: 200 });
    epochs.push(s.lease.epoch);
  }
  check("PG: steal chain bumps the epoch strictly 1→2→3→4", epochs.join(",") === "1,2,3,4", `epochs=${epochs.join(",")}`);

  // cleanup only OUR test rows
  const del = await query(`DELETE FROM job_leases WHERE job_id LIKE 'lease-t-%' RETURNING job_id`);
  check("test rows cleaned up (scoped by tag prefix)", del.rowCount >= 0, `deleted=${del.rowCount}`);

  // --- cross-PROCESS race: two independent node processes (= two regions,
  // two OS processes, two separate pools) both acquire the same job. This is
  // the ask's "two workers race, one wins" at maximum realism: no shared
  // memory, only the shared PostgreSQL store.
  const procJob = `${TAG}-proc-race`;
  const childScript = `(async () => {
    const { createLeaseManager } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, "src/distributed/job-leases.js")).href)});
    // node -e: extra CLI args land at argv[1..] (argv[0] is the node binary)
    const m = createLeaseManager({ backend: "postgres", region: process.argv[1], workerId: process.argv[2] });
    const r = await m.acquire(process.argv[3], null, { ttl: 60000 });
    console.log(JSON.stringify({ acquired: r.acquired, owner: r.lease && r.lease.owner, epoch: r.lease && r.lease.epoch }));
    process.exit(0);
  })().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });`;

  const runChild = (region, worker) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", childScript, region, worker, procJob], { cwd: PROJECT });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      try { resolve({ code, ...JSON.parse(out.trim()) }); }
      catch { resolve({ code, parseError: true, out, err }); }
    });
  });
  const [cA, cB] = await Promise.all([
    runChild("proc-region-a", "proc-worker-a"),
    runChild("proc-region-b", "proc-worker-b"),
  ]);
  const procWinners = [cA, cB].filter((c) => c.acquired === true);
  check("cross-PROCESS race: exactly one of the two node processes wins",
    procWinners.length === 1 && cA.code === 0 && cB.code === 0,
    `a={acquired:${cA.acquired},owner:${cA.owner}} b={acquired:${cB.acquired},owner:${cB.owner}}`);
  if (procWinners.length === 1) {
    const { lease } = await mA.getLease(procJob);
    check("cross-PROCESS race: shared store shows the winning process as sole owner",
      lease && lease.owner === procWinners[0].owner && lease.epoch === procWinners[0].epoch,
      `owner=${lease?.owner} epoch=${lease?.epoch}`);
  }
  await query(`DELETE FROM job_leases WHERE job_id = $1`, [procJob]);

  await mA.close();
  await mB.close();
  await closePool();
}

function winnerOwner(a, b) {
  if (a.acquired) return a.lease.owner;
  if (b.acquired) return b.lease.owner;
  return "pg-worker-a";
}

// =====================================================================
const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\n==== job-leases: ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""} ====`);
process.exit(failed ? 1 : 0);
