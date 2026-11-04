#!/usr/bin/env node
// Worker autoscaling tests (task 4.2.4) — src/workers/scaling-policy.js,
// src/workers/worker-pool-manager.js, src/workers/autoscaler.js.
//
//   Part A (pure, zero services): the scaling-policy DECISION ENGINE driven by
//   a simulated clock — sustained scale-up signals, signal debounce/reset,
//   up/down cooldowns, utilization hysteresis deadband, queue-age signal,
//   per-pool max, per-region cap, min floor, step limits, idle scale-down with
//   an unknown-utilization path, policy validation (inverted hysteresis is a
//   hard error), env parsing, and an 800-tick seeded fuzz asserting the
//   global invariants (no simultaneous up+down, step bounds, cooldown law).
//
//   Part B (zero services): worker-pool-manager over a DETERMINISTIC SIMULATED
//   WORKER FACTORY (the remote-end simulator — worker processes stand in) —
//   min boot, hard max cap, least-busy removal, SAFE DRAIN (close only after
//   active jobs reach 0), forced close on drain-grace expiry, scaleTo clamps,
//   drainAll, and the REAL default factory's clean error when REDIS env is
//   absent.
//
//   Part C (zero services): the AUTOSCALER end-to-end over the simulated clock
//   + simulated metrics + simulated workers — a full burst→plateau→drain
//   lifecycle with the exact action timeline asserted, a fast-flapping load
//   that must produce ZERO actions (debounce), a slow-wave load that must stay
//   inside the cooldown law, the clean no-metrics-source error, and the real
//   start()/stop() interval loop.
//
//   Part D (only when the compose redis on 127.0.0.1:6379 answers): the REAL
//   BullMQ metrics path — default createQueueMetricsProvider reads a real
//   queue's depth + oldest-job age and the autoscaler scales a simulated pool
//   from it. Unreachable → SKIP lines, exit 0.
//
// No credentials: nothing here reads or writes secrets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, detail = "") => console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

// ── deterministic simulated clock ──────────────────────────────────────────
function makeSimClock(startMs = 0) {
  return {
    nowMs: startMs,
    now() { return this.nowMs; },
    advance(ms) { this.nowMs += ms; },
  };
}

// ── deterministic simulated worker factory (the remote-end simulator) ──────
function makeSimWorkerFactory({ concurrency = 1 } = {}) {
  const workers = [];
  const factory = async ({ workerId }) => {
    const w = {
      workerId,
      concurrency,
      active: 0,
      closed: false,
      closeCalls: 0,
      closeLog: [], // { activeAtClose }
      async getActiveJobsCount() { return w.active; },
      async close() { w.closeCalls++; w.closeLog.push({ activeAtClose: w.active }); w.closed = true; },
    };
    workers.push(w);
    return w;
  };
  return { workers, factory };
}

// ── simulated queue metrics + REAL pool stats composition (what the autoscaler
//    consumes; pool side flows through the real refreshActiveJobs/stats code)
function makeSimMetrics(pool, sim) {
  return async () => {
    await pool.refreshActiveJobs();
    const s = pool.stats();
    return {
      queueDepth: sim.depth,
      oldestJobAgeMs: sim.age,
      activeJobs: s.activeJobs,
      workerCount: s.running,
      workerUtilization: s.utilization,
      regionalWorkerCount: s.size,
    };
  };
}

// cooldown law: between two APPLIED actions, the gap must cover the later
// action's direction cooldown (checked on every simulation below)
function cooldownLawViolations(entries, policy) {
  const applied = entries.filter((e) => e.applied);
  const bad = [];
  for (let i = 1; i < applied.length; i++) {
    const prev = applied[i - 1];
    const cur = applied[i];
    const required = cur.action === "scale-up" ? policy.scaleUp.cooldownMs : policy.scaleDown.cooldownMs;
    if (cur.at - prev.at < required) bad.push(`${cur.action}@${cur.at} only ${cur.at - prev.at}ms after ${prev.action}@${prev.at}`);
  }
  return bad;
}

// ===========================================================================
// Part A — scaling policy decision engine (pure, simulated clock)
// ===========================================================================
console.log("\n-- Part A: scaling-policy decision engine (simulated clock) --");
{
  const { defaultScalingPolicy, initialPolicyState, computeScaleDecision, commitAppliedAction, validateScalingPolicy, parsePolicyFromEnv } =
    await import("../src/workers/scaling-policy.js");

  const mkPolicy = (over = {}) => {
    const p = defaultScalingPolicy();
    return {
      ...p, ...over,
      scaleUp: { ...p.scaleUp, ...(over.scaleUp || {}) },
      scaleDown: { ...p.scaleDown, ...(over.scaleDown || {}) },
      idle: { ...p.idle, ...(over.idle || {}) },
    };
  };
  // drive the pure engine tick-by-tick with an injected clock — exactly like
  // the autoscaler does: applied actions are committed (cooldown state advances)
  function runEngine(policy, ticks) {
    // ticks: Array<{ at, metrics }> — must be non-decreasing in `at`
    let state = initialPolicyState();
    const out = [];
    for (const t of ticks) {
      const res = computeScaleDecision({ policy, metrics: t.metrics, state, now: t.at });
      const appliedAction = res.action !== "hold";
      state = appliedAction ? commitAppliedAction(res.nextState, res.action, t.at) : res.nextState;
      out.push({ at: t.at, ...res, applied: appliedAction ? { changed: res.delta } : null });
    }
    return out;
  }
  const baseMetrics = (over = {}) => ({
    queueDepth: 0, oldestJobAgeMs: 0, workerUtilization: null, workerCount: 1, activeJobs: 0, regionalWorkerCount: 1, ...over,
  });

  // A1 — quiet metrics → hold, nothing invented
  {
    const p = mkPolicy();
    const out = runEngine(p, [{ at: 0, metrics: baseMetrics({ queueDepth: 0, workerUtilization: 0.1 }) }]);
    check("A1: quiet metrics → hold with no action", out[0].action === "hold" && out[0].delta === 0, JSON.stringify(out[0].reasons));
    check("A1: hold keeps desired at current worker count", out[0].desired === 1);
  }

  // A2 — sustained depth: exact sustain boundary respected
  {
    const p = mkPolicy();
    const ticks = [0, 4000, 8000, 9999, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 20 }) }));
    const out = runEngine(p, ticks);
    check("A2: no scale-up before the sustain window elapses",
      out.slice(0, 4).every((r) => r.action === "hold"),
      out.slice(0, 4).map((r) => `${r.at}:${r.action}`).join(","));
    check("A2: scale-up fires exactly when sustainMs elapses (t=10000)",
      out[4].action === "scale-up" && out[4].delta === 2 && out[4].desired === 3,
      `${out[4].action} delta=${out[4].delta} desired=${out[4].desired}`);
    check("A2: scale-up reasons carry the queue-depth signal", out[4].reasons.includes("queue-depth"));
  }

  // A3 — signal reset mid-window (debounce): flapping depth never scales
  {
    const p = mkPolicy();
    const ticks = [];
    for (let i = 0; i < 10; i++) {
      ticks.push({ at: i * 5000, metrics: baseMetrics({ queueDepth: i % 2 === 0 ? 20 : 0 }) });
    }
    const out = runEngine(p, ticks);
    check("A3: flapping signal resets the sustain window — zero actions ever",
      out.every((r) => r.action === "hold"), out.filter((r) => r.action !== "hold").length + " actions");
  }

  // A4 — cooldown gates the second scale-up; fires when the cooldown expires
  {
    const p = mkPolicy();
    const ticks = [0, 5000, 10_000, 15_000, 30_000, 40_000, 70_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 20 }) }));
    const out = runEngine(p, ticks);
    const at = Object.fromEntries(out.map((r) => [r.at, r]));
    check("A4: first scale-up at sustain boundary (t=10000, +2 → 3 workers)",
      at[10_000].action === "scale-up" && at[10_000].delta === 2);
    check("A4: second scale-up blocked inside the cooldown (t=15000, t=30000)",
      at[15_000].action === "hold" && at[15_000].reasons.includes("scale-up-cooldown")
      && at[30_000].action === "hold" && at[30_000].reasons.includes("scale-up-cooldown"));
    check("A4: scale-up fires once the cooldown expires (t=40000)",
      at[40_000].action === "scale-up" && at[40_000].delta === 2);
    const law = cooldownLawViolations(out, p);
    check("A4: cooldown law holds across the whole run", law.length === 0, law.join("; "));
  }

  // A5 — utilization hysteresis: deadband between down=0.25 and up=0.8
  {
    const p = mkPolicy();
    const out = runEngine(p, [
      // phase 1: util 1.0 sustained → scale up (depth 0, pure utilization signal)
      ...[0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ workerUtilization: 1, activeJobs: 1 }) })),
      // phase 2: util 0.5 — inside the deadband, for far longer than both windows
      ...[15_000, 30_000, 45_000, 60_000, 75_000].map((at) => ({ at, metrics: baseMetrics({ workerUtilization: 0.5, activeJobs: 1 }) })),
      // phase 3: util 0 sustained → scale down (the pool is now 2 workers
      // after phase 1's scale-up — the metrics must reflect that pool)
      ...[80_000, 95_000, 110_000].map((at) => ({ at, metrics: baseMetrics({ workerCount: 2, regionalWorkerCount: 2, workerUtilization: 0 }) })),
    ]);
    const at = Object.fromEntries(out.map((r) => [r.at, r]));
    check("A5: high utilization sustained → scale-up (t=10000)", at[10_000].action === "scale-up" && at[10_000].reasons.includes("worker-utilization"));
    check("A5: mid-band utilization produces NO action for 60s (hysteresis deadband)",
      [15_000, 30_000, 45_000, 60_000, 75_000].every((t) => at[t].action === "hold" && at[t].reasons.includes("no-signal")),
      [15_000, 30_000, 45_000, 60_000, 75_000].map((t) => `${t}:${at[t].action}(${at[t].reasons.join("|")})`).join(","));
    check("A5: low utilization sustained → scale-down (t=110000)",
      at[110_000].action === "scale-down" && at[110_000].delta === 1,
      `${at[110_000].action} (${at[110_000].reasons.join(",")})`);
    const law = cooldownLawViolations(out, p);
    check("A5: cooldown law holds (down waits out downCooldownMs after the up)", law.length === 0, law.join("; "));
  }

  // A6 — queue-age signal: small depth but starving oldest job → scale up
  {
    const p = mkPolicy();
    const out = runEngine(p, [0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 1, oldestJobAgeMs: 60_000 }) })));
    check("A6: queue-age signal sustained → scale-up", out[2].action === "scale-up" && out[2].reasons.includes("queue-age"),
      `${out[2].action} (${out[2].reasons.join(",")})`);
  }

  // A7 — per-pool max respected
  {
    const p = mkPolicy({ maxWorkers: 2 });
    const out = runEngine(p, [0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 20, workerCount: 2, regionalWorkerCount: 2 }) })));
    check("A7: pool at maxWorkers → hold 'pool-max', no delta", out[2].action === "hold" && out[2].reasons.includes("pool-max") && out[2].delta === 0,
      out[2].reasons.join(","));
  }

  // A8 — per-region cap respected (regional count across ALL pools)
  {
    const p = mkPolicy({ maxWorkers: 8, maxWorkersPerRegion: 3 });
    const out = runEngine(p, [0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 20, workerCount: 2, regionalWorkerCount: 3 }) })));
    check("A8: region at maxWorkersPerRegion → hold 'region-cap'", out[2].action === "hold" && out[2].reasons.includes("region-cap"),
      out[2].reasons.join(","));
    // same policy, headroom available → scales
    const out2 = runEngine(p, [0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 20, workerCount: 2, regionalWorkerCount: 2 }) })));
    check("A8: with regional headroom the scale-up proceeds", out2[2].action === "scale-up");
  }

  // A9 — min floor respected on scale-down
  {
    const p = mkPolicy({ minWorkers: 1 });
    const out = runEngine(p, [0, 30_000, 90_000].map((at) => ({ at, metrics: baseMetrics({ workerCount: 1, workerUtilization: 0, activeJobs: 0 }) })));
    check("A9: pool at minWorkers → hold 'at-min'", out[2].action === "hold" && out[2].reasons.includes("at-min"), out[2].reasons.join(","));
  }

  // A10 — step limiting: huge backlog adds at most scaleUp.step per action
  {
    const p = mkPolicy();
    const out = runEngine(p, [0, 5000, 10_000].map((at) => ({ at, metrics: baseMetrics({ queueDepth: 100 }) })));
    check("A10: deep backlog capped by scaleUp.step (delta=2, not 7)", out[2].action === "scale-up" && out[2].delta === 2 && out[2].desired === 3,
      `delta=${out[2].delta} desired=${out[2].desired}`);
    check("A10: desired target computed from depth (would reach ceil(100/4) over ticks)", out[2].details.targetDesired === 8);
  }

  // A11 — idle scale-down via the idle window (utilization UNKNOWN path)
  {
    const p = mkPolicy({ idle: { idleAfterMs: 60_000 }, scaleDown: { ...mkPolicy().scaleDown, sustainMs: 30_000 } });
    const ticks = [0, 55_000, 60_000, 90_000].map((at) => ({
      at,
      metrics: baseMetrics({ workerCount: 3, regionalWorkerCount: 3, workerUtilization: null, activeJobs: 0, queueDepth: 0 }),
    }));
    const out = runEngine(p, ticks);
    const at = Object.fromEntries(out.map((r) => [r.at, r]));
    check("A11: idle pool with unknown utilization holds before idleAfterMs (t=55000)",
      at[55_000].action === "hold" && at[55_000].signals.down.length === 0, at[55_000].reasons.join(","));
    check("A11: idle window elapses at t=60000 → 'idle' signal armed, sustain pending",
      at[60_000].action === "hold" && at[60_000].signals.down.includes("idle") && at[60_000].reasons.includes("sustaining"),
      at[60_000].reasons.join(","));
    check("A11: down sustain elapses → scale-down carries the 'idle' reason (t=90000)",
      at[90_000].action === "scale-down" && at[90_000].reasons.includes("idle") && at[90_000].delta === 1 && at[90_000].desired === 2,
      `${at[90_000].action} delta=${at[90_000].delta}`);
  }

  // A12 — 800-tick seeded fuzz: global invariants (no simultaneous up+down,
  // step bounds, cooldown law, min/max bounds) under adversarial metrics
  {
    const p = mkPolicy({ maxWorkers: 6, minWorkers: 1 });
    let seed = 0x2f6e2b1;
    const rand = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    let state = initialPolicyState();
    const out = [];
    const utils = [null, 0, 0.1, 0.25, 0.4, 0.55, 0.79, 0.8, 0.95, 1];
    for (let i = 0; i < 800; i++) {
      const at = i * 2500;
      const metrics = baseMetrics({
        workerCount: rand(7),
        regionalWorkerCount: rand(9),
        queueDepth: rand(41),
        oldestJobAgeMs: rand(121) * 1000,
        workerUtilization: utils[rand(utils.length)],
        activeJobs: rand(9),
      });
      const res = computeScaleDecision({ policy: p, metrics, state, now: at });
      const applied = res.action !== "hold";
      if (res.sustained.up && res.sustained.down) out.push(`t${at}: simultaneous sustained up+down`);
      if (res.action === "scale-up" && (res.delta < 1 || res.delta > p.scaleUp.step)) out.push(`t${at}: bad up delta ${res.delta}`);
      if (res.action === "scale-down" && (res.delta < 1 || res.delta > p.scaleDown.step)) out.push(`t${at}: bad down delta ${res.delta}`);
      if (res.action === "scale-up" && res.desired > p.maxWorkers) out.push(`t${at}: desired ${res.desired} > maxWorkers`);
      if (res.action === "scale-down" && res.desired < p.minWorkers) out.push(`t${at}: desired ${res.desired} < minWorkers`);
      state = res.nextState;
      if (applied) state = { ...state, lastScaleAt: at, lastAction: res.action }; // feed the cooldown state like the autoscaler does
    }
    // cooldown law over the applied sequence from the fuzz history (same seed → same metric sequence)
    const applied = [];
    let st = initialPolicyState();
    seed = 0x2f6e2b1;
    for (let i = 0; i < 800; i++) {
      const at = i * 2500;
      const metrics = baseMetrics({
        workerCount: rand(7), regionalWorkerCount: rand(9), queueDepth: rand(41),
        oldestJobAgeMs: rand(121) * 1000, workerUtilization: utils[rand(utils.length)], activeJobs: rand(9),
      });
      const res = computeScaleDecision({ policy: p, metrics, state: st, now: at });
      if (res.action !== "hold") applied.push({ at, action: res.action, applied: true });
      st = res.nextState;
      if (res.action !== "hold") st = { ...st, lastScaleAt: at, lastAction: res.action };
    }
    const law = cooldownLawViolations(applied, p);
    check("A12: 800-tick fuzz — no invariant violations (bands, steps, min/max)", out.length === 0, out.slice(0, 3).join("; "));
    check(`A12: 800-tick fuzz — cooldown law holds across ${applied.length} applied actions`, law.length === 0, law.slice(0, 3).join("; "));
  }

  // A13 — policy validation: inverted hysteresis is a HARD error
  {
    const bad1 = mkPolicy({ scaleDown: { utilization: 0.9 } }); // > up 0.8
    const r1 = validateScalingPolicy(bad1);
    check("A13: inverted utilization deadband rejected", !r1.ok && r1.errors.some((e) => /scaleDown\.utilization must be < scaleUp\.utilization/.test(e)),
      r1.errors.join("; "));
    const bad2 = mkPolicy({ scaleDown: { queueDepth: 5 } }); // >= up 4
    const r2 = validateScalingPolicy(bad2);
    check("A13: depth deadband inversion rejected", !r2.ok && r2.errors.some((e) => /scaleDown\.queueDepth must be < scaleUp\.queueDepthPerWorker/.test(e)),
      r2.errors.join("; "));
    const bad3 = mkPolicy({ minWorkers: 9 });
    const r3 = validateScalingPolicy(bad3);
    check("A13: min > max rejected", !r3.ok && r3.errors.some((e) => /minWorkers must be <= maxWorkers/.test(e)));
    const r4 = validateScalingPolicy(defaultScalingPolicy());
    check("A13: default policy validates clean", r4.ok, r4.errors.join("; "));
  }

  // A14 — env parsing (overrides + clean invalid-config error)
  {
    const p = parsePolicyFromEnv({
      CLONER_AUTOSCALE_MIN_WORKERS: "2",
      CLONER_AUTOSCALE_MAX_WORKERS: "12",
      CLONER_AUTOSCALE_MAX_PER_REGION: "10",
      CLONER_AUTOSCALE_UP_QUEUE_DEPTH_PER_WORKER: "6",
      CLONER_AUTOSCALE_UP_COOLDOWN_MS: "45000",
      CLONER_AUTOSCALE_DOWN_UTILIZATION: "0.3",
    });
    check("A14: env overrides parsed", p.minWorkers === 2 && p.maxWorkers === 12 && p.maxWorkersPerRegion === 10
      && p.scaleUp.queueDepthPerWorker === 6 && p.scaleUp.cooldownMs === 45_000 && p.scaleDown.utilization === 0.3,
      JSON.stringify({ min: p.minWorkers, max: p.maxWorkers, region: p.maxWorkersPerRegion }));
    check("A14: unset env keys fall back to defaults", p.scaleUp.sustainMs === 10_000 && p.idle.idleAfterMs === 60_000);
    let threw = "";
    try {
      parsePolicyFromEnv({ CLONER_AUTOSCALE_UP_UTILIZATION: "0.5", CLONER_AUTOSCALE_DOWN_UTILIZATION: "0.9" });
    } catch (e) { threw = String(e?.message || e); }
    check("A14: invalid env (inverted deadband) → clean error", /invalid CLONER_AUTOSCALE_\* configuration/.test(threw) && /scaleDown\.utilization/.test(threw), threw);
  }
}

// ===========================================================================
// Part B — worker pool manager (deterministic simulated workers)
// ===========================================================================
console.log("\n-- Part B: worker-pool-manager (simulated workers) --");
{
  const { createWorkerPoolManager, defaultPoolWorkerFactory } = await import("../src/workers/worker-pool-manager.js");

  // B1 — boots at minWorkers; stats shape with per-worker concurrency
  {
    const sim = makeSimWorkerFactory({ concurrency: 2 });
    const pool = createWorkerPoolManager({ poolId: "b1", region: "eu-1", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    const s = pool.stats();
    check("B1: pool boots at minWorkers", pool.size === 1 && s.running === 1, `size=${pool.size}`);
    check("B1: stats carry poolId/region/capacity", s.poolId === "b1" && s.region === "eu-1" && s.capacity === 2, JSON.stringify(s));
    check("B1: utilization starts at 0 with idle workers", s.utilization === 0);
    await pool.close();
  }

  // B2 — hard max cap: addWorkers caps with shortfall reported
  {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const cappedEvents = [];
    const pool = createWorkerPoolManager({ poolId: "b2", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    pool.on("capped", (e) => cappedEvents.push(e));
    const res = await pool.addWorkers(10, { reason: "test" });
    check("B2: addWorkers(10) caps at maxWorkers=4", pool.size === 4 && res.started.length === 3 && res.capped === true && res.shortfall === 7,
      `size=${pool.size} started=${res.started.length}`);
    check("B2: 'capped' event emitted with shortfall", cappedEvents.length >= 1 && cappedEvents[0].shortfall === 7);
    await pool.close();
  }

  // B3 — least-busy-first removal: idle workers leave, busy ones stay
  {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({ poolId: "b3", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    await pool.addWorkers(3);
    const [w1, w2, w3, w4] = sim.workers;
    w1.active = 2; w2.active = 1; w3.active = 0; w4.active = 0;
    const res = await pool.removeWorkers(2, { reason: "test" });
    const removedIds = res.removed.map((r) => r.workerId).sort();
    check("B3: the two IDLE workers are removed, busy ones retained",
      removedIds.join(",") === [w3.workerId, w4.workerId].sort().join(",") && pool.size === 2,
      `removed=${removedIds.join(",")}`);
    check("B3: no forced closes on idle removal", res.removed.every((r) => !r.forced));
    check("B3: busy workers still running", w1.closed === false && w2.closed === false);
    await pool.close();
  }

  // B4 — SAFE DRAIN: a busy worker is closed only AFTER its jobs reach 0
  {
    const sim = makeSimWorkerFactory({ concurrency: 2 });
    const pool = createWorkerPoolManager({
      poolId: "b4", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory,
      drainTimeoutMs: 5000, drainPollMs: 10, logger: quietLogger,
    });
    await pool.ready;
    await pool.addWorkers(1);
    const [w1, w2] = sim.workers;
    w1.active = 5; // keep the veteran busy so the least-busy pick is w2
    w2.active = 1;
    const drainingEvents = [];
    pool.on("worker-draining", (e) => drainingEvents.push(e));
    const removal = pool.removeWorkers(1, { reason: "test" });
    await sleep(40); // removal is polling while the job runs
    const midDrain = sim.workers.find((w) => w.workerId === w2.workerId);
    check("B4: busy worker marked draining, NOT closed while jobs run",
      midDrain.closeCalls === 0 && pool.listWorkers().some((s) => s.status === "draining"),
      `closeCalls=${midDrain.closeCalls}`);
    check("B4: 'worker-draining' event emitted with active count", drainingEvents.length === 1 && drainingEvents[0].activeJobs === 1);
    w2.active = 0; // the job finishes
    const res = await removal;
    check("B4: closed only after active jobs hit 0 (activeAtClose=0)", res.removed.length === 1 && w2.closeLog[0]?.activeAtClose === 0,
      JSON.stringify(w2.closeLog));
    check("B4: drain was not forced", res.removed[0].forced === false);
    check("B4: slot removed, busy worker untouched", pool.size === 1 && w1.closed === false);
    await pool.close();
  }

  // B5 — drain-grace expiry: never-idle worker is force-closed and REPORTED
  {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({
      poolId: "b5", minWorkers: 0, maxWorkers: 2, workerFactory: sim.factory,
      drainTimeoutMs: 150, drainPollMs: 20, logger: quietLogger,
    });
    await pool.ready;
    await pool.addWorkers(1); // minWorkers is 0 → boot the worker explicitly
    const [w1] = sim.workers;
    w1.active = 1; // never finishes
    const res = await pool.removeWorkers(1, { reason: "test" });
    check("B5: never-idle worker force-closed after the grace", res.removed.length === 1 && res.removed[0].forced === true && w1.closed === true,
      `forced=${res.removed[0]?.forced}`);
    check("B5: pool size drops to 0 after forced drain", pool.size === 0);
    await pool.close();
  }

  // B6 — scaleTo clamps to [minWorkers, maxWorkers]; drainAll goes to 0
  {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({ poolId: "b6", minWorkers: 1, maxWorkers: 3, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    const r1 = await pool.scaleTo(0, { reason: "test" });
    check("B6: scaleTo(0) clamps up to minWorkers", pool.size === 1 && r1.target === 1);
    await pool.scaleTo(99, { reason: "test" });
    check("B6: scaleTo(99) clamps down to maxWorkers", pool.size === 3);
    await pool.scaleTo(2, { reason: "test" });
    check("B6: scaleTo(2) removes one (all idle → no forced)", pool.size === 2);
    const drained = await pool.drainAll({ reason: "shutdown" });
    check("B6: drainAll removes everything", pool.size === 0 && drained.removed.length === 2);
    await pool.close();
    check("B6: close() is idempotent", pool.isClosed === true);
  }

  // B7 — REAL default factory without Redis env → clean error (product path)
  {
    const saved = { r: process.env.REDIS_URL, cr: process.env.CLONER_REDIS_URL };
    delete process.env.REDIS_URL;
    delete process.env.CLONER_REDIS_URL;
    let err = "";
    try { await defaultPoolWorkerFactory({ workerId: "b7-w1" }); } catch (e) { err = String(e?.message || e); }
    // restore EXACTLY: assigning undefined would stringify to "undefined" and
    // poison process.env for the rest of the suite (Part D would probe a bogus host)
    if (saved.r === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved.r;
    if (saved.cr === undefined) delete process.env.CLONER_REDIS_URL; else process.env.CLONER_REDIS_URL = saved.cr;
    check("B7: defaultPoolWorkerFactory without REDIS_URL fails cleanly (no invented worker)",
      /REDIS_URL \/ CLONER_REDIS_URL/.test(err), err);
  }
}

// ===========================================================================
// Part C — autoscaler end-to-end deterministic simulation
// ===========================================================================
console.log("\n-- Part C: autoscaler end-to-end (simulated clock + workers) --");
{
  const { createAutoscaler } = await import("../src/workers/autoscaler.js");
  const { createWorkerPoolManager } = await import("../src/workers/worker-pool-manager.js");
  const { defaultScalingPolicy } = await import("../src/workers/scaling-policy.js");

  const mkPolicy = (over = {}) => {
    const p = defaultScalingPolicy();
    return {
      ...p, ...over,
      scaleUp: { ...p.scaleUp, ...(over.scaleUp || {}) },
      scaleDown: { ...p.scaleDown, ...(over.scaleDown || {}) },
      idle: { ...p.idle, ...(over.idle || {}) },
    };
  };
  async function makeRig({ policy, poolOpts = {} } = {}) {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({
      poolId: "sim", region: "sim-region", minWorkers: 1, maxWorkers: 8,
      workerFactory: sim.factory, drainTimeoutMs: 2000, drainPollMs: 5, logger: quietLogger, ...poolOpts,
    });
    await pool.ready;
    const clock = makeSimClock();
    const simQ = { depth: 0, age: 0 };
    const scaler = createAutoscaler({
      policy,
      poolManager: pool,
      getMetrics: makeSimMetrics(pool, simQ),
      clock,
      logger: quietLogger,
    });
    const forcedRemovals = [];
    pool.on("worker-removed", (e) => { if (e.forced) forcedRemovals.push(e); });
    return { pool, clock, simQ, scaler, sim, forcedRemovals };
  }

  // C1 — full lifecycle: burst → plateau → full drain, exact timeline
  {
    const policy = mkPolicy(); // defaults: up dpw4/sustain10s/cd30s/step2, down util.25/depth0/sustain30s/cd60s/step1, idle 60s
    const rig = await makeRig({ policy });
    const { pool, clock, simQ, scaler, sim } = rig;

    const applied = [];
    scaler.on("decision", (e) => { if (e.applied) applied.push(e); });

    // schedule: heavy backlog until t=50000, then fully drained
    const schedule = (t) => {
      if (t <= 50_000) { simQ.depth = 20; simQ.age = 0; sim.workers[0].active = 1; }
      else { simQ.depth = 0; simQ.age = 0; sim.workers.forEach((w) => { w.active = 0; }); }
    };

    for (let t = 0; t <= 300_000; t += 5000) {
      clock.nowMs = t; // the tick IS the clock — metrics and decision share `now`
      schedule(t);
      await scaler.evaluate();
    }

    const seq = applied.map((a) => `${a.action}@${a.at}(+${a.delta})`);
    // 2 scale-ups (t=10000, t=40000 — after the 30s up-cooldown), then the
    // backlog clears at t=50000; the 60s down-cooldown from t=40000 expires at
    // t=100000 and each down drains one idle worker, repeat every 60s
    check("C1: exact action timeline — 2 scale-ups then 4 scale-downs",
      JSON.stringify(applied.map((a) => `${a.action}@${a.at}`)) === JSON.stringify([
        "scale-up@10000", "scale-up@40000", "scale-down@100000", "scale-down@160000", "scale-down@220000", "scale-down@280000",
      ]), seq.join(", "));
    check("C1: scale-up deltas respect step (2,2)", applied.slice(0, 2).every((a) => a.delta === 2));
    check("C1: pool ends at minWorkers after the drain", pool.size === 1, `size=${pool.size}`);
    check("C1: cooldown law across the whole lifecycle", cooldownLawViolations(scaler.history(), policy).length === 0);
    check("C1: every drain was SAFE (no forced close, no worker closed mid-job)",
      rig.forcedRemovals.length === 0 && sim.workers.every((w) => w.closeLog.every((c) => c.activeAtClose === 0)),
      `forced=${rig.forcedRemovals.length}`);
    check("C1: pool size never left [min,max] (verified via event stream)",
      applied.every((a) => a.poolSize >= 1 && a.poolSize <= 8));
    const holds = scaler.history().filter((h) => h.action === "hold");
    check("C1: pre-sustain ticks held with 'sustaining'",
      holds.some((h) => h.at === 0 && h.reasons.includes("sustaining")));
    check("C1: cooldown-blocked ticks held with 'scale-up-cooldown'",
      holds.some((h) => h.at === 15_000 && h.reasons.includes("scale-up-cooldown")));
    check("C1: at-min ticks held after full drain",
      holds.some((h) => h.at === 300_000 && h.reasons.includes("at-min")));
    await scaler.close();
    await pool.close();
  }

  // C2 — fast-flapping load (faster than the sustain window) → ZERO actions
  {
    const policy = mkPolicy();
    const rig = await makeRig({ policy });
    const { pool, clock, simQ, scaler, sim } = rig;
    for (let t = 0; t < 100; t++) {
      clock.nowMs = t * 5000;
      simQ.depth = t % 2 === 0 ? 30 : 0; // flaps every 5s < 10s sustain
      simQ.age = 0;
      sim.workers.forEach((w) => { w.active = 0; });
      await scaler.evaluate();
    }
    const appliedActions = scaler.history().filter((h) => h.applied);
    check("C2: load flapping faster than sustainMs → ZERO scale actions (no oscillation)",
      appliedActions.length === 0, `${appliedActions.length} actions`);
    check("C2: pool stayed at minWorkers", pool.size === 1);
    await scaler.close();
    await pool.close();
  }

  // C3 — slow waves (30s burst / 40s valley): scales up under real load, drains
  // in the valleys, stays inside the cooldown law. Applied actions are
  // collected from the "decision" event because history() is a bounded window
  // (long runs splice old entries out — that truncation is part of the design).
  {
    const policy = mkPolicy();
    const rig = await makeRig({ policy });
    const { pool, clock, simQ, scaler, sim } = rig;
    const applied = [];
    scaler.on("decision", (e) => { if (e.applied) applied.push(e); });
    for (let t = 0; t < 240; t++) { // 20 minutes, 70s period
      const inBurst = t % 14 < 6; // 5s ticks: 30s burst / 40s valley
      simQ.depth = inBurst ? 30 : 0;
      simQ.age = 0;
      sim.workers.forEach((w, i) => { w.active = inBurst && i === 0 ? 1 : 0; });
      clock.nowMs = t * 5000;
      await scaler.evaluate();
    }
    const ups = applied.filter((a) => a.action === "scale-up");
    const downs = applied.filter((a) => a.action === "scale-down");
    const law = cooldownLawViolations(scaler.history(), policy);
    check("C3: sustained bursts DO scale the pool up", ups.length >= 1 && applied.length >= 2,
      `${ups.length} ups / ${downs.length} downs of ${applied.length} actions`);
    check("C3: valleys DO drain (down scale-downs happened)", downs.length >= 1, `${downs.length} downs`);
    check("C3: cooldown law holds across all actions", law.length === 0, law.slice(0, 2).join("; "));
    check("C3: pool size always within [1,8]",
      scaler.history().every((h) => h.poolSize >= 1 && h.poolSize <= 8) && applied.every((a) => a.poolSize >= 1 && a.poolSize <= 8)
      && pool.size >= 1 && pool.size <= 8);
    check("C3: bounded action count over 240 ticks (anti-chatter)", applied.length <= 45, `${applied.length} actions`);
    check("C3: all drains safe", rig.forcedRemovals.length === 0 && sim.workers.every((w) => w.closeLog.every((c) => c.activeAtClose === 0)));
    check("C3: never closes below minWorkers", applied.every((a) => a.action !== "scale-down" || a.desired >= 1));
    check("C3: snapshot counts every evaluation, not just retained history",
      scaler.snapshot().totalEvaluations === 240 && scaler.snapshot().historyEntries === 200,
      `total=${scaler.snapshot().totalEvaluations} retained=${scaler.snapshot().historyEntries}`);
    await scaler.close();
    await pool.close();
  }

  // C4 — no metrics source → clean error, nothing invented
  {
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({ poolId: "c4", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    const scaler = createAutoscaler({ policy: mkPolicy(), poolManager: pool, redisUrl: "", getMetrics: null, logger: quietLogger });
    let err = "";
    try { await scaler.evaluate(); } catch (e) { err = String(e?.message || e); }
    check("C4: evaluate without metrics source fails cleanly",
      /no metrics source/.test(err) && /REDIS_URL \/ CLONER_REDIS_URL/.test(err), err);
    check("C4: no history entry was fabricated for the failed tick", scaler.history().length === 0);
    check("C4: no workers were added or removed on the failed tick", pool.size === 1);
    await scaler.close();
    await pool.close();
  }

  // C5 — real start()/stop() interval loop (real timers, short)
  {
    const policy = mkPolicy({ evaluateIntervalMs: 5000, maxWorkers: 4 });
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({ poolId: "c5", minWorkers: 1, maxWorkers: 4, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;
    const clock = { now: () => Date.now() }; // REAL clock for this one
    const scaler = createAutoscaler({
      policy, poolManager: pool, getMetrics: makeSimMetrics(pool, { depth: 0, age: 0 }), clock, intervalMs: 120, logger: quietLogger,
    });
    scaler.start();
    await sleep(80); // the immediate first tick is fire-and-forget — give it a beat
    check("C5: start() flips isRunning and evaluates immediately", scaler.isRunning === true && scaler.snapshot().totalEvaluations >= 1,
      `total=${scaler.snapshot().totalEvaluations}`);
    await sleep(600);
    const n1 = scaler.history().length;
    check("C5: interval loop keeps evaluating (>=3 ticks in 600ms)", n1 >= 3, `n=${n1}`);
    scaler.stop();
    await sleep(300);
    check("C5: stop() halts the loop", scaler.isRunning === false && scaler.history().length === n1);
    check("C5: snapshot exposes policy/state/pool", scaler.snapshot().policy.maxWorkers === 4 && scaler.snapshot().pool.running === 1);
    await scaler.close();
    await pool.close();
  }
}

// ===========================================================================
// Part D — REAL Redis path (compose redis; SKIP when unreachable)
// ===========================================================================
console.log("\n-- Part D: real BullMQ metrics provider (compose redis) --");
{
  const { createAutoscaler } = await import("../src/workers/autoscaler.js");
  const { createWorkerPoolManager } = await import("../src/workers/worker-pool-manager.js");
  const { defaultScalingPolicy } = await import("../src/workers/scaling-policy.js");
  const { resolveRedisUrl } = await import("../src/queues/clone-queue.js");
  const { default: IORedis } = await import("ioredis");

  const redisUrl = resolveRedisUrl() || "redis://127.0.0.1:6379";
  let probe = null;
  let probeError = "";
  try {
    probe = new IORedis(redisUrl, { lazyConnect: true, connectTimeout: 1500, retryStrategy: () => null, enableOfflineQueue: false });
    probe.on("error", () => {});
    await probe.connect();
    await probe.ping();
  } catch (e) {
    probeError = String(e?.message || e);
    try { probe?.disconnect(); } catch {}
    probe = null;
  }

  if (!probe) {
    skip("D1: default metrics provider reads real queue depth", `compose redis unreachable (${probeError})`);
    skip("D2: oldest-job age measured from real BullMQ timestamps", "compose redis unreachable");
  } else {
    const { Queue } = await import("bullmq");
    const probeQueueName = `autoscaler-probe-${Date.now()}`;
    const q = new Queue(probeQueueName, { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) });
    const sim = makeSimWorkerFactory({ concurrency: 1 });
    const pool = createWorkerPoolManager({ poolId: "d-real", minWorkers: 1, maxWorkers: 8, workerFactory: sim.factory, logger: quietLogger });
    await pool.ready;

    const policy = {
      ...defaultScalingPolicy(),
      evaluateIntervalMs: 1000,
      scaleUp: { queueDepthPerWorker: 2, oldestJobAgeMs: 5000, utilization: 0.95, sustainMs: 200, cooldownMs: 400, step: 2 },
      scaleDown: { utilization: 0.1, queueDepth: 0, sustainMs: 200, cooldownMs: 400, step: 1 },
      idle: { idleAfterMs: 1000 },
    };
    // autoscaler with NO getMetrics injection → the REAL default provider
    const scaler = createAutoscaler({ policy, poolManager: pool, redisUrl, queueName: probeQueueName, logger: quietLogger });

    for (let i = 1; i <= 5; i++) {
      await q.add("probe", { payload: { url: "http://fixture.invalid/autoscale-probe" } }, { jobId: `probe-${i}` });
    }

    const e1 = await scaler.evaluate();
    check("D1: default provider reads the REAL queue depth (5 waiting)", e1.metrics.queueDepth === 5, `depth=${e1.metrics.queueDepth}`);
    check("D1: first tick holds (sustain not yet elapsed)", e1.action === "hold", e1.reasons.join(","));

    await sleep(350); // oldest job ages past the thresholds
    const e2 = await scaler.evaluate();
    check("D2: oldest waiting job age measured from real BullMQ timestamps", e2.metrics.oldestJobAgeMs >= 300, `age=${e2.metrics.oldestJobAgeMs}ms`);
    check("D1: sustained real backlog → scale-up applied (+2 → 3 workers)",
      e2.action === "scale-up" && e2.applied?.changed === 2 && pool.size === 3,
      `${e2.action} applied=${JSON.stringify(e2.applied)} size=${pool.size}`);
    // metrics are a pre-action snapshot: at e2 the pool was still 1; the next
    // tick's metrics must see the grown pool (single-pool default for the region)
    const e3 = await scaler.evaluate();
    check("D1: regionalWorkerCount defaults to this pool's size",
      e2.metrics.regionalWorkerCount === 1 && e3.metrics.regionalWorkerCount === 3,
      `before=${e2.metrics.regionalWorkerCount} after=${e3.metrics.regionalWorkerCount}`);

    await q.obliterate({ force: true }).catch(() => {});
    await q.close();
    await scaler.close();
    await pool.close();
    try { await probe.quit(); } catch { try { probe.disconnect(); } catch {} }
  }
}

const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
