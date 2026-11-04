#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
// Multi-site benchmark and repeatable scoring (task 3.5.7).
//
// Runs the SAME engine pipeline (exploration → understanding → reconstruction →
// generated-clone verification → fidelity) over every site declared in
// fixtures/benchmark/sites.json — the three 3.5.1 category fixtures, the 3.4.2
// workspace fixture, the 3.5.3 stateful fixture, the 3.5.4 visual fixture and a
// simple known multi-page site — and scores each site 0-100 with the versioned
// rubric in fixtures/benchmark/rubric.json.
//
// Scoring contract (rubric-first, deterministic):
//   - five weighted dimensions: visualSimilarity, structuralAccuracy,
//     interactionPassRate, stateRestoration, runtimeRobustness;
//   - every dimension score is a weighted mean of component metrics mapped
//     through linear [floor,target] bands declared in the rubric — the bands,
//     weights, floors and tolerance are DATA, never code;
//   - dimensions a site does not declare (e.g. stateRestoration on a static
//     site) are not scored and their weight renormalizes over the applicable
//     set;
//   - site-level rates only: a site with more routes or components cannot
//     dominate the aggregate (aggregate = unweighted mean of site scores);
//   - risk-note enforcement: a site FAILS when any applicable dimension scores
//     below rubric.criticalDimensionFloor even if its weighted total clears the
//     floor — a strong visual score can never compensate for broken
//     interactions;
//   - the run FAILS (exit 1) when any site scores below its complexity floor,
//     when a critical dimension breaches its floor, or when a site regresses
//     beyond rubric.regressionTolerance against fixtures/benchmark/baseline.json
//     (a missing baseline is seeded by a gate-clean run — never by a failing one).
//
// Determinism: all score inputs come from engine outputs (manifest, dom.json,
// understanding models, reconstruction report, asset manifest, analyzeFidelity,
// the live clone's runtime state). The written report contains no timestamps
// and no durations, so re-running the same engine build against the same
// fixtures reproduces output/benchmark-3-5.md byte-for-byte.
//
// Run:      node scripts/test-multisite-benchmark.mjs
// Writes:   output/benchmark-3-5.md + artifacts/benchmark-3-5-result.json
// CI wire:  "test:benchmark": "node scripts/test-multisite-benchmark.mjs"
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts, deriveInteractionRecords } from "../src/reconstruction/reconstruction-pipeline.js";
import { loadArtifacts } from "../src/reconstruction/artifact-loader.js";
import { buildUnderstandingPage, pageArtifactsFromLoaded } from "../src/reconstruction/website-understanding.js";
import { analyzeFidelity } from "../src/reconstruction/visual-fidelity-analyzer.js";
import { DOM_EXTRACTOR_SCRIPT } from "../src/intelligence/dom-extractor.js";
import {
  createApplicationStateSink,
  attachApplicationStateCapture,
  exportApplicationState,
} from "../src/exploration/application-state-capture.js";
import {
  buildAppStatePlan,
  augmentProjectWithAppState,
  primaryDeepLink,
} from "../src/reconstruction/application-state-builder.js";
import { startFixtureServer } from "./fixtures/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const BENCH_DIR = path.join(ROOT, "fixtures", "benchmark");
const manifest = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "manifest.json"), "utf8"));
const sitesFile = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "sites.json"), "utf8"));
const rubric = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "rubric.json"), "utf8"));
const sites = sitesFile.sites;

const VIEWPORT = manifest.capture.viewport;
const BUDGETS = manifest.budgets;
const ARTIFACTS = path.join(ROOT, "artifacts");
const REPORT_PATH = path.join(ROOT, "output", "benchmark-3-5.md");
const RESULT_PATH = path.join(ARTIFACTS, "benchmark-3-5-result.json");
const BASELINE_PATH = path.join(BENCH_DIR, "baseline.json");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ENV = { engineVersion: pkg.version, node: process.version, platform: `${process.platform} ${process.arch}` };

const round2 = (v) => Math.round(v * 100) / 100;
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const pathnameOf = (p) => {
  try { return new URL(p.url).pathname; } catch { return null; }
};

// ---- generic rubric evaluator ----------------------------------------------
// direction=higher: [floor,target] -> [0,100]; direction=lower: the inverse.
function bandScore(value, comp) {
  const { floor, target } = comp;
  if (comp.direction === "lower") {
    if (floor === target) return value <= target ? 100 : 0;
    const t = (floor - value) / (floor - target);
    return Math.max(0, Math.min(1, t)) * 100;
  }
  if (floor === target) return value >= target ? 100 : 0;
  const t = (value - floor) / (target - floor);
  return Math.max(0, Math.min(1, t)) * 100;
}

function scoreSite(site, metrics) {
  const applicable = site.requiredDimensions.filter((d) => rubric.dimensions[d]);
  const dims = {};
  for (const dim of applicable) {
    const spec = rubric.dimensions[dim];
    const comps = spec.components || spec.profiles[site.stateProfile].components;
    const detail = {};
    let total = 0, wsum = 0;
    for (const [cid, comp] of Object.entries(comps)) {
      const value = metrics[dim]?.[cid] ?? 0;
      const s = bandScore(value, comp);
      detail[cid] = { value: round2(value), score: round2(s), band: `${comp.direction} [${comp.floor},${comp.target}]` };
      total += s * comp.weight;
      wsum += comp.weight;
    }
    dims[dim] = { score: round2(wsum ? total / wsum : 0), components: detail };
  }
  const wsum = applicable.reduce((s, d) => s + rubric.dimensions[d].weight, 0);
  const overall = round2(wsum ? applicable.reduce((s, d) => s + dims[d].score * rubric.dimensions[d].weight, 0) / wsum : 0);
  return { overall, dimensions: dims, applicable };
}

// ---- static server for the generated project (export contract) -------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".webp": "image/webp",
};
function startProjectServer(outDir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    const fp = path.join(outDir, rel);
    if (!fp.startsWith(outDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- per-site metric collection --------------------------------------------

// distinct trigger ids across every captured page's dom.json (generic capture
// contract — the same evidence the coverage suite asserts on)
function collectTriggerIds(artifactsDir, pages) {
  const ids = new Set();
  for (const p of pages) {
    try {
      const dom = readJson(path.join(artifactsDir, "pages", p.pageId, "dom.json"));
      for (const e of dom.elements || []) if (e && e.dataClonerTrigger) ids.add(e.dataClonerTrigger);
    } catch { /* missing page evidence counts against pageEvidenceRatio */ }
  }
  return [...ids];
}

function pageEvidence(artifactsDir, pages) {
  if (!pages.length) return { ratio: 0, good: 0, total: 0 };
  let good = 0;
  for (const p of pages) {
    try {
      const dom = readJson(path.join(artifactsDir, "pages", p.pageId, "dom.json"));
      const hasDom = (dom.sampled > 0) && Array.isArray(dom.elements) && dom.elements.length > 0;
      const hasStyles = fs.existsSync(path.join(artifactsDir, "pages", p.pageId, "styles.json"));
      const hasShot = fs.existsSync(path.join(artifactsDir, "pages", p.pageId, "screenshot-viewport.png"));
      if (hasDom && hasStyles && hasShot) good++;
    } catch { /* counts as missing evidence */ }
  }
  return { ratio: good / pages.length, good, total: pages.length };
}

// network-captured images vs what the generated project actually carries
function assetCompleteness(artifactsDir, outDir) {
  let captured = 0, copied = 0;
  try {
    const am = readJson(path.join(artifactsDir, "assets", "manifest.json"));
    const entries = am.capturedFromNetwork?.entries || [];
    const images = entries.filter((e) => /\.(png|jpe?g|gif|svg|webp)$/i.test(e.localPath || "") && e.hash && e.localPath);
    captured = images.length;
    if (captured) {
      const pub = path.join(outDir, "public", "assets");
      const files = fs.existsSync(pub) ? new Set(fs.readdirSync(pub)) : new Set();
      for (const e of images) if (files.has(path.basename(e.localPath))) copied++;
    }
  } catch { /* no asset manifest — captured stays 0 → completeness 1.0 */ }
  return { captured, copied, ratio: captured ? Math.min(1, copied / captured) : 1 };
}

// path hygiene + referenced local assets existing on disk
function runtimeHygiene(outDir, genFiles) {
  let relativeOnly = true;
  let referenced = 0, present = 0;
  for (const f of genFiles) {
    const fp = path.join(outDir, f);
    if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, "utf8");
    if (/(?:src|href)\s*=\s*["'](?:[A-Za-z]:[\\/]|file:)/i.test(html) || html.includes(ROOT + path.sep) || html.includes(ROOT + "/")) {
      relativeOnly = false;
    }
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']/g)].map((m) => m[1])
      .filter((u) => !/^(?:https?:|data:|mailto:|\/\/)/.test(u) && /\.[a-z0-9]{2,5}$/i.test(u.split("?")[0]));
    for (const r of refs) {
      referenced++;
      if (fs.existsSync(path.join(outDir, r))) present++;
    }
  }
  return { relativeOnly, localAssetsPresent: referenced ? present / referenced : 1, referenced, present };
}

// deterministic scripted app-state capture for the stateful fixture — the same
// documented Wave-2 hook the 3.5.3 suite exercises (initial + two combos)
async function captureAppState(browser, base, artifactsDir) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(250);
    const sink = createApplicationStateSink();
    const cap = (phase, label) => attachApplicationStateCapture(page, sink, { phase, label });
    await cap("route", "initial");
    await page.evaluate(() => {
      history.replaceState(null, "", "/?route=active");
      location.hash = "#/items?view=active";
    });
    await page.waitForTimeout(200);
    await page.click('.cat-btn[data-cat="books"]');
    await page.selectOption("#sort", "price-asc");
    await page.click("#page-up");
    await page.waitForTimeout(200);
    await cap("interaction", "books/price-asc/page2/active");
    await page.click("#theme-toggle");
    await page.click("#cart-add");
    await cap("interaction", "dark-theme/cart1");
    fs.writeFileSync(path.join(artifactsDir, "pages", "page-001", "application-state.json"),
      JSON.stringify(exportApplicationState(sink), null, 2));
    return true;
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// clone-side verification: runtime boot, wiring, fidelity, state persistence
async function verifyClone(browser, site, outDir, origPng, origElements) {
  const server = await startProjectServer(outDir);
  const base = "http://127.0.0.1:" + server.address().port;
  const pageErrors = [], consoleErrors = [];
  const out = { pageErrors, consoleErrors };
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

    await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(600);
    out.state = await page.evaluate(() => {
      const rt = window.__CLONER_RUNTIME || null;
      const paneRects = () => [...document.querySelectorAll("[data-ws-pane]")].map((p) => Math.round(p.getBoundingClientRect().width));
      return {
        runtimeBooted: !!rt,
        runtimeErrors: rt && Array.isArray(rt.errors) ? rt.errors.length : 0,
        wiredTriggers: document.querySelectorAll("[data-cloner-trigger]").length,
        runtimeRecords: Array.isArray(window.__CLONER_INTERACTIONS) ? window.__CLONER_INTERACTIONS.length : 0,
        appStateApplied: window.__APP_STATE_APPLIED || null,
        urlNow: { hash: location.hash, search: location.search },
        workspace: {
          root: !!document.querySelector("[data-ws-root]"),
          tabs: document.querySelectorAll("[data-ws-tab]").length,
          splitters: document.querySelectorAll("[data-ws-splitter]").length,
          panels: document.querySelectorAll("[data-ws-panel]").length,
        },
        paneWidths: paneRects(),
      };
    });

    const shot = await page.screenshot({ timeout: 20000 });
    const intel = await page.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
    out.cloneElements = intel && Array.isArray(intel.elements) ? intel.elements.length : 0;
    out.fidelity = await analyzeFidelity(origPng, shot, origElements,
      intel && Array.isArray(intel.elements) ? intel.elements : [], { page });

    if (site.stateProfile === "workspace") {
      const before = out.state.paneWidths;
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => [...document.querySelectorAll("[data-ws-pane]")].map((p) => Math.round(p.getBoundingClientRect().width)));
      out.workspaceReload = { before, after, same: before.length === after.length && before.every((w, i) => w === after[i]) };
    }
    await ctx.close();

    if (site.stateProfile === "app-state") {
      // fresh context = empty storage → the runtime must re-apply captured entries
      const ctx2 = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page2 = await ctx2.newPage();
      await page2.goto(base + "/", { waitUntil: "load", timeout: 30000 });
      await page2.waitForTimeout(400);
      out.persistence = await page2.evaluate(() => ({
        theme: localStorage.getItem("stateful:theme"),
        cart: localStorage.getItem("stateful:cartCount"),
      }));
      await ctx2.close();
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 300);
  } finally {
    await new Promise((r) => server.close(r));
  }
  return out;
}

// ---- one site, end to end ---------------------------------------------------
async function runSite(site, browser) {
  const fxMod = await import(pathToFileURL(path.join(ROOT, site.fixtureModule)).href);
  const fx = fxMod[site.exportName];
  const metrics = {};
  const notes = [];
  let artifactsDir = null, outDir = null, deepLink = null, planSources = null;

  const server = await startFixtureServer(fx);
  try {
    const base = server.base;
    const jobId = `bench-${site.id}-${Date.now().toString(36)}`;
    const { artifactsDir: ad, manifest: m } = await runExplorationJob({
      url: base + site.entry,
      artifactsRoot: ARTIFACTS,
      jobId,
      config: { policy: { budgets: BUDGETS } },
    });
    artifactsDir = ad;
    outDir = path.join(ARTIFACTS, jobId + "-project");

    // -- structural metrics from the exploration outputs ----------------------
    const routes = new Set((m.pages || []).map(pathnameOf).filter(Boolean));
    const ev = pageEvidence(artifactsDir, m.pages || []);
    const triggerIds = collectTriggerIds(artifactsDir, m.pages || []);
    // failures.json is an object: { errors, warnings, failedInteractions, crashes, timeouts }
    const failuresCount = (() => {
      try {
        const f = readJson(path.join(artifactsDir, "reports", "failures.json"));
        return (f.errors?.length || 0) + (f.warnings?.length || 0) + (f.failedInteractions || 0) + (f.crashes || 0) + (f.timeouts || 0);
      } catch { return -1; }
    })();

    // -- understanding pass (async, every page) -------------------------------
    let uPages = 0, uWithComponents = 0, uWarnings = 0;
    const loaded = loadArtifacts(artifactsDir);
    if (loaded.ok) {
      for (const lp of loaded.pages) {
        try {
          const u = await buildUnderstandingPage(pageArtifactsFromLoaded(lp, artifactsDir));
          uPages++;
          if (Array.isArray(u.components) && u.components.length >= 3) uWithComponents++;
          uWarnings += (u.warnings || []).length;
        } catch { /* a page whose understanding crashed counts against coverage */ }
      }
    } else {
      notes.push(`artifact loader incomplete: ${(loaded.missing || []).join(",")}`);
    }

    // -- stateful fixture: scripted app-state capture (documented Wave-2 hook) -
    if (site.stateProfile === "app-state") {
      const cap = await captureAppState(browser, base, artifactsDir);
      if (cap === true) {
        const plan = buildAppStatePlan(artifactsDir, {});
        deepLink = primaryDeepLink(plan);
        planSources = plan.sources;
        site.__plan = plan; // consumed after reconstruction (augmentation)
      } else {
        notes.push(`app-state capture failed: ${cap.error}`);
      }
    }

    // -- reconstruction (pipeline derives interaction records itself) ----------
    let rec = null;
    try {
      rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
    } catch (e) {
      notes.push(`reconstruction crashed: ${String(e?.message || e).slice(0, 200)}`);
    }
    let validationRatio = 0, genFiles = [];
    if (rec?.ok) {
      const v = rec.report.validation || [];
      genFiles = v.map((x) => x.file).filter(Boolean);
      validationRatio = v.length ? v.filter((x) => x.ok).length / v.length : 0;
      if (site.stateProfile === "app-state" && site.__plan) {
        const aug = augmentProjectWithAppState(outDir, site.__plan, { pages: genFiles });
        metrics.stateRestoration = {
          planSources: (planSources?.deepLinks >= 1 ? 0.5 : 0) + (planSources?.storage >= 1 ? 0.25 : 0) + (planSources?.controls >= 1 ? 0.25 : 0),
          runtimeLinked: genFiles.length ? (aug.linked || 0) / genFiles.length : 0,
          // clone-side components filled after verifyClone
          cloneUrlRestore: 0, persistenceRestore: 0,
        };
        metrics.stateRestoration.__aug = { applied: !!aug.applied, linked: aug.linked };
      }
    }
    delete site.__plan;

    metrics.structuralAccuracy = {
      routeCoverage: site.expectedRoutes ? Math.min(1, routes.size / site.expectedRoutes) : 0,
      pageEvidenceRatio: ev.ratio,
      componentCoverage: uPages ? uWithComponents / uPages : 0,
      reconstructionValidationRatio: validationRatio,
      assetCompleteness: assetCompleteness(artifactsDir, outDir).ratio,
    };
    metrics.__structuralRaw = { routes: routes.size, expectedRoutes: site.expectedRoutes, evidence: ev, uPages, uWithComponents, uWarnings, failuresCount };

    // -- interaction metrics ---------------------------------------------------
    const derived = deriveInteractionRecords(artifactsDir);
    metrics.__interactionRaw = { capturedTriggers: triggerIds, derivedRecords: derived.length };
    metrics.__minTriggers = site.minTriggers;

    // -- clone verification + fidelity ----------------------------------------
    const origPng = path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png");
    const origEls = readJson(path.join(artifactsDir, "pages", "page-001", "dom.json")).elements;
    const clone = await verifyClone(browser, site, outDir, origPng, origEls);
    metrics.__cloneRaw = clone;

    const f = clone.fidelity;
    const origCount = (origEls || []).length;
    const compared = f ? f.typography.compared : 0;
    metrics.visualSimilarity = f ? {
      pixelSimilarityPct: f.pixel.similarityPct,
      geometryMatchRatio: f.geometry.paired ? f.geometry.matched / f.geometry.paired : 1,
      missingRatio: origCount ? f.missing.count / origCount : 0,
      typographyMismatchRatio: compared ? f.typography.mismatchCount / compared : 0,
      colorMismatchRatio: compared ? f.color.mismatchCount / compared : 0,
    } : { pixelSimilarityPct: 0, geometryMatchRatio: 0, missingRatio: 1, typographyMismatchRatio: 1, colorMismatchRatio: 1 };

    const st = clone.state || {};
    metrics.interactionPassRate = {
      triggerCaptureRatio: site.minTriggers ? Math.min(1, triggerIds.length / site.minTriggers) : 1,
      cloneWiringRatio: triggerIds.length ? Math.min(1, (st.wiredTriggers || 0) / triggerIds.length) : 1,
      runtimeRecordRatio: derived.length ? Math.min(1, (st.runtimeRecords || 0) / derived.length) : 1,
    };

    if (site.stateProfile === "app-state") {
      const restored = !!(deepLink && st.urlNow?.hash === deepLink.hash && st.urlNow?.search === deepLink.query && st.appStateApplied?.url === true);
      const persisted = !!(clone.persistence && clone.persistence.theme === "dark" && clone.persistence.cart === "1");
      if (metrics.stateRestoration) {
        metrics.stateRestoration.cloneUrlRestore = restored ? 1 : 0;
        metrics.stateRestoration.persistenceRestore = persisted ? 1 : 0;
      } else {
        metrics.stateRestoration = { planSources: 0, runtimeLinked: 0, cloneUrlRestore: 0, persistenceRestore: 0 };
      }
      // fingerprint is a per-run content hash — strip it so the written report
      // stays byte-reproducible across runs
      const stripVolatile = (o) => (o == null ? o : JSON.parse(JSON.stringify(o, (k, v) => (k === "fingerprint" ? undefined : v))));
      metrics.__stateRaw = { deepLink: stripVolatile(deepLink), restored, persisted, persistence: clone.persistence || null, planSources };
    }
    if (site.stateProfile === "workspace") {
      const ws = st.workspace || {};
      const structureOk = ws.root && ws.tabs >= 2 && ws.splitters >= 2 && ws.panels >= 2;
      const wsAug = !!(rec?.ok && rec.report.workspaceAugmentation && rec.report.workspaceAugmentation.applied !== false);
      metrics.stateRestoration = {
        workspaceAugmentation: wsAug ? 1 : 0,
        cloneDockStructure: structureOk ? 1 : 0,
        reloadPersistence: clone.workspaceReload?.same ? 1 : 0,
      };
      metrics.__stateRaw = { workspace: ws, reload: clone.workspaceReload || null, wsAug };
    }

    // -- runtime robustness ----------------------------------------------------
    const hygiene = rec?.ok ? runtimeHygiene(outDir, genFiles) : { relativeOnly: false, localAssetsPresent: 0, referenced: 0, present: 0 };
    metrics.runtimeRobustness = {
      pageErrors: pageErrorsLike(clone.pageErrors),
      consoleErrors: (clone.consoleErrors || []).length,
      runtimeErrors: st.runtimeBooted ? (st.runtimeErrors || 0) : 1,
      relativePathsOnly: hygiene.relativeOnly ? 1 : 0,
      localAssetsPresent: hygiene.localAssetsPresent,
    };
    metrics.__runtimeRaw = { ...hygiene, booted: !!st.runtimeBooted, cloneElements: clone.cloneElements, cloneError: clone.error || null };

    if (clone.error) notes.push(`clone verification error: ${clone.error}`);
    if (!rec?.ok) notes.push("reconstruction not ok — see artifacts");
    metrics.__notes = notes;
    return metrics;
  } finally {
    await server.close();
  }
}

function pageErrorsLike(arr) {
  return (arr || []).length;
}

// ---- gates, baseline, report ------------------------------------------------
function evaluateGates(site, scored) {
  const floor = rubric.floorsByComplexity[site.complexity] ?? 65;
  const gates = { floor, failures: [] };
  if (scored.overall < floor) gates.failures.push(`overall ${scored.overall} < floor ${floor}`);
  for (const [dim, d] of Object.entries(scored.dimensions)) {
    if (d.score < rubric.criticalDimensionFloor) {
      gates.failures.push(`critical dimension ${dim} ${d.score} < ${rubric.criticalDimensionFloor}`);
    }
  }
  return gates;
}

function regressionCheck(baseline, siteId, scored) {
  if (!baseline) return null;
  const b = baseline.perSite?.[siteId];
  if (!b) return null;
  const drop = round2(b.overall - scored.overall);
  const dims = Object.entries(scored.dimensions).map(([d, v]) => {
    const bd = b.dimensions?.[d]?.score;
    return bd === undefined ? null : { dim: d, baseline: bd, current: v.score, drop: round2(bd - v.score) };
  }).filter(Boolean);
  return {
    baselineOverall: b.overall, drop,
    flagged: drop > rubric.regressionTolerance,
    dimensionDrops: dims.filter((x) => x.drop > rubric.regressionTolerance),
  };
}

function renderReport({ results, aggregate, categoryAggs, baselineUsed, baselineSeeded }) {
  const L = [];
  L.push(`# Multi-Site Benchmark — task 3.5.7`);
  L.push("");
  L.push(`Engine ${ENV.engineVersion} · node ${ENV.node} · ${ENV.platform}`);
  L.push(`Fixtures benchmark-sites ${sitesFile.version} (${sites.length} sites) · rubric ${rubric.version} · viewport ${VIEWPORT.width}x${VIEWPORT.height} · budgets ${JSON.stringify(BUDGETS)}`);
  L.push("");
  L.push(`> Deterministic scoring from suite outputs: every number below is computed from engine artifacts and the live generated clone through the versioned rubric. No live external sites, no credentials, no timestamps — rerunning this script on the same engine build and fixture set reproduces this report byte-for-byte.`);
  L.push("");
  L.push(`## Scoring contract`);
  L.push("");
  L.push(`| dimension | weight | applies to |`);
  L.push(`| --- | --- | --- |`);
  for (const [dim, spec] of Object.entries(rubric.dimensions)) {
    const sitesWith = sites.filter((s) => s.requiredDimensions.includes(dim)).map((s) => s.id).join(", ");
    L.push(`| ${dim} | ${spec.weight} | ${sitesWith} |`);
  }
  L.push("");
  L.push(`Site score = weighted mean of applicable dimension scores (weights renormalized). Aggregate = unweighted mean of site scores. Site floor = complexity floor (${Object.entries(rubric.floorsByComplexity).map(([k, v]) => `${k} ${v}`).join(", ")}). A site fails when any applicable dimension < ${rubric.criticalDimensionFloor}, even if the total clears the floor (visual strength never compensates for broken interactions).`);
  L.push("");
  L.push(`## Per-site results`);
  L.push("");
  L.push(`| site | category | complexity | ${Object.keys(rubric.dimensions).join(" | ")} | overall | floor | verdict |`);
  L.push(`| --- | --- | --- | ${Object.keys(rubric.dimensions).map(() => "---").join(" | ")} | --- | --- | --- |`);
  for (const r of results) {
    const dv = (d) => (r.scored.dimensions[d] ? r.scored.dimensions[d].score.toFixed(1) : "n/a");
    L.push(`| ${r.site.id} | ${r.site.category} | ${r.site.complexity} | ${Object.keys(rubric.dimensions).map(dv).join(" | ")} | **${r.scored.overall.toFixed(2)}** | ${r.gates.floor} | ${r.gates.failures.length ? "FAIL" : "PASS"} |`);
  }
  L.push("");
  L.push(`**Aggregate score: ${aggregate.toFixed(2)} / 100**`);
  L.push("");
  L.push(`### Category aggregates`);
  L.push("");
  L.push(`| category | sites | mean score |`);
  L.push(`| --- | --- | --- |`);
  for (const [cat, a] of Object.entries(categoryAggs)) L.push(`| ${cat} | ${a.sites.join(", ")} | ${a.mean.toFixed(2)} |`);
  L.push("");
  L.push(`## Dimension detail (per-site component values)`);
  for (const r of results) {
    L.push("");
    L.push(`### ${r.site.id} (${r.site.category}, ${r.site.complexity}) — overall ${r.scored.overall.toFixed(2)}`);
    L.push("");
    L.push(`${r.site.demonstrates}`);
    L.push("");
    L.push(`| dimension | component | value | band | score |`);
    L.push(`| --- | --- | --- | --- | --- |`);
    for (const [dim, d] of Object.entries(r.scored.dimensions)) {
      for (const [cid, c] of Object.entries(d.components)) {
        L.push(`| ${dim} (${d.score.toFixed(1)}) | ${cid} | ${c.value} | ${c.band} | ${c.score.toFixed(1)} |`);
      }
    }
    if (r.raw) {
      const bits = [];
      if (r.raw.__structuralRaw) bits.push(`routes ${r.raw.__structuralRaw.routes}/${r.raw.__structuralRaw.expectedRoutes}, pages ${r.raw.__structuralRaw.evidence.good}/${r.raw.__structuralRaw.evidence.total} with full evidence, understanding ${r.raw.__structuralRaw.uWithComponents}/${r.raw.__structuralRaw.uPages} pages ≥3 components, warnings ${r.raw.__structuralRaw.uWarnings}, exploration failures ${r.raw.__structuralRaw.failuresCount}`);
      if (r.raw.__interactionRaw) bits.push(`triggers ${r.raw.__interactionRaw.capturedTriggers.length} (min ${r.raw.__minTriggers}), derived records ${r.raw.__interactionRaw.derivedRecords}`);
      if (r.raw.__cloneRaw?.fidelity) bits.push(`pixel similarity ${r.raw.__cloneRaw.fidelity.pixel.similarityPct}%, geometry ${r.raw.__cloneRaw.fidelity.geometry.matched}/${r.raw.__cloneRaw.fidelity.geometry.paired} paired, missing ${r.raw.__cloneRaw.fidelity.missing.count}`);
      if (r.raw.__cloneRaw?.state) bits.push(`clone wired ${r.raw.__cloneRaw.state.wiredTriggers}, runtime records ${r.raw.__cloneRaw.state.runtimeRecords}, runtime errors ${r.raw.__cloneRaw.state.runtimeErrors}, page errors ${r.raw.__cloneRaw.pageErrors.length}, console errors ${r.raw.__cloneRaw.consoleErrors.length}`);
      if (r.raw.__stateRaw) bits.push(`state: ${JSON.stringify(r.raw.__stateRaw)}`);
      if (r.notes?.length) bits.push(`notes: ${r.notes.join(" | ")}`);
      L.push("");
      L.push(bits.join(" · "));
    }
  }
  L.push("");
  L.push(`## Gate failures`);
  L.push("");
  const failing = results.filter((r) => r.gates.failures.length);
  if (!failing.length) L.push(`None — every site at or above its floor, no critical dimension below ${rubric.criticalDimensionFloor}.`);
  else for (const r of failing) L.push(`- **${r.site.id}** (overall ${r.scored.overall.toFixed(2)} < floor ${r.gates.floor}): ${r.gates.failures.join("; ")}`);
  L.push("");
  L.push(`## Regression vs baseline`);
  L.push("");
  if (baselineSeeded) L.push(`Baseline seeded this run (no prior fixtures/benchmark/baseline.json) — subsequent runs compare against it and fail beyond a ${rubric.regressionTolerance}-point per-site drop.`);
  else if (!baselineUsed) L.push(`No baseline present and the run did not seed one (gate failures) — scores above are unanchored.`);
  else {
    L.push(`Baseline: fixtures/benchmark/baseline.json (rubric ${baselineUsed.rubricVersion}, fixtures ${baselineUsed.fixtureVersion}). Tolerance ${rubric.regressionTolerance} points.`);
    L.push("");
    L.push(`| site | baseline | current | Δ | flagged |`);
    L.push(`| --- | --- | --- | --- | --- |`);
    for (const r of results) {
      const reg = r.regression;
      L.push(`| ${r.site.id} | ${reg ? reg.baselineOverall.toFixed(2) : "n/a"} | ${r.scored.overall.toFixed(2)} | ${reg ? (reg.drop >= 0 ? "+" : "") + reg.drop.toFixed(2) : "n/a"} | ${reg?.flagged ? "**REGRESSION**" : "ok"} |`);
    }
    const flagged = results.filter((r) => r.regression?.flagged);
    if (flagged.length) {
      L.push("");
      for (const r of flagged) L.push(`- REGRESSION ${r.site.id}: ${r.scored.overall.toFixed(2)} vs baseline ${r.regression.baselineOverall.toFixed(2)} (drop ${r.regression.drop})`);
    }
  }
  L.push("");
  L.push(`## Determinism note`);
  L.push("");
  L.push(`Verification for this task runs the same engine build against the same fixture set twice and diffs the report + scores; see the run log for the measured diff result. Live-site checks are a separate manual contract and are never part of this benchmark.`);
  L.push("");
  return L.join("\n");
}

// ---- main -------------------------------------------------------------------
console.log(`multi-site benchmark — ${sites.length} site(s), rubric ${rubric.version}, fixtures ${sitesFile.version}, viewport ${VIEWPORT.width}x${VIEWPORT.height}`);
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
const results = [];
try {
  for (const site of sites) {
    const t0 = Date.now();
    console.log(`\n== site: ${site.id} (${site.category}, ${site.complexity}) — ${site.fixtureModule}`);
    let metrics = null, notes = [];
    try {
      metrics = await runSite(site, browser);
      notes = metrics.__notes || [];
    } catch (e) {
      notes = [`site run crashed: ${String(e?.message || e).slice(0, 300)}`];
      metrics = {};
    }
    const scored = scoreSite(site, metrics);
    const gates = evaluateGates(site, scored);
    results.push({ site, metrics, scored, gates, notes, raw: metrics, elapsedMs: Date.now() - t0 });
    console.log(`   overall ${scored.overall.toFixed(2)} (floor ${gates.floor}) — ${gates.failures.length ? "FAIL: " + gates.failures.join("; ") : "PASS"} [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  }
} finally {
  await browser.close().catch(() => {});
}

// aggregates (unweighted site means — plan step 4 normalization)
const aggregate = round2(results.reduce((s, r) => s + r.scored.overall, 0) / results.length);
const categoryAggs = {};
for (const r of results) {
  const cat = r.site.category;
  (categoryAggs[cat] ||= { sites: [], sum: 0 }).sites.push(r.site.id);
  categoryAggs[cat].sum += r.scored.overall;
}
for (const a of Object.values(categoryAggs)) a.mean = round2(a.sum / a.sites.length);

// baseline
let baselineUsed = null, baselineSeeded = false;
const anyGateFailure = results.some((r) => r.gates.failures.length);
if (fs.existsSync(BASELINE_PATH)) {
  try { baselineUsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")); } catch { baselineUsed = null; }
}
for (const r of results) r.regression = baselineUsed ? regressionCheck(baselineUsed, r.site.id, r.scored) : null;
const regressions = results.filter((r) => r.regression?.flagged);

let seeded = null;
if (!baselineUsed && !anyGateFailure) {
  seeded = {
    rubricVersion: rubric.version,
    fixtureVersion: sitesFile.version,
    perSite: Object.fromEntries(results.map((r) => [r.site.id, {
      overall: r.scored.overall,
      dimensions: Object.fromEntries(Object.entries(r.scored.dimensions).map(([d, v]) => [d, { score: v.score }])),
    }])),
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(seeded, null, 2) + "\n");
  baselineSeeded = true;
  baselineUsed = seeded;
  for (const r of results) r.regression = regressionCheck(seeded, r.site.id, r.scored);
}

// outputs
fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
const md = renderReport({ results, aggregate, categoryAggs, baselineUsed, baselineSeeded });
fs.writeFileSync(REPORT_PATH, md);

const result = {
  task: "3.5.7",
  benchmark: "multi-site",
  manifestVersion: manifest.version,
  fixtureVersion: sitesFile.version,
  rubricVersion: rubric.version,
  environment: ENV,
  aggregate,
  categoryAggs,
  baselineSeeded,
  results: results.map((r) => ({
    site: r.site.id,
    category: r.site.category,
    complexity: r.site.complexity,
    overall: r.scored.overall,
    floor: r.gates.floor,
    dimensions: Object.fromEntries(Object.entries(r.scored.dimensions).map(([d, v]) => [d, v.score])),
    gateFailures: r.gates.failures,
    regression: r.regression ? { baselineOverall: r.regression.baselineOverall, drop: r.regression.drop, flagged: r.regression.flagged } : null,
    notes: r.notes,
    raw: {
      structural: r.raw?.__structuralRaw || null,
      interaction: r.raw?.__interactionRaw || null,
      state: r.raw?.__stateRaw || null,
      runtime: r.raw?.__runtimeRaw || null,
      fidelity: r.raw?.__cloneRaw?.fidelity ? {
        similarityPct: r.raw.__cloneRaw.fidelity.pixel.similarityPct,
        geometry: r.raw.__cloneRaw.fidelity.geometry,
        missing: r.raw.__cloneRaw.fidelity.missing.count,
        typography: r.raw.__cloneRaw.fidelity.typography.mismatchCount,
        color: r.raw.__cloneRaw.fidelity.color.mismatchCount,
      } : null,
    },
  })),
  report: path.relative(ROOT, REPORT_PATH),
};
fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));

console.log(`\naggregate ${aggregate.toFixed(2)}/100 — report: ${path.relative(ROOT, REPORT_PATH)}`);
const hardFail = anyGateFailure || regressions.length > 0;
if (hardFail) {
  for (const r of results) if (r.gates.failures.length) console.log(`FAIL ${r.site.id}: ${r.gates.failures.join("; ")}`);
  for (const r of regressions) console.log(`REGRESSION ${r.site.id}: ${r.scored.overall} vs baseline ${r.regression.baselineOverall}`);
  process.exit(1);
}
console.log("all sites pass gates" + (baselineSeeded ? " (baseline seeded)" : baselineUsed ? " (baseline compared)" : ""));
process.exit(0);
