#!/usr/bin/env node
// Cost-aware scheduler simulation tests (task 4.2.13).
//
// Deterministic, in-process simulations with an injected fake clock — no
// network, no database, no real regions. The 4.2.7 resource scheduler is
// INJECTED, so the suite ships a faithful reference implementation of the
// documented base contract (assign(job, { candidates }) with resource packing)
// as the remote-side simulator — the same pattern as clone-queue's
// bullmqFactory test hook. Product code (src/distributed/cost-aware-scheduler.js)
// contains no simulation logic.
//
// Coverage:
//   A. construction + validation (missing base, dup regions, missing pricing, bad windows, bad env JSON)
//   B. cheaper-region preference when SLA allows
//   C. urgent jobs prefer the fast region when the cheap one is congested
//   D. deadline feasibility: cheapest SLA-FEASIBLE region (not cheapest overall)
//   E. no region meets the deadline → fastest chosen, SLA never causes a reject
//   F. resource exhaustion → reject, base consulted
//   G. region affinity honored / unsatisfiable affinity rejected
//   H. off-peak deferral: peak-time batch job deferred to the exact window start
//   I. cost ledger exactness (off-peak vs peak multiplier math)
//   J. deferral guards: deadline, maxDeferralMs cap, minSavingsFraction,
//      maxDeferrals, deferrable:false, high priority
//   K. timezone arbitrage: off-peak region NOW beats cheaper-at-peak region
//   L. weekends are off-peak for weekday-only windows
//   M. 10 jobs / 3 regions / 24h timeline simulation with invariants
//   N. determinism: identical inputs → identical decisions + ledger
//   O. env-config integration (COST_AWARE_CONFIG / COST_AWARE_REGION_PRICING)
//   P. live 4.2.7 scheduler probe (skips loudly while the sibling task is not landed)
import fs from "node:fs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n-- ${t} --`);

const watchdog = setTimeout(() => {
  console.log("FAIL  global timeout (60s)");
  process.exit(1);
}, 60_000);
watchdog.unref();

const HOUR = 3600_000;
const MIN = 60_000;

// deterministic epoch anchors — 2026-03-02 is a Monday
const T_PEAK = Date.UTC(2026, 2, 2, 10, 30, 0); // Mon 10:30 UTC (inside 9-17 window)
const T_OFFPEAK = Date.UTC(2026, 2, 2, 18, 30, 0); // Mon 18:30 UTC
const T_WEEKEND = Date.UTC(2026, 2, 7, 10, 0, 0); // Sat 10:00 UTC
const WINDOW_9_17 = [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }];

const { createCostAwareScheduler } = await import("../src/distributed/cost-aware-scheduler.js");

// ---------- helpers ----------

function makeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => (t = ms),
    advance: (ms) => (t += ms),
    get: () => t,
  };
}

// Reference implementation of the 4.2.7 base-scheduler contract (remote-side
// simulator, test-only): resource packing over candidates in preference order.
function createReferenceBaseScheduler(workers) {
  const state = new Map(workers.map((w) => [w.workerId, { ...w }]));
  const reservations = new Map(); // jobId -> { workerId, memory, browserSlots }
  let assignCalls = 0;
  return {
    assign(job, { candidates } = {}) {
      assignCalls++;
      for (const c of candidates ?? []) {
        const s = state.get(c.workerId);
        if (!s) continue;
        const needMem = job.memory ?? 0;
        const needSlots = job.browserSlots ?? 0;
        if ((s.memoryFree ?? Infinity) >= needMem && (s.browserSlotsFree ?? Infinity) >= needSlots) {
          s.memoryFree -= needMem;
          s.browserSlotsFree -= needSlots;
          reservations.set(job.jobId, { workerId: s.workerId, memory: needMem, slots: needSlots });
          return { workerId: s.workerId, regionId: s.regionId };
        }
      }
      return null;
    },
    release(_handle, info) {
      const r = reservations.get(info?.jobId);
      if (!r) return;
      reservations.delete(info.jobId);
      const s = state.get(r.workerId);
      if (s) {
        s.memoryFree += r.memory;
        s.browserSlotsFree += r.slots;
      }
    },
    listWorkers() {
      return Array.from(state.values());
    },
    snapshot() {
      return Array.from(state.values()).map((w) => ({ ...w }));
    },
    assignCallCount: () => assignCalls,
  };
}

function mkWorker(workerId, regionId, { memory = 8192, slots = 2 } = {}) {
  return { workerId, regionId, memoryTotal: memory, memoryFree: memory, browserSlotsTotal: slots, browserSlotsFree: slots };
}

// ---------- A. construction + validation ----------
section("A. construction + validation");
{
  const prevConfig = process.env.COST_AWARE_CONFIG;
  const prevPricing = process.env.COST_AWARE_REGION_PRICING;
  delete process.env.COST_AWARE_CONFIG;
  delete process.env.COST_AWARE_REGION_PRICING;
  try {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const regions = [{ id: "r1" }];

    let threw = "";
    try {
      createCostAwareScheduler({ regions, regionPricing: { r1: { hourlyRate: 1 } } });
    } catch (e) {
      threw = String(e.message);
    }
    check("A1 missing injected base scheduler throws", threw.includes("4.2.7"), threw.slice(0, 80));

    threw = "";
    try {
      createCostAwareScheduler({
        base,
        regions: [{ id: "r1" }, { id: "r1" }],
        regionPricing: { r1: { hourlyRate: 1 } },
      });
    } catch (e) {
      threw = String(e.message);
    }
    check("A2 duplicate region ids throw", threw.includes("duplicate region ids"), threw.slice(0, 80));

    threw = "";
    try {
      createCostAwareScheduler({ base, regions, regionPricing: {} });
    } catch (e) {
      threw = String(e.message);
    }
    check("A3 missing region pricing throws", threw.includes("missing region pricing"), threw.slice(0, 80));

    threw = "";
    try {
      createCostAwareScheduler({
        base,
        regions,
        regionPricing: { r1: { hourlyRate: 1 } },
        config: { peakWindows: [{ startHour: 17, endHour: 9 }] },
      });
    } catch (e) {
      threw = String(e.message);
    }
    check("A4 peak window crossing midnight throws", threw.includes("endHour > startHour"), threw.slice(0, 80));

    process.env.COST_AWARE_CONFIG = "{not json";
    threw = "";
    try {
      createCostAwareScheduler({ base, regions, regionPricing: { r1: { hourlyRate: 1 } } });
    } catch (e) {
      threw = String(e.message);
    }
    check("A5 invalid COST_AWARE_CONFIG JSON throws", threw.includes("COST_AWARE_CONFIG"), threw.slice(0, 80));
  } finally {
    if (prevConfig === undefined) delete process.env.COST_AWARE_CONFIG;
    else process.env.COST_AWARE_CONFIG = prevConfig;
    if (prevPricing === undefined) delete process.env.COST_AWARE_REGION_PRICING;
    else process.env.COST_AWARE_REGION_PRICING = prevPricing;
  }
}

// ---------- B. cheaper-region preference ----------
section("B. cheaper-region preference when SLA allows");
{
  const base = createReferenceBaseScheduler([mkWorker("w-exp", "r-exp"), mkWorker("w-cheap", "r-cheap")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-exp" }, { id: "r-cheap" }],
    regionPricing: { "r-exp": { hourlyRate: 5, fixedPerJob: 0.1 }, "r-cheap": { hourlyRate: 1, fixedPerJob: 0.1 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
    config: { peakWindows: [] }, // always off-peak → pure region-cost comparison
  });
  const job = { jobId: "j-b1", priority: 10, memory: 1024, browserSlots: 1, estimatedRuntimeMs: HOUR };
  const d = s.schedule(job);
  check("B1 batch job routed to the cheaper region", d.decision === "run" && d.regionId === "r-cheap", JSON.stringify(d));
  check("B2 cost = 1.0/h * 1h * off-peak(0.5, no windows) + fixed 0.1 = 0.6", d.cost === 0.6, `cost=${d.cost}`);
  check("B3 reason=cheapest_region, slaMet", d.reason === "cheapest_region" && d.slaMet === true, d.reason);
  check("B4 base scheduler was consulted (assign called once)", base.assignCallCount() === 1, `calls=${base.assignCallCount()}`);
}

// ---------- C. urgent vs cheap-but-congested ----------
section("C. urgent jobs prefer the fast region; batch still goes cheap");
{
  const base = createReferenceBaseScheduler([mkWorker("w-cheap", "r-cheap"), mkWorker("w-fast", "r-fast")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-cheap" }, { id: "r-fast" }],
    regionPricing: { "r-cheap": { hourlyRate: 1 }, "r-fast": { hourlyRate: 5 } },
    workers: base.listWorkers(),
    regionSignals: { getQueueDepth: (r) => (r === "r-cheap" ? 10 : 0), getAvgRuntimeMs: () => 5 * MIN },
    clock: () => clock.now(),
    config: { peakWindows: [] },
  });
  const urgent = s.schedule({ jobId: "j-urg", priority: 90, memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("C1 urgent job avoids the 50-min congested cheap region → r-fast", urgent.regionId === "r-fast", JSON.stringify(urgent));
  check("C2 urgent reason=urgent_region_selected", urgent.reason === "urgent_region_selected", urgent.reason);
  const batch = s.schedule({ jobId: "j-batch", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("C3 batch job still takes the congested cheap region", batch.regionId === "r-cheap", JSON.stringify(batch));
  const urgentClass = s.schedule({ jobId: "j-urg2", urgency: "urgent", memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("C4 urgency:'urgent' class behaves like high priority", urgentClass.regionId === "r-fast", JSON.stringify(urgentClass));
}

// ---------- D. deadline feasibility ----------
section("D. cheapest SLA-FEASIBLE region (deadline-aware)");
{
  const base = createReferenceBaseScheduler([mkWorker("w-cheap", "r-cheap"), mkWorker("w-fast", "r-fast")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-cheap" }, { id: "r-fast" }],
    regionPricing: { "r-cheap": { hourlyRate: 1 }, "r-fast": { hourlyRate: 5 } },
    workers: base.listWorkers(),
    regionSignals: { getQueueDepth: (r) => (r === "r-cheap" ? 10 : 0), getAvgRuntimeMs: () => 5 * MIN },
    clock: () => clock.now(),
    config: { peakWindows: [] },
  });
  const tight = s.schedule({ jobId: "j-tight", priority: 50, deadlineAt: T_PEAK + 10 * MIN, memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("D1 tight deadline → fast region (cheap one misses the SLA)", tight.regionId === "r-fast", JSON.stringify(tight));
  check("D2 tight-deadline reason=cheapest_sla_feasible", tight.reason === "cheapest_sla_feasible", tight.reason);
  const slack = s.schedule({ jobId: "j-slack", priority: 50, deadlineAt: T_PEAK + 8 * HOUR, memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("D3 generous deadline → cheap region wins", slack.regionId === "r-cheap", JSON.stringify(slack));
}

// ---------- E. no region meets the deadline ----------
section("E. impossible deadline → fastest region, never a reject");
{
  const base = createReferenceBaseScheduler([mkWorker("w-cheap", "r-cheap"), mkWorker("w-fast", "r-fast")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-cheap" }, { id: "r-fast" }],
    regionPricing: { "r-cheap": { hourlyRate: 1 }, "r-fast": { hourlyRate: 5 } },
    workers: base.listWorkers(),
    regionSignals: { getQueueDepth: (r) => (r === "r-cheap" ? 10 : 0), getAvgRuntimeMs: () => 5 * MIN },
    clock: () => clock.now(),
    config: { peakWindows: [] },
  });
  const d = s.schedule({ jobId: "j-imposs", priority: 50, deadlineAt: T_PEAK + 3 * MIN, memory: 512, browserSlots: 1, estimatedRuntimeMs: 5 * MIN });
  check("E1 impossible deadline still runs (fastest region)", d.decision === "run" && d.regionId === "r-fast", JSON.stringify(d));
  check("E2 slaMet=false, reason=no_region_meets_sla_fastest_chosen", d.slaMet === false && d.reason === "no_region_meets_sla_fastest_chosen", d.reason);
}

// ---------- F. resource exhaustion ----------
section("F. resource exhaustion → reject, base consulted");
{
  const base = createReferenceBaseScheduler([mkWorker("w1", "r1", { memory: 1024, slots: 1 }), mkWorker("w2", "r2", { memory: 1024, slots: 1 })]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r1" }, { id: "r2" }],
    regionPricing: { r1: { hourlyRate: 1 }, r2: { hourlyRate: 2 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
  });
  s.schedule({ jobId: "j-fill1", priority: 50, memory: 1024, browserSlots: 1 });
  s.schedule({ jobId: "j-fill2", priority: 50, memory: 1024, browserSlots: 1 });
  const before = base.assignCallCount();
  const d = s.schedule({ jobId: "j-overflow", priority: 90, memory: 1024, browserSlots: 1 });
  check("F1 job exceeding every worker's resources is rejected", d.decision === "reject" && d.reason === "no_worker_has_capacity", JSON.stringify(d));
  check("F2 base scheduler was consulted for the rejected job", base.assignCallCount() === before + 1, `calls=${base.assignCallCount()}`);
}

// ---------- G. region affinity ----------
section("G. region affinity");
{
  const base = createReferenceBaseScheduler([mkWorker("w-exp", "r-exp"), mkWorker("w-cheap", "r-cheap")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-exp" }, { id: "r-cheap" }],
    regionPricing: { "r-exp": { hourlyRate: 5 }, "r-cheap": { hourlyRate: 1 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
    config: { peakWindows: [] },
  });
  const pinned = s.schedule({ jobId: "j-pin", priority: 10, regionAffinity: ["r-exp"], memory: 512, browserSlots: 1 });
  check("G1 affinity pins the job to the expensive region", pinned.decision === "run" && pinned.regionId === "r-exp", JSON.stringify(pinned));
  const bad = s.schedule({ jobId: "j-bad", priority: 10, regionAffinity: ["r-nowhere"], memory: 512, browserSlots: 1 });
  check("G2 unsatisfiable affinity → reject", bad.decision === "reject" && bad.reason === "region_affinity_unsatisfiable", JSON.stringify(bad));
}

// ---------- H. off-peak deferral ----------
section("H. off-peak deferral of a non-urgent job");
{
  const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
    regionPricing: { r1: { hourlyRate: 2 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
  });
  const job = { jobId: "j-defer", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR };
  const d = s.schedule(job);
  const expectedStart = Date.UTC(2026, 2, 2, 17, 0, 0); // Mon 17:00 UTC
  check("H1 peak-time batch job deferred", d.decision === "defer", JSON.stringify(d));
  check("H2 startAt = exact off-peak window start (Mon 17:00 UTC)", d.startAt === expectedStart, `startAt=${new Date(d.startAt).toISOString()}`);
  check("H3 costNow=2.0, costAtStart=1.0, savings=0.5", d.costNow === 2 && d.costAtStart === 1 && d.savings === 0.5, `${d.costNow}/${d.costAtStart}/${d.savings}`);
  check("H4 deferred job does NOT reserve base resources", base.assignCallCount() === 0, `calls=${base.assignCallCount()}`);
  check("H5 job sits in the defer queue", s.getDeferred().length === 1 && s.getDeferred()[0].jobId === "j-defer", JSON.stringify(s.getDeferred()));

  const urgent = s.schedule({ jobId: "j-urgent-now", priority: 90, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
  check("H6 urgent twin at the same peak moment runs immediately", urgent.decision === "run" && urgent.peak === true && urgent.regionId === "r1", JSON.stringify(urgent));

  clock.set(expectedStart);
  const callsBefore = base.assignCallCount(); // 1 — the urgent twin from H6
  const released = s.poll();
  check("H7 poll at window start releases exactly one job → run, off-peak", released.length === 1 && released[0].decision.decision === "run" && released[0].decision.peak === false, JSON.stringify(released));
  check("H8 released job assigned on the base scheduler (twin + release = 2)", base.assignCallCount() === callsBefore + 1, `calls=${base.assignCallCount()}`);
  const again = s.poll();
  check("H9 second poll releases nothing (no double-run)", again.length === 0 && s.getDeferred().length === 0, JSON.stringify(again));
}

// ---------- I. cost ledger exactness ----------
section("I. cost ledger exactness");
{
  const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
  const clock = makeClock(T_PEAK);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
    regionPricing: { r1: { hourlyRate: 2 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
  });
  const peakRun = s.onJobComplete("j-peak", { runtimeMs: HOUR, regionId: "r1", startedAt: T_PEAK });
  const offStart = Date.UTC(2026, 2, 2, 17, 0, 0);
  const offRun = s.onJobComplete("j-off", { runtimeMs: HOUR, regionId: "r1", startedAt: offStart });
  check("I1 peak-hour job costs exactly 2.0 and is flagged peak", peakRun.cost === 2 && peakRun.peak === true, JSON.stringify(peakRun));
  check("I2 off-peak job costs exactly 1.0 (50% discount)", offRun.cost === 1 && offRun.peak === false, JSON.stringify(offRun));
  const spend = s.getSpend();
  check("I3 getSpend totals 3.0 over 2 jobs", spend.cost === 3 && spend.jobs === 2, JSON.stringify(spend));
  const peakOnly = s.getSpend({ peak: true });
  check("I4 getSpend({peak:true}) = 2.0", peakOnly.cost === 2 && peakOnly.jobs === 1, JSON.stringify(peakOnly));
  let threw = false;
  try {
    s.onJobComplete("j-bad", { runtimeMs: HOUR, regionId: "r-unknown" });
  } catch {
    threw = true;
  }
  check("I5 completion for an unpriced region throws", threw, "");
}

// ---------- J. deferral guards ----------
section("J. deferral guards");
{

  // J1 deadline blocks deferral
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
    });
    const d = s.schedule({ jobId: "j1", priority: 10, deadlineAt: T_PEAK + 3 * HOUR, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("J1 deadline before the off-peak window → runs at peak", d.decision === "run" && d.peak === true, JSON.stringify(d));
  }
  // J2 maxDeferralMs cap
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
      config: { maxDeferralMs: 3 * HOUR }, // 6.5h until off-peak → plan rejected
    });
    const d = s.schedule({ jobId: "j2", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("J2 deferral beyond maxDeferralMs is refused → runs at peak", d.decision === "run" && d.peak === true, JSON.stringify(d));
  }
  // J3 minSavingsFraction
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
      config: { offPeakDiscount: 0.05 }, // 5% savings < 10% threshold
    });
    const d = s.schedule({ jobId: "j3", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("J3 savings below minSavingsFraction → runs at peak", d.decision === "run" && d.peak === true, JSON.stringify(d));
  }
  // J4 maxDeferrals guard
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
      config: { maxDeferrals: 1 },
    });
    const job = { jobId: "j4", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR };
    const first = s.schedule(job);
    const second = s.schedule(job); // re-submitted while still deferred
    check(
      "J4 first submit defers; immediate re-submit runs at peak (max_deferrals_reached)",
      first.decision === "defer" && second.decision === "run" && second.reason === "max_deferrals_reached_ran_at_peak",
      `first=${first.decision} second=${second.decision}/${second.reason}`
    );
    s.cancelDeferred("j4");
  }
  // J5 deferrable:false
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
    });
    const d = s.schedule({ jobId: "j5", priority: 10, deferrable: false, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("J5 deferrable:false job never deferred", d.decision === "run" && d.peak === true, JSON.stringify(d));
  }
  // J6 high default priority threshold
  {
    const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({
      base,
      regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
      regionPricing: { r1: { hourlyRate: 2 } },
      workers: base.listWorkers(),
      clock: () => clock.now(),
    });
    const d = s.schedule({ jobId: "j6", priority: 95, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("J6 priority 95 (>= threshold 60) treated as urgent → never deferred", d.decision === "run" && d.peak === true, JSON.stringify(d));
  }
}

// ---------- K. timezone arbitrage ----------
section("K. timezone arbitrage — off-peak region wins NOW");
{
  const base = createReferenceBaseScheduler([mkWorker("w-a", "r-a"), mkWorker("w-b", "r-b")]);
  const clock = makeClock(T_PEAK); // 10:30 UTC
  const s = createCostAwareScheduler({
    base,
    regions: [
      { id: "r-a", timezoneOffsetMinutes: 480, peakWindows: [{ startHour: 9, endHour: 17 }] }, // local 18:30 → OFF-peak
      { id: "r-b", timezoneOffsetMinutes: 0, peakWindows: [{ startHour: 9, endHour: 17 }] }, // local 10:30 → peak
    ],
    regionPricing: { "r-a": { hourlyRate: 1.5 }, "r-b": { hourlyRate: 1 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
  });
  const d = s.schedule({ jobId: "j-tz", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
  check("K1 batch job routed to the off-peak (more expensive on-paper) region NOW", d.decision === "run" && d.regionId === "r-a" && d.peak === false, JSON.stringify(d));
  check("K2 no deferral needed (0.75/h off-peak < 1.0/h peak)", d.cost === 0.75, `cost=${d.cost}`);
  const states = s.describeRegionState({ estimatedRuntimeMs: HOUR });
  const a = states.find((x) => x.regionId === "r-a");
  const b = states.find((x) => x.regionId === "r-b");
  check("K3 describeRegionState reflects opposite local peak states", a.peak === false && b.peak === true, JSON.stringify({ a: a.peak, b: b.peak }));
}

// ---------- L. weekends ----------
section("L. weekday-only windows leave weekends off-peak");
{
  const base = createReferenceBaseScheduler([mkWorker("w1", "r1")]);
  const clock = makeClock(T_WEEKEND);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r1", peakWindows: WINDOW_9_17 }],
    regionPricing: { r1: { hourlyRate: 2 } },
    workers: base.listWorkers(),
    clock: () => clock.now(),
  });
  const d = s.schedule({ jobId: "j-wknd", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
  check("L1 Saturday peak-hour-of-day job runs immediately, off-peak", d.decision === "run" && d.peak === false, JSON.stringify(d));
  check("L2 nextOffPeakStart returns `now` when already off-peak", s.nextOffPeakStart("r1") === T_WEEKEND, String(s.nextOffPeakStart("r1")));
}

// ---------- M. 10 jobs / 3 regions / 24h simulation ----------
section("M. timeline simulation — 10 jobs, 3 regions, 24h");
function runTimelineSimulation() {
  const T0 = Date.UTC(2026, 2, 2, 10, 0, 0); // Mon 10:00 UTC — inside the peak window
  const STEP = 30 * MIN;
  const clock = makeClock(T0);
  const CAP = { memory: 16384, slots: 6 }; // enough slots that the cheapest region can host every concurrent job
  const workers = [
    mkWorker("w-west-1", "r-west", CAP),
    mkWorker("w-west-2", "r-west", CAP),
    mkWorker("w-central-1", "r-central", CAP),
    mkWorker("w-central-2", "r-central", CAP),
    mkWorker("w-east-1", "r-east", CAP),
    mkWorker("w-east-2", "r-east", CAP),
  ];
  const base = createReferenceBaseScheduler(workers);
  const s = createCostAwareScheduler({
    base,
    regions: [{ id: "r-west" }, { id: "r-central" }, { id: "r-east" }],
    regionPricing: {
      "r-west": { hourlyRate: 3.0 },
      "r-central": { hourlyRate: 1.8 },
      "r-east": { hourlyRate: 1.2 },
    },
    workers,
    clock: () => clock.now(),
    config: { peakWindows: WINDOW_9_17, offPeakDiscount: 0.5 },
  });

  const jobs = [
    { jobId: "urgent-1", priority: 90, memory: 1024, browserSlots: 1, estimatedRuntimeMs: 10 * MIN },
    { jobId: "urgent-2", priority: 90, memory: 1024, browserSlots: 1, estimatedRuntimeMs: 10 * MIN },
    { jobId: "normal-1", priority: 40, memory: 2048, browserSlots: 1, estimatedRuntimeMs: 15 * MIN, deadlineAt: T0 + 2 * HOUR },
    { jobId: "normal-2", priority: 40, memory: 2048, browserSlots: 1, estimatedRuntimeMs: 15 * MIN, deadlineAt: T0 + 2 * HOUR },
    { jobId: "normal-3", priority: 40, memory: 2048, browserSlots: 1, estimatedRuntimeMs: 15 * MIN, deadlineAt: T0 + 2 * HOUR },
    { jobId: "normal-4", priority: 40, memory: 2048, browserSlots: 1, estimatedRuntimeMs: 15 * MIN, deadlineAt: T0 + 2 * HOUR },
    { jobId: "batch-1", priority: 10, memory: 4096, browserSlots: 1, estimatedRuntimeMs: 30 * MIN },
    { jobId: "batch-2", priority: 10, memory: 4096, browserSlots: 1, estimatedRuntimeMs: 30 * MIN },
    { jobId: "batch-3", priority: 10, memory: 4096, browserSlots: 1, estimatedRuntimeMs: 30 * MIN },
    { jobId: "batch-4", priority: 10, memory: 4096, browserSlots: 1, estimatedRuntimeMs: 30 * MIN },
  ];

  const decisions = []; // { at, jobId, decision }
  const releasedAt = new Map(); // jobId -> simulated step time of release
  const jobById = new Map(jobs.map((j) => [j.jobId, j]));
  for (const job of jobs) decisions.push({ at: clock.now(), jobId: job.jobId, decision: s.schedule(job) });

  // complete the jobs that ran at T0 (urgent + deadline-bound normals) — the
  // poll loop below only covers deferred releases
  for (const d of decisions.slice()) {
    if (d.decision.decision === "run") {
      s.onJobComplete(d.jobId, {
        runtimeMs: jobById.get(d.jobId).estimatedRuntimeMs,
        regionId: d.decision.regionId,
        startedAt: T0,
      });
    }
  }

  const end = T0 + 24 * HOUR;
  while (clock.now() < end) {
    clock.advance(STEP);
    for (const { jobId, decision } of s.poll()) {
      if (releasedAt.has(jobId)) releasedAt.set(jobId, releasedAt.get(jobId) + 1e9); // double release marker
      else releasedAt.set(jobId, clock.now());
      if (decision.decision === "run") {
        s.onJobComplete(jobId, { runtimeMs: jobById.get(jobId).estimatedRuntimeMs, regionId: decision.regionId, startedAt: clock.now() });
        decisions.push({ at: clock.now(), jobId, decision });
      }
    }
  }
  return { s, base, jobs, decisions, releasedAt, T0 };
}

{
  const { s, base, jobs, decisions, releasedAt, T0 } = runTimelineSimulation();
  const byJob = new Map();
  for (const d of decisions) if (!byJob.has(d.jobId) || d.decision.decision !== "defer") byJob.set(d.jobId, d.decision);

  const urgentOk = jobs
    .filter((j) => j.priority === 90)
    .every((j) => {
      const d = byJob.get(j.jobId);
      return d && d.decision === "run" && d.at === T0 && d.peak === true;
    });
  check("M1 both urgent jobs ran immediately at T0 inside the peak window", urgentOk, JSON.stringify(jobs.filter((j) => j.priority === 90).map((j) => byJob.get(j.jobId))));

  const normalRegions = jobs.filter((j) => j.priority === 40).map((j) => byJob.get(j.jobId)?.regionId);
  check("M2 deadline-bound normal jobs ran at T0 in the cheapest region r-east", normalRegions.every((r) => r === "r-east"), JSON.stringify(normalRegions));

  const batchDefers = jobs.filter((j) => j.priority === 10).map((j) => decisions.find((d) => d.jobId === j.jobId).decision);
  const expectedStart = Date.UTC(2026, 2, 2, 17, 0, 0);
  check(
    "M3 all four batch jobs deferred at T0 with startAt=Mon 17:00 UTC",
    batchDefers.every((d) => d.decision === "defer" && d.startAt === expectedStart),
    JSON.stringify(batchDefers.map((d) => ({ decision: d.decision, startAt: d.startAt })))
  );
  const releaseTimes = jobs.filter((j) => j.priority === 10).map((j) => releasedAt.get(j.jobId));
  check(
    "M4 batch jobs released exactly once at the 17:00 step",
    releaseTimes.length === 4 && releaseTimes.every((t) => t === expectedStart),
    JSON.stringify(releaseTimes.map((t) => new Date(t).toISOString()))
  );

  const ledger = s.getCostLedger();
  check("M5 all 10 jobs completed exactly once (ledger = 10 entries)", ledger.length === 10, `entries=${ledger.length}`);
  const batchCosts = ledger.filter((r) => String(r.jobId).startsWith("batch"));
  check(
    "M6 batch jobs paid the off-peak rate (0.3 each < 0.6 peak r-east)",
    batchCosts.length === 4 && batchCosts.every((r) => r.cost === 0.3 && r.peak === false),
    JSON.stringify(batchCosts.map((r) => r.cost))
  );
  const spend = s.getSpend().cost;
  const baseline = jobs.reduce((sum, j) => sum + s.estimateCost(j, "r-west", T0), 0);
  check("M7 cost-aware spend beats the all-rush baseline (2.8 < 10.0)", spend === 2.8 && spend < baseline, `spend=${spend} baseline=${Math.round(baseline * 100) / 100}`);
  const leaks = base.snapshot().filter((w) => w.memoryFree !== w.memoryTotal || w.browserSlotsFree !== w.browserSlotsTotal);
  check("M8 no resource leaks — all worker capacity released after completion", leaks.length === 0, JSON.stringify(leaks));
  const rejects = decisions.filter((d) => d.decision.decision === "reject");
  check("M9 zero rejects across the whole simulation", rejects.length === 0, JSON.stringify(rejects));
}

// ---------- N. determinism ----------
section("N. determinism");
{
  const a = runTimelineSimulation();
  const b = runTimelineSimulation();
  const strip = (run) =>
    JSON.stringify({ decisions: run.decisions, ledger: run.s.getCostLedger(), spend: run.s.getSpend() });
  check("N1 two identical simulations produce byte-identical decisions + ledger", strip(a) === strip(b), `len=${strip(a).length}`);
}

// ---------- O. env-config integration ----------
section("O. env-config integration");
{
  const prevConfig = process.env.COST_AWARE_CONFIG;
  const prevPricing = process.env.COST_AWARE_REGION_PRICING;
  process.env.COST_AWARE_CONFIG = JSON.stringify({
    offPeakDiscount: 0.4,
    peakWindows: [{ startHour: 9, endHour: 17 }],
  });
  process.env.COST_AWARE_REGION_PRICING = JSON.stringify({ e1: { hourlyRate: 2 }, e2: { hourlyRate: 1 } });
  try {
    const base = createReferenceBaseScheduler([mkWorker("w1", "e1"), mkWorker("w2", "e2")]);
    const clock = makeClock(T_PEAK);
    const s = createCostAwareScheduler({ base, regions: [{ id: "e1" }, { id: "e2" }], workers: base.listWorkers(), clock: () => clock.now() });
    const job = { estimatedRuntimeMs: HOUR };
    check("O1 env pricing honored: e1 peak cost = 2.0", s.estimateCost(job, "e1", T_PEAK) === 2, String(s.estimateCost(job, "e1", T_PEAK)));
    check("O2 env discount honored: e1 off-peak = 1.2 (0.6 multiplier)", s.estimateCost(job, "e1", T_OFFPEAK) === 1.2, String(s.estimateCost(job, "e1", T_OFFPEAK)));
    const d = s.schedule({ jobId: "j-env", priority: 10, memory: 512, browserSlots: 1, estimatedRuntimeMs: HOUR });
    check("O3 peak-time batch job defers using env config", d.decision === "defer", JSON.stringify(d));
    check("O4 costAtStart reflects the env off-peak rate on the cheap region", d.costAtStart === 0.6 && d.regionId === "e2", `${d.costAtStart}@${d.regionId}`);
  } finally {
    if (prevConfig === undefined) delete process.env.COST_AWARE_CONFIG;
    else process.env.COST_AWARE_CONFIG = prevConfig;
    if (prevPricing === undefined) delete process.env.COST_AWARE_REGION_PRICING;
    else process.env.COST_AWARE_REGION_PRICING = prevPricing;
  }
}

// ---------- P. real 4.2.7 ResourceScheduler integration (packer mode) ----------
section("P. real 4.2.7 ResourceScheduler integration (packer mode)");
{
  const schedPath = new URL("../src/distributed/scheduler.js", import.meta.url);
  if (!fs.existsSync(schedPath)) {
    console.log("SKIP  P — src/distributed/scheduler.js not present yet (task 4.2.7 runs in parallel)");
  } else {
    const { createResourceScheduler } = await import(schedPath.href);
    const clock = makeClock(T_PEAK);

    // two regions, one worker each, ONE browser slot per worker — capacity
    // exhaustion and strict-mode head-of-line behavior are reachable
    const regionCapacity = { memoryMb: 8192, browserSlots: 1 };
    const mkBase = () => createResourceScheduler({ now: () => new Date(clock.now()).toISOString() });
    const baseCheap = mkBase();
    const baseExp = mkBase();
    baseCheap.registerWorker({ id: "w-cheap", capacity: regionCapacity });
    baseExp.registerWorker({ id: "w-exp", capacity: regionCapacity });

    const s = createCostAwareScheduler({
      bases: { "r-cheap": baseCheap, "r-exp": baseExp },
      regions: [{ id: "r-exp" }, { id: "r-cheap" }],
      regionPricing: { "r-exp": { hourlyRate: 5 }, "r-cheap": { hourlyRate: 1 } },
      workers: [
        { workerId: "w-cheap", regionId: "r-cheap", memoryTotal: 8192, browserSlotsTotal: 1 },
        { workerId: "w-exp", regionId: "r-exp", memoryTotal: 8192, browserSlotsTotal: 1 },
      ],
      clock: () => clock.now(),
      config: { peakWindows: [] },
    });

    const d1 = s.schedule({ jobId: "p-1", priority: 10, memory: 1024, browserSlots: 1 });
    check("P1 cost wrapper routes to the cheap region through the REAL 4.2.7 packer", d1.decision === "run" && d1.regionId === "r-cheap" && d1.workerId === "w-cheap", JSON.stringify(d1));
    check("P2 job is RUNNING on the region base (jobSnapshot)", baseCheap.jobSnapshot("p-1").state === "running", JSON.stringify(baseCheap.jobSnapshot("p-1")));

    const d2 = s.schedule({ jobId: "p-2", priority: 10, memory: 1024, browserSlots: 1 });
    check("P3 cheap region full → QUEUED (base accepted the job, no capacity yet)", d2.decision === "queued" && d2.regionId === "r-cheap", JSON.stringify(d2));
    const d3 = s.schedule({ jobId: "p-3", priority: 10, memory: 1024, browserSlots: 1 });
    check("P4 third job also queued behind p-2 (strict head-of-line in the base)", d3.decision === "queued", JSON.stringify(d3));

    s.onJobComplete("p-1", { runtimeMs: MIN, regionId: "r-cheap", startedAt: clock.now() });
    check("P5 onJobComplete released the base's capacity", baseCheap.workerSnapshot("w-cheap").used.browserSlots === 0, JSON.stringify(baseCheap.workerSnapshot("w-cheap")));

    const drained1 = s.drain().map((x) => x.jobId);
    check("P6 drain() places exactly the head-of-line job (p-2) through the real packer", drained1.length === 1 && drained1[0] === "p-2", JSON.stringify(drained1));
    check("P7 p-2 running, p-3 still pending in the base", baseCheap.jobSnapshot("p-2").state === "running" && baseCheap.jobSnapshot("p-3").state === "pending", "");

    s.onJobComplete("p-2", { runtimeMs: MIN, regionId: "r-cheap", startedAt: clock.now() });
    const drained2 = s.drain().map((x) => x.jobId);
    check("P8 second drain places p-3", drained2.length === 1 && drained2[0] === "p-3" && baseCheap.jobSnapshot("p-3").state === "running", JSON.stringify(drained2));

    const d4 = s.schedule({ jobId: "p-4", priority: 10, memory: 999999, browserSlots: 1 });
    check("P9 job that can never fit is rejected (unfittable_in_region)", d4.decision === "reject" && d4.reason === "unfittable_in_region", JSON.stringify(d4));

    s.onJobComplete("p-3", { runtimeMs: HOUR, regionId: "r-cheap", startedAt: clock.now() });
    const rec = s.getCostLedger().find((r) => r.jobId === "p-3");
    check("P10 packer-mode completion cost exact: 1/h * 1h * off-peak 0.5 = 0.5 (no windows ⇒ always off-peak)", rec && rec.cost === 0.5 && rec.peak === false, JSON.stringify(rec));
  }
}

// ---------- summary ----------
const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\nRESULT: ${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
