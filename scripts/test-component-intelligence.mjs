process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Component-intelligence tests (task 3.5.2) — cross-page reusable-component
// pattern detection + registry. ZERO NETWORK by default.
//
// Sections:
//  [1] component-evidence 3.5.2 primitives: structure signature, interaction
//      shape, context resolution — determinism, content/geometry exclusion,
//      normalization.
//  [2] buildComponentRegistry on SYNTHETIC understanding models (no browser):
//      cross-page linking (one pattern id, many instances), instance-specific
//      property preservation through annotate, coincidental-similarity guard
//      (behavior split), context split, confidence floors, minPages, input
//      tolerance, output determinism incl. input-order independence.
//  [3] e2e multi-route fixture (real exploration job, 4 pages): the SAME
//      navigation and main-workspace components recurring on every page must be
//      detected ONCE each and linked by one pattern id on all pages; the
//      single-page pricing table must NOT become a cross-page pattern.
//  [4] e2e inline pattern site (3 routes served here): repeated header,
//      navigation, product cards across routes — plus a decoy product card
//      whose add-to-cart button carries a trigger mark (same structure,
//      different behavior) that must stay unlinked, and single-page table/form
//      that must not merge into anything.
//
// A global fetch tripwire fails the run if ANY network call is attempted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { multiRouteSite } = await import("../scripts/fixtures/index.mjs");
const { startFixtureServer, sendHtml, reqUrl } = await import("../scripts/fixtures/server.mjs");
const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { loadArtifacts } = await import("../src/reconstruction/artifact-loader.js");
const {
  componentStructureSignature, componentInteractionShape, componentContext,
  buildComponentRegistry, registryForPage, annotateUnderstanding, registrySummary,
} = await import("../src/reconstruction/component-evidence.js");
const { buildUnderstandingPage, pageArtifactsFromLoaded } = await import(
  "../src/reconstruction/website-understanding.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- zero-network tripwire ----
const fetchAttempts = [];
globalThis.fetch = (...args) => {
  fetchAttempts.push(String(args[0]));
  return Promise.reject(new Error("NETWORK_BLOCKED_BY_TEST"));
};

// ---- helpers ----
// mkComp(): a minimal understanding-shaped component (website-understanding
// output contract: id/kind/confidence/evidence/interaction/provenance)
let cid = 0;
const mkComp = (kind, { tag = "div", cls = null, role = null, confidence = 0.9, text = null,
  triggers = 0, networkRefs = 0, evidenceSources = ["dom-tag"], id = null, repSig = null } = {}) => ({
  id: id || `c-${++cid}`,
  kind, elementIndex: cid, tag, cls, role,
  confidence,
  evidence: evidenceSources.map((s) => ({ source: s, ref: `elements[${cid}]`, note: "", weight: confidence })),
  provenance: { tag, cls, text },
  interaction: {
    triggers: Array.from({ length: triggers }, (_, k) => ({ id: `t-${k}`, elementIndex: cid, label: null })),
    networkRefs: Array.from({ length: networkRefs }, (_, k) => `network:/img/${k}.png`),
  },
  repeated: repSig ? { signature: repSig, siblings: 3 } : null,
});
const mkPage = (pageId, components, { parentEdges = [] } = {}) => ({
  pageId,
  components,
  relationships: { parentChild: parentEdges, repeatedGroups: [] },
});

// =====================================================================
console.log("\n[1] signature / interaction-shape / context primitives");
{
  const a = mkComp("card", { cls: "product-card" });
  const b = mkComp("card", { cls: "product-card" });
  check("identical structure → identical signature (deterministic)",
    componentStructureSignature(a) === componentStructureSignature(b) && componentStructureSignature(a) === "card|div|-|card,product",
    componentStructureSignature(a));
  // content + geometry + within-page repetition are INSTANCE/ARRANGEMENT
  // properties and must NOT enter the signature
  const withContent = { ...a, provenance: { ...a.provenance, text: "Totally different words" }, rect: { x: 9, y: 9, w: 999, h: 999 }, repeated: { signature: "product-card", siblings: 3 } };
  check("text/rect/repetition excluded — instance content never splits a pattern",
    componentStructureSignature(withContent) === componentStructureSignature(a),
    componentStructureSignature(withContent));
  check("class token order normalized", componentStructureSignature(mkComp("card", { cls: "Card Product" })) === componentStructureSignature(a),
    componentStructureSignature(mkComp("card", { cls: "Card Product" })));
  check("tag/role participate (case-normalized), empty classes → '-'",
    componentStructureSignature(mkComp("header", { tag: "HEADER", role: "Banner" })) === "header|header|banner|-",
    componentStructureSignature(mkComp("header", { tag: "HEADER", role: "Banner" })));
  check("non-record → null signature", componentStructureSignature(null) === null && componentStructureSignature(42) === null);

  check("interaction shape: trigger count exact", componentInteractionShape(mkComp("card", { triggers: 2 })) === "t2|n0", componentInteractionShape(mkComp("card", { triggers: 2 })));
  check("interaction shape: network refs quantized (0 / exact small / 4+)",
    componentInteractionShape(mkComp("card", { networkRefs: 3 })) === "t0|n3" &&
    componentInteractionShape(mkComp("card", { networkRefs: 7 })) === "t0|n4+",
    componentInteractionShape(mkComp("card", { networkRefs: 7 })));

  const parent = mkComp("card-grid", { cls: "grid", id: "u-0" });
  const child = mkComp("card", { cls: "card", id: "u-1" });
  const page = mkPage("p1", [parent, child], { parentEdges: [{ parent: "u-0", child: "u-1", via: "containment" }] });
  check("context: parent's classified kind", componentContext(child, page) === "card-grid", componentContext(child, page));
  check("context: no classified parent → (root)", componentContext(parent, page) === "(root)", componentContext(parent, page));
  check("context: dangling parent edge → (root)", componentContext({ ...child, id: "u-ghost" }, page) === "(root)");
}

// =====================================================================
console.log("\n[2] buildComponentRegistry — synthetic multi-page models");
const SYNSHARED = {
  header: () => mkComp("header", { tag: "header", cls: "site-header", confidence: 0.95, evidenceSources: ["dom-tag", "geometry"] }),
  nav: (label) => mkComp("navigation", { tag: "nav", cls: "main-nav", confidence: 0.96, text: label, evidenceSources: ["dom-tag", "dom-class", "geometry"] }),
  workspace: () => mkComp("workspace", { tag: "main", cls: "content", confidence: 0.85 }),
};
console.log("  [2a] cross-page linking: one pattern id, every instance linked");
{
  const pages = ["alpha", "beta", "gamma"].map((p) => mkPage(p, [SYNSHARED.header(), SYNSHARED.nav(`Nav of ${p}`), SYNSHARED.workspace()]));
  const reg = buildComponentRegistry(pages);
  check("one pattern per recurring kind (detected ONCE, not per page)",
    reg.patterns.filter((p) => p.kind === "navigation").length === 1 &&
    reg.patterns.filter((p) => p.kind === "header").length === 1 &&
    reg.patterns.filter((p) => p.kind === "workspace").length === 1,
    reg.patterns.map((p) => `${p.kind}:${p.patternId}`).join(" "));
  const navPattern = reg.patterns.find((p) => p.kind === "navigation");
  check("pattern spans all pages with every instance recorded",
    navPattern.pages.join(",") === "alpha,beta,gamma" && navPattern.instanceCount === 3 &&
    navPattern.instances.every((i) => i.pageId && i.componentId && typeof i.elementIndex === "number"),
    JSON.stringify(navPattern.pages));
  check("pattern confidence: noisy-OR across independent instances, capped ≤ 0.99",
    navPattern.confidence > 0.96 && navPattern.confidence <= 0.99, String(navPattern.confidence));
  check("pattern provenance: union of evidence sources + example instance",
    JSON.stringify(navPattern.provenance.evidenceSources) === JSON.stringify(["dom-class", "dom-tag", "geometry"]) &&
    navPattern.provenance.example.pageId === "alpha",
    JSON.stringify(navPattern.provenance.evidenceSources));

  const annotated = pages.map((p) => annotateUnderstanding(p, reg));
  const navIds = annotated.map((u) => u.components.find((c) => c.kind === "navigation").pattern?.patternId);
  check("every page's nav instance linked to the SAME patternId", new Set(navIds).size === 1 && navIds[0] === navPattern.patternId, navIds.join(","));
  check("annotate is additive: instance keeps id/text/evidence (instance-specific overrides preserved)",
    annotated[1].components.find((c) => c.kind === "navigation").provenance.text === "Nav of beta" &&
    JSON.stringify(annotated[1].components.find((c) => c.kind === "navigation").evidence) === JSON.stringify(pages[1].components.find((c) => c.kind === "navigation").evidence));
  const before = JSON.stringify(pages);
  annotateUnderstanding(pages[0], reg);
  check("annotate does NOT mutate the input model", JSON.stringify(pages) === before);

  const again = buildComponentRegistry(pages);
  check("registry deterministic: identical input → identical output", JSON.stringify(again) === JSON.stringify(reg));
  const shuffled = buildComponentRegistry([pages[2], pages[0], pages[1]]);
  check("input-order independent (same patterns, same ids, same output JSON)", JSON.stringify(shuffled) === JSON.stringify(reg));
}

console.log("  [2b] coincidental-similarity guard: same structure, different behavior → kept separate");
{
  const plain = () => mkComp("card", { cls: "product-card", confidence: 0.89, evidenceSources: ["dom-class", "repetition", "geometry"], repSig: "product-card" });
  const interactive = mkComp("card", { cls: "product-card", confidence: 0.89, triggers: 1, evidenceSources: ["dom-class", "repetition", "geometry"], repSig: "product-card", id: "c-decoy" });
  const pages = [
    mkPage("home", [plain({}), plain(), plain()]),
    mkPage("catalog", [plain(), interactive, plain()]),
  ];
  const reg = buildComponentRegistry(pages);
  const cardPatterns = reg.patterns.filter((p) => p.kind === "card");
  check("plain cards across pages form exactly ONE pattern; the trigger-decoy never merges in",
    cardPatterns.length === 1 && cardPatterns[0].instanceCount === 5 && !cardPatterns[0].instances.some((i) => i.componentId === "c-decoy"),
    `${cardPatterns.length} pattern(s), ${cardPatterns[0]?.instanceCount} instances`);
  const decoy = reg.unlinked.find((u) => u.componentId === "c-decoy");
  check("decoy recorded as unlinked with an explicit reason", !!decoy && /recurs on 1 page/.test(decoy.reason), decoy?.reason);
  check("coincidental-similarity warning surfaced", reg.warnings.some((w) => /coincidental-similarity guard/.test(w) && /card\|div/.test(w)), reg.warnings.join(" | "));
  const annotated = annotateUnderstanding(pages[1], reg);
  check("decoy instance carries NO pattern link after annotate",
    annotated.components.find((c) => c.id === "c-decoy").pattern === undefined &&
    annotated.components.filter((c) => c.kind === "card" && c.pattern).length === 2);
}

console.log("  [2c] context split + confidence floor + thresholds");
{
  // same structure + behavior, but different parent context on each side —
  // both sides recur on 2 pages, so BOTH form patterns, separately
  const rootCard = (id) => mkComp("card", { cls: "card", confidence: 0.9, id });
  const sideCard = (id) => mkComp("card", { cls: "card", confidence: 0.9, id });
  const mkSide = (id) => mkComp("sidebar", { tag: "aside", cls: "rail", id });
  const pages = [
    mkPage("a", [rootCard("r-1")]),
    mkPage("b", [rootCard("r-2")]),
    mkPage("c", [mkSide("u-side-1"), sideCard("s-1")], { parentEdges: [{ parent: "u-side-1", child: "s-1", via: "containment" }] }),
    mkPage("d", [mkSide("u-side-2"), sideCard("s-2")], { parentEdges: [{ parent: "u-side-2", child: "s-2", via: "containment" }] }),
  ];
  const reg = buildComponentRegistry(pages);
  const cardPatterns = reg.patterns.filter((p) => p.kind === "card");
  check("same structure+behavior but different parent context → TWO separate patterns",
    cardPatterns.length === 2 && new Set(cardPatterns.map((p) => p.context)).size === 2 &&
    cardPatterns.some((p) => p.context === "sidebar") && cardPatterns.some((p) => p.context === "(root)"),
    cardPatterns.map((p) => p.context).join(" | "));

  const weak = mkComp("header", { tag: "header", cls: "site-header", confidence: 0.3, id: "c-weak" });
  const strongHeader = SYNSHARED.header();
  const regFloor = buildComponentRegistry([mkPage("a", [weak]), mkPage("b", [strongHeader])]);
  check("instance below minConfidence floor never linked; the strong leftover cannot pattern alone either",
    regFloor.patterns.filter((p) => p.kind === "header").length === 0 &&
    regFloor.unlinked.some((u) => u.componentId === "c-weak" && /below floor/.test(u.reason)) &&
    regFloor.unlinked.some((u) => u.componentId === strongHeader.id && /fewer than minPages/.test(u.reason)),
    JSON.stringify(regFloor.unlinked));

  const reg1Page = buildComponentRegistry([mkPage("solo", [mkComp("card", { cls: "tile" }), mkComp("card", { cls: "tile" })])], { minPages: 1 });
  check("minPages:1 opts in same-page repetition as a pattern; default minPages:2 does not",
    reg1Page.patterns.length === 1 && reg1Page.patterns[0].pages.join(",") === "solo" &&
    buildComponentRegistry([mkPage("solo", [mkComp("card", { cls: "tile" }), mkComp("card", { cls: "tile" })])]).unlinked.some((u) => /fewer than minPages/.test(u.reason)),
    JSON.stringify(reg1Page.stats));

  const regTolerant = buildComponentRegistry([mkPage("ok", [SYNSHARED.nav("x")]), { pageId: "bad", understanding: { pageId: "bad" } }, null]);
  check("malformed input entries skipped with a warning, good entries still processed",
    regTolerant.stats.pages === 1 && regTolerant.warnings.some((w) => /skipped/.test(w)), regTolerant.warnings.join(" | "));

  const onPage = registryForPage(reg, "b");
  check("registryForPage: page-scoped pattern + instances only",
    onPage.pageId === "b" && onPage.patterns.length === 1 && onPage.patterns[0].context === "(root)" &&
    onPage.instances.length === 1 && onPage.instances[0].componentId === "r-2" && onPage.instances[0].patternId === onPage.patterns[0].patternId,
    `${onPage.patterns.length} patterns / ${onPage.instances.length} instances`);
  const sum = registrySummary(reg);
  check("registrySummary: compact per-kind counts", sum.patterns === reg.patterns.length && sum.patternsByKind.card === 2 && sum.linkedInstances === 6, JSON.stringify(sum));
}

// =====================================================================
console.log("\n[3] e2e multi-route fixture — nav + workspace recurring across 4 pages");
try {
  const { base, close } = await startFixtureServer(multiRouteSite);
  try {
    const { artifactsDir } = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(PROJECT, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 4, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 180000 } } },
    });
    const loaded = loadArtifacts(artifactsDir);
    check("multi-page fixture captured (>= 3 pages)", loaded.ok === true && loaded.pages.length >= 3, `${loaded.pages.length} pages`);
    const pathnameOf = (p) => { try { return new URL(p.url).pathname; } catch { return null; } };
    const pageRecords = [];
    for (const lp of loaded.pages) {
      const u = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
      pageRecords.push({ pageId: lp.pageId, understanding: u });
    }
    const reg = buildComponentRegistry(pageRecords);
    const navPattern = reg.patterns.find((p) => p.kind === "navigation");
    const wsPattern = reg.patterns.find((p) => p.kind === "workspace");
    check("navigation detected ONCE as a cross-page pattern (not per page)",
      reg.patterns.filter((p) => p.kind === "navigation").length === 1 && navPattern.pages.length === loaded.pages.length,
      `pages=[${navPattern?.pages.join(",")}]`);
    check("workspace (main) also detected once across all pages",
      reg.patterns.filter((p) => p.kind === "workspace").length === 1 && wsPattern.pages.length === loaded.pages.length,
      `pages=[${wsPattern?.pages.join(",")}]`);
    check("both patterns are strong (confidence >= 0.95 from noisy-OR across instances)",
      navPattern.confidence >= 0.95 && wsPattern.confidence >= 0.95,
      `nav=${navPattern?.confidence} ws=${wsPattern?.confidence}`);
    check("single-page pricing table did NOT become a cross-page pattern",
      !reg.patterns.some((p) => p.kind === "table") && reg.unlinked.some((u) => u.kind === "table" && /fewer than minPages/.test(u.reason)),
      reg.unlinked.filter((u) => u.kind === "table").map((u) => u.reason).join(" | "));

    const annotated = pageRecords.map((r) => ({ ...r, understanding: annotateUnderstanding(r.understanding, reg) }));
    const navIds = annotated.map((r) => r.understanding.components.find((c) => c.kind === "navigation")?.pattern?.patternId);
    check("every page's navigation instance linked to the SAME patternId",
      new Set(navIds).size === 1 && navIds[0] === navPattern.patternId, navIds.join(","));
    check("annotated instances keep their page-specific provenance (cls site-nav everywhere, own ids)",
      annotated.every((r) => {
        const nav = r.understanding.components.find((c) => c.kind === "navigation");
        return nav.pattern && nav.provenance.cls === "site-nav" && !navPattern.instances.some((i) => i.componentId !== nav.id && i.componentId === nav.id);
      }));
    const reg2 = buildComponentRegistry(pageRecords);
    check("e2e registry deterministic", JSON.stringify(reg2) === JSON.stringify(reg));
    check("ZERO network attempts during e2e", fetchAttempts.length === 0, `${fetchAttempts.length} attempts`);
  } finally {
    await close();
  }
} catch (e) {
  check("multi-route e2e no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

// =====================================================================
console.log("\n[4] e2e inline pattern site — header/nav/product-cards across 3 routes + guards");
// 3 routes share <header class="site-header"> + <nav class="main-nav"> +
// <main>. All three carry product-card grids with DIFFERENT instance counts
// (3 / 3 / 2 — instance-count differences must not split the shared card
// component). "/catalog" hides ONE decoy card whose buy button carries a
// data-cloner-trigger (same structure, different behavior); "/catalog" also has
// a spec table and "/contact" a contact form — single-page, must not merge.
const PNAV = `<header class="site-header"><span class="brand">Patternly</span></header>
<nav class="main-nav"><a href="/">Home</a><a href="/catalog">Catalog</a><a href="/contact">Contact</a></nav>`;
const CARD = (name, blurb, trigger = null) =>
  `<div class="product-card"><h3>${name}</h3><p>${blurb}</p>${trigger ? `<button class="buy" data-cloner-trigger="${trigger}">Add</button>` : `<a class="buy" href="/contact">Buy</a>`}</div>`;
const PAGE_CSS = `body{font-family:Arial;margin:0;background:#f4f5f7}
.site-header{background:#17324d;color:#fff;padding:12px 20px}
.main-nav{background:#28527a;padding:10px 20px}
.main-nav a{color:#fff;margin-right:14px;text-decoration:none}
main{max-width:820px;margin:24px auto;background:#fff;padding:24px;min-height:320px}
.cards-grid{display:flex;gap:16px}
.product-card{width:220px;border:1px solid #c8d0d8;padding:12px}
.buy{display:inline-block;padding:4px 10px;background:#28527a;color:#fff;text-decoration:none}`;
const PATTERN_PAGES = {
  "/": `<!DOCTYPE html><html><head><title>Patternly — Home</title><style>${PAGE_CSS}</style></head><body>${PNAV}<main>
<h1>Patternly home</h1>
<div class="cards-grid">${CARD("Alpha Kit", "Starter component kit")}${CARD("Beta Kit", "Extended kit")}${CARD("Gamma Kit", "Full kit")}</div>
</main></body></html>`,
  "/catalog": `<!DOCTYPE html><html><head><title>Patternly — Catalog</title><style>${PAGE_CSS}
.spec-table{border-collapse:collapse}
.spec-table td,.spec-table th{border:1px solid #99a;padding:6px 12px}</style></head><body>${PNAV}<main>
<h1>Catalog</h1>
<table class="spec-table"><tr><th>Kit</th><th>Parts</th></tr><tr><td>Alpha</td><td>12</td></tr><tr><td>Beta</td><td>30</td></tr></table>
<div class="cards-grid">${CARD("Delta Kit", "Catalog exclusive")}${CARD("Epsilon Kit", "Catalog second", "t-add-delta")}${CARD("Zeta Kit", "Catalog third")}</div>
</main></body></html>`,
  "/contact": `<!DOCTYPE html><html><head><title>Patternly — Contact</title><style>${PAGE_CSS}
.contact-form label{display:block;margin:8px 0 2px}
.contact-form input,.contact-form textarea{width:280px;padding:4px}</style></head><body>${PNAV}<main>
<h1>Contact us</h1>
<form class="contact-form"><label>Name<input type="text"></label><label>Message<textarea></textarea></label></form>
<div class="cards-grid">${CARD("Eta Kit", "Also sold here")}${CARD("Theta Kit", "Also sold here too")}</div>
</main></body></html>`,
};
const patternSite = {
  name: "pattern-site",
  entry: "/",
  handle(req, res) {
    const key = reqUrl(req).pathname;
    if (PATTERN_PAGES[key]) { sendHtml(res, PATTERN_PAGES[key]); return; }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
try {
  const { base, close } = await startFixtureServer(patternSite);
  try {
    const { artifactsDir } = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(PROJECT, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 3, maxStatesPerPage: 2, maxInteractionsPerState: 4, maxTotalTimeMs: 180000 } } },
    });
    const loaded = loadArtifacts(artifactsDir);
    const pathnameOf = (p) => { try { return new URL(p.url).pathname; } catch { return null; } };
    const paths = loaded.pages.map(pathnameOf).sort();
    check("all 3 routes captured", paths.join(",") === "/,/catalog,/contact", paths.join(","));
    const pageRecords = [];
    for (const lp of loaded.pages) {
      const u = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
      pageRecords.push({ pageId: lp.pageId, understanding: u, pathname: pathnameOf(lp) });
    }
    const reg = buildComponentRegistry(pageRecords);
    const oneOf = (kind) => reg.patterns.filter((p) => p.kind === kind);
    check("header + navigation each detected ONCE spanning all 3 routes",
      oneOf("header").length === 1 && oneOf("header")[0].pages.length === 3 &&
      oneOf("navigation").length === 1 && oneOf("navigation")[0].pages.length === 3,
      reg.patterns.map((p) => `${p.kind}(${p.pages.length}p)`).join(","));
    check("workspace detected ONCE (catalog diverges by descendant trigger — guarded, stays unlinked)",
      oneOf("workspace").length === 1 && oneOf("workspace")[0].pages.length >= 2 &&
      reg.unlinked.some((u) => u.kind === "workspace" && /fewer than minPages/.test(u.reason)),
      `pages=${oneOf("workspace")[0]?.pages.length}`);
    const gridPattern = oneOf("card-grid")[0];
    check("card-grid containers detected ONCE (catalog grid diverges by descendant trigger — guarded, unlinked)",
      oneOf("card-grid").length === 1 && gridPattern.pages.length >= 2 &&
      reg.unlinked.some((u) => u.kind === "card-grid" && /fewer than minPages/.test(u.reason)),
      `${gridPattern?.instanceCount} grids on [${gridPattern?.pages.join(",")}]`);
    const cardPattern = oneOf("card")[0];
    check("product cards: ONE pattern spanning 3 pages with all 7 plain instances",
      oneOf("card").length === 1 && cardPattern.pages.length === 3 && cardPattern.instanceCount === 7,
      `${cardPattern?.instanceCount} instances on [${cardPattern?.pages.join(",")}]`);
    check("card pattern provenance spans all evidence sources",
      JSON.stringify(cardPattern.provenance.evidenceSources) === JSON.stringify(["dom-class", "geometry", "repetition"]),
      JSON.stringify(cardPattern.provenance.evidenceSources));
    const decoy = reg.unlinked.find((u) => u.kind === "card" && /behavior|recurs on 1 page/.test(u.reason));
    const decoyPages = pageRecords.filter((r) => r.pathname === "/catalog");
    const decoyFound = decoyPages.length === 1 && (() => {
      const annotated = annotateUnderstanding(decoyPages[0].understanding, reg);
      const cards = annotated.components.filter((c) => c.kind === "card");
      return cards.length === 3 && cards.filter((c) => c.pattern).length === 2 && cards.some((c) => !c.pattern && c.interaction.triggers.length === 1);
    })();
    check("trigger-decoy card kept OUT of the shared card pattern (behavior differs), plain catalog cards linked",
      decoyFound && !!decoy, reg.unlinked.filter((u) => u.kind === "card").map((u) => u.reason).join(" | "));
    check("coincidental-similarity guard warning fired for the card structure",
      reg.warnings.some((w) => /coincidental-similarity guard/.test(w) && /card\|/.test(w)), reg.warnings.join(" | "));
    check("single-page table + form did NOT merge into any cross-page pattern",
      !reg.patterns.some((p) => p.kind === "table") && !reg.patterns.some((p) => p.kind === "form") &&
      reg.unlinked.some((u) => u.kind === "table") && reg.unlinked.some((u) => u.kind === "form"),
      reg.unlinked.map((u) => u.kind).join(","));
    const annotatedAll = pageRecords.map((r) => annotateUnderstanding(r.understanding, reg));
    const cardIds = annotatedAll.map((u) => u.components.filter((c) => c.kind === "card" && c.pattern).map((c) => c.pattern.patternId));
    check("all linked card instances share ONE patternId across pages",
      new Set(cardIds.flat()).size === 1 && cardIds.flat().length === 7, `${cardIds.flat().length} linked instances`);
    check("annotate is additive at e2e scale: every instance keeps its own rect/cls/provenance, only .pattern added",
      annotatedAll.every((u, pi) => u.components.every((c, ci) => {
        const orig = pageRecords[pi].understanding.components[ci];
        return JSON.stringify(c.rect) === JSON.stringify(orig.rect) &&
          c.cls === orig.cls && c.elementIndex === orig.elementIndex &&
          JSON.stringify(c.evidence) === JSON.stringify(orig.evidence) &&
          JSON.stringify(c.interaction) === JSON.stringify(orig.interaction) &&
          (c.pattern ? !orig.pattern : true);
      })),
      "");
    const reg2 = buildComponentRegistry(pageRecords);
    check("e2e registry deterministic (byte-identical rebuild)", JSON.stringify(reg2) === JSON.stringify(reg));
    check("ZERO network attempts in this section", fetchAttempts.length === 0, `${fetchAttempts.length} attempts`);
  } finally {
    await close();
  }
} catch (e) {
  check("pattern-site e2e no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
