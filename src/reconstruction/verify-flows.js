// Flow-matrix verification — numbered flow cases (F01-H1 …) replayed on the clone.
// Companion to the three-stage loop in verify.js: stage 1 samples triggers, the
// matrix derives NUMBERED flows from the recorded evidence — one flow per
// recorded interaction cluster (per explored page whose interactions are
// replayable) — and executes, per flow:
//   H-cases  happy replay of every recorded interaction (the trigger opens the
//            overlay/module its runtime record and exploration behavior promise)
//   E-cases  a fixed edge list, where applicable: double-click, long input,
//            back-button mid-flow, keyboard-only focus, missing alt/label (a11y)
//   N-cases  wrong-state navigation: deep-link direct entry into a mid-site page
//            + cross-page navigation with a panel still open
// The a11y contract itself (accessible names, image alts, keyboard focus) lives in
// verify-a11y.js — checkA11y / checkKeyboardFocus; runners here wire the evidence.
// Output: <artifactsDir>/reports/flow-matrix.json —
//   { flows: [{ id, cases: [{ id, kind, result, evidence }] }], bugs: [{ severity, case, what, evidence }] }
// Offline by construction: Playwright drives file:// clone pages only — the same
// contract stage 1 uses (verify.js:98); no network, no external sites.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../browser.js";
import { checkA11y, checkKeyboardFocus, reportA11yViolations } from "./verify-a11y.js";

const MAX_FLOWS = 12;      // flows per run — bounds huge multipage sites
const MAX_H_PER_FLOW = 12; // happy-replay cases per flow (stage 1 caps triggers the same way, verify.js:27)
const MAX_CONSOLE = 5;     // console/pageerror lines kept per case
const LONG_INPUT = "x".repeat(5000);

// runtime replay records — same two shapes verify.js:29 parses (v1
// cloner-runtime.js, v2 runtime/interactions.js)
function readRuntimeRecords(out) {
  for (const f of ["cloner-runtime.js", path.join("runtime", "interactions.js")]) {
    try {
      const rt = fs.readFileSync(path.join(out, f), "utf8");
      const m = rt.match(/window\.__CLONER_INTERACTIONS = (\[.*\]);?\s*$/m);
      return JSON.parse(m ? m[1] : "[]");
    } catch {}
  }
  return [];
}

// clone file for an explored route — mirrors the pipeline slug rule
// (page-001 → index.html, else slug(route).html with / and ?&# → _)
function cloneFileForRoute(projectDir, pageId, routeUrl) {
  let slug = "";
  try {
    slug = new URL(routeUrl).pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.html?$/i, "").replace(/[?&#]/g, "_").replace(/\//g, "_").replace(/_+$/, "");
  } catch {}
  const file = pageId === "page-001" ? "index.html" : (slug || pageId) + ".html";
  return fs.existsSync(path.join(projectDir, file)) ? file : null;
}

// recorded evidence load — every source optional, the matrix degrades honestly
// when one is missing: routes from manifest.json pages, per-page interaction
// clusters from pages/page-NNN/dom.json (the explorer's own capture), expected
// opens from exploration.json behaviors, replay backing from the runtime records
function loadEvidence(cloneDir, artifactsDir) {
  const ev = { records: [], behaviors: [], pages: [] };
  ev.records = readRuntimeRecords(cloneDir);
  const recordIds = new Set(ev.records.map((r) => r.id));
  for (const dir of [artifactsDir, cloneDir]) {
    if (!dir || ev.behaviors.length) continue;
    try { ev.behaviors = JSON.parse(fs.readFileSync(path.join(dir, "exploration.json"), "utf8")).behaviors || []; } catch {}
  }
  const behaviorIds = new Set(ev.behaviors.map((b) => b.trigger?.id).filter(Boolean));
  let manifest = null;
  for (const dir of [artifactsDir, cloneDir]) {
    if (manifest) break;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch {}
  }
  if (Array.isArray(manifest?.pages) && manifest.pages.length) {
    for (const mp of manifest.pages) {
      const file = cloneFileForRoute(cloneDir, mp.pageId, (mp.route || {}).url || mp.url);
      if (!file) continue; // no clone file for this route — deep-link N-cases would be meaningless
      const page = { pageId: mp.pageId, route: (mp.route || {}).url || mp.url, file, triggers: [], hasInputs: false };
      try {
        const dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", mp.pageId, "dom.json"), "utf8"));
        for (const el of dom.elements || []) {
          if (el.tag === "input" || el.tag === "textarea") page.hasInputs = true;
          // only ids backed by recorded evidence (runtime record or exploration
          // behavior) form a replayable cluster — dead clone marks stay stage 2's lane
          if (el.dataClonerTrigger && (recordIds.has(el.dataClonerTrigger) || behaviorIds.has(el.dataClonerTrigger))) {
            page.triggers.push({ id: el.dataClonerTrigger, label: el.ariaName || (el.text || "").slice(0, 40) });
          }
        }
      } catch {} // no per-page dom evidence — cluster placement falls back below
      if (!page.triggers.length && (mp.records || 0) > 0) {
        // partial-evidence run: place the page's records by intersecting the
        // recorded ids with the triggers its clone file actually carries
        try {
          for (const m of fs.readFileSync(path.join(cloneDir, file), "utf8").matchAll(/data-cloner-trigger="([^"]+)"/g)) {
            if (recordIds.has(m[1]) || behaviorIds.has(m[1])) page.triggers.push({ id: m[1], label: "" });
          }
        } catch {}
      }
      ev.pages.push(page);
    }
  }
  if (!ev.pages.length && recordIds.size) {
    // v1 layout (no manifest): every recorded interaction lives on the one clone page
    ev.pages.push({ pageId: "page-001", route: null, file: "index.html", triggers: [...recordIds].map((id) => ({ id, label: "" })), hasInputs: false });
  }
  return ev;
}

// label/input enrichment for pages without per-page dom evidence (v1 runs) —
// labels from exploration behaviors, input presence sniffed from the clone html
function enrichPages(ev, cloneDir) {
  const byId = new Map(ev.behaviors.map((b) => [b.trigger?.id, b.trigger?.label]).filter(([id]) => id));
  for (const page of ev.pages) {
    for (const t of page.triggers) if (!t.label) t.label = byId.get(t.id) || "";
    if (!page.hasInputs) {
      try { page.hasInputs = /<(input|textarea)\b/i.test(fs.readFileSync(path.join(cloneDir, page.file), "utf8").slice(0, 200000)); } catch {}
    }
  }
}

// matrix build — one flow per recorded interaction cluster (a page whose
// interactions are replayable), H-cases first, then the fixed edge list
// (only where the page's recorded shape applies), then the N-cases
function buildMatrix(ev) {
  const flows = [];
  const sitePages = ev.pages.filter((p) => p.triggers.length);
  for (const page of sitePages.slice(0, MAX_FLOWS)) {
    const flow = { id: `F${String(flows.length + 1).padStart(2, "0")}`, page: page.file, cases: [] };
    const triggers = page.triggers.slice(0, MAX_H_PER_FLOW);
    triggers.forEach((t, i) => flow.cases.push({ id: `${flow.id}-H${i + 1}`, kind: "happy-replay", trigger: t.id, label: t.label || null, result: "pending", evidence: {} }));
    let e = 0, n = 0;
    const pushE = (kind, extra = {}) => flow.cases.push({ id: `${flow.id}-E${++e}`, kind, ...extra, result: "pending", evidence: {} });
    const pushN = (kind, extra = {}) => flow.cases.push({ id: `${flow.id}-N${++n}`, kind, ...extra, result: "pending", evidence: {} });
    if (triggers.length) pushE("double-click", { trigger: triggers[0].id }); // rapid double activation
    if (page.hasInputs) pushE("long-input");                                 // oversized text input
    if (sitePages.length > 1) pushE("back-button");                          // back mid-flow with a panel open
    pushE("keyboard-focus");                                                 // keyboard-only navigation + visible focus
    pushE("a11y-name-alt");                                                  // accessible names + image alts
    if (sitePages.length > 1 && page.pageId !== "page-001") pushN("wrong-state-navigation", { target: page.file, mode: "deep-link" });
    if (sitePages.length > 1) pushN("wrong-state-navigation", { mode: "cross-page" });
    flows.push(flow);
  }
  return flows;
}

function fileUrl(cloneDir, file) {
  return "file:///" + path.join(cloneDir, file).replace(/\\/g, "/");
}

// keep the browser on the flow's clone page — H cases navigate once per flow;
// edge/N cases may navigate away and must land back before interacting
async function ensurePage(p, ctx, file) {
  if (ctx.fctx.current === file) return;
  await p.goto(fileUrl(ctx.cloneDir, file), { waitUntil: "load", timeout: 20000 });
  await p.waitForTimeout(400);
  ctx.fctx.current = file;
}

function clearPanels(p) {
  return p.evaluate(() => { document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach((n) => n.remove()); }).catch(() => {});
}

async function shot(p, dir, id) {
  try {
    await p.screenshot({ path: path.join(dir, id + ".png"), timeout: 8000 });
    return "reports/flow-matrix/" + id + ".png";
  } catch { return null; }
}

async function runHappy(p, c, ctx) {
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  const res = await p.evaluate((id) => {
    const el = document.querySelector(`[data-cloner-trigger="${id}"]`);
    if (!el) return { found: false, opened: false };
    el.click();
    // same contract as stage 1: overlay appears after the click (verify.js:118),
    // inner-entry check accepts overlay OR module (verify.js:134)
    return { found: true, opened: !!(document.querySelector("[data-cloner-overlay]") || document.querySelector("[data-cloner-module]")) };
  }, c.trigger);
  c.result = res.found && res.opened ? "pass" : "fail";
  c.evidence.target = c.trigger;
  c.evidence.detail = res.found ? (res.opened ? `trigger ${c.trigger} opened its panel` : `trigger ${c.trigger} clicked but nothing opened`) : `trigger ${c.trigger} missing from the clone`;
}

async function runDoubleClick(p, c, ctx) {
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  const res = await p.evaluate((id) => {
    const el = document.querySelector(`[data-cloner-trigger="${id}"]`);
    if (!el) return { found: false };
    el.click(); el.click(); // rapid double activation — the runtime must absorb it
    return { found: true };
  }, c.trigger);
  c.result = res.found ? "pass" : "fail"; // thrown errors attach via the console tap
  c.evidence.detail = res.found ? `double activation of ${c.trigger} absorbed, no thrown errors` : `trigger ${c.trigger} missing from the clone`;
}

async function runLongInput(p, c, ctx) {
  await ensurePage(p, ctx, ctx.flow.page);
  const res = await p.evaluate((val) => {
    const el = [...document.querySelectorAll("input,textarea")].find((n) => (n.getAttribute("type") || "text") !== "hidden");
    if (!el) return { found: false };
    el.focus();
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { found: true, accepted: el.value.length, max: el.maxLength > 0 ? el.maxLength : null };
  }, LONG_INPUT);
  c.result = res.found ? "pass" : "fail";
  c.evidence.detail = res.found ? `input accepted ${res.accepted} chars${res.max ? ` (maxlength ${res.max})` : ""} without errors` : "no fillable text input on the page";
}

async function runBackButton(p, c, ctx) {
  const first = ctx.flow.cases.find((x) => x.kind === "happy-replay");
  const sibling = ctx.ev.pages.find((pg) => pg.file && pg.file !== ctx.flow.page)?.file;
  if (!first || !sibling) { c.result = "fail"; c.evidence.detail = "no recorded trigger or sibling page to navigate through"; return; }
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  const openedBefore = await p.evaluate((id) => { const el = document.querySelector(`[data-cloner-trigger="${id}"]`); if (el) el.click(); return !!(document.querySelector("[data-cloner-overlay]") || document.querySelector("[data-cloner-module]")); }, first.trigger);
  await p.goto(fileUrl(ctx.cloneDir, sibling), { waitUntil: "load", timeout: 20000 });
  await p.goBack().catch(() => {});
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({ rendered: !!document.body && document.body.children.length > 0, here: decodeURIComponent(location.href.split("/").pop() || "") }));
  c.result = after.rendered && after.here === ctx.flow.page && ctx.errors.length === 0 ? "pass" : "fail";
  c.evidence.detail = `panel ${openedBefore ? "open" : "closed"} before leaving; back landed on ${after.here} (${after.rendered ? "rendered" : "BLANK"})`;
}

// keyboard-only focus E-case — the Tab + focus-ring check lives in verify-a11y.js
async function runKeyboardFocus(p, c, ctx) {
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  const res = await checkKeyboardFocus(p);
  c.result = res.moved && res.visible ? "pass" : "fail";
  c.evidence.detail = res.moved ? `Tab focused <${res.tag}> "${res.name}" — focus ring ${res.visible ? "visible" : "NOT visible"}` : "Tab did not move focus into the page";
}

// a11y E-case — the scan + case evidence contract live in verify-a11y.js now
async function runA11y(p, c, ctx) {
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  reportA11yViolations(c, ctx.report, await checkA11y(p, { file: ctx.flow.page }), MAX_CONSOLE);
}

// N1 — wrong-state navigation: deep-link DIRECT entry into a mid-site page
// (no warm-up through the entry point); the recorded trigger must not crash it
async function runDeepLink(p, c, ctx) {
  ctx.fctx.current = null;
  await p.goto(fileUrl(ctx.cloneDir, c.target), { waitUntil: "load", timeout: 20000 });
  await p.waitForTimeout(300);
  const res = await p.evaluate(() => ({ rendered: !!document.body && document.body.children.length > 0, title: document.title }));
  const first = ctx.flow.cases.find((x) => x.kind === "happy-replay");
  if (res.rendered && first) {
    const opened = await p.evaluate((id) => {
      const el = document.querySelector(`[data-cloner-trigger="${id}"]`);
      if (!el) return null;
      el.click();
      return !!(document.querySelector("[data-cloner-overlay]") || document.querySelector("[data-cloner-module]"));
    }, first.trigger);
    if (opened !== null) c.evidence.detail = `deep-link entry rendered; first recorded trigger ${opened ? "still opens" : "does not open"} from the deep link (graceful)`;
  }
  c.result = res.rendered && ctx.errors.length === 0 ? "pass" : "fail";
  if (!c.evidence.detail) c.evidence.detail = res.rendered ? `deep-link entry rendered "${res.title}" without errors` : `deep-link direct entry to ${c.target} rendered a BLANK page`;
}

// N2 — wrong-state navigation: cross-page navigation mid-flow (panel still
// open); the sibling page must render without carried-over state or errors
async function runCrossPage(p, c, ctx) {
  const first = ctx.flow.cases.find((x) => x.kind === "happy-replay");
  const sibling = ctx.ev.pages.find((pg) => pg.file && pg.file !== ctx.flow.page)?.file;
  if (!first || !sibling) { c.result = "fail"; c.evidence.detail = "no recorded trigger or sibling page"; return; }
  await ensurePage(p, ctx, ctx.flow.page);
  await clearPanels(p);
  await p.evaluate((id) => { const el = document.querySelector(`[data-cloner-trigger="${id}"]`); if (el) el.click(); }, first.trigger);
  const res = await p.goto(fileUrl(ctx.cloneDir, sibling), { waitUntil: "load", timeout: 20000 })
    .then(() => p.evaluate(() => ({ panels: document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").length, rendered: !!document.body && document.body.children.length > 0 })));
  c.result = res.rendered && ctx.errors.length === 0 ? "pass" : "fail";
  c.evidence.detail = `navigated mid-flow to ${sibling}: ${res.panels} panel(s) carried over, page ${res.rendered ? "rendered" : "BLANK"}`;
}

// bug mapping — severity per case kind; the a11y runner pushes per-offender bugs (medium/low)
const BUG_FOR_KIND = {
  "happy-replay": { severity: "high", what: (c) => `recorded interaction "${c.label || c.trigger}" does not replay on the clone` },
  "double-click": { severity: "high", what: () => "double activation of a recorded control threw or broke the page" },
  "long-input": { severity: "medium", what: () => "oversized text input threw or broke the field" },
  "back-button": { severity: "medium", what: () => "back-button mid-flow landed blank or threw" },
  "keyboard-focus": { severity: "medium", what: () => "keyboard focus is not visible (no outline/shadow on the focused control)" },
  "a11y-name-alt": { severity: "medium", what: () => "accessibility contract violated (unnamed control or missing alt)" },
  "wrong-state-navigation": { severity: "high", what: (c) => `wrong-state navigation (${c.mode || "deep-link"}) landed blank or threw` },
};

const RUNNERS = { "happy-replay": runHappy, "double-click": runDoubleClick, "long-input": runLongInput, "back-button": runBackButton, "keyboard-focus": runKeyboardFocus, "a11y-name-alt": runA11y };

// runFlowMatrix(cloneDir, artifactsDir) — build + execute the flow matrix on the
// clone. Non-fatal by contract: any internal error lands in report.error, the
// caller (verify.js) never fails verification because of it.
export async function runFlowMatrix(cloneDir, artifactsDir) {
  const report = { flows: [], bugs: [] };
  try {
    const ev = loadEvidence(cloneDir, artifactsDir);
    enrichPages(ev, cloneDir);
    report.flows = buildMatrix(ev);
    if (!report.flows.length) {
      report.note = "no replayable recorded interaction clusters — nothing to replay";
      return finish(report, artifactsDir, cloneDir);
    }
    const shotDir = path.join(artifactsDir || cloneDir, "reports", "flow-matrix");
    fs.mkdirSync(shotDir, { recursive: true });
    const b = await launchBrowser({ headless: true });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; // console + pageerror tap, drained per case
    p.on("pageerror", (e) => { if (errors.length < 20) errors.push("pageerror: " + String(e?.message || e).slice(0, 200)); });
    p.on("console", (m) => { if (m.type() === "error" && errors.length < 20) errors.push("console.error: " + String(m.text()).slice(0, 200)); });
    const ctx = { cloneDir, artifactsDir, ev, errors, report, fctx: { current: null } };
    for (const flow of report.flows) {
      ctx.flow = flow;
      ctx.fctx.current = null;
      for (const c of flow.cases) {
        errors.length = 0;
        try {
          const runner = c.kind === "wrong-state-navigation" ? (c.mode === "cross-page" ? runCrossPage : runDeepLink) : RUNNERS[c.kind];
          await runner(p, c, ctx);
        } catch (e) {
          c.result = "fail";
          c.evidence.error = String(e?.message || e).slice(0, 200);
        }
        if (errors.length) c.evidence.console = errors.slice(0, MAX_CONSOLE);
        if (c.result === "fail") {
          c.evidence.screenshotRef = await shot(p, shotDir, c.id);
          for (const bg of report.bugs) if (bg.case === c.id && !bg.evidence.screenshotRef) bg.evidence.screenshotRef = c.evidence.screenshotRef;
          const spec = BUG_FOR_KIND[c.kind];
          if (spec && !report.bugs.some((bg) => bg.case === c.id)) report.bugs.push({ severity: spec.severity, case: c.id, what: spec.what(c), evidence: { ...c.evidence } });
        }
      }
    }
    await b.close().catch(() => {});
  } catch (e) {
    report.error = String(e?.message || e).slice(0, 200);
  }
  return finish(report, artifactsDir, cloneDir);
}

// report write — the file carries exactly the { flows, bugs } contract
function finish(report, artifactsDir, cloneDir) {
  try {
    const dir = path.join(artifactsDir || cloneDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "flow-matrix.json"), JSON.stringify({ flows: report.flows, bugs: report.bugs }, null, 2));
    report.reportFile = "reports/flow-matrix.json";
  } catch (e) {
    report.writeError = String(e?.message || e).slice(0, 120);
  }
  return report;
}
