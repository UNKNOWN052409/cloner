// Scaling policy + decision engine (task 4.2.4): the PURE, deterministic core
// of worker autoscaling. No I/O, no clocks of its own — `now` is always
// injected, so simulations can replay whole days of load in microseconds.
//
// What the engine decides on (every tick = one computeScaleDecision call):
//   • queue depth per worker   — waiting jobs / running workers above
//                                scaleUp.queueDepthPerWorker → up signal
//   • queue age                — oldest WAITING job older than
//                                scaleUp.oldestJobAgeMs (with depth > 0) →
//                                up signal (catches slow consumers even when
//                                depth-per-worker looks acceptable)
//   • worker utilization       — busy slots / total slots at or above
//                                scaleUp.utilization → up signal
//   • worker utilization/depth low — busy ratio ≤ scaleDown.utilization AND
//                                depth ≤ scaleDown.queueDepth → down signal
//   • fully idle pool          — 0 waiting AND 0 active for idle.idleAfterMs →
//                                down signal toward minWorkers
//
// Oscillation is prevented by FOUR independent, composable mechanisms:
//   1. SUSTAIN WINDOWS — a signal must persist continuously for
//      scaleUp.sustainMs / scaleDown.sustainMs before it can act; the timer
//      resets whenever the signal disappears (debounce).
//   2. HYSTERESIS DEADBAND — down thresholds must sit strictly BELOW the up
//      thresholds (validated invariant), so mid-range load acts on neither.
//   3. COOLDOWNS — after ANY applied action the next action needs
//      scaleUp.cooldownMs (for up) / scaleDown.cooldownMs (for down) of quiet.
//      Cooldowns do not reset the sustain timers: if the signal is still
//      present when the cooldown expires, the pending action fires.
//   4. STEP LIMITS — at most scaleUp.step / scaleDown.step workers change per
//      action, so one evaluation can never slam the pool.
// When up AND down are somehow sustained together (should be impossible with
// a valid deadband) the engine HOLDS with "conflicting-signals" — never both.
//
// Caps: desired is clamped to [minWorkers, maxWorkers] (per-pool) and to
// maxWorkersPerRegion minus the region-wide count (metrics.regionalWorkerCount
// — the count across ALL pools in the region, supplied by the metrics source;
// single-pool deployments pass their own size).
//
// Contract (pure):
//   state   = initialPolicyState()                       → opaque, caller-owned
//   result  = computeScaleDecision({ policy, metrics, state, now })
//   state   = result.nextState                           → feed into next call
// The caller applies result.action (autoscaler.js) and stores nextState.
// A result with action "scale-up"/"scale-down" and delta > 0 means ACT; the
// caller updates nextState.lastScaleAt/lastAction (done here ONLY when the
// caller reports applied — see commitAppliedAction()).
// ── defaults (also the env fallbacks in parsePolicyFromEnv) ────────────────
export function defaultScalingPolicy() {
  return {
    minWorkers: 1,
    maxWorkers: 8,
    maxWorkersPerRegion: null, // null = unlimited
    evaluateIntervalMs: 5000,
    scaleUp: {
      queueDepthPerWorker: 4, // waiting jobs per worker that trigger scale-up
      oldestJobAgeMs: 30_000, // oldest waiting job age that triggers scale-up
      utilization: 0.8, // busy-slot ratio that triggers scale-up
      sustainMs: 10_000, // signal must persist this long, continuously
      cooldownMs: 30_000, // quiet gap required after ANY action before an up
      step: 2, // max workers added per action
    },
    scaleDown: {
      utilization: 0.25, // must stay < scaleUp.utilization (hysteresis)
      queueDepth: 0, // must stay < scaleUp.queueDepthPerWorker (hysteresis)
      sustainMs: 30_000,
      cooldownMs: 60_000, // quiet gap required after ANY action before a down
      step: 1, // max workers removed per action (drain one at a time)
    },
    idle: {
      idleAfterMs: 60_000, // 0 waiting + 0 active for this long → drain toward min
    },
  };
}

// opaque initial decision state — callers keep this and feed nextState back
export function initialPolicyState() {
  return {
    lastScaleAt: -Infinity, // ms timestamp of the last APPLIED action
    lastAction: null, // "scale-up" | "scale-down" | null
    upSignalSince: null, // first tick the up signal appeared continuously
    downSignalSince: null,
    idleSince: null, // first tick the pool was fully idle
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// normalize one metrics snapshot; unknown utilization (null/NaN) is skipped by
// the signal logic rather than read as 0 — "not measured" is not "idle"
function normalizeMetrics(metrics = {}) {
  const toCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const utilRaw = metrics.workerUtilization == null ? null : Number(metrics.workerUtilization);
  return {
    workerCount: toCount(metrics.workerCount),
    queueDepth: toCount(metrics.queueDepth),
    oldestJobAgeMs: Math.max(0, Number(metrics.oldestJobAgeMs) || 0),
    activeJobs: toCount(metrics.activeJobs),
    // null/undefined/NaN stay null = "not measured" — Number(null) is 0, which
    // would otherwise masquerade as a fully idle pool
    workerUtilization: utilRaw != null && Number.isFinite(utilRaw) && utilRaw >= 0 ? Math.min(1, utilRaw) : null,
    regionalWorkerCount: Math.max(toCount(metrics.workerCount), toCount(metrics.regionalWorkerCount)),
  };
}

/**
 * One deterministic evaluation of the policy against a metrics snapshot.
 * @param {object} opts
 * @param {object} opts.policy     validated scaling policy (validateScalingPolicy)
 * @param {object} opts.metrics    { queueDepth, oldestJobAgeMs, workerUtilization|null,
 *                                   workerCount, activeJobs, regionalWorkerCount }
 * @param {object} opts.state      previous nextState (initialPolicyState() first call)
 * @param {number} opts.now        injected clock ms — the ONLY time source
 * @returns {{ action: "scale-up"|"scale-down"|"hold", delta: number, desired: number,
 *             reasons: string[], signals: { up: string[], down: string[] },
 *             sustained: { up: boolean, down: boolean, idle: boolean },
 *             details: object, nextState: object }}
 */
export function computeScaleDecision({ policy: p, metrics, state, now }) {
  const m = normalizeMetrics(metrics);
  const prev = { ...initialPolicyState(), ...(state || {}) };
  const next = { ...prev };

  const depthPerWorker = m.workerCount > 0 ? m.queueDepth / m.workerCount : m.queueDepth;
  const atMax = m.workerCount >= p.maxWorkers;
  const regionalHeadroom = p.maxWorkersPerRegion == null
    ? Infinity
    : Math.max(0, p.maxWorkersPerRegion - m.regionalWorkerCount);

  // ── raw signals (present/absent on THIS tick) ─────────────────────────────
  const upSignals = [];
  if (depthPerWorker >= p.scaleUp.queueDepthPerWorker) upSignals.push("queue-depth");
  if (m.queueDepth > 0 && m.oldestJobAgeMs >= p.scaleUp.oldestJobAgeMs) upSignals.push("queue-age");
  if (m.workerUtilization != null && m.workerUtilization >= p.scaleUp.utilization) upSignals.push("worker-utilization");
  if (m.queueDepth > 0 && m.workerCount === 0) upSignals.push("no-workers");

  const downSignals = [];
  if (m.workerUtilization != null
    && m.workerUtilization <= p.scaleDown.utilization
    && m.queueDepth <= p.scaleDown.queueDepth) downSignals.push("worker-utilization");

  // idle: nothing waiting, nothing running, and the pool is above min —
  // track with its own (longer) window so an idle drain is deliberate
  const idleNow = m.queueDepth === 0 && m.activeJobs === 0 && m.workerCount > p.minWorkers;
  next.idleSince = idleNow ? (prev.idleSince ?? now) : null;
  const idleSustained = idleNow && now - next.idleSince >= p.idle.idleAfterMs;
  if (idleSustained) downSignals.push("idle");

  // ── sustain windows (continuous-presence debounce) ────────────────────────
  next.upSignalSince = upSignals.length ? (prev.upSignalSince ?? now) : null;
  next.downSignalSince = downSignals.length ? (prev.downSignalSince ?? now) : null;
  const upSustained = upSignals.length > 0 && now - next.upSignalSince >= p.scaleUp.sustainMs;
  const downSustained = downSignals.length > 0 && now - next.downSignalSince >= p.scaleDown.sustainMs;

  // ── cooldowns: after ANY applied action, the next action of a given
  //    direction waits for that direction's cooldownMs ──────────────────────
  const upCooldownRemaining = Math.max(0, p.scaleUp.cooldownMs - (now - prev.lastScaleAt));
  const downCooldownRemaining = Math.max(0, p.scaleDown.cooldownMs - (now - prev.lastScaleAt));

  const hold = (gate, extra = {}) => ({
    action: "hold",
    delta: 0,
    desired: m.workerCount,
    reasons: [...upSignals, ...downSignals, gate],
    signals: { up: [...upSignals], down: [...downSignals] },
    sustained: { up: upSustained, down: downSustained, idle: idleSustained },
    details: {
      depthPerWorker,
      workerCount: m.workerCount,
      queueDepth: m.queueDepth,
      utilization: m.workerUtilization,
      poolHeadroom: Math.max(0, p.maxWorkers - m.workerCount),
      regionalHeadroom: regionalHeadroom === Infinity ? null : regionalHeadroom,
      cooldownRemainingMs: { up: upCooldownRemaining, down: downCooldownRemaining },
      ...extra,
    },
    nextState: next,
  });

  // conflicting sustained signals → do nothing (never flip-flop in one tick)
  if (upSustained && downSustained) return hold("conflicting-signals");

  // ── scale-up branch ───────────────────────────────────────────────────────
  if (upSustained) {
    if (atMax) return hold("pool-max");
    if (regionalHeadroom <= 0) return hold("region-cap");
    // target: enough workers that each has ≤ queueDepthPerWorker waiting;
    // age/no-worker signals always add at least one worker
    const targetFromDepth = m.queueDepth > 0 ? Math.ceil(m.queueDepth / p.scaleUp.queueDepthPerWorker) : 0;
    let desired = Math.max(targetFromDepth, m.workerCount + 1);
    desired = clamp(desired, p.minWorkers, p.maxWorkers);
    desired = Math.min(desired, m.workerCount + regionalHeadroom);
    const delta = clamp(Math.min(desired - m.workerCount, p.scaleUp.step), 0, p.maxWorkers);
    if (delta <= 0) return hold("pool-max");
    if (upCooldownRemaining > 0) return hold("scale-up-cooldown", { pendingDelta: delta, pendingDesired: desired });
    return {
      action: "scale-up",
      delta,
      desired: m.workerCount + delta,
      reasons: [...upSignals],
      signals: { up: [...upSignals], down: [...downSignals] },
      sustained: { up: true, down: downSustained, idle: idleSustained },
      details: {
        depthPerWorker,
        targetDesired: desired,
        workerCount: m.workerCount,
        queueDepth: m.queueDepth,
        utilization: m.workerUtilization,
        poolHeadroom: Math.max(0, p.maxWorkers - m.workerCount),
        regionalHeadroom: regionalHeadroom === Infinity ? null : regionalHeadroom,
        cooldownRemainingMs: { up: 0, down: downCooldownRemaining },
      },
      nextState: next,
    };
  }

  // ── scale-down branch ─────────────────────────────────────────────────────
  if (downSustained) {
    const delta = clamp(Math.min(m.workerCount - p.minWorkers, p.scaleDown.step), 0, p.scaleDown.step);
    if (delta <= 0) return hold("at-min");
    if (downCooldownRemaining > 0) return hold("scale-down-cooldown", { pendingDelta: delta });
    return {
      action: "scale-down",
      delta,
      desired: m.workerCount - delta,
      reasons: [...downSignals],
      signals: { up: [...upSignals], down: [...downSignals] },
      sustained: { up: upSustained, down: true, idle: idleSustained },
      details: {
        depthPerWorker,
        workerCount: m.workerCount,
        queueDepth: m.queueDepth,
        utilization: m.workerUtilization,
        idleForMs: idleSustained ? now - next.idleSince : null,
        poolHeadroom: Math.max(0, p.maxWorkers - m.workerCount),
        regionalHeadroom: regionalHeadroom === Infinity ? null : regionalHeadroom,
        cooldownRemainingMs: { up: upCooldownRemaining, down: 0 },
      },
      nextState: next,
    };
  }

  // signals present but not yet sustained (or nothing at all)
  if (upSignals.length || downSignals.length) return hold("sustaining");
  return hold("no-signal");
}

/**
 * Commit an APPLIED action into the decision state (autoscaler calls this
 * after the pool change actually happened). Keeping it separate makes
 * computeScaleDecision side-effect-free while cooldown bookkeeping stays exact.
 */
export function commitAppliedAction(state, action, now) {
  return {
    ...state,
    lastScaleAt: now,
    lastAction: action,
    lastActionAt: now,
  };
}

/**
 * Validate a policy. The hysteresis invariants are HARD errors: a policy
 * whose down thresholds are not strictly below the up thresholds can
 * oscillate, so it is refused outright.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScalingPolicy(policy) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const p = policy || {};
  const int = (v) => Number.isInteger(v);

  need(int(p.minWorkers) && p.minWorkers >= 0, "minWorkers must be an integer >= 0");
  need(int(p.maxWorkers) && p.maxWorkers >= 1, "maxWorkers must be an integer >= 1");
  need(p.minWorkers <= p.maxWorkers, "minWorkers must be <= maxWorkers");
  need(p.maxWorkersPerRegion == null || (int(p.maxWorkersPerRegion) && p.maxWorkersPerRegion >= 1),
    "maxWorkersPerRegion must be null or an integer >= 1");
  need(int(p.evaluateIntervalMs) && p.evaluateIntervalMs >= 100, "evaluateIntervalMs must be an integer >= 100");

  const up = p.scaleUp || {};
  const down = p.scaleDown || {};
  need(Number.isFinite(up.queueDepthPerWorker) && up.queueDepthPerWorker > 0, "scaleUp.queueDepthPerWorker must be > 0");
  need(Number.isFinite(up.oldestJobAgeMs) && up.oldestJobAgeMs >= 0, "scaleUp.oldestJobAgeMs must be >= 0");
  need(Number.isFinite(up.utilization) && up.utilization > 0 && up.utilization <= 1, "scaleUp.utilization must be in (0, 1]");
  need(Number.isFinite(up.sustainMs) && up.sustainMs >= 0, "scaleUp.sustainMs must be >= 0");
  need(Number.isFinite(up.cooldownMs) && up.cooldownMs >= 0, "scaleUp.cooldownMs must be >= 0");
  need(int(up.step) && up.step >= 1, "scaleUp.step must be an integer >= 1");

  need(Number.isFinite(down.utilization) && down.utilization >= 0 && down.utilization <= 1, "scaleDown.utilization must be in [0, 1]");
  need(Number.isFinite(down.queueDepth) && down.queueDepth >= 0, "scaleDown.queueDepth must be >= 0");
  need(Number.isFinite(down.sustainMs) && down.sustainMs >= 0, "scaleDown.sustainMs must be >= 0");
  need(Number.isFinite(down.cooldownMs) && down.cooldownMs >= 0, "scaleDown.cooldownMs must be >= 0");
  need(int(down.step) && down.step >= 1, "scaleDown.step must be an integer >= 1");

  // hysteresis invariants (the no-oscillation contract)
  const bothOk = errors.every((e) => !/scaleUp\.|scaleDown\./.test(e));
  if (bothOk) {
    need(down.utilization < up.utilization, "hysteresis: scaleDown.utilization must be < scaleUp.utilization");
    need(down.queueDepth < up.queueDepthPerWorker, "hysteresis: scaleDown.queueDepth must be < scaleUp.queueDepthPerWorker");
  }

  const idle = p.idle || {};
  need(Number.isFinite(idle.idleAfterMs) && idle.idleAfterMs >= 0, "idle.idleAfterMs must be >= 0");

  return { ok: errors.length === 0, errors: errors.filter(Boolean) };
}

// ── env parsing ────────────────────────────────────────────────────────────
const envNum = (env, key, dflt) => {
  const raw = env[key];
  if (raw == null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
};
const envInt = (env, key, dflt) => Math.floor(envNum(env, key, dflt));

/**
 * Build the policy from CLONER_AUTOSCALE_* env vars (falling back to the
 * defaults). Throws a clean, listed error when the resulting policy violates
 * validation (e.g. a down threshold set ABOVE its up threshold).
 * @param {object} [env] defaults to process.env
 */
export function parsePolicyFromEnv(env = process.env) {
  const d = defaultScalingPolicy();
  const regionRaw = env.CLONER_AUTOSCALE_MAX_PER_REGION;
  const policy = {
    minWorkers: envInt(env, "CLONER_AUTOSCALE_MIN_WORKERS", d.minWorkers),
    maxWorkers: envInt(env, "CLONER_AUTOSCALE_MAX_WORKERS", d.maxWorkers),
    maxWorkersPerRegion: regionRaw == null || String(regionRaw).trim() === "" ? null : envInt(env, "CLONER_AUTOSCALE_MAX_PER_REGION", 0),
    evaluateIntervalMs: envInt(env, "CLONER_AUTOSCALE_EVALUATE_INTERVAL_MS", d.evaluateIntervalMs),
    scaleUp: {
      queueDepthPerWorker: envNum(env, "CLONER_AUTOSCALE_UP_QUEUE_DEPTH_PER_WORKER", d.scaleUp.queueDepthPerWorker),
      oldestJobAgeMs: envNum(env, "CLONER_AUTOSCALE_UP_OLDEST_JOB_AGE_MS", d.scaleUp.oldestJobAgeMs),
      utilization: envNum(env, "CLONER_AUTOSCALE_UP_UTILIZATION", d.scaleUp.utilization),
      sustainMs: envNum(env, "CLONER_AUTOSCALE_UP_SUSTAIN_MS", d.scaleUp.sustainMs),
      cooldownMs: envNum(env, "CLONER_AUTOSCALE_UP_COOLDOWN_MS", d.scaleUp.cooldownMs),
      step: envInt(env, "CLONER_AUTOSCALE_UP_STEP", d.scaleUp.step),
    },
    scaleDown: {
      utilization: envNum(env, "CLONER_AUTOSCALE_DOWN_UTILIZATION", d.scaleDown.utilization),
      queueDepth: envNum(env, "CLONER_AUTOSCALE_DOWN_QUEUE_DEPTH", d.scaleDown.queueDepth),
      sustainMs: envNum(env, "CLONER_AUTOSCALE_DOWN_SUSTAIN_MS", d.scaleDown.sustainMs),
      cooldownMs: envNum(env, "CLONER_AUTOSCALE_DOWN_COOLDOWN_MS", d.scaleDown.cooldownMs),
      step: envInt(env, "CLONER_AUTOSCALE_DOWN_STEP", d.scaleDown.step),
    },
    idle: {
      idleAfterMs: envNum(env, "CLONER_AUTOSCALE_IDLE_AFTER_MS", d.idle.idleAfterMs),
    },
  };
  const { ok, errors } = validateScalingPolicy(policy);
  if (!ok) throw new Error(`scaling-policy: invalid CLONER_AUTOSCALE_* configuration — ${errors.join("; ")}`);
  return policy;
}
