// Phase-3.4 responsive reconstruction e2e (task 3.4.7): a fixture with REAL CSS
// media queries at 768/1024 (sidebar hidden, cards reordered, nav collapsed) →
// exploration → responsive-rule inference from captured per-viewport evidence →
// reconstruction → project augmentation → Playwright behavior assertions on the
// CLONE at 1440/768/390 against the ORIGINAL at the same widths.
//
// Honest evidence note: the exploration pipeline writes responsive.json for the
// FIRST explored page only and only for the non-primary viewports
// (src/pipeline/exploration-pipeline.js:172-181 — viewports.slice(1)), and its
// geometry holds top-level containers only (src/assets/asset-manifest.js:66-75).
// This test therefore (a) consumes the real responsive.json for the pipeline
// evidence path, and (b) runs its own multi-viewport capture
// (capturePerViewportEvidence) for the full element sets (child order, nav
// toggle, discrete width steps) the pipeline capture cannot express.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
// G5.3 SSRF guard: this suite explores a LOOPBACK fixture server — the
// documented opt-in (same pattern as scripts/test-exploration.mjs:1;
// production default stays strict).
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import {
  inferResponsiveRules,
  responsiveCss,
  loadResponsiveEvidence,
  buildDomIndex,
  capturePerViewportEvidence,
  augmentProjectWithResponsive,
  breakpointBetween,
  keyOf,
} from "../src/reconstruction/responsive-analyzer.js";
import { responsivePageSite } from "./fixtures/responsive-page.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { DEFAULT_POLICY } from "../src/exploration/exploration-policy.js";

const ROOT = path.resolve(".");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

const VIEWPORTS = DEFAULT_POLICY.viewports; // desktop 1440 / tablet 768 / mobile 390

// ---------- synthetic per-viewport set helpers (pure unit checks) ----------
const el = (tag, cls, display, rect, extra = {}) => ({
  tag, cls, display, rect,
  text: extra.text ?? "", parentKey: extra.parentKey ?? null,
  testid: extra.testid ?? null, role: extra.role ?? null,
  gridTemplateColumns: extra.gridTemplateColumns ?? null,
});
const setOf = (viewport, width, elements) => ({ viewport, width, height: 900, elements });

console.log("\n[1] uncertainty + breakpoint derivation (pure inference)");
{
  const side = (display) => el("aside", "sidebar container", display, display === "none" ? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: 260, h: 420 });
  // single viewport → no media queries at all (uncertainty preserved)
  const single = inferResponsiveRules([setOf("desktop", 1440, [side("block")])]);
  check("single-viewport evidence → no media queries", single.mediaQueries.length === 0 && single.rules.length === 0, single.notes.join("; "));
  // hidden only at mobile → breakpoint between 390 and 768
  const a = inferResponsiveRules([
    setOf("mobile", 390, [side("none")]),
    setOf("tablet", 768, [side("block")]),
    setOf("desktop", 1440, [side("block")]),
  ]);
  const ra = a.rules.find((r) => r.kind === "display-flip");
  check("mobile-only flip → band floor((390+768)/2)=579", !!ra && ra.band === 579, ra ? `band ${ra.band}` : "no rule");
  check("breakpoint strictly between observed widths, midpoint not arbitrary", !!ra && ra.between.join(",") === "390,768" && ra.band === Math.floor((390 + 768) / 2) && ra.band > 390 && ra.band < 768, JSON.stringify(ra?.between));
  // hidden at tablet + mobile → breakpoint between 768 and 1440
  const b = inferResponsiveRules([
    setOf("mobile", 390, [side("none")]),
    setOf("tablet", 768, [side("none")]),
    setOf("desktop", 1440, [side("block")]),
  ]);
  const rb = b.rules.find((r) => r.kind === "display-flip");
  check("tablet+mobile flip → band floor((768+1440)/2)=1104", !!rb && rb.band === 1104 && rb.between.join(",") === "768,1440", rb ? `band ${rb.band} between ${rb.between}` : "no rule");
  check("breakpointBetween never brackets without a wider base observation", breakpointBetween([1440], [1440]) === null, "change at every observed width → null");
  const cssA = responsiveCss(b);
  check("media query keyed by derived breakpoint", cssA.includes("@media (max-width: 1104px)") && cssA.includes("display: none"), "");
}
console.log("\n[2] reorder + collapsed-nav detection (pure inference)");
{
  const domIndex = new Map([
    [keyOf("div", "cards"), { i: 10, root: false }],
    [keyOf("article", "card card-a"), { i: 11, root: false }],
    [keyOf("article", "card card-b"), { i: 12, root: false }],
    [keyOf("article", "card card-c"), { i: 13, root: false }],
    [keyOf("nav", "nav-menu"), { i: 20, root: false }],
    [keyOf("button", "nav-toggle"), { i: 21, root: false }],
  ]);
  const card = (cls, x, parent) => el("article", "card " + cls, "block", { x, y: 40, w: 230, h: 120 }, { parentKey: parent ?? "div.cards" });
  const mkSets = (mobileMenu) => [
    setOf("mobile", 390, [
      el("div", "cards", "flex", { x: 0, y: 0, w: 380, h: 400 }, { parentKey: "main.content" }),
      card("card-b", 0), card("card-a", 250), card("card-c", 500),
      mobileMenu ? el("nav", "nav-menu", "none", { x: 0, y: 0, w: 0, h: 0 }, { parentKey: "header.header-container" })
                 : el("nav", "nav-menu", "flex", { x: 500, y: 14, w: 420, h: 36 }, { parentKey: "header.header-container" }),
      el("button", "nav-toggle", "inline-flex", { x: 300, y: 14, w: 80, h: 36 }, { parentKey: "header.header-container", text: "Menu" }),
    ]),
    setOf("tablet", 768, [
      el("div", "cards", "flex", { x: 0, y: 0, w: 720, h: 400 }, { parentKey: "main.content" }),
      card("card-b", 0), card("card-a", 250), card("card-c", 500),
      mobileMenu ? el("nav", "nav-menu", "none", { x: 0, y: 0, w: 0, h: 0 }, { parentKey: "header.header-container" })
                 : el("nav", "nav-menu", "flex", { x: 500, y: 14, w: 420, h: 36 }, { parentKey: "header.header-container" }),
      el("button", "nav-toggle", "inline-flex", { x: 300, y: 14, w: 80, h: 36 }, { parentKey: "header.header-container", text: "Menu" }),
    ]),
    setOf("desktop", 1440, [
      el("div", "cards", "flex", { x: 0, y: 0, w: 1160, h: 400 }, { parentKey: "main.content" }),
      card("card-a", 0), card("card-b", 250), card("card-c", 500),
      el("nav", "nav-menu", "flex", { x: 500, y: 14, w: 420, h: 36 }, { parentKey: "header.header-container" }),
      el("button", "nav-toggle", "inline-flex", { x: 300, y: 14, w: 80, h: 36 }, { parentKey: "header.header-container", text: "Menu" }),
    ]),
  ];
  const reorder = inferResponsiveRules(mkSets(false), { domIndexByKey: domIndex });
  const orderRules = reorder.rules.filter((r) => r.kind === "reorder");
  check("reorder detected → total order rules at derived band", orderRules.length === 3 && orderRules.every((r) => r.band === 1104), orderRules.map((r) => `${r.key}→${r.props.order}`).join(", "));
  const bRule = orderRules.find((r) => r.key === keyOf("article", "card card-b"));
  const aRule = orderRules.find((r) => r.key === keyOf("article", "card card-a"));
  check("narrow-viewport sequence B,A,C emitted as order props", bRule?.props.order === 0 && aRule?.props.order === 1, `B=${bRule?.props.order} A=${aRule?.props.order}`);
  check("clone selectors resolved via dom index", orderRules.every((r) => /^\.cx-\d+$/.test(r.selector)), orderRules.map((r) => r.selector).join(", "));

  const collapsed = inferResponsiveRules(mkSets(true), { domIndexByKey: domIndex });
  check("collapsed nav detected with trigger + menu", !!collapsed.mobileNav && collapsed.mobileNav.menu.key === keyOf("nav", "nav-menu") && collapsed.mobileNav.trigger.key === keyOf("button", "nav-toggle"), JSON.stringify(collapsed.mobileNav?.menu ?? null));
  check("runtime sidebar wiring assigned when source has no sidebar-* testid", collapsed.mobileNav?.wiredByRuntime === false && collapsed.mobileNav.trigger.testidAssigned === "sidebar-nav-toggle", "");
  const menuRule = collapsed.rules.find((r) => r.key === keyOf("nav", "nav-menu") && r.kind === "display-flip");
  check("runtime-wired menu rule excluded from responsive.css (bootstrap + runtime toggle own it)", menuRule?.runtimeWired === true && !responsiveCss(collapsed).includes(".cx-20"), "");
  const cssOnly = inferResponsiveRules(mkSets(true).map((s) => ({ ...s, elements: s.elements.filter((e) => e.cls !== "nav-toggle") })), { domIndexByKey: domIndex });
  check("no trigger captured → CSS-only collapse, no mobileNav wiring", cssOnly.mobileNav === null && cssOnly.rules.some((r) => r.kind === "display-flip" && r.key === keyOf("nav", "nav-menu")), cssOnly.notes.join("; "));
}

// ---------- fixture server + exploration ----------
console.log("\n[3] exploration of the responsive fixture");
const site = await startFixtureServer(responsivePageSite);
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url: site.base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 1, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 150000 } } },
});
check("exploration completed", manifest.status === "completed", manifest.status);
check("one page explored (maxRoutes=1)", manifest.coverage.routesExplored === 1, String(manifest.coverage.routesExplored));

// NOTE (ask step 1/4): the pipeline writes responsive.json for the FIRST page
// only (exploration-pipeline.js:172) and for viewports.slice(1) only (tablet +
// mobile, exploration-pipeline.js:173). Desktop evidence comes from dom.json.
let responsive = null;
try { responsive = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "responsive.json"), "utf8")); } catch {}
check("responsive.json written for page-001", !!responsive && Array.isArray(responsive.captures), responsive ? `${responsive.captures.length} capture(s)` : "missing");
check("responsive.json carries the non-primary viewports (768 + 390)", !!responsive && responsive.captures.map((c) => c.width).join(",") === "768,390", responsive ? responsive.captures.map((c) => c.width).join(",") : "—");
const tabCap = responsive?.captures?.find((c) => c.width === 768);
const sideCont = tabCap?.geometry?.containers?.find((c) => /sidebar/.test(c.cls || ""));
check("responsive.json carries sidebar hidden-at-tablet evidence", !!sideCont && sideCont.display === "none", sideCont ? `cls="${sideCont.cls}" display=${sideCont.display}` : "sidebar container not captured");
check("responsive.json is page-001-only (documented limitation)", !fs.existsSync(path.join(artifactsDir, "pages", "page-002", "responsive.json")), "no page-002 responsive.json");

// ---------- pipeline-evidence path: dom.json (desktop) + responsive.json ----------
console.log("\n[4] inference from the pipeline's responsive.json");
const domIndex = buildDomIndex(artifactsDir, "page-001");
const { sets: pipeSets, source } = loadResponsiveEvidence(artifactsDir, "page-001");
check("pipeline evidence = primary(dom.json) + 2 responsive captures", pipeSets.length === 3 && pipeSets.map((s) => s.width).sort((a, b) => a - b).join(",") === "390,768,1440", pipeSets.map((s) => s.width).join(","));
const pipeAnalysis = inferResponsiveRules(pipeSets, { domIndexByKey: domIndex });
const pipeSide = pipeAnalysis.rules.find((r) => r.kind === "display-flip" && /sidebar/.test(r.key));
check("sidebar display-flip inferred from responsive.json", !!pipeSide && pipeSide.band === 1104, pipeSide ? `band ${pipeSide.band}` : `rules: ${pipeAnalysis.rules.map((r) => r.kind + ":" + r.key).join("; ") || "none"}`);
check("pipeline breakpoint between 768 and 1440 (never arbitrary)", pipeAnalysis.breakpoints.length === 1 && pipeAnalysis.breakpoints[0].between.join(",") === "768,1440", JSON.stringify(pipeAnalysis.breakpoints));
check("sidebar mapped to a captured clone element", !!pipeSide && /^(body > )?\.cx-\d+$/.test(pipeSide.selector || ""), pipeSide?.selector || "no selector");
check("hidden-sidebars metadata with runtime wiring note", pipeAnalysis.sidebars.length === 1 && /runtimeTemplate/.test(pipeAnalysis.sidebars[0].runtimeWiring), "");
check("pipeline path yields exactly the sidebar rule (fluid containers skipped)", pipeAnalysis.rules.length === 1, pipeAnalysis.rules.map((r) => r.kind + ":" + r.key).join("; "));
check("responsive.css text carries the derived media query", responsiveCss(pipeAnalysis).includes("@media (max-width: 1104px)"), "");

// ---------- rich per-viewport capture on the original fixture ----------
console.log("\n[5] full inference from multi-viewport capture (reorder, collapse, widths)");
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const probePage = await browser.newPage();
await probePage.goto(site.base + "/", { waitUntil: "domcontentloaded" });
await probePage.waitForTimeout(300);
const richSets = await capturePerViewportEvidence(probePage, VIEWPORTS);
check("rich capture at all three policy viewports", richSets.length === 3 && richSets.map((s) => s.width).join(",") === "1440,768,390", richSets.map((s) => s.width + ":" + s.elements.length + "el").join(", "));
const analysis = inferResponsiveRules(richSets, { domIndexByKey: domIndex });
const side = analysis.rules.find((r) => r.kind === "display-flip" && /sidebar/.test(r.key));
check("sidebar hidden rule (band 1104, between 768 and 1440)", !!side && side.band === 1104 && side.between.join(",") === "768,1440", side ? `${side.selector} @${side.band}` : "no rule");
const orderRules = analysis.rules.filter((r) => r.kind === "reorder");
const cardB = orderRules.find((r) => /card-b/.test(r.key));
const cardA = orderRules.find((r) => /card-a/.test(r.key));
check("card reorder inferred (B before A at narrow widths)", orderRules.length === 3 && cardB?.props.order === 0 && cardA?.props.order === 1, orderRules.map((r) => `${r.key}→order ${r.props.order}`).join(", "));
check("collapsed nav wired (trigger + menu resolved to clone elements)", !!analysis.mobileNav && /^\.cx-\d+$/.test(analysis.mobileNav.trigger.selector || "") && /^\.cx-\d+$/.test(analysis.mobileNav.menu.selector || ""), analysis.mobileNav ? `${analysis.mobileNav.trigger.selector} → ${analysis.mobileNav.menu.selector}` : "no mobileNav");
const widthRules = analysis.rules.filter((r) => r.kind === "width" && /brand/.test(r.key));
check("brand width step rules in both derived bands", widthRules.length === 2 && widthRules.map((r) => r.band).sort((a, b) => b - a).join(",") === "1104,579", widthRules.map((r) => `@${r.band} ${r.props.width}`).join(", "));
check("breakpoints are exactly the midpoints between observed widths", JSON.stringify(analysis.breakpoints) === JSON.stringify([{ maxWidth: 1104, between: [768, 1440] }, { maxWidth: 579, between: [390, 768] }]), JSON.stringify(analysis.breakpoints));
const css = responsiveCss(analysis);
check("responsive.css keyed by derived breakpoints only", css.includes("@media (max-width: 1104px)") && css.includes("@media (max-width: 579px)"), "");
const menuSel = analysis.mobileNav?.menu?.selector;
check("runtime-wired menu rule NOT emitted as CSS (bootstrap owns it)", !!menuSel && !css.split("\n").some((l) => l.trim().startsWith(menuSel + " { display: none")), `menu ${menuSel} absent from responsive.css`);
await probePage.close();

// ---------- reconstruction + augmentation ----------
console.log("\n[6] reconstruct + augment the generated project");
const outDir = path.join(ROOT, "artifacts", jobId + "-project");
const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
check("reconstruction ok", rec.ok === true, "rounds: " + rec.report.rounds.length);
const genFiles = (rec.report.validation || []).map((v) => v.file).filter(Boolean);
const aug = augmentProjectWithResponsive(outDir, analysis, { pages: genFiles });
check("responsive.css written into the project", aug.applied && fs.existsSync(path.join(outDir, "styles", "responsive.css")), aug.cssFile || "missing");
const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
const linkPos = indexHtml.indexOf('href="styles/responsive.css"');
const compPos = indexHtml.indexOf('href="styles/components.css"');
check("responsive.css linked after components.css (cascade wins)", linkPos > compPos && compPos > 0, `components@${compPos} responsive@${linkPos}`);
check("hamburger mapped to the runtime's sidebar toggle (data-testid)", aug.wired && indexHtml.includes('data-testid="sidebar-nav-toggle"'), aug.wiredTrigger || "not wired");
check("collapsible menu carries the runtime's app-sidebar hook class", new RegExp('class="cx-\\d+ nav-menu app-sidebar"').test(indexHtml), "");
const bootstrapPath = path.join(outDir, "runtime", "responsive.js");
check("runtime/responsive.js bootstrap emitted with the derived band", fs.existsSync(bootstrapPath) && /"bp":1104/.test(fs.readFileSync(bootstrapPath, "utf8")), "");
check("wired trigger carries no overlay-replay attrs", !/data-(cloner-trigger|replay-id)="[^"]*"[^>]*class="[^"]*nav-toggle/.test(indexHtml) && !/class="[^"]*nav-toggle[^"]*"[^>]*data-(cloner-trigger|replay-id)/.test(indexHtml), "");
const runtimeSrc = fs.readFileSync(path.join(outDir, "runtime", "interactions.js"), "utf8");
let recCount = -1;
try { recCount = JSON.parse(runtimeSrc.match(/^window\.__CLONER_INTERACTIONS = (.*);$/m)[1]).length; } catch {}
check("wired trigger's replay records stripped (no findRec hijack)", recCount === 0, `${recCount} record(s) left`);

// ---------- behavior: clone vs original at 1440 / 768 / 390 ----------
console.log("\n[7] Playwright behavior — clone vs original at 1440/768/390");
const cloneSrv = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
  const fp = path.join(outDir, rel);
  if (!fp.startsWith(outDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end("nf"); return; }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" });
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => cloneSrv.listen(0, "127.0.0.1", r));
const cloneBase = "http://127.0.0.1:" + cloneSrv.address().port;

const measure = async (page, url, vp) => {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const disp = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).display : null; };
    const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; };
    const cards = [...document.querySelectorAll(".cards > *")].map((n) => {
      const r = n.getBoundingClientRect();
      const h = n.querySelector("h1,h2,h3,h4");
      return { t: ((h ? h.textContent : n.textContent) || "").trim().slice(0, 8), x: Math.round(r.x), y: Math.round(r.y) };
    }).sort((a, b) => (a.y - b.y) || (a.x - b.x)).map((c) => c.t);
    return { sidebar: disp(".sidebar"), menu: disp(".nav-menu"), toggle: disp(".nav-toggle"), brandW: rect(".brand-mark")?.w ?? null, cardOrder: cards };
  });
};
const toggleMenu = async (page) => {
  await page.click(".nav-toggle");
  await page.waitForTimeout(200);
  return page.evaluate(() => getComputedStyle(document.querySelector(".nav-menu")).display);
};

const ctx = await browser.newContext();
const origPage = await ctx.newPage();
const clonePage = await ctx.newPage();
const results = {};
for (const vp of VIEWPORTS) {
  const original = await measure(origPage, site.base + "/", vp);
  const clone = await measure(clonePage, cloneBase + "/", vp);
  results[vp.name] = { original, clone };
  const same = (k) => JSON.stringify(clone[k]) === JSON.stringify(original[k]);
  if (vp.name === "desktop") {
    check("desktop: sidebar visible in both", clone.sidebar !== "none" && original.sidebar !== "none", `clone=${clone.sidebar} original=${original.sidebar}`);
    check("desktop: nav menu visible in both", clone.menu !== "none" && original.menu !== "none", `clone=${clone.menu} original=${original.menu}`);
    check("desktop: card order matches original (A,B,C)", same("cardOrder") && clone.cardOrder.join(",") === "Card A,Card B,Card C", clone.cardOrder.join(","));
    check("desktop: brand width unchanged", Math.abs((clone.brandW || 0) - (original.brandW || 0)) <= 6, `clone=${clone.brandW}px original=${original.brandW}px`);
  } else if (vp.name === "tablet") {
    check("tablet: sidebar hidden — per the original", original.sidebar === "none" && clone.sidebar === "none", `clone=${clone.sidebar} original=${original.sidebar}`);
    check("tablet: card order matches original (B,A,C)", same("cardOrder") && clone.cardOrder.join(",") === "Card B,Card A,Card C", clone.cardOrder.join(","));
    check("tablet: nav collapsed — per the original", original.menu === "none" && clone.menu === "none", `clone=${clone.menu} original=${original.menu}`);
    check("tablet: brand width matches original", Math.abs((clone.brandW || 0) - (original.brandW || 0)) <= 6, `clone=${clone.brandW}px original=${original.brandW}px`);
  } else {
    check("mobile: sidebar hidden in both", clone.sidebar === "none" && original.sidebar === "none", `clone=${clone.sidebar} original=${original.sidebar}`);
    check("mobile: card order matches original", same("cardOrder"), `clone=${clone.cardOrder.join(",")} original=${original.cardOrder.join(",")}`);
    check("mobile: nav collapsed before the toggle", clone.menu === "none" && original.menu === "none", `clone=${clone.menu} original=${original.menu}`);
    const origOpen = await toggleMenu(origPage);
    const cloneOpen = await toggleMenu(clonePage);
    check("mobile: hamburger reveals the nav in both (runtime sidebar wiring)", origOpen !== "none" && cloneOpen !== "none", `clone=${cloneOpen} original=${origOpen}`);
    const origClosed = await toggleMenu(origPage);
    const cloneClosed = await toggleMenu(clonePage);
    check("mobile: second toggle re-collapses the nav in both", origClosed === "none" && cloneClosed === "none", `clone=${cloneClosed} original=${origClosed}`);
  }
}
check("desktop layout unchanged by the responsive layer", ["sidebar", "menu", "cardOrder"].every((k) => JSON.stringify(results.desktop.clone[k]) === JSON.stringify(results.desktop.original[k])), "");

// ---------- cleanup + summary ----------
await ctx.close();
await browser.close();
await new Promise((r) => cloneSrv.close(r));
await site.close();
console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(ROOT, "artifacts", "test-responsive-reconstruction-result.json"), JSON.stringify({
  pass, fail, jobId,
  breakpoints: analysis.breakpoints,
  mobileNav: analysis.mobileNav ? { trigger: analysis.mobileNav.trigger.selector, menu: analysis.mobileNav.menu.selector, band: analysis.mobileNav.band, wiredByRuntime: analysis.mobileNav.wiredByRuntime } : null,
  behavior: results,
}, null, 2));
process.exit(fail ? 1 : 0);
