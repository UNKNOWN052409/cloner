// Cost prediction (Phase 5.0 — cost-prediction area, task G3.3).
//
// Predicts a job's cost BEFORE execution and recommends cheaper execution
// strategies. Built on the REAL landed cost machinery — nothing here invents
// a cost model:
//
//   • credit-side cost: src/platform/compute-accounting.js computeCost()
//     (the exact round6 cost model over resolved rates) with quantities
//     predicted by the workload predictor (./workload-prediction.js) or
//     supplied explicitly.
//   • infrastructure-side region cost: the documented 4.2.13 formula
//     hourlyRate × runtimeHours × peakMultiplier + fixedPerJob, with the
//     SAME peak-window semantics as src/distributed/cost-aware-scheduler.js
//     (that module is not owned by this lane and is not edited — the pure
//     helpers below replicate its documented, tested semantics and credit it).
//
// Rates resolution (deterministic fallback, offline CI contract):
//   injected ratesFor(scope)  → used verbatim
//   default                   → the real compute-accounting.resolveRates()
//                               (lazy import); when PostgreSQL is unreachable
//                               it falls back to the env-configurable
//                               DEFAULT_RATES (COMPUTE_RATE_*), flagged
//                               ratesSource: "env-defaults". Never throws on a
//                               missing database.
//
// Strategy recommendation is HARD-CONSTRAINED (the 4.2.13 risk note):
//   • urgent jobs (urgency "urgent" or priority >= deferPriorityThreshold)
//     are NEVER deferred — deferral is refused with a reason, not offered.
//   • deferral must fit inside the job's deadline (deadlineAt, if any, with a
//     safety buffer) and a hard maxDeferralMs cap.
//   • region moves never leave the job's regionAffinity (when given); a
//     region without pricing is not evaluated, never guessed.
// Output is a deterministic, explainable, ordered option list.
import { computeCost, DEFAULT_RATES, round6 as round6Cost } from "../compute-accounting.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const DEFAULTS = Object.freeze({
  offPeakDiscount: 0.5,             // multiplier outside a peak window = 1 - discount
  deferPriorityThreshold: 60,       // priority >= threshold ⇒ urgent (never deferred)
  slaBufferMs: MINUTE_MS,           // safety margin between run + start and the deadline
  maxDeferralMs: 12 * HOUR_MS,      // hard deferral cap
  minSavingsFraction: 0.1,          // defer only when saving >= 10%
  defaultRuntimeMs: 5 * MINUTE_MS,  // job.estimatedRuntimeMs fallback
});

// ---------- env config (same keys the 4.2.13 scheduler reads; optional) -----

export function readEnvPricing(raw = process.env.COST_AWARE_REGION_PRICING) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cost-prediction] COST_AWARE_REGION_PRICING is not valid JSON: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[cost-prediction] COST_AWARE_REGION_PRICING must be a JSON object of { regionId: { hourlyRate, fixedPerJob } }");
  }
  return parsed;
}

export function readEnvPeakWindows(raw = process.env.COST_AWARE_CONFIG) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cost-prediction] COST_AWARE_CONFIG is not valid JSON: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("[cost-prediction] COST_AWARE_CONFIG must be a JSON object");
  return Array.isArray(parsed.peakWindows) ? parsed.peakWindows : null;
}

// ---------- peak-window helpers (semantics of cost-aware-scheduler.js) ------

function localParts(epochMs, tzOffsetMinutes) {
  const d = new Date(epochMs + tzOffsetMinutes * MINUTE_MS);
  return { hour: d.getUTCHours(), day: d.getUTCDay() };
}

function validateWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.map((w) => {
    const startHour = Number(w?.startHour);
    const endHour = Number(w?.endHour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
      throw new Error("[cost-prediction] peakWindows.startHour must be an integer 0..23");
    }
    if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
      throw new Error("[cost-prediction] peakWindows.endHour must be an integer 1..24");
    }
    if (endHour <= startHour) throw new Error("[cost-prediction] peakWindows must satisfy endHour > startHour (no midnight crossing)");
    const days = w.days == null ? null : w.days.map(Number);
    if (days) {
      for (const d of days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error("[cost-prediction] peakWindows.days must contain integers 0..6 (0=Sunday)");
      }
    }
    return days && days.length ? { days, startHour, endHour } : { startHour, endHour };
  });
}

export function isPeak(epochMs, windows, tzOffsetMinutes = 0) {
  const ws = validateWindows(windows);
  if (!ws.length) return false;
  const { hour, day } = localParts(epochMs, tzOffsetMinutes);
  for (const w of ws) {
    const days = Array.isArray(w.days) && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(day)) continue;
    if (hour >= w.startHour && hour < w.endHour) return true;
  }
  return false;
}

// first moment at/after `from` outside every peak window (hour-aligned
// membership, same as the scheduler). No windows ⇒ already off-peak ⇒ `from`.
export function nextOffPeakStart(epochMs, windows, tzOffsetMinutes = 0) {
  if (!isPeak(epochMs, windows, tzOffsetMinutes)) return epochMs;
  let t = Math.floor(epochMs / HOUR_MS) * HOUR_MS;
  for (let i = 0; i <= 8 * 24; i++) {
    if (!isPeak(t, windows, tzOffsetMinutes)) return Math.max(t, epochMs);
    t += HOUR_MS;
  }
  throw new Error("[cost-prediction] no off-peak hour within 8 days — check peakWindows");
}

// ---------- pricing validation (mirrors the scheduler's rules) --------------

function validatePricingMap(pricing) {
  const out = new Map();
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return out;
  for (const [regionId, p] of Object.entries(pricing)) {
    const hourlyRate = Number(p?.hourlyRate);
    const fixedPerJob = Number(p?.fixedPerJob ?? 0);
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      throw new Error(`[cost-prediction] regionPricing.hourlyRate for "${regionId}" must be a positive number`);
    }
    if (!Number.isFinite(fixedPerJob) || fixedPerJob < 0) {
      throw new Error(`[cost-prediction] regionPricing.fixedPerJob for "${regionId}" must be a non-negative number`);
    }
    out.set(String(regionId).slice(0, 64), { hourlyRate, fixedPerJob });
  }
  return out;
}

// ---------- the predictor ----------------------------------------------------

export function createCostPredictor({
  workload = null,       // optional createWorkloadPredictor() for quantity prediction
  ratesFor = null,       // optional async (scope) → { runtime_minute, browser_slot, artifact_byte, currency? }
  now = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const nowMs = () => (typeof now === "function" ? now() : now != null ? Number(now) : Date.now());

  async function defaultRatesFor(scope) {
    try {
      const acct = await import("../compute-accounting.js");
      return await acct.resolveRates(scope);
    } catch {
      // Deterministic fallback: the env-configurable default rates. Flagged —
      // never silently presented as database-resolved rates.
      return {
        runtime_minute: DEFAULT_RATES.runtime_minute(),
        browser_slot: DEFAULT_RATES.browser_slot(),
        artifact_byte: DEFAULT_RATES.artifact_byte(),
        currency: (process.env.COMPUTE_CURRENCY || "credits").trim() || "credits",
        sources: { runtime_minute: "env", browser_slot: "env", artifact_byte: "env" },
      };
    }
  }

  function ratesSourceOf(rates) {
    const vals = rates && rates.sources && typeof rates.sources === "object" ? Object.values(rates.sources) : [];
    const s = vals.length ? String(vals[0]) : null;
    if (!s) return "injected";
    if (s === "env") return "env-defaults";
    if (s === "scope" || s === "global") return "database";
    return s;
  }

  function runtimeMsOf(job) {
    const n = Number(job?.estimatedRuntimeMs ?? job?.runtimeMs);
    return Number.isFinite(n) && n > 0 ? n : cfg.defaultRuntimeMs;
  }

  function isUrgent(job) {
    if (job?.urgency === "urgent") return true;
    if (job?.urgency === "batch" || job?.urgency === "low") return false;
    const p = Number(job?.priority);
    return Number.isFinite(p) ? p >= cfg.deferPriorityThreshold : false;
  }

  // resolve the cost quantities: explicit > workload predictor > defaults
  async function resolveQuantities({ quantities, job }) {
    if (quantities && typeof quantities === "object") {
      const rt = Number(quantities.runtimeMs);
      const sl = Number(quantities.browserSlots ?? 0);
      const by = Number(quantities.artifactBytes ?? 0);
      if (!Number.isFinite(rt) || rt < 0) throw new Error("quantities.runtimeMs must be a non-negative finite number");
      if (!Number.isFinite(sl) || sl < 0) throw new Error("quantities.browserSlots must be a non-negative finite number");
      if (!Number.isFinite(by) || by < 0) throw new Error("quantities.artifactBytes must be a non-negative finite number");
      return { runtimeMs: Math.round(rt), browserSlots: Math.round(sl), artifactBytes: Math.round(by), basis: "explicit" };
    }
    if (workload && typeof workload.predict === "function") {
      const p = workload.predict(job || {});
      return {
        runtimeMs: Math.max(0, Math.round(p.runtimeMs.estimate)),
        browserSlots: Math.max(0, p.resources.browserSlots),
        artifactBytes: Math.max(0, p.resources.artifactBytes),
        basis: `workload-prediction:${p.basis}`,
      };
    }
    const rt = runtimeMsOf(job);
    return { runtimeMs: Math.round(rt), browserSlots: Math.max(0, Math.round(Number(job?.browserSlots ?? 1)) || 1), artifactBytes: Math.max(0, Math.round(Number(job?.artifactBytes ?? 0)) || 0), basis: "defaults" };
  }

  // predictCost({ scope, job, quantities }) → credit-side prediction using the
  // REAL compute-accounting cost model (exact round6 arithmetic).
  async function predictCost({ scope = null, job = {}, quantities = null } = {}) {
    const rates = await (ratesFor ? ratesFor(scope) : defaultRatesFor(scope));
    const q = await resolveQuantities({ quantities, job });
    const cost = computeCost(q, rates);
    return {
      quantities: q,
      rates: {
        runtime_minute: rates.runtime_minute,
        browser_slot: rates.browser_slot,
        artifact_byte: rates.artifact_byte,
        currency: rates.currency,
        source: ratesSourceOf(rates),
      },
      cost: {
        runtime: cost.costRuntime,
        slots: cost.costSlots,
        bytes: cost.costBytes,
        total: cost.costTotal,
        runtimeMinutes: cost.runtimeMinutes,
        currency: cost.currency,
      },
      basis: q.basis,
    };
  }

  // infrastructure-side cost for one region at one instant (4.2.13 formula).
  // Only meaningful when regionPricing exists for the region.
  function estimateRegionCost({ regionId, runtimeMs, at, pricing, peakWindows = [], tzOffsetMinutes = 0 }) {
    const p = pricing.get(String(regionId).slice(0, 64));
    if (!p) return null;
    const multiplier = isPeak(at, peakWindows, tzOffsetMinutes) ? 1 : 1 - cfg.offPeakDiscount;
    return round6Cost(p.hourlyRate * (runtimeMs / HOUR_MS) * multiplier + (p.fixedPerJob || 0));
  }

  // recommendStrategies({ scope, job, quantities, regionPricing?, peakWindows?,
  //   tzOffsetMinutes? }) → { baseline, strategies: [...] } — deterministic,
  //   explainable option list:
  //     run_now          the credit-side predicted cost (always present)
  //     defer_offpeak    offered only when: currently at peak, deferral fits
  //                      the deadline + hard cap, savings clear the threshold
  //                      AND the job is not urgent (urgent ⇒ offered as
  //                      feasible:false with the refusal reason)
  //     move_region      cheapest affinity-feasible priced region vs the most
  //                      expensive priced region (no pricing ⇒ omitted)
  //   Ordering: feasible first, then savingsFraction desc, estimatedCost asc,
  //   strategy asc, regionId asc — fully deterministic.
  async function recommendStrategies({ scope = null, job = {}, quantities = null, regionPricing = null, peakWindows = null, tzOffsetMinutes = 0 } = {}) {
    const at = nowMs();
    const baseline = await predictCost({ scope, job, quantities });
    const runtimeMs = baseline.quantities.runtimeMs;
    const windows = peakWindows === undefined || peakWindows === null ? (readEnvPeakWindows() || []) : peakWindows;
    const strategies = [{
      strategy: "run_now",
      feasible: true,
      estimatedCost: baseline.cost.total,
      currency: baseline.cost.currency,
      savingsFraction: 0,
      reason: "credit-side predicted cost at current rates",
    }];

    // ---- off-peak deferral (credit-side runtime component discount) ----
    const urgent = isUrgent(job);
    const deadline = Number(job?.deadlineAt);
    const hasDeadline = Number.isFinite(deadline) && deadline > at;
    const atPeak = isPeak(at, windows, tzOffsetMinutes);
    // An always-peak window (legal config, e.g. { startHour: 0, endHour: 24 })
    // has no off-peak hour: the deferral option degrades to infeasible-with-
    // reason instead of throwing (a read path must never 500).
    let startAt = null;
    if (atPeak) {
      try { startAt = nextOffPeakStart(at, windows, tzOffsetMinutes); }
      catch { startAt = null; }
    }
    const deferredRuntime = round6Cost(baseline.cost.runtime * (1 - cfg.offPeakDiscount));
    const deferCost = round6Cost(deferredRuntime + baseline.cost.slots + baseline.cost.bytes);
    const savingsFraction = baseline.cost.total > 0 ? round6Cost(1 - deferCost / baseline.cost.total) : 0;

    let deferReason;
    let deferFeasible = true;
    if (!atPeak) {
      deferFeasible = false;
      deferReason = "already off-peak — deferral has nothing to wait for";
    } else if (startAt == null) {
      deferFeasible = false;
      deferReason = "no off-peak hour within the next 8 days — check peakWindows (deferral unavailable)";
    } else if (!urgent && startAt - at > cfg.maxDeferralMs) {
      deferFeasible = false;
      deferReason = `off-peak start in ${Math.round((startAt - at) / MINUTE_MS)} min exceeds maxDeferralMs`;
    } else if (!urgent && hasDeadline && startAt + runtimeMs + cfg.slaBufferMs > at + (deadline - at)) {
      deferFeasible = false;
      deferReason = "off-peak start would run past the job deadline";
    } else if (urgent) {
      deferFeasible = false;
      deferReason = "job is urgent — deferral is never offered for urgent jobs (hard constraint)";
    } else if (savingsFraction < cfg.minSavingsFraction) {
      deferFeasible = false;
      deferReason = `savings ${(savingsFraction * 100).toFixed(1)}% below minSavingsFraction ${(cfg.minSavingsFraction * 100).toFixed(1)}%`;
    } else {
      deferReason = `run in the off-peak window starting ${new Date(startAt).toISOString()} — runtime component discounted ${(cfg.offPeakDiscount * 100).toFixed(0)}%`;
    }
    strategies.push({
      strategy: "defer_offpeak",
      feasible: deferFeasible,
      startAt: startAt == null ? null : new Date(startAt).toISOString(),
      estimatedCost: deferCost,
      currency: baseline.cost.currency,
      savingsFraction,
      reason: deferReason,
      peakNow: atPeak,
    });

    // ---- region moves (infrastructure-side; needs pricing) ----
    let pricing;
    try {
      pricing = validatePricingMap(regionPricing != null ? regionPricing : readEnvPricing());
    } catch {
      pricing = new Map();
    }
    if (pricing.size > 0) {
      const affinity = Array.isArray(job?.regionAffinity) && job.regionAffinity.length ? job.regionAffinity.map((r) => String(r).slice(0, 64)) : null;
      const rows = [];
      for (const [regionId, _p] of pricing.entries()) {
        if (affinity && !affinity.includes(regionId)) {
          rows.push({ regionId, estimatedCost: null, excluded: "outside regionAffinity (hard constraint)" });
          continue;
        }
        const cost = estimateRegionCost({ regionId, runtimeMs, at, pricing, peakWindows: windows, tzOffsetMinutes });
        rows.push({ regionId, estimatedCost: cost, excluded: null });
      }
      const evaluated = rows.filter((r) => r.estimatedCost != null);
      if (evaluated.length >= 2) {
        const sorted = evaluated.slice().sort((a, b) => a.estimatedCost - b.estimatedCost || a.regionId.localeCompare(b.regionId));
        const cheapest = sorted[0];
        const mostExpensive = sorted[sorted.length - 1];
        const savingsFraction = mostExpensive.estimatedCost > 0 ? round6Cost(1 - cheapest.estimatedCost / mostExpensive.estimatedCost) : 0;
        const moveFeasible = savingsFraction >= cfg.minSavingsFraction;
        strategies.push({
          strategy: "move_region",
          feasible: moveFeasible,
          regionId: cheapest.regionId,
          comparedToRegion: mostExpensive.regionId,
          estimatedCost: cheapest.estimatedCost,
          currency: "region-pricing",
          savingsFraction,
          reason: moveFeasible
            ? `region ${cheapest.regionId} prices this job at ${cheapest.estimatedCost} vs ${mostExpensive.estimatedCost} in ${mostExpensive.regionId} (infrastructure-side estimate)`
            : `cheapest region already within ${(savingsFraction * 100).toFixed(1)}% of the most expensive — no move worth the risk`,
          excludedRegions: rows.filter((r) => r.excluded).map((r) => ({ regionId: r.regionId, reason: r.excluded })),
        });
      }
    }

    strategies.sort((a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      b.savingsFraction - a.savingsFraction ||
      (a.estimatedCost ?? Infinity) - (b.estimatedCost ?? Infinity) ||
      String(a.strategy).localeCompare(String(b.strategy)) ||
      String(a.regionId ?? "").localeCompare(String(b.regionId ?? ""))
    );

    return { at: new Date(at).toISOString(), baseline, strategies, config: { offPeakDiscount: cfg.offPeakDiscount, minSavingsFraction: cfg.minSavingsFraction, maxDeferralMs: cfg.maxDeferralMs } };
  }

  return { predictCost, recommendStrategies, isUrgent, isPeak: (t, w, tz) => isPeak(t, w, tz), nextOffPeakStart: (t, w, tz) => nextOffPeakStart(t, w, tz) };
}
