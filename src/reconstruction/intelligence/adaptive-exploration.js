// Adaptive exploration (plan §"Adaptive exploration" + §"Browser intelligence"
// + task 5.0.4 interaction-coverage maximizer).
//
// What it does:
//   1. rankCandidates() — ranks PENDING exploration candidates (state-discovery
//      3.5.5 shape) by three deterministic signals: UNCERTAINTY (how little the
//      already-explored graph knows about what this candidate leads to),
//      COVERAGE GAP (interaction/region kinds no explored state has exercised),
//      and EXPECTED INFORMATION GAIN (new structure counts vs what is known).
//      Optional learned-model consumption: an offline-trained kind scorer
//      (offline-learner.js) lowers uncertainty confidence for candidates whose
//      page structure the model already understands well — injected, never
//      required (deterministic fallback when absent).
//   2. createCoverageMaximizer() — explores until the interaction pass-rate
//      PLATEAUS or the budget exhausts. The browser step is an INJECTED engine
//      hook (the pipeline's exploration runner in product; a deterministic
//      fixture-driven engine in tests) — state-discovery/route-discovery stay
//      READ-ONLY (documented hook contract). Hard guarantees: executed
//      navigations NEVER exceed the budget; per-budget navigations never exceed
//      the baseline plan; plateau detection stops the loop on no-improvement.
//   3. recommendExplorationBudget() — browser-intelligence depth: given the
//      measured efficiency counters of a finished run (navigations saved,
//      states per route, coverage), recommend the next run's budgets. Bounded
//      by the policy floor/ceiling so a recommendation can never disable
//      exploration entirely or explode it.

import { parseSignatureCounts, interactionPotentialScore } from "../../exploration/state-discovery.js";

// interaction-kind hints inside DOM signature counts (parseSignatureCounts
// returns the captured counts payload: buttons/links/inputs/tables/canvases/
// modals/tabs/headers — the same keys interactionPotentialScore consumes).
const KIND_HINTS = [
  { kind: "form", test: (c) => (c.inputs || 0) >= 2 },
  { kind: "table", test: (c) => (c.tables || 0) >= 1 },
  { kind: "modal", test: (c) => (c.modals || 0) >= 1 },
  { kind: "tabs", test: (c) => (c.tabs || 0) >= 1 },
  { kind: "chart", test: (c) => (c.canvases || 0) >= 1 },
  { kind: "interactive", test: (c) => (c.buttons || 0) >= 1 || (c.links || 0) >= 2 },
];

function hintedKinds(counts) {
  return KIND_HINTS.filter((h) => h.test(counts)).map((h) => h.kind);
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// rankCandidates(candidates, ctx) → candidates with { signals, priority }.
//   candidates: state-discovery addCandidate() rows ({ id, url, domSig, score,
//               interaction, parentExplored, ... }) — pending ones only.
//   ctx: { coveredKinds: Set<string>, exploredSimilar: Map<urlPath,count>,
//          scorer?: createKindScorer() result, pages?: understanding models }
// Deterministic: stable sort by (priority desc, state-discovery score desc,
// candidate id asc).
export function rankCandidates(candidates, ctx = {}) {
  const covered = ctx.coveredKinds || new Set();
  const exploredSimilar = ctx.exploredSimilar || new Map();
  const rows = (candidates || []).map((c) => {
    const counts = parseSignatureCounts(c.domSig);
    const kinds = hintedKinds(counts);
    // coverage gap: fraction of this candidate's hinted kinds not yet covered
    // (0 when the candidate hints nothing new, 1 when every hinted kind is new)
    const gap = kinds.length ? kinds.filter((k) => !covered.has(k)).length / kinds.length : 0;
    // uncertainty: 1 when nothing similar was explored yet, decaying to 0 as
    // similar states accumulate (diminishing returns → less uncertain, less urgent)
    const similar = exploredSimilar.get(pathKey(c.url)) || 0;
    const uncertainty = clamp01(1 - similar / 3);
    // information gain: normalized interaction potential × novelty of counts
    const potential = interactionPotentialScore(counts, { parentExplored: !!c.parentExplored });
    const infoGain = clamp01(Math.log2(1 + Math.max(0, potential)) / 4);
    // optional learned-model uncertainty refinement (weak prior, gated by callers)
    let learnedUncertainty = null;
    if (ctx.scorer && typeof ctx.scorer.score === "function") {
      try {
        const s = ctx.scorer.score(c._component || {}, {});
        if (s && Number.isFinite(s.confidence)) learnedUncertainty = 1 - clamp01(s.confidence);
      } catch { /* scorer abstains → deterministic signals only */ }
    }
    const uncertaintyBlend = learnedUncertainty === null ? uncertainty : clamp01(0.7 * uncertainty + 0.3 * learnedUncertainty);
    const priority = Math.round((0.4 * gap + 0.35 * uncertaintyBlend + 0.25 * infoGain) * 1000) / 1000;
    return {
      ...c,
      signals: { coverageGap: Math.round(gap * 1000) / 1000, uncertainty: Math.round(uncertaintyBlend * 1000) / 1000, infoGain: Math.round(infoGain * 1000) / 1000, hintedKinds: kinds, potential },
      priority,
    };
  });
  rows.sort((a, b) =>
    b.priority - a.priority ||
    (b.score || 0) - (a.score || 0) ||
    String(a.id).localeCompare(String(b.id)));
  return rows;
}

const pathKey = (u) => {
  try { return new URL(u).pathname; } catch { return String(u || ""); }
};

// coverageFromGraph(graph) → { coveredKinds, exploredSimilar } consumed by
// rankCandidates — derived from a REAL state-discovery graph (nodes carry
// interaction + domSig of what was actually explored).
export function coverageFromGraph(graph) {
  const coveredKinds = new Set();
  const exploredSimilar = new Map();
  for (const n of graph?.nodes || []) {
    const counts = parseSignatureCounts(n.domSig);
    for (const k of hintedKinds(counts)) coveredKinds.add(k);
    const key = pathKey(n.url);
    exploredSimilar.set(key, (exploredSimilar.get(key) || 0) + 1);
  }
  return { coveredKinds, exploredSimilar };
}

// ---------- coverage maximizer (5.0.4) ----------

// createCoverageMaximizer({ engine, candidates, ctx, budget, baselineNavigations,
// plateauRounds, minImprovement, batch }) → { run() }.
//   engine.step(candidate) → { pass: bool, navigations: int, newState?: object }
//     — INJECTED real exploration step (product: pipeline runner hook; tests:
//     deterministic fixture engine standing in for the remote browser side).
//   budget: maximum navigations the maximizer may cause (hard cap).
//   baselineNavigations: what the un-maximized plan would spend — the run must
//     stay AT OR BELOW this to satisfy the 5.0.4 acceptance contract.
export function createCoverageMaximizer({
  engine,
  candidates = [],
  ctx = {},
  budget = 20,
  baselineNavigations = null,
  plateauRounds = 2,
  minImprovement = 0.01,
  batch = 3,
} = {}) {
  if (!engine || typeof engine.step !== "function") {
    throw new TypeError("coverage maximizer requires an engine with step(candidate)");
  }
  const cap = Math.max(0, Math.floor(budget));
  if (Number.isFinite(baselineNavigations)) {
    // acceptance contract: never spend more than the baseline plan would
    budget = Math.min(cap, Math.max(0, Math.floor(baselineNavigations)));
  } else {
    budget = cap;
  }

  return {
    budget,
    async run() {
      let pending = candidates.slice();
      let navigations = 0;
      let passes = 0, attempts = 0;
      let bestPassRate = 0;
      let roundsWithoutImprovement = 0;
      const history = [];
      const stateIds = [];
      let plateau = false;
      let budgetExhausted = false;

      while (pending.length && navigations < budget) {
        const coverage = coverageFromGraph({ nodes: stateIds });
        const ranked = rankCandidates(pending, { ...ctx, ...coverage });
        const slice = ranked.slice(0, Math.max(1, Math.min(batch, budget - navigations)));
        let roundPasses = 0, roundAttempts = 0;
        for (const c of slice) {
          if (navigations >= budget) break; // hard cap — never exceeded
          const remaining = budget - navigations;
          const res = await engine.step(c, { remainingNavigations: remaining });
          const used = Math.max(0, Math.floor(Number(res?.navigations ?? 1)));
          navigations = Math.min(budget, navigations + used); // clamp, then audit
          if (res?.newState) stateIds.push(res.newState);
          if (typeof res?.pass === "boolean") { roundAttempts++; attempts++; if (res.pass) roundPasses++; }
          pending = pending.filter((p) => p.id !== c.id);
        }
        passes += roundPasses;
        const passRate = roundAttempts ? roundPasses / roundAttempts : bestPassRate;
        const improved = passRate - bestPassRate >= minImprovement;
        if (improved) roundsWithoutImprovement = 0;
        else roundsWithoutImprovement++;
        bestPassRate = Math.max(bestPassRate, passRate);
        history.push({
          round: history.length + 1,
          candidatesExplored: slice.length,
          navigations,
          roundPassRate: Math.round(passRate * 1000) / 1000,
          bestPassRate: Math.round(bestPassRate * 1000) / 1000,
        });
        if (roundsWithoutImprovement >= plateauRounds) { plateau = true; break; }
        if (navigations >= budget) budgetExhausted = true;
      }
      if (!pending.length) { /* corpus fully explored */ } else if (navigations >= budget) budgetExhausted = true;

      return {
        navigations,
        budget,
        withinBudget: navigations <= budget,
        withinBaseline: Number.isFinite(baselineNavigations) ? navigations <= baselineNavigations : null,
        plateau,
        budgetExhausted,
        passRate: attempts ? Math.round((passes / attempts) * 1000) / 1000 : 0,
        rounds: history.length,
        history,
        remainingCandidates: pending.length,
      };
    },
  };
}

// ---------- browser-intelligence: exploration depth recommendation ----------

// recommendExplorationBudget(coverageReport, stats, policy?) → { maxRoutes,
// maxStatesPerPage, reason } — deterministic; bounded to ±50% of the observed
// defaults and never below 1 / above the policy ceiling.
//   coverageReport: reports/coverage-report.json shape ({ coveragePct, ... })
//   stats: graph.stats() shape ({ navigationsSaved, candidateDuplicates, ... })
export function recommendExplorationBudget(coverageReport, stats, policy = {}) {
  const coveragePct = clamp01((Number(coverageReport?.coveragePct) || 0) / 100);
  const routesExplored = Math.max(1, Number(coverageReport?.routesExplored) || 1);
  const statesRecorded = Math.max(0, Number(coverageReport?.statesRecorded) || 0);
  const saved = Math.max(0, Number(stats?.navigationsSaved) || 0);
  const savedRatio = clamp01(saved / Math.max(1, saved + routesExplored));
  const statesPerPage = statesRecorded / routesExplored;

  const baseRoutes = Math.round(Number(policy?.budgets?.maxRoutes) || 12);
  const baseStates = Math.round(Number(policy?.budgets?.maxStatesPerPage) || 20);

  // under-covered + efficient dedup → afford more routes; efficient dedup with
  // saturated coverage → fewer routes (the savings are already banked)
  const routeFactor = (1 - coveragePct) * (1 + savedRatio); // 0..2
  let maxRoutes = Math.round(baseRoutes * (0.5 + 0.5 * routeFactor));
  // rich per-page state yield justifies a higher page budget; thin yield (≤1
  // state per page) does not
  let maxStatesPerPage = Math.round(baseStates * clamp01(0.5 + statesPerPage / 10));

  maxRoutes = Math.max(1, Math.min(baseRoutes * 2, maxRoutes));
  maxStatesPerPage = Math.max(1, Math.min(baseStates * 2, maxStatesPerPage));

  const reasons = [];
  if (coveragePct < 0.8) reasons.push(`coverage ${Math.round(coveragePct * 100)}% < 80% — more routes`);
  if (savedRatio > 0.5) reasons.push(`${Math.round(savedRatio * 100)}% candidate navigations saved by dedup — headroom available`);
  if (coveragePct >= 0.99) reasons.push("coverage saturated — keep routes flat");
  if (statesPerPage <= 1.5) reasons.push(`only ${Math.round(statesPerPage * 100) / 100} states/page observed — page budget flat`);
  return {
    maxRoutes,
    maxStatesPerPage,
    reason: reasons.join("; ") || "within observed efficiency envelope",
    inputs: { coveragePct: Math.round(coveragePct * 1000) / 1000, routesExplored, statesPerPage: Math.round(statesPerPage * 100) / 100, savedRatio: Math.round(savedRatio * 1000) / 1000 },
  };
}
