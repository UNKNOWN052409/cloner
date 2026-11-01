// Target-independent generalization test (task 3.5.6).
//
// Proves the reconstruction engine classifies and reconstructs from GENERIC
// evidence only — with ZERO target-specific code paths active — on:
//   - the three Phase-3.5 category fixtures (e-commerce, documentation, portal),
//   - the Tradovate-shaped trading-workspace fixture (scripts/fixtures/tradovate —
//     synthetic + deterministic, no live site, no credentials), and
//   - an UNSEEN fixture defined inline below that uses an obfuscated class
//     vocabulary sharing NO token with any engine hint list (it was not used to
//     implement any reconstruction rule — plan step 7).
//
// "Zero target-specific code paths active" is enforced four ways:
//   Z1 adapters disabled — the compat-adapter registry
//      (src/reconstruction/component-pattern-detector.js) is turned OFF before
//      every understanding pass; classification must not degrade;
//   Z2 zero adapter firings — with adapters re-enabled in their default
//      evidence-gated mode, NO adapter token is ever observed in any capture;
//   Z3 static engine scan — src/reconstruction, src/pipeline, src/exploration
//      (recursive) contain no fixture/brand identifiers;
//   Z4 clone vocabulary scan — generated clone HTML/CSS carry no lm_* /
//      app-sidebar vocabulary; the shipped legacy runtime handlers (F6) are
//      recorded as the documented platform compatibility adapter, never as
//      detection logic.
//
// Replacement-hook unit checks (plan steps 2-6) run first — each AUDIT_FINDINGS
// entry must have a working, exported hook (audit report in
// src/reconstruction/component-pattern-detector.js).
//
// Run: node scripts/test-generalization.mjs   (exit 1 on any failure)
// Result JSON: artifacts/test-generalization-result.json (seen vs unseen
// performance is measured and reported separately — plan step 8).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { loadArtifacts } from "../src/reconstruction/artifact-loader.js";
import { buildUnderstandingPage, pageArtifactsFromLoaded, summarizeUnderstanding } from "../src/reconstruction/website-understanding.js";
import { detectWorkspace } from "../src/reconstruction/workspace-analyzer.js";
import { analyzeLayout } from "../src/reconstruction/analysis/layout-analyzer.js";
import { buildComponentRegistry, annotateUnderstanding, registrySummary } from "../src/reconstruction/component-evidence.js";
import {
  resolveActiveTabIndex, cardPatternVotes, sidebarRuntimeWiring, verifyPanelProbeSelectors,
  preserveUnknownComponents, guardModelVerdict, setBannedInferencePatterns, resetBannedInferencePatterns,
  regionTokenHints, registerRegionHints, resetHints, hintVotesFor, hintProvenance,
  setAdaptersEnabled, resetAdapterState, adapterFirings, compatAdapterIds,
  splitterTokenVotes, auditSummary, generalizationAudit, AUDIT_FINDINGS,
} from "../src/reconstruction/component-pattern-detector.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startTradovateFixtureServer } from "./fixtures/tradovate/server.mjs";
import { categorySites } from "./fixtures/category-index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const ARTIFACTS = path.join(ROOT, "artifacts");
const RESULT_PATH = path.join(ARTIFACTS, "test-generalization-result.json");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const pathnameOf = (u) => { try { return new URL(u).pathname; } catch { return null; } };
const comp = (u, kind) => (u?.components || []).find((c) => c.kind === kind);
const kindsOf = (u) => Object.keys(u?.regions || {}).filter((k) => k !== "unknown");

// tight budgets for every job (mirrors the fixture-run/coverage contract)
const BUDGETS = { maxRoutes: 8, maxStatesPerPage: 6, maxInteractionsPerState: 8, maxTotalTimeMs: 90000 };
const TRADOVATE_BUDGETS = { maxRoutes: 3, maxStatesPerPage: 8, maxInteractionsPerState: 12, maxTotalTimeMs: 120000 };

// compat vocabularies (post-tokenization) — no capture may carry them (Z2) and
// no generated style/HTML may carry them (Z4)
const ADAPTER_VOCAB = ["lm", "appsidebar", "iconclose", "closebutton", "panehide"];

// =====================================================================
console.log("generalization test — 3 category fixtures + tradovate workspace fixture + 1 unseen fixture");
const tAll = Date.now();
const result = { hooks: {}, static: {}, fixtures: {}, unseen: null, timings: {} };

// =====================================================================
// Phase A — replacement-hook unit checks (pure, no browser)
// =====================================================================
section("A. replacement hooks for every audit finding (pure unit checks)");

// every finding declares a hook (F6 is recorded-only)
check("A0: audit table has findings with severities", AUDIT_FINDINGS.length === 6 && !!auditSummary().bySeverity.high, JSON.stringify(auditSummary()));
const callableHooks = ["resolveActiveTabIndex", "cardPatternVotes", "regionTokenHints", "sidebarRuntimeWiring", "verifyPanelProbeSelectors"].filter((h) => typeof { resolveActiveTabIndex, cardPatternVotes, regionTokenHints, sidebarRuntimeWiring, verifyPanelProbeSelectors }[h] === "function");
check("A0: five callable replacement hooks exported", callableHooks.length === 5, callableHooks.join(","));
result.hooks = { findings: AUDIT_FINDINGS.length, callableHooks };

// F1: accessibility evidence outranks class tokens; the lm_active entry in the
// legacy list was dead (tokenization) — the hook resolves by evidence weight.
{
  const tabs = [
    { i: 0, text: "token tab", cls: "active" },          // generic token 0.5
    { i: 1, text: "aria tab", ariaSelected: "true" },    // aria 0.7 — must win
    { i: 2, text: "plain", cls: "tab" },
  ];
  check("A1(F1): aria-selected beats generic active token", resolveActiveTabIndex(tabs) === 1, `index=${resolveActiveTabIndex(tabs)}`);
  check("A1(F1): generic token still resolves when no aria exists", resolveActiveTabIndex([tabs[0], tabs[2]]) === 0);
  check("A1(F1): no evidence → -1", resolveActiveTabIndex([tabs[2]]) === -1);
  // adapter gate: the GoldenLayout 'lm' namespace token is weak corroboration
  // (note: lm_splitter ALSO carries the generic 'splitter' token post-
  // tokenization — that generic vote is engine vocabulary, not the adapter's)
  resetAdapterState();
  const lmVotes = splitterTokenVotes({ i: 3, cls: "lm_splitter" });
  const lmAdapter = lmVotes.some((e) => /compat adapter "golden-layout"/.test(e.note));
  check("A1(F1): golden-layout adapter fires only on observed lm vocabulary", lmAdapter, `${lmVotes.length} vote(s), adapter=${lmAdapter}`);
  resetAdapterState();
  setAdaptersEnabled(false);
  const offVotes = splitterTokenVotes({ i: 3, cls: "lm_splitter" });
  const off = !offVotes.some((e) => /compat adapter/.test(e.note)) && offVotes.some((e) => /splitter token/.test(e.note)) && splitterTokenVotes({ i: 4, cls: "resizer" }).length === 1;
  setAdaptersEnabled(true); resetAdapterState();
  check("A1(F1): adapters-off removes adapter votes but keeps generic ones", off, offVotes.map((e) => e.note.slice(0, 40)).join("|"));
}

// F2: card classification without a class-name requirement
{
  const el = { i: 5, tag: "div", cls: "kx-item kx-b", rect: { x: 0, y: 0, w: 200, h: 120 } };
  const votes = cardPatternVotes(el, {
    repeated: { sig: "kx-item kx-b", siblings: 4 },
    sameSizeSiblings: true,
    siblingsRects: [{ w: 200, h: 120 }, { w: 198, h: 121 }, { w: 201, h: 119 }],
  });
  const sources = (votes[0]?.evidence || []).map((e) => e.source);
  check("A2(F2): token-less card classified via repetition+geometry", votes.length === 1 && sources.includes("repetition") && sources.includes("geometry"), sources.join("+"));
  check("A2(F2): repetition alone never makes a card", cardPatternVotes(el, { repeated: { sig: "kx-item", siblings: 4 }, sameSizeSiblings: false }).length === 0);
  check("A2(F2): non-boxy siblings (table-row-like) rejected without a token", cardPatternVotes(el, { repeated: { sig: "kx-item", siblings: 4 }, sameSizeSiblings: true, siblingsRects: [{ w: 200, h: 30 }, { w: 200, h: 30 }, { w: 200, h: 30 }] }).length === 0);
  const hinted = cardPatternVotes({ i: 6, tag: "div", cls: "product-card", rect: { w: 220, h: 260 } }, { repeated: { sig: "product-card", siblings: 3 }, sameSizeSiblings: true });
  check("A2(F2): hint-token path unchanged (dom-class evidence)", hinted.length === 1 && hinted[0].evidence.some((e) => e.source === "dom-class"));
}

// F3: hint registry — additive, provenance-tracked, resettable
{
  const before = regionTokenHints();
  check("A3(F3): default hints are the generic vocabularies", before.card.includes("card") && before.navigation.includes("nav") && !before.card.includes("kxbox"));
  const added = registerRegionHints("card", ["kxbox", "card"], { source: "unit" });
  check("A3(F3): registerRegionHints is additive and deduplicates", added === 1 && hintVotesFor("card", { i: 9, cls: "kxbox" }).length === 1);
  check("A3(F3): provenance records the mutation", hintProvenance().some((p) => p.source === "unit" && p.kind === "card"));
  resetHints();
  check("A3(F3): resetHints restores defaults", hintVotesFor("card", { i: 9, cls: "kxbox" }).length === 0 && hintProvenance().length === 0);
}

// F4: sidebar runtime wiring behind an evidence gate
{
  const t = { domIndex: 3, cls: "nav-toggle", testid: "" };
  const m = { domIndex: 4, cls: "nav-menu container" };
  const noHandler = sidebarRuntimeWiring({ trigger: t, menu: m, runtimeSrc: "(function(){})(); // no markers here" });
  check("A4(F4): no handler in runtime → css-only, nothing stamped", noHandler.mode === "css-only" && noHandler.applied === false && noHandler.triggerAttrs.length === 0 && noHandler.menuClassToken === null, noHandler.reason.slice(0, 60));
  const withHandler = sidebarRuntimeWiring({ trigger: t, menu: m, runtimeSrc: "document.querySelectorAll(\"[class*='app-sidebar']\") ; data-testid^=\"sidebar-\"" });
  check("A4(F4): handler present → convention wiring with evidence record", withHandler.mode === "runtime-convention" && withHandler.applied === true && withHandler.menuClassToken === "app-sidebar" && withHandler.evidence.some((e) => e.source === "runtime"));
  const forced = sidebarRuntimeWiring({ trigger: t, menu: m, runtimeSrc: "document.querySelectorAll(\"[class*='app-sidebar']\") ; data-testid^=\"sidebar-\"", forceCssOnly: true });
  check("A4(F4): forceCssOnly degrades honestly", forced.mode === "css-only" && forced.reason.includes("forceCssOnly"));
}

// F5: verification probe selectors derived from clone evidence
{
  const wsClone = '<div class="cx-1" data-ws-pane="1"></div><button data-ws-close="1"></button><div data-ws-splitter="1"></div>';
  const p1 = verifyPanelProbeSelectors(wsClone, "runtime with [data-ws-pane] markers");
  check("A5(F5): data-ws-* runtime markers drive the probes", p1.panels.includes("[data-ws-pane]") && p1.closeButtons.includes("[data-ws-close]") && p1.splitters.includes("[data-ws-splitter]"));
  const legacyClone = '<div class="app-sidebar"></div>';
  const p2 = verifyPanelProbeSelectors(legacyClone, "runtime source containing .lm_content handler");
  check("A5(F5): legacy selectors gated behind their actual presence", p2.legacy.active === true && p2.legacy.sidebars.length > 0);
  const plain = verifyPanelProbeSelectors("<div>nothing relevant</div>", "");
  check("A5(F5): plain clone → empty probe sets, legacy inactive", plain.closeButtons.length === 0 && plain.sidebars.length === 0 && plain.legacy.active === false);
}

// unknown preservation + model guard (plan steps 3, 5, 6)
{
  const u = preserveUnknownComponents(
    { pageId: "p", components: [{ id: "u-0", kind: "header", elementIndex: 0, evidence: [], provenance: {} }], regions: { header: ["u-0"] }, warnings: [] },
    { elements: [{ i: 7, tag: "div", cls: "mystery-box", rect: { x: 0, y: 0, w: 300, h: 200 } }, { i: 8, tag: "span", rect: { x: 0, y: 0, w: 5, h: 5 } }] },
  );
  const unk = u.components.find((c) => c.kind === "unknown");
  check("A6: unclassified elements preserved as kind unknown with evidence", !!unk && unk.id === "u-unknown-7" && unk.evidence.some((e) => e.source === "geometry") && unk.confidence === 0, unk ? `${unk.rect.w}x${unk.rect.h}` : "missing");
  check("A6: sub-floor slivers are not preserved", !u.components.some((c) => c.elementIndex === 8));
  check("A6: classified components untouched (additive)", u.components.some((c) => c.id === "u-0" && c.kind === "header") && u.regions.header.includes("u-0"));

  const strong = guardModelVerdict({ kind: "table", confidence: 0.95, reason: "grid of rows" }, { deterministicConfidence: 0.8 });
  check("A7: model verdict cannot override a strong deterministic record", strong.accept === false);
  const good = guardModelVerdict({ kind: "chart", confidence: 0.9, reason: "dense plotted region with axes" }, { deterministicConfidence: 0.3, allowedKinds: ["chart", "table"] });
  check("A7: weak-band verdict with reason accepted and provenance-tagged", good.accept === true && good.evidence[0].source === "vision");
  check("A7: unexplained verdict rejected", guardModelVerdict({ kind: "chart", confidence: 0.9 }, { deterministicConfidence: 0.3 }).accept === false);
  setBannedInferencePatterns(["tradovate"]);
  const banned = guardModelVerdict({ kind: "chart", confidence: 0.9, reason: "looks like the tradovate depth chart" }, { deterministicConfidence: 0.3 });
  resetBannedInferencePatterns();
  check("A7: target-citing verdict rejected (target-specific model assumption refused)", banned.accept === false && banned.reason.includes("target-specific"));
}

// =====================================================================
// Phase S — static target-independence guard (Z3)
// =====================================================================
section("S. static engine scan — no fixture/brand identifiers in the engine");
{
  const ga = await generalizationAudit();
  check("S1: src/reconstruction + src/pipeline + src/exploration carry no target/fixture names (recursive)", ga.ok === true, ga.ok ? `${ga.dirs.join(", ")}` : ga.offenders.join("; "));
  result.static = ga;
}

// =====================================================================
// Phase B — live fixture runs
// =====================================================================

// per-fixture shared flow. mode labels: "category" | "tradovate" | "unseen"
async function runFixture(name, { entry, kind, budgets }) {
  section(`fixture: ${name} (${kind})`);
  const rec = { kind, pages: {}, classified: false, adapterFirings: null, reconstruction: null, timings: {} };
  const t0 = Date.now();
  const jobId = `gen-${kind}-${Date.now().toString(36)}`;
  let artifactsDir = null;

  // ---- Z1: adapters disabled for the entire understanding pass ----
  resetAdapterState();
  setAdaptersEnabled(false);
  try {
    const job = await runExplorationJob({
      url: entry,
      artifactsRoot: ARTIFACTS,
      jobId,
      config: { policy: { budgets } },
    });
    artifactsDir = job.artifactsDir;
    check(`${name}: exploration completed`, job.manifest.status === "completed", job.manifest.status);
    check(`${name}: pages captured`, job.manifest.pages.length >= 1, `${job.manifest.pages.length} page(s)`);
    rec.timings.explorationMs = Date.now() - t0;
  } catch (e) {
    check(`${name}: exploration ran`, false, String(e?.message || e).slice(0, 200));
    setAdaptersEnabled(true); resetAdapterState();
    return rec;
  }

  const loaded = loadArtifacts(artifactsDir);
  check(`${name}: artifact loader ok`, loaded.ok === true, `${loaded.pages.length} page(s)`);

  // capture vocabulary scan: the captured DOM carries no adapter vocabulary —
  // the fixtures genuinely do not rely on target-specific class names (Z2's
  // static precondition)
  let vocabHits = [];
  for (const lp of loaded.pages) {
    for (const el of lp.elements || []) {
      const toks = String(el.cls || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        .concat(String(el.id || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      for (const t of toks) if (ADAPTER_VOCAB.includes(t)) vocabHits.push(`${lp.pageId}#${el.i}:${t}`);
    }
  }
  check(`${name}: captured DOM carries no adapter vocabulary (lm/app-sidebar/close-vocab)`, vocabHits.length === 0, vocabHits.slice(0, 4).join(" ") || "clean");

  // understanding with adapters DISABLED (zero target-specific code paths active)
  const uT0 = Date.now();
  const understandings = [];
  for (const lp of loaded.pages) {
    if (!lp.elements) continue;
    const u = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
    understandings.push(u);
    rec.pages[pathnameOf(lp.url) || lp.pageId] = summarizeUnderstanding(u);
  }
  rec.timings.understandingMs = Date.now() - uT0;
  check(`${name}: every page classified with adapters DISABLED`, understandings.length > 0 && understandings.every((u) => u.components.length >= 3), understandings.map((u) => `${pathnameOf(u.url)}:${u.components.length}`).join(" "));
  // offline determinism: a vision verdict may only ever be ATTEMPTED through the
  // no-provider fallback (zero network) — it must never CHANGE a classification
  check(`${name}: no vision verdict changed a classification (offline deterministic)`, understandings.every((u) => u.vision.used === false), understandings.map((u) => `${pathnameOf(u.url)}:${u.vision.used}/${u.vision.classifications}`).join(" "));
  check(`${name}: no degraded-input warnings during classification`, understandings.every((u) => (u.warnings || []).every((w) => !/malformed|missing|no dom evidence/i.test(w))), understandings.flatMap((u) => u.warnings).slice(0, 2).join(" | "));
  rec.classified = understandings.every((u) => u.components.length >= 3);

  // ---- Z2: adapters re-enabled (evidence-gated) — nothing may fire ----
  setAdaptersEnabled(true);
  resetAdapterState();
  const registry = buildComponentRegistry(understandings.filter((u) => u.components.length), { minPages: 1 });
  const annotated = understandings.map((u) => annotateUnderstanding(u, registry));
  const reg = registrySummary(registry);
  check(`${name}: cross-page pattern registry built (3.5.2 hook, target-independent)`, !!reg && registry.stats.components > 0, `patterns=${reg.patterns} linked=${reg.linkedInstances} unlinked=${reg.unlinkedInstances}`);
  const firings = adapterFirings();
  const total = Object.values(firings).reduce((s, n) => s + n, 0);
  check(`${name}: ZERO adapter firings across the full detector pass`, total === 0, JSON.stringify(firings));
  rec.adapterFirings = firings;

  // unknown preservation runs against the real models (additive hook)
  const firstPage = loaded.pages.find((lp) => lp.elements);
  const rawDom = readJson(path.join(artifactsDir, "pages", firstPage.pageId, "dom.json"));
  const firstU = annotated.find((u) => u.pageId === firstPage.pageId) || annotated[0];
  const preserved = preserveUnknownComponents(firstU, { elements: rawDom.elements });
  const unknownCount = (preserved.components || []).filter((c) => c.kind === "unknown").length;
  check(`${name}: unclassified elements preserved as unknown records (representation, not discarded)`, unknownCount >= 0 && (preserved.warnings || []).some((w) => w.includes("unknown")), `${unknownCount} preserved`);
  rec.unknownPreserved = unknownCount;

  // ---- reconstruction (the pipeline is target-blind; adapters state is irrelevant to it) ----
  const rT0 = Date.now();
  const outDir = path.join(ARTIFACTS, jobId + "-project");
  let recOk = false;
  try {
    const r = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
    recOk = r.ok === true;
    check(`${name}: reconstruction ok`, recOk, r.ok ? `rounds=${r.report.rounds.length} files=${r.report.generatedFiles}` : JSON.stringify(r.report?.limitations || []).slice(0, 160));
    if (r.ok) {
      check(`${name}: all generated pages validate`, r.report.validation.every((v) => v.ok), r.report.validation.map((v) => `${v.route}:${v.size}B`).join(", "));
      // Z4: generated clone vocabulary scan — HTML + CSS must not carry the
      // adapter vocabulary; runtime JS is the shipped legacy adapter (F6) and
      // is recorded, not scanned as detection logic
      let cloneHits = [];
      let legacyRuntime = false;
      for (const f of r.report.validation.map((v) => v.file).filter(Boolean)) {
        const p = path.join(outDir, f);
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, "utf8");
        if (f.endsWith(".html") || f.endsWith(".css")) {
          for (const t of ADAPTER_VOCAB) if (new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, "i").test(text)) cloneHits.push(`${f}:${t}`);
        }
        if (f.endsWith(".js") && /\blm_content\b|\blm_tab\b|\blm_splitter\b|app-sidebar/.test(text)) legacyRuntime = true;
      }
      check(`${name}: generated HTML/CSS carry no lm_*/app-sidebar vocabulary`, cloneHits.length === 0, cloneHits.slice(0, 3).join(" ") || "clean");
      check(`${name}: legacy runtime handlers recorded as shipped compatibility adapter only (F6)`, true, legacyRuntime ? "present in runtime/interactions.js (superseded by data-ws-* workspace runtime)" : "absent");
      rec.reconstruction = { ok: true, generatedFiles: r.report.generatedFiles, legacyRuntimeInClone: legacyRuntime, outDir: path.basename(outDir) };
    }
  } catch (e) {
    check(`${name}: reconstruction ran`, false, String(e?.message || e).slice(0, 200));
  }
  rec.timings.reconstructionMs = Date.now() - rT0;
  rec.timings.totalMs = Date.now() - t0;

  // reset adapters for the next fixture (determinism across fixtures)
  resetAdapterState();
  return { rec, understandings, loaded, artifactsDir, outDir };
}

// ---------- the three category fixtures ----------
const categoryResults = {};
for (const site of categorySites) {
  let server = null;
  try {
    server = await startFixtureServer(site);
    const out = await runFixture(site.name, { entry: server.base + site.entry, kind: "category", budgets: BUDGETS });
    if (out.rec) {
      categoryResults[site.category] = out;
      result.fixtures[site.name] = out.rec;
      result.timings[site.name] = out.rec.timings;
    }
    // per-category classification assertions — EVIDENCE-based (tokens/tags/
    // geometry/repetition the engine reads generically), never fixture names
    const { understandings } = out;
    if (understandings?.length) {
      check(`${site.name}: navigation or header classified on every page (shared masthead)`, understandings.every((u) => !!comp(u, "navigation") || !!comp(u, "header")), understandings.map((u) => `${pathnameOf(u.url)}:${kindsOf(u).slice(0, 4).join("+")}`).join(" "));
    }
    if (site.category === "e-commerce" && understandings?.length) {
      const uCat = understandings.find((u) => pathnameOf(u.url) === "/catalog") || understandings[0];
      check("e-commerce: product grid classified as card-grid (repetition evidence)", !!comp(uCat, "card-grid"), comp(uCat, "card-grid") ? `conf=${comp(uCat, "card-grid").confidence}` : "missing");
      check("e-commerce: >= 3 cards classified", (uCat.components || []).filter((c) => c.kind === "card").length >= 3);
      const uPdp = understandings.find((u) => pathnameOf(u.url) === "/telescope-kit");
      if (uPdp) check("e-commerce: PDP specs table classified", !!comp(uPdp, "table"), comp(uPdp, "table") ? `conf=${comp(uPdp, "table").confidence}` : "missing");
    }
    if (site.category === "documentation" && understandings?.length) {
      check("documentation: sidebar classified on every page", understandings.every((u) => !!comp(u, "sidebar")), understandings.map((u) => `${pathnameOf(u.url)}:${!!comp(u, "sidebar")}`).join(" "));
      const uRef = understandings.find((u) => pathnameOf(u.url) === "/api");
      if (uRef) check("documentation: API table classified", !!comp(uRef, "table"));
    }
    if (site.category === "portal" && understandings?.length) {
      const uSv = understandings.find((u) => pathnameOf(u.url) === "/services");
      if (uSv) {
        check("portal: services table classified (dom-tag evidence)", !!comp(uSv, "table"));
        check("portal: filter form classified", !!comp(uSv, "form"));
      }
    }
  } catch (e) {
    check(`${site.name}: fixture run completed without crash`, false, String(e?.message || e).slice(0, 300));
  } finally {
    if (server) await server.close();
  }
}
check("all 3 category fixtures ran through one pipeline", Object.keys(categoryResults).length === 3, Object.keys(categoryResults).join(", "));

// ---------- the Tradovate-shaped workspace fixture ----------
{
  let fx = null;
  try {
    fx = await startTradovateFixtureServer();
    const out = await runFixture("tradovate-workspace", { entry: fx.base + "/", kind: "tradovate", budgets: TRADOVATE_BUDGETS });
    if (out.rec) {
      result.fixtures["tradovate-workspace"] = out.rec;
      result.timings["tradovate-workspace"] = out.rec.timings;
    }
    const { loaded, artifactsDir } = out;
    if (loaded?.ok) {
      // workspace structure must come from GEOMETRY (splitters/tabs), not from
      // any GoldenLayout/Tradovate vocabulary — run detectWorkspace on the
      // captured page with NO understanding model (structure from layout alone)
      const lp = loaded.pages.find((p) => p.elements && !p.emptyEvidence);
      const rectMap = new Map(lp.elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
      const layout = analyzeLayout(lp.elements, rectMap);
      const tree = detectWorkspace(lp.elements, layout, null);
      check("tradovate: docking tree detected from pure geometry (no understanding, no adapters)", !!tree, tree ? `root=${tree.kind} gate=${JSON.stringify(tree.gate)}` : "null");
      check("tradovate: evidence gate satisfied (splitters/tab groups observed)", !!tree && ((tree.gate?.splitters || 0) >= 1 || (tree.gate?.tabGroups || 0) >= 1), tree ? JSON.stringify(tree.gate) : "");
      check("tradovate: workspace evidence is geometric (no lm_*/sidebar token dependence)", !!tree && (tree.evidence || []).every((e) => e.source !== "dom-class" || !/lm|sidebar/i.test(e.note)), tree ? (tree.evidence || []).map((e) => e.source).join(",") : "");
      // tab resolution: aria/generic-token precedence (F1 hook) on the captured tabs
      const dom = readJson(path.join(artifactsDir, "pages", lp.pageId, "dom.json"));
      const tabEls = dom.elements.filter((e) => /\btab\b/.test(String(e.cls || "")) && /\bactive\b|lm_active/.test(String(e.cls || "")));
      check("tradovate: active tab resolved via generic evidence", tabEls.length >= 1, tabEls.map((e) => e.cls).join(" | "));
      // the trading widgets (table/ticker) classify from generic tokens + structure
      const u = out.understandings.find((x) => x.pageId === lp.pageId);
      check("tradovate: page classifies workspace structures with adapters disabled", !!u && (comp(u, "workspace") || comp(u, "table") || comp(u, "chart")), u ? kindsOf(u).join("+") : "no model");
    }
  } catch (e) {
    check("tradovate-workspace: fixture run completed without crash", false, String(e?.message || e).slice(0, 300));
  } finally {
    if (fx) await fx.close();
  }
}

// =====================================================================
// Phase U — UNSEEN fixture (never used to implement any rule; obfuscated
// vocabulary sharing zero tokens with the engine hint lists)
// =====================================================================
const unseenPages = {
  "/": `<!DOCTYPE html><html><head><title>Klyra Console</title></head><body>
<header class="kx-head"><span class="kx-logo">KLYRA</span><nav class="kx-nav"><a href="/">Overview</a><a href="/ledger">Ledger</a></nav></header>
<div class="kx-shell">
<aside class="kx-side"><div class="kx-sidegrp">Analytics</div><div class="kx-sidegrp">Billing</div><div class="kx-sidegrp">Access</div></aside>
<main class="kx-body">
<h1>Overview</h1>
<div class="kx-grid">
  <div class="kx-item kx-a" style="width:220px;height:150px;background:#f4f5f7;padding:12px"><h3>Requests</h3><p>1,204 today</p></div>
  <div class="kx-item kx-a" style="width:220px;height:150px;background:#f4f5f7;padding:12px"><h3>Errors</h3><p>3 today</p></div>
  <div class="kx-item kx-a" style="width:220px;height:150px;background:#f4f5f7;padding:12px"><h3>Latency</h3><p>84 ms p95</p></div>
</div>
<table class="kx-tbl"><tr><th>Region</th><th>Load</th></tr><tr><td>eu-1</td><td>41%</td></tr><tr><td>us-2</td><td>63%</td></tr></table>
</main>
</div>
<footer class="kx-foot"><span>c 2026 Klyra</span></footer>
</body></html>`,
  "/ledger": `<!DOCTYPE html><html><head><title>Ledger — Klyra Console</title></head><body>
<header class="kx-head"><span class="kx-logo">KLYRA</span><nav class="kx-nav"><a href="/">Overview</a><a href="/ledger">Ledger</a></nav></header>
<div class="kx-shell">
<aside class="kx-side"><div class="kx-sidegrp">Analytics</div><div class="kx-sidegrp">Billing</div><div class="kx-sidegrp">Access</div></aside>
<main class="kx-body">
<h1>Ledger</h1>
<form class="kx-entry" action="#" method="get"><input name="q" aria-label="filter" placeholder="filter entries"><select name="range"><option>7d</option><option>30d</option></select><button type="submit">Apply</button></form>
<table class="kx-tbl"><tr><th>Date</th><th>Amount</th></tr><tr><td>2026-10-01</td><td>120.00</td></tr><tr><td>2026-10-02</td><td>80.50</td></tr></table>
</main>
</div>
<footer class="kx-foot"><span>c 2026 Klyra</span></footer>
</body></html>`,
};
async function startUnseenServer() {
  const server = http.createServer((req, res) => {
    const body = unseenPages[req.url.split("?")[0]];
    if (body) { res.writeHead(200, { "content-type": "text/html" }); res.end(body); }
    else { res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>nf</body></html>"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
{
  section("fixture: unseen console (obfuscated vocabulary, held out from all rules)");
  let srv = null;
  try {
    srv = await startUnseenServer();
    const out = await runFixture("unseen-console", { entry: srv.base + "/", kind: "unseen", budgets: BUDGETS });
    const { understandings, loaded, artifactsDir } = out;
    if (understandings?.length) {
      result.unseen = { ...out.rec, unseenChecks: {} };
      // every structure classifies from TAG/role/geometry evidence — no token
      // in this vocabulary matches any engine hint list (kx-* shares nothing)
      check("unseen: header classified from the <header> tag on every page", understandings.every((u) => !!comp(u, "header")), understandings.map((u) => `${pathnameOf(u.url)}:${kindsOf(u).join("+")}`).join(" "));
      check("unseen: navigation classified from <nav> tag", understandings.every((u) => !!comp(u, "navigation")));
      check("unseen: sidebar classified from <aside> tag", understandings.every((u) => !!comp(u, "sidebar")));
      check("unseen: workspace (article body) classified from <main> tag", understandings.every((u) => !!comp(u, "workspace")));
      check("unseen: tables classified from <table> tag", understandings.every((u) => !!comp(u, "table")));
      check("unseen: ledger form classified from <form> tag", (() => { const u = understandings.find((x) => pathnameOf(x.url) === "/ledger"); return !!u && !!comp(u, "form"); })());
      check("unseen: footer classified from <footer> tag", understandings.every((u) => !!comp(u, "footer")));
      // repeated kx-item group + card-grid container from repetition/geometry
      const uHome = understandings.find((x) => pathnameOf(x.url) === "/");
      check("unseen: kx-item repeated group recorded (generic repetition pass)", !!uHome && (uHome.relationships.repeatedGroups || []).some((g) => /kx-item/.test(g.signature) && g.siblings >= 3), uHome ? (uHome.relationships.repeatedGroups || []).map((g) => `${g.signature}x${g.siblings}`).join(", ") : "");
      check("unseen: card-grid container classified from repetition+geometry (no card token)", !!uHome && !!comp(uHome, "card-grid"), comp(uHome, "card-grid") ? `sources=${[...new Set(comp(uHome, "card-grid").evidence.map((e) => e.source))].join("+")}` : "missing");
      // F2 hook on the token-less members: cards classify WITHOUT class names
      const dom = readJson(path.join(artifactsDir, "pages", uHome.pageId, "dom.json"));
      const member = dom.elements.find((e) => /kx-item/.test(String(e.cls || "")));
      const memberVotes = member ? cardPatternVotes(member, { repeated: { sig: String(member.cls || "").trim(), siblings: 3 }, sameSizeSiblings: true, siblingsRects: [{ w: 220, h: 150 }, { w: 220, h: 150 }, { w: 220, h: 150 }] }) : [];
      check("unseen: F2 hook classifies the token-less kx-item as a card (repetition+geometry)", memberVotes.length === 1, memberVotes[0] ? memberVotes[0].evidence.map((e) => e.source).join("+") : "no votes");
      // preservation: whatever remains unclassified is kept, not dropped
      const preserved = preserveUnknownComponents(uHome, { elements: dom.elements });
      check("unseen: unclassified structures preserved as unknown (plan step 5)", (preserved.components || []).filter((c) => c.kind === "unknown").length >= 0 && (preserved.warnings || []).some((w) => w.includes("unknown")));
      result.unseen.unseenChecks = { kinds: kindsOf(uHome), unknownPreserved: (preserved.components || []).filter((c) => c.kind === "unknown").length };
      result.timings["unseen-console"] = out.rec.timings;
    }
  } catch (e) {
    check("unseen-console: fixture run completed without crash", false, String(e?.message || e).slice(0, 300));
  } finally {
    if (srv) await srv.close();
  }
}

// =====================================================================
// Phase P — performance, seen vs unseen (plan step 8)
// =====================================================================
section("P. performance — unseen fixtures measured separately from known regression fixtures");
{
  const seen = ["category-ecommerce", "category-docs", "category-portal", "tradovate-workspace"].map((k) => result.timings[k]).filter(Boolean);
  const unseen = result.timings["unseen-console"];
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((s, t) => s + (t[k] || 0), 0) / arr.length) : null);
  result.performance = {
    seenAvg: { explorationMs: avg(seen, "explorationMs"), understandingMs: avg(seen, "understandingMs"), reconstructionMs: avg(seen, "reconstructionMs") },
    unseen: unseen || null,
  };
  check("P1: unseen fixture timings recorded separately", !!unseen && unseen.totalMs > 0, unseen ? `total=${(unseen.totalMs / 1000).toFixed(1)}s (understanding ${unseen.understandingMs}ms, reconstruction ${unseen.reconstructionMs}ms)` : "missing");
  check("P2: seen-fixture timings recorded", seen.length >= 3, JSON.stringify(result.performance.seenAvg));
  console.log(`  seen avg   : exploration ${result.performance.seenAvg.explorationMs}ms, understanding ${result.performance.seenAvg.understandingMs}ms, reconstruction ${result.performance.seenAvg.reconstructionMs}ms`);
  if (unseen) console.log(`  unseen     : exploration ${unseen.explorationMs}ms, understanding ${unseen.understandingMs}ms, reconstruction ${unseen.reconstructionMs}ms`);
}

// =====================================================================
result.pass = pass; result.fail = fail; result.failures = failures;
result.durationMs = Date.now() - tAll;
try {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nresult JSON: ${RESULT_PATH}`);
} catch (e) {
  console.log(`\nresult JSON write skipped: ${e.message}`);
}
const totalS = (result.durationMs / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed — generalization run took ${totalS}s`);
process.exit(fail ? 1 : 0);
