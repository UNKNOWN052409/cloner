// G4.2 SELF-REVERSE — app-like targets through the FULL pipeline.
//
// "Self-reverse" here means the cloner reverses its OWN app-class fixtures
// (scripts/fixtures/workspace-dock.mjs and scripts/fixtures/tradovate/server.mjs
// — deterministic, credential-free, 127.0.0.1-only) end to end, then proves the
// CLONE is a working app, not a screenshot:
//
//   1. EXPLORATION    — runExplorationJob with a real headless browser against
//                       the fixture server (auth-free app targets).
//   2. RECONSTRUCTION — reconstructFromArtifacts → editable project tree with
//                       the workspace (docking) runtime, tab groups, splitters,
//                       data-stream replay plan and interaction records wired.
//   3. INTERACTION REPLAY — a human-journey pass on the CLONE over a local HTTP
//                       server: real mouse drags on splitters, tab clicks,
//                       close/reopen, collapse, recorded overlay triggers, and
//                       data-stream widgets updating (zero-network replay of the
//                       captured timeline, per-key value fidelity).
//   4. 3-STEP VERIFICATION — src/reconstruction/verify.js (functional /
//                       optimization-completeness / visual) must PASS on the
//                       artifacts, repair loop included.
//
// No mocks in any product path: exploration hits the live fixture over HTTP/WS,
// reconstruction reads the real captured artifacts, verification drives a real
// browser. The fixtures are the project's own test doubles standing in for a
// third-party app — the permitted "remote-end simulator".
//
// Usage:  node scripts/self-reverse-app.mjs [--fixture=dock|tradovate|both]
// Result: artifacts/self-reverse-app-result.json
// Exit:   0 all checks passed · 1 at least one check failed
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import http from "node:http";

// Fixture-testing opt-in (src/security/url-guard.js:6,93): this script's
// targets are the project's own 127.0.0.1 fixtures. Same sanctioned opt-in
// every other fixture script uses (test-ui-onboarding.mjs, qa-probe-isolation.mjs…).
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

import { chromium } from "playwright";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";
import { verifyTask } from "../src/reconstruction/verify.js";
import { flattenNumericStructure } from "../src/exploration/websocket-session-capture.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { workspaceDockSite } from "./fixtures/workspace-dock.mjs";
import { startTradovateFixtureServer, quoteMap, POLLING_TOTAL } from "./fixtures/tradovate/server.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const RESULT_PATH = path.join(ROOT, "artifacts", "self-reverse-app-result.json");

// ---------------------------------------------------------------- harness --
const result = {
  task: "G4.2 self-reverse-app",
  generatedAt: new Date().toISOString(),
  node: process.version,
  fixtures: {},
  pass: 0,
  fail: 0,
  failures: [],
  allPassed: false,
};
let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : "")); console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const approx = (a, b, tol) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

// serve a static clone dir over 127.0.0.1 — a real HTTP load, not file://
async function serveCloneDir(cloneDir) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".mhtml": "message/rfc822", ".json": "application/json" };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    const fp = path.join(cloneDir, rel);
    if (!fp.startsWith(cloneDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

async function launch() {
  return chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
}

// minW the reconstructed workspace runtime actually runs with (parsed from the
// generated runtime — the assertion target, not a hard-coded guess)
function runtimeMinW(cloneDir) {
  try {
    const js = fs.readFileSync(path.join(cloneDir, "runtime", "interactions.js"), "utf8");
    return Number((js.match(/minW:\s*(\d+)/) || [])[1]) || 120;
  } catch { return 120; }
}

// workspace attribute stamps in the generated clone HTML (evidence of docking)
function wsStampCounts(cloneDir) {
  const html = fs.readFileSync(path.join(cloneDir, "index.html"), "utf8");
  const count = (a) => (html.match(new RegExp(`data-ws-${a}="`, "g")) || []).length;
  return {
    html,
    counts: { root: count("root"), pane: count("pane"), splitter: count("splitter"), tab: count("tab"), panel: count("panel"), close: count("close"), collapse: count("collapse") },
  };
}

// load the clone with network-call counters + a DOM mutation log on stream cells
async function openCloneWithInstrumentation(cloneBase, { shortWait = false } = {}) {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__NET_CALLS = { fetch: 0, xhr: 0, ws: 0, beacon: 0 };
    window.__MUT_LOG = [];
    const OF = window.fetch;
    window.fetch = function (u, p) { window.__NET_CALLS.fetch++; return OF.call(this, u, p); };
    const OX = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { window.__NET_CALLS.xhr++; return OX.apply(this, arguments); };
    const OW = window.WebSocket;
    window.WebSocket = function (u, p) { window.__NET_CALLS.ws++; return p === undefined ? new OW(u) : new OW(u, p); };
    window.WebSocket.prototype = OW.prototype;
    if (navigator.sendBeacon) { const OB = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, d) => { window.__NET_CALLS.beacon++; return OB(u, d); }; }
    let armed = false;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target;
        if (el && el.matches && el.matches("[data-stream-target]")) {
          window.__MUT_LOG.push({ t: Date.now(), key: el.getAttribute("data-stream-target"), text: String(el.textContent) });
        }
      }
    });
    const arm = () => { if (armed || !document.documentElement) return; armed = true; mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); };
    document.addEventListener("readystatechange", arm);
    setTimeout(arm, 0);
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
  await page.goto(cloneBase + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__CLONER_STREAMS_DONE === true, null, { timeout: shortWait ? 4000 : 25000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { browser, ctx, page, pageErrors };
}

// captured per-key final value from the sanitized websocket.json (numbers only)
function capturedTimeline(wsFixture) {
  const events = (wsFixture.events || []).filter((e) => e.kind === "frame" && e.direction === "in" && e.payloadStructure);
  const byKey = new Map();
  const msgs = [];
  for (const e of events) {
    const data = flattenNumericStructure(e.payloadStructure);
    if (!Object.keys(data).length) continue;
    msgs.push({ t: e.t, data });
    for (const [k, v] of Object.entries(data)) byKey.set(k, v);
  }
  return { byKey, msgs };
}

const shown = (page, sel) => page.$eval(sel, (el) => {
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
}).catch(() => false);
const widthOf = (page, sel) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().width)).catch(() => -1);
async function dragSplitter(page, nth, dx) {
  const box = await page.locator("[data-ws-splitter]").nth(nth).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(180);
}

// summarize the 3-step verification report into a result sub-object
function verificationSummary(verification) {
  const stages = (verification.stages || []).map((s) => ({
    stage: s.stage,
    passed: s.passed === true,
    failedChecks: (s.checks || []).filter((c) => !c.ok).map((c) => `${c.name}: ${String(c.detail || "").slice(0, 180)}`),
  }));
  return {
    passed: verification.passed === true,
    rounds: (verification.rounds || []).length,
    stages,
    repairLoop: verification.repairLoop
      ? { stopped: verification.repairLoop.stopped, improved: verification.repairLoop.improved, applied: verification.repairLoop.applied, reverted: verification.repairLoop.reverted }
      : null,
  };
}

// ============================================================================
// FULL PIPELINE for one fixture + all clone-side assertions
// ============================================================================
async function selfReverseFixture(spec) {
  const out = { name: spec.name, jobId: spec.jobId };
  const artifactsDir = path.join(ROOT, "artifacts", spec.jobId);
  const cloneDir = artifactsDir + "-project";
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(cloneDir, { recursive: true, force: true });

  // ---- 1. exploration (real browser against the live fixture) -------------
  section(`${spec.name}: exploration (full pipeline, real browser)`);
  const fx = await spec.startServer();
  try {
    const job = await runExplorationJob({
      url: fx.base + spec.entry,
      artifactsRoot: path.join(ROOT, "artifacts"),
      jobId: spec.jobId,
      config: { policy: { budgets: spec.budgets } },
    });
    out.artifactsDir = path.relative(ROOT, job.artifactsDir);
    out.manifestStatus = job.manifest.status;
    out.routes = job.manifest.pages.map((p) => { try { return new URL(p.url).pathname; } catch { return p.url; } });
    check(`${spec.name}: exploration completed`, job.manifest.status === "completed", job.manifest.status);
    check(`${spec.name}: route set as expected`, JSON.stringify(out.routes) === JSON.stringify(spec.expectedRoutes), (out.routes || []).join(", ") || "none");
  } finally {
    await fx.close();
  }

  // ---- 2. reconstruction ---------------------------------------------------
  section(`${spec.name}: reconstruction`);
  const rec = await reconstructFromArtifacts(artifactsDir, { outDir: cloneDir });
  out.reconstructionOk = rec.ok === true;
  check(`${spec.name}: reconstruction ok`, rec.ok === true, `rounds=${(rec.report.rounds || []).length}`);
  out.workspaceRoot = rec.report.workspace ? rec.report.workspace.root : null;
  out.streamsPlan = rec.report.streams || null;

  const ws = wsStampCounts(cloneDir);
  out.wsStamps = ws.counts;
  check(`${spec.name}: docking runtime stamped into the clone (root/splitters/tabs/panels)`,
    ws.counts.root >= 1 && ws.counts.splitter >= 2 && ws.counts.tab >= 2 && ws.counts.panel >= 2 && ws.counts.pane >= 3,
    JSON.stringify(ws.counts));
  check(`${spec.name}: styles/workspace.css emitted`, fs.existsSync(path.join(cloneDir, "styles", "workspace.css")), "styles/workspace.css");
  check(`${spec.name}: workspace runtime embedded in runtime/interactions.js`,
    /__CLONER_WORKSPACE_RUNTIME__/.test(fs.readFileSync(path.join(cloneDir, "runtime", "interactions.js"), "utf8")), "runtime mark");
  out.runtimeMinW = runtimeMinW(cloneDir);

  // one clone server for the whole fixture run (journey + streams)
  const cloneSrv = await serveCloneDir(cloneDir);

  // ---- 3. interaction replay — the recorded controls work IN THE CLONE ----
  section(`${spec.name}: interaction replay on the clone (1440x900, real mouse)`);
  let journeyErrors = [];
  try {
    const browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => journeyErrors.push(String(e.message).slice(0, 160)));
    await page.goto(cloneSrv.base + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(400);

    // 3a. docking structure as a human sees it: visible panes at captured sizes
    const panes = await page.$$eval("[data-ws-pane]", (els) => els.map((el) => ({
      i: el.getAttribute("data-ws-i"),
      w: Math.round(el.getBoundingClientRect().width),
      visible: getComputedStyle(el).display !== "none",
    })));
    const paneWidths = panes.map((p) => p.w);
    const paneId = (n) => `[data-ws-pane][data-ws-i="${panes[n].i}"]`;
    out.paneWidths = paneWidths;
    check(`${spec.name}: ≥3 dock panes visible`, panes.length >= 3 && panes.every((p) => p.visible && p.w > 0),
      panes.map((p) => `${p.i}:${p.w}px`).join("/"));
    (spec.expectedPaneWidths || []).forEach((want, n) => {
      check(`${spec.name}: initial pane ${n} width ≈ captured ${want}px`, approx(paneWidths[n], want, 12), `${paneWidths[n]}px`);
    });

    // 3b. tabs — click through; the mapped panel becomes visible, marker moves
    const tabCount = await page.$$eval("[data-ws-tab]", (els) => els.length);
    check(`${spec.name}: tab strip present (≥2 tabs)`, tabCount >= 2, `${tabCount} tabs`);
    if (tabCount >= 2 && spec.tabTexts) {
      const labels = await page.$$eval("[data-ws-tab]", (els) => els.map((e) => (e.textContent || "").trim()));
      const ok = spec.tabTexts.every((t, i) => labels[i] && labels[i].toLowerCase().includes(t.toLowerCase()));
      check(`${spec.name}: captured tab labels preserved (${spec.tabTexts.join("|")})`, ok, labels.join(" | "));
      out.tabLabels = labels;
    }
    const panelVis = () => page.$$eval("[data-ws-panel]", (els) => els.map((e) => {
      const cs = getComputedStyle(e);
      return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
    }));
    const v0 = await panelVis();
    check(`${spec.name}: captured-active panel shown first, others hidden`, v0[0] === true && v0.slice(1).every((x) => x === false), `visible=${v0.join(",")}`);
    await page.locator('[data-ws-tab][data-ws-tab-index="1"]').click();
    await page.waitForTimeout(250);
    const v1 = await panelVis();
    check(`${spec.name}: tab switch → second panel visible, first hidden`, v1[1] === true && v1[0] === false, `visible=${v1.join(",")}`);
    if (spec.secondPanelText) {
      const txt = await page.$eval('[data-ws-panel-index="1"]', (e) => (e.textContent || "")).catch(() => "");
      check(`${spec.name}: second panel content actually rendered`, spec.secondPanelText.test(txt), `${txt.length} chars, matched /${spec.secondPanelText.source}/`);
    }
    const activeAfter = await page.$eval('[data-ws-tab][data-ws-tab-index="1"]', (e) => e.getAttribute("data-ws-active") === "1").catch(() => false);
    check(`${spec.name}: active marker moved to the clicked tab`, activeAfter === true, "data-ws-active=1");
    await page.locator('[data-ws-tab][data-ws-tab-index="0"]').click();
    await page.waitForTimeout(250);
    const vBack = await panelVis();
    check(`${spec.name}: switching back restores the first panel`, vBack[0] === true && vBack[1] === false, `visible=${vBack.join(",")}`);

    // 3c. splitter drag — real mouse drag resizes the adjacent pane pair
    const wBefore = { a: await widthOf(page, paneId(0)), b: await widthOf(page, paneId(1)), c: await widthOf(page, paneId(2)) };
    await dragSplitter(page, 0, 100);
    const wAfter = { a: await widthOf(page, paneId(0)), b: await widthOf(page, paneId(1)), c: await widthOf(page, paneId(2)) };
    check(`${spec.name}: splitter 1 drag → left pane grows ~100px`, wAfter.a - wBefore.a >= 80, `${wBefore.a}→${wAfter.a}`);
    check(`${spec.name}: splitter 1 drag → center pane shrinks correspondingly`, wBefore.b - wAfter.b >= 80, `${wBefore.b}→${wAfter.b}`);
    check(`${spec.name}: splitter 1 drag → right pane unaffected`, Math.abs(wAfter.c - wBefore.c) <= 4, `${wBefore.c}→${wAfter.c}`);
    const minW = out.runtimeMinW;
    await dragSplitter(page, 0, -900);
    const wClamped = await widthOf(page, paneId(0));
    check(`${spec.name}: min-size clamp holds at runtime minW=${minW}px`, approx(wClamped, minW, 10), `dragged past min → ${wClamped}px`);
    const centerAfterClamp = await widthOf(page, paneId(1));
    check(`${spec.name}: clamped drag keeps the pair total (no dead space)`, approx(wBefore.a + wBefore.b, wClamped + centerAfterClamp, 14), `${wClamped}+${centerAfterClamp}`);
    const splitterCount = await page.$$eval("[data-ws-splitter]", (els) => els.length);
    if (splitterCount >= 2) {
      const c0 = await widthOf(page, paneId(1)), r0 = await widthOf(page, paneId(2));
      await dragSplitter(page, 1, -90);
      const c1 = await widthOf(page, paneId(1)), r1 = await widthOf(page, paneId(2));
      check(`${spec.name}: splitter 2 drag → right grows, center shrinks`, r1 - r0 >= 60 && c0 - c1 >= 60, `center ${c0}→${c1}, right ${r0}→${r1}`);
    } else {
      check(`${spec.name}: second splitter present for drag test`, false, `only ${splitterCount} splitter(s)`);
    }
    out.drag = { before: wBefore, after: wAfter, clamped: wClamped, minW };

    // 3d. close ✕ → pane hides, reopen affordance restores it at its pre-close size
    const closeCount = await page.$$eval("[data-ws-close]", (els) => els.length);
    check(`${spec.name}: close ✕ controls present (≥1)`, closeCount >= 1, `${closeCount} close control(s)`);
    const wPreClose = await widthOf(page, paneId(2)); // baseline BEFORE the close
    const closed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("[data-ws-close]")];
      const btn = btns[btns.length - 1]; // right-most close (matches exploration's ✕)
      const pane = btn.closest("[data-ws-pane]");
      const key = pane ? pane.getAttribute("data-ws-i") : null;
      btn.click();
      return { key, hidden: pane ? getComputedStyle(pane).display === "none" : false };
    });
    check(`${spec.name}: ✕ closes the pane`, closed.key !== null && closed.hidden === true, `pane ${closed.key} display=none`);
    const reopenSel = `[data-cloner-reopen="${closed.key}"]`;
    const hasReopen = (await page.$(reopenSel)) !== null;
    check(`${spec.name}: reopen affordance appears for the closed pane`, hasReopen, reopenSel);
    if (hasReopen) {
      await page.click(reopenSel);
      await page.waitForTimeout(200);
      const wRe = await widthOf(page, paneId(2));
      check(`${spec.name}: reopen restores the pane (size kept)`,
        (await shown(page, paneId(2))) === true && wRe > 100 && approx(wRe, wPreClose, 14), `${wPreClose}→${wRe}px`);
    }

    // 3e. collapse ↔ restore (left pane rail)
    if ((await page.$("[data-ws-collapse]")) !== null) {
      const preW = await widthOf(page, paneId(0));
      await page.click("[data-ws-collapse]");
      await page.waitForTimeout(200);
      const railW = await widthOf(page, paneId(0));
      check(`${spec.name}: collapse shrinks the pane to the rail (≤40px)`, railW > 0 && railW <= 40, `${preW}→${railW}px`);
      await page.click("[data-ws-collapse]");
      await page.waitForTimeout(200);
      const postW = await widthOf(page, paneId(0));
      check(`${spec.name}: uncollapse restores the pane width`, approx(postW, preW, 12), `${railW}→${postW}px`);
    } else {
      check(`${spec.name}: collapse control present`, false, "no [data-ws-collapse] in clone");
    }

    // 3f. dock state survives a reload (persisted workspace state)
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(400);
    const reloadW = await widthOf(page, paneId(0));
    check(`${spec.name}: reload preserves the resized pane state`, approx(reloadW, minW, 10), `${reloadW}px after reload (was clamped to ${minW})`);
    await ctx.close();
    await browser.close().catch(() => {});
  } finally {
    // cloneSrv intentionally stays open for the streams pass below
  }

  // 3g. recorded overlay interactions replay in the clone
  if (spec.expectReplayTrigger) {
    section(`${spec.name}: recorded interaction replay (exploration records → clone)`);
    const { browser, page, pageErrors } = await openCloneWithInstrumentation(cloneSrv.base, { shortWait: true });
    try {
      const replayIds = await page.$$eval("[data-replay-id]", (els) => els.map((e) => e.getAttribute("data-replay-id"))).catch(() => []);
      out.replayTriggers = replayIds;
      check(`${spec.name}: recorded interaction wired for replay (data-replay-id)`, replayIds.length >= 1, replayIds.join(",") || "none");
      if (replayIds.length) {
        await page.locator(`[data-replay-id="${replayIds[0]}"]`).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
        const overlayUp = await page.evaluate(() => {
          const ov = document.querySelector("[data-cloner-overlay]");
          return !!ov && (ov.textContent || "").length > 40;
        });
        check(`${spec.name}: recorded control replays — overlay opens with content`, overlayUp === true, `trigger ${replayIds[0]}`);
      }
      check(`${spec.name}: no page errors during replay`, pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "clean");
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // 3h. data-stream widgets update in the clone (zero-network replay)
  {
    section(`${spec.name}: data-stream widgets`);
    let wsFixture = null, captured = null;
    if (spec.streamsMode === "fidelity") {
      wsFixture = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "websocket.json"), "utf8"));
      captured = capturedTimeline(wsFixture);
      check(`${spec.name}: websocket session captured (≥1 channel, numeric frames)`,
        wsFixture.channelCount >= 1 && (wsFixture.events || []).some((e) => e.kind === "frame"),
        `${wsFixture.channelCount} channel(s), ${captured.msgs.length} numeric frame(s)`);
      check(`${spec.name}: captured timeline matches the fixture's deterministic math`,
        captured.byKey.get("quotes.MES.price") === quoteMap(POLLING_TOTAL).MES.price,
        `final MES ${captured.byKey.get("quotes.MES.price")} === quoteMap(${POLLING_TOTAL}).MES.price`);
    }
    const { browser, page, pageErrors } = await openCloneWithInstrumentation(cloneSrv.base, { shortWait: spec.streamsMode !== "fidelity" });
    try {
      const net = await page.evaluate(() => window.__NET_CALLS);
      check(`${spec.name}: stream replay makes ZERO network calls`, net.fetch === 0 && net.xhr === 0 && net.ws === 0 && net.beacon === 0, JSON.stringify(net));
      const targets = await page.$$eval("[data-stream-target]", (els) => els.map((el) => ({ key: el.getAttribute("data-stream-target"), text: el.textContent.trim() }))).catch(() => []);
      out.streamBindings = targets.length;
      if (spec.streamsMode === "fidelity") {
        check(`${spec.name}: live-data widgets wired in the clone`, targets.length >= 8, `${targets.length} data-stream-target binding(s)`);
        let checked = 0;
        const mismatches = [];
        for (const t of targets) {
          const want = captured.byKey.get(String(t.key).split(".").slice(1).join("."));
          if (typeof want !== "number") continue;
          checked++;
          const got = Number(String(t.text).replace(/[+,%\s]/g, ""));
          if (!(Math.abs(got - want) < 1e-6)) mismatches.push(`${t.key}: rendered "${t.text}" ≠ captured ${want}`);
        }
        check(`${spec.name}: every bound cell shows its key's captured final value`, checked >= 8 && mismatches.length === 0,
          `${checked} binding(s) verified${mismatches.length ? " — " + mismatches.slice(0, 4).join("; ") : ""}`);
        const muts = await page.evaluate(() => window.__MUT_LOG);
        check(`${spec.name}: stream cells update LIVE during replay (≥4 DOM mutations)`, muts.length >= 4, `${muts.length} mutation(s) on bound cells`);
        out.streams = { targets: targets.length, verifiedBindings: checked, mutations: muts.length, zeroNetwork: Object.values(net).every((v) => v === 0) };
      } else {
        // the dock fixture has no captured live-data stream: the stream layer
        // must not hallucinate live bindings (a static plan at most), and the
        // page must stay error-free
        check(`${spec.name}: no live bindings fabricated for a page without a captured stream`, targets.length === 0, `${targets.length} data-stream-target(s)`);
      }
      check(`${spec.name}: no page errors with the stream runtime loaded`, pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "clean");
    } finally {
      await browser.close().catch(() => {});
    }
  }

  check(`${spec.name}: no page errors during the docking journey`, journeyErrors.length === 0, journeyErrors.slice(0, 2).join(" | ") || "clean");
  await cloneSrv.close();

  // ---- 4. 3-step verification (functional / optimization / visual) ---------
  section(`${spec.name}: 3-step verification (verifyTask)`);
  const verification = await verifyTask(artifactsDir);
  out.verification = verificationSummary(verification);
  check(`${spec.name}: verification produced the 3-stage report`, out.verification.stages.length === 3,
    out.verification.stages.map((s) => `${s.stage}:${s.passed ? "ok" : "FAIL"}`).join(", "));
  const byStage = Object.fromEntries(out.verification.stages.map((s) => [s.stage, s]));
  check(`${spec.name}: step 1 FUNCTIONAL passed`, byStage.functional?.passed === true, (byStage.functional?.failedChecks || []).join(" | ") || "all checks ok");
  check(`${spec.name}: step 2 OPTIMIZATION-COMPLETENESS passed`, byStage["optimization-completeness"]?.passed === true, (byStage["optimization-completeness"]?.failedChecks || []).join(" | ") || "all checks ok");
  check(`${spec.name}: step 3 VISUAL passed`, byStage.visual?.passed === true, (byStage.visual?.failedChecks || []).join(" | ") || "all checks ok");
  check(`${spec.name}: overall verification passed`, verification.passed === true,
    out.verification.repairLoop ? `repairLoop stopped=${out.verification.repairLoop.stopped} improved=${out.verification.repairLoop.improved}` : `round ${verification.round || 1}`);

  return out;
}

// ============================================================================
// RUN
// ============================================================================
const which = process.argv.find((a) => a.startsWith("--fixture=")) || "--fixture=both";
const mode = which.split("=")[1];
const sel = (m) => mode === "both" || mode === m;

for (const [key, spec] of [
  ["dock", {
    name: "workspace-dock",
    jobId: "self-reverse-dock",
    startServer: () => startFixtureServer(workspaceDockSite),
    entry: "/",
    budgets: { maxRoutes: 1, maxStatesPerPage: 4, maxInteractionsPerState: 8, maxTotalTimeMs: 150000 },
    expectedRoutes: ["/"],
    expectedPaneWidths: [260, 868, 300],
    tabTexts: ["Orders", "Positions"],
    secondPanelText: /Open positions blotter/,
    streamsMode: "inert",
    expectReplayTrigger: false,
  }],
  ["tradovate", {
    name: "tradovate-app",
    jobId: "self-reverse-tradovate",
    startServer: () => startTradovateFixtureServer(),
    entry: "/",
    budgets: { maxRoutes: 3, maxStatesPerPage: 8, maxInteractionsPerState: 12, maxTotalTimeMs: 240000 },
    expectedRoutes: ["/", "/analytics"],
    expectedPaneWidths: [260, 862, 300],
    tabTexts: ["Orders", "Positions"],
    secondPanelText: /position/i,
    streamsMode: "fidelity",
    expectReplayTrigger: true,
  }],
]) {
  if (!sel(key)) continue;
  try {
    result.fixtures[spec.name] = await selfReverseFixture(spec);
  } catch (e) {
    fail++;
    const msg = e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e);
    failures.push(`${spec.name} runner crashed — ${msg}`);
    console.log(`  FAIL ${spec.name} runner crashed — ${msg}`);
  }
}

// ------------------------------------------------------------------ summary
section("SUMMARY");
result.pass = pass;
result.fail = fail;
result.failures = failures;
result.allPassed = fail === 0;
console.log(`\n${pass} passed, ${fail} failed${failures.length ? ":\n  - " + failures.join("\n  - ") : ""}`);
fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
console.log(`result → ${path.relative(ROOT, RESULT_PATH)}`);
process.exitCode = fail === 0 ? 0 : 1;
