#!/usr/bin/env node
// Offline flow-matrix test — asserts the flow-matrix engine (verify-flows.js)
// builds NUMBERED flow cases (F01-H1 …) from recorded evidence and executes them
// for real on a generated clone, reporting a real PASS and a real FAIL with
// evidence.
//
// What it does (fully offline — 127.0.0.1 fixture + file:// clone only):
//   1. serves a 2-page fixture site on 127.0.0.1 (ephemeral port) and fetches
//      both routes — the recorded evidence below is derived from the SERVED html;
//   2. synthesizes the artifacts a v2 exploration run would produce (manifest
//      pages/routes, per-page dom.json clusters, exploration.json behaviors —
//      same shapes as artifacts/*/manifest.json + pages/page-NNN/dom.json);
//   3. generates the clone project (<artifacts>-project/: index.html, about.html,
//      runtime/interactions.js) — the clone faithfully carries the fixture's
//      a11y bug: one button with NO accessible name (no text/aria-label);
//   4. calls the REAL runFlowMatrix(cloneDir, artifactsDir);
//   5. asserts: report file exists with the { flows, bugs } contract; flow ids
//      are F01/F02 zero-padded; case ids match /^F\d{2}-[HEN]\d+$/; a real
//      passing case (F01-H1 happy replay); a real failing a11y case with a bug
//      entry (severity + case + what + evidence whose screenshot exists);
//   6. prints PASS/FAIL counts, exit 1 on any failure.
// No package.json script here — the integrator owns package.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startFixtureServer, sendHtml, solidPng } from "./fixtures/server.mjs";
import { runFlowMatrix } from "../src/reconstruction/verify-flows.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passCount = 0;
let failCount = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) { passCount++; console.log(`  PASS  ${label}`); }
  else { failCount++; failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
}

// ---- 1. the fixture site (two pages; page-001 carries the a11y bug button) ----
const FOCUS_CSS = "button:focus-visible, a:focus-visible { outline: 2px solid #06f; outline-offset: 2px; }";
const homeHtml = `<!doctype html>
<html><head><title>Flow Fixture</title><style>${FOCUS_CSS}</style></head>
<body>
<header><nav><a href="/about">About</a></nav></header>
<main>
  <h1>Fixture home</h1>
  <button data-cloner-trigger="t0" id="open-panel">Open panel</button>
  <button data-cloner-trigger="t1" id="open-settings">Open settings</button>
  <button data-cloner-trigger="t2" id="icon-btn"></button>
  <label for="q">Search</label><input id="q" type="text">
  <img src="/pixel.png" alt="Fixture logo">
</main>
<script src="/runtime.js"></script>
</body></html>`;
const aboutHtml = `<!doctype html>
<html><head><title>About — Flow Fixture</title><style>${FOCUS_CSS}</style></head>
<body>
<header><nav><a href="/">Home</a></nav></header>
<main><h1>About</h1><button data-cloner-trigger="t3" id="load-stats">Load stats</button></main>
<script src="/runtime.js"></script>
</body></html>`;

const site = {
  name: "flow-matrix-fixture",
  handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") return sendHtml(res, homeHtml);
    if (u.pathname === "/about") return sendHtml(res, aboutHtml);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  },
};

// small fetch helper — plain http.get, no browser, proves the fixture is live
function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

// clone page = fixture page with links rewritten to sibling files (the honest
// route→local-file contract link-rewriter.js applies) + the runtime script +
// the img src remapped to the clone's local assets/ (an absolute /pixel.png
// would 404 on file:// and poison every error-sensitive case with a console error)
function cloneHtml(html) {
  return html
    .replace(/href="\/about"/, `href="./about.html"`)
    .replace(/href="\/"/, `href="./index.html"`)
    .replace(`src="/pixel.png"`, `src="assets/pixel.png"`)
    .replace(`<script src="/runtime.js"></script>`, `<script src="runtime/interactions.js"></script>`);
}

// replay records — ids match the fixture's data-cloner-trigger marks; the t0
// panel bakes an inner entry (m1) like the real runtime's overlay records
const RUNTIME_RECORDS = [
  { id: "t0", kind: "overlay", text: "Open panel", html: `<div class='cloner-panel'><h3>Panel</h3><button data-cloner-inner="m1">Inner action</button></div>` },
  { id: "t1", kind: "overlay", text: "Open settings", html: `<div class='cloner-panel'><h3>Settings</h3></div>` },
  { id: "t2", kind: "overlay", text: "", html: `<div class='cloner-panel'><h3>Quick actions</h3></div>` },
  { id: "t3", kind: "overlay", text: "Load stats", html: `<div class='cloner-panel'><h3>Stats</h3><span>42 requests</span></div>` },
  { id: "m1", kind: "module", text: "Inner action", html: `<div class='cloner-module'><p>Inner module content</p></div>` },
];

// minimal replay runtime — the same contract the generated clones use:
// trigger click → overlay/module from the record; inner click → module;
// Escape closes; an inner click with no record is absorbed (no throw)
const RUNTIME_JS = `window.__CLONER_INTERACTIONS = ${JSON.stringify(RUNTIME_RECORDS)};
(function () {
  var DATA = window.__CLONER_INTERACTIONS;
  function open(kind, html) {
    var w = document.createElement("div");
    w.setAttribute("data-cloner-" + kind, "1");
    w.innerHTML = html;
    document.body.appendChild(w);
    return w;
  }
  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-cloner-trigger]") : null;
    if (el) {
      var rec = DATA.find(function (r) { return r.id === el.getAttribute("data-cloner-trigger"); });
      if (rec && rec.kind) open(rec.kind, rec.html || "<div>panel</div>");
      return;
    }
    var inner = e.target.closest ? e.target.closest("[data-cloner-inner]") : null;
    if (inner) {
      var irec = DATA.find(function (r) { return r.id === inner.getAttribute("data-cloner-inner"); });
      if (irec) open(irec.kind || "module", irec.html || "<div>inner</div>");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach(function (n) { n.remove(); });
  });
})();
`;

// ---- recorded evidence shapes — identical to real v2 exploration artifacts ----
function domElement(i, el) {
  return { i, tag: el.tag, role: null, ariaName: el.ariaName ?? null, id: el.id ?? null, dataClonerTrigger: el.trigger ?? null, href: el.href ?? null, cls: el.cls ?? null, text: el.text ?? null, parent: null, children: 0, rect: { x: 0, y: 0, w: 100, h: 30 } };
}
const HOME_DOM_ELEMENTS = [
  domElement(0, { tag: "header", text: "About", cls: "site-header" }),
  domElement(1, { tag: "a", href: "/about", text: "About" }),
  domElement(2, { tag: "h1", text: "Fixture home" }),
  domElement(3, { tag: "button", ariaName: "Open panel", id: "open-panel", trigger: "t0", text: "Open panel" }),
  domElement(4, { tag: "button", ariaName: "Open settings", id: "open-settings", trigger: "t1", text: "Open settings" }),
  domElement(5, { tag: "button", ariaName: "", id: "icon-btn", trigger: "t2", text: "", cls: "icon-btn" }),
  domElement(6, { tag: "input", id: "q", ariaName: "Search" }),
  domElement(7, { tag: "img", ariaName: "Fixture logo", cls: "logo" }),
];
const ABOUT_DOM_ELEMENTS = [
  domElement(0, { tag: "header", text: "Home", cls: "site-header" }),
  domElement(1, { tag: "a", href: "/", text: "Home" }),
  domElement(2, { tag: "h1", text: "About" }),
  domElement(3, { tag: "button", ariaName: "Load stats", id: "load-stats", trigger: "t3", text: "Load stats" }),
];
const BEHAVIORS = [
  { trigger: { id: "t0", label: "Open panel" }, opens: { kind: "overlay", w: 420, h: 180 }, childPanels: [], screenshot: null },
  { trigger: { id: "t1", label: "Open settings" }, opens: { kind: "overlay", w: 360, h: 140 }, childPanels: [], screenshot: null },
  { trigger: { id: "t2", label: "" }, opens: { kind: "overlay", w: 300, h: 120 }, childPanels: [], screenshot: null },
  { trigger: { id: "t3", label: "Load stats" }, opens: { kind: "overlay", w: 380, h: 160 }, childPanels: [], screenshot: null },
];

function writeArtifacts(artifactsDir, base) {
  fs.mkdirSync(path.join(artifactsDir, "pages", "page-001"), { recursive: true });
  fs.mkdirSync(path.join(artifactsDir, "pages", "page-002"), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "manifest.json"), JSON.stringify({
    schemaVersion: "2.0", jobId: "flow-matrix-fixture", status: "completed", originalUrl: base,
    pages: [
      { pageId: "page-001", url: base + "/", route: { url: base + "/", source: "seed" }, records: 3, domSampled: HOME_DOM_ELEMENTS.length },
      { pageId: "page-002", url: base + "/about", route: { url: base + "/about", source: "dom-link" }, records: 1, domSampled: ABOUT_DOM_ELEMENTS.length },
    ],
    coverage: { routesExplored: 2, routesDiscovered: 2, statesRecorded: 4 }, errors: [], warnings: [],
  }, null, 2));
  fs.writeFileSync(path.join(artifactsDir, "pages", "page-001", "dom.json"), JSON.stringify({ pageId: "page-001", url: base + "/", total: HOME_DOM_ELEMENTS.length, sampled: HOME_DOM_ELEMENTS.length, elements: HOME_DOM_ELEMENTS }, null, 2));
  fs.writeFileSync(path.join(artifactsDir, "pages", "page-002", "dom.json"), JSON.stringify({ pageId: "page-002", url: base + "/about", total: ABOUT_DOM_ELEMENTS.length, sampled: ABOUT_DOM_ELEMENTS.length, elements: ABOUT_DOM_ELEMENTS }, null, 2));
  fs.writeFileSync(path.join(artifactsDir, "exploration.json"), JSON.stringify({ generatedAt: new Date().toISOString(), statesDir: "states", behaviors: BEHAVIORS }, null, 2));
}

function writeCloneProject(cloneDir) {
  fs.mkdirSync(path.join(cloneDir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(cloneDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, "index.html"), cloneHtml(homeHtml));
  fs.writeFileSync(path.join(cloneDir, "about.html"), cloneHtml(aboutHtml));
  fs.writeFileSync(path.join(cloneDir, "runtime", "interactions.js"), RUNTIME_JS);
  fs.writeFileSync(path.join(cloneDir, "assets", "pixel.png"), solidPng(9, 105, 201));
}

async function main() {
  const fx = await startFixtureServer(site);
  let artifactsDir = null;
  try {
    console.log(`flow-matrix test — fixture at ${fx.base} (127.0.0.1, offline)\n`);
    // 2. the fixture site is real: both routes serve their triggers
    const home = await fetchText(fx.base + "/");
    const about = await fetchText(fx.base + "/about");
    check("fixture site serves / with recorded triggers", home.status === 200 && home.body.includes(`data-cloner-trigger="t0"`));
    check("fixture site serves /about with recorded triggers", about.status === 200 && about.body.includes(`data-cloner-trigger="t3"`));

    // 3. artifacts + clone project in the OS temp dir (never the repo tree)
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-matrix-fixture-"));
    writeArtifacts(artifactsDir, fx.base);
    const cloneDir = artifactsDir + "-project";
    writeCloneProject(cloneDir);

    // 4. the REAL engine: build + execute the flow matrix on the clone
    const report = await runFlowMatrix(cloneDir, artifactsDir);
    const reportPath = path.join(artifactsDir, "reports", "flow-matrix.json");
    check("flow-matrix.json written to reports/", fs.existsSync(reportPath));
    let matrix = null;
    try { matrix = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch {}
    check("report carries the { flows, bugs } contract", !!matrix && Array.isArray(matrix.flows) && Array.isArray(matrix.bugs));
    if (!matrix) throw new Error("no parseable flow-matrix.json — cannot continue");

    // numbered ids: flows F01/F02 zero-padded sequential; cases F01-H1/E1/N1
    check("flows are numbered F01, F02 (zero-padded, sequential)", matrix.flows.length === 2 && matrix.flows.map((f) => f.id).join(",") === "F01,F02", matrix.flows.map((f) => f.id).join(","));
    const allCases = matrix.flows.flatMap((f) => f.cases);
    check("every case id matches F<nn>-<H|E|N><n>", allCases.length > 0 && allCases.every((c) => /^F\d{2}-[HEN]\d+$/.test(c.id)), allCases.map((c) => c.id).slice(0, 3).join(",") + "…");

    // real passing case: the happy replay of the first recorded interaction
    const h1 = allCases.find((c) => c.id === "F01-H1");
    check("F01-H1 happy replay PASSES with evidence", h1?.result === "pass" && !!h1.evidence.detail, JSON.stringify(h1?.evidence || {}).slice(0, 120));
    const f2h1 = matrix.flows[1].cases.find((c) => c.id === "F02-H1");
    check("F02-H1 happy replay PASSES", f2h1?.result === "pass", f2h1?.evidence?.detail || "");

    // real failing case: the unnamed button (t2) → a11y E-case fail + bug entry
    const a11y = allCases.filter((c) => c.kind === "a11y-name-alt");
    const failingA11y = a11y.find((c) => c.result === "fail");
    check("a11y E-cases generated on both flows", a11y.length === 2, a11y.map((c) => c.id).join(","));
    check("the unnamed button produces a real FAILING a11y case", !!failingA11y && (failingA11y.evidence.offenders?.unnamed || []).some((s) => s.includes("icon-btn")), failingA11y?.evidence?.detail || "no failing a11y case");
    const a11yBug = failingA11y && matrix.bugs.find((b) => b.case === failingA11y.id && b.severity === "medium" && b.what && b.evidence);
    check("bug entry: severity + case + what + evidence for the a11y fail", !!a11yBug, JSON.stringify(matrix.bugs).slice(0, 140));
    const shotRef = a11yBug?.evidence?.screenshotRef;
    check("bug evidence screenshot exists on disk", !!shotRef && fs.existsSync(path.join(artifactsDir, shotRef)), shotRef || "no screenshotRef");

    // edge coverage: the fixed edge list actually appears (where applicable)
    check("F01 carries long-input + back-button + keyboard-focus E-cases", ["long-input", "back-button", "keyboard-focus"].every((k) => matrix.flows[0].cases.some((c) => c.kind === k)), matrix.flows[0].cases.map((c) => c.kind).join(","));
    check("F02 carries a deep-link wrong-state N-case", matrix.flows[1].cases.some((c) => c.kind === "wrong-state-navigation" && c.mode === "deep-link"), matrix.flows[1].cases.map((c) => c.kind + (c.mode ? ":" + c.mode : "")).join(","));
    const focus = matrix.flows[0].cases.find((c) => c.kind === "keyboard-focus");
    check("keyboard-only focus case passes (visible focus ring)", focus?.result === "pass", focus?.evidence?.detail || "");

    // honest totals: a matrix with both real passes and real fails
    const passed = allCases.filter((c) => c.result === "pass").length;
    const failed = allCases.filter((c) => c.result === "fail").length;
    check("matrix contains real passes AND real fails", passed > 0 && failed > 0, `${passed} pass / ${failed} fail`);
    check("report on disk matches the returned object", passed + failed === report.flows.reduce((n, f) => n + f.cases.length, 0));

    console.log(`\nflow matrix: ${matrix.flows.length} flows, ${allCases.length} cases — ${passed} PASS / ${failed} FAIL, ${matrix.bugs.length} bug(s)`);
    for (const f of matrix.flows) console.log(`  ${f.id} (${f.page}): ` + f.cases.map((c) => `${c.id}=${c.result === "pass" ? "ok" : "FAIL"}`).join(" "));
  } finally {
    await fx.close();
    if (artifactsDir && failCount === 0 && !process.env.CLONER_KEEP_FIXTURE) {
      // the clone lives in the SIBLING "-project" dir — remove both
      fs.rmSync(artifactsDir + "-project", { recursive: true, force: true });
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    } else if (artifactsDir) {
      console.log(`\n(temp artifacts kept for debugging: ${artifactsDir})`);
    }
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount) { console.log("failures:\n  - " + failures.join("\n  - ")); process.exit(1); }
}

main().catch((e) => {
  console.error("test crashed:", e?.stack || e);
  process.exit(1);
});

