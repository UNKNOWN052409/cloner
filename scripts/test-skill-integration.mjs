// Task G6.7 — ai-cloner-skill-integration test suite.
//
// Validates the three skill-integration modules (src/reconstruction/skill-integration/)
// against the ai-website-cloner-claudeskill technique mapping
// (docs/AI-CLONER-SKILL-INTEGRATION.md):
//   technique 1 — per-section computed-style spec files      → style-spec.js
//   technique 2 — per-section parallel builders + merge      → parallel-builders.js
//   technique 3 — section-scoped visual-diff final gate      → section-gate.js
//
// Phase A is pure/deterministic (no browser). Phase B runs the REAL pipeline
// end-to-end against a local fixture server with a REAL browser: exploration →
// understanding → spec files → live extended computed-style capture →
// reconstruction → parallel build + merge → rendered-geometry equivalence
// (merged per-section output vs the monolithic generator, measured in-page) →
// the section final gate on the clean clone, on a spec-faithful build (extended
// captured values folded into the built CSS), on a deliberately drifted clone
// (must fail ONLY the drifted section), and on a dual-viewport run (1440+390).
// No mocks: every browser, server, screenshot and measurement here is real;
// the fixture server stands in for the remote site exactly like every other
// suite in this repo.
//
// Fixture bound: the production renderer truncates at 60 children per node
// (src/reconstruction/analysis/component-tree-builder.js:98), so the fixture's
// repeated group stays at 50 — the equivalence comparison must compare like
// with like, not engine bounds against unbounded output.
//
// Run: CLONER_ALLOW_PRIVATE_TARGETS=1 node scripts/test-skill-integration.mjs
// (the env opt-in is set below as a fallback — local fixtures are the point).
// Result JSON: artifacts/test-skill-integration-result.json (exit 1 on failure).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

process.env.CLONER_ALLOW_PRIVATE_TARGETS = process.env.CLONER_ALLOW_PRIVATE_TARGETS || "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const ARTIFACTS = path.join(ROOT, "artifacts");
const RESULT_PATH = path.join(ARTIFACTS, "test-skill-integration-result.json");

import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { loadArtifacts } from "../src/reconstruction/artifact-loader.js";
import { buildUnderstandingPage, pageArtifactsFromLoaded } from "../src/reconstruction/website-understanding.js";
import { buildComponentTree } from "../src/reconstruction/analysis/component-tree-builder.js";
import { analyzeLayout } from "../src/reconstruction/analysis/layout-analyzer.js";
import { generatePageHtml } from "../src/reconstruction/generation/project-generator.js";
import { launchBrowser } from "../src/browser.js";
import { DOM_EXTRACTOR_SCRIPT } from "../src/intelligence/dom-extractor.js";
import { GEOMETRY_TOLERANCE_PX } from "../src/reconstruction/visual-fidelity-analyzer.js";
import {
  buildSectionSpecs, writeSectionSpecs, loadSectionSpecs,
  enrichSpecsFromExtendedCapture, captureExtendedStyles,
  childrenIndexMap, structuralPathOf,
  EXTENDED_STYLE_PROPS,
} from "../src/reconstruction/skill-integration/style-spec.js";
import {
  planSectionBuilders, buildSectionFragment, mergeSectionFragments,
  buildLeadFragments, writeBuildPlan, estimateBuilderLines, inlineSpecFor,
  SPEC_COMPLEXITY_BUDGET,
} from "../src/reconstruction/skill-integration/parallel-builders.js";
import {
  sectionGate, dualViewportGate, correlateDefectWithSpec,
  attributeDefectsToSections, cellsOfRect, runSectionVisualGate,
  SECTION_GATE_FAIL_SEVERITY, SECTION_GATE_WARN_SEVERITY,
} from "../src/reconstruction/skill-integration/section-gate.js";

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const result = { unit: {}, live: {}, timings: {} };
const tAll = Date.now();

// =====================================================================
// fixture evidence builder (pure) — synthetic dom.json-shaped evidence
// =====================================================================

// A deterministic synthetic page: header(+nested nav), an over-budget hero
// with a styled title, a card grid, a table and a footer. Obfuscated class
// vocabulary — no engine hint tokens, mirroring the generalization discipline
// (engine rules must not know this shape).
function syntheticEvidence() {
  const elements = [];
  let i = 0;
  const push = (el) => { elements.push({ i: i, ...el }); return i++; };
  const r = (x, y, w, h) => ({ x, y, w, h });
  push({ tag: "header", cls: "hd", parent: null, rect: r(0, 0, 1440, 80), text: null,
    style: { fontSize: "16px", color: "rgb(20, 20, 20)", backgroundColor: "rgb(255, 255, 255)", padding: "0px", fontWeight: "400" },
    layout: { display: "flex", position: "static" } });
  push({ tag: "nav", cls: "nv", parent: 0, rect: r(8, 20, 700, 40), text: "Products",
    style: { fontSize: "14px", color: "rgb(20, 20, 20)" }, layout: { display: "block", position: "static" } });
  push({ tag: "div", cls: "zhero", parent: null, rect: r(0, 80, 1440, 400), text: null,
    style: { fontSize: "48px", backgroundColor: "rgb(18, 32, 64)", padding: "24px", fontWeight: "700" },
    layout: { display: "block", position: "static" } });
  push({ tag: "span", cls: "ztitle", parent: 2, rect: r(24, 120, 900, 60), text: "Shipping lanes, visualized",
    style: { fontSize: "48px", color: "rgb(255, 255, 255)", fontWeight: "700" },
    layout: { display: "block", position: "static" } });
  for (let k = 0; k < 78; k++) {
    push({ tag: "span", cls: "ztick", parent: 2, rect: r(24 + k * 18, 220, 16, 160), text: `${k}`,
      style: { fontSize: "12px", color: "rgb(120, 140, 180)" }, layout: { display: "inline-block", position: "static" } });
  }
  const gridIdx = push({ tag: "div", cls: "zgrid", parent: null, rect: r(0, 480, 1440, 320), text: null,
    style: { fontSize: "16px", padding: "16px" }, layout: { display: "flex", position: "static" } });
  const cardIdxs = [];
  for (let k = 0; k < 4; k++) {
    const c = push({ tag: "div", cls: "zcard", parent: gridIdx, rect: r(16 + k * 350, 496, 330, 280), text: null,
      style: { fontSize: "14px", backgroundColor: "rgb(244, 245, 247)", borderRadius: "8px", padding: "12px" },
      layout: { display: "block", position: "static" } });
    cardIdxs.push(c);
    push({ tag: "img", cls: "zimg", parent: c, rect: r(28 + k * 350, 508, 306, 140), text: null, src: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='306' height='140'%3E%3C/svg%3E`,
      style: { fontSize: "14px" }, layout: { display: "block", position: "static" } });
    push({ tag: "h3", cls: "zh", parent: c, rect: r(28 + k * 350, 656, 306, 24), text: `Route ${k + 1}`,
      style: { fontSize: "18px", fontWeight: "600" }, layout: { display: "block", position: "static" } });
    push({ tag: "p", cls: "zp", parent: c, rect: r(28 + k * 350, 688, 306, 40), text: `Legs ${k + 2}–${k + 5} open.`,
      style: { fontSize: "14px", color: "rgb(60, 60, 60)" }, layout: { display: "block", position: "static" } });
  }
  const tblIdx = push({ tag: "table", cls: "ztbl", parent: null, rect: r(0, 800, 1440, 120), text: null,
    style: { fontSize: "14px" }, layout: { display: "table", position: "static" } });
  for (let k = 0; k < 3; k++) {
    push({ tag: "tr", cls: null, parent: tblIdx, rect: r(0, 800 + k * 40, 1440, 40), text: k === 0 ? "Harbor" : `Port ${k}`,
      style: { fontSize: "14px" }, layout: { display: "table-row", position: "static" } });
  }
  const footIdx = push({ tag: "footer", cls: "zft", parent: null, rect: r(0, 920, 1440, 60), text: "Demo shipping co.",
    style: { fontSize: "12px", color: "rgb(90, 90, 90)" }, layout: { display: "block", position: "static" } });
  // one element outside every section (lead coverage)
  push({ tag: "div", cls: "znote", parent: null, rect: r(0, 980, 1440, 30), text: "portal note",
    style: { fontSize: "12px" }, layout: { display: "block", position: "static" } });

  const understanding = {
    pageId: "page-001",
    url: "http://127.0.0.1:1/",
    components: [
      { id: "u-0", kind: "header", elementIndex: 0, rect: { x: 0, y: 0, w: 1440, h: 80 }, confidence: 0.9 },
      { id: "u-2", kind: "workspace", elementIndex: 2, rect: { x: 0, y: 80, w: 1440, h: 400 }, confidence: 0.8 },
      { id: "u-g", kind: "card-grid", elementIndex: gridIdx, rect: { x: 0, y: 480, w: 1440, h: 320 }, confidence: 0.85 },
      { id: "u-t", kind: "table", elementIndex: tblIdx, rect: { x: 0, y: 800, w: 1440, h: 120 }, confidence: 0.8 },
      { id: "u-f", kind: "footer", elementIndex: footIdx, rect: { x: 0, y: 920, w: 1440, h: 60 }, confidence: 0.9 },
      // nested section: the nav is a member of the header's subtree
      { id: "u-n", kind: "navigation", elementIndex: 1, rect: { x: 8, y: 20, w: 700, h: 40 }, confidence: 0.85 },
    ],
    regions: {}, warnings: [],
  };
  const interactions = [
    { id: "t1", pageId: "page-001", domIndex: 3, kind: "click" },
    { id: "t9", pageId: "page-001", domIndex: 9999, kind: "click" }, // dangling — must be ignored
  ];
  return { elements, understanding, interactions, gridIdx, cardIdxs, tblIdx, footIdx };
}

// =====================================================================
// Phase A — pure unit checks (no browser)
// =====================================================================
section("A. pure unit checks — specs, plan, build, merge, gate");
{
  const { elements, understanding, interactions, gridIdx, tblIdx } = syntheticEvidence();
  const byIndex = new Map(elements.map((e) => [e.i, e]));
  const childMap = childrenIndexMap(elements);
  const parentOf = new Map(elements.map((e) => [e.i, e.parent]));

  // A1 — evidence gate
  const gated = buildSectionSpecs({ elements, understanding: { components: [] }, interactions: [] });
  check("A1: no understanding components → ok:false, no fabricated specs", gated.ok === false && gated.specs.length === 0 && typeof gated.why === "string", gated.why || "");
  const gated2 = buildSectionSpecs({ elements: [], understanding, interactions: [] });
  check("A1: no element evidence → ok:false", gated2.ok === false && gated2.specs.length === 0);

  // A2 — happy path (document order: header y0, nav y20, hero y80, grid y480, table y800, footer y920)
  const built = buildSectionSpecs({ elements, understanding, interactions, pageId: "page-001" });
  check("A2: specs built from evidence", built.ok === true && built.specs.length === 6, `${built.specs.length} section(s), uncovered=${built.uncovered}`);
  const sHero = built.specs.find((s) => s.elementIndex === 2);
  check("A2: sections in document order (header, nav, hero, grid, table, footer)",
    built.specs.map((s) => s.elementIndex).join(",") === `0,1,2,${gridIdx},${tblIdx},${elements.length - 2}`,
    built.specs.map((s) => s.sectionId + ":" + s.elementIndex).join(" "));
  check("A2: hero spec carries the whole subtree (80 members)", !!sHero && sHero.members.length === 80, sHero ? `${sHero.members.length} member(s)` : "missing");
  check("A2: member styles are the EXACT captured values (verbatim copy)",
    !!sHero && sHero.members[0].style.fontSize === "48px" && sHero.members[0].style.backgroundColor === "rgb(18, 32, 64)",
    sHero ? JSON.stringify(sHero.members[0].style).slice(0, 80) : "missing");
  check("A2: structural paths carry a step for the TOPMOST element too (root step fix; k counts same tag+firstClass roots)",
    !!sHero && sHero.members[0].path === "div.zhero:nth-of-type(1)" && sHero.members[1].path === "div.zhero:nth-of-type(1) > span.ztitle:nth-of-type(1)",
    sHero ? `${sHero.members[0].path} | ${sHero.members[1].path}` : "missing");
  check("A2: verbatim text + assets recorded", !!sHero && sHero.verbatimText.includes("Shipping lanes, visualized") &&
    built.specs.find((s) => s.elementIndex === gridIdx).assets.length === 4);
  check("A2: interaction linkage (t1 → hero member; dangling t9 ignored)",
    !!sHero && sHero.interactions.length === 1 && sHero.interactions[0].id === "t1" && sHero.interactions[0].triggerElement === 3,
    sHero ? JSON.stringify(sHero.interactions) : "missing");
  check("A2: the note element outside every section is counted uncovered", built.uncovered === 1, `uncovered=${built.uncovered}`);

  // A3 — plan: budget split + nested exclusion (hero estimate 164 > 150 → 2 subs + wrapper)
  const plan = planSectionBuilders(built.specs, { parentOf });
  const heroBuilders = plan.plan.builders.filter((b) => b.sectionId === sHero.sectionId);
  check("A3: plan ok — 4 single-section builders + hero split (2 subs + wrapper) = 7; nested nav excluded + recorded",
    plan.ok === true && plan.plan.builders.length === 7 && heroBuilders.length === 3 && plan.plan.nested.length === 1 && plan.plan.nested[0].sectionId === built.specs.find((s) => s.elementIndex === 1).sectionId,
    `builders=${plan.plan.builders.length}, hero=${heroBuilders.map((b) => b.role).join("+")}, nested=${JSON.stringify(plan.plan.nested)}`);
  const orderPos = (id) => plan.plan.order.indexOf(id);
  const heroSubIds = heroBuilders.filter((b) => b.role === "sub-component").map((b) => b.builderId);
  const heroWrapId = heroBuilders.find((b) => b.role === "wrapper").builderId;
  check("A3: sub-components dispatched BEFORE their wrapper (skill rule), sections in document order",
    heroSubIds.every((id) => orderPos(id) < orderPos(heroWrapId)) && plan.plan.order[0].startsWith("sec-001"),
    `order=${plan.plan.order.join(",")}`);
  check("A3: budget is the skill's 150-line rule", SPEC_COMPLEXITY_BUDGET === 150 && estimateBuilderLines(sHero) > SPEC_COMPLEXITY_BUDGET, `hero estimate=${estimateBuilderLines(sHero)}`);
  check("A3: builders carry the spec INLINE with exact captured values",
    heroBuilders.some((b) => b.inlineSpec.includes("48px")), "inline spec carries captured values");
  const capped = inlineSpecFor({ ...sHero, members: Array.from({ length: 400 }, (_, k) => ({ i: k, tag: "span", cls: "x", rect: { x: 0, y: 0, w: 1, h: 1 }, style: {} })) });
  check("A3: inline spec bounded", capped.split("\n").length <= 201, `${capped.split("\n").length} lines`);

  // A4 — fragments + merge on synthetic evidence
  const ctx = {
    elementsByIndex: byIndex, childMap, layoutByIndex: new Map(),
    wireByIndex: new Map([[3, "t1"]]), assetByIndex: new Map(), streamByIndex: new Map(),
    routeFileMap: new Map(), claimedIndexes: new Set(built.specs.flatMap((s) => s.members.map((m) => m.i))),
  };
  const fragments = plan.plan.builders.map((b) => buildSectionFragment(b, ctx));
  const leads = buildLeadFragments([elements.length - 1], ctx); // the znote element
  const merge = mergeSectionFragments({ fragments, plan: plan.plan, leadFragments: leads, parentOf });
  check("A4: merge composes every member exactly once (no marker left, no duplicate cx-N)",
    merge.conflicts.length === 0 && !merge.html.includes("merge:") &&
    elements.slice(0, -1).every((e) => (merge.html.match(new RegExp(`cx-${e.i}[" ]`, "g")) || []).length === 1),
    `conflicts=${merge.conflicts.length}, sections=${merge.mergedSections}, subsMerged=${merge.subComponentsMerged}`);
  check("A4: lead fragment renders the uncovered element", leads.length === 1 && leads[0].html.includes("znote"), `leads=${leads.length}`);
  const ruleCount = (merge.css.match(/\.cx-\d+ \{/g) || []).length;
  check("A4: merged css carries exactly one rule per element (104 claimed + 1 lead)", ruleCount === elements.length, `${ruleCount} rule(s) for ${elements.length} element(s)`);
  check("A4: interaction wiring survives the fragment path (data-replay-id on cx-3)",
    merge.html.includes('data-replay-id="t1"'));
  check("A4: nested section's markup still present (rendered inside its container)", merge.html.includes("cx-1"), `nested=${JSON.stringify(plan.plan.nested[0])}`);

  // A5 — conflict handling is fail-closed
  const dupFrag = { builderId: "dup-1", sectionId: "sec-dup", role: "section", rootIndex: 3, rect: null, html: "", css: ".cx-3 { width: 1px; }" };
  const mergeDup = mergeSectionFragments({ fragments: [...fragments, dupFrag], plan: { order: [...plan.plan.order, "dup-1"] }, leadFragments: [], parentOf });
  const firstCx3 = mergeDup.conflicts[0];
  check("A5: duplicate selector → conflict recorded, first dispatch-order rule kept, duplicate dropped",
    mergeDup.conflicts.length === 1 && firstCx3.keptFrom === "sec-003-sub0" && firstCx3.droppedFrom === "dup-1" && !mergeDup.css.includes("width: 1px"),
    JSON.stringify(mergeDup.conflicts));

  // A6 — spec correlation verdicts (the skill's "check the spec file" step)
  const heroSpec = sHero;
  check("A6: clone-drift — spec captured the truth, clone deviated",
    correlateDefectWithSpec({ refs: [2], field: "fontSize", original: "48px", clone: "30px" }, heroSpec) === "clone-drift");
  check("A6: spec-drift — captured spec disagrees with the original measurement (re-extract)",
    correlateDefectWithSpec({ refs: [2], field: "fontSize", original: "44px", clone: "44px" }, heroSpec) === "spec-drift");
  check("A6: uncaptured-property — boxShadow never captured (extended capture closes it)",
    correlateDefectWithSpec({ refs: [2], field: "boxShadow", original: "rgb(0,0,0) 0px 2px 4px", clone: "none" }, heroSpec) === "uncaptured-property");
  check("A6: extended capture present → boxShadow becomes a value verdict",
    correlateDefectWithSpec({ refs: [2], field: "boxShadow", original: "rgb(0,0,0) 0px 2px 4px", clone: "none" },
      { ...heroSpec, members: heroSpec.members.map((m, k) => k === 0 ? { ...m, extended: { boxShadow: "rgb(0,0,0) 0px 2px 4px" } } : m) }) === "clone-drift");
  check("A6: unattributed — ref outside the spec", correlateDefectWithSpec({ refs: [999], field: "fontSize", original: "1px", clone: "2px" }, heroSpec) === "unattributed");
  check("A6: structural — missing-component kind", correlateDefectWithSpec({ refs: [3], kind: "missing-component" }, heroSpec) === "structural");

  // A7 — attribution by ref and by grid cell
  const dims = { w: 1440, h: 1010 };
  const gridSpecA7 = built.specs.find((s) => s.elementIndex === gridIdx);
  const tblSpecA7 = built.specs.find((s) => s.elementIndex === tblIdx);
  const defects = [
    { kind: "typography", field: "fontSize", refs: [2], severity: 0.5, region: null, original: "48px", clone: "30px" },
    { kind: "color", refs: [], severity: 0.45, region: cellsOfRect({ x: 0, y: 800, w: 1440, h: 120 }, dims)[0], original: null, clone: null },
    { kind: "color", refs: [], severity: 0.1, region: 118, original: null, clone: null }, // off-grid cell — no section
  ];
  const attr = attributeDefectsToSections(defects, built.specs, { dims });
  check("A7: element-ref defect attributes to the owning section", (attr.bySection[heroSpec.sectionId] || []).length === 1);
  check("A7: region-cell defect attributes to the SMALLEST covering section (table over the wider grid)",
    (attr.bySection[tblSpecA7.sectionId] || []).length === 1 && (attr.bySection[gridSpecA7.sectionId] || []).length === 0,
    `table=${(attr.bySection[tblSpecA7.sectionId] || []).length}, grid=${(attr.bySection[gridSpecA7.sectionId] || []).length}`);
  check("A7: uncovered cell stays unattributed", attr.unattributed.length === 1, `unattributed=${attr.unattributed.length}`);

  // A8 — gate thresholds + fallback
  const gate = sectionGate(defects, built.specs, { dims });
  const heroEntry = gate.sections.find((s) => s.sectionId === heroSpec.sectionId);
  const tblEntry = gate.sections.find((s) => s.sectionId === tblSpecA7.sectionId);
  check("A8: hero FAILS at severity ≥ 0.4 with a repair-against-spec route", heroEntry.status === "fail" && heroEntry.repairRoute === "repair-against-spec",
    `worst=${heroEntry.worstSeverity} route=${heroEntry.repairRoute}`);
  check("A8: table fails via region-cell attribution; all other sections pass",
    tblEntry.status === "fail" && gate.sections.filter((s) => s.sectionId !== heroSpec.sectionId && s.sectionId !== tblSpecA7.sectionId).every((s) => s.status === "pass"),
    gate.sections.map((s) => `${s.sectionId}:${s.status}`).join(" "));
  check("A8: thresholds are the documented constants",
    gate.thresholds.fail === 0.4 && gate.thresholds.warn === 0.2 && SECTION_GATE_FAIL_SEVERITY === 0.4 && SECTION_GATE_WARN_SEVERITY === 0.2);
  const fallback = sectionGate(defects, [], { dims });
  check("A8: no specs → honest page-level fallback (not a fabricated per-section pass)",
    fallback.mode === "page-level-fallback" && fallback.passed === false && fallback.unattributedCount === defects.length);

  // A9 — dual viewport combination modes
  const okLeg = { passed: true, sections: [] };
  check("A9: desktop-only when no mobile leg", dualViewportGate({ desktop: okLeg }).mode === "desktop-only" && dualViewportGate({ desktop: okLeg }).passed === true);
  check("A9: mobile advisory never decides", dualViewportGate({ desktop: okLeg, mobile: { passed: false }, gatingMobile: false }).mode === "desktop-gating-mobile-advisory");
  check("A9: dual-gating requires BOTH legs", dualViewportGate({ desktop: okLeg, mobile: { passed: false }, gatingMobile: true }).passed === false);
  check("A9: extended vocabulary is the skill's missing set (letterSpacing/boxShadow/transform/filters)",
    EXTENDED_STYLE_PROPS.includes("letterSpacing") && EXTENDED_STYLE_PROPS.includes("boxShadow") && EXTENDED_STYLE_PROPS.includes("transform") && EXTENDED_STYLE_PROPS.includes("filter"),
    `${EXTENDED_STYLE_PROPS.length} props`);
  result.unit = { checks: pass };
}

// =====================================================================
// Phase B — live end-to-end (real fixture server + real browser)
// =====================================================================

// Generic single-page demo site — obfuscated vocabulary (zt-* / zhero), no
// engine hint tokens; inline styles carry the extended vocabulary the stock
// extractor never captures (letter-spacing, box-shadow, transform). The
// repeated group stays at 50 — under the renderer's 60-children bound. The
// bar row is a flex container (a shape the production generator reproduces);
// table markup is deliberately absent because the production renderer's tag
// whitelist renders tr/td as div — that pre-existing engine limitation would
// fail ANY table fixture's clean-clone gate and is not this task's target.
const TICKS = 50;
const FIXTURE_HTML = `<!DOCTYPE html><html><head><title>Meridian Freight — Demo</title><style>
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
  /* spacing uses margins/gaps, NOT padding: the generator emits captured
     border-box rects as width/height and the browser reads them content-box,
     so padded elements drift (a real engine limitation the faithful build
     corrects via BORDER_BOX_CORRECTION — the fixture keeps it out of the
     pipeline clone's way) */
  .hd { display: flex; align-items: center; gap: 16px; height: 80px; background: #ffffff; }
  .hd h1 { font-size: 20px; margin: 0 0 0 24px; color: #14161a; }
  .nv { display: flex; gap: 24px; margin-left: 40px; }
  .nv a { color: #2b4c7e; text-decoration: none; font-size: 14px; }
  .zhero { background: rgb(18, 32, 64); color: #ffffff; }
  .zhero .ztitle { display: block; font-size: 48px; font-weight: 700; letter-spacing: 2px; margin: 0 0 12px 24px; text-shadow: 0 2px 4px rgba(0,0,0,0.4); }
  .zbars { display: flex; gap: 2px; align-items: flex-end; height: 160px; margin-left: 24px; }
  /* the transform must keep the tick's box INSIDE zbars — the extractor
     resolves parents by geometric containment, and a box that escapes its
     parent re-parents (honest captured evidence, but it would re-shape the
     clone's tree) */
  .zhero .ztick { width: 16px; height: 150px; background: rgba(120,140,180,0.5); transform: translateY(-4px); }
  .zgrid { display: flex; gap: 20px; background: #f7f8fa; }
  .zcard { width: 330px; background: #ffffff; border-radius: 8px; margin: 16px 0; box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
  .zcard .zimg { display: block; margin: 12px 12px 0; }
  .zcard h3 { font-size: 18px; letter-spacing: 1px; margin: 8px 12px 4px; }
  .zcard p { font-size: 14px; color: #3c3c3c; margin: 0 12px 12px; }
  .zft { display: flex; align-items: center; height: 56px; background: #14161a; color: #9aa0a8; font-size: 12px; }
  .zft span { margin-left: 24px; }
</style></head><body>
<header class="hd"><h1>Meridian Freight</h1><nav class="nv"><a href="#routes">Routes</a><a href="#ports">Ports</a><a href="#fleet">Fleet</a></nav></header>
<section class="zhero" id="routes"><div class="ztitle">Shipping lanes, visualized</div><div class="zbars">${Array.from({ length: TICKS }, () => `<span class="ztick"></span>`).join("")}</div></section>
<div class="zgrid" id="ports">${Array.from({ length: 4 }, (_, k) => `<div class="zcard"><img class="zimg" alt="chart ${k + 1}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='306' height='120'%3E%3Crect width='306' height='120' fill='%23eef1f5'/%3E%3C/svg%3E" width="306" height="120"><h3>Route ${k + 1}</h3><p>Legs ${k + 2}–${k + 5} open.</p></div>`).join("")}</div>
<footer class="zft"><span>Demo shipping co. — generated fixture</span></footer>
</body></html>`;

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: "http://127.0.0.1:" + server.address().port }));
  });
}

async function measureBoxes(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const el = document.querySelector(sel.replace(/^\.cx-(\d+)$/, (m, n) => `[class~="cx-${n}"]`));
      if (!el) { out[sel] = null; continue; }
      const r = el.getBoundingClientRect();
      out[sel] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, selectors);
}

{
  section("B. live end-to-end — fixture server, exploration, specs, merge equivalence, section gate");
  const t0 = Date.now();
  const jobId = `g67-${Date.now().toString(36)}`;
  const BUDGETS = { maxRoutes: 2, maxStatesPerPage: 3, maxInteractionsPerState: 3, maxTotalTimeMs: 90000 };
  let fx = null;
  try {
    fx = await startFixtureServer();
    result.live.base = fx.base;

    // ---- B1: exploration (real pipeline, real browser) ----
    const job = await runExplorationJob({ url: fx.base + "/", artifactsRoot: ARTIFACTS, jobId, config: { policy: { budgets: BUDGETS } } });
    const artifactsDir = job.artifactsDir;
    check("B1: exploration completed", job.manifest.status === "completed", job.manifest.status);
    result.live.artifactsDir = path.basename(artifactsDir);

    // ---- B2: understanding ----
    const loaded = loadArtifacts(artifactsDir);
    check("B2: artifacts load", loaded.ok === true, `${loaded.pages.length} page(s)`);
    const lp = loaded.pages.find((p) => p.elements && !p.emptyEvidence);
    const understanding = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
    check("B2: sections classified from generic evidence", (understanding.components || []).length >= 3,
      `${(understanding.components || []).length} component(s): ${(understanding.components || []).map((c) => c.kind).join(",")}`);

    // ---- B3: section spec files (technique 1) ----
    const dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "dom.json"), "utf8"));
    const elements = dom.elements;
    const built = buildSectionSpecs({ elements, understanding, interactions: [], pageId: "page-001" });
    check("B3: section specs built from real capture", built.ok === true && built.specs.length >= 2,
      `${built.specs.length} section(s), uncovered=${built.uncovered}`);
    const written = writeSectionSpecs(built.specs, artifactsDir);
    const indexOnDisk = fs.existsSync(path.join(artifactsDir, "specs", "index.json"));
    const firstSpecOnDisk = written.files.length >= 2 && fs.existsSync(path.join(artifactsDir, written.files[0].file));
    check("B3: spec files written next to the artifacts (specs/index.json + per-section)", indexOnDisk && firstSpecOnDisk,
      `${written.files.length} file(s)`);
    const reloaded = loadSectionSpecs(artifactsDir);
    check("B3: specs read back losslessly", reloaded.ok === true && reloaded.specs.length === built.specs.length);
    const domByIndex = new Map(elements.map((e) => [e.i, e]));
    const biggestSpec = built.specs.slice().sort((a, b) => b.members.length - a.members.length)[0];
    const exactStyle = biggestSpec.members.filter((m) => {
      const d = domByIndex.get(m.i);
      return d && JSON.stringify(m.style) === JSON.stringify(d.style || {});
    }).length;
    check("B3: member computed styles are byte-exact against dom.json", exactStyle >= Math.min(5, biggestSpec.members.length),
      `${exactStyle}/${biggestSpec.members.length} member(s) byte-identical`);
    const withPaths = built.specs.flatMap((s) => s.members).filter((m) => m.path).length;
    check("B3: structural paths recorded for top-level AND nested members", withPaths >= 3 && built.specs.every((s) => s.members[0].path),
      `${withPaths} member(s) with paths`);

    // ---- B4: extended computed-style capture on the ORIGINAL page (real browser) ----
    const extendedByIndex = new Map();
    const b = await launchBrowser({ headless: true });
    try {
      const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await p.goto(fx.base + "/", { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(400);
      // capture roots: every spec root PLUS the uncovered top-level elements
      // (lead-covered subtrees — their extended values feed the lead fragments)
      const byIndexAll = new Map(elements.map((e) => [e.i, e]));
      const childMapAll = childrenIndexMap(elements);
      const uncoveredRootPaths = (built.uncoveredIndexes || [])
        .filter((i) => byIndexAll.get(i)?.parent == null)
        .map((i) => structuralPathOf(i, byIndexAll, childMapAll))
        .filter(Boolean);
      const rootPaths = [
        ...built.specs.map((s) => s.members[0]?.path).filter(Boolean),
        ...uncoveredRootPaths,
      ].slice(0, 16);
      const cap = await captureExtendedStyles(p, rootPaths, { maxDepth: 6, maxChildren: 200, maxTargets: 20 });
      check("B4: extended capture resolves paths on the live page", cap.sampled > 0 && cap.unresolved.length === 0,
        `sampled=${cap.sampled} unresolved=${cap.unresolved.length}`);
      const enriched = enrichSpecsFromExtendedCapture(built.specs, cap.byPath);
      check("B4: spec members enriched with measured extended values", enriched >= 3, `${enriched} member(s) enriched`);
      for (const s of built.specs) for (const m of s.members) if (m.extended) extendedByIndex.set(m.i, m.extended);
      // uncovered (lead-covered) elements: their measured extended values feed
      // the lead fragments' spec-faithful emission
      for (const i of built.uncoveredIndexes || []) {
        const pEl = structuralPathOf(i, byIndexAll, childMapAll);
        const ext = pEl ? cap.byPath[pEl] : null;
        if (ext && Object.keys(ext).length) extendedByIndex.set(i, ext);
      }
      const titleMember = built.specs.flatMap((s) => s.members).find((m) => (m.cls || "").includes("ztitle"));
      const tickMember = built.specs.flatMap((s) => s.members).find((m) => (m.cls || "").includes("ztick"));
      const cardMember = built.specs.flatMap((s) => s.members).find((m) => (m.cls || "").includes("zcard"));
      const h3Member = built.specs.flatMap((s) => s.members).find((m) => m.tag === "h3");
      check("B4: letterSpacing measured where the fixture sets it (skill vocabulary gap closed)",
        !!h3Member && h3Member.extended && h3Member.extended.letterSpacing === "1px",
        h3Member?.extended ? h3Member.extended.letterSpacing : "missing");
      check("B4: transform measured on the hero ticks", !!tickMember && !!tickMember.extended?.transform, tickMember?.extended?.transform || "missing");
      check("B4: boxShadow measured on the cards", !!cardMember && !!cardMember.extended?.boxShadow, cardMember?.extended?.boxShadow || "missing");
      await p.close();
    } finally {
      await b.close().catch(() => {});
    }

    // ---- B5: reconstruction (existing pipeline, untouched) ----
    const outDir = path.join(ARTIFACTS, jobId + "-project");
    const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
    check("B5: reconstruction ok", rec.ok === true, rec.ok ? `rounds=${rec.report.rounds.length} files=${rec.report.generatedFiles}` : JSON.stringify(rec.report?.limitations || []).slice(0, 140));

    // ---- B6: parallel builders + deterministic merge (technique 2) ----
    const parentOf = new Map(elements.map((e) => [e.i, e.parent]));
    const childMap = childrenIndexMap(elements);
    const plan = planSectionBuilders(built.specs, { parentOf, budget: 40 }); // tight budget → live split path
    const splits = plan.plan.builders.filter((x) => x.role === "sub-component").length;
    const wrappers = plan.plan.builders.filter((x) => x.role === "wrapper").length;
    check("B6: live plan with forced budget splits sections into sub-builders + wrappers", plan.ok === true && splits >= 2 && wrappers >= 1,
      `builders=${plan.plan.builders.length} (subs=${splits}, wrappers=${wrappers})`);
    const baseCtx = {
      elementsByIndex: new Map(elements.map((e) => [e.i, e])), childMap,
      layoutByIndex: (() => {
        const rectMap = new Map(elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
        return new Map(Object.entries(analyzeLayout(elements, rectMap)).map(([k, v]) => [Number(k), v]));
      })(),
      wireByIndex: new Map(), assetByIndex: new Map(), streamByIndex: new Map(), routeFileMap: new Map(),
      claimedIndexes: new Set(built.specs.flatMap((s) => s.members.map((m) => m.i))),
    };
    const fragments = plan.plan.builders.map((x) => buildSectionFragment(x, baseCtx));
    // lead roots: component-tree roots that are not section roots
    const tree = buildComponentTree(dom, "page-001");
    const sectionRoots = new Set(plan.plan.builders.filter((x) => x.role !== "sub-component").map((x) => x.rootIndex));
    const treeRootIdxs = (tree.children || []).map((n) => n._elementIndex);
    const leadRoots = treeRootIdxs.filter((idx) => !sectionRoots.has(idx));
    const leads = buildLeadFragments(leadRoots, baseCtx);
    const merge = mergeSectionFragments({ fragments, plan: plan.plan, leadFragments: leads, parentOf });
    const planWritten = writeBuildPlan(artifactsDir, plan.plan, merge);
    check("B6: merge resolves with zero conflicts (each element claimed once)",
      merge.conflicts.length === 0 && merge.mergedSections >= 2, `conflicts=${merge.conflicts.length}, sections=${merge.mergedSections}, subsMerged=${merge.subComponentsMerged}, nestedInLead=${merge.nestedInLead.length}`);
    check("B6: build plan persisted (specs/build-plan.json)", planWritten.ok === true && fs.existsSync(path.join(artifactsDir, planWritten.file)));
    check("B6: wrapper markers fully resolved", !merge.html.includes("merge:"), merge.html.includes("merge:") ? "marker left" : "clean");

    // render-equivalence: merged per-section output vs the monolithic generator,
    // measured in a real browser at 1440×900 (tolerance = the analyzer's 2px)
    const b2 = await launchBrowser({ headless: true });
    try {
      const monolithic = generatePageHtml({ url: fx.base + "/", pageId: "page-001" }, { children: [tree] }, {
        routeFileMap: new Map(), interactionsByIndex: new Map(), assetByIndex: new Map(), streamByIndex: null, hasStreams: false,
      });
      // the monolithic page wraps everything in the generator's root <div class="cx-x">
      // (generatePageHtml renders the tree root); layout.css's `body > .cx-N`
      // rules are calibrated to that structure — the merged page must carry the
      // same wrapper or those selectors hit different elements
      const mergedPage = monolithic.replace(/<body[^>]*>[\s\S]*<\/body>/, (m) => m.replace(/(?<=<body[^>]*>)[\s\S]*(?=<script)/, "\n" + '<div class="cx-x">\n' + merge.html + "\n</div>\n"));
      const mergedDir = path.join(ARTIFACTS, jobId + "-merged");
      fs.mkdirSync(path.join(mergedDir, "styles"), { recursive: true });
      fs.mkdirSync(path.join(mergedDir, "runtime"), { recursive: true });
      fs.copyFileSync(path.join(outDir, "styles", "tokens.css"), path.join(mergedDir, "styles", "tokens.css"));
      fs.copyFileSync(path.join(outDir, "styles", "layout.css"), path.join(mergedDir, "styles", "layout.css"));
      fs.writeFileSync(path.join(mergedDir, "styles", "components.css"), merge.css);
      fs.writeFileSync(path.join(mergedDir, "runtime", "interactions.js"), ";");
      fs.writeFileSync(path.join(mergedDir, "index.html"), mergedPage);
      result.live.mergedDir = path.basename(mergedDir);
      const p = await b2.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const allIdx = [...new Set(elements.map((e) => e.i))];
      const sels = allIdx.map((idx) => `.cx-${idx}`);
      await p.goto("file:///" + path.join(outDir, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(500);
      const monoBoxes = await measureBoxes(p, sels);
      await p.goto("file:///" + path.join(mergedDir, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(500);
      const mergedBoxes = await measureBoxes(p, sels);
      const compared = [];
      let maxDelta = 0;
      for (const sel of sels) {
        const a = monoBoxes[sel], bb = mergedBoxes[sel];
        if (!a || !bb) continue;
        const d = Math.max(Math.abs(a.x - bb.x), Math.abs(a.y - bb.y), Math.abs(a.w - bb.w), Math.abs(a.h - bb.h));
        compared.push({ sel, d: +d.toFixed(2) });
        if (d > maxDelta) maxDelta = d;
      }
      result.live.renderEquivalence = { compared: compared.length, ofElements: allIdx.length, maxDeltaPx: +maxDelta.toFixed(2), tolerance: GEOMETRY_TOLERANCE_PX };
      check("B6: RENDER EQUIVALENCE — merged per-section output matches the monolithic generator within the 2px geometry tolerance",
        compared.length >= Math.floor(allIdx.length * 0.9) && maxDelta <= GEOMETRY_TOLERANCE_PX,
        `${compared.length}/${allIdx.length} element(s) compared, maxDelta=${maxDelta.toFixed(2)}px`);
      if (maxDelta > GEOMETRY_TOLERANCE_PX) console.log("    worst:", JSON.stringify(compared.slice().sort((a, bb) => bb.d - a.d).slice(0, 5)));
      await p.close();
    } finally {
      await b2.close().catch(() => {});
    }

    // ---- B7: section visual gate on the CLEAN clone (technique 3) ----
    const gate1 = await runSectionVisualGate({ artifactsDir, cloneDir: outDir, specs: built.specs, viewports: [{ name: "desktop", width: 1440, height: 900 }] });
    check("B7: gate ran on the real clone", gate1.ok === true && gate1.perViewport.desktop && !gate1.perViewport.desktop.skipped,
      gate1.ok ? `mode=${gate1.gate.mode}, passed=${gate1.gate.passed}, pixel=${gate1.perViewport.desktop.pixel?.similarityPct}%` : gate1.why);
    check("B7: per-section attribution active on real evidence",
      gate1.ok && gate1.perViewport.desktop.gate.mode === "per-section" && gate1.perViewport.desktop.gate.sections.length >= 2,
      gate1.ok ? `${gate1.perViewport.desktop.gate.sections.length} section(s)` : "n/a");
    check("B7: clean clone passes the section gate", gate1.ok && gate1.gate.passed === true,
      gate1.ok ? `worstSeverity=${gate1.perViewport.desktop.gate.worstSeverity}; sections=${gate1.perViewport.desktop.gate.sections.map((s) => `${s.sectionId}:${s.status}:${s.worstSeverity}`).join(" ")}` : "n/a");
    result.live.cleanGate = gate1.ok ? { passed: gate1.gate.passed, pixel: gate1.perViewport.desktop.pixel, sections: gate1.perViewport.desktop.gate.sections.length } : null;

    // ---- B7b: spec-faithful build — extended captured values folded into the
    // built CSS (technique 1 feeding technique 2), gated like any clone ----
    const faithfulCtx = { ...baseCtx, extendedByIndex };
    const faithfulFragments = plan.plan.builders.map((x) => buildSectionFragment(x, faithfulCtx));
    const faithfulLeads = buildLeadFragments(leadRoots, faithfulCtx);
    const faithfulMerge = mergeSectionFragments({ fragments: faithfulFragments, plan: plan.plan, leadFragments: faithfulLeads, parentOf, borderBoxCorrection: true });
    const faithfulDir = path.join(ARTIFACTS, jobId + "-faithful");
    fs.mkdirSync(path.join(faithfulDir, "styles"), { recursive: true });
    fs.mkdirSync(path.join(faithfulDir, "runtime"), { recursive: true });
    fs.copyFileSync(path.join(outDir, "styles", "tokens.css"), path.join(faithfulDir, "styles", "tokens.css"));
    fs.copyFileSync(path.join(outDir, "styles", "layout.css"), path.join(faithfulDir, "styles", "layout.css"));
    fs.writeFileSync(path.join(faithfulDir, "styles", "components.css"), faithfulMerge.css);
    fs.writeFileSync(path.join(faithfulDir, "runtime", "interactions.js"), ";");
    fs.writeFileSync(path.join(faithfulDir, "index.html"), fs.readFileSync(path.join(ARTIFACTS, jobId + "-merged", "index.html"), "utf8").replace(/<style>[\s\S]*?<\/style>/, "").replace(/<link rel="stylesheet" href="styles\/components.css">/, '<link rel="stylesheet" href="styles/components.css">'));
    check("B7b: spec-faithful CSS carries the extended captured values (letter-spacing/box-shadow/transform)",
      faithfulMerge.css.includes("letter-spacing: 1px") && faithfulMerge.css.includes("letter-spacing: 2px") &&
        faithfulMerge.css.includes("box-shadow:") && faithfulMerge.css.includes("transform: matrix(1, 0, 0, 1, 0, -4)"),
      `extended rules=${(faithfulMerge.css.match(/letter-spacing|box-shadow|transform:/g) || []).length}`);
    const gateF = await runSectionVisualGate({ artifactsDir, cloneDir: faithfulDir, specs: built.specs, viewports: [{ name: "desktop", width: 1440, height: 900 }] });
    const pxPipeline = gate1.ok ? gate1.perViewport.desktop.pixel.similarityPct : null;
    const pxFaithful = gateF.ok ? gateF.perViewport.desktop.pixel.similarityPct : null;
    check("B7b: spec-faithful build passes the section gate without regressing the gate metric",
      gateF.ok && gateF.gate.passed === true && pxFaithful !== null && pxPipeline !== null &&
        gateF.perViewport.desktop.gate.worstSeverity <= gate1.perViewport.desktop.gate.worstSeverity,
      `faithful=${pxFaithful}% (worst ${gateF.ok ? gateF.perViewport.desktop.gate.worstSeverity : "?"}) vs pipeline=${pxPipeline}% (worst ${gate1.ok ? gate1.perViewport.desktop.gate.worstSeverity : "?"})`);
    result.live.faithfulGate = gateF.ok ? { passed: gateF.gate.passed, pixel: gateF.perViewport.desktop.pixel } : null;

    // ---- B8: drifted clone must fail ONLY the drifted section ----
    // Background + typography drift on the card-GRID root and one card heading:
    // attribution follows the captured member sets (the container spec claims
    // its subtree first), the drift does not shift layout outside the grid
    // (explicit heights), so exactly one section must fail.
    const gridSpec = built.specs.find((s) => (s.members[0]?.cls || "").includes("zgrid")) || built.specs[0];
    const gridRoot = gridSpec.members[0].i;
    const gridH3 = gridSpec.members.find((m) => m.tag === "h3") || gridSpec.members[1];
    const indexHtmlPath = path.join(outDir, "index.html");
    const originalHtml = fs.readFileSync(indexHtmlPath, "utf8");
    try {
      const drift = `<style>.cx-${gridRoot} { background-color: rgb(255, 0, 0) !important; } .cx-${gridH3.i} { font-size: 28px !important; }</style></head>`;
      fs.writeFileSync(indexHtmlPath, originalHtml.replace("</head>", drift));
      const gate2 = await runSectionVisualGate({ artifactsDir, cloneDir: outDir, specs: built.specs, viewports: [{ name: "desktop", width: 1440, height: 900 }] });
      const drifted = gate2.ok ? gate2.perViewport.desktop.gate.sections.find((s) => s.sectionId === gridSpec.sectionId) : null;
      check("B8: drifted clone FAILS the gate", gate2.ok && gate2.gate.passed === false,
        gate2.ok ? `passed=${gate2.gate.passed}, worst=${gate2.perViewport.desktop.gate.worstSeverity}` : gate2.why);
      check("B8: the DRIFTED section fails with clone-drift verdicts (repair-against-spec route)",
        !!drifted && drifted.status === "fail" && (drifted.verdicts["clone-drift"] || 0) >= 1 && drifted.repairRoute === "repair-against-spec",
        drifted ? `status=${drifted.status}, verdicts=${JSON.stringify(drifted.verdicts)}, top=${JSON.stringify(drifted.topDefects.slice(0, 2))}` : "n/a");
      check("B8: untouched sections still pass (attribution is local, not page-wide)",
        gate2.ok ? gate2.perViewport.desktop.gate.sections.filter((s) => s.sectionId !== gridSpec.sectionId).every((s) => s.status !== "fail") : false,
        gate2.ok ? gate2.perViewport.desktop.gate.sections.map((s) => `${s.sectionId}:${s.status}`).join(" ") : "n/a");
      result.live.driftGate = gate2.ok ? { passed: gate2.gate.passed, driftedSection: drifted?.status, verdicts: drifted?.verdicts } : null;
    } finally {
      fs.writeFileSync(indexHtmlPath, originalHtml); // restore the clean clone
    }

    // ---- B9: dual-viewport gate (1440 + 390, real original captures) ----
    const b3 = await launchBrowser({ headless: true });
    try {
      const p = await b3.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await p.goto(fx.base + "/", { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(500);
      const mobilePng = await p.screenshot({ timeout: 20000 });
      const mobileIntel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      await p.close();
      const gate3 = await runSectionVisualGate({
        artifactsDir, cloneDir: outDir, specs: built.specs,
        viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }],
        originalByViewport: { mobile: { png: mobilePng, elements: mobileIntel?.elements || [] } },
      });
      const mob = gate3.ok ? gate3.perViewport.mobile : null;
      check("B9: mobile leg measured against a real 390px original capture",
        gate3.ok && mob && !mob.skipped, gate3.ok ? `pixel=${mob.pixel?.similarityPct}%, passed=${mob.gate?.passed}` : gate3.why);
      check("B9: dual-viewport mode is dual-gating (both legs decide)",
        gate3.ok && gate3.gate.mode === "dual-gating", gate3.ok ? gate3.gate.mode : "n/a");
      check("B9: mobile leg produces per-section attribution too",
        gate3.ok && mob?.gate?.mode === "per-section", gate3.ok ? `${mob?.gate?.sections?.length} section(s)` : "n/a");
      result.live.dualGate = gate3.ok ? {
        mode: gate3.gate.mode, passed: gate3.gate.passed,
        desktop: gate3.perViewport.desktop?.pixel, mobilePixel: mob?.pixel, mobilePassed: mob?.gate?.passed,
      } : null;
      const gateFile = path.join(artifactsDir, "specs", "section-gate.json");
      check("B9: gate report persisted (specs/section-gate.json)", fs.existsSync(gateFile));
    } finally {
      await b3.close().catch(() => {});
    }
  } catch (e) {
    check("B: live phase completed without crash", false, String(e?.stack || e?.message || e).slice(0, 300));
  } finally {
    if (fx) await new Promise((r) => fx.server.close(r));
  }
  result.timings.liveMs = Date.now() - t0;
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
console.log(`\n${pass} passed, ${fail} failed — skill-integration run took ${(result.durationMs / 1000).toFixed(1)}s`);
process.exit(fail ? 1 : 0);
