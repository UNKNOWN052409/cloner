// Autonomous visual & functional repair e2e (task 3.4.5) — deterministic, zero
// network, zero browser: the repair loop's checks are INJECTED checkFns that
// measure the specific synthetic defects from file content (the exact contract
// executeRepairs exposes for real fidelity/functional checks).
//
// Fixture: a reconstruction-style project dir with three KNOWN defects —
//   1. bad background color   .hero (styles/layout.css sets #ff00ff; the live
//                             measured value was #0f1420) → token-fix via
//                             clone-fixes.css (autoRemediate pattern)
//   2. broken asset src       <img src="assets/missing-logo.png"> (file absent;
//                             replacement assets/logo.png exists) → asset-remap
//   3. dead interaction attr  data-cloner-trigger="t7" with no runtime record →
//                             interaction-rewire (dead-attribute pruning,
//                             verify.js:476-485 pattern)
// plus two defects that must be SKIPPED: a region-only color drift (confidence
// 0.5 < threshold 0.6) and a missing-component (no bounded minimal action).
//
// Asserted:
//  [1] planRepairs maps defect kinds onto the repair vocabulary, groups
//      same-target defects, skips below-threshold/unmappable defects, orders by
//      severity×area.
//  [2] executeRepairs full run: every repair improves its relevant metric and
//      is kept; clone-fixes.css + link written; asset remapped; dead attr
//      pruned; unrelated files byte-identical; loop bounded by plan exhaustion;
//      history.jsonl + per-round snapshots written.
//  [3] maxRounds bounds the loop (1 round, rest pending, stopped "max-rounds").
//  [4] a no-improvement round hard-stops AND rolls back byte-for-byte
//      (clone-fixes.css removed, index.html restored).
//  [5] repair-history: append-only JSONL; snapshot → mutate → restore round-trip.
//  [6] verifyOne injection overrides the checkFns dispatch.
//  [7] actions without any measurable check are never applied.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planRepairs,
  REPAIR_KINDS,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "../src/reconstruction/repair-planner.js";
import {
  executeRepairs,
  applyAction,
  DEFAULT_KIND_CHECK,
} from "../src/reconstruction/repair-executor.js";
import {
  appendHistory,
  readHistory,
  snapshotProject,
  restoreSnapshot,
} from "../src/reconstruction/repair-history.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---- fixture project --------------------------------------------------------
const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Repair Fixture</title>
  <link rel="stylesheet" href="styles/layout.css">
  <link rel="stylesheet" href="styles/components.css">
</head>
<body>
  <div class="cx-3 hero">Hero panel</div>
  <img class="cx-5 logo" src="assets/missing-logo.png" alt="logo">
  <button class="cx-7 live" data-cloner-trigger="t1">Live trigger</button>
  <button class="cx-8 dead" data-cloner-trigger="t7">Dead trigger</button>
</body>
</html>
`;
const LAYOUT_CSS = `.hero { background: #ff00ff; color: #ffffff; }\n.logo { width: 48px; height: 48px; }\n`;
const COMPONENTS_CSS = `/* unrelated component rules — must remain byte-identical through every repair round */\n.card { padding: 8px; border-radius: 4px; }\n`;
const RUNTIME_JS = `window.__CLONER_INTERACTIONS = [{"id":"t1","kind":"overlay"}];\n`;

const FIX_ROOT = path.join(ROOT, "artifacts", "test-autonomous-repair");
fs.rmSync(FIX_ROOT, { recursive: true, force: true });

function buildProject(name) {
  const dir = path.join(FIX_ROOT, name);
  for (const sub of ["styles", "assets", "runtime"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(dir, "styles", "layout.css"), LAYOUT_CSS);
  fs.writeFileSync(path.join(dir, "styles", "components.css"), COMPONENTS_CSS);
  fs.writeFileSync(path.join(dir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(dir, "runtime", "interactions.js"), RUNTIME_JS);
  return dir;
}

const read = (p) => fs.readFileSync(p, "utf8");
const readIn = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const bytesOf = (dir) => {
  const map = new Map();
  for (const rel of ["index.html", "styles/layout.css", "styles/components.css", "runtime/interactions.js", "assets/logo.png"]) {
    map.set(rel, fs.readFileSync(path.join(dir, rel)));
  }
  return map;
};
const bytesUnchanged = (dir, before, rels) => rels.every((rel) => fs.readFileSync(path.join(dir, rel)).equals(before.get(rel)));

// injected checkFns measuring THE SPECIFIC synthetic defects (pure fs, no browser)
function makeCheckFns() {
  return {
    fidelity(projectDir) {
      let score = 0;
      const html = readIn(projectDir, "index.html");
      const fixesPath = path.join(projectDir, "clone-fixes.css");
      const fixes = fs.existsSync(fixesPath) ? read(fixesPath) : "";
      // metric 1 — the hero background is overridden to the measured live value
      if (html.includes("clone-fixes.css") && /background(-color)?:\s*#0f1420\b/.test(fixes)) score += 0.5;
      // metric 2 — the broken asset reference now points at an existing file
      const logoPath = path.join(projectDir, "assets", "logo.png");
      if (!html.includes("assets/missing-logo.png") && html.includes("assets/logo.png") && fs.existsSync(logoPath)) score += 0.5;
      return score;
    },
    functional(projectDir) {
      const triggers = [...readIn(projectDir, "index.html").matchAll(/data-cloner-trigger="(t\d+)"/g)].map((m) => m[1]);
      let records = [];
      try {
        records = JSON.parse(read(path.join(projectDir, "runtime", "interactions.js")).match(/window\.__CLONER_INTERACTIONS = (\[.*\]);/)[1]);
      } catch {}
      const ids = new Set(records.map((r) => r.id));
      if (!triggers.length) return 1;
      return triggers.filter((t) => ids.has(t)).length / triggers.length;
    },
  };
}

// synthetic defects in the 3.4.3 classifier shape (visual-diff-classifier.js) plus
// a verification dead-attribute defect (verify.js stage-2 / hex.extra source)
const DEFECTS = [
  {
    kind: "color", severity: 0.72, salience: 0.9, confidence: 0.8, refs: [3], region: 2,
    field: "backgroundColor", original: "#0f1420", clone: "#ff00ff",
    action: { kind: "color-token-fix", target: ".cx-3", prop: "backgroundColor", value: "#0f1420" },
  },
  {
    kind: "missing-asset", severity: 0.5, salience: 0.6, confidence: 0.8, refs: [5],
    original: { tag: "img", src: "assets/missing-logo.png" },
    action: { kind: "restore-asset", target: ".cx-5", tag: "img", src: "assets/missing-logo.png" },
  },
  { kind: "interaction", severity: 0.4, salience: 0.3, confidence: 0.9, refs: [], deadAttrs: ["t7"] },
  {
    kind: "color", severity: 0.3, salience: 0.2, confidence: 0.5, refs: [], region: 9,
    action: { kind: "color-token-fix", target: "region:9", prop: "backgroundColor" },
  },
  {
    kind: "missing-component", severity: 0.6, salience: 0.5, confidence: 0.75, refs: [7],
    original: { tag: "section" },
    action: { kind: "add-component", target: ".cx-7" },
  },
];
const ASSET_MAP = { "assets/missing-logo.png": "assets/logo.png" };

try {
  // ---------------------------------------------------------- [1] planner
  console.log("\n[1] planRepairs — mapping, grouping, threshold, ordering");
  const plan = planRepairs(DEFECTS, { assetMap: ASSET_MAP });
  check("5 defects in → 3 planned actions + 2 skipped", plan.actions.length === 3 && plan.skipped.length === 2,
    `planned: [${plan.actions.map((a) => a.kind).join(", ")}] skipped: [${plan.skipped.map((s) => s.kind).join(", ")}]`);
  check("action kinds drawn from the repair vocabulary", plan.actions.every((a) => REPAIR_KINDS.includes(a.kind)), plan.actions.map((a) => a.kind).join(", "));
  check("color→token-fix carries the measured live value", plan.actions.some((a) => a.kind === "token-fix" && a.target === ".cx-3" && a.payload.props["background-color"] === "#0f1420"), "");
  check("missing-asset→asset-remap resolved via assetMap", plan.actions.some((a) => a.kind === "asset-remap" && a.payload.from === "assets/missing-logo.png" && a.payload.to === "assets/logo.png"), "");
  check("dead attr→interaction-rewire targets the trigger", plan.actions.some((a) => a.kind === "interaction-rewire" && a.target === '[data-cloner-trigger="t7"]'), "");
  check("region-only color defect skipped below threshold 0.6",
    plan.threshold === DEFAULT_CONFIDENCE_THRESHOLD && plan.skipped.some((s) => s.confidence === 0.5 && /below threshold/.test(s.reason)), "");
  check("missing-component skipped (no bounded minimal action)",
    plan.skipped.some((s) => s.kind === "missing-component" && /structural/.test(s.reason)), "");
  check("ordered severity×area first (0.72 → 0.5 → 0.4)",
    plan.actions.map((a) => a.kind).join(",") === "token-fix,asset-remap,interaction-rewire"
    && plan.actions.every((a, i) => i === 0 || plan.actions[i - 1].priority >= a.priority),
    plan.actions.map((a) => `${a.kind}@${a.priority.toFixed(2)}`).join(" → "));
  const grouped = planRepairs([
    { kind: "typography", severity: 0.6, confidence: 0.85, refs: [12], action: { kind: "typography-override", target: ".cx-12", prop: "fontWeight", value: "400" } },
    { kind: "stacking", severity: 0.5, confidence: 0.7, refs: [12], action: { kind: "stacking-fix", target: ".cx-12", values: { zIndex: "5" } } },
  ]);
  check("same-target defects group into ONE css-override (typography + stacking merge props)",
    grouped.actions.length === 1 && grouped.actions[0].kind === "css-override"
    && grouped.actions[0].payload.props["font-weight"] === "400" && grouped.actions[0].payload.props["z-index"] === "5"
    && grouped.actions[0].defectKinds.length === 2 && grouped.actions[0].confidence === 0.7, "");
  check("asset-remap without a resolvable target is skipped",
    planRepairs([{ kind: "missing-asset", severity: 0.5, confidence: 0.8, action: { kind: "restore-asset", target: ".cx-5", src: "assets/gone.png" } }]).skipped.length === 1, "");
  check("applyAction rejects unsupported kinds (never mutate blindly)",
    (() => { try { applyAction(buildProject("reject"), { kind: "unknown-kind", payload: {} }); return false; } catch { return true; } })(), "");

  // ------------------------------------------------- [2] full repair run
  console.log("\n[2] executeRepairs — bounded keep-if-improved loop over the synthetic defects");
  const dir = buildProject("full-run");
  const before2 = bytesOf(dir);
  const res = await executeRepairs(dir, planRepairs(DEFECTS, { assetMap: ASSET_MAP }).actions, { maxRounds: 3, checkFns: makeCheckFns() });
  check("3 rounds ran, all kept, loop exhausted", res.rounds.length === 3 && res.applied.length === 3 && res.reverted.length === 0 && res.stopped === "exhausted",
    `stopped=${res.stopped}, rounds=${res.rounds.length}`);
  check("every round improved its relevant check", res.rounds.every((r) => r.kept && r.after > r.before),
    res.rounds.map((r) => `r${r.round} ${r.action.kind} ${r.before}→${r.after}`).join(", "));
  check("metrics improved end-to-end (fidelity 0→1, functional 0.5→1)",
    res.improved && res.baseline.fidelity === 0 && res.final.fidelity === 1 && res.baseline.functional === 0.5 && res.final.functional === 1,
    JSON.stringify({ baseline: res.baseline, final: res.final }));
  check("clone-fixes.css override written + linked exactly once",
    fs.existsSync(path.join(dir, "clone-fixes.css"))
    && /background-color: #0f1420 !important/.test(readIn(dir, "clone-fixes.css"))
    && (readIn(dir, "index.html").match(/clone-fixes\.css/g) || []).length === 1, "");
  check("broken asset src remapped to the existing file",
    !readIn(dir, "index.html").includes("assets/missing-logo.png") && readIn(dir, "index.html").includes('src="assets/logo.png"'), "");
  check("dead interaction attr pruned, live trigger kept",
    !readIn(dir, "index.html").includes('data-cloner-trigger="t7"') && readIn(dir, "index.html").includes('data-cloner-trigger="t1"'), "");
  check("unrelated files untouched byte-for-byte",
    bytesUnchanged(dir, before2, ["styles/layout.css", "styles/components.css", "runtime/interactions.js", "assets/logo.png"]), "");
  const history2 = readHistory(res.historyPath);
  check("history.jsonl written with per-round {round, action, before, after, kept, reason}",
    history2.length === 3 && history2.every((e) => Number.isInteger(e.round) && e.action?.kind && Number.isFinite(e.before) && Number.isFinite(e.after) && typeof e.kept === "boolean" && typeof e.reason === "string"),
    res.historyPath);
  check("per-round snapshots written (index.html + styles) for rollback",
    [1, 2, 3].every((n) => fs.existsSync(path.join(dir, ".repair", "snapshots", `round-00${n}`, "index.html"))
      && fs.existsSync(path.join(dir, ".repair", "snapshots", `round-00${n}`, "styles", "layout.css"))), "");

  // ------------------------------------------------- [3] maxRounds bound
  console.log("\n[3] rounds are bounded by maxRounds");
  const dir3 = buildProject("bounded");
  const res3 = await executeRepairs(dir3, planRepairs(DEFECTS, { assetMap: ASSET_MAP }).actions, { maxRounds: 1, checkFns: makeCheckFns() });
  check("maxRounds=1 caps the loop at one round", res3.rounds.length === 1 && res3.stopped === "max-rounds" && res3.pending.length === 2,
    `stopped=${res3.stopped}, pending=[${res3.pending.map((a) => a.kind).join(", ")}]`);
  check("history holds exactly the executed round", readHistory(res3.historyPath).length === 1, "");

  // --------------------------------------- [4] no-improvement hard stop
  console.log("\n[4] no-improvement round hard-stops and rolls back");
  const dir4 = buildProject("no-improvement");
  const before4 = bytesOf(dir4);
  const res4 = await executeRepairs(dir4, planRepairs(DEFECTS, { assetMap: ASSET_MAP }).actions,
    { maxRounds: 3, checkFns: { fidelity: () => 0.42, functional: () => 0.5 } });
  check("first non-improving round stops the loop", res4.rounds.length === 1 && res4.stopped === "no-improvement" && res4.reverted.length === 1 && res4.pending.length === 2,
    `stopped=${res4.stopped}, pending=${res4.pending.length}`);
  check("failed repair rolled back byte-for-byte (clone-fixes.css removed, index.html restored)",
    !fs.existsSync(path.join(dir4, "clone-fixes.css")) && bytesUnchanged(dir4, before4, ["index.html", "styles/layout.css"]), "");
  const entry4 = readHistory(res4.historyPath)[0];
  check("revert recorded in history with reason", entry4.kept === false && /reverted/.test(entry4.reason), entry4.reason);

  // --------------------------------------------- [5] history + snapshots
  console.log("\n[5] repair-history — append-only JSONL + snapshot/restore round-trip");
  const dir5 = buildProject("history");
  const hPath = path.join(dir5, ".repair", "history.jsonl");
  appendHistory(hPath, { round: 1, action: { kind: "token-fix", target: ".cx-3" }, before: 0, after: 0.5, kept: true, reason: "improved" });
  appendHistory(hPath, { round: 2, action: { kind: "asset-remap", target: ".cx-5" }, before: 0.5, after: 1, kept: true, reason: "improved" });
  const entries5 = readHistory(hPath);
  check("append-only history: two appends → two entries in order", entries5.length === 2 && entries5[0].round === 1 && entries5[1].round === 2, "");
  const snap = snapshotProject(dir5, path.join(dir5, ".repair", "snapshots", "manual"));
  fs.writeFileSync(path.join(dir5, "index.html"), "MUTATED");
  fs.writeFileSync(path.join(dir5, "styles", "layout.css"), "MUTATED");
  fs.writeFileSync(path.join(dir5, "clone-fixes.css"), ".cx-3 { background-color: #0f1420 !important; }");
  restoreSnapshot(dir5, snap.dir);
  check("snapshot → mutate → restore round-trip (created file removed, edits undone)",
    readIn(dir5, "index.html") === INDEX_HTML && readIn(dir5, "styles/layout.css") === LAYOUT_CSS && !fs.existsSync(path.join(dir5, "clone-fixes.css")),
    `restored=[${snap.files.join(", ")}, styles/]`);

  // --------------------------------------------- [6] verifyOne injection
  console.log("\n[6] verifyOne overrides the checkFns dispatch");
  const dir6 = buildProject("verify-one");
  const seen = [];
  const fns6 = makeCheckFns();
  const res6 = await executeRepairs(dir6, planRepairs(DEFECTS, { assetMap: ASSET_MAP }).actions, {
    maxRounds: 3,
    // custom composite metric — verifyOne replaces the checkFns dispatch entirely;
    // it measures project STATE, so the score rises as each repair lands
    verifyOne: async (projectDir, action) => {
      seen.push(action ? action.kind : "baseline");
      return (await fns6.fidelity(projectDir)) + (await fns6.functional(projectDir));
    },
  });
  check("verifyOne used for baseline AND every action measurement",
    seen[0] === "baseline" && ["token-fix", "asset-remap", "interaction-rewire"].every((k) => seen.includes(k)),
    seen.join(", "));
  check("verifyOne-driven rounds kept + improved", res6.rounds.length === 3 && res6.applied.length === 3 && res6.improved, "");

  // --------------------------------- [7] unmeasurable actions never apply
  console.log("\n[7] actions without any check function are never applied");
  const dir7 = buildProject("no-checks");
  const before7 = bytesOf(dir7);
  const res7 = await executeRepairs(dir7, planRepairs(DEFECTS, { assetMap: ASSET_MAP }).actions, { checkFns: {} });
  check("empty checkFns → nothing applied, nothing measured",
    res7.rounds.length === 0 && res7.unverifiable.length === 3 && res7.stopped === "exhausted"
    && bytesUnchanged(dir7, before7, ["index.html", "styles/layout.css"]),
    `unverifiable=${res7.unverifiable.length}, stopped=${res7.stopped}`);

  // result record
  const outPath = path.join(ROOT, "artifacts", "test-autonomous-repair-result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    pass, fail,
    fullRun: {
      baseline: res.baseline, final: res.final, stopped: res.stopped,
      rounds: res.rounds.map((r) => ({ round: r.round, action: r.action, before: r.before, after: r.after, kept: r.kept, reason: r.reason })),
    },
    bounded: { stopped: res3.stopped, rounds: res3.rounds.length, pending: res3.pending.length },
    noImprovement: { stopped: res4.stopped, rounds: res4.rounds.length, rolledBack: !fs.existsSync(path.join(dir4, "clone-fixes.css")) },
    plan: plan.stats,
  }, null, 2));
  console.log(`\nresult written: ${outPath}`);
} finally {
  // nothing to tear down — pure fs fixtures under artifacts/
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
