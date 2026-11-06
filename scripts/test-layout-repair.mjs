#!/usr/bin/env node
// Layout-repair self-test (offline, file:// only, no network, no package changes):
//
//   fixture original page --(real Playwright capture)--> artifacts
//     (pages/page-001/{dom.json, styles.json, geometry.json, screenshot-viewport.png})
//   hand-broken generated clone  (header height 0 + no background, 2200px nav
//     list forcing page-level horizontal overflow, hero section collapsed to 8px)
//   → analyzeLayoutDefects() must FLAG the header-gap, horizontal-clip and
//     collapsed-section classes from measured evidence
//   → planRepairs() must emit executor-compatible fix descriptors, gated and
//     evidence-cited
//   → runRepairLoop() (the existing repair loop) applies them with a re-render
//     score; the executor's keep-if-improved rule is the pass/fail judge
//   → independent re-render: header height > 0 with its background back, no
//     horizontal overflow (scrollWidth and window scrollX), hero height restored
//
// The ORIGINAL artifacts are not hardcoded: the capture step measures the
// fixture page in a real browser exactly like the exploration pipeline does.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { analyzeLayoutDefects } from "../src/reconstruction/analysis/layout-analyzer.js";
import { planRepairs } from "../src/reconstruction/repair-planner.js";
import { runRepairLoop } from "../src/reconstruction/repair-executor.js";
import { launchBrowser } from "../src/browser.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const VIEWPORT = { width: 1440, height: 900 };
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const HERO_H = 480, HEADER_H = 72;

// ---- fixtures ---------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-repair-test-"));
const artifacts = path.join(root, "artifacts");
const clone = path.join(root, "generated-project");
fs.mkdirSync(path.join(artifacts, "pages", "page-001"), { recursive: true });
fs.mkdirSync(path.join(clone, "styles"), { recursive: true });

const origHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Original</title><style>
* { box-sizing: border-box; margin: 0; }
body { font-family: "Segoe UI", Arial, sans-serif; background: #ffffff; color: #111827; }
.site-header { height: ${HEADER_H}px; background: rgb(35, 41, 54); display: flex; align-items: center; justify-content: space-between; padding: 0 32px; }
.logo { width: 140px; height: 36px; background: rgb(249, 115, 22); border-radius: 4px; flex: none; }
.main-nav { display: flex; gap: 16px; }
.main-nav a { display: inline-block; background: rgb(229, 231, 235); color: #111827; font-size: 14px; padding: 8px 16px; border-radius: 4px; text-decoration: none; }
.hero { height: ${HERO_H}px; background: rgb(245, 247, 250); display: flex; flex-direction: column; justify-content: center; padding: 0 64px; }
.features { height: 240px; background: #ffffff; padding: 48px 64px; }
.site-footer { height: 120px; background: rgb(28, 33, 40); color: #f9fafb; display: flex; align-items: center; padding: 0 64px; }
</style></head><body>
<header class="site-header"><div class="logo"></div><nav class="main-nav">${["Markets", "Watchlists", "Charts", "Orders", "Accounts", "Support"].map((t) => `<a href="#">${t}</a>`).join("")}</nav></header>
<section class="hero"><h1>Trade smarter</h1><p>Real-time data and fast execution for active traders.</p></section>
<section class="features"><h2>Everything you need</h2><p>Charts, watchlists and automation in one place.</p></section>
<footer class="site-footer"><p>&copy; 2026 Example Markets</p></footer>
</body></html>`;
const origPath = path.join(root, "original.html");
fs.writeFileSync(origPath, origHtml);

const NAV_LINKS = ["Markets", "Watchlists", "Charts", "Orders", "Accounts", "Support"];
fs.writeFileSync(path.join(clone, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Clone</title>
<link rel="stylesheet" href="styles/tokens.css">
<link rel="stylesheet" href="styles/components.css">
</head><body>
<header class="cx-0 site-header"><div class="cx-1 logo"></div><nav class="cx-2 main-nav">${NAV_LINKS.map((t, i) => `<a class="cx-${3 + i}" href="#">${t}</a>`).join("")}</nav></header>
<section class="cx-9 hero"><h1 class="cx-10">Trade smarter</h1><p class="cx-11">Real-time data and fast execution for active traders.</p></section>
<section class="cx-12 features"><h2 class="cx-13">Everything you need</h2><p class="cx-14">Charts, watchlists and automation in one place.</p></section>
<footer class="cx-15 site-footer"><p class="cx-16">&copy; 2026 Example Markets</p></footer>
</body></html>`);
// deliberate breaks, generator file conventions: header rendered at height 0
// with NO background (empty header band), nav content 2200px wide (page-level
// horizontal overflow → clipped nav), hero section collapsed to 8px.
fs.writeFileSync(path.join(clone, "styles", "tokens.css"),
  'body { margin: 0; background: #ffffff; color: #111827; font-family: "Segoe UI", Arial, sans-serif; }\n');
fs.writeFileSync(path.join(clone, "styles", "components.css"), `* { box-sizing: border-box; }
.cx-0 { display: flex; align-items: center; justify-content: space-between; height: 0; padding: 0 32px; }
.cx-1 { width: 140px; height: 36px; background: rgb(249, 115, 22); border-radius: 4px; flex: none; }
.cx-2 { display: flex; gap: 16px; min-width: 2200px; }
${NAV_LINKS.map((_, i) => `.cx-${3 + i}`).join(", ")} { display: inline-block; background: rgb(229, 231, 235); color: #111827; font-size: 14px; padding: 8px 16px; border-radius: 4px; text-decoration: none; }
.cx-9 { height: 8px; background: rgb(245, 247, 250); display: flex; flex-direction: column; justify-content: center; padding: 0 64px; }
.cx-12 { height: 240px; background: #ffffff; padding: 48px 64px; }
.cx-15 { height: 120px; background: rgb(28, 33, 40); color: #f9fafb; display: flex; align-items: center; padding: 0 64px; }
`);

// ---- capture the original like the exploration pipeline does ----------------
const b = await launchBrowser({ headless: true });
try {
  const page = await b.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.goto(fileUrl(origPath), { waitUntil: "load" });
  await page.waitForTimeout(300);
  const cap = await page.evaluate(() => {
    const els = [...document.querySelectorAll("body *")];
    const idx = new Map(els.map((e, i) => [e, i]));
    const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const elements = els.map((e, i) => ({
      i, tag: e.tagName.toLowerCase(), cls: (e.getAttribute("class") || "").split(/\s+/)[0] || null,
      rect: rectOf(e), parent: e.parentElement && idx.has(e.parentElement) ? idx.get(e.parentElement) : null,
      text: (e.textContent || "").trim().slice(0, 40) || null,
    }));
    const styles = els.map((e, i) => { const cs = getComputedStyle(e); return { i, tag: e.tagName.toLowerCase(), cls: (e.getAttribute("class") || "").split(/\s+/)[0] || null, style: { backgroundColor: cs.backgroundColor, color: cs.color, fontFamily: cs.fontFamily, fontSize: cs.fontSize } }; });
    const containers = elements.filter((e) => ["header", "div", "nav", "section", "footer"].includes(e.tag))
      .map((e) => ({ ...e, layout: { display: getComputedStyle(els[e.i]).display, position: getComputedStyle(els[e.i]).position } }));
    return { elements, styles, containers, bodyStyle: (({ backgroundColor, color, fontFamily, fontSize }) => ({ backgroundColor, color, fontFamily, fontSize }))(getComputedStyle(document.body)) };
  });
  const pageDir = path.join(artifacts, "pages", "page-001");
  fs.writeFileSync(path.join(pageDir, "dom.json"), JSON.stringify({ pageId: "page-001", url: fileUrl(origPath), total: cap.elements.length, sampled: cap.elements.length, elements: cap.elements, repeated: [], fixed: [], sticky: [] }));
  fs.writeFileSync(path.join(pageDir, "styles.json"), JSON.stringify({ pageId: "page-001", typography: [], bodyStyle: cap.bodyStyle, htmlStyle: null, elements: cap.styles }));
  fs.writeFileSync(path.join(pageDir, "geometry.json"), JSON.stringify({ pageId: "page-001", containers: cap.containers, fixed: [], sticky: [], repeated: [] }));
  fs.writeFileSync(path.join(pageDir, "screenshot-viewport.png"), await page.screenshot({ timeout: 20000 }));
  fs.writeFileSync(path.join(artifacts, "manifest.json"), JSON.stringify({ pages: [{ pageId: "page-001", url: fileUrl(origPath) }], generatedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(root, "capture.json"), JSON.stringify({ headerH: cap.elements[0].rect.h, heroH: cap.elements[9].rect.h }));
} finally {
  await b.close().catch(() => {});
}
const captured = JSON.parse(fs.readFileSync(path.join(root, "capture.json"), "utf8"));
check("capture: original header/hero measured at fixture heights", captured.headerH === HEADER_H && captured.heroH === HERO_H, JSON.stringify(captured));

// ---- phase 1: analyzer flags the three defect classes -----------------------
console.log("\n[1] analyzeLayoutDefects (Playwright, file:// only)");
const analysis = await analyzeLayoutDefects(artifacts, clone);
const D = analysis.defects;
const byKind = (k) => D.filter((d) => d.defect === k);
check("analyzer: header-collapsed detected", byKind("layout-header-collapsed").length === 1, JSON.stringify(D.map((d) => d.defect)));
check("analyzer: collapsed header fix carries measured min-height + captured background",
  byKind("layout-header-collapsed")[0]?.suggestedFix.includes(`min-height: ${HEADER_H}px`) && byKind("layout-header-collapsed")[0]?.measured.originalBg === "#232936",
  JSON.stringify(byKind("layout-header-collapsed")[0] || null));
check("analyzer: header-unstyled NOT double-emitted for a collapsed header (one fix per symptom)", byKind("layout-header-unstyled").length === 0, JSON.stringify(byKind("layout-header-unstyled")));
const overflowRoot = byKind("layout-overflow-x").find((d) => d.measured.isScrollRoot === true);
const overflowInner = byKind("layout-overflow-x").find((d) => d.measured.isScrollRoot === false);
check("analyzer: root horizontal overflow detected once, covering the measured scroll roots, original had no overflow",
  !!overflowRoot && overflowRoot.selector === "html, body" && overflowRoot.measured.originalHadNoOverflow === true
  && overflowRoot.measured.overflowPx === overflowRoot.measured.scrollWidth - overflowRoot.measured.clientWidth && overflowRoot.measured.overflowPx > 100,
  JSON.stringify(byKind("layout-overflow-x").map((d) => ({ s: d.selector, m: d.measured }))));
check("analyzer: inner <header>/<nav> overflow also reported (nav-clipping class)", !!overflowInner && overflowInner.selector === ".cx-0" && overflowInner.measured.isScrollRoot === false, JSON.stringify(overflowInner || null));
check("analyzer: collapsed hero section detected with measured heights", byKind("layout-collapsed-section").length === 1 && byKind("layout-collapsed-section")[0].measured.originalH === HERO_H && byKind("layout-collapsed-section")[0].measured.cloneH === 8, JSON.stringify(byKind("layout-collapsed-section")));
check("analyzer: intact sections (features/footer) not flagged", !D.some((d) => d.defect === "layout-collapsed-section" && d.measured.originalH !== HERO_H), JSON.stringify(byKind("layout-collapsed-section")));
check("analyzer: every detection carries non-empty evidence + suggestedFix", D.every((d) => typeof d.evidence === "string" && d.evidence.length > 20 && typeof d.suggestedFix === "string"), JSON.stringify(D.map((d) => [d.defect, d.evidence?.slice(0, 30)])));

// ---- phase 2: planner maps detections to executor-compatible fixes ---------
console.log("\n[2] planRepairs (executor vocabulary + gates)");
const plan = planRepairs(D);
const A = plan.actions;
check("planner: header fix is a css-override with measured min-height + captured background",
  A.some((a) => a.kind === "css-override" && a.target === ".cx-0" && a.payload.props["min-height"] === `${HEADER_H}px` && a.payload.props.background === "#232936"), JSON.stringify(A));
check("planner: overflow fix is overflow-x:hidden on the measured scroll roots",
  A.filter((a) => a.kind === "css-override" && a.payload.props["overflow-x"] === "hidden").length === 1 && A.find((a) => a.payload.props["overflow-x"] === "hidden").target === "html, body", JSON.stringify(A.map((a) => a.target)));
check("planner: section fix is a geometry-fix min-height (never a clipping height)",
  A.some((a) => a.kind === "geometry-fix" && a.target === ".cx-9" && a.payload.props["min-height"] === `${HERO_H}px`), JSON.stringify(A));
check("planner: inner-container overflow skipped (root containment is the bounded repair)",
  plan.skipped.some((s) => s.kind === "layout-overflow-x" && /root scroll containment/.test(s.reason)), JSON.stringify(plan.skipped));
check("planner: every action cites its measured evidence", A.every((a) => typeof a.evidence === "string" && a.evidence.length > 20), JSON.stringify(A.map((a) => a.evidence)));
// planner gates on constructed detections (unit-level, clearly labelled):
const unstyledPlan = planRepairs([{ kind: "layout-header-unstyled", severity: 0.85, confidence: 0.85, selector: ".cx-0", evidence: "unit: header has height but no background", measured: { originalBg: "rgb(35, 41, 54)", cloneBg: "rgba(0, 0, 0, 0)" } }]);
check("planner: header-unstyled maps to a !important token-fix with the captured color",
  unstyledPlan.actions.length === 1 && unstyledPlan.actions[0].kind === "token-fix" && unstyledPlan.actions[0].payload.important === true && unstyledPlan.actions[0].payload.props["background-color"] === "rgb(35, 41, 54)", JSON.stringify(unstyledPlan));
const gateOff = planRepairs([{ kind: "layout-overflow-x", severity: 0.7, confidence: 0.9, selector: "body", measured: { originalHadNoOverflow: false, isScrollRoot: true } }]);
check("planner: overflow-x gate — original scrolled too → no clip fix emitted",
  gateOff.actions.length === 0 && /diverge from the original/.test(gateOff.skipped[0]?.reason || ""), JSON.stringify(gateOff.skipped));

// ---- phase 3: the existing repair loop applies the plan ---------------------
console.log("\n[3] runRepairLoop (snapshot → apply → re-measure → keep/revert)");
// independent re-render score (higher = better): the four things the ask cares
// about, measured on the rendered clone over file://
async function layoutScore(projectDir) {
  const b2 = await launchBrowser({ headless: true });
  try {
    const p = await b2.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await p.goto(fileUrl(path.join(projectDir, "index.html")), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(300);
    return await p.evaluate(({ headerH, heroH }) => {
      let s = 0;
      const hdr = document.querySelector(".cx-0");
      if (hdr && hdr.getBoundingClientRect().height > 0) s++;
      if (hdr && getComputedStyle(hdr).backgroundColor !== "rgba(0, 0, 0, 0)") s++;
      // page-level containment: the viewport scroll area is clean AND the
      // window cannot actually be scrolled sideways (verified Chromium
      // behavior: both roots need overflow-x:hidden for the lock to hold)
      window.scrollTo(500, 0);
      const locked = window.scrollX === 0;
      window.scrollTo(0, 0);
      if (document.documentElement.scrollWidth <= document.documentElement.clientWidth && locked) s++;
      const hero = document.querySelector(".cx-9");
      if (hero && hero.getBoundingClientRect().height >= 0.75 * heroH) s++;
      return s;
    }, { headerH: HEADER_H, heroH: HERO_H });
  } finally { await b2.close().catch(() => {}); }
}
const repair = await runRepairLoop({ generatedAt: new Date().toISOString(), stages: [] }, clone, {
  defects: D, // analyzer detections flow straight into the existing loop's defect input
  checkFns: { fidelity: layoutScore },
  maxRounds: 6,
});
check("repair loop: baseline was broken (score 0/4)", repair.overall.baseline === 0, JSON.stringify(repair.overall));
check("repair loop: plan improved and every planned fix was kept", repair.improved === true && repair.applied.length === 3 && repair.reverted.length === 0, `stopped=${repair.stopped} applied=${repair.applied.length} reverted=${repair.reverted.length}`);
check("repair loop: plan exhausted (no dead-stop mid-plan)", repair.stopped === "exhausted", String(repair.stopped));
check("repair loop: history written to .repair/history.jsonl", fs.existsSync(repair.historyPath), repair.historyPath);
check("repair loop: fixes appended to clone-fixes.css and linked",
  fs.existsSync(path.join(clone, "clone-fixes.css")) && fs.readFileSync(path.join(clone, "index.html"), "utf8").includes("clone-fixes.css"), "");

// ---- phase 4: independent re-render — the defects are GONE ------------------
console.log("\n[4] re-render the repaired clone");
{
  const b3 = await launchBrowser({ headless: true });
  try {
    const p = await b3.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await p.goto(fileUrl(path.join(clone, "index.html")), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(300);
    const m = await p.evaluate(async ({ headerH, heroH }) => {
      const hdr = document.querySelector(".cx-0");
      const hero = document.querySelector(".cx-9");
      window.scrollTo(500, 0);
      const scrollX = window.scrollX;
      window.scrollTo(0, 0);
      return {
        headerH: hdr ? Math.round(hdr.getBoundingClientRect().height) : null,
        headerBg: hdr ? getComputedStyle(hdr).backgroundColor : null,
        heroH: hero ? Math.round(hero.getBoundingClientRect().height) : null,
        bodyScroll: [document.body.scrollWidth, document.body.clientWidth],
        htmlScroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        windowScrollX: scrollX,
      };
    }, { headerH: HEADER_H, heroH: HERO_H });
    check("re-render: header height > 0 (was 0)", m.headerH > 0, JSON.stringify(m));
    check(`re-render: header restored to ~${HEADER_H}px min-height`, m.headerH >= HEADER_H, JSON.stringify(m));
    check("re-render: header background restored (was backgroundless)", m.headerBg !== "rgba(0, 0, 0, 0)", String(m.headerBg));
    check("re-render: no horizontal overflow on the viewport (html scrollWidth <= clientWidth)", m.htmlScroll[0] <= m.htmlScroll[1], JSON.stringify(m));
    check("re-render: window cannot scroll horizontally (scrollX stays 0)", m.windowScrollX === 0, String(m.windowScrollX));
    check(`re-render: collapsed hero restored to >= 75% of ${HERO_H}px`, m.heroH >= 0.75 * HERO_H, String(m.heroH));
    const fixesCss = fs.readFileSync(path.join(clone, "clone-fixes.css"), "utf8");
    check("clone-fixes.css: cites repair ids + measured values, nothing invented",
      /repair R\d+ \(css-override\)/.test(fixesCss) && fixesCss.includes(`min-height: ${HEADER_H}px`) && fixesCss.includes(`min-height: ${HERO_H}px`) && fixesCss.includes("overflow-x: hidden") && fixesCss.includes("#232936"), fixesCss);
  } finally { await b3.close().catch(() => {}); }
}

console.log(`\nlayout-repair self-test: ${pass} PASS, ${fail} FAIL — fixture root ${root}`);
process.exit(fail ? 1 : 0);
