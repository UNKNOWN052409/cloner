// Exploration pipeline (spec §1, §15): URL + auth + policy → autonomous
// exploration → machine-readable artifact tree. Reuses the proven engine
// (browser.js capture, interactions.js explorer) and adds the intelligence +
// graph + contract layers around it.
import path from "node:path";
import fs from "node:fs";
import { launchBrowser, newContext, loadCookies } from "../browser.js";
// realignment integration: browser pool (one warm browser reused across jobs in
// this process, per-job isolated contexts) + the authenticated-session hook
// (login once → verified → persisted storage state, official Playwright pattern)
import { getWorkerPool, createWorkerPool, getBrowserRootPid, sampleBrowserRss } from "../browser/browser-pool.js";
import { authenticateSession } from "../exploration/authenticated-session.js";
import { resolvePolicy } from "../exploration/exploration-policy.js";
import { createRouteDiscovery, spaRecorderScript } from "../exploration/route-discovery.js";
// task 3.5.6: the proven SPA in-URL walker (test-spa-depth.mjs) is wired into
// the per-route loop below — enumerateInAppStates records same-URL view
// switches as url#state graph nodes, statePageId names their artifact dirs and
// statePageEntries turns them into manifest.pages entries
import { createStateGraph, DOM_SIGNATURE_SCRIPT, enumerateInAppStates, statePageId, statePageEntries } from "../exploration/state-discovery.js";
import { DOM_EXTRACTOR_SCRIPT, analyzeTypography } from "../intelligence/dom-extractor.js";
import { buildAssetManifest, captureResponsive } from "../assets/asset-manifest.js";
import { createArtifactStore, redact } from "../storage/artifact-store.js";
import { createLogger } from "../observability/logger.js";
// observability realignment: workflow event emitter for the swarm build viewer
// (stage/todo/agent events on the existing bus at REAL stage boundaries)
import { createWorkflowEmitter } from "../observability/workflow-events.js";
import { withJobScope } from "../events.js";
// task 3.4.4: sanitized WebSocket session capture — payload SHAPES only, every
// string value redacted (numbers kept per the ticker contract), query values
// stripped from URLs, credential-named keys collapsed
import { attachWebSocketCapture, createWebSocketSink, exportWebSocketSink } from "../exploration/websocket-session-capture.js";
// task 3.5.3: application-state capture (URL hash/query, storage, marked
// controls) — one observation per explored route, same sink/export pattern as
// the WebSocket capture
import { createApplicationStateSink, attachApplicationStateCapture, exportApplicationState } from "../exploration/application-state-capture.js";

function makeJobId() {
  return "exp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function safePathname(u) {
  try { return new URL(u).pathname; } catch { return null; }
}

// realignment: in-process pool identity — every runExplorationJob in this node
// process shares ONE pool so consecutive jobs reuse the same warm browser
const POOL_ID = "exploration-pipeline-inproc";

// merge payload cookies with the verified session's cookies (session wins on
// name+domain so a fresh login cannot be shadowed by a stale payload cookie)
function mergeCookies(base, session) {
  if (!session?.length) return base || null;
  const out = [...(base || [])];
  for (const sc of session) {
    const i = out.findIndex((c) => c.name === sc.name && (c.domain || "") === (sc.domain || ""));
    if (i >= 0) out[i] = sc; else out.push(sc);
  }
  return out.length ? out : null;
}

// task 3.5.6: state-page evidence writer for in-URL states — the same artifact
// shape scripts/test-spa-depth.mjs proves (its capturePageArtifacts): screenshot
// + dom.json + geometry.json + styles.json + network.json under pages/<stateId>/,
// so the reconstruction's artifact-loader reads each state page exactly like a
// route page. Walk-period network traffic stays attributed to the parent route
// page, so a state page's network.json is an honest empty ledger.
async function captureInAppStateArtifacts(store, p, stateId, stateUrl) {
  const shot = await p.screenshot({ fullPage: false, timeout: 20000 }).catch(() => null);
  const screenshotRef = shot ? store.writeBinary(`pages/${stateId}/screenshot-viewport.png`, shot) : null;
  const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
  let domRef = null;
  if (intel) {
    intel.typography = analyzeTypography(intel.elements);
    store.writeJson(`pages/${stateId}/dom.json`, { pageId: stateId, url: stateUrl, total: intel.total, sampled: intel.sampled, elements: intel.elements, repeated: intel.repeated, fixed: intel.fixed, sticky: intel.sticky, typography: intel.typography });
    store.writeJson(`pages/${stateId}/geometry.json`, { pageId: stateId, containers: intel.elements.slice(0, 60).map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect, layout: e.layout })), fixed: intel.fixed, sticky: intel.sticky, repeated: intel.repeated });
    store.writeJson(`pages/${stateId}/styles.json`, { pageId: stateId, typography: intel.typography, bodyStyle: intel.bodyStyle || null, htmlStyle: intel.htmlStyle || null, elements: intel.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, style: e.style })) });
    domRef = `pages/${stateId}/dom.json`;
  }
  store.writeJson(`pages/${stateId}/network.json`, { pageId: stateId, url: stateUrl, entries: [] });
  return { screenshotRef, domRef };
}

export async function runExplorationJob({ url, cookiesFile, cookies, storage, username, password, storageStateFile = null, sessionSidecarFile = null, config = {}, artifactsRoot = "artifacts", jobId: forcedId, onProgress = null } = {}) {
  const id = forcedId || makeJobId();
  const store = createArtifactStore(artifactsRoot, id);
  const policy = resolvePolicy(config.policy || {});
  const { bus } = await import("../events.js");
  const logger = createLogger({ jobId: id, artifactsDir: store.dirs.root, sessionId: config.sessionId || "local" });
  // workflow events (viewer contract): stage/todo/agent emissions tagged with
  // this job id on the shared bus
  const wf = createWorkflowEmitter({ jobId: id });
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
    if (e?.job && e.job !== id) return; // another job's engine traffic
    const d = e?.data || {};
    logger.debug("engine", d.msg || d.id || "step", { status: d.status }); // per-step chatter: debug only (log contract)
  };
  const onLog = (e) => {
    if (!engineActive) return;
    if (e?.job && e.job !== id) return; // another job's engine traffic
    const d = e?.data || {};
    if (d.level === "warn") {
      // the engine logs these only after its own click retry also failed
      if (/inner click failed|topbar control .* failed/i.test(String(d.msg || ""))) logger.bump("failedInteractions");
      logger.warn("engine", d.msg || "");
    } else if (d.msg) logger.debug("engine", d.msg); // per-step chatter: debug only (log contract)
  };
  bus.on("step", onStep);
  bus.on("log", onLog);

  logger.info("pipeline", "exploration job started", { url, budgets: policy.budgets });
  wf.stage("exploration", "running", 0); // viewer: the stage has started

  let browser = null; // pooled browser (pool mode) or direct launch (legacy mode)
  let lease = null;   // pool lease — null when CLONER_BROWSER_POOL=0
  let ctx = null;
  let page = null;
  // realignment: pool default ON — one warm browser is reused across jobs in
  // this process; CLONER_BROWSER_POOL=0 forces the legacy per-job launch/close.
  const poolEnabled = process.env.CLONER_BROWSER_POOL !== "0";
  try {
    // ---- auth hook (BEFORE route exploration): payload credentials →
    // authenticateSession() establishes, VERIFIES and persists the session so
    // this job's context starts from the storage state (official Playwright
    // auth pattern). needsHuman → bus event + PAUSE (fail-soft, never bypass).
    let authOk = false;
    let authStatus = username && password ? "pending" : "not-required";
    let authReason = null;
    let authIndicators = null;
    let sessionState = null;
    let sessionStorageData = null;
    if (username && password) {
      // session REUSE first: a prior job's verified storage state (auth/session
      // .json + sessionStorage sidecar) seeds this context without a second
      // login — repeated logins kick the older concurrent session on sites
      // like trader.tradovate.com. Fall back to a fresh login only when the
      // saved files are missing/unreadable.
      let reused = false;
      if (storageStateFile && fs.existsSync(storageStateFile)) {
        try {
          sessionState = JSON.parse(fs.readFileSync(storageStateFile, "utf8"));
          if (sessionSidecarFile && fs.existsSync(sessionSidecarFile)) {
            sessionStorageData = JSON.parse(fs.readFileSync(sessionSidecarFile, "utf8"));
            store.writeJson("auth/session-storage.json", sessionStorageData);
          }
          store.writeJson("auth/session.json", sessionState);
          authOk = true;
          authStatus = "verified";
          reused = true;
          authIndicators = ["reused-session-state"];
          logger.info("auth", "session reused from prior job (no second login)", {
            ref: storageStateFile,
            cookies: (sessionState.cookies || []).length,
            sessionStorage: sessionStorageData ? Object.keys(sessionStorageData.items || {}).length : 0,
          });
        } catch (e) {
          warnings.push("auth: session reuse failed — falling back to fresh login: " + String(e?.message || e).slice(0, 120));
        }
      }
      if (!reused) {
      const auth = await authenticateSession({ url, username, password, policy, logger, artifactsDir: store.dirs.root });
      for (const w of auth.warnings || []) warnings.push("auth: " + w);
      if (auth.ok) {
        try {
          sessionState = JSON.parse(fs.readFileSync(auth.storageStatePath, "utf8"));
          // session state lives under the job artifacts (auth/session.json).
          // NOTE: exportV2Task's fail-closed credential scan refuses to ship
          // session-named files — the exporter (outside this file's ownership)
          // would abort authed-job exports until it excludes them at copy time.
          store.writeJson("auth/session.json", sessionState);
          if (auth.sessionStoragePath && fs.existsSync(auth.sessionStoragePath)) {
            // SPA auth tokens often live in sessionStorage (storageState never
            // captures it) — sidecar captured by authenticateSession, injected
            // into the exploration context below via addInitScript.
            sessionStorageData = JSON.parse(fs.readFileSync(auth.sessionStoragePath, "utf8"));
            store.writeJson("auth/session-storage.json", sessionStorageData);
          }
          authOk = true;
          authStatus = "verified";
          authIndicators = auth.indicators || [];
          logger.info("auth", "authenticated session established + persisted", { ref: "auth/session.json", indicators: authIndicators.length });
        } catch (e) {
          authStatus = "failed";
          authReason = `session state unreadable: ${String(e?.message || e).slice(0, 120)}`;
          warnings.push("auth: " + authReason);
        }
      } else if (auth.needsHuman) {
        // MFA/CAPTCHA/second-step challenge — NEVER bypassed: emit the warn
        // event, record the pause in the manifest, stop exploration for THIS job
        authStatus = "human-required";
        authReason = auth.reason;
        withJobScope(id, () => bus.emit("auth:human-required", { level: "warn", jobId: id, url, reason: auth.reason }));
        logger.warn("auth", `human required — exploration paused for this job: ${auth.reason}`);
        const pausedManifest = redact({
          schemaVersion: "1.0.0",
          jobId: id, startedAt, finishedAt: new Date().toISOString(),
          originalUrl: url,
          status: "paused-human-required",
          configuration: { budgets: policy.budgets, viewports: policy.viewports.map((v) => v.name) },
          discoveredRoutes: 0, discoveredStates: 0, discoveredInteractions: 0,
          assets: { total: 0, totalBytes: 0, byType: {}, deduplicated: 0, capturedFromNetwork: { count: 0, bytes: 0 } },
          pages: [],
          coverage: { routesExplored: 0, routesDiscovered: 0, statesRecorded: 0 },
          errors: errors.map((e) => ({ message: String(e).slice(0, 200) })),
          warnings: warnings.map((w) => ({ message: String(w).slice(0, 200) })),
          auth: { loginRequired: true, credentialsUsed: true, status: "human-required", paused: true, reason: auth.reason, indicators: [], sessionStateRef: null },
          metrics: logger.metrics(),
        });
        store.writeManifest(pausedManifest);
        // same redact() wrap as the completed path further down — the paused
        // reports carry errors/warnings too, so credential-shaped strings that
        // ever land in them (JWTs, ?token= URLs) are scrubbed here as well
        store.writeJson("reports/exploration-summary.json", redact({ jobId: id, status: pausedManifest.status, pages: 0, routes: 0, states: 0, interactions: 0, errors, warnings }));
        store.writeJson("reports/failures.json", redact({ errors, warnings, failedInteractions: 0, crashes: 0, timeouts: 0 }));
        logger.debug("pipeline", "exploration job paused (auth needs human) — no pages explored");
        // log contract + viewer: the ONE stage summary line for a paused job
        logger.stage("exploration", "paused", { routes: 0, pages: 0, states: 0, warnings: warnings.length, errors: errors.length });
        wf.stage("exploration", "paused", 0);
        return { jobId: id, artifactsDir: store.dirs.root, manifest: pausedManifest };
      } else {
        authStatus = "failed";
        authReason = auth.reason;
        warnings.push(`auth: session not established — exploring without authentication (fail-soft): ${auth.reason}`);
      }
      } // end if (!reused) — fresh-login fallback
    }

    // ---- browser: pooled (default) or per-job launch (CLONER_BROWSER_POOL=0) ----
    let pool = null;
    if (poolEnabled) {
      pool = getWorkerPool(POOL_ID) || createWorkerPool(POOL_ID, {
        // 30s idle window (was the pool default 120s): a parked browser keeps the
        // node event loop alive, so one-shot CLI runs would otherwise sit idle
        // for 120s after the last job; busy workers still reuse across bursts.
        // CLONER_POOL_IDLE_TIMEOUT_MS overrides for deployments that want longer.
        idleTimeoutMs: process.env.CLONER_POOL_IDLE_TIMEOUT_MS ? Number(process.env.CLONER_POOL_IDLE_TIMEOUT_MS) : 30_000,
      });
    }
    // realignment: REAL browser RSS via browser-pool's sampler (CDP process list
    // → OS WorkingSetSize sum) — peak per job lands in manifest.browserMemory,
    // the evidence for the pool-vs-per-job RAM measurement. CLONER_BROWSER_RSS_SAMPLE=0
    // disables the sampling (each win32 sample costs ~1s of OS query).
    const rssSampling = process.env.CLONER_BROWSER_RSS_SAMPLE !== "0";
    const browserMemory = { mode: poolEnabled ? "pool" : "per-job", peakRssMB: null, samples: 0, sampleFailures: 0, browserRootPid: null, poolBrowsersCreated: null, poolReusedBrowser: null };
    const sampleRss = async (label) => {
      try {
        if (!rssSampling || !browser?.isConnected?.()) return;
        const rss = await sampleBrowserRss(browser);
        if (rss == null) { browserMemory.sampleFailures++; return; }
        browserMemory.samples++;
        const mb = Math.round((rss / (1024 * 1024)) * 10) / 10;
        if (browserMemory.peakRssMB == null || mb > browserMemory.peakRssMB) browserMemory.peakRssMB = mb;
        logger.debug("browser", `browser RSS ${mb}MB (peak ${browserMemory.peakRssMB}MB) — ${label}`);
      } catch { browserMemory.sampleFailures++; }
    };

    // session state → context inputs (payload cookies keep lower precedence
    // than the verified session's own cookies; localStorage from the storage
    // state's origins is merged so SPA sessions restore too)
    const payloadCookies = cookies || (cookiesFile ? loadCookies(cookiesFile) : null);
    const contextCookies = sessionState ? mergeCookies(payloadCookies, sessionState.cookies) : payloadCookies;
    const contextStorage = sessionState
      ? { ...(storage || {}), ls: { ...(storage?.ls || {}), ...Object.fromEntries((sessionState.origins || []).flatMap((o) => (o.localStorage || []).map((e) => [e.name, e.value]))) } }
      : storage;

    // ---- browser session ----
    const sessionStart = Date.now();
    if (pool) {
      const createdBefore = pool.stats().browsersCreated;
      lease = await pool.acquire({ cookies: contextCookies, viewport: policy.viewports[0], storage: contextStorage });
      browser = lease.browser;
      browserMemory.poolReusedBrowser = pool.stats().browsersCreated === createdBefore;
      browserMemory.poolBrowsersCreated = pool.stats().browsersCreated;
    } else {
      browser = await launchBrowser({ headless: true });
    }
    browserMemory.browserRootPid = await getBrowserRootPid(browser).catch(() => null);
    ctx = lease ? lease.context : await newContext(browser, { cookies: contextCookies, viewport: policy.viewports[0], storage: contextStorage });
    if (sessionStorageData && ctx?.addInitScript) {
      // SPA auth token lives in sessionStorage (storageState never carries it) —
      // seed it before the first navigation. Origin-checked so a pooled context
      // reused by a later different-site job cannot leak this site's token.
      await ctx.addInitScript(({ origin, items }) => {
        if (location.origin === origin) {
          try { for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v); } catch {}
        }
      }, sessionStorageData);
      logger.info("auth", "sessionStorage injected into exploration context", { origin: sessionStorageData.origin, keys: Object.keys(sessionStorageData.items || {}).length });
    }
    page = lease ? await lease.newPage() : await ctx.newPage();
    logger.metric("navigationMs", Date.now() - sessionStart);
    logger.info("browser", "browser + context ready", {
      viewport: policy.viewports[0].name,
      mode: browserMemory.mode,
      poolReusedBrowser: browserMemory.poolReusedBrowser,
      poolBrowsersCreated: browserMemory.poolBrowsersCreated,
      rootPid: browserMemory.browserRootPid,
    });
    if (poolEnabled) {
      logger.debug("browser", browserMemory.poolReusedBrowser
        ? `pool REUSE confirmed: job acquired a pre-existing pooled browser (browsersCreated=${browserMemory.poolBrowsersCreated}, rootPid=${browserMemory.browserRootPid})`
        : `pool launched a NEW browser for this job (browsersCreated=${browserMemory.poolBrowsersCreated}, rootPid=${browserMemory.browserRootPid})`);
    }
    page.on("crash", () => { logger.bump("crashes"); errors.push("page crashed during exploration"); });

    // network recorder (spec §11) — attach() registers the page listeners; the
    // returned recorder MUST be attached or every network.json stays empty
    const { attachNetworkRecorder } = await import("../network/network-recorder.js");
    const network = { entries: [] };
    const allNetwork = []; // job-level accumulation for asset capture
    let netCursor = 0;
    attachNetworkRecorder(ctx, network).attach(page);

    // task 3.4.4: WebSocket session capture — attached BEFORE navigation so the
    // initial upgrade is captured; handlers are defensive and never throw
    const wsSink = createWebSocketSink();
    attachWebSocketCapture(page, wsSink);

    // task 3.5.3: application-state sink — reset per page, exported after the
    // page's captures so pages/<pageId>/application-state.json carries only the
    // states observed while exploring THAT page
    const appStateSink = createApplicationStateSink();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
    // SPA hydration gate (heavy SPAs like trader.tradovate.com render shell →
    // "app-initializing" → real DOM minutes later than networkidle): wait until
    // the app's initializing marker class disappears, bounded by
    // CLONER_HYDRATION_WAIT_MS (default 20000; 0 = off).
    const hydrationWaitMs = Number(process.env.CLONER_HYDRATION_WAIT_MS ?? 20000);
    if (hydrationWaitMs > 0) {
      const hydrated = await page
        .waitForFunction(
          () => !document.querySelector(".app-initializing, [class*='app-initializing' i], #app-initializing"),
          { timeout: hydrationWaitMs },
        )
        .then(() => true, () => false);
      if (hydrated) logger.info("browser", "SPA hydration gate passed (app-initializing cleared)", { waitedMs: hydrationWaitMs });
      else logger.debug("browser", "hydration gate: no app-initializing marker or timeout — continuing", { waitedMs: hydrationWaitMs });
      // settled-DOM gate: the marker class clears BEFORE the real DOM mounts
      // (measured on trader.tradovate.com: class gone → topbar still ~4s away).
      // Wait for the app to become interactive: some visible chrome beyond the
      // loading shell (any element whose area > 30% viewport below the shell),
      // then a fixed settle window for late data-driven DOM (charts/quotes).
      const settleMs = Number(process.env.CLONER_SPA_SETTLE_MS ?? 8000);
      await page
        .waitForFunction(
          () => {
            const shell = document.querySelector(".app-initializing, [class*='app-initializing' i]");
            if (shell && document.contains(shell)) return false;
            const els = document.body ? document.body.querySelectorAll("*") : [];
            let visible = 0;
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width > 40 && r.height > 12 && r.top >= 0 && r.top < innerHeight && el.children.length === 0 && (el.textContent || "").trim()) visible++;
              if (visible >= 8) return true;
            }
            return false;
          },
          { timeout: settleMs },
        )
        .then(() => logger.info("browser", "SPA settle gate passed (real DOM visible)"), () => {});
      await page.waitForTimeout(Math.min(settleMs, 4000)).catch(() => {});
    }
    logger.debug("browser", "page loaded", { url: page.url() });
    await sampleRss("after seed load");
    const spaScript = spaRecorderScript(policy.routes.maxSpaEvents);
    await page.evaluate(spaScript).catch(() => {});

    // ---- auth detection (spec §6): the login-form probe feeds the manifest.
    // The actual login is the authenticateSession hook ABOVE (it ran before this
    // context was created and its verified storage state was loaded into the
    // context) — never a second inline submit, so a verified session is never
    // re-typed into a live form. ----
    const authInfo = await page.evaluate(() => {
      const pass = document.querySelector('input[type="password"]');
      if (!pass) return { loginRequired: false };
      const userField = document.querySelector('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]');
      return { loginRequired: true, hasUsernameField: !!userField };
    }).catch(() => ({ loginRequired: false }));

    if (authInfo.loginRequired && username && password && authOk) {
      logger.info("auth", "login form still present on the entry page — session already established and verified before exploration (no re-submit)");
    } else if (authInfo.loginRequired && username && password && !authOk) {
      warnings.push("login form present but session establishment failed — exploration limited to public state");
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
    // task 3.5.6: route-page count tracked separately from manifest.pages —
    // in-URL state entries are appended to pages[] (one manifest page per
    // state, exactly like the test proves) but must NOT consume the maxRoutes
    // budget or the page-NNN numbering, which count ROUTES explored
    let routesExplored = 0;
    const exploredPaths = new Set();
    const maxRoutes = policy.budgets.maxRoutes;

    const exploreRoute = async (route, pageId, { navigate }) => {
      logger.setPage(pageId);
      // viewer todo: one per explored route (unit "route") — closed at the end
      // of this function or with an honest failed note if the stage dies
      const todoId = `route:${pageId}`;
      wf.todoAdd(todoId, `explore ${safePathname(route.url) || route.url}`, "route");
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

      // mark triggers BEFORE the DOM extractor so data-cloner-trigger attrs
      // are captured in dom.json and carried through to the generated project
      const { markTriggers } = await import("../interactions.js");
      await markTriggers(page, { max: policy.budgets.maxInteractionsPerState }).catch((e) => logger.warn("markTriggers", e.message.slice(0, 80)));

      // DOM intelligence (spec §9)
      const tDom = Date.now();
      const domIntel = await page.evaluate(DOM_EXTRACTOR_SCRIPT).catch(() => null);
      logger.metric("domExtractionMs", Date.now() - tDom);
      if (domIntel) {
        domIntel.typography = analyzeTypography(domIntel.elements);
        store.writeJson(`pages/${pageId}/dom.json`, { pageId, url: page.url(), total: domIntel.total, sampled: domIntel.sampled, elements: domIntel.elements, repeated: domIntel.repeated, fixed: domIntel.fixed, sticky: domIntel.sticky, typography: domIntel.typography });
        store.writeJson(`pages/${pageId}/geometry.json`, { pageId, containers: domIntel.elements.slice(0, 60).map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, rect: e.rect, layout: e.layout })), fixed: domIntel.fixed, sticky: domIntel.sticky, repeated: domIntel.repeated });
        // bodyStyle/htmlStyle (G4.1): the page-root computed styles the element
        // loop can never capture — the token builder's body rule reads these
        store.writeJson(`pages/${pageId}/styles.json`, { pageId, typography: domIntel.typography, bodyStyle: domIntel.bodyStyle || null, htmlStyle: domIntel.htmlStyle || null, elements: domIntel.elements.map((e) => ({ i: e.i, tag: e.tag, cls: e.cls, style: e.style })) });
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
        // engine emissions are tagged with THIS job id (bus job scope) so the
        // bridge can drop concurrent jobs' traffic even mid-overlap
        records = await withJobScope(id, () => recordInteractions(page, {
          waitMs: 800, max: policy.budgets.maxStatesPerPage, triggerMax: policy.budgets.maxInteractionsPerState,
          budgetMs: Math.max(20000, pageDeadline - Date.now()), outDir: store.dirs.root,
        }));
      } finally { engineActive = false; }

      // network flush AFTER the interactions so interaction traffic is
      // attributed to the page that caused it (spec §11). The full buffer is
      // retained in allNetwork for the asset-capture stage.
      const newEntries = network.entries.slice(netCursor);
      netCursor = network.entries.length;
      allNetwork.push(...newEntries);
      store.writeJson(`pages/${pageId}/network.json`, { pageId, url: page.url(), entries: redact(newEntries) });

      // task 3.4.4: sanitized WebSocket session fixture for THIS page, then reset
      // the sink so each page's websocket.json carries only the frames observed
      // while exploring it (the replayer pairs page widgets with page captures)
      store.writeJson(`pages/${pageId}/websocket.json`, exportWebSocketSink(wsSink));
      wsSink.events = [];
      wsSink.sockets = 0;
      wsSink.dropped = 0;
      wsSink.startedAt = null;

      // task 3.5.3: application-state fixture for THIS page, then reset the sink
      store.writeJson(`pages/${pageId}/application-state.json`, exportApplicationState(appStateSink));
      appStateSink.events = [];
      appStateSink.dropped = 0;

      // harvest THIS page's SPA transitions before navigating away — the
      // recorder buffer is per-document and resets on every navigation (spec §7A)
      await discovery.fromSpaEvents(maxRoutes);

      // task 3.5.3: one application-state observation for THIS page — after all
      // interactions (so controls carry their post-interaction values) but
      // before navigation away. Never throws (honest { error } event on probe
      // failure); the artifact always exists via exportApplicationState.
      const appState = await attachApplicationStateCapture(page, appStateSink, { phase: "route", label: pageId });
      if (appState) logger.debug("app-state", `captured ${appState.probe ? "probe + " : ""}${Object.keys(appState.storage || {}).filter((ns) => Object.keys(appState.storage[ns] || {}).length).length} storage ns`, { url: page.url() });

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
        // status "in-url": these are same-URL view captures keyed url#state —
        // the exact shape state-graph-core's walker labels "in-url" and the
        // consumers count (verify-visual3's in-URL evidence branch filters
        // status === "in-url"; the gates count the same nodes). The old
        // "recorded" label was read by nothing, so 13 documented url#state
        // states surfaced as IN-URL-STATES=0 and the completeness gate failed
        // its "0 documented behaviors" check despite on-disk dom evidence.
        const st = graph.addState({ url: page.url() + "#" + (rec.text || rec.id), domSig: domSig + ":" + rec.id, parentStateId: rootNode.node.id, interaction: rec.text || rec.id, screenshotRef, domRef, status: "in-url" });
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
      discovery.markExplored(page.url()); // task 3.5.5: keep the dedup index in sync for planNavigations()
      pages.push({ pageId, url: page.url(), route, records: records.length, domSampled: domIntel ? domIntel.sampled : 0 });
      routesExplored++; // the ROUTE page counts toward maxRoutes; the in-URL state entries below do not
      // task 3.5.6: in-URL state depth — the proven SPA walker now runs in the
      // product pipeline (QA wiring): after interaction recording, walk the
      // page's visible in-app nav/tab controls and record every same-URL DOM
      // change as an url#state node + pages/<pageId>-state-NN/ evidence, wired
      // exactly like scripts/test-spa-depth.mjs proves (the reconstruction
      // emits one page per manifest.pages entry, no changes needed there).
      // Guarded by the policy risk rules (DANGEROUS text/containers), capped by
      // budgets.maxInUrlStates AND the remaining page budget; a candidate that
      // navigates is restored and left to route-discovery.
      const pageEntry = pages[pages.length - 1];
      const walkBudgetMs = Math.min(pageDeadline - Date.now(), 60000);
      if (process.env.CLONER_DISABLE_INURL_WALK === "1") {
        // operational kill-switch (same idiom as CLONER_BROWSER_POOL): skips the
        // walker without a code change — QA can isolate walker-caused deltas
        logger.debug("state-depth", `page ${pageId}: CLONER_DISABLE_INURL_WALK=1 — in-URL walk skipped`);
      } else if (walkBudgetMs < 3000) {
        logger.debug("state-depth", `page ${pageId}: page budget exhausted — in-URL walk skipped`);
      } else {
        try {
          const depth = await enumerateInAppStates(page, {
            graph,
            parentNode: rootNode.node,
            policy,
            captureState: async ({ page: p, index }) => captureInAppStateArtifacts(store, p, statePageId(pageId, index), pageEntry.url),
            logger,
            budgetMs: walkBudgetMs,
          });
          // walk-period network traffic belongs to the page whose controls
          // caused it (spec §11 attribution) — extend the parent page's ledger
          // (redact is idempotent, so already-redacted entries survive the merge)
          const walkNet = network.entries.slice(netCursor);
          netCursor = network.entries.length;
          if (walkNet.length) {
            store.writeJson(`pages/${pageId}/network.json`, { pageId, url: pageEntry.url, entries: redact([...newEntries, ...walkNet]) });
          }
          if (depth.recorded > 0) {
            pages.push(...statePageEntries(pageEntry, depth.states));
            logger.info("state-depth", `${depth.recorded} in-URL state(s) recorded on ${pageId}`, { candidates: depth.candidates, unsafeSkipped: depth.skipped.unsafe, urlChanged: depth.skipped["url-changed"] });
          } else {
            logger.debug("state-depth", `page ${pageId}: no in-URL state (candidates=${depth.candidates}, ledger ${JSON.stringify(depth.skipped)})`);
          }
        } catch (e) {
          // fail-soft: the walker never kills the route's exploration
          warnings.push(`in-URL state walk failed on ${pageId}: ` + String(e?.message || e).slice(0, 100));
        }
      }
      logger.debug("explore", `page ${pageId} done`, { records: records.length, domSampled: domIntel ? domIntel.sampled : 0 });
      // viewer: the route todo closes and the page lands as a labeled build unit
      wf.todoDone(todoId);
      wf.agent(pageId, "page");
      wf.stage("exploration", "running", Math.min(routesExplored / Math.max(plannedRoutes.length, routesExplored), 1));
      await sampleRss(`after page capture ${pageId}`);
    };

    // exploration set is fixed when the loop starts (bounded budget); SPA routes
    // discovered while exploring are harvested per page below and picked up by
    // the second pass if they are genuinely new documents
    // exploration set: planNavigations (task 3.5.5) — score-ordered (seed pinned,
    // query-variant duplicates skipped pre-navigation) and capped. Completeness
    // mode (policy.routes.prioritize:false) returns the raw discovered order —
    // identical to the pre-3.5.5 `discovery.routes.slice(0, maxRoutes)` behavior.
    const plannedRoutes = discovery.planNavigations({ max: maxRoutes, explored: [...exploredPaths].map((pn) => pn) });
    for (let pi = 0; pi < plannedRoutes.length && routesExplored < maxRoutes; pi++) {
      if (Date.now() > deadline) { warnings.push("total exploration time budget exhausted — remaining routes skipped"); break; }
      await exploreRoute(plannedRoutes[pi], "page-" + String(routesExplored + 1).padStart(3, "0"), { navigate: pi > 0 });
    }
    // second pass: SPA routes found during the loop are recorded for every page;
    // ones with a pathname never explored (real new documents, not query/hash
    // state variants of an already-explored page) are explored while budget remains
    for (const route of [...discovery.routes]) {
      if (routesExplored >= maxRoutes || Date.now() > deadline) break;
      const pn = safePathname(route.url);
      if (!pn || exploredPaths.has(pn)) continue;
      if (plannedRoutes.some((r) => r.url === route.url)) continue;
      exploredPaths.add(pn);
      await exploreRoute(route, "page-" + String(routesExplored + 1).padStart(3, "0"), { navigate: true });
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
      if (assetCapture.count) logger.debug("assets", `captured ${assetCapture.count} resource(s), ${(assetCapture.bytes / 1024).toFixed(0)}KB`); // count lives in the stage summary
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
      coverage: { routesExplored: routesExplored, routesDiscovered: discovery.routes.length, statesRecorded: graphData.stats.nodes },
      errors: errors.map((e) => ({ message: String(e).slice(0, 200) })),
      warnings: warnings.map((w) => ({ message: String(w).slice(0, 200) })),
      auth: { loginRequired: authInfo.loginRequired, credentialsUsed: !!(username && password), status: authStatus, reason: authReason, indicators: authIndicators, sessionStateRef: sessionState ? "auth/session.json" : null },
      metrics: logger.metrics(),
      browserMemory: { ...browserMemory },
    });
    store.writeManifest(manifest);
    // exploration.json — the completeness contract verify.js checks (the v1
    // interaction explorer only wrote it when behaviors were recorded; the v2
    // pipeline always writes a summary so verified-authed jobs never fail
    // "exploration + replay data complete" on an honest empty-interaction site)
    store.writeJson("exploration.json", {
      generatedAt: new Date().toISOString(),
      jobId: id,
      status: manifest.status,
      coverage: manifest.coverage,
      // v1 contract (src/interactions.js:855): behaviors is an ARRAY —
      // reconstruction iterates it. v2 records live in transitions/records.
      statesDir: "_reference/states",
      behaviors: [],
      source: "v2-exploration-summary",
    });
    store.writeJson("reports/exploration-summary.json", redact({
      jobId: id, status: manifest.status, pages: routesExplored, routes: discovery.routes.length,
      states: graphData.stats.nodes, interactions: graphData.stats.edges, errors, warnings,
    }));
    store.writeJson("reports/coverage-report.json", {
      routesDiscovered: discovery.routes.length,
      routesExplored: routesExplored,
      coveragePct: discovery.routes.length ? Math.round((routesExplored / discovery.routes.length) * 100) : 100,
      statesRecorded: graphData.stats.nodes,
      budget: policy.budgets,
      // task 3.5.5 step 8: exploration efficiency counters (redundant routes,
      // duplicates skipped pre-navigation, saved navigations, planner totals)
      efficiency: { routes: discovery.stats(), states: graph.stats() },
    });
    store.writeJson("reports/failures.json", redact({
      errors, warnings,
      failedInteractions: logger.metrics().failedInteractions,
      crashes: logger.metrics().crashes,
      timeouts: logger.metrics().timeouts,
    }));

    // log contract: THE one summary line for the exploration stage (status +
    // key numbers; the per-stage exactly-once guarantee lives in logger.stage)
    logger.stage("exploration", manifest.status, {
      routes: discovery.routes.length, pages: routesExplored,
      states: graphData.stats.nodes, interactions: graphData.stats.edges,
      assets: assetManifest.total + assetCapture.count,
      warnings: warnings.length, errors: errors.length,
    });
    wf.stage("exploration", manifest.status, 1); // viewer: stage boundary reached
    // G5.4: freeze the byte-level integrity manifest AFTER the last artifact
    // write — export later refuses to ship a tree that no longer matches it.
    try {
      const { writeIntegrityManifest } = await import("../storage/artifact-lifecycle.js");
      writeIntegrityManifest(store.dirs.root);
    } catch (e) {
      logger.warn?.("pipeline", `integrity manifest not written: ${String(e?.message || e).slice(0, 120)}`);
    }
    return { jobId: id, artifactsDir: store.dirs.root, manifest };
  } catch (e) {
    logger.error("pipeline", `exploration job failed: ${String(e?.message || e).slice(0, 200)}`);
    // log contract: the stage still gets its ONE summary line, with the honest
    // failed status (thrown error itself is not in errors[], hence +1)
    logger.stage("exploration", "failed", { warnings: warnings.length, errors: errors.length + 1 });
    wf.stage("exploration", "failed");
    wf.closeOpenTodos("exploration stage failed"); // every open route todo gets an ok:false done
    throw e;
  } finally {
    // always: detach this job's bus listeners + release the browser. Pool mode:
    // page.close() then the DIRTY lease release — the per-job context is closed
    // (never reused across jobs) while the browser itself stays warm in the pool
    // for the next job. Legacy mode (CLONER_BROWSER_POOL=0): close the browser.
    bus.off("step", onStep);
    bus.off("log", onLog);
    if (lease) {
      if (page) await page.close().catch(() => {});
      await lease.release({ dirty: true }).catch(() => {});
    } else if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
