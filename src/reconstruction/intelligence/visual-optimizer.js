// Visual optimizer (task G3.2, PLAN50 "visual optimization": automated defect
// localization, layout correction and regression prevention).
//
// Three capabilities, all deterministic and evidence-gated:
//
//  1. LOCALIZATION — localizeDefects(fidelity, opts) turns the
//     visual-fidelity-analyzer's measured report into WHERE the drift is:
//     hot pixel-grid cells (score ≥ HOT_CELL_FLOOR, the classifier's
//     visible-drift floor) are clustered into connected components ("drift
//     clusters") with page-space rects; each cluster is marked explained when
//     an element-level classifier defect already accounts for one of its cells,
//     otherwise unexplained — and unexplained clusters get the candidate
//     elements whose captured boxes overlap the cluster rect (ranked by
//     overlap ratio, capped). Element defects themselves come from the
//     EXISTING 3.4.3 classifier (src/reconstruction/visual-diff-classifier.js,
//     READ-ONLY here) — this module localizes and targets, it never
//     re-invents classification.
//
//  2. LAYOUT CORRECTION — correctLayout(projectDir, fidelity, opts) filters
//     the localized layout-relevant defects, plans through the EXISTING
//     repair-planner (planRepairs, READ-ONLY) and executes through the
//     EXISTING repair-executor (executeRepairs, READ-ONLY — its per-round
//     snapshot/measure/keep-revert loop is the executor's own measurable gate).
//     On top of that, this pass-level MEASURABLE-IMPROVEMENT GATE accepts the
//     whole correction only when the aggregate check score improves by more
//     than opts.minGateImprovement across ALL checks the plan used; a failed
//     gate restores the pre-pass project byte-for-byte via repair-history's
//     snapshotProject/restoreSnapshot (the executor's own rollback surface)
//     and reports accepted:false with the measured before/after. No action is
//     ever applied without a measurable check (the executor's unverifiable
//     contract); a plan with no repairable actions never touches the project.
//
//  3. REGRESSION PREVENTION — the multisite benchmark
//     (scripts/test-multisite-benchmark.mjs, task 3.5.7) seeds
//     fixtures/benchmark/baseline.json and fails runs whose per-site score
//     drops > rubric.regressionTolerance. The hooks here expose that exact
//     contract as a reusable, testable gate so the integrator can wire visual
//     regression prevention into the benchmark without touching it:
//       seedBenchmarkBaseline(results)      → benchmark-shaped baseline JSON
//       evaluateBenchmarkRegression(...)    → per-site drop flags (fail-closed)
//       writeSimilarityLedger/readSimilarityLedger
//       evaluateSimilarityLedger(...)       → per-site pixel-similarity drops
//       regressionGate(opts)                → one bound object for the benchmark
//     The seeded shape mirrors the benchmark's own seed
//     (test-multisite-benchmark.mjs:660-673: { rubricVersion, fixtureVersion,
//     perSite: { site: { overall, dimensions: { dim: { score } } } } }) and is
//     asserted shape-compatible against the real baseline file in the suite.
//
// Safety rules (mirror the pipeline's standing contract):
//  - malformed/absent input degrades to an empty-but-honest result, never a
//    throw (localization) — a crash must not invent or hide defects;
//  - correction NEVER writes anything when the plan is empty and ALWAYS
//    restores on gate failure (byte-identical restore is verified by digest);
//  - regression evaluation is pure — no fs, no browser, no model calls — so
//    the benchmark stays deterministic and replayable (3.5.7 contract);
//  - ledger writes are atomic (tmp file + rename) and versioned; a malformed
//    ledger read throws (fail-closed — a prevention hook must never silently
//    accept unreadable baselines).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GRID_X, GRID_Y } from "../visual-fidelity-analyzer.js";
import { classifyDefects, severityFor } from "../visual-diff-classifier.js";
import { planRepairs } from "../repair-planner.js";
import { executeRepairs, DEFAULT_KIND_CHECK } from "../repair-executor.js";
import {
  snapshotProject,
  restoreSnapshot,
} from "../repair-history.js";

// visible pixel drift floor for a grid cell (0-255 mean channel delta) — the
// same floor the 3.4.3 classifier uses for region-only defects
// (visual-diff-classifier.js REGION_SCORE_FLOOR), so a "hot" cell here is the
// same evidence the classifier calls visible.
export const HOT_CELL_FLOOR = 20;

// layout-relevant defect kinds — position/size/z-index drift. Typography and
// color are fidelity repairs but not layout repairs; they flow only when the
// caller widens opts.kinds.
export const LAYOUT_KINDS = Object.freeze(["geometry", "stacking"]);

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const round2 = (v) => Math.round(v * 100) / 100;

// digestTree(dir, opts) → stable string digest of every file under dir
// (relative path + sha256 of bytes). opts.exclude skips top-level entries —
// the repair bookkeeping (".repair" history + per-round snapshots, and the
// optimizer's own pass-baseline snapshot) is NOT project state: the executor's
// rollback contract already deletes created bookkeeping on restore, and gate
// digests must compare exactly the executor's mutation surface (index.html,
// styles/, clone-fixes.css). Used to PROVE a gate-failure restore was
// byte-identical — the same evidence standard the executor applies per round.
export function digestTree(dir, opts = {}) {
  const exclude = new Set((Array.isArray(opts.exclude) ? opts.exclude : [".repair"]).map(String));
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (rel === "" && exclude.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(childRel);
      else if (ent.isFile()) {
        out.push(`${childRel}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(abs, ent.name))).digest("hex")}`);
      }
    }
  };
  walk("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 1. Defect localization
// ---------------------------------------------------------------------------

// cellRect(cell, dims) → page-space rect of one grid cell.
export function cellRect(cell, dims) {
  const col = cell % GRID_X;
  const row = Math.floor(cell / GRID_X);
  const w = dims.w / GRID_X;
  const h = dims.h / GRID_Y;
  return { x: col * w, y: row * h, w, h };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// clusterHotRegions(regions, dims, opts) → connected components (4-neighbours)
// over the 12×8 grid cells whose score ≥ opts.hotThreshold. Deterministic:
// clusters ordered by first-cell index, cells ascending inside a cluster.
export function clusterHotRegions(regions, dims, opts = {}) {
  const floor = Number.isFinite(opts.hotThreshold) ? opts.hotThreshold : HOT_CELL_FLOOR;
  const list = (Array.isArray(regions) ? regions : []).filter(
    (r) => r && Number.isInteger(r.cell) && Number.isFinite(r.score) && r.score >= floor,
  );
  const byCell = new Map(list.map((r) => [r.cell, r]));
  const seen = new Set();
  const clusters = [];
  for (const start of [...byCell.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const cells = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cell = queue.shift();
      cells.push(cell);
      const col = cell % GRID_X;
      const row = Math.floor(cell / GRID_X);
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const c2 = col + dc;
        const r2 = row + dr;
        if (c2 < 0 || c2 >= GRID_X || r2 < 0 || r2 >= GRID_Y) continue;
        const n = r2 * GRID_X + c2;
        if (byCell.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    cells.sort((a, b) => a - b);
    // page-space union rect of the cluster's cells
    let rect = null;
    for (const cell of cells) {
      const cr = cellRect(cell, dims);
      rect = rect
        ? {
            x: Math.min(rect.x, cr.x),
            y: Math.min(rect.y, cr.y),
            w: 0,
            h: 0,
            x2: Math.max(rect.x + rect.w, cr.x + cr.w),
            y2: Math.max(rect.y + rect.h, cr.y + cr.h),
          }
        : { x: cr.x, y: cr.y, w: cr.w, h: cr.h, x2: cr.x + cr.w, y2: cr.y + cr.h };
    }
    rect = { x: rect.x, y: rect.y, w: rect.x2 - rect.x, h: rect.y2 - rect.y };
    const scores = cells.map((c) => byCell.get(c).score);
    const peakScore = Math.max(...scores);
    const meanScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    const areaPct = round2((cells.length / (GRID_X * GRID_Y)) * 100);
    const dominantVisualKind =
      cells
        .map((c) => byCell.get(c).visualKind)
        .filter(Boolean)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] || null;
    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      cells,
      rect: { x: round2(rect.x), y: round2(rect.y), w: round2(rect.w), h: round2(rect.h) },
      peakScore,
      meanScore: round2(meanScore),
      areaPct,
      // area-weighted severity on the shared severityFor curve — the same
      // 0-1 scale the classifier's defects use, so a cluster is rankable
      // against element defects directly.
      severity: severityFor(cells.length / (GRID_X * GRID_Y), clamp01(peakScore / 255)),
      dominantVisualKind,
    });
  }
  return clusters;
}

// localizeDefects(fidelity, opts) →
//   { clusters, explainedClusters, unexplainedClusters, elementDefects,
//     candidatesByCluster, summary }
// opts: { hotThreshold?, elements? (original capture: [{i, tag, cls, rect}]),
//         candidateLimit? (default 3) }
// Element defects come from classifyDefects (READ-ONLY reuse). A cluster is
// "explained" when an element defect measured in one of its cells; every other
// cluster is unexplained and gets candidate elements ranked by captured-box
// overlap with the cluster rect — the repair targets for unexplained drift.
export function localizeDefects(fidelity, opts = {}) {
  const f = fidelity && typeof fidelity === "object" ? fidelity : {};
  const dims = f.dims && f.dims.w > 0 && f.dims.h > 0 ? f.dims : null;
  const empty = {
    clusters: [],
    explainedClusters: [],
    unexplainedClusters: [],
    elementDefects: [],
    candidatesByCluster: {},
    summary: { hotCells: 0, clusters: 0, explained: 0, unexplained: 0, candidates: 0, peakScore: 0 },
  };
  if (!dims) return empty; // malformed report → honest empty, never a throw

  const elementDefects = classifyDefects(f);
  const clusters = clusterHotRegions(f.regions, dims, opts);
  const explainedCells = new Map(); // cell → [kind:target, ...]
  for (const d of elementDefects) {
    // only ELEMENT-level evidence explains a cluster (refs non-empty); the
    // classifier's region-only color defects (refs: [], target "region:N") are
    // themselves the unexplained-drift bucket and must not self-explain.
    if (d.region === null || d.region === undefined || !Array.isArray(d.refs) || !d.refs.length) continue;
    const label = `${d.kind}:${d.action?.target ?? d.refs[0] ?? "?"}`;
    const arr = explainedCells.get(d.region) || [];
    arr.push(label);
    explainedCells.set(d.region, arr);
  }

  const limit = Number.isInteger(opts.candidateLimit) && opts.candidateLimit > 0 ? opts.candidateLimit : 3;
  const elements = (Array.isArray(opts.elements) ? opts.elements : []).filter(
    (e) => e && e.rect && e.rect.w > 0 && e.rect.h > 0,
  );

  const candidatesByCluster = {};
  const explained = [];
  const unexplained = [];
  let hotCells = 0;
  let candidateCount = 0;
  for (const cluster of clusters) {
    hotCells += cluster.cells.length;
    const causes = [];
    for (const cell of cluster.cells) for (const label of explainedCells.get(cell) || []) causes.push(label);
    cluster.explainedBy = [...new Set(causes)];
    cluster.verdict = causes.length ? "explained" : "unexplained";
    const pageArea = dims.w * dims.h;
    // candidate elements whose captured box overlaps the drift area, ranked by
    // overlap share of the element's own box (a small element fully inside the
    // drift outranks a huge one barely touched by it)
    const ranked = elements
      .map((e) => ({
        i: e.i,
        tag: e.tag,
        cls: e.cls || null,
        rect: e.rect,
        overlapPct: round2(clamp01(overlapArea(e.rect, cluster.rect) / (e.rect.w * e.rect.h)) * 100),
        coveragePct: round2(clamp01(overlapArea(e.rect, cluster.rect) / Math.max(1, pageArea)) * 100),
      }))
      .filter((c) => c.overlapPct > 0)
      .sort((a, b) => b.overlapPct - a.overlapPct || a.i - b.i)
      .slice(0, limit);
    cluster.candidates = ranked;
    if (causes.length) explained.push(cluster);
    else unexplained.push(cluster);
    candidatesByCluster[cluster.id] = ranked;
    candidateCount += ranked.length;
  }

  return {
    clusters,
    explainedClusters: explained,
    unexplainedClusters: unexplained,
    elementDefects,
    candidatesByCluster,
    summary: {
      hotCells,
      clusters: clusters.length,
      explained: explained.length,
      unexplained: unexplained.length,
      candidates: candidateCount,
      peakScore: clusters.length ? Math.max(...clusters.map((c) => c.peakScore)) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Layout correction — through the EXISTING planner + executor, gated
// ---------------------------------------------------------------------------

// correctLayout(projectDir, fidelity, opts) →
//   { accepted, gate: { before, after, delta, minGateImprovement, passed, reason },
//     localization, plan, repair, baselineSnapshot, restored, restoreIdentical,
//     checks }
// opts: { kinds = LAYOUT_KINDS, extraDefects = [], checkFns, checkForKind,
//         verifyOne, maxRounds = 3, minImprovement = 0 (executor per-round),
//         minGateImprovement = 0 (pass-level), confidenceThreshold, assetMap,
//         snapshotRoot }
// Gate: accepted ⇔ the executor ran AND every check's final score is finite
// AND (sum(final) − sum(baseline)) > minGateImprovement. A failed gate rolls
// the whole pass back via repair-history and proves the restore byte-identical.
export async function correctLayout(projectDir, fidelity, opts = {}) {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : LAYOUT_KINDS;
  const localization = localizeDefects(fidelity, opts);
  const defects = [
    ...localization.elementDefects.filter((d) => kinds.includes(d.kind)),
    ...(Array.isArray(opts.extraDefects) ? opts.extraDefects : []),
  ];
  const plan = planRepairs(defects, {
    assetMap: opts.assetMap,
    confidenceThreshold: opts.confidenceThreshold,
  });

  const base = {
    accepted: false,
    gate: { before: NaN, after: NaN, delta: NaN, minGateImprovement: Number(opts.minGateImprovement) || 0, passed: false, reason: "" },
    localization,
    plan,
    repair: null,
    baselineSnapshot: null,
    restored: false,
    restoreIdentical: null,
    checks: [],
  };
  if (!plan.actions.length) {
    base.gate.reason = "no repairable defects after localization/kind filter — project untouched";
    return base;
  }

  const snapshotRoot = opts.snapshotRoot || path.join(projectDir, ".repair", "optimizer");
  const snap = snapshotProject(projectDir, path.join(snapshotRoot, "pass-baseline"));
  // bookkeeping excluded from the digest: the executor's .repair tree plus the
  // optimizer's own snapshot root (wherever the caller put it)
  const gateExclude = [".repair", path.relative(projectDir, snapshotRoot)];
  const beforeDigest = digestTree(projectDir, { exclude: gateExclude });
  base.baselineSnapshot = { dir: snap.dir, exclude: gateExclude };

  let repair;
  try {
    repair = await executeRepairs(projectDir, plan.actions, {
      maxRounds: opts.maxRounds,
      checkFns: opts.checkFns,
      checkForKind: opts.checkForKind || DEFAULT_KIND_CHECK,
      verifyOne: opts.verifyOne,
      minImprovement: opts.minImprovement,
    });
  } catch (e) {
    restoreSnapshot(projectDir, snap.dir);
    base.restored = true;
    base.restoreIdentical = digestTree(projectDir, { exclude: gateExclude }) === beforeDigest;
    base.gate.reason = `correction crashed: ${String(e?.message || e).slice(0, 140)} — restored`;
    return base;
  }
  base.repair = repair;
  base.checks = Object.keys(repair.baseline);

  const keys = Object.keys(repair.baseline);
  const before = keys.reduce((s, k) => s + (Number.isFinite(repair.baseline[k]) ? repair.baseline[k] : 0), 0);
  const after = keys.reduce((s, k) => s + (Number.isFinite(repair.final[k]) ? repair.final[k] : 0), 0);
  const allFinite = keys.length > 0 && keys.every((k) => Number.isFinite(repair.final[k]) && Number.isFinite(repair.baseline[k]));
  const delta = after - before;
  const minGate = Number.isFinite(opts.minGateImprovement) ? opts.minGateImprovement : 0;

  if (!allFinite) {
    restoreSnapshot(projectDir, snap.dir);
    base.restored = true;
    base.restoreIdentical = digestTree(projectDir, { exclude: gateExclude }) === beforeDigest;
    base.gate.before = before;
    base.gate.after = after;
    base.gate.delta = NaN;
    base.gate.reason = "non-finite check score — improvement unmeasurable, restored";
    return base;
  }

  const passed = delta > minGate;
  base.gate = {
    before: round2(before),
    after: round2(after),
    delta: round2(delta),
    minGateImprovement: minGate,
    passed,
    reason: passed
      ? `measurable improvement: ${round2(before)} → ${round2(after)} (Δ ${round2(delta)} > ${minGate})`
      : `improvement below gate: ${round2(before)} → ${round2(after)} (Δ ${round2(delta)} ≤ ${minGate}) — restored`,
  };
  if (!passed) {
    restoreSnapshot(projectDir, snap.dir);
    base.restored = true;
    base.restoreIdentical = digestTree(projectDir, { exclude: gateExclude }) === beforeDigest;
    return base;
  }
  base.accepted = true;
  base.restoreIdentical = null;
  return base;
}

// ---------------------------------------------------------------------------
// 3. Regression prevention — multisite benchmark hooks
// ---------------------------------------------------------------------------

export const LEDGER_VERSION = 1;

// Default tolerance: the multisite rubric's regressionTolerance is the single
// source of truth (fixtures/benchmark/rubric.json → 3); callers pass the
// rubric value through. The constant is the fallback when no rubric is given.
export const REGRESSION_TOLERANCE = 3;

// seedBenchmarkBaseline(results, meta) → the EXACT shape the multisite
// benchmark seeds (test-multisite-benchmark.mjs:660-673):
//   { rubricVersion, fixtureVersion, perSite: { site: { overall, dimensions } } }
// results: [{ site, overall, dimensions: { dim: { score } } }] (scored shape).
export function seedBenchmarkBaseline(results, meta = {}) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r.site === "string");
  const perSite = {};
  for (const r of list.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))) {
    perSite[r.site] = {
      overall: round2(r.overall ?? 0),
      dimensions: Object.fromEntries(
        Object.entries(r.dimensions || {}).map(([d, v]) => [d, { score: round2(v?.score ?? 0) }]),
      ),
    };
  }
  return {
    rubricVersion: meta.rubricVersion ?? null,
    fixtureVersion: meta.fixtureVersion ?? null,
    perSite,
  };
}

// evaluateBenchmarkRegression(baseline, currentResults, opts) →
//   { pass, tolerance, compared, regressions: [...], unanchored: [...] }
// Mirrors the benchmark's regressionCheck semantics (drop = baseline − current,
// flagged when drop > tolerance) plus per-DIMENSION drops — a site can hold its
// overall while one dimension quietly collapses, and prevention must catch
// that. Sites absent from the baseline are unanchored (reported, never a
// silent pass or a fabricated failure). Pure — no fs, no model, deterministic.
export function evaluateBenchmarkRegression(baseline, currentResults, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : REGRESSION_TOLERANCE;
  const perSite = baseline && typeof baseline === "object" ? baseline.perSite || {} : {};
  const list = (Array.isArray(currentResults) ? currentResults : []).filter((r) => r && typeof r.site === "string");
  const regressions = [];
  const unanchored = [];
  const compared = [];
  for (const r of [...list].sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))) {
    const b = perSite[r.site];
    if (!b) {
      unanchored.push({ site: r.site, reason: "no baseline entry" });
      continue;
    }
    const drop = round2((b.overall ?? 0) - (r.overall ?? 0));
    const dimensionDrops = Object.entries(r.dimensions || {})
      .map(([dim, v]) => {
        const bd = b.dimensions?.[dim]?.score;
        return bd === undefined
          ? null
          : { dim, baseline: bd, current: round2(v?.score ?? 0), drop: round2(bd - (v?.score ?? 0)) };
      })
      .filter(Boolean)
      .filter((d) => d.drop > tolerance)
      .sort((a, b2) => b2.drop - a.drop);
    const flagged = drop > tolerance;
    const entry = { site: r.site, baselineOverall: b.overall ?? 0, current: round2(r.overall ?? 0), drop, flagged, dimensionDrops };
    compared.push(entry);
    if (flagged || dimensionDrops.length) regressions.push(entry);
  }
  return {
    pass: regressions.length === 0,
    tolerance,
    compared,
    regressions,
    unanchored,
  };
}

// similarity ledger: per-site pixel-similarity records — the VISUAL half of
// regression prevention. Shape: { version, rubricVersion, fixtureVersion,
// perSite: { site: { similarityPct } } }. Atomic, versioned writes; a
// malformed read throws (fail-closed).
export function writeSimilarityLedger(ledgerPath, records, meta = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r.site === "string");
  const perSite = {};
  for (const r of list.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))) {
    perSite[r.site] = {
      similarityPct: Number.isFinite(r.similarityPct) ? round2(r.similarityPct) : null,
    };
  }
  const ledger = {
    version: LEDGER_VERSION,
    rubricVersion: meta.rubricVersion ?? null,
    fixtureVersion: meta.fixtureVersion ?? null,
    perSite,
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(tmp, ledgerPath);
  return ledger;
}

export function readSimilarityLedger(ledgerPath) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, "utf8");
  } catch (e) {
    throw new Error(`similarity ledger unreadable at ${ledgerPath}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`similarity ledger malformed JSON at ${ledgerPath}: ${e.message}`);
  }
  if (!parsed || parsed.version !== LEDGER_VERSION || typeof parsed.perSite !== "object" || parsed.perSite === null) {
    throw new Error(`similarity ledger at ${ledgerPath} is not a v${LEDGER_VERSION} ledger`);
  }
  return parsed;
}

// evaluateSimilarityLedger(baselineLedger, currentRecords, opts) →
//   { pass, tolerance, regressions: [{ site, baseline, current, drop }],
//     unanchored: [...], added: [...] }
// A site's pixel similarity dropping more than tolerance flags a visual
// regression even when the aggregate benchmark score held — the regression
// the similarity ledger exists to prevent.
export function evaluateSimilarityLedger(baselineLedger, currentRecords, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : REGRESSION_TOLERANCE;
  const perSite = baselineLedger && typeof baselineLedger === "object" ? baselineLedger.perSite || {} : {};
  const list = (Array.isArray(currentRecords) ? currentRecords : []).filter((r) => r && typeof r.site === "string");
  const regressions = [];
  const unanchored = [];
  const added = [];
  for (const r of [...list].sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0))) {
    const b = perSite[r.site];
    if (!b) {
      added.push(r.site);
      continue;
    }
    if (!Number.isFinite(r.similarityPct)) {
      unanchored.push({ site: r.site, reason: "current similarity not measurable" });
      continue;
    }
    const base = Number.isFinite(b.similarityPct) ? b.similarityPct : 0;
    const drop = round2(base - r.similarityPct);
    if (drop > tolerance) regressions.push({ site: r.site, baseline: base, current: round2(r.similarityPct), drop });
  }
  return { pass: regressions.length === 0, tolerance, regressions, unanchored, added };
}

// regressionGate(opts) → the ONE-CALL hook for the benchmark integrator:
//   const gate = regressionGate({ tolerance: rubric.regressionTolerance,
//                                 ledgerPath: "artifacts/benchmark-visual-ledger.json" });
//   gate.seed(results, { rubricVersion, fixtureVersion })       // seed/rewrite baseline
//   gate.evaluate(baseline, results)                            // score-drops gate
//   gate.writeLedger(similarityRecords, meta)                   // persist similarity
//   gate.checkLedger(similarityRecords)                         // visual gate
// Ledger reads/writes hit fs (the gate's only side effects); evaluation is pure.
export function regressionGate(opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : REGRESSION_TOLERANCE;
  const ledgerPath = opts.ledgerPath || null;
  return {
    tolerance,
    ledgerPath,
    seed: (results, meta) => seedBenchmarkBaseline(results, meta),
    evaluate: (baseline, results) => evaluateBenchmarkRegression(baseline, results, { tolerance }),
    writeLedger: (records, meta) => {
      if (!ledgerPath) throw new Error("regressionGate: no ledgerPath configured");
      return writeSimilarityLedger(ledgerPath, records, meta);
    },
    readLedger: () => {
      if (!ledgerPath) throw new Error("regressionGate: no ledgerPath configured");
      return readSimilarityLedger(ledgerPath);
    },
    checkLedger: (records) => {
      if (!ledgerPath) throw new Error("regressionGate: no ledgerPath configured");
      return evaluateSimilarityLedger(readSimilarityLedger(ledgerPath), records, { tolerance });
    },
  };
}

// BENCHMARK_WIRING — the documented integration for the integrator agent
// (scripts/test-multisite-benchmark.mjs and src/platform/verify.js are
// READ-ONLY for G3.2). Two hooks, both additive, both deterministic:
export const BENCHMARK_WIRING = Object.freeze([
  "1. Score-drops gate (test-multisite-benchmark.mjs, after regressionCheck):",
  "   import { regressionGate } from '../src/reconstruction/intelligence/visual-optimizer.js';",
  "   const gate = regressionGate({ tolerance: rubric.regressionTolerance });",
  "   const visualGuard = gate.evaluate(baselineUsed, results.map((r) => ({",
  "     site: r.site.id, overall: r.scored.overall, dimensions: r.scored.dimensions })));",
  "   // hardFail ||= !visualGuard.pass  (regressions[].dimensionDrops carry the per-dimension evidence)",
  "",
  "2. Pixel-similarity ledger (after verifyClone per site):",
  "   const gate = regressionGate({ tolerance: rubric.regressionTolerance,",
  "     ledgerPath: path.join(ARTIFACTS, 'benchmark-visual-ledger.json') });",
  "   const records = results.map((r) => ({ site: r.site.id,",
  "     similarityPct: r.raw.__cloneRaw?.fidelity?.pixel?.similarityPct ?? NaN }));",
  "   if (fs.existsSync(gate.ledgerPath)) { const verdict = gate.checkLedger(records);",
  "     if (!verdict.pass) process.exitCode = 1; }",
  "   gate.writeLedger(records, { rubricVersion: rubric.version, fixtureVersion: sitesFile.version });",
  "",
  "Seeding contract: on a gate-clean run with no baseline/ledger present, call gate.seed(...) /",
  "gate.writeLedger(...) exactly like the benchmark seeds baseline.json — never seed from a failing run.",
]);
