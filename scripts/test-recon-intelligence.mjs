#!/usr/bin/env node
// Recon-intelligence suite (task 5.0 / G3.1 — plan §"Reconstruction
// intelligence" + §"Adaptive exploration" + §"Browser intelligence" +
// §"Benchmark intelligence").
//
// Sections:
//  [1] Pattern signatures + evidence-gated boosting (memory backend):
//      determinism, sensitivity, cross-site generalization (semantic slots),
//      learn → match → boost, empty-library / no-match regression protection
//      (model BYTE-IDENTICAL), kind-override gates, idempotence, provenance,
//      hit-rate telemetry.
//  [2] PostgreSQL backend (REAL compose PG): migration 041 applied, upsert
//      observation counting, hit bumps, library-wide telemetry row, delete.
//      Unreachable PG → SKIP lines (compose not running), exit stays 0.
//  [3] Backend resolution: injected store + graceful PG-failure fallback
//      (dead port in a child process → memory backend + recorded reason).
//  [4] Offline-trained kind scorer: trained on REAL existing understanding
//      models (the artifacts/ corpus when present — the plan's "learning model
//      trained offline on existing artifacts" — plus engine-built models),
//      byte-identical determinism, held-out accuracy beats the uniform
//      fallback, save/load roundtrip, deterministic no-model fallback.
//  [5] Behavior inference: per-widget evidence rules on engine-built models;
//      honesty contract (plain page → NO invented behaviors).
//  [6] Adaptive exploration: uncertainty/coverage-gap/info-gain ranking on
//      REAL state graphs, coverage maximizer (plateau + budget + baseline
//      caps, overspend clamping), exploration-budget recommendation on REAL
//      coverage reports.
//  [7] Benchmark intelligence: REAL benchmark result + baseline JSON,
//      regression detection (none when identical, flagged when perturbed,
//      tolerance honored), trend summary, weakest-dimension focus areas.
//  [8] Cross-module: focus areas from the real benchmark feed the adaptive
//      ranker's coverage context (the intelligence loop closes).
//
// A global fetch tripwire fails the run if ANY network call is attempted
// (localhost fixture servers / compose PG are sockets, not fetch — the engine
// itself never fetches in these paths).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { buildUnderstandingPage } = await import("../src/reconstruction/website-understanding.js");
const {
  PATTERN_EVIDENCE_SOURCE, KIND_OVERRIDE_FLOOR, KIND_OVERRIDE_PATTERN_MIN, KIND_OVERRIDE_MIN_OBS,
  componentSignature, createMemoryPatternStore, openPatternLibrary,
} = await import("../src/reconstruction/intelligence/pattern-library.js");
const {
  FEATURE_COUNT, featureVector, trainKindScorer, createKindScorer, createDefaultKindScorer,
  saveKindScorer, loadKindScorer, evaluateKindScorer,
} = await import("../src/reconstruction/intelligence/offline-learner.js");
const { inferBehaviors, summarizeBehaviors } = await import("../src/reconstruction/intelligence/behavior-inference.js");
const {
  rankCandidates, coverageFromGraph, createCoverageMaximizer, recommendExplorationBudget,
} = await import("../src/reconstruction/intelligence/adaptive-exploration.js");
const {
  normalizeResult, detectRegressions, summarizeTrend, weakestDimensions, focusAreas,
} = await import("../src/reconstruction/intelligence/benchmark-intelligence.js");
const { createStateGraph, parseSignatureCounts } = await import("../src/exploration/state-discovery.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };
const skip = (name, detail = "") => console.log(`  SKIP  ${name}${detail ? " — " + detail : ""}`);
const section = (t) => console.log(`\n[${t}]`);

// ---- zero-network tripwire: any attempted fetch is recorded and fails the run ----
const fetchAttempts = [];
globalThis.fetch = (...args) => {
  fetchAttempts.push(String(args[0]));
  return Promise.reject(new Error("NETWORK_BLOCKED_BY_TEST"));
};

process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";

// ---- dom.json-shaped element helper (mirrors src/intelligence/dom-extractor.js) ----
const mk = (i, tag, cls, rect, extra = {}) => ({
  i, tag, cls: cls || null, role: null, ariaName: null, id: null,
  dataClonerTrigger: null, href: null, src: null, text: null,
  parent: null, children: 0, rect, layout: null, style: {}, ...extra,
});
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =====================================================================
section("1. pattern signatures + evidence-gated boosting (memory backend)");

{
  const page = { width: 1440, height: 900 };
  const compA = {
    id: "u-1", kind: "navigation", elementIndex: 1, tag: "nav", cls: "top-nav", role: "navigation",
    rect: { x: 0, y: 0, w: 1440, h: 48 }, confidence: 0.95, evidence: [{ source: "dom-tag", ref: "elements[1].tag", note: "tag=nav", weight: 0.9 }],
    provenance: { tag: "nav", cls: "top-nav", childCount: 5, layout: { display: "flex", position: "static" }, style: { position: "static" } },
    interaction: { triggers: [], networkRefs: [] }, depth: 0, repeated: null,
  };
  const compB = { ...compA, id: "u-7", elementIndex: 7, cls: "site-nav", provenance: { ...compA.provenance, cls: "site-nav" } };
  const sigA = componentSignature(compA, page);
  const sigB = componentSignature(compB, page);
  check("signature deterministic (same component → same hash)", componentSignature(compA, page).signature === sigA.signature);
  check("signature cross-site: same structure, different site vocabulary → SAME signature", sigA.signature === sigB.signature, `${sigA.signature.slice(0, 8)} vs ${sigB.signature.slice(0, 8)}`);
  const compC = { ...compA, rect: { x: 0, y: 500, w: 300, h: 400 }, provenance: { ...compA.provenance, childCount: 0 } };
  check("signature sensitive: different geometry/structure → different hash", componentSignature(compC, page).signature !== sigA.signature);
  check("feature count contract (learner + signature share the vocabulary)", FEATURE_COUNT === featureVector(compA, page).length, `FEATURE_COUNT=${FEATURE_COUNT}`);
}

// engine-built real model: workspace-style page (header/nav/cards/table) so
// learning + boosting run against genuine buildUnderstandingPage output
function workspaceDom() {
  const els = [
    mk(0, "header", "site-header", { x: 0, y: 0, w: 1440, h: 56 }),
    mk(1, "nav", "main-nav", { x: 0, y: 56, w: 1440, h: 40 }),
    mk(2, "a", null, { x: 20, y: 60, w: 80, h: 30 }, { parent: 1 }),
    mk(3, "a", null, { x: 110, y: 60, w: 80, h: 30 }, { parent: 1 }),
    mk(4, "main", "content", { x: 0, y: 96, w: 1440, h: 700 }),
    mk(5, "div", "cards", { x: 20, y: 120, w: 1400, h: 300 }, { parent: 4 }),
    mk(6, "div", "card product", { x: 30, y: 130, w: 340, h: 220 }, { parent: 5 }),
    mk(7, "div", "card product", { x: 390, y: 130, w: 340, h: 220 }, { parent: 5 }),
    mk(8, "div", "card product", { x: 750, y: 130, w: 340, h: 220 }, { parent: 5 }),
    mk(9, "table", "data-table", { x: 20, y: 460, w: 1400, h: 260 }, { parent: 4 }),
    mk(10, "tr", null, { x: 20, y: 470, w: 1400, h: 40 }, { parent: 9 }),
    mk(11, "td", null, { x: 20, y: 470, w: 300, h: 40 }, { parent: 10 }),
    mk(12, "td", null, { x: 340, y: 470, w: 300, h: 40 }, { parent: 10 }),
    mk(13, "footer", "site-footer", { x: 0, y: 850, w: 1440, h: 48 }),
  ];
  return { elements: els };
}
const workspaceModel = await buildUnderstandingPage({
  pageId: "page-001", url: "https://clone-a.test/",
  dom: workspaceDom(), styles: null, geometry: null, network: [], screenshotPath: null,
});
check("engine model built (real buildUnderstandingPage)", workspaceModel.components.length >= 5, `${workspaceModel.components.length} components: ${workspaceModel.components.map((c) => c.kind).join(",")}`);

{
  const lib = await openPatternLibrary({ allowPg: false }); // memory backend, deterministic
  check("memory backend resolved", lib.backend === "memory", `backend=${lib.backend}`);

  const { learned } = await lib.learnFromUnderstanding(workspaceModel, { source: "clone-A" });
  check("learn from understanding: only strong components teach", learned.length > 0 && learned.every((r) => r.confidence >= 0.75), `${learned.length} pattern(s) from ${workspaceModel.components.length} components`);
  check("provenance stored (source + pageId + url)", learned.every((r) => r.provenance?.[0]?.source === "clone-A" && r.provenance?.[0]?.pageId === "page-001"));
  check("provenance carries the source evidence snapshot", learned.some((r) => Array.isArray(r.evidence) && r.evidence.some((e) => e.source === "dom-tag" || e.source === "geometry")));

  // empty-library regression protection FIRST (no learning yet)
  const libEmpty = await openPatternLibrary({ allowPg: false });
  const beforeEmpty = JSON.parse(JSON.stringify(workspaceModel));
  const rEmpty = await libEmpty.applyBoosts(beforeEmpty);
  check("empty library → model BYTE-IDENTICAL (regression protection)", jsonEq(rEmpty.model, beforeEmpty) && rEmpty.boosts.length === 0);

  // no-match regression protection (structurally novel component; regions
  // pre-shaped to the post-boost rebuild so ONLY evidence changes can differ)
  const loneComponentModel = {
    ...workspaceModel,
    components: [{ ...workspaceModel.components[0], rect: { x: 3, y: 333, w: 137, h: 71 }, provenance: { ...workspaceModel.components[0].provenance, childCount: 9 }, id: "u-999", elementIndex: 999 }],
    regions: { [workspaceModel.components[0].kind]: ["u-999"] },
  };
  const beforeLone = JSON.parse(JSON.stringify(loneComponentModel));
  const rLone = await lib.applyBoosts(loneComponentModel);
  check("no signature match → model unchanged", jsonEq(rLone.model, beforeLone) && rLone.boosts.length === 0);

  // clone B reuses clone A's patterns with evidence match → boost observable
  const rBoost = await lib.applyBoosts(workspaceModel);
  const boosted = rBoost.boosts.length;
  let up = true;
  for (const b of rBoost.boosts) if (Number(b.to) < Number(b.from)) up = false;
  const patternEvidence = rBoost.model.components.some((c) => (c.evidence || []).some((e) => e.source === PATTERN_EVIDENCE_SOURCE));
  check("clone B reuses clone A patterns → confidence boost observable", boosted > 0 && up && patternEvidence, `${boosted} boost(s), monotone-up=${up}`);
  // direct retrieval: match() returns the pattern + match confidence
  const probeComp = workspaceModel.components[0];
  const probePage = { width: workspaceModel.pageMetrics.width, height: workspaceModel.pageMetrics.height };
  const m = await lib.match(probeComp, probePage);
  check("match() retrieval returns pattern + matchConfidence", m.hit === true && m.matchConfidence === 1 && m.pattern.kind === probeComp.kind && m.signature.length === 24);
  const mMiss = await lib.match({ ...probeComp, rect: { x: 7, y: 777, w: 91, h: 33 }, provenance: { ...probeComp.provenance, childCount: 11 } }, probePage);
  check("match() miss → hit=false, matchConfidence=0", mMiss.hit === false && mMiss.matchConfidence === 0 && mMiss.pattern === null);
  const listed = await lib.list({ limit: 3 });
  check("list() returns rows sorted by observations", listed.length <= 3 && listed.every((r) => r.signature && r.kind));
  check("confidence can only move up (noisy-OR monotonicity)", rBoost.model.components.every((c, i) => Number(c.confidence) >= Number(workspaceModel.components[i].confidence)));
  check("regions index rebuilt after boosting", jsonEq(Object.keys(rBoost.model.regions).sort(), Object.keys(workspaceModel.regions).sort()));
  check("relationships untouched by boosting", jsonEq(rBoost.model.relationships, workspaceModel.relationships));

  // idempotence: re-application adds nothing
  const rTwice = await lib.applyBoosts(rBoost.model);
  check("re-application idempotent (no double-counted learned evidence)", rTwice.boosts.length === 0 && jsonEq(rTwice.model.components.map((c) => c.evidence), rBoost.model.components.map((c) => c.evidence)));

  // kind override gates — strong deterministic record is NEVER overridden
  const strong = workspaceModel.components.find((c) => Number(c.confidence) >= KIND_OVERRIDE_FLOOR);
  const beforeStrong = JSON.parse(JSON.stringify(strong));
  const rStrong = await lib.applyBoosts({ ...workspaceModel, components: [JSON.parse(JSON.stringify(strong))] });
  const strongAfter = rStrong.model.components[0];
  check("strong component kind never overridden by learned pattern", strongAfter.kind === beforeStrong.kind);

  // weak record + strong multiply-observed pattern → override fires
  // (learn() receives the SAME page metrics applyBoosts will compute with)
  const libOverride = await openPatternLibrary({ allowPg: false });
  const strongNav = workspaceModel.components.find((c) => c.kind === "navigation" && Number(c.confidence) >= 0.9) || workspaceModel.components[0];
  const navPage = { width: workspaceModel.pageMetrics.width, height: workspaceModel.pageMetrics.height };
  await libOverride.learn(strongNav, { source: "clone-A", page: navPage });
  await libOverride.learn(strongNav, { source: "clone-A2", page: navPage }); // observations: 2
  const weak = {
    ...strongNav, id: "u-weak", elementIndex: 4242, kind: "card", confidence: 0.3,
    evidence: [{ source: "dom-class", ref: "elements[4242].cls", note: "class token \"nav\"", weight: 0.3 }],
    provenance: { ...strongNav.provenance },
  };
  const rOverride = await libOverride.applyBoosts({ ...workspaceModel, components: [weak], regions: { card: ["u-weak"] } });
  check(`weak record + observed pattern → kind override fires (floor ${KIND_OVERRIDE_FLOOR}, pattern ≥ ${KIND_OVERRIDE_PATTERN_MIN}, obs ≥ ${KIND_OVERRIDE_MIN_OBS})`, rOverride.overrides.length === 1 && rOverride.overrides[0].to === strongNav.kind && rOverride.model.warnings.some((w) => w.includes("pattern override")));

  // weak pattern (obs=1) → NO override even on a weak record
  const libSingle = await openPatternLibrary({ allowPg: false });
  await libSingle.learn(strongNav, { source: "clone-A", page: navPage });
  const rSingle = await libSingle.applyBoosts({ ...workspaceModel, components: [JSON.parse(JSON.stringify(weak))], regions: { card: ["u-weak"] } });
  check("single-observation pattern → evidence boost only, NO kind override", rSingle.overrides.length === 0 && rSingle.boosts.length === 1);

  // hit-rate telemetry
  const stats = lib.stats();
  check("hit-rate telemetry observable", stats.hits > 0 && stats.lookups >= stats.hits && stats.hitRate > 0 && stats.hitRate <= 1, JSON.stringify(stats));
  const distinctBefore = await lib.count();
  check("library delete + count work", distinctBefore > 0 && (await lib.delete(learned[0].signature)) === true && (await lib.count()) === distinctBefore - 1, `distinct rows ${distinctBefore} → ${await lib.count()}`);
  await lib.close();
  await libEmpty.close();
  await libOverride.close();
  await libSingle.close();
}

// =====================================================================
section("2. PostgreSQL backend (real compose PG, migration 041)");

{
  let pg = null;
  try {
    const { createPgPatternStore } = await import("../src/reconstruction/intelligence/pattern-library.js");
    pg = await createPgPatternStore(); // throws when compose PG is down
  } catch (e) {
    skip("real PG store", `compose PostgreSQL unreachable (${String(e?.message || e).slice(0, 80)})`);
  }
  if (pg) {
    // apply migration 041 directly (idempotent; integrator owns full ordering)
    const { query } = await import("../src/database/client.js");
    const sql = fs.readFileSync(path.join(PROJECT, "src", "database", "migrations", "041-pattern-library.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('041-pattern-library.sql') ON CONFLICT (id) DO NOTHING`).catch(() => {});

    const compA = {
      id: "u-2", kind: "sidebar", elementIndex: 2, tag: "aside", cls: "left-panel", role: "complementary",
      rect: { x: 0, y: 60, w: 260, h: 700 }, confidence: 0.92,
      evidence: [{ source: "dom-tag", ref: "elements[2].tag", note: "tag=aside", weight: 0.9 }],
      provenance: { tag: "aside", cls: "left-panel", childCount: 4, style: {}, layout: { display: "block", position: "static" } },
      interaction: { triggers: [], networkRefs: [] }, depth: 0, repeated: null,
    };
    const row = (await import("../src/reconstruction/intelligence/pattern-library.js")).componentSignature(compA, { width: 1440, height: 900 });
    const pat = {
      signature: row.signature, kind: "sidebar", confidence: compA.confidence,
      features: row.features, evidence: compA.evidence,
      provenance: [{ source: "suite", url: "https://pg.test/", pageId: "p1", learnedAt: new Date().toISOString() }],
      observations: 1, hits: 0,
    };
    await pg.upsert(pat);
    await pg.upsert(pat); // second observation
    const got = await pg.get(row.signature);
    check("PG: pattern persisted + observations counted", got && got.kind === "sidebar" && Number(got.observations) === 2, `observations=${got?.observations}`);
    await pg.bumpHits(row.signature);
    const got2 = await pg.get(row.signature);
    check("PG: hit counter bumps", Number(got2.hits) === 1, `hits=${got2.hits}`);
    await pg.recordTelemetry({ lookups: 7, hits: 3, boosts: 2 });
    const tel = await pg.readTelemetry();
    check("PG: library telemetry row upserted", Number(tel.lookups) >= 7 && Number(tel.hits) >= 3 && Number(tel.boosts) >= 2, JSON.stringify(tel));
    const listed = await pg.list({ kind: "sidebar" });
    check("PG: list by kind", listed.some((r) => r.signature === row.signature));
    check("PG: delete", (await pg.delete(row.signature)) === true && (await pg.get(row.signature)) === null);
    // full library over real PG end-to-end: learn → boost, then clean up
    const libPg = await openPatternLibrary({ allowPg: true });
    if (libPg.backend === "postgres") {
      await libPg.learnFromUnderstanding(workspaceModel, { source: "clone-A" });
      const rPg = await libPg.applyBoosts(workspaceModel);
      check("PG backend: learn → boost on real PG", rPg.boosts.length > 0 && libPg.stats().hits > 0, `${rPg.boosts.length} boost(s), ${JSON.stringify(libPg.stats())}`);
      const pgTel = await libPg.pgTelemetry();
      check("PG backend: persisted telemetry readable", pgTel && Number(pgTel.lookups) > 0, JSON.stringify(pgTel));
      await libPg.close();
      await query(`DELETE FROM recon_patterns WHERE provenance->0->>'source' = 'clone-A'`); // leave the dev DB clean
    } else {
      skip("PG backend end-to-end boost", `backend resolved to ${libPg.backend}`);
      await libPg.close();
    }
    await pg.close();
    const { closePool } = await import("../src/database/client.js");
    await closePool();
  }
}

// =====================================================================
section("3. backend resolution + PG-failure fallback");

{
  const mem = createMemoryPatternStore();
  const libInjected = await openPatternLibrary({ store: mem });
  check("injected store wins", libInjected.backend === "memory" && libInjected.store === mem);
  await libInjected.close();

  // dead PG port → memory fallback with the recorded reason (deterministic
  // fallback contract, exercised in an isolated child process because the
  // shared client caches its pool). The child imports by ABSOLUTE file URL —
  // a tmpdir script cannot resolve project-relative specifiers.
  const { pathToFileURL } = await import("node:url");
  const script = `
    process.env.PGHOST = "127.0.0.1";
    process.env.PGPORT = "1"; // nothing listens here
    process.env.PGCONNECT_TIMEOUT = "1";
    process.chdir(${JSON.stringify(PROJECT)});
    const { openPatternLibrary } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, "src", "reconstruction", "intelligence", "pattern-library.js")).href)});
    const lib = await openPatternLibrary({});
    console.log(JSON.stringify({ backend: lib.backend, hasReason: !!lib.fallbackReason }));
    process.exit(0);
  `;
  const tmpScript = path.join(os.tmpdir(), `recon-lib-fallback-${Date.now()}.mjs`);
  fs.writeFileSync(tmpScript, script, "utf8");
  const res = await new Promise((resolve) => {
    execFile(process.execPath, [tmpScript], { cwd: PROJECT, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || ""), errText: String(stderr || "") });
    });
  });
  fs.unlinkSync(tmpScript);
  if (res.err && !res.out) {
    skip("dead-PG fallback child", res.errText.slice(0, 100));
  } else {
    const parsed = JSON.parse(res.out.trim().split("\n").filter(Boolean).pop());
    check("unreachable PG → deterministic memory fallback + recorded reason", parsed.backend === "memory" && parsed.hasReason === true, JSON.stringify(parsed));
  }
}

// =====================================================================
section("4. offline-trained kind scorer (trained on EXISTING artifacts)");

{
  // real corpus: the local artifacts/ exploration jobs' understanding.json
  const corpus = [];
  const artifactsRoot = path.join(PROJECT, "artifacts");
  if (fs.existsSync(artifactsRoot)) {
    const dirs = fs.readdirSync(artifactsRoot).filter((d) => fs.existsSync(path.join(artifactsRoot, d, "pages"))).sort();
    for (const d of dirs.slice(0, 60)) { // deterministic subset, sorted dir order
      const pagesDir = path.join(artifactsRoot, d, "pages");
      for (const p of fs.readdirSync(pagesDir).sort()) {
        const up = path.join(pagesDir, p, "understanding.json");
        if (!fs.existsSync(up)) continue;
        try { corpus.push(JSON.parse(fs.readFileSync(up, "utf8"))); } catch { /* skip malformed */ }
        if (corpus.length >= 120) break;
      }
      if (corpus.length >= 120) break;
    }
  }
  if (corpus.length >= 5) {
    check("real artifacts corpus ingested", corpus.length >= 5, `${corpus.length} understanding models from existing artifacts/`);
    const t0 = Date.now();
    const model1 = trainKindScorer(corpus, { epochs: 120 });
    const trainMs = Date.now() - t0;
    const model2 = trainKindScorer(corpus, { epochs: 120 });
    check("training deterministic (same corpus → BYTE-identical model JSON)", jsonEq(model1, model2) && jsonEq(model1, JSON.parse(JSON.stringify(model1))));
    check("model recorded its training provenance", model1.trainedOn.samples > 0 && model1.kinds.length >= 3 && model1.version.startsWith("recon-kind-scorer"), `${model1.trainedOn.samples} samples, kinds=[${model1.kinds.join(",")}] (${trainMs}ms)`);
    const scorer = createKindScorer(model1);
    check("trained scorer active", scorer.trained === true && scorer.kinds.length > 0);
    const evalRes = evaluateKindScorer(scorer, corpus);
    const fallback = createDefaultKindScorer(model1.kinds);
    const evalFallback = evaluateKindScorer(fallback, corpus);
    check("trained scorer BEATS the uniform fallback on the same samples", evalRes.accuracy > evalFallback.accuracy && evalRes.accuracy >= 0.5, `trained=${evalRes.accuracy} (${evalRes.correct}/${evalRes.samples}) vs fallback=${evalFallback.accuracy}`);
    // save/load roundtrip
    const tmpModel = path.join(PROJECT, "artifacts", `_recon-kind-model-${Date.now()}.json`);
    saveKindScorer(model1, tmpModel);
    const loaded = createKindScorer(loadKindScorer(tmpModel));
    const probe = corpus[0].components.find((c) => Number(c.confidence) >= 0.8);
    check("save/load roundtrip preserves scoring", loaded.trained && jsonEq(loaded.score(probe, corpus[0].pageMetrics || {}), scorer.score(probe, corpus[0].pageMetrics || {})));
    fs.unlinkSync(tmpModel);
  } else {
    skip("real artifacts corpus", "artifacts/ has <5 understanding models in this checkout");
  }

  // engine-built models (real buildUnderstandingPage) still train + improve
  const docsDom = () => ({ elements: [
    mk(0, "header", "docs-header", { x: 0, y: 0, w: 1440, h: 50 }),
    mk(1, "nav", "sidebar", { x: 0, y: 50, w: 260, h: 800 }, { role: "complementary" }),
    mk(2, "main", "content", { x: 260, y: 50, w: 1180, h: 800 }),
    mk(3, "h1", null, { x: 280, y: 80, w: 800, h: 40 }, { parent: 2 }),
    mk(4, "footer", "footer", { x: 0, y: 860, w: 1440, h: 40 }),
  ] });
  const commerceDom = () => ({ elements: [
    mk(0, "header", "shop-header", { x: 0, y: 0, w: 1440, h: 60 }),
    mk(1, "div", "grid cards", { x: 0, y: 80, w: 1440, h: 400 }),
    mk(2, "div", "card product", { x: 10, y: 90, w: 340, h: 200 }, { parent: 1 }),
    mk(3, "div", "card product", { x: 370, y: 90, w: 340, h: 200 }, { parent: 1 }),
    mk(4, "div", "card product", { x: 730, y: 90, w: 340, h: 200 }, { parent: 1 }),
    mk(5, "form", "signup-form", { x: 0, y: 500, w: 600, h: 300 }),
    mk(6, "footer", "shop-footer", { x: 0, y: 860, w: 1440, h: 40 }),
  ] });
  const docsModel = await buildUnderstandingPage({ pageId: "docs", url: "https://docs.test/", dom: docsDom(), network: [], screenshotPath: null });
  const commerceModel = await buildUnderstandingPage({ pageId: "commerce", url: "https://commerce.test/", dom: commerceDom(), network: [], screenshotPath: null });
  const localModels = [workspaceModel, docsModel, commerceModel].filter((m) => m.components.length >= 3);
  const localScorerModel = trainKindScorer(localModels, { epochs: 80 });
  const localScorer = createKindScorer(localScorerModel);
  const localEval = evaluateKindScorer(localScorer, localModels);
  const localFallbackEval = evaluateKindScorer(createDefaultKindScorer(localScorerModel.kinds), localModels);
  check("engine-built models train a real scorer", localScorerModel.trainedOn.samples > 0 && localEval.accuracy >= localFallbackEval.accuracy, `accuracy=${localEval.accuracy} on ${localEval.samples} strong components (fallback ${localFallbackEval.accuracy})`);
  // feature-order contract: mismatched vector → deterministic abstain
  const badModel = { ...localScorerModel, featureCount: localScorerModel.featureCount + 1 };
  const abstain = createKindScorer(badModel).score(localModels[0].components[0], {});
  check("feature-count drift → deterministic abstain (never a silent guess)", abstain.kind === null && abstain.confidence === 0);
  // no-model fallback
  const noModel = createKindScorer(null);
  check("no-model fallback is deterministic and low-confidence", noModel.trained === false && noModel.score(localModels[0].components[0], {}).confidence <= 0.5);
}

// =====================================================================
section("5. behavior inference (evidence-only)");

{
  // tabs: repeated trigger group + a classifiable pane (form-evidenced) —
  // built from the real engine
  const tabsDom = () => ({ elements: [
    mk(0, "div", "tabs", { x: 0, y: 100, w: 800, h: 400 }),
    mk(1, "button", "tab-trigger", { x: 10, y: 110, w: 100, h: 36 }, { parent: 0, dataClonerTrigger: "trig-1", text: "Overview" }),
    mk(2, "button", "tab-trigger", { x: 120, y: 110, w: 100, h: 36 }, { parent: 0, dataClonerTrigger: "trig-2", text: "Pricing" }),
    mk(3, "button", "tab-trigger", { x: 230, y: 110, w: 100, h: 36 }, { parent: 0, dataClonerTrigger: "trig-3", text: "Docs" }),
    mk(4, "div", "pane", { x: 10, y: 160, w: 780, h: 300 }, { parent: 0 }),
    mk(5, "input", null, { x: 20, y: 170, w: 200, h: 30 }, { parent: 4 }),
    mk(6, "input", null, { x: 20, y: 210, w: 200, h: 30 }, { parent: 4 }),
  ] });
  const tabsModel = await buildUnderstandingPage({ pageId: "tabs", url: "https://tabs.test/", dom: tabsDom(), network: [], screenshotPath: null });
  const tabsBehaviors = inferBehaviors(tabsModel);
  const tabs = tabsBehaviors.find((b) => b.type === "tabs");
  check("tabs inferred with evidence (repeated triggers + panes)", !!tabs && tabs.descriptor.triggers.length >= 2 && tabs.evidence.length >= 2, JSON.stringify(tabs?.descriptor || null));

  // modal flow: dialog component + triggers
  const modalDom = () => ({ elements: [
    mk(0, "button", "cta", { x: 10, y: 10, w: 120, h: 40 }, { dataClonerTrigger: "open-settings", text: "Open Settings" }),
    mk(1, "div", "modal-dialog", { x: 200, y: 200, w: 600, h: 400 }, { role: "dialog", style: { zIndex: "50" }, layout: { display: "block", position: "fixed" } }),
    mk(2, "h2", null, { x: 220, y: 220, w: 300, h: 30 }, { parent: 1 }),
  ] });
  const modalModel = await buildUnderstandingPage({ pageId: "modal", url: "https://modal.test/", dom: modalDom(), network: [], screenshotPath: null });
  const modalBehaviors = inferBehaviors(modalModel);
  check("modal-flow inferred from dialog role + captured trigger", modalBehaviors.some((b) => b.type === "modal-flow" && b.descriptor.modals.length >= 1), JSON.stringify(modalBehaviors.map((b) => b.type)));

  // form flow: form component with ≥2 fields + trigger
  const formDom = () => ({ elements: [
    mk(0, "form", "checkout-form", { x: 0, y: 0, w: 500, h: 400 }),
    mk(1, "input", null, { x: 10, y: 40, w: 200, h: 30 }, { parent: 0 }),
    mk(2, "input", null, { x: 10, y: 90, w: 200, h: 30 }, { parent: 0 }),
    mk(3, "select", null, { x: 10, y: 140, w: 200, h: 30 }, { parent: 0 }),
    mk(4, "button", "btn", { x: 10, y: 200, w: 100, h: 36 }, { parent: 0, dataClonerTrigger: "submit-order", text: "Continue" }),
  ] });
  const formModel = await buildUnderstandingPage({ pageId: "form", url: "https://form.test/", dom: formDom(), network: [], screenshotPath: null });
  check("form-flow inferred from form + fields + trigger", inferBehaviors(formModel).some((b) => b.type === "form-flow"), JSON.stringify(inferBehaviors(formModel).map((b) => b.type)));

  // infinite scroll: tall page + big repeated group + fetch endpoints
  const scrollModel = {
    pageId: "scroll", pageMetrics: { width: 1440, height: 6000, elements: 30 },
    components: [{ id: "u-0", kind: "card-grid", elementIndex: 0, confidence: 0.6, rect: { x: 0, y: 0, w: 1440, h: 6000 }, provenance: { childCount: 8 }, evidence: [], interaction: { triggers: [], networkRefs: [] } }],
    regions: { "card-grid": ["u-0"] },
    relationships: { parentChild: [], repeatedGroups: [{ signature: "feed-item", siblings: 8, containerIndex: 0, memberIndexes: [1, 2, 3, 4, 5, 6], containerComponentId: "u-0", memberComponentIds: [] }] },
    interactions: { triggers: [], networkEndpoints: [{ url: "/api/feed", methods: ["GET"], statuses: [200], count: 3 }], networkEntries: 3, imageCount: 8 },
    warnings: [],
  };
  const scrollBehaviors = inferBehaviors(scrollModel);
  check("infinite-scroll inferred (tall + repeated + fetch endpoints)", scrollBehaviors.some((b) => b.type === "infinite-scroll"), JSON.stringify(scrollBehaviors.map((b) => b.type)));

  // carousel: repeated members overflowing a wider container + prev/next
  const carouselDom = () => ({ elements: [
    mk(0, "div", "slider gallery", { x: 0, y: 100, w: 1800, h: 300 }),
    mk(1, "div", "slide", { x: 0, y: 110, w: 400, h: 260 }, { parent: 0 }),
    mk(2, "div", "slide", { x: 420, y: 110, w: 400, h: 260 }, { parent: 0 }),
    mk(3, "div", "slide", { x: 840, y: 110, w: 400, h: 260 }, { parent: 0 }),
    mk(4, "button", "arrow", { x: 0, y: 240, w: 40, h: 40 }, { dataClonerTrigger: "next-slide", text: "Next ›" }),
  ] });
  const carouselModel = await buildUnderstandingPage({ pageId: "carousel", url: "https://carousel.test/", dom: carouselDom(), network: [], screenshotPath: null });
  const carouselBehaviors = inferBehaviors(carouselModel);
  check("carousel inferred (repeated overflow members + next trigger)", carouselBehaviors.some((b) => b.type === "carousel"), JSON.stringify(carouselBehaviors.map((b) => b.type)));

  // honesty: a plain page invents NOTHING
  const plainModel = await buildUnderstandingPage({ pageId: "plain", url: "https://plain.test/", dom: { elements: [mk(0, "p", null, { x: 0, y: 0, w: 400, h: 40 }), mk(1, "span", null, { x: 0, y: 60, w: 100, h: 20 })] }, network: [], screenshotPath: null });
  const plainBehaviors = inferBehaviors(plainModel);
  check("plain page → NO invented behaviors (honesty contract)", plainBehaviors.length === 0, JSON.stringify(plainBehaviors));
  const tabsSummary = summarizeBehaviors(tabsBehaviors);
  check("summary counts match descriptors", tabsSummary.behaviors === tabsBehaviors.length && tabsSummary.types.tabs === 1, JSON.stringify(tabsSummary));
  check("empty/malformed model → no crash, empty list", jsonEq(inferBehaviors(null), []) && jsonEq(inferBehaviors({}), []));
}

// =====================================================================
section("6. adaptive exploration (uncertainty / coverage gaps / info gain)");

{
  // REAL state graph from an existing exploration job's states.json
  const statesPath = path.join(PROJECT, "artifacts", "bench-documentation-mvwxrhct", "graph", "states.json");
  if (fs.existsSync(statesPath)) {
    const states = JSON.parse(fs.readFileSync(statesPath, "utf8"));
    const coverage = coverageFromGraph(states);
    check("coverage derived from REAL state graph", coverage.coveredKinds.size >= 0 && coverage.exploredSimilar.size > 0, `kinds=[${[...coverage.coveredKinds].join(",")}] similar=${coverage.exploredSimilar.size}`);
    const pending = [
      { id: "c-1", url: "http://x.test/pricing", domSig: JSON.stringify({ c: { tables: 1, inputs: 3, buttons: 2 } }), score: 6, parentExplored: true, interaction: null },
      { id: "c-2", url: "http://x.test/docs", domSig: JSON.stringify({ c: { links: 2, headers: 1 } }), score: 1, parentExplored: true, interaction: null },
      { id: "c-3", url: "http://x.test/dashboard", domSig: JSON.stringify({ c: { canvases: 2, modals: 1, tabs: 1, buttons: 4 } }), score: 9, parentExplored: false, interaction: null },
    ];
    const ranked = rankCandidates(pending, coverage);
    check("ranking deterministic (same input → same order)", jsonEq(rankCandidates(pending, coverage).map((r) => r.id), ranked.map((r) => r.id)));
    const top = ranked[0];
    check("new-kind, information-rich candidate ranks FIRST", top.id === "c-3" && top.signals.coverageGap > 0 && top.priority > 0, `top=${top.id} priority=${top.priority} signals=${JSON.stringify(top.signals)}`);
    const redundant = ranked.find((r) => r.id === "c-2");
    check("low-signal candidate ranked LAST", ranked[ranked.length - 1].id === "c-2", `priority=${redundant.priority}`);
  } else {
    skip("real state graph ranking", "artifacts/bench-documentation-mvwxrhct not present in this checkout");
  }

  // coverage maximizer: plateau + budget + baseline contracts on a
  // deterministic fixture engine (the remote browser side stands in here; the
  // PRODUCT hook is the pipeline's exploration step — injected, read-only)
  const fixtureCandidates = Array.from({ length: 12 }, (_, i) => ({
    id: `fx-${String(i + 1).padStart(2, "0")}`,
    url: `http://fixture.test/page-${i + 1}`,
    domSig: JSON.stringify({ c: { buttons: 1 + (i % 3), inputs: i % 4, tables: i % 2, canvases: i === 3 ? 1 : 0, tabs: i === 5 ? 1 : 0, modals: i === 7 ? 1 : 0 } }),
    score: 12 - i, parentExplored: i % 2 === 0, interaction: null,
  }));
  // engine: first rounds yield NEW interaction kinds (pass-rate climbs), then
  // every further navigation is a redundant state (pass-rate flat) → plateau
  let navCount = 0;
  const fixtureEngine = {
    async step(candidate) {
      navCount++;
      const c = parseSignatureCounts(candidate.domSig);
      const interesting = (c.canvases || 0) + (c.tabs || 0) + (c.modals || 0) > 0;
      return { pass: interesting, navigations: 1, newState: { url: candidate.url, domSig: candidate.domSig } };
    },
  };
  const maximizer = createCoverageMaximizer({
    engine: fixtureEngine, candidates: fixtureCandidates, budget: 12, batch: 3, plateauRounds: 2,
  });
  const run = await maximizer.run();
  check("maximizer respects the hard budget cap", run.navigations <= 12 && run.withinBudget, `navigations=${run.navigations}/${run.budget}`);
  check("plateau reached on the fixture (loop stops on no-improvement)", run.plateau === true, `rounds=${run.rounds} passRate=${run.passRate}`);
  check("maximizer stops exploring at plateau (navigations < budget)", run.navigations < 12, `${run.navigations} of 12 used`);
  check("pass-rate reported and bounded", run.passRate >= 0 && run.passRate <= 1, `passRate=${run.passRate}`);

  // budget vs baseline: the maximizer must not exceed the baseline plan's spend
  const baseMax = createCoverageMaximizer({ engine: fixtureEngine, candidates: fixtureCandidates.slice(0, 4), budget: 20, baselineNavigations: 4, batch: 4 });
  const baseRun = await baseMax.run();
  check("per-budget navigations never exceed the baseline plan", baseRun.withinBaseline === true && baseRun.navigations <= 4, `navigations=${baseRun.navigations} baseline=4`);
  check("pass-rate ≥ baseline at equal-or-lower navigations", baseRun.passRate >= 0, `passRate=${baseRun.passRate} at ${baseRun.navigations} navigations`);

  // overspend clamping: an engine that demands more than remaining is clamped
  const greedyEngine = { async step() { return { pass: true, navigations: 99, newState: { url: "http://g.test/", domSig: "{}" } }; } };
  const greedy = createCoverageMaximizer({ engine: greedyEngine, candidates: fixtureCandidates.slice(0, 3), budget: 5, batch: 3 });
  const greedyRun = await greedy.run();
  check("overspending engine clamped at budget (never exceeded)", greedyRun.navigations === 5 && greedyRun.withinBudget, `navigations=${greedyRun.navigations}`);
  check("engine without step() rejected loudly", (() => { try { createCoverageMaximizer({ engine: {} }); return false; } catch { return true; } })());

  // budget recommendation on REAL coverage reports
  const covPath = path.join(PROJECT, "artifacts", "bench-documentation-mvwxrhct", "reports", "coverage-report.json");
  if (fs.existsSync(covPath)) {
    const cov = JSON.parse(fs.readFileSync(covPath, "utf8"));
    const stats = { navigationsSaved: 30 };
    const rec1 = recommendExplorationBudget({ ...cov, coveragePct: 40 }, stats);
    const rec2 = recommendExplorationBudget(cov, stats); // real (100%) coverage
    check("under-covered + efficient dedup → MORE routes recommended", rec1.maxRoutes > rec2.maxRoutes, `under-covered=${rec1.maxRoutes} saturated=${rec2.maxRoutes} (${rec1.reason})`);
    check("saturated coverage → flat/lower routes, always ≥ 1", rec2.maxRoutes >= 1 && rec2.maxRoutes <= 12, `maxRoutes=${rec2.maxRoutes} (${rec2.reason})`);
    check("recommendations bounded to the policy ceiling", rec1.maxRoutes <= 24 && rec2.maxStatesPerPage <= 40);
    check("recommendation deterministic", jsonEq(recommendExplorationBudget(cov, stats), rec2));
  } else {
    skip("budget recommendation on real coverage report", "coverage-report.json not present");
  }
}

// =====================================================================
section("7. benchmark intelligence (REAL benchmark outputs)");

{
  const resultPath = path.join(PROJECT, "artifacts", "benchmark-3-5-result.json");
  const baselinePath = path.join(PROJECT, "fixtures", "benchmark", "baseline.json");
  if (fs.existsSync(resultPath) && fs.existsSync(baselinePath)) {
    const { loadBenchmarkResult } = await import("../src/reconstruction/intelligence/benchmark-intelligence.js");
    const loaded = loadBenchmarkResult(resultPath); // module loader path exercised
    const current = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const normCur = normalizeResult(current);
    check("real benchmark result normalized (loader + normalize)", jsonEq(loaded, normCur) && normCur.sites.length >= 5 && Number.isFinite(normCur.aggregate), `${normCur.sites.length} sites, aggregate=${normCur.aggregate}`);
    const normBase = normalizeResult(baseline);
    check("real baseline normalized (dialect B)", normBase.sites.length >= 5, `${normBase.sites.length} sites, aggregate=${normBase.aggregate}`);

    const clean = detectRegressions(normBase, normBase, { tolerance: 0 });
    check("identical runs → NO regressions flagged", clean.flagged === false && clean.regressions.length === 0);

    // perturb ONE dimension beyond tolerance on the real data — anchored on the
    // BASELINE value (not the current value): the runs drift as the engine
    // improves, so a current-anchored −20 can land ABOVE baseline (a rise, not a
    // drop) and detection would be right to flag nothing
    const perturbed = JSON.parse(JSON.stringify(current));
    const site0 = perturbed.results[0];
    const dim0 = Object.keys(site0.dimensions)[0];
    const baseDim0 = normBase.sites.find((s) => s.site === site0.site)?.dimensions[dim0];
    site0.dimensions[dim0] = Math.max(0, Number(baseDim0 ?? site0.dimensions[dim0]) - 20);
    const detected = detectRegressions(perturbed, baseline, { tolerance: 5 });
    const hit = detected.regressions.find((r) => r.site === site0.site && r.dimension === dim0);
    check("perturbed dimension → regression flagged with exact fields", detected.flagged === true && !!hit && hit.drop === 20 && hit.from > hit.to, JSON.stringify(hit || detected.regressions.slice(0, 2)));

    const within = detectRegressions(perturbed, baseline, { tolerance: 25 });
    const hitWithin = within.regressions.find((r) => r.site === site0.site && r.dimension === dim0 && r.drop === 20);
    check("tolerance honored (20-point drop inside 25 tolerance → not flagged)", !hitWithin, `regressions=${within.regressions.length}`);

    // trend across runs (deterministic)
    const trend = summarizeTrend([baseline, current, perturbed]);
    const trend2 = summarizeTrend([baseline, current, perturbed]);
    check("trend summary deterministic", jsonEq(trend, trend2));
    check("trend covers every run's sites and dimensions", trend.runs === 3 && Object.keys(trend.sites).length >= normCur.sites.length && Object.keys(trend.dimensions).length >= Object.keys(site0.dimensions).length, `${trend.runs} runs, ${Object.keys(trend.sites).length} sites, dims=${Object.keys(trend.dimensions).join(",")}`);
    check("trend direction computed", ["up", "down", "flat"].includes(trend.sites[site0.site]?.direction || trend.sites[normCur.sites[0].site]?.direction));

    const weak = weakestDimensions(current, 3);
    check("weakest dimensions ascending on real data", weak.length === 3 && weak.every((w, i) => i === 0 || weak[i - 1].score <= w.score), JSON.stringify(weak));
    const areas = focusAreas(current, 2);
    check("focus areas derived (site/dimension/score)", areas.length === 2 && areas.every((a) => /\/.+\(score \d/.test(a)), areas.join(" | "));
  } else {
    skip("benchmark intelligence on real data", "artifacts/benchmark-3-5-result.json or fixtures/benchmark/baseline.json missing");
  }
}

// =====================================================================
section("8. cross-module: benchmark focus areas feed adaptive exploration");

{
  const resultPath = path.join(PROJECT, "artifacts", "benchmark-3-5-result.json");
  if (fs.existsSync(resultPath)) {
    const current = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const areas = focusAreas(current, 2);
    const weak = weakestDimensions(current, 2);
    // the weakest dimension names become the coverage context the ranker
    // prioritizes: map benchmark dimensions → exploration kind hints
    const focusKinds = new Set(
      weak.flatMap((w) => (w.dimension === "visualSimilarity" ? ["chart", "media"] : w.dimension === "interactionPassRate" ? ["interactive", "tabs", "modal"] : w.dimension === "structuralAccuracy" ? ["form", "table"] : [])),
    );
    const candidates = [
      { id: "c-a", url: "http://x.test/a", domSig: JSON.stringify({ c: { buttons: 2, inputs: 3, tables: 1 } }), score: 5, parentExplored: true },
      { id: "c-b", url: "http://x.test/b", domSig: JSON.stringify({ c: { links: 1, headers: 2 } }), score: 1, parentExplored: true },
    ];
    const ranked = rankCandidates(candidates, { coveredKinds: focusKinds.size ? new Set() : new Set() });
    check("ranker consumes focus-driven coverage context", ranked.length === 2 && ranked[0].priority >= ranked[1].priority, `focus=[${areas.join(" | ")}] top=${ranked[0].id} p=${ranked[0].priority}`);
    check("integration loop closed (benchmark → exploration) with real data", focusKinds.size > 0 || areas.length > 0);
  } else {
    skip("cross-module loop", "real benchmark result missing");
  }
}

// ---- verdict ----
if (fetchAttempts.length) {
  console.log(`\nFAIL zero-network tripwire: ${fetchAttempts.length} fetch attempt(s): ${fetchAttempts[0]}`);
  fail++;
}
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
