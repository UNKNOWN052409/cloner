// Exploration pipeline (spec §1, §15): URL + auth + policy → autonomous
// exploration → machine-readable artifact tree. Reuses the proven engine
// (browser.js capture, interactions.js explorer) and adds the intelligence +
// graph + contract layers around it.
import path from "node:path";
import fs from "node:fs";
import { launchBrowser, newContext, loadCookies } from "../browser.js";
import { resolvePolicy } from "../exploration/exploration-policy.js";
import { createRouteDiscovery, spaRecorderScript } from "../exploration/route-discovery.js";
import { createStateGraph, DOM_SIGNATURE_SCRIPT } from "../exploration/state-discovery.js";
import { DOM_EXTRACTOR_SCRIPT, analyzeTypography } from "../intelligence/dom-extractor.js";
import { buildAssetManifest, captureResponsive } from "../assets/asset-manifest.js";
import { createArtifactStore, redact } from "../storage/artifact-store.js";
import { createLogger } from "../observability/logger.js";

function makeJobId() {
  return "exp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function safePathname(u) {
  try { return new URL(u).pathname; } catch { return null; }
}

export async function runExplorationJob({ url, cookiesFile, cookies, storage, username, password, config = {}, artifactsRoot = "artifacts", jobId: forcedId, onProgress = null } = {}) {
  const id = forcedId || makeJobId();
  const store = createArtifactStore(artifactsRoot, id);
  const policy = resolvePolicy(config.policy || {});
  const { bus } = await import("../events.js");
  const logger = createLogger({ jobId: id, artifactsDir: store.dirs.root, sessionId: config.sessionId || "local" });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + policy.budgets.maxTotalTimeMs;
  const warnings = [];
  const errors = [];

  // per-job bus bridge (spec §16): named handlers removed in finally, so no
  // listener accumulation across jobs; events are only mirrored while THIS job
  // is inside an engine call (engineActive), so bus traffic from concurrent
  // clone tasks / other runs outside that window never reaches this job's log
  let engineActive = false;
  const onStep = (e) => {
    if (!engineActive) return;
    const d = e?.data || {};
    logger.info("engine", d.msg || d.id || "step", { status: d.status });
  };
  const onLog = (e) => {
    if (!engineActive) return;
    const d = e?.data || {};
    if (d.level === "warn") {
      // the engine logs these only after its own click retry also failed
      if (/inner click failed|topbar control .* failed/i.test(String(d.msg || ""))) logger.bump("failedInteractions");
      logger.warn("engine", d.msg || "");
    } else if (d.msg) logger.info("engine", d.msg);
  };
  bus.on("step", onStep);
  bus.on("log", onLog);

  logger.info("pipeline", "exploration job started", { url, budgets: policy.budgets });

  let browser = null;
  try {
    browser = await launchBrowser({ headless: true });
    // ---- browser session ----
    const sessionStart = Date.now();
    const ctx = await newContext(browser, {
      cookies: cookies || (cookiesFile ? loadCookies(cookiesFile) : null),
      viewport: policy.viewports[0],
      storage,
    });
    const page = await ctx.newPage();
    logger.metric("navigationMs", Date.now() - sessionStart);
    logger.info("browser", "browser + context ready", { viewport: policy.viewports[0].name });
    page.on("crash", () => { logger.bump("crashes"); errors.push("page crashed during exploration"); });

    // network recorder (spec §11) — attach() registers the page listeners; the
    // returned recorder MUST be attached or every network.json stays empty
    const { attachNetworkRecorder } = await import("../network/network-recorder.js");
    const network = { entries: [] };
    const allNetwork = []; // job-level accumulation for asset capture
    let netCursor = 0;
    attachNetworkRecorder(ctx, network).attach(page);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
    logger.info("browser", "page loaded", { url: page.url() });
    const spaScript = spaRecorderScript(policy.routes.maxSpaEvents);
    await page.evaluate(spaScript).catch(() => {});

    // ---- auth detection (spec §6) ----
    const authInfo = await page.evaluate(() => {
      const pass = document.querySelector('input[type="password"]');
      if (!pass) return { loginRequired: false };
      const userField = document.querySelector('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]');
      return { loginRequired: true, hasUsernameField: !!userField };
    }).catch(() => ({ loginRequired: false }));

    if (authInfo.loginRequired && username && password) {
      logger.info("auth", "login form detected — submitting user-provided credentials");
      const userOk = await page.locator('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]').first().fill(username, { timeout: 8000 }).then(() => true, () => false);
      if (!userOk) warnings.push("login: username/email field not found — credentials were not typed");
      const passOk = userOk && await page.locator('input[type="password"]').first().fill(password, { timeout: 8000 }).then(() => true, () => false);
      if (userOk && !passOk) warnings.push("login: password field not fillable — credentials were not typed");
      if (userOk && passOk) {
        // submit exactly once: click when a submit control exists, Enter only as
        // fallback — racing both double-submits real login forms
        const clicked = await page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first().click({ timeout: 6000 }).then(() => true, () => false);
        if (!clicked) await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(6000);
      }
      const still = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => true);
      if (still) errors.push("authentication may have failed — password field still present");
      else logger.info("auth", "login submitted");
    } else if (authInfo.loginRequired) {
      warnings.push("login required but no credentials provided — exploration limited to public state");
    }

    // ---- route discovery (spec §7A) ----
    const discovery = createRouteDiscovery(page, policy, logger);
    await discovery.seed(page.url());
    await discovery.fromDom(policy.budgets.maxRoutes);
    await discovery.installSpaRecorder();

    // ---- per-page capture + states (bounded, spec §7B/§7C/§8) ----
    const graph = createStateGraph();
    const pages = [];
    const exploredPaths = new Set();
    const maxRoutes = policy.budgets.maxRoutes;

    const exploreRoute = async (route, pageId, { navigate }) => {
      logger.setPage(pageId);
      const tNav = Date.now();
      if (navigate) {
        await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
          if (/timeout/i.test(String(e?.message || e))) logger.bump("timeouts");
          errors.push(`route failed: ${route.url} — ${String(e?.message || e).slice(0, 80)}`);
        });
        try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch {}
        await page.evaluate(spaScript).catch(() => {});
      }
      logger.metric("navigationMs", Date.now() - tNav);
      const pageDeadline = Math.min(Date.now() + policy.budgets.maxTimePerPageMs, deadline);

      // state node (dedup by fingerprint, spec §8)
      const domSig = await page.evaluate(DOM_SIGNATURE_SCRIPT).catch(() => "sig-unavailable");
      logger.setState("root");

      // screenshots (spec §10)
      const tShot = Date.now();
      const shotFull = await page.screenshot({ fullPage: false, timeout: 20000 }).catch(() => null);
      if (shotFull) store.writeBinary(`pages/${pageId}/screenshot-viewport.png`, shotFull);
      logger.metric("screenshotMs", Date.now() - tShot);

      // DOM intelligence (spec §9)
      const tDom = Date.now();
      const domIntel = await page.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      logger.metric("domExtractionMs", Date.now() - tDom);
      if (domIntel) {
        domIntel.typography = analyzeTypography(domIntel.elements);
        store.writeJson(`pages/${pageId}/dom.json`, { pageId, url: page.url(), total: domIntel.total, sampled: domIntel.sampled, elements: domIntel.elements, repeated: domIntel.repeated, fixed: domIntel.fixed, sticky: domIntel.sticky, typography: domIntel.typography });
        store.writeJson(`pages/${pageId}/geometry.json`, { pageId, containers: domIntel.elements.slice(0, 60).map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect, layout: e.layout })), fixed: domIntel.fixed, sticky: domIntel.sticky, repeated: domIntel.repeated });
        store.writeJson(`pages/${pageId}/styles.json`, { pageId, typography: domIntel.typography, elements: domIntel.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, style: e.style })) });
      }

      // responsive captures (first explored page only, spec §10)
      if (pages.length === 0) {
        const responsive = await captureResponsive(page, policy.viewports.slice(1), null, store.dirs.root, pageId).catch((e) => {
          logger.warn("responsive", `responsive capture failed: ${String(e?.message || e).slice(0, 120)}`);
          return null;
        });
        if (responsive) {
          store.writeJson(`pages/${pageId}/responsive.json`, responsive);
          if (responsive.layoutChanged) logger.info("responsive", "layout changes detected across viewports");
        }
      }

      // interaction states via the proven explorer (spec §7B/§7C); the bus
      // bridge only mirrors engine events while this call is live
      const { recordInteractions } = await import("../interactions.js");
      engineActive = true;
      let records;
      try {
        records = await recordInteractions(page, {
          waitMs: 800, max: policy.budgets.maxStatesPerPage, triggerMax: policy.budgets.maxInteractionsPerState,
          budgetMs: Math.max(20000, pageDeadline - Date.now()), outDir: store.dirs.root,
        });
      } finally { engineActive = false; }

      // network flush AFTER the interactions so interaction traffic is
      // attributed to the page that caused it (spec §11). The full buffer is
      // retained in allNetwork for the asset-capture stage.
      const newEntries = network.entries.slice(netCursor);
      netCursor = network.entries.length;
      allNetwork.push(...newEntries);
      store.writeJson(`pages/${pageId}/network.json`, { pageId, url: page.url(), entries: redact(newEntries) });

      // harvest THIS page's SPA transitions before navigating away — the
      // recorder buffer is per-document and resets on every navigation (spec §7A)
      await discovery.fromSpaEvents(maxRoutes);

      // graph: root state + one node/edge per recorded interaction, with
      // evidence wired to the artifacts that actually exist (spec §8)
      const rootNode = graph.addState({ url: page.url(), domSig, screenshotRef: shotFull ? `pages/${pageId}/screenshot-viewport.png` : null, domRef: domIntel ? `pages/${pageId}/dom.json` : null, viewport: policy.viewports[0].name, status: "explored" });
      const refStatesDir = path.join(store.dirs.root, "_reference", "states");
      let stateShots = [];
      try { stateShots = fs.existsSync(refStatesDir) ? fs.readdirSync(refStatesDir) : []; } catch {}
      for (const rec of records) {
        if (rec.kind !== "overlay" && rec.kind !== "module") continue;
        const shotFile = stateShots.find((f) => f.startsWith(`${rec.id}-`) && f.endsWith(".png")) || (stateShots.includes(`picker-${rec.id}.png`) ? `picker-${rec.id}.png` : null);
        const screenshotRef = shotFile ? `_reference/states/${shotFile}` : null;
        const domRef = rec.html ? store.writeText(`states/${pageId}/${rec.id}.html`, rec.html) : null;
        const st = graph.addState({ url: page.url() + "#" + (rec.text || rec.id), domSig: domSig + ":" + rec.id, parentStateId: rootNode.node.id, interaction: rec.text || rec.id, screenshotRef, domRef, status: "recorded" });
        graph.addEdge({
          fromStateId: rootNode.node.id, toStateId: st.node.id, trigger: rec.text || rec.id, action: "click",
          expected: `${rec.kind} opens`,
          actual: st.duplicate ? "duplicate state (deduped)" : "captured",
          success: true,
          evidence: screenshotRef || domRef,
        });
      }
      const pn = safePathname(page.url());
      if (pn) exploredPaths.add(pn);
      pages.push({ pageId, url: page.url(), route, records: records.length, domSampled: domIntel ? domIntel.sampled : 0 });
      logger.info("explore", `page ${pageId} done`, { records: records.length, domSampled: domIntel ? domIntel.sampled : 0 });
    };

    // exploration set is fixed when the loop starts (bounded budget); SPA routes
    // discovered while exploring are harvested per page below and picked up by
    // the second pass if they are genuinely new documents
    const plannedRoutes = discovery.routes.slice(0, maxRoutes);
    for (let pi = 0; pi < plannedRoutes.length && pages.length < maxRoutes; pi++) {
      if (Date.now() > deadline) { warnings.push("total exploration time budget exhausted — remaining routes skipped"); break; }
      await exploreRoute(plannedRoutes[pi], "page-" + String(pages.length + 1).padStart(3, "0"), { navigate: pi > 0 });
    }
    // second pass: SPA routes found during the loop are recorded for every page;
    // ones with a pathname never explored (real new documents, not query/hash
    // state variants of an already-explored page) are explored while budget remains
    for (const route of [...discovery.routes]) {
      if (pages.length >= maxRoutes || Date.now() > deadline) break;
      const pn = safePathname(route.url);
      if (!pn || exploredPaths.has(pn)) continue;
      if (plannedRoutes.some((r) => r.url === route.url)) continue;
      exploredPaths.add(pn);
      await exploreRoute(route, "page-" + String(pages.length + 1).padStart(3, "0"), { navigate: true });
    }

    // ---- graph + state evidence (spec §8, §15) ----
    const graphData = graph.serialize();
    store.writeJson("graph/routes.json", { routes: discovery.routes, policy: policy.routes });
    store.writeJson("graph/states.json", graphData);
    store.writeJson("graph/transitions.json", { edges: graphData.edges });
    store.writeJson("states/index.json", {
      note: "state evidence index (spec §8/§15): interaction-state HTML per page under states/<pageId>/<recordId>.html, state screenshots under _reference/states/, page captures under pages/<pageId>/",
      states: graphData.nodes,
      edges: graphData.edges,
    });

    // ---- asset capture (spec §0 preflight) + manifest (§11/§12) ----
    // persist static resources found by the network recorder (browser still open)
    let assetCapture = { count: 0, bytes: 0 };
    try {
      const { captureAssets } = await import("./asset-capture.js");
      assetCapture = await captureAssets(ctx, allNetwork, store, logger);
      if (assetCapture.count) logger.info("assets", `captured ${assetCapture.count} resource(s), ${(assetCapture.bytes / 1024).toFixed(0)}KB`);
    } catch (e) {
      warnings.push("asset capture failed: " + String(e.message || e).slice(0, 100));
    }
    const assetManifest = buildAssetManifest(store.dirs.root);
    assetManifest.capturedFromNetwork = assetCapture;
    store.writeJson("assets/manifest.json", assetManifest);

    // ---- manifest (spec §15) ----
    const finishedAt = new Date().toISOString();
    const manifest = redact({
      schemaVersion: "1.0.0",
      jobId: id,
      startedAt, finishedAt,
      originalUrl: url,
      status: errors.length ? "completed-with-errors" : "completed",
      configuration: { budgets: policy.budgets, viewports: policy.viewports.map((v) => v.name) },
      discoveredRoutes: discovery.routes.length,
      discoveredStates: graphData.stats.nodes,
      discoveredInteractions: graphData.stats.edges,
      assets: { total: assetManifest.total + assetCapture.count, totalBytes: assetManifest.totalBytes + assetCapture.bytes, byType: assetManifest.byType, deduplicated: assetManifest.deduplicated, capturedFromNetwork: assetCapture },
      pages,
      coverage: { routesExplored: pages.length, routesDiscovered: discovery.routes.length, statesRecorded: graphData.stats.nodes },
      errors: errors.map((e) => ({ message: String(e).slice(0, 200) })),
      warnings: warnings.map((w) => ({ message: String(w).slice(0, 200) })),
      auth: { loginRequired: authInfo.loginRequired, credentialsUsed: !!(username && password) },
      metrics: logger.metrics(),
    });
    store.writeManifest(manifest);
    store.writeJson("reports/exploration-summary.json", redact({
      jobId: id, status: manifest.status, pages: pages.length, routes: discovery.routes.length,
      states: graphData.stats.nodes, interactions: graphData.stats.edges, errors, warnings,
    }));
    store.writeJson("reports/coverage-report.json", {
      routesDiscovered: discovery.routes.length,
      routesExplored: pages.length,
      coveragePct: discovery.routes.length ? Math.round((pages.length / discovery.routes.length) * 100) : 100,
      statesRecorded: graphData.stats.nodes,
      budget: policy.budgets,
    });
    store.writeJson("reports/failures.json", redact({
      errors, warnings,
      failedInteractions: logger.metrics().failedInteractions,
      crashes: logger.metrics().crashes,
      timeouts: logger.metrics().timeouts,
    }));

    logger.info("pipeline", "exploration job finished", { status: manifest.status });
    return { jobId: id, artifactsDir: store.dirs.root, manifest };
  } catch (e) {
    logger.error("pipeline", `exploration job failed: ${String(e?.message || e).slice(0, 200)}`);
    throw e;
  } finally {
    // always: detach this job's bus listeners + close the browser (no leaked
    // chromium process and no dangling transport on any failure path)
    bus.off("step", onStep);
    bus.off("log", onLog);
    if (browser) await browser.close().catch(() => {});
  }
}
