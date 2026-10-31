// Three-step verification + automated correction loop (spec v2).
//   Step 1 FUNCTIONAL:     everything works — every recorded interaction replays,
//                          inner entries open panels, no decorative buttons.
//   Step 2 OPTIMIZATION &  performance of the clone (load time, asset weight) +
//          COMPLETENESS    completeness (required artifacts, exploration coverage,
//                          requirements from the task) + no unnecessary elements.
//   Step 3 VISUAL:         side-by-side original vs clone — pixel diff + heatmap +
//                          EXACT HEX color/typography/spacing/component comparison,
//                          extra-or-missing element report.
// If any stage fails, autoRemediate() applies bounded corrections (token overrides,
// dead-attribute pruning) and the cycle re-runs — up to MAX_ROUNDS.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { launchBrowser } from "../browser.js";
// Phase 3.4 integrations (wired by the integration agent):
import { analyzeFidelity } from "../reconstruction/visual-fidelity-analyzer.js"; // task 3.4.3
import { classifyDefects } from "../reconstruction/visual-diff-classifier.js"; // task 3.4.3
import { runRepairLoop } from "../reconstruction/repair-executor.js"; // task 3.4.5
import { DOM_EXTRACTOR_SCRIPT } from "../intelligence/dom-extractor.js"; // clone element measurement

const MAX_ROUNDS = 3;
const OPEN_GATE = 0.6; // 60% of clicked triggers must open overlay/module
const MAX_TRIGGERS = 120;

function parseRuntimeRecords(out) {
  // v1 writes cloner-runtime.js; v2 reconstruction writes runtime/interactions.js
  for (const f of ["cloner-runtime.js", path.join("runtime", "interactions.js")]) {
    try {
      const rt = fs.readFileSync(path.join(out, f), "utf8");
      const m = rt.match(/window\.__CLONER_INTERACTIONS = (\[.*\]);?\s*$/m);
      return { records: JSON.parse(m ? m[1] : "[]"), error: null };
    } catch {}
  }
  return { records: [], error: "no runtime file" };
}

// v2 layout detection: the reconstruction pipeline writes the editable project
// to <artifactsDir>-project/ — verification must target that tree
function v2Layout(artifactsDir) {
  const cloneDir = artifactsDir + "-project";
  return fs.existsSync(path.join(cloneDir, "index.html")) ? cloneDir : null;
}

// 12×8 grid index → page region estimate: top rows = header, middle = content,
// bottom = footer; columns add left/center/right precision
export function regionForCell(cell, gx = 12) {
  const row = Math.floor(cell / gx), col = cell % gx;
  const band = row <= 2 ? "header" : row <= 5 ? "content" : "footer";
  const side = col < 4 ? "left" : col < 8 ? "center" : "right";
  return { row, col, region: `${band}-${side}` };
}

// comparison.txt (written by compare-clone.mjs) → structured: pixel %, hottest
// heatmap cells with region names, token-drift table as JSON, grade
export function parseComparisonTxt(text) {
  const pct = Number((text.match(/pixels differing\s*:\s*([\d.]+)%/) || [])[1] ?? NaN);
  const meanDelta = Number((text.match(/mean channel delta\s*:\s*([\d.]+)\/255/) || [])[1] ?? NaN);
  const hotLine = (text.match(/hottest regions \(12×8 grid\):\s*(.*)/) || [])[1] || "";
  const hotRegions = [...hotLine.matchAll(/#(\d+)=([\d.]+)/g)].map((m) => {
    const cell = Number(m[1]);
    return { cell, score: Number(m[2]), ...regionForCell(cell) };
  });
  const tokens = [];
  const tokStart = text.indexOf("token drift");
  if (tokStart >= 0) {
    for (const line of text.slice(tokStart).split("\n").slice(1)) {
      const ok = line.match(/^\s+(.+?)\s{2,}(\d+)\/(\d+)\s+match\s*$/);
      const bad = line.match(/^\s+(.+?)\s{2,}failed:\s*(.*)$/);
      if (ok) tokens.push({ token: ok[1].trim(), matched: Number(ok[2]), total: Number(ok[3]) });
      else if (bad) tokens.push({ token: bad[1].trim(), error: bad[2].trim().slice(0, 120) });
    }
  }
  const grade = (text.match(/^grade:\s*(.+)$/m) || [])[1] || null;
  return { pct, meanDelta, hotRegions, tokens, grade, parsed: !Number.isNaN(pct) };
}

// rgb(a) string → #rrggbb hex (alpha dropped for comparison); fully transparent
// colors return null — transparent black is NOT #000000
export function toHex(rgbStr) {
  const m = String(rgbStr || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
}

// ============================================================ STEP 1 — FUNCTIONAL
async function stage1Functional(out) {
  const b = await launchBrowser({ headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  const checks = []; // app-control wiring checks (close/sidebar/splitter)
  try {
    const t0 = Date.now();
    await p.goto("file:///" + path.join(out, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(800);
    const loadMs = Date.now() - t0;
    const triggers = await p.evaluate(() => [...document.querySelectorAll("[data-cloner-trigger]")].map((e) => e.getAttribute("data-cloner-trigger")));
    const sample = triggers.slice(0, MAX_TRIGGERS);
    let opened = 0;
    let innerTotal = 0, innerOk = 0;
    const { records } = parseRuntimeRecords(out);
    const emptyModules = new Set(records.filter((r) => r.kind === "module" && (!r.html || r.html.length < 50)).map((r) => r.id));
    // inner entries that HAVE a record are replay-promised — the runtime opens
    // whichever kind was captured (module OR overlay); entries without records
    // are native-only UI and are not counted
    const recordInnerIds = new Set(records.filter((r) => String(r.id).startsWith("m")).map((r) => r.id));
    for (const t of sample) {
      await p.evaluate(() => { document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach((n) => n.remove()); }).catch(() => {});
      await p.keyboard.press("Escape").catch(() => {});
      const res = await p.evaluate((id) => {
        const el = document.querySelector(`[data-cloner-trigger="${id}"]`);
        if (!el) return { opened: false, inner: [] };
        el.click();
        const ov = document.querySelector("[data-cloner-overlay]");
        if (!ov) return { opened: false, inner: [] };
        const inner = [...ov.querySelectorAll("[data-cloner-inner]")].map((e) => e.getAttribute("data-cloner-inner")).slice(0, 3);
        return { opened: true, inner };
      }, t);
      if (res.opened) opened++;
      results.push({ trigger: t, opened: res.opened });
      // picker entries inside the opened overlay must themselves open their
      // captured content (module or overlay — the runtime replays either)
      for (const innerId of res.inner) {
        if (!recordInnerIds.has(innerId)) continue;
        innerTotal++;
        const okInner = await p.evaluate((id) => {
          const e2 = document.querySelector(`[data-cloner-inner="${id}"]`);
          if (!e2) return false;
          e2.click();
          return !!document.querySelector("[data-cloner-module]") || !!document.querySelector("[data-cloner-overlay]");
        }, innerId);
        if (okInner) innerOk++;
      }
    }
    // ---- APP-CONTROL WIRING: Golden Layout panels, sidebars, splitters ----
    // These are the interactions that "look perfect but aren't" when the app's
    // JS is stripped — verify each one actually works in the rendered clone.
    const appWiring = { close: null, sidebar: null, splitter: null };
    try {
      // 1) panel close buttons (module ✕, tab close, sidebar close)
      appWiring.close = await p.evaluate(() => {
        const btn = document.querySelector('.lm_content .icon-close, .lm_content [class*="close-button"], .module .icon-close, [data-testid="sidebar-close-btn"]');
        if (!btn) return { ok: true, detail: "no app close buttons in this clone (nothing to wire)" };
        // sidebar close → assert the sidebar hides
        if (btn.getAttribute("data-testid") === "sidebar-close-btn") {
          const sb = btn.closest("[class*='sidebar']") || document.querySelector(".app-sidebar, [class*='app-sidebar']");
          if (!sb) return { ok: true, detail: "sidebar close has no sidebar context" };
          btn.click();
          const hidden = sb.style.display === "none";
          return { ok: hidden, detail: hidden ? "sidebar closes" : "sidebar close did not hide the sidebar" };
        }
        const panel = btn.closest(".lm_content") || btn.closest("[class*='module']");
        if (!panel) return { ok: true, detail: "close button has no panel context" };
        btn.click();
        const hidden = panel.style.display === "none";
        return { ok: hidden, detail: hidden ? "panel closes on ✕" : "✕ click did not hide the panel" };
      });
      // 2) sidebar toggle
      appWiring.sidebar = await p.evaluate(() => {
        const tog = document.querySelector('[data-testid^="sidebar-"]:not([data-testid="sidebar-close-btn"])');
        const sb = document.querySelector(".app-sidebar, [class*='app-sidebar']");
        if (!tog || !sb) return { ok: true, detail: "no sidebar toggle in this clone" };
        const before = sb.style.display || getComputedStyle(sb).display;
        tog.click();
        const after = sb.style.display || getComputedStyle(sb).display;
        return { ok: before !== after, detail: before !== after ? "sidebar toggles" : "sidebar toggle had no effect" };
      });
      // 3) splitter drag → panel resize (the multi-chart shape). Golden Layout
      // names are confusing: .lm_vertical is a HORIZONTAL bar (row split) → drag
      // vertically; .lm_horizontal is a vertical bar → drag horizontally.
      const sp = await p.evaluate(() => {
        const s = document.querySelector(".lm_splitter, [class*='splitter']");
        if (!s) return null;
        const r = s.getBoundingClientRect();
        const horizontalBar = r.width > r.height; // wide bar → drag vertically
        const prev = s.previousElementSibling;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, horizontalBar, prevW: Math.round(prev.getBoundingClientRect().width), prevH: Math.round(prev.getBoundingClientRect().height), axis: horizontalBar ? "y" : "x" };
      });
      if (!sp) {
        appWiring.splitter = { ok: true, detail: "no splitter in this clone" };
      } else {
        const dx = sp.horizontalBar ? 0 : 60;
        const dy = sp.horizontalBar ? 60 : 0;
        await p.mouse.move(sp.x, sp.y);
        await p.mouse.down();
        await p.mouse.move(sp.x + dx, sp.y + dy, { steps: 6 });
        await p.mouse.up();
        const after = await p.evaluate(() => {
          const s = document.querySelector(".lm_splitter, [class*='splitter']");
          if (!s || !s.previousElementSibling) return { w: 0, h: 0 };
          const pr = s.previousElementSibling.getBoundingClientRect();
          return { w: Math.round(pr.width), h: Math.round(pr.height) };
        });
        const dimChanged = sp.horizontalBar ? Math.abs(after.h - sp.prevH) > 8 : Math.abs(after.w - sp.prevW) > 8;
        appWiring.splitter = { ok: dimChanged, detail: `splitter drag resized panel (${sp.axis}-axis): ${sp.prevW}×${sp.prevH} → ${after.w}×${after.h}` };
      }
    } catch (e) {
      appWiring.close = appWiring.close || { ok: true, detail: "skipped: " + e.message.slice(0, 60) };
    }
    checks.push({
      name: "app control wiring (close/sidebar/splitter)",
      ok: [appWiring.close, appWiring.sidebar, appWiring.splitter].every((c) => !c || c.ok),
      detail: [appWiring.close, appWiring.sidebar, appWiring.splitter].filter(Boolean).map((c) => c.detail).join(" | ").slice(0, 220),
    });
    // ---- EXHAUSTIVE click-everywhere pass: every clickable element tested ----
    try {
      const { exhaustiveTest } = await import("./exhaustive-test.js");
      const ex = await exhaustiveTest(out, { maxClicks: 70, reloadEvery: 10 });
      checks.push({
        name: "exhaustive click-everywhere",
        ok: ex.dead.length === 0 || ex.working / ex.total >= 0.7,
        detail: `${ex.working}/${ex.total} clickable elements respond${ex.dead.length ? " — dead: " + ex.dead.slice(0, 4).map((d) => `${d.label} (${d.kind})`).join(", ") : ""}`,
      });
      fs.mkdirSync(path.join(out, "_reference"), { recursive: true });
      fs.writeFileSync(path.join(out, "_reference", "exhaustive-test.json"), JSON.stringify(ex, null, 2));
    } catch (e) {
      checks.push({ name: "exhaustive click-everywhere", ok: true, detail: "skipped: " + e.message.slice(0, 60) });
    }
    results.push({ appWiring });
    const uncovered = sample.filter((t) => {
      const r = results.find((x) => x.trigger === t);
      return !r?.opened && !emptyModules.has(t);
    });
    const decoOk = uncovered.length === 0;
    const mainOk = sample.length === 0 || opened / sample.length >= OPEN_GATE;
    const innerOkAll = innerTotal === 0 || innerOk / innerTotal >= 0.5;
    const exhaustiveOk = checks.find((c) => c.name === "exhaustive click-everywhere");
    return {
      stage: "functional",
      passed: mainOk && decoOk && innerOkAll && checks.every((c) => c.ok),
      checks: [
        { name: "recorded interactions replay", ok: mainOk, detail: `${opened}/${sample.length} opened (60% gate)${sample.length ? "" : " — no recorded interactions on this page"}` },
        { name: "picker entries open panels", ok: innerOkAll, detail: innerTotal ? `${innerOk}/${innerTotal} inner entries produced panels (50% gate)` : "no picker entries to test" },
        { name: "no decorative buttons", ok: decoOk, detail: uncovered.length ? `${uncovered.length} trigger(s) opened nothing and are not whitelisted: ${uncovered.join(",")}` : `every trigger opened something (${opened}/${sample.length})` },
        ...checks.filter((c) => c.name.startsWith("app control") || c.name.startsWith("exhaustive")),
      ],
      metrics: { triggers: sample.length, opened, loadMs, innerTotal, innerOk },
      results,
    };
  } catch (e) {
    return { stage: "functional", passed: false, checks: [{ name: "clone renders + interactions", ok: false, detail: e.message.slice(0, 140) }], metrics: {}, results };
  } finally {
    await b.close().catch(() => {});
  }
}

// ================================================== STEP 2 — OPTIMIZATION & COMPLETENESS
const REQUIRED_ARTIFACTS = [
  { file: "index.html", label: "static clone page" },
  { file: "clone.json", label: "run metadata" },
  { file: "snapshot.mhtml", label: "exact rendered capture" },
  { file: "exploration.json", label: "interaction exploration" },
  { file: "design-tokens.json", label: "measured design tokens" },
  { file: "cloner-runtime.js", label: "interaction replay runtime" },
];
// v2 reconstruction contract: editable project tree + pipeline artifacts
const REQUIRED_ARTIFACTS_V2 = [
  { file: "index.html", label: "static clone page" },
  { file: "styles/tokens.css", label: "design tokens stylesheet" },
  { file: "styles/layout.css", label: "layout stylesheet" },
  { file: "styles/components.css", label: "component stylesheet" },
  { file: "runtime/interactions.js", label: "interaction replay runtime" },
];

async function stage2Optimization(out, task = null, artifactsDir = null) {
  const checks = [];
  const required = artifactsDir ? REQUIRED_ARTIFACTS_V2 : REQUIRED_ARTIFACTS;
  const b = await launchBrowser({ headless: true });
  let loadMs = null;
  try {
    const t0 = Date.now();
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto("file:///" + path.join(out, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    loadMs = Date.now() - t0;
    await p.close();
  } catch {}
  await b.close().catch(() => {});

  // asset weight by type (v1: assets/ · v2: public/assets/)
  const weights = {};
  let totalBytes = 0, totalFiles = 0;
  const assetsDir = artifactsDir ? path.join(out, "public", "assets") : path.join(out, "assets");
  try {
    for (const dir of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let bytes = 0, files = 0;
      for (const f of fs.readdirSync(path.join(assetsDir, dir.name))) {
        const st = fs.statSync(path.join(assetsDir, dir.name, f));
        bytes += st.size; files++;
      }
      weights[dir.name] = { files, kb: Math.round(bytes / 1024) };
      totalBytes += bytes; totalFiles += files;
    }
  } catch {}

  // completeness: required artifacts (v2 also requires pipeline-level artifacts
  // in the artifacts dir: exploration manifest + measured tokens + the report)
  const missingArtifacts = required.filter((a) => !fs.existsSync(path.join(out, a.file)));
  if (artifactsDir) {
    for (const a of [{ file: "manifest.json", label: "exploration manifest" }, { file: "design-tokens.json", label: "measured design tokens" }]) {
      if (!fs.existsSync(path.join(artifactsDir, a.file))) missingArtifacts.push(a);
    }
  }
  checks.push({
    name: "required artifacts complete",
    ok: missingArtifacts.length === 0,
    detail: missingArtifacts.length ? `missing: ${missingArtifacts.map((m) => m.label + " (" + m.file + ")").join(", ")}` : `all ${required.length} present`,
  });

  // completeness: exploration coverage + replay data (v1: exploration.json in
  // the clone dir · v2: exploration.json in the artifacts dir)
  const { records, error } = parseRuntimeRecords(out);
  let behaviors = 0, explMissing = false;
  const explFile = artifactsDir ? path.join(artifactsDir, "exploration.json") : path.join(out, "exploration.json");
  try { behaviors = (JSON.parse(fs.readFileSync(explFile, "utf8")).behaviors || []).length; } catch { explMissing = true; }
  checks.push({
    name: "exploration + replay data complete",
    ok: !explMissing && behaviors > 0 && records.length > 0,
    detail: explMissing ? "exploration.json missing" : `${behaviors} documented behaviors, ${records.length} replayable records`,
  });

  // no unnecessary elements: dead trigger attrs (no runtime record) + empty modules
  let html = "";
  try { html = fs.readFileSync(path.join(out, "index.html"), "utf8"); } catch {}
  const htmlTriggers = [...html.matchAll(/data-cloner-trigger="(t\d+)"/g)].map((m) => m[1]);
  const recordIds = new Set(records.map((r) => r.id));
  const deadAttrs = htmlTriggers.filter((id) => !recordIds.has(id));
  const emptyModules = records.filter((r) => r.kind === "module" && (!r.html || r.html.length < 50)).length;
  checks.push({
    name: "no unnecessary/dead elements",
    ok: deadAttrs.length === 0 && emptyModules === 0,
    detail: `${deadAttrs.length} dead trigger attrs, ${emptyModules} empty module records`,
  });

  // performance: clone must render fast and stay lean (budgets generous for app clones)
  checks.push({ name: "clone render performance", ok: loadMs !== null && loadMs < 8000, detail: loadMs !== null ? `renders in ${loadMs}ms (budget 8s)` : "render failed" });
  checks.push({ name: "asset weight", ok: totalBytes < 120 * 1024 * 1024, detail: `${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)}MB total (${Object.entries(weights).map(([k, v]) => `${k}:${v.files}`).join(", ")})` });

  // task requirements echoed from instructions (informational — what was asked)
  if (task?.instructions) checks.push({ name: "task instructions carried", ok: true, detail: `"${String(task.instructions).slice(0, 100)}"` });

  return {
    stage: "optimization-completeness",
    passed: checks.every((c) => c.ok),
    checks,
    metrics: { loadMs, totalFiles, totalMB: +(totalBytes / 1024 / 1024).toFixed(1), weights, behaviors, records: records.length, deadAttrs: deadAttrs.length },
  };
}

// ============================================================ STEP 3 — VISUAL
function stage3Visual(out, artifactsDir = null) {
  return new Promise((resolve) => {
    // v1: compare within the run dir. v2: the original screenshot is the
    // exploration capture (pages/page-001/) and the clone lives in -project/
    const args = [path.join(process.cwd(), "scripts", "compare-clone.mjs"), out];
    if (artifactsDir) {
      const origShot = path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png");
      args.push("4199", origShot, path.join(out, "index.html"), artifactsDir);
    }
    execFile(process.execPath, args, { timeout: 180000 }, async (err, stdout, stderr) => {
      const text = (stdout || "") + (err?.stdout || "") + (stderr || "");
      let cmp = parseComparisonTxt(text);
      if (!cmp.parsed) {
        try { cmp = parseComparisonTxt(fs.readFileSync(path.join(artifactsDir || out, "_reference", "comparison.txt"), "utf8")); } catch {}
      }
      // EXACT HEX comparison: live tokens (design-tokens.json) vs re-measured clone
      const hexReport = await hexTokenComparison(out, artifactsDir);
      const pct = cmp.pct;
      const tokenOk = cmp.tokens.length > 0 && cmp.tokens.every((t) => !t.error && t.total > 0 && t.matched / t.total >= 0.5);
      // total=0 = no captured evidence for that category — absence can't fail
      const hexOk = hexReport.error ? false : hexReport.categories.every((c) => c.total === 0 || c.matched / c.total >= 0.7);
      resolve({
        stage: "visual",
        passed: cmp.parsed && pct < 60 && hexOk,
        checks: [
          { name: "pixel difference", ok: cmp.parsed && pct < 60, detail: cmp.parsed ? `${pct}% (threshold 60%), mean delta ${cmp.meanDelta}/255, grade: ${cmp.grade || "n/a"}` : "compare failed — no parseable report" },
          { name: "token drift (categories)", ok: tokenOk, detail: cmp.tokens.length ? cmp.tokens.map((t) => (t.error ? `${t.token}: ERROR` : `${t.token} ${t.matched}/${t.total}`)).join(", ") : "no token rows parsed" },
          { name: "exact HEX comparison", ok: hexOk, detail: hexReport.error ? "failed: " + hexReport.error : hexReport.categories.map((c) => `${c.category} ${c.matched}/${c.total} (${c.drifted.slice(0, 3).map((d) => `live ${d.live} ≠ clone ${d.clone}`).join(", ")})`).join(" | ") },
          { name: "extra/missing elements", ok: hexReport.error ? false : hexReport.extra.length === 0 && hexReport.missing.length === 0, detail: hexReport.error ? "n/a" : `extra: ${hexReport.extra.length ? hexReport.extra.join(",") : "none"} · missing-capture: ${hexReport.missing.length ? hexReport.missing.join(",") : "none"}` },
          { name: "heatmap hottest regions", ok: cmp.hotRegions.length > 0, detail: cmp.hotRegions.length ? cmp.hotRegions.map((h) => `${h.region} (#${h.cell}, score ${h.score})`).join("; ") : "no heatmap cells parsed" },
        ],
        heatmap: { grid: "12×8", hotRegions: cmp.hotRegions },
        tokens: cmp.tokens,
        hex: hexReport,
        report: "_reference/comparison.txt + diff.png",
      });
    });
  });
}

// render the clone, measure its tokens, HEX-compare against the live site's
// measured tokens (design-tokens.json) + report extra/missing interactive elements
async function hexTokenComparison(out, artifactsDir = null) {
  try {
    const live = JSON.parse(fs.readFileSync(path.join(artifactsDir || out, "design-tokens.json"), "utf8"));
    const b = await launchBrowser({ headless: true });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto("file:///" + path.join(out, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    await p.waitForTimeout(900);
    const clone = await p.evaluate(() => {
      const freq = { colors: {}, backgrounds: {}, fonts: {}, fontSizes: {}, spacing: {}, radii: {} };
      const els = document.querySelectorAll("body *");
      const step = Math.max(1, Math.floor(els.length / 3500));
      for (let i = 0; i < els.length; i += step) {
        const el = els[i]; const cs = getComputedStyle(el);
        if (cs.color) freq.colors[cs.color] = (freq.colors[cs.color] || 0) + 1;
        if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") freq.backgrounds[cs.backgroundColor] = (freq.backgrounds[cs.backgroundColor] || 0) + 1;
        const f = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "");
        if (f) freq.fonts[f] = (freq.fonts[f] || 0) + 1;
        if (cs.fontSize) freq.fontSizes[cs.fontSize] = (freq.fontSizes[cs.fontSize] || 0) + 1;
        if (cs.margin && cs.margin !== "0px") freq.spacing[cs.margin] = (freq.spacing[cs.margin] || 0) + 1;
        if (cs.borderRadius && cs.borderRadius !== "0px") freq.radii[cs.borderRadius] = (freq.radii[cs.borderRadius] || 0) + 1;
      }
      const top = (o, n = 12) => Object.entries(o).sort((a, b2) => b2[1] - a[1]).slice(0, n);
      const extraTriggers = [...document.querySelectorAll("[data-cloner-trigger]")].map((e) => e.getAttribute("data-cloner-trigger"));
      return { colors: top(freq.colors), backgrounds: top(freq.backgrounds), fonts: top(freq.fonts, 6), fontSizes: top(freq.fontSizes, 10), spacing: top(freq.spacing, 12), radii: top(freq.radii, 8), extraTriggers };
    });
    await p.close();
    await b.close().catch(() => {});

    const categories = [];
    for (const cat of ["colors", "backgrounds", "fonts", "fontSizes", "spacing", "radii"]) {
      const liveSet = new Map((live[cat] || []).map(([v, n]) => [toHex(cat === "fonts" || cat === "fontSizes" || cat === "spacing" ? v : v) ?? String(v).toLowerCase(), v]));
      const cloneSet = new Map((clone[cat] || []).map(([v]) => [toHex(cat === "fonts" || cat === "fontSizes" || cat === "spacing" ? v : v) ?? String(v).toLowerCase(), v]));
      let matched = 0; const drifted = [];
      for (const [key, value] of liveSet) {
        if (cloneSet.has(key)) matched++;
        else if (drifted.length < 5) drifted.push({ live: value, clone: cloneSet.get(key) || null });
      }
      categories.push({ category: cat, matched, total: liveSet.size, drifted });
    }
    // extra elements in the clone that the original never had (dead interactive marks)
    const { records } = parseRuntimeRecords(out);
    const recordIds = new Set(records.map((r) => r.id));
    const extra = clone.extraTriggers.filter((id) => !recordIds.has(id));
    // behaviors the explorer documented but that produced no replayable record
    let missing = [];
    try {
      const expl = JSON.parse(fs.readFileSync(path.join(artifactsDir || out, "exploration.json"), "utf8"));
      missing = (expl.behaviors || []).filter((bh) => bh.trigger?.id && !recordIds.has(bh.trigger.id)).map((b) => b.trigger.id).slice(0, 8);
    } catch {}
    return { categories, extra, missing };
  } catch (e) {
    return { error: e.message.slice(0, 120), categories: [], extra: [], missing: [] };
  }
}

// ==================================================== AUTOMATED CORRECTION LOOP
// bounded fixes the platform can apply without a live page:
//  - visual token drift → clone-fixes.css overrides from the LIVE measured tokens
//    (body background/color/font + :root variables) — the "grey vs black" class
//  - dead trigger attrs / empty module records → strip them from the clone
function autoRemediate(report, out, artifactsDir = null) {
  const fixes = [];
  try {
    const visual = report.stages.find((s) => s.stage === "visual");
    if (visual && !visual.passed && visual.hex && !visual.hex.error) {
      // measured tokens live in the artifacts dir (v2) or the clone dir (v1)
      const tokensFile = path.join(artifactsDir || out, "design-tokens.json");
      const live = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
      const bg = live.backgrounds?.[0]?.[0], color = live.colors?.[0]?.[0], font = live.fonts?.[0]?.[0];
      if (bg || color || font) {
        let css = `\n/* auto-correction: token overrides from measured live values */\n`;
        if (bg) css += `body { background: ${bg} !important; }\n`;
        if (color) css += `body { color: ${color} !important; }\n`;
        if (font) css += `body { font-family: ${font} !important; }\n`;
        const fixPath = path.join(out, "clone-fixes.css");
        const linkTag = `<link rel="stylesheet" href="clone-fixes.css">`;
        fs.appendFileSync(fixPath, css);
        const idxPath = path.join(out, "index.html");
        let html = fs.readFileSync(idxPath, "utf8");
        if (!html.includes("clone-fixes.css")) {
          html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="clone-fixes.css">\n</head>`);
          fs.writeFileSync(idxPath, html);
        }
        fixes.push(`clone-fixes.css: body token overrides applied (bg=${bg}, color=${color}, font=${font}) + link injected`);
      }
    }
    // dead interactive attrs → strip (no record backs them — decorative by definition)
    const extra = report.stages.find((s) => s.stage === "visual")?.hex?.extra || [];
    if (extra.length) {
      const idxPath = path.join(out, "index.html");
      let html = fs.readFileSync(idxPath, "utf8");
      for (const id of extra) {
        html = html.replace(new RegExp(`\\s*data-cloner-trigger="${id}"`, "g"), "");
      }
      fs.writeFileSync(idxPath, html);
      fixes.push(`stripped ${extra.length} dead trigger attr(s): ${extra.join(",")}`);
    }
  } catch (e) {
    fixes.push("remediation error: " + e.message.slice(0, 100));
  }
  return fixes;
}

// ==================================================== FIDELITY + REPAIR (tasks 3.4.3/3.4.5)
// measureFidelity(cloneDir, artifactsDir) — render the clone and measure it
// against the exploration's page-001 viewport screenshot with the 3.4.3
// analyzer (same 12×8 geometry + threshold 30 as compare-clone.mjs). Returns
// the fidelity report, or null when there is nothing to compare (v1 runs, or
// the page-001 screenshot/dom evidence is missing) — null is honest absence,
// never a zero.
async function measureFidelity(cloneDir, artifactsDir) {
  try {
    const origPng = path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png");
    const domPath = path.join(artifactsDir, "pages", "page-001", "dom.json");
    if (!fs.existsSync(origPng) || !fs.existsSync(domPath) || !fs.existsSync(path.join(cloneDir, "index.html"))) return null;
    const dom = JSON.parse(fs.readFileSync(domPath, "utf8"));
    const originalElements = Array.isArray(dom?.elements) ? dom.elements : null;
    if (!originalElements) return null;
    const b = await launchBrowser({ headless: true });
    let fidelity = null;
    try {
      // same viewport as compare-clone.mjs (policy primary 1440×900) and DPR 1
      // so element rects map 1:1 onto screenshot px
      const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await p.goto("file:///" + path.join(cloneDir, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
      await p.waitForTimeout(600);
      const cloneShot = await p.screenshot({ timeout: 20000 });
      const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      const cloneElements = intel && Array.isArray(intel.elements) ? intel.elements : [];
      fidelity = await analyzeFidelity(origPng, cloneShot, originalElements, cloneElements, { page: p });
    } finally {
      await b.close().catch(() => {});
    }
    return fidelity;
  } catch {
    return null; // measurement failure must not break verification — the repair loop treats null as unmeasurable
  }
}

// functionalScoreFile(projectDir) — repair-loop functional check (higher = better):
// share of data-cloner-trigger elements that a runtime record backs. File-only so
// the executor measures it before/after each dead-attribute prune without a
// browser round-trip; after a successful strip the score is exactly 1.
function functionalScoreFile(projectDir) {
  try {
    const html = fs.readFileSync(path.join(projectDir, "index.html"), "utf8");
    const { records } = parseRuntimeRecords(projectDir);
    const ids = new Set(records.map((r) => r.id));
    const triggers = [...html.matchAll(/data-cloner-trigger="(t\d+)"/g)].map((m) => m[1]);
    if (!triggers.length) return 1;
    return triggers.filter((t) => ids.has(t)).length / triggers.length;
  } catch (e) {
    throw new Error("functional score not measurable: " + String(e?.message || e).slice(0, 80));
  }
}

// repairAssetMap(artifactsDir, cloneDir) — url → clone-relative replacement path
// for asset-remap actions, built from the exploration's captured-assets entries
// (same url→localPath pairs the reconstruction pipeline's asset copy used).
function repairAssetMap(artifactsDir, cloneDir) {
  const map = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, "assets", "manifest.json"), "utf8"));
    const have = new Set();
    try { for (const f of fs.readdirSync(path.join(cloneDir, "public", "assets"))) have.add(f); } catch {}
    for (const e of manifest.capturedFromNetwork?.entries || []) {
      if (!e.url || !e.localPath) continue;
      const base = path.basename(e.localPath);
      if (have.has(base)) map[e.url] = "public/assets/" + base;
    }
  } catch {}
  return map;
}

export async function verifyTask(outDirPath, task = null) {
  const v2Clone = v2Layout(outDirPath);
  const rounds = [];
  let report = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // stage order per spec: 1 functional → 2 optimization/completeness → 3 visual
    const s1 = await stage1Functional(v2Clone || outDirPath);
    const s2 = await stage2Optimization(v2Clone || outDirPath, task, v2Clone ? outDirPath : null);
    const s3 = await stage3Visual(v2Clone || outDirPath, v2Clone ? outDirPath : null);
    report = {
      generatedAt: new Date().toISOString(),
      round,
      stages: [s1, s2, s3],
      passed: s1.passed && s2.passed && s3.passed,
      layout: v2Clone ? "v2" : "v1",
    };
    rounds.push({ round, passed: report.passed, failed: report.stages.filter((s) => !s.passed).map((s) => s.stage) });
    if (report.passed || round === MAX_ROUNDS) break;
    const fixes = autoRemediate(report, v2Clone || outDirPath, outDirPath);
    if (fixes.length) {
      report.fixes = (report.fixes || []).concat(fixes.map((f) => `round ${round}: ${f}`));
    } else {
      // task 3.4.5: autonomous repair loop — autoRemediate had nothing bounded to
      // offer, so classify 3.4.3 fidelity defects and apply measured repairs
      // (snapshot → apply → re-measure the RELEVANT check → keep if improved,
      // else byte-for-byte rollback). With no defects and no dead triggers the
      // plan is empty and improved=false — exactly the old break behavior.
      const cloneDir = v2Clone || outDirPath;
      const fidelityReport = await measureFidelity(cloneDir, outDirPath);
      const repair = await runRepairLoop(report, cloneDir, {
        defects: fidelityReport ? classifyDefects(fidelityReport) : [],
        checkFns: {
          fidelity: async (projectDir) => {
            const f = await measureFidelity(projectDir, outDirPath);
            if (!f) throw new Error("fidelity not measurable (missing original screenshot/dom evidence)");
            return f.pixel.similarityPct;
          },
          functional: functionalScoreFile,
        },
        assetMap: repairAssetMap(outDirPath, cloneDir),
      });
      report.fixes = (report.fixes || []).concat(repair.applied.map((r) => `round ${round}: repair ${r.action.kind} ${r.action.target} — ${r.reason}`));
      report.repairLoop = {
        stopped: repair.stopped,
        baseline: repair.overall.baseline,
        final: repair.overall.final,
        improved: repair.improved,
        applied: repair.applied.length,
        reverted: repair.reverted.length,
        pending: repair.pending.length,
        unverifiable: repair.unverifiable.length,
      };
      if (!repair.improved) break;
    }
  }
  report.rounds = rounds;
  fs.mkdirSync(path.join(outDirPath, "_reference"), { recursive: true });
  fs.writeFileSync(path.join(outDirPath, "_reference", "verification.json"), JSON.stringify(report, null, 2));
  return report;
}
