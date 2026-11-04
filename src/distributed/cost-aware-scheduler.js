// Cost-aware scheduling (task 4.2.13).
//
// Extends the resource-aware scheduler (task 4.2.7, INJECTED — this module does
// not own or import it) with cost signals:
//
//   1. Cheaper-region preference — among the regions that can host a job within
//      its SLA, pick the cheapest one. Urgent jobs (or jobs whose deadline no
//      region can meet) prefer the FASTEST region instead: SLA beats cost.
//   2. Off-peak deferral — non-urgent, deferrable jobs submitted inside a peak
//      window are deferred to the next off-peak window of a cheap region when
//      the projected savings clear a threshold and the deferral fits inside the
//      job's deadline (if any) and a hard deferral cap. Urgent jobs are never
//      deferred.
//
// Injected base-scheduler contract (mirrors 4.2.7) — TWO shapes, both injected:
//
//   A. `bases` — one 4.2.7 ResourceScheduler PER REGION (the native composition):
//        { [regionId]: { submit(spec), dispatch() -> placements, release(workerId, jobId),
//                        registerWorker({ id, capacity }), jobSnapshot(id), snapshot() } }
//      The wrapper picks the region (cost + SLA + deferral) and submits the job
//      into that region's scheduler; the base does the packing within the region.
//      Jobs the base accepts but cannot place yet come back as decision
//      "queued"; drain() surfaces every placement (including jobs the base
//      placed for its own pending queue).
//
//   B. `base` — a single assign-oracle (custom packers / tests):
//        base.assign(job, { candidates }) -> { workerId, regionId } | workerId | null
//        candidates: workers in PREFERENCE ORDER (cheapest / fastest region first).
//      The wrapper passes one ordered candidate list per schedule() call, so the
//      base's first-feasible pick IS the cost-preferred pick. Any extra 4.2.7
//      methods (listWorkers, release, ...) are forwarded when present.
//
// Region signals (optional, injected): { getQueueDepth(regionId), getAvgRuntimeMs(regionId) }
// — wired to the worker plane / capacity analytics in production; default depth 0.
//
// Cost model (rates are CONFIG, never hardcoded):
//   cost = hourlyRate[region] * runtimeHours * multiplier + fixedPerJob[region]
//   multiplier = 1 inside the region's peak window, (1 - offPeakDiscount) otherwise
//   Region pricing comes from the regionPricing argument or the
//   COST_AWARE_REGION_PRICING env var (JSON). A region without pricing is a
//   construction error — silently inventing prices is not allowed.
//
// Peak windows (CONFIG, region-local time via timezoneOffsetMinutes):
//   [{ days: [0..6, 0=Sunday, omitted = every day], startHour, endHour }]
//   global default from COST_AWARE_CONFIG.peakWindows, overridable per region.
//
// schedule() is synchronous and pure (no timers); deferred jobs are held in
// memory and released by poll(now) from the caller's loop.
//
// Env config (all optional):
//   COST_AWARE_CONFIG          JSON — offPeakDiscount, maxDeferralMs,
//                              minSavingsFraction, deferPriorityThreshold,
//                              urgentMaxDelayMs, slaBufferMs, defaultRuntimeMs,
//                              maxDeferrals, peakWindows
//   COST_AWARE_REGION_PRICING  JSON — { [regionId]: { hourlyRate, fixedPerJob } }
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;

const DEFAULTS = Object.freeze({
  offPeakDiscount: 0.5,            // off-peak multiplier = 1 - 0.5
  maxDeferralMs: 12 * HOUR_MS,     // never defer a job further than this
  minSavingsFraction: 0.1,         // defer only when saving >= 10% of run-now cost
  deferPriorityThreshold: 60,      // priority >= threshold ⇒ urgent (never deferred)
  urgentMaxDelayMs: 30_000,        // urgent SLA: region queue delay must stay below this
  slaBufferMs: MINUTE_MS,          // safety margin between delay+runtime and the deadline
  defaultRuntimeMs: 5 * MINUTE_MS, // job.estimatedRuntimeMs fallback
  maxDeferrals: 1,                 // a job may be deferred at most this many times
  peakWindows: [],                 // no windows ⇒ every region is off-peak around the clock
});

export function createCostAwareScheduler({
  base = null,
  bases = null,
  regions = null,
  workers = null,
  regionPricing = null,
  regionSignals = null,
  clock = null,
  config = null,
} = {}) {
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error("[cost-aware-scheduler] `regions` must be a non-empty array of { id, ... } (task 4.2.1 region registry)");
  }
  const regionIds = regions.map((r) => {
    if (!r || typeof r.id !== "string" || !r.id) throw new Error("[cost-aware-scheduler] every region needs a string `id`");
    return r.id;
  });
  if (new Set(regionIds).size !== regionIds.length) {
    throw new Error("[cost-aware-scheduler] duplicate region ids: " + regionIds.join(", "));
  }

  // Two injected base shapes (both are "the 4.2.7 scheduler", injected):
  //   • `bases` — one RESOURCE-SCHEDULER PER REGION (the native 4.2.7
  //     ResourceScheduler composition): { [regionId]: { submit, dispatch, release, ... } }.
  //     The wrapper picks the region (cost + SLA + deferral); the base packs
  //     within it via submit() + dispatch().
  //   • `base` — a single assign-oracle: base.assign(job, { candidates }) ->
  //     { workerId } | workerId | null, honoring candidate preference order.
  let basesByRegion = null;
  if (bases) {
    const entries = bases instanceof Map ? Array.from(bases.entries()) : Object.entries(bases);
    basesByRegion = new Map(entries);
    const unknown = Array.from(basesByRegion.keys()).filter((id) => !regionIds.includes(id));
    if (unknown.length) {
      throw new Error(`[cost-aware-scheduler] bases has schedulers for unknown regions: ${unknown.join(", ")}`);
    }
    for (const [id, b] of basesByRegion) {
      if (!b || typeof b.submit !== "function" || typeof b.dispatch !== "function") {
        throw new Error(`[cost-aware-scheduler] bases["${id}"] does not look like a 4.2.7 ResourceScheduler (needs submit + dispatch)`);
      }
    }
  }
  const packerMode = !!basesByRegion && basesByRegion.size > 0;
  if (!packerMode && (!base || typeof base.assign !== "function")) {
    throw new Error(
      "[cost-aware-scheduler] an injected base scheduler (task 4.2.7) is required: pass `bases` (one ResourceScheduler per region) or `base` with an assign(job, { candidates }) method"
    );
  }

  const cfg = mergeConfig([DEFAULTS, readEnvConfig(), config]);

  const pricing = validatePricing(regionIds, [readEnvPricing(), regionPricing]);

  const regionById = new Map(regions.map((r) => [r.id, r]));
  const windowsByRegion = new Map(
    regions.map((r) => [
      r.id,
      validateWindows(Array.isArray(r.peakWindows) ? r.peakWindows : cfg.peakWindows, r.id),
    ])
  );

  const now = () => {
    if (typeof clock === "function") return clock();
    if (clock && typeof clock.now === "function") return clock.now();
    return Date.now();
  };

  // worker inventory: injected list first, then the base's own list if exposed
  let workerList = Array.isArray(workers) ? workers.slice() : [];
  if (workerList.length === 0 && typeof base.listWorkers === "function") {
    const fromBase = base.listWorkers();
    if (Array.isArray(fromBase)) workerList = fromBase.slice();
  }
  const workerById = new Map();
  for (const w of workerList) {
    if (w && typeof w.workerId === "string") workerById.set(w.workerId, w);
  }

  const signals = regionSignals || {};
  const getQueueDepth = (regionId) => {
    const v = typeof signals.getQueueDepth === "function" ? signals.getQueueDepth(regionId) : 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const getAvgRuntimeMs = (regionId) => {
    const v = typeof signals.getAvgRuntimeMs === "function" ? signals.getAvgRuntimeMs(regionId) : cfg.defaultRuntimeMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : cfg.defaultRuntimeMs;
  };

  const deferred = new Map(); // jobId -> { job, startAt, deferredAt, count }
  const deferralCounts = new Map(); // jobId -> completed deferrals
  const ledger = []; // completed-job cost records (feed for capacity analytics 4.2.11)
  const sidePlacements = []; // placements a dispatch() pass made for OTHER pending jobs (surfaced by drain())

  const runtimeMsOf = (job) => {
    const n = Number(job?.estimatedRuntimeMs);
    return Number.isFinite(n) && n > 0 ? n : cfg.defaultRuntimeMs;
  };

  // ---- region-local wall clock helpers (offset in minutes, UTC-based math) ----

  function localParts(epochMs, tzOffsetMinutes) {
    const d = new Date(epochMs + tzOffsetMinutes * MINUTE_MS);
    return {
      hour: d.getUTCHours(),
      day: d.getUTCDay(), // 0=Sunday .. 6=Saturday
    };
  }

  function inPeak(epochMs, regionId) {
    const windows = windowsByRegion.get(regionId) || [];
    if (windows.length === 0) return false;
    const { hour, day } = localParts(epochMs, tzOf(regionId));
    for (const w of windows) {
      const days = Array.isArray(w.days) && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(day)) continue;
      if (hour >= w.startHour && hour < w.endHour) return true;
    }
    return false;
  }

  function tzOf(regionId) {
    const n = Number(regionById.get(regionId)?.timezoneOffsetMinutes);
    return Number.isFinite(n) ? n : 0;
  }

  // first moment at/after `from` when regionId is outside every peak window.
  // Windows are hour-aligned, so membership is constant within each hour.
  function nextOffPeakStart(regionId, from = now()) {
    if (!inPeak(from, regionId)) return from;
    let t = Math.floor(from / HOUR_MS) * HOUR_MS; // current local hour boundary
    for (let i = 0; i <= 8 * 24; i++) {
      if (!inPeak(t, regionId)) return Math.max(t, from);
      t += HOUR_MS;
    }
    throw new Error(`[cost-aware-scheduler] region ${regionId} has no off-peak hour within 8 days — check peakWindows`);
  }

  // ---- cost math ----

  function multiplierAt(epochMs, regionId) {
    return inPeak(epochMs, regionId) ? 1 : 1 - cfg.offPeakDiscount;
  }

  function estimateCostRaw(job, regionId, at) {
    const p = pricing.get(regionId);
    if (!p) throw new Error(`[cost-aware-scheduler] no pricing configured for region "${regionId}"`);
    const hours = runtimeMsOf(job) / HOUR_MS;
    return p.hourlyRate * hours * multiplierAt(at, regionId) + (p.fixedPerJob || 0);
  }

  function regionDelayMs(regionId) {
    const depth = getQueueDepth(regionId);
    if (depth <= 0) return 0;
    let count = 0;
    for (const w of workerList) if (w && w.regionId === regionId) count++;
    return (depth * getAvgRuntimeMs(regionId)) / Math.max(1, count);
  }

  // ---- SLA evaluation + region ordering ----

  function workersOf(regionId) {
    return workerList.filter((w) => w && w.regionId === regionId);
  }

  // SLA semantics per region:
  //   deadline known        → feasible iff delay + runtime + buffer <= timeLeft
  //   urgent, no deadline   → feasible iff delay <= urgentMaxDelayMs
  //   otherwise (slack job) → every region is feasible (SLA allows waiting)
  function evaluateRegions(job, at) {
    const deadline = Number(job?.deadlineAt);
    const hasDeadline = Number.isFinite(deadline) && deadline > at;
    const timeLeft = hasDeadline ? deadline - at : null;
    const urgent = isUrgent(job);
    const runtime = runtimeMsOf(job);
    const rows = [];
    for (const regionId of regionIds) {
      const delay = regionDelayMs(regionId);
      const turnaround = delay + runtime;
      let feasible;
      if (hasDeadline) feasible = delay + runtime + cfg.slaBufferMs <= timeLeft;
      else if (urgent) feasible = delay <= cfg.urgentMaxDelayMs;
      else feasible = true;
      rows.push({ regionId, delay, turnaround, runtime, feasible, hasDeadline, urgent });
    }
    return { rows, hasDeadline, urgent, timeLeft };
  }

  function isUrgent(job) {
    if (job?.urgency === "urgent") return true;
    if (job?.urgency === "batch" || job?.urgency === "low") return false;
    const p = Number(job?.priority);
    return Number.isFinite(p) ? p >= cfg.deferPriorityThreshold : false;
  }

  function isDeferrable(job) {
    if (job?.deferrable === false) return false;
    if (isUrgent(job)) return false; // hard invariant: urgent jobs never deferred
    return true;
  }

  // cheapest first among SLA-feasible rows; when NO region is feasible, fall
  // back to fastest-first (an already-late job is run to minimize damage —
  // rejection is a resource outcome owned by the base, never an SLA outcome).
  function orderRows(rows, at) {
    const feasible = rows.filter((r) => r.feasible);
    if (feasible.length > 0) {
      const runtime = rows[0].runtime;
      const probe = { estimatedRuntimeMs: runtime };
      const ordered = feasible
        .slice()
        .sort(
          (a, b) =>
            estimateCostRaw(probe, a.regionId, at) - estimateCostRaw(probe, b.regionId, at) ||
            a.turnaround - b.turnaround ||
            a.regionId.localeCompare(b.regionId)
        );
      return { ordered, slaMet: true };
    }
    const ordered = rows
      .slice()
      .sort((a, b) => a.turnaround - b.turnaround || a.regionId.localeCompare(b.regionId));
    return { ordered, slaMet: false };
  }

  function buildCandidates(orderedRows) {
    const out = [];
    for (const row of orderedRows) for (const w of workersOf(row.regionId)) out.push(w);
    return out;
  }

  function normalizeAssignment(res) {
    if (!res) return null;
    if (typeof res === "string") return { workerId: res };
    if (typeof res === "object") {
      const workerId = res.workerId ?? res.worker ?? res.id ?? null;
      return workerId ? { ...res, workerId } : null;
    }
    return null;
  }

  // ---- off-peak deferral ----

  // Best off-peak plan among ALL regions: cheapest off-peak cost whose startAt
  // fits inside maxDeferralMs and (when the job has one) its deadline. Deferral
  // only pays when the run-now region is at peak — otherwise there is nothing
  // to wait for.
  function evaluateDeferral(job, { at, regionId, costNow, hasDeadline, timeLeft }) {
    if (!isDeferrable(job)) return null;
    if (!inPeak(at, regionId)) return null; // chosen region already off-peak
    const runtime = runtimeMsOf(job);
    let best = null;
    for (const r of regionIds) {
      const startAt = nextOffPeakStart(r, at);
      if (startAt <= at) continue; // region already off-peak → no waiting gain
      if (startAt - at > cfg.maxDeferralMs) continue;
      if (hasDeadline && startAt + runtime + cfg.slaBufferMs > at + timeLeft) continue;
      const cost = estimateCostRaw(job, r, startAt);
      if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && r.localeCompare(best.regionId) < 0)) {
        best = { regionId: r, startAt, cost };
      }
    }
    if (!best) return null;
    const savings = 1 - best.cost / costNow;
    if (savings < cfg.minSavingsFraction) return null;
    return best;
  }

  // ---- public surface ----

  function schedule(job) {
    if (!job || typeof job !== "object") throw new Error("[cost-aware-scheduler] schedule(job) needs a job object");
    const at = now();
    const key = job.jobId ?? job.id ?? null;
    const affinity = Array.isArray(job.regionAffinity) && job.regionAffinity.length ? job.regionAffinity : null;

    let { rows, hasDeadline, urgent, timeLeft } = evaluateRegions(job, at);
    if (affinity) {
      const allowed = new Set(affinity);
      rows = rows.filter((r) => allowed.has(r.regionId));
      if (rows.length === 0) return { decision: "reject", reason: "region_affinity_unsatisfiable", at };
    }
    const { ordered, slaMet } = orderRows(rows, at);
    const chosenRegionId = ordered[0].regionId;
    const costNow = estimateCostRaw(job, chosenRegionId, at);

    // deferral is evaluated BEFORE the base reservation: a deferred job must
    // not pin worker resources while it waits for its window.
    const deferPlan = evaluateDeferral(job, { at, regionId: chosenRegionId, costNow, hasDeadline, timeLeft });
    if (deferPlan) {
      // a job currently sitting in the defer queue has already spent one slot
      const spent = (deferralCounts.get(key) || 0) + (deferred.has(key) ? 1 : 0);
      if (spent < cfg.maxDeferrals) {
        deferred.set(key, { job, startAt: deferPlan.startAt, deferredAt: at, count: spent });
        return {
          decision: "defer",
          jobId: key,
          startAt: deferPlan.startAt,
          regionId: deferPlan.regionId,
          costNow: round(costNow),
          costAtStart: round(deferPlan.cost),
          savings: round(1 - deferPlan.cost / costNow),
          reason: "off_peak_deferral",
          at,
        };
      }
    }

    // run path — the region is chosen here (cost + SLA + deferral); the
    // injected base packs the job WITHIN it. Two base shapes:
    //   • packer mode (`bases`): 4.2.7 ResourceScheduler per region —
    //     submit() + dispatch(); strict-mode head-of-line semantics stay in
    //     the base, placements for OTHER pending jobs surface via drain().
    //   • oracle mode (`base`): base.assign(job, { candidates }) with the
    //     candidates already in cost-preference order.
    let placed = null;
    if (packerMode) {
      const res = runOnRegionBase(basesByRegion.get(chosenRegionId), job, key, chosenRegionId);
      if (res.rejectReason) return { decision: "reject", reason: res.rejectReason, detail: res.detail, at };
      if (res.queued) {
        return {
          decision: "queued",
          jobId: key,
          regionId: chosenRegionId,
          cost: round(costNow),
          peak: inPeak(at, chosenRegionId),
          slaMet,
          reason: "awaiting_region_capacity",
          at,
        };
      }
      placed = { workerId: res.workerId, regionId: chosenRegionId };
    } else {
      const candidates = buildCandidates(ordered);
      const assignment = normalizeAssignment(base.assign(job, { candidates, orderedRegions: ordered.map((r) => r.regionId) }));
      if (!assignment) return { decision: "reject", reason: "no_worker_has_capacity", at };
      const regionId = workerById.get(assignment.workerId)?.regionId || assignment.regionId || chosenRegionId;
      if (affinity && !affinity.includes(regionId)) {
        return { decision: "reject", reason: "base_assigned_outside_region_affinity", workerId: assignment.workerId, at };
      }
      placed = { workerId: assignment.workerId, regionId };
    }

    return {
      decision: "run",
      workerId: placed.workerId,
      regionId: placed.regionId,
      cost: round(estimateCostRaw(job, placed.regionId, at)),
      peak: inPeak(at, placed.regionId),
      slaMet,
      reason:
        deferPlan
          ? "max_deferrals_reached_ran_at_peak"
          : !slaMet
            ? "no_region_meets_sla_fastest_chosen"
            : urgent
              ? "urgent_region_selected"
              : hasDeadline
                ? "cheapest_sla_feasible"
                : "cheapest_region",
      at,
    };
  }

  // submit + dispatch one job onto a region's 4.2.7 ResourceScheduler.
  // Returns { workerId } | { queued: true } | { rejectReason, detail? }.
  function runOnRegionBase(rb, job, jobId, regionId) {
    if (!rb) return { rejectReason: "region_has_no_scheduler" };
    ensureRegionWorkers(rb, regionId);
    const spec = {
      id: String(jobId),
      priority: Number.isFinite(Number(job.priority)) ? Number(job.priority) : 0,
      resources: packerResources(job),
    };
    try {
      rb.submit(spec);
    } catch (e) {
      if (e?.code === "UNFITTABLE") return { rejectReason: "unfittable_in_region", detail: String(e.message).slice(0, 200) };
      if (e?.code === "DUPLICATE") {
        // resubmission while the base still knows the job — reuse its state
        try {
          const st = rb.jobSnapshot(spec.id);
          if (st.state === "running" && st.worker) return { workerId: st.worker };
          return { queued: true };
        } catch {
          return { rejectReason: "duplicate_submit_unknown", detail: String(e?.message || e).slice(0, 200) };
        }
      }
      return { rejectReason: "region_submit_failed", detail: String(e?.message || e).slice(0, 200) };
    }
    const placements = rb.dispatch() || [];
    for (const p of placements) {
      if (p.jobId !== spec.id) sidePlacements.push({ jobId: p.jobId, regionId, workerId: p.workerId });
    }
    const mine = placements.find((p) => p.jobId === spec.id);
    if (mine) return { workerId: mine.workerId };
    try {
      const st = rb.jobSnapshot(spec.id);
      if (st.state === "running" && st.worker) return { workerId: st.worker };
      return { queued: true }; // accepted into the region, awaiting capacity
    } catch {
      return { rejectReason: "region_submit_lost" };
    }
  }

  // jobs with no declared needs default to one browser slot (4.2.7 requires
  // at least one declared resource)
  function packerResources(job) {
    const mem = job.memoryMb ?? job.memory;
    const slots = job.browserSlots ?? job.browserSlots;
    const hasMem = Number.isFinite(Number(mem));
    const hasSlots = Number.isFinite(Number(slots));
    if (!hasMem && !hasSlots) return { memoryMb: 0, browserSlots: 1 };
    return {
      memoryMb: hasMem ? Math.max(0, Number(mem)) : 0,
      browserSlots: hasSlots ? Math.max(0, Math.floor(Number(slots))) : 0,
    };
  }

  // register this region's declared workers on its base the first time the
  // base is used (idempotent — already-registered workers are skipped)
  const basesWarmed = new Set();
  function ensureRegionWorkers(rb, regionId) {
    if (basesWarmed.has(regionId)) return;
    basesWarmed.add(regionId);
    let registered = new Set();
    try {
      const snap = typeof rb.snapshot === "function" ? rb.snapshot() : null;
      registered = new Set((snap?.workers || []).map((w) => w.id));
    } catch {
      /* base without snapshot() — attempt registerWorker blindly */
    }
    for (const w of workersOf(regionId)) {
      if (registered.has(w.workerId)) continue;
      try {
        rb.registerWorker({
          id: w.workerId,
          capacity: { memoryMb: w.memoryMb ?? w.memoryTotal ?? 0, browserSlots: w.browserSlots ?? w.browserSlotsTotal ?? 0 },
        });
      } catch {
        /* duplicate-registration race — the base is the source of truth */
      }
    }
  }

  // release every deferred job whose window has arrived and re-schedule it.
  // The target region is off-peak by construction, so the fresh decision is
  // "run" unless capacity vanished in the meantime (then: reject — surfaced).
  function poll(nowArg = now()) {
    const t = Number.isFinite(Number(nowArg)) ? Number(nowArg) : now();
    const due = [];
    for (const [key, d] of deferred) if (d.startAt <= t) due.push([key, d]);
    const out = [];
    for (const [key, d] of due) {
      deferred.delete(key);
      deferralCounts.set(key, (deferralCounts.get(key) || 0) + 1);
      out.push({ jobId: key, decision: schedule(d.job) });
    }
    return out;
  }

  function getDeferred() {
    return Array.from(deferred.entries()).map(([jobId, d]) => ({
      jobId,
      startAt: d.startAt,
      deferredAt: d.deferredAt,
      deferralCount: d.count,
    }));
  }

  function cancelDeferred(jobId) {
    return deferred.delete(jobId);
  }

  // ---- ledger (per-job compute accounting feed; 4.2.11/4.2.12 aggregates) ----

  function onJobComplete(jobId, { runtimeMs, regionId, startedAt = null } = {}) {
    if (regionId == null || !pricing.has(regionId)) {
      throw new Error(`[cost-aware-scheduler] onJobComplete: unknown region "${regionId}"`);
    }
    const rt = Number(runtimeMs);
    if (!Number.isFinite(rt) || rt < 0) {
      throw new Error("[cost-aware-scheduler] onJobComplete: runtimeMs must be a non-negative number");
    }
    const started = Number.isFinite(Number(startedAt)) ? Number(startedAt) : now();
    const cost = estimateCostRaw({ estimatedRuntimeMs: rt }, regionId, started);
    const record = { jobId, regionId, cost: round(cost), runtimeMs: rt, peak: inPeak(started, regionId), at: now() };
    ledger.push(record);
    // free the base's resources (4.2.7 contract)
    if (packerMode) {
      const rb = basesByRegion.get(regionId);
      if (rb && typeof rb.jobSnapshot === "function" && typeof rb.release === "function") {
        try {
          const st = rb.jobSnapshot(String(jobId));
          if (st.state === "running" && st.worker) rb.release(st.worker, String(jobId));
        } catch {
          /* job already released or unknown to the base — best effort */
        }
      }
    } else if (typeof base.release === "function") {
      try {
        base.release(null, { jobId, regionId, runtimeMs: rt });
      } catch {
        /* base without per-job release state — best effort */
      }
    }
    return record;
  }

  // one dispatch pass over every region base — surfaces placements for jobs
  // that were "queued" once capacity freed (plus any side placements a
  // schedule() pass produced for other pending jobs). Oracle mode: no-op.
  // Returns [{ jobId, regionId, workerId }].
  function drain() {
    const out = sidePlacements.splice(0);
    if (!packerMode) return out;
    for (const [regionId, rb] of basesByRegion) {
      let placements = [];
      try {
        placements = rb.dispatch() || [];
      } catch {
        continue;
      }
      for (const p of placements) out.push({ jobId: p.jobId, regionId, workerId: p.workerId });
    }
    return out;
  }

  function getCostLedger() {
    return ledger.slice();
  }

  function getSpend(filter = {}) {
    let sum = 0;
    let count = 0;
    for (const r of ledger) {
      if (filter.regionId && r.regionId !== filter.regionId) continue;
      if (filter.peak !== undefined && r.peak !== filter.peak) continue;
      sum += r.cost;
      count++;
    }
    return { cost: round(sum), jobs: count };
  }

  // ---- diagnostics surface ----

  function describeRegionState(job = null, at = now()) {
    const rt = job ? runtimeMsOf(job) : cfg.defaultRuntimeMs;
    const probe = { estimatedRuntimeMs: rt };
    return regionIds.map((id) => {
      const offAt = nextOffPeakStart(id, at);
      return {
        regionId: id,
        delayMs: regionDelayMs(id),
        peak: inPeak(at, id),
        nextOffPeakStart: offAt,
        costNow: round(estimateCostRaw(probe, id, at)),
        costOffPeak: round(estimateCostRaw(probe, id, offAt)),
      };
    });
  }

  function stats() {
    return {
      mode: packerMode ? "region-packers" : "assign-oracle",
      regions: regionIds.length,
      workers: workerList.length,
      deferred: deferred.size,
      deferralCounts: Object.fromEntries(deferralCounts),
      ledgerEntries: ledger.length,
      config: { ...cfg, peakWindows: cfg.peakWindows.length },
    };
  }

  return {
    schedule,
    poll,
    drain,
    getDeferred,
    cancelDeferred,
    estimateCost: (job, regionId, at = now()) => round(estimateCostRaw(job, regionId, at)),
    nextOffPeakStart,
    onJobComplete,
    getCostLedger,
    getSpend,
    describeRegionState,
    stats,
    base, // forwarded for integrators that drive the oracle base directly
    bases: basesByRegion ? Object.fromEntries(basesByRegion) : null, // packer mode: region -> 4.2.7 scheduler
  };
}

// ---- env config (all optional; JSON parse errors are construction errors) ----

function readEnvConfig() {
  const raw = process.env.COST_AWARE_CONFIG;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cost-aware-scheduler] COST_AWARE_CONFIG is not valid JSON: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[cost-aware-scheduler] COST_AWARE_CONFIG must be a JSON object");
  }
  return parsed;
}

function readEnvPricing() {
  const raw = process.env.COST_AWARE_REGION_PRICING;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cost-aware-scheduler] COST_AWARE_REGION_PRICING is not valid JSON: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[cost-aware-scheduler] COST_AWARE_REGION_PRICING must be a JSON object of { regionId: { hourlyRate, fixedPerJob } }");
  }
  return parsed;
}

// ---- helpers ----

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function mergeConfig(sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
  }
  const num = (k, min, max) => {
    const v = Number(out[k]);
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new Error(`[cost-aware-scheduler] config.${k} must be a number in [${min}, ${max}] (got ${out[k]})`);
    }
    out[k] = v;
  };
  num("offPeakDiscount", 0, 1);
  num("maxDeferralMs", 0, 365 * 24 * HOUR_MS);
  num("minSavingsFraction", 0, 1);
  num("deferPriorityThreshold", 0, 100);
  num("urgentMaxDelayMs", 0, 24 * HOUR_MS);
  num("slaBufferMs", 0, 24 * HOUR_MS);
  num("defaultRuntimeMs", 1, 365 * 24 * HOUR_MS);
  const md = Number(out.maxDeferrals);
  if (!Number.isInteger(md) || md < 0 || md > 100) {
    throw new Error("[cost-aware-scheduler] config.maxDeferrals must be an integer in [0, 100]");
  }
  out.maxDeferrals = md;
  if (!Array.isArray(out.peakWindows)) throw new Error("[cost-aware-scheduler] config.peakWindows must be an array");
  return out;
}

function validatePricing(regionIds, sources) {
  const merged = new Map();
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [regionId, p] of Object.entries(src)) {
      const hourlyRate = Number(p?.hourlyRate);
      const fixedPerJob = Number(p?.fixedPerJob ?? 0);
      if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
        throw new Error(`[cost-aware-scheduler] pricing.hourlyRate for region "${regionId}" must be a positive number`);
      }
      if (!Number.isFinite(fixedPerJob) || fixedPerJob < 0) {
        throw new Error(`[cost-aware-scheduler] pricing.fixedPerJob for region "${regionId}" must be a non-negative number`);
      }
      merged.set(regionId, { hourlyRate, fixedPerJob });
    }
  }
  const missing = regionIds.filter((id) => !merged.has(id));
  if (missing.length) {
    throw new Error(
      `[cost-aware-scheduler] missing region pricing for: ${missing.join(", ")} — pass regionPricing or set COST_AWARE_REGION_PRICING (JSON)`
    );
  }
  return merged;
}

function validateWindows(windows, regionId) {
  if (!Array.isArray(windows)) throw new Error(`[cost-aware-scheduler] peakWindows for region "${regionId}" must be an array`);
  return windows.map((w) => {
    const startHour = Number(w?.startHour);
    const endHour = Number(w?.endHour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
      throw new Error(`[cost-aware-scheduler] peakWindows.startHour for region "${regionId}" must be an integer 0..23`);
    }
    if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
      throw new Error(`[cost-aware-scheduler] peakWindows.endHour for region "${regionId}" must be an integer 1..24`);
    }
    if (endHour <= startHour) {
      throw new Error(`[cost-aware-scheduler] peakWindows for region "${regionId}" must satisfy endHour > startHour (windows may not cross midnight)`);
    }
    const days = w.days == null ? null : w.days.map(Number);
    if (days) {
      for (const d of days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          throw new Error(`[cost-aware-scheduler] peakWindows.days for region "${regionId}" must contain integers 0..6 (0=Sunday)`);
        }
      }
    }
    return days ? { days, startHour, endHour } : { startHour, endHour };
  });
}
