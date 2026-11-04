#!/usr/bin/env node
// Resource-aware scheduler tests (task 4.2.7) — src/distributed/scheduler.js.
//
//   Part A (unit, hand-computed expectations): spec validation errors with
//   stable codes, eager UNFITTABLE rejection, exact priority + FIFO packing
//   sequences, strict vs backfill head-of-line behavior, browser-slot limits
//   independent of memory, worker down/up failover + requeue, removeWorker
//   fleet-max effects, late-registered worker un-flagging a permanently
//   unfittable job.
//
//   Part B (THE SIMULATION — 10 jobs / 3 workers): a deterministic
//   discrete-event simulation of a real fleet. The scheduler is the REAL
//   product code; the test simulates the WORKER side (the remote end), the
//   only thing allowed to be simulated. Every dispatch pass is cross-checked
//   against an INDEPENDENT reference packer (written in this file, not
//   imported), every state transition is checked against an EXTERNAL
//   assignment ledger for overcommit (memory AND browser slots, used >= 0),
//   and a priority-property checker proves no higher-priority pending job
//   that could fit was ever jumped. Two runs: strict mode (with a mid-flight
//   worker failure + failover) and backfill mode.
//
//   Part C (checker self-test): the same invariant battery is run against
//   three deliberately broken packers (priority-ignoring, memory- and
//   slot-overcommitting) and must CATCH each — proving Parts B/D green
//   results are discriminating, not vacuous.
//
//   Part D (seeded stress, no Math.random): 60 jobs / 5 workers via a seeded
//   LCG, both modes, same invariant battery + completion guarantee.
//
// Exit code 1 on any FAIL. Zero external services, zero credentials.
import { ResourceScheduler, SchedulerError, fitsCapacity, bestWorkerFor } from "../src/distributed/scheduler.js";

const results = [];
let failed = false;
const check = (name, ok, detail = "") => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

const errCode = (fn) => {
  try { fn(); return null; } catch (e) { return e instanceof SchedulerError ? e.code : `NOT_SCHEDULER_ERROR:${e?.message}`; }
};

// ---------- helpers shared with the simulation ----------

/** Sort jobs the way the scheduler must: priority desc, then submission seq. */
const dispatchOrder = (pending) =>
  [...pending].sort((a, b) => b.priority - a.priority || a.seq - b.seq);

/**
 * INDEPENDENT reference packer (the oracle). Deliberately a from-scratch
 * reimplementation of the documented contract — the scheduler under test
 * shares no code with this. Returns placements [{jobId, workerId}] in order.
 *   strict: stop at the first pending job that fits nowhere (but permanently
 *           unfittable jobs are skipped, never block).
 *   backfill: skip blocked heads, keep packing.
 */
function oraclePass(pending, workers, mode) {
  const ws = workers.map((w) => ({ ...w }));
  let maxMem = 0, maxSlots = 0;
  for (const w of ws) { maxMem = Math.max(maxMem, w.capMem); maxSlots = Math.max(maxSlots, w.capSlots); }
  const placements = [];
  for (const job of dispatchOrder(pending)) {
    if (job.memoryMb > maxMem || job.browserSlots > maxSlots) continue; // never fittable
    let best = null;
    for (const w of ws) {
      if (w.down) continue;
      const remM = w.capMem - w.usedMem;
      const remS = w.capSlots - w.usedSlots;
      if (remM < job.memoryMb || remS < job.browserSlots) continue;
      const scoreM = remM - job.memoryMb, scoreS = remS - job.browserSlots;
      if (!best || scoreM < best.scoreM || (scoreM === best.scoreM && (scoreS < best.scoreS || (scoreS === best.scoreS && w.id < best.id)))) {
        best = { id: w.id, scoreM, scoreS };
      }
    }
    if (!best) { if (mode === "strict") break; continue; }
    const w = ws.find((x) => x.id === best.id);
    w.usedMem += job.memoryMb;
    w.usedSlots += job.browserSlots;
    placements.push({ jobId: job.id, workerId: w.id });
  }
  return placements;
}

/** fits-anywhere check against a plain worker-state array (checker-side). */
function fitsAnywhereIn(workers, job) {
  return workers.some((w) => !w.down && w.capMem - w.usedMem >= job.memoryMb && w.capSlots - w.usedSlots >= job.browserSlots);
}

/**
 * Priority-property checker: for every placement J of a pass, every
 * higher-priority job H that was pending at pass start and was NOT placed in
 * that pass must not fit anywhere in the state immediately before J was
 * placed. (Placements only consume resources, so if H did not fit at its own
 * consideration moment — which is earlier and lower-used — it cannot fit
 * later; conversely if it DID fit it must have been placed. Violations here
 * are genuine priority jumps.)
 */
function checkPriorityProperty(passStart, placements, violations, label) {
  const placedIds = new Set(placements.map((p) => p.jobId));
  for (let i = 0; i < placements.length; i++) {
    const J = placements[i];
    const scratch = passStart.workers.map((w) => ({ ...w }));
    for (let k = 0; k < i; k++) {
      const p = placements[k];
      const spec = passStart.pending.find((j) => j.id === p.jobId);
      const w = scratch.find((x) => x.id === p.workerId);
      w.usedMem += spec.memoryMb;
      w.usedSlots += spec.browserSlots;
    }
    for (const H of passStart.pending) {
      if (placedIds.has(H.id) || H.priority <= J.priority) continue;
      if (fitsAnywhereIn(scratch, H)) {
        violations.push({ label: `${label}: priority-jump`, placed: J.jobId, jumpedHigher: H.id, H: { mem: H.memoryMb, slots: H.browserSlots } });
      }
    }
  }
}

/**
 * Deterministic discrete-event simulation of the fleet.
 * The scheduler under test is REAL; this loop simulates worker execution
 * (each placement takes `durations` ms of simulated time, then releases).
 * `makeScheduler` defaults to the real ResourceScheduler but can inject a
 * deliberately broken engine (Part D proves the battery catches it).
 * Returns rich telemetry; `violations` must end up EMPTY for a green run.
 */
function runSimulation({ mode, workers, jobs, durations, downWorkerAt = null, maxEvents = 5000, makeScheduler = null }) {
  let simClock = 0;
  const iso = () => new Date(simClock).toISOString();
  const scheduler = makeScheduler
    ? makeScheduler(mode, iso)
    : new ResourceScheduler({ mode, now: iso });

  const events = { assign: [], requeue: [], unfittable: [], fittable: [] };
  scheduler.on("assign", (p) => events.assign.push({ ...p, at: simClock }));
  scheduler.on("requeue", (p) => events.requeue.push({ ...p, at: simClock }));
  scheduler.on("unfittable", (p) => events.unfittable.push({ ...p, at: simClock }));
  scheduler.on("fittable", (p) => events.fittable.push({ ...p, at: simClock }));

  const specOf = new Map(jobs.map((j) => [j.id, j]));
  for (const w of workers) scheduler.registerWorker(w);
  for (const j of jobs) scheduler.submit({ id: j.id, priority: j.priority, resources: { memoryMb: j.memoryMb, browserSlots: j.browserSlots } });

  const violations = [];
  const ledger = new Map(); // workerId -> { mem, slots } — EXTERNAL accounting
  const finishes = []; // { at, workerId, jobId, order }
  const starts = new Map(); // jobId -> first-start simClock
  const assignCount = new Map(); // workerId -> count of assignments received
  let order = 0;
  let downDone = false;
  let downClock = null;
  let assignsAfterDown = 0;

  const checkInvariants = (label) => {
    const snap = scheduler.snapshot();
    for (const w of snap.workers) {
      if (w.used.memoryMb > w.capacity.memoryMb || w.used.browserSlots > w.capacity.browserSlots) {
        violations.push({ label: `${label}: OVERCOMMIT`, worker: w.id, used: w.used, capacity: w.capacity });
      }
      if (w.used.memoryMb < 0 || w.used.browserSlots < 0 || w.runningJobs < 0) {
        violations.push({ label: `${label}: NEGATIVE-USAGE`, worker: w.id, used: w.used, runningJobs: w.runningJobs });
      }
    }
    for (const [wid, acc] of ledger) {
      const w = snap.workers.find((x) => x.id === wid);
      if (w && (acc.mem !== w.used.memoryMb || acc.slots !== w.used.browserSlots)) {
        violations.push({ label: `${label}: LEDGER-MISMATCH`, worker: wid, ledger: acc, scheduler: w.used });
      }
    }
  };

  const runPass = (label) => {
    const snap = scheduler.snapshot();
    const passStart = {
      pending: snap.pending.map((j) => ({ id: j.id, priority: j.priority, seq: j.seq, memoryMb: j.resources.memoryMb, browserSlots: j.resources.browserSlots })),
      workers: snap.workers.map((w) => ({ id: w.id, capMem: w.capacity.memoryMb, capSlots: w.capacity.browserSlots, usedMem: w.used.memoryMb, usedSlots: w.used.browserSlots, down: w.down })),
    };
    const placements = scheduler.dispatch();
    const oracle = oraclePass(passStart.pending, passStart.workers, mode);
    const actual = placements.map((p) => ({ jobId: p.jobId, workerId: p.workerId }));
    if (JSON.stringify(oracle) !== JSON.stringify(actual)) {
      violations.push({ label: `${label}: ORACLE-MISMATCH`, oracle, actual });
    }
    checkPriorityProperty(passStart, placements, violations, label);
    for (const p of placements) {
      if (downDone && p.workerId === downWorkerAt?.workerId) assignsAfterDown += 1;
      assignCount.set(p.workerId, (assignCount.get(p.workerId) || 0) + 1);
      const acc = ledger.get(p.workerId) || { mem: 0, slots: 0 };
      acc.mem += specOf.get(p.jobId).memoryMb;
      acc.slots += specOf.get(p.jobId).browserSlots;
      ledger.set(p.workerId, acc);
      if (!starts.has(p.jobId)) starts.set(p.jobId, simClock);
      finishes.push({ at: simClock + durations.get(p.jobId), workerId: p.workerId, jobId: p.jobId, order: ++order });
    }
    checkInvariants(label);
    return placements;
  };

  runPass("t=0 initial");

  let processed = 0;
  while (finishes.length && processed < maxEvents) {
    finishes.sort((a, b) => a.at - b.at || a.order - b.order);
    const ev = finishes.shift();
    simClock = ev.at;
    processed += 1;

    if (downWorkerAt && !downDone && simClock >= downWorkerAt.atClock) {
      downDone = true;
      downClock = simClock;
      const requeued = scheduler.markWorkerDown(downWorkerAt.workerId, { reason: "simulated worker crash" });
      ledger.delete(downWorkerAt.workerId); // its work left the box
      for (const jobId of requeued) {
        // the crashed worker will never report those finishes — drop them
        const idx = finishes.findIndex((f) => f.jobId === jobId);
        if (idx >= 0) finishes.splice(idx, 1);
      }
      checkInvariants("worker-down");
      runPass("post-worker-down");
    }

    scheduler.release(ev.workerId, ev.jobId);
    const acc = ledger.get(ev.workerId);
    if (acc) {
      acc.mem -= specOf.get(ev.jobId).memoryMb;
      acc.slots -= specOf.get(ev.jobId).browserSlots;
    }
    checkInvariants(`t=${simClock} release`);
    runPass(`t=${simClock} redispatch`);
  }
  if (processed >= maxEvents) violations.push({ label: "EVENT-GUARD-TRIPPED", processed });

  const snap = scheduler.snapshot();
  const stats = scheduler.stats();
  return { scheduler, snapshot: snap, stats, events, violations, starts, simClock, downClock, assignCount, assignsAfterDown };
}

// =====================================================================
// Part A — unit behavior with hand-computed expectations
// =====================================================================
console.log("\n--- Part A: unit behavior (hand-computed expectations) ---");
{
  // A1: spec validation → stable error codes
  const s1 = new ResourceScheduler();
  check("A1.1 job without any resource need → INVALID_JOB", errCode(() => s1.submit({ resources: {} })) === "INVALID_JOB");
  check("A1.2 negative memoryMb → INVALID_JOB", errCode(() => s1.submit({ resources: { memoryMb: -1 } })) === "INVALID_JOB");
  check("A1.3 fractional browserSlots → INVALID_JOB", errCode(() => s1.submit({ resources: { browserSlots: 1.5 } })) === "INVALID_JOB");
  check("A1.4 non-numeric priority → INVALID_JOB", errCode(() => s1.submit({ priority: "high", resources: { memoryMb: 1 } })) === "INVALID_JOB");
  check("A1.5 non-object job spec → INVALID_JOB", errCode(() => s1.submit("nope")) === "INVALID_JOB");
  check("A1.6 worker without capacity → INVALID_WORKER", errCode(() => s1.registerWorker({ id: "x" })) === "INVALID_WORKER");
  check("A1.7 negative worker capacity → INVALID_WORKER", errCode(() => s1.registerWorker({ id: "x", capacity: { memoryMb: -5, browserSlots: 1 } })) === "INVALID_WORKER");
  check("A1.8 fractional worker slots → INVALID_WORKER", errCode(() => s1.registerWorker({ id: "x", capacity: { memoryMb: 100, browserSlots: 0.5 } })) === "INVALID_WORKER");
  check("A1.9 release from unknown worker → UNKNOWN_WORKER", errCode(() => s1.release("ghost", "job")) === "UNKNOWN_WORKER");
  s1.registerWorker({ id: "w", capacity: { memoryMb: 100, browserSlots: 1 } });
  check("A1.10 release of unknown job → UNKNOWN_JOB", errCode(() => s1.release("w", "nope")) === "UNKNOWN_JOB");

  // A2: eager UNFITTABLE when the fleet is known; accepted when fleet unknown
  const s2 = new ResourceScheduler();
  s2.registerWorker({ id: "small", capacity: { memoryMb: 2048, browserSlots: 2 } });
  check("A2.1 job larger than every worker's memory → UNFITTABLE at submit", errCode(() => s2.submit({ id: "big", resources: { memoryMb: 4096, browserSlots: 1 } })) === "UNFITTABLE");
  check("A2.2 job needing more slots than fleet max → UNFITTABLE at submit", errCode(() => s2.submit({ id: "slotty", resources: { memoryMb: 512, browserSlots: 3 } })) === "UNFITTABLE");
  const s2b = new ResourceScheduler();
  let accepted = null;
  try { accepted = s2b.submit({ id: "huge", resources: { memoryMb: 1e9, browserSlots: 1 } }); } catch { accepted = null; }
  check("A2.3 job with no fleet registered yet → accepted (fleet unknown)", !!accepted && accepted.state === "pending");

  // A3: exact priority + FIFO packing sequence on a single worker.
  // Hand-computed: worker 6144 MB / 3 slots. d(1024)+b(2048)+c(2048)=5120 fits;
  // a(2048) does not (1024 left) → pending. b before c proves FIFO within p5.
  const s3 = new ResourceScheduler();
  s3.registerWorker({ id: "w", capacity: { memoryMb: 6144, browserSlots: 3 } });
  s3.submit({ id: "a", priority: 1, resources: { memoryMb: 2048, browserSlots: 1 } });
  s3.submit({ id: "b", priority: 5, resources: { memoryMb: 2048, browserSlots: 1 } });
  s3.submit({ id: "c", priority: 5, resources: { memoryMb: 2048, browserSlots: 1 } });
  s3.submit({ id: "d", priority: 10, resources: { memoryMb: 1024, browserSlots: 1 } });
  const p3 = s3.dispatch().map((p) => p.jobId);
  check("A3.1 exact order: d (p10) then b, c (p5 FIFO); a blocked by memory", JSON.stringify(p3) === JSON.stringify(["d", "b", "c"]), JSON.stringify(p3));
  const snap3 = s3.snapshot();
  check("A3.2 exactly 'a' pending; usage 5120 MB / 3 slots — within capacity", snap3.totals.pending === 1 && snap3.pending[0].id === "a" && snap3.workers[0].used.memoryMb === 5120 && snap3.workers[0].used.browserSlots === 3, JSON.stringify(snap3.workers[0].used));
  s3.release("w", "b");
  const p3b = s3.dispatch().map((p) => p.jobId);
  check("A3.3 freed memory lets 'a' place on next pass", JSON.stringify(p3b) === JSON.stringify(["a"]), JSON.stringify(p3b));

  // A4: strict head-of-line blocking vs backfill
  const s4 = new ResourceScheduler({ mode: "strict" });
  s4.registerWorker({ id: "w1", capacity: { memoryMb: 4096, browserSlots: 2 } });
  s4.submit({ id: "r1", priority: 9, resources: { memoryMb: 2048, browserSlots: 1 } });
  s4.dispatch();
  s4.submit({ id: "h", priority: 10, resources: { memoryMb: 3072, browserSlots: 1 } }); // blocked: only 2048 free
  s4.submit({ id: "l", priority: 1, resources: { memoryMb: 1024, browserSlots: 1 } });  // would fit
  const p4 = s4.dispatch();
  check("A4.1 strict mode: blocked head halts the pass (lower-priority job may NOT jump)", p4.length === 0 && s4.snapshot().pending.map((j) => j.id).sort().join(",") === "h,l", JSON.stringify(p4));
  const s4b = new ResourceScheduler({ mode: "backfill" });
  s4b.registerWorker({ id: "w1", capacity: { memoryMb: 4096, browserSlots: 2 } });
  s4b.submit({ id: "r1", priority: 9, resources: { memoryMb: 2048, browserSlots: 1 } });
  s4b.dispatch();
  s4b.submit({ id: "h", priority: 10, resources: { memoryMb: 3072, browserSlots: 1 } });
  s4b.submit({ id: "l", priority: 1, resources: { memoryMb: 1024, browserSlots: 1 } });
  const p4b = s4b.dispatch().map((p) => p.jobId);
  check("A4.2 backfill mode: blocked head skipped, leftover capacity used by 'l'", JSON.stringify(p4b) === JSON.stringify(["l"]), JSON.stringify(p4b));
  s4b.release("w1", "r1");
  const p4c = s4b.dispatch().map((p) => p.jobId);
  check("A4.3 backfill: once memory frees, the skipped head 'h' places next", JSON.stringify(p4c) === JSON.stringify(["h"]), JSON.stringify(p4c));
  s4.release("w1", "r1");
  const p4d = s4.dispatch().map((p) => p.jobId);
  // h (3072/1) places, then l (1024/1) fits the remaining 1024 MB / 1 slot
  check("A4.4 strict mode resumes: head 'h' first, then 'l' fits the rest", JSON.stringify(p4d) === JSON.stringify(["h", "l"]), JSON.stringify(p4d));

  // A5: browser slots are a hard limit even when memory is plentiful
  const s5 = new ResourceScheduler();
  s5.registerWorker({ id: "w", capacity: { memoryMb: 8192, browserSlots: 2 } });
  for (const id of ["s1", "s2", "s3"]) s5.submit({ id, priority: 1, resources: { memoryMb: 512, browserSlots: 1 } });
  const p5 = s5.dispatch().map((p) => p.jobId);
  check("A5.1 third 1-slot job blocked by the 2-slot cap despite free memory", JSON.stringify(p5) === JSON.stringify(["s1", "s2"]) && s5.snapshot().pending.some((j) => j.id === "s3"), JSON.stringify(p5));
  s5.release("w", "s1");
  const p5b = s5.dispatch().map((p) => p.jobId);
  check("A5.2 slot freed → third job places", JSON.stringify(p5b) === JSON.stringify(["s3"]), JSON.stringify(p5b));

  // A6: worker down → requeue running work → failover to survivors; up/busy/remove semantics
  const s6 = new ResourceScheduler();
  s6.registerWorker({ id: "w1", capacity: { memoryMb: 2048, browserSlots: 1 } });
  s6.registerWorker({ id: "w2", capacity: { memoryMb: 2048, browserSlots: 1 } });
  s6.submit({ id: "r", priority: 1, resources: { memoryMb: 2048, browserSlots: 1 } });
  s6.dispatch();
  const requeued = s6.markWorkerDown("w1", { reason: "test crash" });
  const snap6 = s6.snapshot();
  check("A6.1 markWorkerDown requeues the running job and zeroes usage", JSON.stringify(requeued) === JSON.stringify(["r"]) && snap6.workers.find((w) => w.id === "w1").down === true && snap6.workers.find((w) => w.id === "w1").used.memoryMb === 0);
  const p6 = s6.dispatch().map((p) => p.jobId);
  check("A6.2 requeued job fails over onto the surviving worker", JSON.stringify(p6) === JSON.stringify(["r"]) && s6.jobSnapshot("r").worker === "w2" && s6.jobSnapshot("r").attempts === 1, JSON.stringify(p6));
  check("A6.3 re-registering a worker with running jobs → DUPLICATE", errCode(() => s6.registerWorker({ id: "w2", capacity: { memoryMb: 9999, browserSlots: 9 } })) === "DUPLICATE");
  check("A6.4 removeWorker with running jobs → WORKER_BUSY", errCode(() => s6.removeWorker("w2")) === "WORKER_BUSY");
  s6.release("w2", "r");
  s6.removeWorker("w2");
  check("A6.5 after removal, fleet max shrinks → oversized submit is UNFITTABLE", errCode(() => s6.submit({ id: "u", resources: { memoryMb: 4096, browserSlots: 1 } })) === "UNFITTABLE");
  s6.markWorkerUp("w1");
  check("A6.6 markWorkerUp returns the worker to the pool", s6.snapshot().workers.find((w) => w.id === "w1").down === false);

  // A7: permanently unfittable pending job never blocks; late capacity un-flags it
  const s7 = new ResourceScheduler();
  s7.submit({ id: "u", priority: 5, resources: { memoryMb: 8192, browserSlots: 1 } });
  s7.submit({ id: "m", priority: 1, resources: { memoryMb: 1024, browserSlots: 1 } });
  const unfittableEvents = [];
  const fittableEvents = [];
  s7.on("unfittable", (e) => unfittableEvents.push(e.jobId));
  s7.on("fittable", (e) => fittableEvents.push(e.jobId));
  s7.registerWorker({ id: "small", capacity: { memoryMb: 2048, browserSlots: 1 } });
  const p7 = s7.dispatch().map((p) => p.jobId);
  check("A7.1 strict mode: unfittable head skipped (not blocking), 'm' places", JSON.stringify(p7) === JSON.stringify(["m"]) && unfittableEvents.includes("u"), JSON.stringify(p7));
  check("A7.2 snapshot buckets the unfittable job", s7.snapshot().unfittable.includes("u"));
  s7.registerWorker({ id: "big", capacity: { memoryMb: 8192, browserSlots: 1 } });
  const p7b = s7.dispatch().map((p) => p.jobId);
  check("A7.3 registering a big worker un-flags and places the head", JSON.stringify(p7b) === JSON.stringify(["u"]) && fittableEvents.includes("u") && s7.jobSnapshot("u").unfittable === false, JSON.stringify(p7b));

  // A8: duplicate pending id → DUPLICATE; completed id may be re-submitted (retry path)
  const s8 = new ResourceScheduler();
  s8.registerWorker({ id: "w", capacity: { memoryMb: 4096, browserSlots: 1 } });
  s8.submit({ id: "j", priority: 1, resources: { memoryMb: 1024, browserSlots: 1 } });
  check("A8.1 duplicate id while pending → DUPLICATE", errCode(() => s8.submit({ id: "j", resources: { memoryMb: 1024, browserSlots: 1 } })) === "DUPLICATE");
  s8.dispatch();
  s8.release("w", "j");
  let resub = null;
  try { resub = s8.submit({ id: "j", priority: 2, resources: { memoryMb: 512, browserSlots: 1 } }); } catch { resub = null; }
  check("A8.2 completed id can be re-submitted as a fresh run", !!resub && resub.attempts === 0 && resub.priority === 2);

  // A9: pure helpers exported for external checkers behave per contract
  const w9 = { capacityMemoryMb: 100, capacityBrowserSlots: 2, usedMemoryMb: 60, usedBrowserSlots: 1 };
  check("A9.1 fitsCapacity: exact fit is a fit", fitsCapacity(w9, { memoryMb: 40, browserSlots: 1 }) === true);
  check("A9.2 fitsCapacity: 1 MB over is not", fitsCapacity(w9, { memoryMb: 41, browserSlots: 1 }) === false);
  check("A9.3 fitsCapacity: slot over is not even with free memory", fitsCapacity(w9, { memoryMb: 10, browserSlots: 2 }) === false);
  const ws9 = [
    { id: "a", capacityMemoryMb: 100, capacityBrowserSlots: 2, usedMemoryMb: 50, usedBrowserSlots: 1 },
    { id: "b", capacityMemoryMb: 100, capacityBrowserSlots: 2, usedMemoryMb: 70, usedBrowserSlots: 0 },
  ];
  check("A9.4 bestWorkerFor picks the tightest (best-fit) worker", bestWorkerFor(ws9, { memoryMb: 20, browserSlots: 1 })?.id === "b");
}

// =====================================================================
// Part B — THE SIMULATION: 10 jobs / 3 workers (the ask's named scale)
// =====================================================================
console.log("\n--- Part B: SIMULATION — 10 jobs / 3 workers (discrete event, deterministic) ---");

const B_WORKERS = [
  { id: "w-big", capacity: { memoryMb: 8192, browserSlots: 3 } },
  { id: "w-mid", capacity: { memoryMb: 4096, browserSlots: 2 } },
  { id: "w-small", capacity: { memoryMb: 2048, browserSlots: 1 } },
];
// 10 jobs: mixed priorities (10 urgent / 5 normal / 1 background), memory
// 256..6142 MB, 1–2 browser slots, distinct execution durations (ms, simulated).
const B_JOBS = [
  { id: "j1", priority: 10, memoryMb: 3072, browserSlots: 2 }, // urgent, heavy
  { id: "j2", priority: 5, memoryMb: 2048, browserSlots: 1 },
  { id: "j3", priority: 5, memoryMb: 4096, browserSlots: 1 },  // big-memory
  { id: "j4", priority: 1, memoryMb: 512, browserSlots: 1 },
  { id: "j5", priority: 10, memoryMb: 1024, browserSlots: 1 }, // urgent, light
  { id: "j6", priority: 5, memoryMb: 1536, browserSlots: 2 },
  { id: "j7", priority: 1, memoryMb: 1024, browserSlots: 1 },
  { id: "j8", priority: 5, memoryMb: 256, browserSlots: 1 },
  { id: "j9", priority: 1, memoryMb: 6144, browserSlots: 1 },  // fits w-big only
  { id: "j10", priority: 5, memoryMb: 768, browserSlots: 1 },
];
const B_DURATIONS = new Map([
  ["j1", 40], ["j2", 30], ["j3", 60], ["j4", 20], ["j5", 25],
  ["j6", 35], ["j7", 20], ["j8", 15], ["j9", 50], ["j10", 10],
]);

const assertCommonSim = (tag, run, { expectRequeues = 0, downWorker = null } = {}) => {
  const { snapshot, stats, violations, events } = run;
  check(`${tag}.1 all 10 jobs completed, nothing pending/running`, snapshot.totals.completed === 10 && snapshot.totals.pending === 0 && snapshot.totals.running === 0, JSON.stringify(snapshot.totals));
  check(`${tag}.2 zero overcommit / negative-usage / ledger violations across every pass`, violations.filter((v) => /OVERCOMMIT|NEGATIVE|LEDGER/.test(v.label)).length === 0, JSON.stringify(violations.filter((v) => /OVERCOMMIT|NEGATIVE|LEDGER/.test(v.label)).slice(0, 2)));
  check(`${tag}.3 every pass matches the independent reference packer (oracle)`, violations.filter((v) => v.label.includes("ORACLE-MISMATCH")).length === 0, JSON.stringify(violations.filter((v) => v.label.includes("ORACLE-MISMATCH")).slice(0, 2)));
  check(`${tag}.4 zero priority jumps (no fittable higher-priority job was ever skipped)`, violations.filter((v) => v.label.includes("priority-jump")).length === 0, JSON.stringify(violations.filter((v) => v.label.includes("priority-jump")).slice(0, 2)));
  check(`${tag}.5 bookkeeping: submitted == completed + pending + running`, stats.submitted === snapshot.totals.completed + snapshot.totals.pending + snapshot.totals.running, JSON.stringify(stats));
  check(`${tag}.6 requeue count as expected`, stats.requeued === expectRequeues, `requeued=${stats.requeued} expected=${expectRequeues}`);
  if (downWorker) {
    const downId = downWorker;
    check(`${tag}.7 downed worker received zero assignments after going down`, run.assignsAfterDown === 0, `assignsAfterDown=${run.assignsAfterDown}`);
    check(`${tag}.8 requeue events name the crashed worker`, events.requeue.every((e) => e.workerId === downId) && events.requeue.length > 0, JSON.stringify(events.requeue));
    const wSnap = snapshot.workers.find((w) => w.id === downId);
    check(`${tag}.9 crashed worker ends clean (no usage, marked down)`, wSnap && wSnap.used.memoryMb === 0 && wSnap.used.browserSlots === 0 && wSnap.down === true);
  }
  check(`${tag}.10 every worker in the fleet did work at least once`, run.assignCount.size === 3, JSON.stringify([...run.assignCount]));
};

{
  // B1: strict mode, healthy fleet — hand-checkable opening pass + invariants
  const run1 = runSimulation({ mode: "strict", workers: B_WORKERS, jobs: B_JOBS, durations: B_DURATIONS });
  assertCommonSim("B1", run1);
  check("B1.11 first pass places exactly [j1→w-mid, j5→w-small, j2→w-big, j3→w-big] (best-fit + priority)", JSON.stringify(run1.events.assign.slice(0, 4).map((p) => `${p.jobId}→${p.workerId}`)) === JSON.stringify(["j1→w-mid", "j5→w-small", "j2→w-big", "j3→w-big"]), JSON.stringify(run1.events.assign.slice(0, 4).map((p) => `${p.jobId}→${p.workerId}`)));
  check("B1.12 both urgent (p10) jobs started at t=0", run1.starts.get("j1") === 0 && run1.starts.get("j5") === 0, `j1@${run1.starts.get("j1")} j5@${run1.starts.get("j5")}`);
  check("B1.13 healthy fleet: zero requeues, assigned exactly 10", run1.stats.requeued === 0 && run1.stats.assigned === 10, JSON.stringify(run1.stats));

  // B2: strict mode + mid-flight crash of w-mid (failover under load)
  const run2 = runSimulation({ mode: "strict", workers: B_WORKERS.map((w) => ({ ...w })), jobs: B_JOBS, durations: B_DURATIONS, downWorkerAt: { workerId: "w-mid", atClock: 30 } });
  assertCommonSim("B2", run2, { expectRequeues: 1, downWorker: "w-mid" });
  check("B2.11 the crash requeued exactly j1 (the job running on w-mid at t=30)", JSON.stringify(run2.events.requeue.map((e) => e.jobId)) === JSON.stringify(["j1"]), JSON.stringify(run2.events.requeue));
  check("B2.12 requeued j1 eventually completed on another worker", run2.snapshot.completedRecent.some((c) => c.jobId === "j1" && c.workerId !== "w-mid"), JSON.stringify(run2.snapshot.completedRecent.filter((c) => c.jobId === "j1")));
  check("B2.13 assigned 11 = 10 original + 1 failover re-run", run2.stats.assigned === 11, `assigned=${run2.stats.assigned}`);
  check("B2.14 utilization is sane: w-small slotUtilization ∈ (0,1]", (() => {
    const w = run2.snapshot.workers.find((x) => x.id === "w-small");
    return w.slotUtilization >= 0 && w.slotUtilization <= 1 && w.memoryUtilization >= 0 && w.memoryUtilization <= 1;
  })());

  // B3: backfill mode, healthy fleet — same invariant battery
  const run3 = runSimulation({ mode: "backfill", workers: B_WORKERS.map((w) => ({ ...w })), jobs: B_JOBS, durations: B_DURATIONS });
  assertCommonSim("B3", run3);
  check("B3.11 backfill first pass = strict pass + j8 packed into leftover w-big capacity", JSON.stringify(run3.events.assign.slice(0, 5).map((p) => `${p.jobId}→${p.workerId}`)) === JSON.stringify(["j1→w-mid", "j5→w-small", "j2→w-big", "j3→w-big", "j8→w-big"]), JSON.stringify(run3.events.assign.slice(0, 5).map((p) => `${p.jobId}→${p.workerId}`)));
}

// =====================================================================
// Part C — checker self-test: the invariant battery must CATCH broken
// packers. Green Part B/D results are only meaningful if the same battery
// fails known-wrong engines. Three broken engines (same interface, same sim):
//   "fifo"              — packs in submission order, ignores priority
//   "overcommit-memory" — ignores the memory limit
//   "overcommit-slots"  — ignores the browser-slot limit
// =====================================================================
console.log("\n--- Part C: checker self-test (the battery must catch broken packers) ---");
{
  /**
   * A minimal scheduler-shaped engine with a deliberately wrong packing
   * strategy. Shares no code with ResourceScheduler; exists ONLY inside this
   * test to prove the invariant checkers are discriminating.
   */
  const makeBrokenEngine = (kind, nowIso) => {
    const workers = new Map();
    const jobs = new Map();
    const pending = [];
    const running = new Map();
    const completed = [];
    let seq = 0;
    const stats = { submitted: 0, assigned: 0, completed: 0, requeued: 0, dispatchPasses: 0, unfittableFlags: 0 };
    const canPlace = (w, j) =>
      !w.down &&
      (kind === "overcommit-memory" || w.capMem - w.usedMem >= j.memoryMb) &&
      (kind === "overcommit-slots" || w.capSlots - w.usedSlots >= j.browserSlots);
    return {
      on() {},
      registerWorker(spec) {
        workers.set(spec.id, { id: spec.id, capMem: spec.capacity.memoryMb, capSlots: spec.capacity.browserSlots, usedMem: 0, usedSlots: 0, runningCount: 0, down: false });
      },
      submit(spec) {
        const j = { id: spec.id, priority: spec.priority ?? 0, memoryMb: spec.resources?.memoryMb ?? 0, browserSlots: spec.resources?.browserSlots ?? 0, seq: ++seq, state: "pending", attempts: 0 };
        jobs.set(j.id, j);
        pending.push(j.id);
        stats.submitted += 1;
        return { id: j.id, state: j.state, attempts: 0 };
      },
      dispatch() {
        stats.dispatchPasses += 1;
        const placements = [];
        const order = kind === "fifo"
          ? [...pending].sort((a, b) => jobs.get(a).seq - jobs.get(b).seq) // BUG under test: submission order, priority ignored
          : [...pending].sort((a, b) => jobs.get(b).priority - jobs.get(a).priority || jobs.get(a).seq - jobs.get(b).seq);
        for (const id of order) {
          const j = jobs.get(id);
          const w = [...workers.values()].find((x) => canPlace(x, j)); // first-fit (wrong tiebreak is fine — limits still hold)
          if (!w) continue;
          w.usedMem += j.memoryMb;
          w.usedSlots += j.browserSlots;
          w.runningCount += 1;
          j.state = "running";
          pending.splice(pending.indexOf(id), 1);
          running.set(id, w.id);
          stats.assigned += 1;
          placements.push({ jobId: id, workerId: w.id, priority: j.priority, memoryMb: j.memoryMb, browserSlots: j.browserSlots, attempts: j.attempts });
        }
        return placements;
      },
      release(workerId, jobId) {
        const w = workers.get(workerId);
        const j = jobs.get(jobId);
        running.delete(jobId);
        w.usedMem -= j.memoryMb;
        w.usedSlots -= j.browserSlots;
        w.runningCount -= 1;
        j.state = "completed";
        completed.push({ jobId, workerId, completedAt: nowIso(), attempts: j.attempts });
        stats.completed += 1;
      },
      markWorkerDown(workerId) {
        const w = workers.get(workerId);
        w.down = true;
        const requeued = [];
        for (const [jobId, wid] of [...running]) {
          if (wid !== workerId) continue;
          const j = jobs.get(jobId);
          w.usedMem -= j.memoryMb;
          w.usedSlots -= j.browserSlots;
          w.runningCount -= 1;
          running.delete(jobId);
          j.state = "pending";
          j.attempts += 1;
          pending.push(jobId);
          requeued.push(jobId);
          stats.requeued += 1;
        }
        return requeued;
      },
      markWorkerUp(workerId) { workers.get(workerId).down = false; },
      removeWorker(workerId) { workers.delete(workerId); },
      snapshot() {
        return {
          mode: kind,
          pending: pending.map((id) => { const j = jobs.get(id); return { id, priority: j.priority, seq: j.seq, resources: { memoryMb: j.memoryMb, browserSlots: j.browserSlots }, unfittable: false, state: "pending", attempts: j.attempts }; }),
          running: [...running].map(([id, wid]) => ({ id, worker: wid, state: "running" })),
          unfittable: [],
          workers: [...workers.values()].map((w) => ({ id: w.id, capacity: { memoryMb: w.capMem, browserSlots: w.capSlots }, used: { memoryMb: w.usedMem, browserSlots: w.usedSlots }, runningJobs: w.runningCount, down: w.down, remaining: {}, memoryUtilization: 0, slotUtilization: 0 })),
          completedRecent: [...completed],
          totals: { pending: pending.length, running: running.size, completed: completed.length, unfittablePending: 0 },
        };
      },
      stats() { return { ...stats }; },
    };
  };

  const base = { workers: B_WORKERS.map((w) => ({ ...w })), jobs: B_JOBS.map((j) => ({ ...j })), durations: B_DURATIONS };

  const runFifo = runSimulation({ mode: "strict", ...base, makeScheduler: (mode, iso) => makeBrokenEngine("fifo", iso) });
  check("C.1 battery catches a priority-ignoring packer (priority-jump violations detected)", runFifo.violations.filter((v) => v.label.includes("priority-jump")).length > 0, `jumps=${runFifo.violations.filter((v) => v.label.includes("priority-jump")).length}`);
  check("C.2 battery also flags it against the reference packer (oracle mismatch)", runFifo.violations.filter((v) => v.label.includes("ORACLE-MISMATCH")).length > 0, `mismatches=${runFifo.violations.filter((v) => v.label.includes("ORACLE-MISMATCH")).length}`);
  check("C.3 the fifo engine is wrong ONLY in order — zero limit violations (checker precision)", runFifo.violations.filter((v) => /OVERCOMMIT|NEGATIVE|LEDGER/.test(v.label)).length === 0, JSON.stringify(runFifo.violations.filter((v) => /OVERCOMMIT|NEGATIVE|LEDGER/.test(v.label)).slice(0, 2)));

  const runMem = runSimulation({ mode: "strict", ...base, makeScheduler: (mode, iso) => makeBrokenEngine("overcommit-memory", iso) });
  check("C.4 battery catches a memory-overcommitting packer (OVERCOMMIT detected)", runMem.violations.filter((v) => v.label.includes("OVERCOMMIT")).length > 0, `hits=${runMem.violations.filter((v) => v.label.includes("OVERCOMMIT")).length}`);

  const runSlot = runSimulation({ mode: "strict", ...base, makeScheduler: (mode, iso) => makeBrokenEngine("overcommit-slots", iso) });
  check("C.5 battery catches a slot-overcommitting packer (OVERCOMMIT detected)", runSlot.violations.filter((v) => v.label.includes("OVERCOMMIT")).length > 0, `hits=${runSlot.violations.filter((v) => v.label.includes("OVERCOMMIT")).length}`);
}

// =====================================================================
// Part C — seeded stress: 60 jobs / 5 workers, both modes
// =====================================================================
console.log("\n--- Part D: seeded stress — 60 jobs / 5 workers (LCG, deterministic) ---");
{
  let seed = 0x42477;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  const C_WORKERS = [
    { id: "cw-1", capacity: { memoryMb: 8192, browserSlots: 3 } },
    { id: "cw-2", capacity: { memoryMb: 4096, browserSlots: 2 } },
    { id: "cw-3", capacity: { memoryMb: 4096, browserSlots: 1 } },
    { id: "cw-4", capacity: { memoryMb: 2048, browserSlots: 2 } },
    { id: "cw-5", capacity: { memoryMb: 2048, browserSlots: 1 } },
  ];
  const C_JOBS = [];
  for (let i = 0; i < 60; i++) {
    C_JOBS.push({
      id: `cj-${i}`,
      priority: pick([1, 1, 5, 5, 5, 10]),
      memoryMb: pick([256, 256, 512, 512, 1024, 1024, 1536, 2048, 3072, 4096]),
      browserSlots: pick([1, 1, 1, 2]),
    });
  }
  const C_DURATIONS = new Map(C_JOBS.map((j) => [j.id, 5 + Math.floor(rnd() * 45)]));

  for (const mode of ["strict", "backfill"]) {
    const run = runSimulation({ mode, workers: C_WORKERS.map((w) => ({ ...w })), jobs: C_JOBS.map((j) => ({ ...j })), durations: C_DURATIONS });
    const { snapshot, stats, violations } = run;
    check(`D.${mode} all 60 jobs completed, nothing stranded`, snapshot.totals.completed === 60 && snapshot.totals.pending === 0 && snapshot.totals.running === 0, JSON.stringify(snapshot.totals));
    check(`D.${mode} zero overcommit/negative/ledger violations`, violations.filter((v) => /OVERCOMMIT|NEGATIVE|LEDGER/.test(v.label)).length === 0, JSON.stringify(violations.slice(0, 2)));
    check(`D.${mode} oracle agreement on every pass`, violations.filter((v) => v.label.includes("ORACLE-MISMATCH")).length === 0, JSON.stringify(violations.slice(0, 2)));
    check(`D.${mode} zero priority jumps`, violations.filter((v) => v.label.includes("priority-jump")).length === 0, JSON.stringify(violations.slice(0, 2)));
    check(`D.${mode} no starvation (event guard never tripped)`, !violations.some((v) => v.label.includes("EVENT-GUARD")), `events processed, makespan=${run.simClock}ms`);
    check(`D.${mode} stats consistent`, stats.submitted === 60 && stats.completed === 60 && stats.assigned >= 60 && stats.assigned === stats.completed + snapshot.totals.pending + snapshot.totals.running, JSON.stringify(stats));
  }
}

// =====================================================================
// Part E — assign() oracle-mode contract (consumed by the 4.2.6
// cost-aware scheduler): candidate-order placement, ledger reservations,
// release(null, { jobId }) best-effort form, flat worker descriptors.
// =====================================================================
console.log("\n--- Part E: assign() contract (4.2.6 cost-aware integration) ---");
{
  const flatWorker = (workerId, regionId, { memory = 8192, slots = 2 } = {}) =>
    ({ workerId, regionId, memoryTotal: memory, memoryFree: memory, browserSlotsTotal: slots, browserSlotsFree: slots });

  // E1: factory({ workers: [flat] }) + listWorkers() flat descriptors
  const s1 = new ResourceScheduler({ workers: [flatWorker("w1", "r1"), flatWorker("w2", "r2", { memory: 4096, slots: 1 })] });
  const lw = s1.listWorkers();
  check("E1.1 flat worker spec registers; listWorkers() returns flat descriptors", lw.length === 2 && lw[0].workerId === "w1" && lw[0].regionId === "r1" && lw[0].memoryTotal === 8192 && lw[0].memoryFree === 8192 && lw[0].browserSlotsFree === 2, JSON.stringify(lw));

  // E2: candidate ORDER wins (first-fit in the caller's preference order)
  const d2 = s1.assign({ jobId: "j-order", memory: 1024, browserSlots: 1 }, { candidates: [{ workerId: "w1" }, { workerId: "w2" }] });
  check("E2.1 assign places on the FIRST fitting candidate (order, not best-fit)", !!d2 && d2.workerId === "w1" && d2.regionId === "r1" && d2.jobId === "j-order", JSON.stringify(d2));

  // E3: ledger reservation is real — dispatch cannot overcommit it.
  // w1 holds 8192; j-order reserved 1024 → 7168 free. A 7200 MB job fits
  // w1's TOTAL but not its remaining capacity → must wait.
  s1.submit({ id: "big", priority: 10, resources: { memoryMb: 7200, browserSlots: 1 } });
  const placed = s1.dispatch();
  check("E3.1 after assign reserved 1024 MB on w1, dispatch packs elsewhere or waits", placed.length === 0 && s1.snapshot().pending.some((j) => j.id === "big") && s1.listWorkers().find((w) => w.workerId === "w1").memoryFree === 8192 - 1024, JSON.stringify({ placed: placed.length, w1: s1.listWorkers().find((w) => w.workerId === "w1") }));

  // E4: release(null, { jobId }) frees the reservation (best-effort form)
  const freed = s1.release(null, { jobId: "j-order", regionId: "r1", runtimeMs: 42 });
  check("E4.1 release(null, {jobId}) frees the assign reservation", !!freed && freed.workerId === "w1" && s1.listWorkers().find((w) => w.workerId === "w1").memoryFree === 8192, JSON.stringify(freed));
  check("E4.2 freed capacity lets dispatch place the waiting job", s1.dispatch().map((p) => p.jobId).join(",") === "big");

  // E5: unknown job through the best-effort form is a silent no-op
  check("E5.1 release(null, {jobId: unknown}) → null, no throw", s1.release(null, { jobId: "never-existed" }) === null);

  // E6: no fit → null (never throws); both memory and slots paths
  check("E6.1 assign with oversized memory → null", s1.assign({ jobId: "no-mem", memory: 1e9, browserSlots: 1 }, { candidates: [{ workerId: "w1" }] }) === null);
  check("E6.2 assign with too many slots → null", s1.assign({ jobId: "no-slot", memory: 512, browserSlots: 99 }, { candidates: [{ workerId: "w1" }] }) === null);

  // E7: downed workers are skipped; duplicate active id → null
  s1.markWorkerDown("w1");
  check("E7.1 assign skips downed workers", s1.assign({ jobId: "j-d", memory: 512, browserSlots: 1 }, { candidates: [{ workerId: "w1" }, { workerId: "w2" }] })?.workerId === "w2");
  s1.release(null, { jobId: "j-d" }); // free w2's only slot before the dup probe
  const d7 = s1.assign({ jobId: "j-dup", memory: 512, browserSlots: 1 }, { candidates: [{ workerId: "w2" }] });
  check("E7.2 duplicate active jobId via assign → null", d7 !== null && s1.assign({ jobId: "j-dup", memory: 512, browserSlots: 1 }, { candidates: [{ workerId: "w2" }] }) === null, JSON.stringify(d7));
  s1.release(null, { jobId: "j-dup" });

  // E8: no candidates → whole-fleet fallback; malformed job → INVALID_JOB
  const s8 = new ResourceScheduler({ workers: [flatWorker("solo", "r-solo")] });
  check("E8.1 assign without candidates packs across the whole fleet", s8.assign({ jobId: "j-solo", memory: 100, browserSlots: 1 })?.workerId === "solo");
  check("E8.2 malformed assign job → INVALID_JOB", errCode(() => s8.assign({ jobId: "x", memory: -5 })) === "INVALID_JOB");
  check("E8.3 native shape still validates after the flat-shape addition", errCode(() => s8.registerWorker({ id: "nat", capacity: { memoryMb: 100 } })) === "INVALID_WORKER"); // browserSlots missing → INVALID_WORKER

  // E9: THE REAL CROSS-LANE WIRING — drive the actual 4.2.6 cost-aware
  // scheduler with THIS module as its injected base (same call the probe in
  // scripts/test-cost-scheduler.mjs Part P makes).
  const { createCostAwareScheduler } = await import("../src/distributed/cost-aware-scheduler.js");
  const clockVal = { now: 0 };
  const base = new ResourceScheduler({ workers: [flatWorker("w1", "r1")] });
  const cost = createCostAwareScheduler({ base, regions: [{ id: "r1" }], regionPricing: { r1: { hourlyRate: 1 } }, workers: base.listWorkers(), clock: () => clockVal.now });
  const d9 = cost.schedule({ jobId: "j-live", priority: 10, memory: 512, browserSlots: 1 });
  check("E9.1 real 4.2.6 cost-aware scheduler runs on top of THIS scheduler (decision=run, region=r1)", d9.decision === "run" && d9.regionId === "r1" && d9.workerId === "w1", JSON.stringify(d9));
  check("E9.2 the reservation landed in THIS scheduler's ledger", base.listWorkers().find((w) => w.workerId === "w1").memoryFree === 8192 - 512);
  cost.onJobComplete("j-live", { regionId: "r1", runtimeMs: 1000 });
  check("E9.3 cost-aware completion path freed the base reservation", base.listWorkers().find((w) => w.workerId === "w1").memoryFree === 8192);
}

// ---------- summary ----------
const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n${passed}/${total} checks passed${failed ? " — FAILURES ABOVE" : " — ALL GREEN"}`);
if (failed) process.exit(1);
