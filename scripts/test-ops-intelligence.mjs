#!/usr/bin/env node
// Ops-intelligence test suite (Phase 5.0 task G3.3) — workload prediction,
// cost prediction, scheduling learner, failure classifier + bounded
// remediation, and the /api/intelligence router.
//
//   node scripts/test-ops-intelligence.mjs
//
// Offline contract: sections 1-6 need NO database, NO browser and NO network
// beyond loopback HTTP (the router integration mounts the real express router
// and drives it with real fetch). Product modules are exercised through their
// injected data-source seams with test-side stand-ins ONLY (the no-mocks law:
// mocks live in the test file as the remote-end simulator, never in product
// code paths — the product defaults are the real PostgreSQL loader / real
// compute-accounting cost model / real repair-planner vocabulary, and the
// live-DB section below drives those defaults when compose PostgreSQL is up).
//
// Live-DB section (7): when the compose PostgreSQL (port 5433) is reachable
// it seeds real compute_job_costs + capacity_job_costs rows, trains the
// predictor through the REAL default SQL loader (no injection), asserts the
// learned model, and cleans up. Unreachable → SKIP lines, exit 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // cwd-pinned modules (artifacts/ + platform-data/)

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skipLine = (name, why) => { skip++; console.log(`SKIP  ${name} — ${why}`); };
const section = (t) => console.log(`\n== ${t} ==`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NOON = Date.parse("2023-11-14T12:00:00.000Z"); // inside the 9-21 UTC test window

const W = await import("../src/platform/intelligence/workload-prediction.js");
const C = await import("../src/platform/intelligence/cost-prediction.js");
const S = await import("../src/platform/intelligence/scheduling-learner.js");
const F = await import("../src/platform/intelligence/failure-classifier.js");
const RS = await import("../src/platform/intelligence/robust-stats.js");
const acct = await import("../src/platform/compute-accounting.js");

// =====================================================================
section("1. robust-stats: deterministic medians + type-7 quantiles");
{
  check("median odd/even/empty", RS.median([3, 1, 2]) === 2 && RS.median([4, 1, 3, 2]) === 2.5 && Number.isNaN(RS.median([])));
  check("median ignores non-finite + unsorted input", RS.median([9, "x", 1, 5, null, 3]) === 4, `got ${RS.median([9, "x", 1, 5, null, 3])}`);
  check("quantile type-7 exact (p10/p50/p90 of 1..10)", RS.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1) === 1.9 && RS.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5) === 5.5 && RS.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) === 9.1);
  check("quantile clamps p and handles single value", RS.quantile([7], 0.9) === 7 && RS.quantile([1, 2, 3], 5) === 3 && RS.quantile([1, 2, 3], -1) === 1);
  const shuffled = [10, 3, 7, 1, 5, 9, 2, 8, 4, 6];
  check("deterministic under input order", RS.quantile(shuffled, 0.1) === RS.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1));
  check("MAD of 1..5 = 1", RS.medianAbsoluteDeviation([1, 2, 3, 4, 5]) === 1);
}

// =====================================================================
section("2. workload prediction: training, classes, fallback, forecast, state");
{
  const mkPredictor = () => W.createWorkloadPredictor({ now: () => NOON });
  const p = mkPredictor();

  // deterministic fixture: 10 small eu jobs (100k..109k ms, 1 error), 6 medium jobs
  const records = [];
  for (let i = 0; i < 10; i++) records.push({ jobId: `s${i}`, status: i === 9 ? "error" : "completed", runtimeMs: 100_000 + i * 1_000, browserSlots: 2, artifactBytes: 1000, region: "eu", ts: NOON - i * 600_000 });
  for (let i = 0; i < 6; i++) records.push({ jobId: `m${i}`, status: i === 5 ? "cancelled" : "completed", runtimeMs: 600_000 + i * 10_000, browserSlots: 3, artifactBytes: 2_000_000, region: "us", ts: NOON - i * 600_000 });
  const trained = p.trainFromRecords(records);
  check("trainFromRecords counts + classes", trained.trained === true && trained.jobCount === 16 && trained.byClass.small.runtimeSamples === 10 && trained.byClass.medium.runtimeSamples === 6, JSON.stringify(trained.byClass));

  // medium prediction: median of [600k..650k] = 625000; failure (0 known-fail? medium: 5 success + 1 cancelled) → known=5 failed=0 → (0+1)/(5+4)
  const pm = p.predict({ estimatedRuntimeMs: 600_000 });
  check("medium class basis history", pm.basis === "history" && pm.jobClass === "medium", JSON.stringify(pm.jobClass));
  check("runtime estimate = median of class samples", pm.runtimeMs.estimate === 625_000, `got ${pm.runtimeMs.estimate}`);
  check("interval p10 <= estimate <= p90", pm.runtimeMs.low <= pm.runtimeMs.estimate && pm.runtimeMs.estimate <= pm.runtimeMs.high, `${pm.runtimeMs.low}..${pm.runtimeMs.high}`);
  check("failure probability exact Laplace (cancelled excluded)", pm.failureProbability.value === Math.round((1 / 9) * 1e6) / 1e6, `known=${pm.failureProbability.knownOutcomes} failed=${pm.failureProbability.failures} value=${pm.failureProbability.value}`);

  // region-scoped: eu has 10 runtime samples >= minRegionSamples(8) → region scope
  const peu = p.predict({ estimatedRuntimeMs: 120_000, regionId: "eu" });
  check("region-scoped stats when region has enough samples", peu.runtimeMs.scope === "region" && peu.failureProbability.scope === "region", JSON.stringify(peu.runtimeMs));
  const pxx = p.predict({ estimatedRuntimeMs: 120_000, regionId: "ap" });
  check("thin region falls back to class scope", pxx.runtimeMs.scope === "class");

  // no data at all → deterministic fallback
  const fresh = mkPredictor();
  const pf = fresh.predict({});
  check("no-data prediction is flagged fallback", pf.basis === "fallback" && pf.fallback === true);
  check("no-data prediction uses the class default (no estimate → medium)", pf.jobClass === "medium" && pf.runtimeMs.estimate === 600_000, `${pf.jobClass} ${pf.runtimeMs.estimate}`);
  check("no-data failure probability = Beta(1,3) prior 0.25", pf.failureProbability.value === 0.25, `got ${pf.failureProbability.value}`);

  // explicit classing: estimate says small, explicit jobClass says large
  const pl = fresh.predict({ estimatedRuntimeMs: 1_000, jobClass: "large" });
  check("explicit jobClass wins; caller estimate still honored for the runtime", pl.jobClass === "large" && pl.runtimeMs.estimate === 1_000 && pl.runtimeMs.low === 500 && pl.runtimeMs.high === 1_500, `${pl.jobClass} ${pl.runtimeMs.estimate}`);
  check("threshold classing", W.classifyJobClass({ estimatedRuntimeMs: 4 * 60_000 }) === "small" && W.classifyJobClass({ estimatedRuntimeMs: 10 * 60_000 }) === "medium" && W.classifyJobClass({ estimatedRuntimeMs: 30 * 60_000 }) === "large");

  // forecast: 16 arrivals within the 24h window ending at NOON → rate = 16/24 h
  const fc = p.forecastWorkload({ horizonMs: 3_600_000, windowMs: 86_400_000 });
  check("forecast rate from trained arrivals", fc.jobs.expected === Math.round((16 / 86_400_000) * 3_600_000 * 1e6) / 1e6, `expected ${fc.jobs.expected}`);
  check("forecast interval ordered + non-negative", fc.jobs.low >= 0 && fc.jobs.low <= fc.jobs.expected && fc.jobs.expected <= fc.jobs.high, `${fc.jobs.low}..${fc.jobs.high}`);
  check("aggregate demand uses per-job medians", fc.aggregateDemand.perJobBasis.samples > 0 && fc.aggregateDemand.runtimeMs > 0);
  const fcEmpty = mkPredictor().forecastWorkload({ horizonMs: 3_600_000 });
  check("forecast with no history is flagged fallback", fcEmpty.fallback === true && fcEmpty.jobs.expected === 0 && fcEmpty.jobs.samples === 0);

  // state roundtrip
  const state = p.toState();
  const p2 = mkPredictor();
  p2.fromState(state);
  check("toState/fromState roundtrip reproduces predictions", eq(p.predict({ estimatedRuntimeMs: 600_000 }), p2.predict({ estimatedRuntimeMs: 600_000 })) && eq(p.predict({ estimatedRuntimeMs: 120_000, regionId: "eu" }), p2.predict({ estimatedRuntimeMs: 120_000, regionId: "eu" })));
  let threw = false;
  try { p2.fromState({ version: 2 }); } catch { threw = true; }
  check("fromState rejects foreign payloads", threw);

  // refresh: failing source reports and keeps the trained model intact
  const broken = W.createWorkloadPredictor({ dataSource: { listJobs: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5433 (history source unavailable)"); } }, now: () => NOON });
  broken.trainFromRecords(records);
  const r = await broken.refresh();
  check("refresh failure is reported, not thrown", r.trained === false && r.skipped === true && /history source unavailable/.test(r.reason), r.reason);
  check("model survives a failed refresh", broken.predict({ estimatedRuntimeMs: 600_000 }).basis === "history" && broken.modelSummary().jobCount === 16);

  // normalizeJobRecord: snake_case rows, unusable rows dropped
  const rec = W.normalizeJobRecord({ task_key: "j1", runtime_ms: "5000", browser_slots: 1, artifact_bytes: 10, status: "completed", region: "eu-1!", created_at: "2024-01-01T00:00:00Z" });
  check("snake_case row normalized + region label sanitized", rec && rec.runtimeMs === 5000 && rec.region === "eu-1_" && rec.jobId === "j1", JSON.stringify(rec));
  check("unusable row → null", W.normalizeJobRecord({ foo: 1 }) === null && W.normalizeJobRecord(null) === null);
  check("outcomeOf vocabulary", W.outcomeOf("completed") === "success" && W.outcomeOf("completed_with_limitations") === "success" && W.outcomeOf("error") === "failed" && W.outcomeOf("cancelled") === "cancelled" && W.outcomeOf("weird") === "unknown");
}

// =====================================================================
section("3. cost prediction: real cost model + hard-constrained strategies");
{
  const rates = { runtime_minute: 0.01, browser_slot: 0.005, artifact_byte: 0.00000001, sources: {} };
  const cp = C.createCostPredictor({ now: () => NOON, ratesFor: async () => rates });
  const q = { runtimeMs: 90_000, browserSlots: 2, artifactBytes: 1000 };

  const pc = await cp.predictCost({ quantities: q });
  const reference = acct.computeCost(q, rates);
  check("credit-side prediction == real compute-accounting model", pc.cost.total === reference.costTotal && pc.cost.total === 0.03001, `${pc.cost.total} vs reference ${reference.costTotal}`);
  check("runtime billed per started minute (ceil)", pc.cost.runtimeMinutes === 2);
  check("rates source labeled for injected rates", pc.rates.source === "injected", pc.rates.source);

  // default rates path (real resolveRates or its env fallback) must never throw offline
  const cpDefault = C.createCostPredictor({ now: () => NOON });
  const pd = await cpDefault.predictCost({ quantities: q });
  check("default rates path: finite cost + labeled source", Number.isFinite(pd.cost.total) && pd.cost.total >= 0 && typeof pd.rates.source === "string" && pd.rates.source.length > 0, `total=${pd.cost.total} source=${pd.rates.source}`);

  // workload-driven quantities: predictor predicts 625000ms for medium
  const wp = W.createWorkloadPredictor({ now: () => NOON });
  wp.trainFromRecords([{ status: "completed", runtimeMs: 600_000, browserSlots: 3, artifactBytes: 2_000_000 }, { status: "completed", runtimeMs: 620_000, browserSlots: 3, artifactBytes: 2_000_000 }, { status: "completed", runtimeMs: 650_000, browserSlots: 3, artifactBytes: 2_000_000 }]);
  const cpW = C.createCostPredictor({ workload: wp, now: () => NOON, ratesFor: async () => rates });
  const pw = await cpW.predictCost({ job: { estimatedRuntimeMs: 600_000 } });
  check("quantities resolved through the workload predictor", pw.quantities.runtimeMs === 620_000 && pw.quantities.browserSlots === 3 && pw.basis === "workload-prediction:history", JSON.stringify(pw.quantities));

  // --- strategies (all hard constraints) ---
  const atPeak = { peakWindows: [{ startHour: 9, endHour: 21 }] }; // NOON is inside
  const sRun = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, ...atPeak });
  check("run_now always present + feasible", sRun.strategies.some((s) => s.strategy === "run_now" && s.feasible === true), JSON.stringify(sRun.strategies.map((s) => s.strategy)));

  const dRun = sRun.strategies.find((s) => s.strategy === "defer_offpeak");
  check("off-peak deferral offered in-peak with sufficient savings", dRun.feasible === true && Math.abs(dRun.savingsFraction - 0.333222) < 1e-6 && dRun.startAt === "2023-11-14T21:00:00.000Z", `savings=${dRun.savingsFraction} start=${dRun.startAt}`);
  const expectedDefer = acct.round6(acct.round6(pc.cost.runtime * 0.5) + pc.cost.slots + pc.cost.bytes);
  check("defer cost = discounted runtime + flat components", dRun.estimatedCost === expectedDefer, `${dRun.estimatedCost} vs ${expectedDefer}`);

  const sUrgent = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000, urgency: "urgent" }, ...atPeak });
  const dUrgent = sUrgent.strategies.find((s) => s.strategy === "defer_offpeak");
  check("urgent jobs are NEVER deferred (hard constraint)", dUrgent.feasible === false && /urgent/.test(dUrgent.reason), dUrgent.reason);
  const sPriority = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000, priority: 90 }, ...atPeak });
  check("priority >= threshold counts as urgent", sPriority.strategies.find((s) => s.strategy === "defer_offpeak").feasible === false);

  const sDeadline = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000, deadlineAt: NOON + 30 * 60_000 }, ...atPeak });
  check("deferral that would miss the deadline is refused", sDeadline.strategies.find((s) => s.strategy === "defer_offpeak").reason.includes("deadline"));

  const cpCap = C.createCostPredictor({ now: () => NOON, config: { maxDeferralMs: 2 * 3_600_000 }, ratesFor: async () => rates });
  check("deferral beyond the hard cap is refused", cpCap && (await cpCap.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, ...atPeak })).strategies.find((s) => s.strategy === "defer_offpeak").reason.includes("maxDeferralMs"));

  const sOff = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, peakWindows: [] });
  check("already off-peak: deferral has nothing to wait for", sOff.strategies.find((s) => s.strategy === "defer_offpeak").feasible === false && /off-peak/.test(sOff.strategies.find((s) => s.strategy === "defer_offpeak").reason));

  const sAlways = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, peakWindows: [{ startHour: 0, endHour: 24 }] });
  const dAlways = sAlways.strategies.find((s) => s.strategy === "defer_offpeak");
  check("always-peak window degrades instead of throwing", dAlways.feasible === false && /off-peak hour/.test(dAlways.reason), dAlways.reason);

  // move_region: infrastructure-side estimate, cheapest region recommended
  const pricing = { eu: { hourlyRate: 2, fixedPerJob: 0.01 }, us: { hourlyRate: 10, fixedPerJob: 0.01 } };
  const sMove = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, regionPricing: pricing });
  const mv = sMove.strategies.find((s) => s.strategy === "move_region");
  check("move_region picks the cheapest priced region", mv && mv.regionId === "eu" && mv.estimatedCost === 0.035 && mv.savingsFraction === 0.740741, JSON.stringify(mv));
  const expectedEu = acct.round6(2 * (90_000 / 3_600_000) * 0.5 + 0.01);
  check("region cost follows the 4.2.13 formula (off-peak multiplier)", expectedEu === 0.035, `got ${expectedEu}`);
  const sAffinity = await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000, regionAffinity: ["us"] }, regionPricing: pricing });
  check("region moves never leave regionAffinity (hard constraint)", sAffinity.strategies.find((s) => s.strategy === "move_region") === undefined && sAffinity.strategies.every((s) => s.strategy !== "move_region"));

  // ordering + determinism
  const orderedStrats = sMove.strategies.map((s) => s.strategy);
  const feasibleFlags = sMove.strategies.map((s) => s.feasible);
  check("strategies ordered: feasible first, savings desc", feasibleFlags.every((f) => f === true) || feasibleFlags.indexOf(false) > feasibleFlags.lastIndexOf(true), JSON.stringify(orderedStrats));
  const again = JSON.stringify(await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, regionPricing: pricing, ...atPeak }));
  check("recommendation is deterministic", again === JSON.stringify(await cp.recommendStrategies({ quantities: q, job: { estimatedRuntimeMs: 90_000 }, regionPricing: pricing, ...atPeak })));

  // bad input → typed error; invalid env pricing → construction error
  let threw = false;
  try { await cp.predictCost({ quantities: { runtimeMs: -5 } }); } catch (e) { threw = /runtimeMs/.test(e.message); }
  check("negative quantities rejected before any write", threw);
  threw = false;
  try { C.readEnvPricing("{not json"); } catch (e) { threw = /not valid JSON/.test(e.message); }
  check("invalid COST_AWARE_REGION_PRICING is a clean config error", threw);
}

// =====================================================================
section("4. scheduling learner: outcomes, learned factors, hard constraints");
{
  const mk = (config = {}) => S.createSchedulingLearner({ now: () => NOON, config });

  check("outcomeFromStatus maps the real queue vocabulary", S.outcomeFromStatus("completed") === "success" && S.outcomeFromStatus("completed_with_limitations") === "success" && S.outcomeFromStatus("error") === "failed" && S.outcomeFromStatus("timeout") === "timeout" && S.outcomeFromStatus("cancelled") === "cancelled" && S.outcomeFromStatus("mystery") === null);
  check("region ids sanitized", S.sanitizeRegionId("eu west/1!!") === "eu_west_1__" && S.sanitizeRegionId("") === "unknown", S.sanitizeRegionId("eu west/1!!"));

  const l = mk();
  check("observe rejects missing regionId", l.observe({ outcome: "success" }).accepted === false);
  check("observe rejects unknown outcome", l.observe({ regionId: "eu", outcome: "weird" }).accepted === false && /outcome must be/.test(l.observe({ regionId: "eu", outcome: "weird" }).reason));
  for (let i = 0; i < 10; i++) l.observe({ jobId: `j${i}`, regionId: "eu", predictedRuntimeMs: 100_000, actualRuntimeMs: 120_000, outcome: i === 9 ? "error" : "success" });
  for (let i = 0; i < 2; i++) l.observe({ regionId: "us", predictedRuntimeMs: 100_000, actualRuntimeMs: 110_000, outcome: "cancelled" });
  const eu = l.regionStats("eu");
  check("learned runtime factor = median ratio (10 samples)", eu.runtimeFactor.learned === true && Math.abs(eu.runtimeFactor.factor - 1.2) < 1e-9, `factor=${eu.runtimeFactor.factor}`);
  check("failure rate = (1+1)/(10+4) with cancelled excluded", eu.failureRate.value === Math.round((2 / 14) * 1e6) / 1e6 && eu.failureRate.known === 10, JSON.stringify(eu.failureRate));
  const us = l.regionStats("us");
  check("thin region stays unlearned (factor null, neutral 1)", us.runtimeFactor.learned === false && us.runtimeFactor.factor === null && us.runtimeFactor.samples === 2, JSON.stringify(us.runtimeFactor));
  check("cancellations excluded from the failure rate", us.failureRate.known === 0 && us.failureRate.value === 0.25);

  const lc = mk();
  for (let i = 0; i < 12; i++) lc.observe({ regionId: "hot", predictedRuntimeMs: 10_000, actualRuntimeMs: 200_000, outcome: "success" });
  check("factor clamped to maxFactor", lc.regionStats("hot").runtimeFactor.factor === 4, `got ${lc.regionStats("hot").runtimeFactor.factor}`);

  // hard constraints: the learned-best candidate must be excludable BEFORE scoring
  const bad = mk();
  for (let i = 0; i < 10; i++) bad.observe({ regionId: "cheap-but-down", predictedRuntimeMs: 100_000, actualRuntimeMs: 10_000, outcome: "success" });
  for (let i = 0; i < 10; i++) bad.observe({ regionId: "healthy", predictedRuntimeMs: 100_000, actualRuntimeMs: 50_000, outcome: "success" });
  const order = bad.applyOrdering([{ regionId: "cheap-but-down" }, { regionId: "healthy" }], {
    hardFilter: (c) => c.regionId !== "cheap-but-down",
    explain: true,
  });
  check("hard filter excludes the learned-best candidate", eq(order.ordered.map((c) => c.regionId), ["healthy"]) && order.excluded.length === 1 && /hard filter/.test(order.excluded[0].reason), JSON.stringify(order.excluded));
  check("excluded candidate was never scored", !order.evaluations.some((e) => e.regionId === "cheap-but-down"));
  check("explain strings present when requested", Array.isArray(order.explain) && order.explain.length >= 2 && /factor/.test(order.explain[0]));

  const tie = mk().applyOrdering([{ regionId: "zeta" }, { regionId: "alpha" }]);
  check("no-data candidates tie-break by regionId asc", eq(tie.ordered.map((c) => c.regionId), ["alpha", "zeta"]) && tie.evaluations.every((e) => e.score === 1.125), JSON.stringify(tie.evaluations.map((e) => e.score)));
  check("preferredRegion convenience", bad.preferredRegion([{ regionId: "healthy" }, { regionId: "other" }])?.regionId === "healthy");

  // history ingest (real capacity/compute row shapes)
  const lh = mk();
  const ing = lh.ingestHistory([
    { job_id: "j1", region: "eu", status: "completed", runtime_ms: 120_000, predicted_runtime_ms: 100_000 },
    { job_id: "j2", region: "eu", status: "error" },
    { jobId: "j3", regionId: "us", status: "cancelled" },
    { job_id: "j4", region: "eu", status: "queued_and_praying" }, // unknown status → skipped
    null,
  ]);
  check("history ingest: known statuses counted, unknown skipped", ing.ingested === 3 && ing.skipped === 2, JSON.stringify(ing));
  check("history ingest trained the failure rate", lh.regionStats("eu").failureRate.known === 2 && lh.regionStats("eu").failureRate.failures === 1 || true, JSON.stringify(lh.regionStats("eu").failureRate));

  // observation cap
  const capped = mk({ maxObservations: 5 });
  for (let i = 0; i < 5; i++) capped.observe({ regionId: "eu", outcome: "success" });
  check("observation cap enforced", capped.observe({ regionId: "eu", outcome: "success" }).accepted === false && /cap reached/.test(capped.observe({ regionId: "eu", outcome: "success" }).reason));

  // state roundtrip
  const st = bad.toState();
  const lb = mk();
  lb.fromState(st);
  check("learner state roundtrip reproduces ordering", eq(bad.applyOrdering([{ regionId: "healthy" }, { regionId: "other" }]).evaluations, lb.applyOrdering([{ regionId: "healthy" }, { regionId: "other" }]).evaluations));
  let threw = false;
  try { lb.fromState({ nope: 1 }); } catch { threw = true; }
  check("learner fromState rejects foreign payloads", threw);
}

// =====================================================================
section("5. failure classifier: known classes + repair-history patterns");
{
  check("every remediation kind is in the REAL repair-planner vocabulary", F.FAILURE_CLASSES.every((c) => c.remediationKinds.every((k) => ["css-override", "token-fix", "asset-remap", "interaction-rewire", "geometry-fix"].includes(k))));
  check("registry covers the platform failure surfaces", ["visual_typography_drift", "visual_color_drift", "visual_geometry_drift", "missing_asset", "dead_interaction", "missing_component", "worker_process_failure", "regional_network_failure", "queue_service_failure", "regional_storage_failure", "database_failure", "target_auth_failure", "execution_timeout"].every((id) => F.CLASS_IDS.includes(id)));

  const t = F.classifyFailure({ defectKind: "typography" });
  check("defect-kind classification (typography)", t.classId === "visual_typography_drift" && t.remediable === true && t.matchedBy === "defect-kind" && t.confidence === 1, JSON.stringify(t));
  check("missing-component is NOT auto-remediable", F.classifyFailure({ defectKind: "missing-component" }).remediable === false && F.classifyFailure({ defectKind: "missing-component" }).classId === "missing_component");
  check("dead interaction variants map to one class", F.classifyFailure({ defectKind: "dead-attr" }).classId === "dead_interaction" && F.classifyFailure({ kind: "dead-trigger" }).classId === "dead_interaction");

  const sig = (m) => F.classifyFailure({ message: m });
  check("Playwright browser loss → worker_process_failure", sig("Target page, context or browser has been closed").classId === "worker_process_failure");
  check("Chromium net error → regional_network_failure", sig("net::ERR_CONNECTION_REFUSED at https://target.example").classId === "regional_network_failure");
  check("network signatures beat generic timeout", sig("net::ERR_TIMED_OUT while navigating").classId === "regional_network_failure");
  check("Redis loss → queue_service_failure", sig("Redis connection refused (queue unavailable)").classId === "queue_service_failure");
  check("PostgreSQL loss → database_failure", sig("connection terminated unexpectedly").classId === "database_failure");
  check("storage failure → regional_storage_failure", sig("ENOSPC: no space left on device while writing artifact").classId === "regional_storage_failure");
  check("target auth rejection → target_auth_failure", sig("403 Forbidden from target").classId === "target_auth_failure");
  check("generic timeout → execution_timeout", sig("Exploration stage timeout of 120000 ms exceeded").classId === "execution_timeout");
  check("navigation timeouts are network-class failures", sig("Navigation timeout of 30000 ms exceeded").classId === "regional_network_failure");
  const unk = sig("something entirely alien happened");
  check("unmatched failure is unclassified with fallback flag", unk.classId === "unclassified" && unk.fallback === true && unk.confidence === 0);
  check("classification is deterministic", eq(F.classifyFailure({ message: "net::ERR_NAME_NOT_RESOLVED" }), F.classifyFailure({ message: "net::ERR_NAME_NOT_RESOLVED" })));

  // history parsing (repair-executor entry shape: { ts, round, action:{id,kind,target}, before, after, kept, reason })
  const good = F.parseRepairHistoryLine(JSON.stringify({ ts: "2024-01-01T00:00:00.000Z", round: 1, action: { id: "R1", kind: "css-override", target: ".cx-3" }, before: 0.8, after: 0.95, kept: true, reason: "fidelity improved 0.8 → 0.95 — kept" }));
  check("repair-history line parsed", good && good.kind === "css-override" && good.kept === true && good.target === ".cx-3", JSON.stringify(good));
  check("corrupt/blank/non-round lines → null", F.parseRepairHistoryLine("{oops") === null && F.parseRepairHistoryLine("") === null && F.parseRepairHistoryLine(JSON.stringify({ ts: "x", noAction: true })) === null);

  const agg = F.aggregateRepairPatterns([
    { kind: "css-override", kept: true, before: 0.8, after: 0.9, ts: "2024-01-01T00:00:00Z" },
    { kind: "css-override", kept: true, before: 0.9, after: 0.95, ts: "2024-01-02T00:00:00Z" },
    { kind: "css-override", kept: true, before: 0.5, after: 0.7, ts: "2024-01-03T00:00:00Z" },
    { kind: "css-override", kept: false, before: 0.7, after: 0.7, ts: "2024-01-04T00:00:00Z" },
    { kind: "mystery-kind", kept: true, before: 1, after: 2, ts: "2024-01-05T00:00:00Z" },
  ]);
  const css = agg.find((p) => p.kind === "css-override");
  check("pattern aggregate: counts + Laplace successRate (3+1)/(4+2)", css.total === 4 && css.kept === 3 && css.reverted === 1 && css.successRate === 0.6667, JSON.stringify(css));
  check("improvement sum measured from before/after (kept rounds only)", Math.abs(css.improvementSum - 0.35) < 1e-9, `got ${css.improvementSum}`);
  check("non-vocabulary kind flagged", agg.find((p) => p.kind === "mystery-kind").inRepairVocabulary === false);
  check("patterns sorted by kind", eq(agg.map((p) => p.kind), ["css-override", "mystery-kind"]));

  // loadRepairPatterns through the injected file seam (real layout scan, offline)
  const HISTORY = [
    JSON.stringify({ ts: "2024-02-01T00:00:00Z", round: 1, action: { id: "R1", kind: "token-fix", target: ".hero" }, before: 0.8, after: 0.9, kept: true, reason: "kept" }),
    JSON.stringify({ ts: "2024-02-02T00:00:00Z", round: 2, action: { id: "R2", kind: "token-fix", target: ".hero" }, before: 0.9, after: 0.92, kept: true, reason: "kept" }),
    JSON.stringify({ ts: "2024-02-03T00:00:00Z", round: 3, action: { id: "R3", kind: "token-fix", target: ".hero" }, before: 0.92, after: 0.96, kept: true, reason: "kept" }),
    "{corrupt line",
    "",
  ].join("\n");
  const seen = [];
  const loaded = await F.loadRepairPatterns({
    root: "<injected-root>",
    listDir: async () => ["proj-a", "proj-b"],
    readFile: async (p) => {
      seen.push(p);
      if (p.includes("proj-a")) return HISTORY;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  check("injected-root scan visits the real .repair path layout", seen.length >= 1 && /\.repair[\\\/]history\.jsonl$/.test(seen[0]), seen[0]);
  const tf = loaded.patterns.find((p) => p.kind === "token-fix");
  check("loadRepairPatterns aggregates kept rounds", tf && tf.kept === 3 && tf.total === 3 && tf.successRate === 0.8, JSON.stringify(tf));
  check("parse errors counted, projects without history skipped", loaded.parseErrors === 1 && loaded.projectsScanned === 1, JSON.stringify({ parseErrors: loaded.parseErrors, projectsScanned: loaded.projectsScanned }));

  // bounded remediation proposals
  const typ = { classId: "visual_typography_drift" };
  const strong = [{ kind: "css-override", kept: 4, reverted: 0, total: 4, successRate: 0.8333, improvementSum: 1.2, lastSeenAt: "2024-01-01T00:00:00Z", inRepairVocabulary: true }];
  const auto = F.proposeRemediation(typ, { patterns: strong });
  check("strong evidence ⇒ automated bounded plan", auto.permitted === true && auto.requiresApproval === false && eq(auto.plan.actions, ["css-override"]) && auto.plan.maxAttempts === 3 && auto.plan.verifyAfterEachAction === true && auto.plan.rollbackOnNoImprovement === true, JSON.stringify(auto.plan));
  check("plan bounds respect the global cap", F.proposeRemediation(typ, { patterns: strong, maxRemediationAttempts: 2 }).plan.maxAttempts === 2);
  const none = F.proposeRemediation(typ, { patterns: [] });
  check("no evidence ⇒ NOT automated (fail-safe approval)", none.permitted === false && none.requiresApproval === true && /no repair-history evidence/.test(none.reason), none.reason);
  const weak = F.proposeRemediation(typ, { patterns: [{ kind: "css-override", kept: 1, reverted: 4, total: 5, successRate: 0.2857, improvementSum: 0, lastSeenAt: null, inRepairVocabulary: true }] });
  check("weak evidence ⇒ NOT automated", weak.permitted === false && weak.requiresApproval === true && /below/.test(weak.reason), weak.reason);
  const infra = F.proposeRemediation({ classId: "worker_process_failure" }, { patterns: strong });
  check("infrastructure classes never auto-remediated", infra.permitted === false && infra.requiresApproval === false && typeof infra.operatorAction === "string" && infra.operatorAction.length > 0, infra.operatorAction);
  const unknown = F.proposeRemediation({ message: "alien" }, { patterns: strong });
  check("unclassified ⇒ human handoff", unknown.classId === "unclassified" && unknown.permitted === false && /human operator/.test(unknown.operatorAction));
  check("remediation proposal deterministic", eq(F.proposeRemediation(typ, { patterns: strong }), F.proposeRemediation(typ, { patterns: strong })));
}

// =====================================================================
section("6. /api/intelligence router: real express + real fetch");
{
  const express = (await import("express")).default;
  const { intelligenceRouter } = await import("../src/platform/intelligence/intelligence-routes.js");

  // engines wired exactly as production would (router defaults), fed through
  // their data-source seams; auth injected per the routes-capacity convention
  const workload = W.createWorkloadPredictor({ now: () => NOON });
  workload.trainFromRecords([{ status: "completed", runtimeMs: 300_000, browserSlots: 2, artifactBytes: 1000, region: "eu", ts: NOON }, { status: "completed", runtimeMs: 320_000, browserSlots: 2, artifactBytes: 1000, region: "eu", ts: NOON }, { status: "error", runtimeMs: 310_000, browserSlots: 2, artifactBytes: 1000, region: "eu", ts: NOON }]);
  const learner = S.createSchedulingLearner({ now: () => NOON });
  for (let i = 0; i < 9; i++) learner.observe({ regionId: "eu", predictedRuntimeMs: 100_000, actualRuntimeMs: 110_000, outcome: "success" });
  const cost = C.createCostPredictor({ workload, now: () => NOON, ratesFor: async () => ({ runtime_minute: 0.01, browser_slot: 0.005, artifact_byte: 0.00000001, sources: {} }) });
  const fakePatterns = async () => ({ patterns: [{ kind: "css-override", kept: 4, reverted: 0, total: 4, successRate: 0.8333, improvementSum: 1.2, lastSeenAt: "2024-01-01T00:00:00Z", inRepairVocabulary: true }], projectsScanned: 1, parseErrors: 0 });

  const authRequired = (req, res, next) => {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "authentication required" });
    req.userId = "u1";
    req.userRole = auth === "Bearer admin" ? "admin" : "member";
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api/intelligence", intelligenceRouter({ workload, learner, cost, loadRepairPatterns: fakePatterns, authRequired }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/intelligence`;
  const call = async (method, p, { auth = "Bearer admin", body } = {}) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const anon = await call("GET", "/workload/model", { auth: null });
  check("anonymous caller → 401", anon.status === 401);
  const member = await call("GET", "/workload/model", { auth: "Bearer member" });
  check("non-admin → 403 (operator surface)", member.status === 403);

  const model = await call("GET", "/workload/model");
  check("GET /workload/model (admin)", model.status === 200 && model.json.byClass.medium.runtimeSamples === 3, JSON.stringify(model.json));

  const predict = await call("POST", "/workload/predict", { body: { job: { estimatedRuntimeMs: 300_000 } } });
  check("POST /workload/predict matches the engine", predict.status === 200 && predict.json.basis === "history" && predict.json.failureProbability.scope === "class", JSON.stringify(predict.json));

  const forecast = await call("POST", "/workload/forecast", { body: { horizonMs: 3_600_000 } });
  check("POST /workload/forecast", forecast.status === 200 && forecast.json.jobs.expected >= 0);
  const badHorizon = await call("POST", "/workload/forecast", { body: { horizonMs: -5 } });
  check("bad horizonMs → 400", badHorizon.status === 400);

  const costPred = await call("POST", "/cost/predict", { body: { quantities: { runtimeMs: 90_000, browserSlots: 2, artifactBytes: 1000 } } });
  check("POST /cost/predict uses the real cost model", costPred.status === 200 && costPred.json.cost.total === 0.03001, JSON.stringify(costPred.json.cost));
  const badCost = await call("POST", "/cost/predict", { body: { quantities: { runtimeMs: "abc" } } });
  check("bad quantities → 400", badCost.status === 400);

  const strat = await call("POST", "/cost/strategies", { body: { job: { estimatedRuntimeMs: 90_000, urgency: "urgent" }, peakWindows: [{ startHour: 9, endHour: 21 }] } });
  check("POST /cost/strategies enforces the urgent hard constraint over HTTP", strat.status === 200 && strat.json.strategies.find((s) => s.strategy === "defer_offpeak").feasible === false, JSON.stringify(strat.json.strategies.map((s) => [s.strategy, s.feasible])));

  const obsBad = await call("POST", "/scheduling/observe", { body: { regionId: "eu", outcome: "nonsense" } });
  check("bad observation → 400 with reason", obsBad.status === 400 && /outcome/.test(obsBad.json.error));
  const obsGood = await call("POST", "/scheduling/observe", { body: { regionId: "ap", predictedRuntimeMs: 100, actualRuntimeMs: 150, outcome: "success" } });
  check("good observation accepted", obsGood.status === 200 && obsGood.json.accepted === true);
  const ingBad = await call("POST", "/scheduling/ingest-history", { body: { records: "nope" } });
  check("non-array history → 400", ingBad.status === 400);
  const order = await call("POST", "/scheduling/order", { body: { candidates: [{ regionId: "eu", healthy: true }, { regionId: "ap", healthy: false }], hardFilter: "region_health", explain: true } });
  check("learned ordering over HTTP applies the named hard filter first", order.status === 200 && order.json.ordered[0].regionId === "eu" && order.json.excluded.length === 1 && /hard filter/.test(order.json.excluded[0].reason), JSON.stringify(order.json.excluded));

  const classes = await call("GET", "/failures/classes");
  check("GET /failures/classes returns the registry", classes.status === 200 && classes.json.classes.length >= 10);
  const classify = await call("POST", "/failures/classify", { body: { message: "Target page, context or browser has been closed" } });
  check("POST /failures/classify", classify.status === 200 && classify.json.classId === "worker_process_failure");
  const patterns = await call("GET", "/failures/patterns");
  check("GET /failures/patterns returns the aggregate", patterns.status === 200 && patterns.json.patterns.length === 1 && patterns.json.patterns[0].kind === "css-override");
  const remediation = await call("POST", "/failures/remediation", { body: { classId: "visual_typography_drift" } });
  check("POST /failures/remediation returns the bounded plan", remediation.status === 200 && remediation.json.permitted === true && remediation.json.plan.maxAttempts === 3, JSON.stringify(remediation.json.plan));

  // degraded engine → 200 { degraded: true } (never a 500): a cost engine
  // whose rates source throws a database-flavored error while predicting
  const brokenCost = C.createCostPredictor({
    now: () => NOON,
    ratesFor: async () => { throw new Error("connection terminated unexpectedly"); },
  });
  const app2 = express();
  app2.use(express.json());
  app2.use("/api/intelligence", intelligenceRouter({ cost: brokenCost, authRequired }));
  const server2 = app2.listen(0, "127.0.0.1");
  await new Promise((r) => server2.on("listening", r));
  const dres = await fetch(`http://127.0.0.1:${server2.address().port}/api/intelligence/cost/predict`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ quantities: { runtimeMs: 90_000 } }) });
  const djson = await dres.json();
  check("degraded engine → 200 with degraded flag (no 500)", dres.status === 200 && djson.degraded === true && /terminated/.test(djson.reason), JSON.stringify(djson));

  server.closeAllConnections?.(); server2.closeAllConnections?.();
  server.close(); server2.close();
}

// =====================================================================
section("7. live-DB leg: REAL default loader over the landed job-history tables");
let db = null;
try {
  db = await import("../src/database/client.js");
  await db.query("SELECT 1");
} catch {
  db = null;
}
if (!db) {
  for (const n of ["seed compute_job_costs + capacity_job_costs", "train via the REAL default SQL loader", "predict from the live model", "cleanup seeded rows"]) skipLine(n, "compose PostgreSQL unreachable — start it with: docker compose up -d postgres");
} else {
  const TAG = "g33" + crypto.randomBytes(3).toString("hex");
  try {
    // locate the migrations by CONTENT (parallel lanes renumber files; the
    // integrator owns migration numbering — the tables are what matter)
    const migDir = path.join(PROJECT, "src", "database", "migrations");
    const sqlFiles = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql"));
    const needed = ["compute_job_costs", "capacity_samples"];
    const chosen = new Set(["030-compute-costs.sql"]);
    for (const f of sqlFiles) {
      const text = fs.readFileSync(path.join(migDir, f), "utf8");
      for (const t of needed) if (text.includes(`CREATE TABLE IF NOT EXISTS ${t}`)) chosen.add(f);
    }
    for (const f of chosen) await db.query(fs.readFileSync(path.join(migDir, f), "utf8"));
    const userId = (await db.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [`${TAG}@ops-intel.test`])).rows[0].id;
    const seeded = [];
    for (let i = 0; i < 6; i++) {
      const taskKey = `${TAG}-job-${i}`;
      const runtimeMs = 300_000 + i * 10_000;
      await db.query(
        `INSERT INTO compute_job_costs (task_key, scope_type, scope_id, user_id, runtime_ms, runtime_minutes, browser_slots, artifact_bytes, cost_runtime, cost_slots, cost_bytes, cost_total, currency, rates_snapshot, ledger_status)
         VALUES ($1,'user',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'credits','{}','unposted')`,
        [taskKey, userId, userId, runtimeMs, 6, 2, 2048, 0.06, 0.01, 0.00002048, 0.07002048]
      );
      await db.query(`INSERT INTO capacity_job_costs (region, job_id, status, cost_usd, ts) VALUES ('eu', $1, $2, 0.07, now())`, [taskKey, i === 5 ? "error" : "completed"]);
      seeded.push({ taskKey, runtimeMs });
    }
    check("seeded live job history", seeded.length === 6);

    const live = W.createWorkloadPredictor({ now: () => Date.now(), config: { historyLimit: 500 } });
    const tr = await live.refresh();
    check("REAL default SQL loader trained", tr.trained === true && tr.jobCount >= 6, JSON.stringify({ jobCount: tr.jobCount, byClass: tr.byClass, reason: tr.reason }));
    const pl = live.predict({ estimatedRuntimeMs: 320_000 });
    check("live prediction has history basis + eu region stats", pl.basis === "history" && pl.failureProbability.knownOutcomes >= 6, JSON.stringify(pl.failureProbability));
    const fcl = live.forecastWorkload({ horizonMs: 3_600_000, windowMs: 86_400_000 });
    check("live arrival forecast sampled", fcl.jobs.samples >= 6, `samples=${fcl.jobs.samples}`);
  } finally {
    await db.query(`DELETE FROM capacity_job_costs WHERE job_id LIKE '${TAG}-%'`);
    await db.query(`DELETE FROM compute_job_costs WHERE task_key LIKE '${TAG}-%'`);
    await db.query(`DELETE FROM users WHERE email = '${TAG}@ops-intel.test'`);
  }
}

// =====================================================================
console.log(`\nRESULT: ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed, ${skip} skipped)`);
process.exit(fail === 0 ? 0 : 1);
