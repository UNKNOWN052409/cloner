#!/usr/bin/env node
// Platform-UI pages 5-8 tests — OFFLINE ONLY (local express mock on 127.0.0.1 +
// ws WebSocketServer; no external sites, no database, no Redis), mirroring the
// conventions of scripts/test-progress-viewer.mjs.
//
//   A. mock API     — fixture blueprint.json / verification.json /
//                     flow-matrix.json / screenshots served under the REAL
//                     endpoint shapes (GET /api/jobs/:jobId/artifacts/*, …),
//                     swarm-viewer stub at /progress/:jobId, preview stub at
//                     /preview/:id/index.html, honest-404 endpoints (download,
//                     versions, publish) exactly as production answers today.
//   B. playwright   — visits the 4 pages with ?job=<fixture id> and asserts:
//                     blueprint renders scope+regions+ambiguities (+ honest 404
//                     for the approve endpoint on a second job), reconstruction
//                     embeds the swarm iframe + stage pills + /ws log, comparison
//                     renders both screenshots + 3 stage results + flow cases,
//                     final renders preview iframe + download link + limitations.
//                     No JS console errors (network-404 resource logs are the
//                     designed honest states and are counted separately).
//
// Prints PASS/FAIL lines with counts, exits 1 on any failure.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const JOB = "job-ui-pages-1", JOB_404 = "job-ui-pages-2";

// 1×1 PNG (valid minimal image so <img> load events fire)
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const blueprint = {
  version: 1, generatedAt: "2026-11-07T10:00:00.000Z", jobId: JOB,
  source: { url: "https://demo.example/", status: "ok" },
  instructions: { raw: "only clone the pricing page; exclude the blog", applied: true, scope: { include: ["only clone the pricing page"], exclude: ["exclude the blog"], notes: [] } },
  stack: { detected: ["react", "tailwind"], scannedUrls: 3, scannedPages: 2, output: { framework: "react", reason: "recommended from detected stack [react, tailwind]", engineOutput: "static", note: "preference recorded — the current engine emits static HTML/CSS/runtime" } },
  pages: [
    { pageId: "page-001", url: "https://demo.example/", route: "/", evidence: "observed", regions: [{ region: "header", selectorHint: "header.site", evidence: "observed" }, { region: "hero", selectorHint: "h1", evidence: "observed" }], components: ["card ×6"] },
    { pageId: "page-002", url: "https://demo.example/pricing", route: "/pricing", evidence: "inferred", regions: [], components: [] },
  ],
  interactions: { model: "click-driven", evidence: "observed", triggers: 12, stateNodes: 0, scrollHints: 1 },
  ambiguities: ["2 discovered route(s) unexplored — reconstruction covers explored routes only"],
  acceptanceEvidence: ["replay 3 explored route(s)", "replay 12 recorded trigger(s)", "reconstruct 2 page(s) with observed regions"],
  coverage: { routesDiscovered: 5, routesExplored: 3 },
};

const verification = {
  generatedAt: "2026-11-07T10:05:00.000Z", round: 2, layout: "v2", passed: true,
  stages: [
    { stage: "functional", passed: true, checks: [{ name: "clone renders + interactions", ok: true, detail: "9 page(s) rendered" }], metrics: { records: 12 } },
    { stage: "optimization-completeness", passed: true, checks: [{ name: "assets resolve", ok: true, detail: "34/34 files present" }], metrics: { totalFiles: 34, totalMB: 1.2 } },
    { stage: "visual", passed: true, checks: [
      { name: "pixel difference", ok: true, detail: "18.4% (threshold 60%), mean delta 4.1/255, grade: A" },
      { name: "token drift (categories)", ok: true, detail: "color 12/12, font 6/6" },
      { name: "exact HEX comparison", ok: true, detail: "colors 30/31" }] },
  ],
  limitations: ["fonts: 2 recorded families unavailable locally — substituted with metric-compatible fallbacks"],
  flowMatrix: { total: 4, passed: 3, failed: 1, bugs: 1, report: "reports/flow-matrix.json" },
};

const flowMatrix = {
  flows: [
    { id: "F01", page: "index.html", cases: [
      { id: "F01-H1", kind: "happy-replay", trigger: "nav-cta", label: "Open pricing", result: "pass", evidence: {} },
      { id: "F01-E1", kind: "double-click", trigger: "nav-cta", result: "fail", evidence: { error: "panel did not close on second click", screenshotRef: "reports/flow-matrix/F01-E1.png", console: ["console.error: modal twice"] } },
      { id: "F01-E2", kind: "keyboard-focus", result: "pass", evidence: {} }] },
    { id: "F02", page: "pricing.html", cases: [{ id: "F02-N1", kind: "wrong-state-navigation", mode: "deep-link", target: "pricing.html", result: "pass", evidence: {} }] },
  ],
  bugs: [{ severity: "medium", case: "F01-E1", what: "double activation leaves the pricing modal open (panel did not close on second click)", evidence: { screenshotRef: "reports/flow-matrix/F01-E1.png" } }],
};

// ---- mock server: REAL endpoint paths, fixture bodies -----------------------
const approveCalls = [];
const app = express();
app.use(express.json());
app.use("/pages", express.static(path.join(PROJECT, "platform-ui", "pages")));
const png = (_req, res) => res.type("image/png").send(PNG1);
app.get("/api/jobs/:jobId/artifacts/blueprint.json", (_req, res) => res.json(blueprint));
app.get("/api/jobs/:jobId/artifacts/_reference/verification.json", (_req, res) => res.json(verification));
app.get("/api/jobs/:jobId/artifacts/reports/flow-matrix.json", (_req, res) => res.json(flowMatrix));
app.get("/api/jobs/:jobId/artifacts/pages/page-001/screenshot-viewport.png", png);
app.get("/api/jobs/:jobId/artifacts/_reference/clone-verify.png", png);
app.get("/api/jobs/:jobId/artifacts/_reference/diff.png", png);
app.get("/api/jobs/:jobId/artifacts/reports/flow-matrix/F01-E1.png", png);
app.post("/api/jobs/:jobId/blueprint/approve", (req, res) => {
  approveCalls.push({ jobId: req.params.jobId, body: req.body });
  if (req.params.jobId === JOB_404) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, accepted: true });
});
app.get("/api/jobs/:jobId", (_req, res) => res.json({ jobId: JOB, status: "completed", url: "https://demo.example/" }));
app.get("/api/tasks/:id", (_req, res) => res.json({ id: JOB, status: "completed", pipeline: "v2", reconstruction: { passed: true, pages: 9, repairs: 2 }, verification: { passed: true } }));
app.get("/progress/:jobId", (req, res) => res.type("html").send(`<html><head><title>swarm</title></head><body><div id="swarm-viewer-stub">swarm viewer for ${req.params.jobId}</div></body></html>`));
app.get("/preview/:id/index.html", (req, res) => res.type("html").send(`<html><head><title>preview</title></head><body><h1 id="preview-stub">clone preview of ${req.params.id}</h1></body></html>`));
app.get("/api/export/:id/download", (_req, res) => res.status(404).json({ error: "export first" })); // honest production state today
app.get("/api/github/status", (_req, res) => res.json({ configured: false, endpoint: "https://api.github.com" }));
app.post("/api/github/publish/:taskId", (_req, res) => res.status(503).json({ error: "GitHub publish not configured (GITHUB_PUBLISH_TOKEN absent)" }));
app.get("/api/versions", (_req, res) => res.status(404).json({ error: "not found" })); // router exists but is not mounted

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const replay = [
    { type: "workflow.stage", data: { stage: "exploration", status: "completed" }, t: Date.now() - 5000, job: JOB },
    { type: "workflow.todo.add", data: { id: "u1", label: "login page shell", route: "/login" }, t: Date.now() - 4000, job: JOB },
    { type: "workflow.todo.done", data: { id: "u1", agent: "builder" }, t: Date.now() - 3000, job: JOB },
  ];
  ws.send(JSON.stringify({ type: "catchup", data: { meta: null, events: replay } }));
  setTimeout(() => { try { ws.send(JSON.stringify({ type: "workflow.stage", data: { stage: "verification", status: "running" }, t: Date.now(), job: JOB })); } catch { /* closed */ } }, 500);
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`mock platform on ${base}`);

// ---- playwright -------------------------------------------------------------
const { chromium } = await import("playwright");
let browser;
try { browser = await chromium.launch({ headless: true }); } catch (e) {
  console.log(`FAIL  playwright launch — ${e.message.split("\n")[0]}`);
  console.log(`\nRESULT: pass=${pass} fail=${fail} skip=1 → exit 1`);
  process.exit(1);
}
const mkPage = () => {
  const bucket = { js: [], net: [] };
  const page = browser.newPage();
  return page.then((p) => {
    p.on("pageerror", (e) => bucket.js.push("pageerror: " + e.message));
    p.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text() || "";
      if (/Failed to load resource/.test(text)) { bucket.net.push(text); return; } // designed honest-404 states
      bucket.js.push(text + " @ " + (m.location()?.url || "?"));
    });
    return { p, bucket };
  });
};
const goto = async (p, url) => { await p.goto(base + url, { waitUntil: "domcontentloaded", timeout: 15000 }); };
const text = async (p, sel) => (await p.locator(sel).allTextContents()).join(" ");

// ---- A/B: page 5 — blueprint ------------------------------------------------
section("page 5 — blueprint");
{
  const { p, bucket } = await mkPage();
  await goto(p, `/pages/blueprint.html?job=${JOB}`);
  await p.waitForSelector("#ta-include", { timeout: 8000 });
  ok("scope include rendered", (await p.inputValue("#ta-include")).includes("pricing page"));
  ok("scope exclude rendered", (await p.inputValue("#ta-exclude")).includes("blog"));
  await p.waitForSelector("#pages-body .page .chip", { timeout: 8000 });
  ok("region chip rendered", (await text(p, "#pages-body .chip")).includes("header"));
  ok("observed badge on region", (await p.locator("#pages-body .badge.observed").count()) >= 1);
  ok("ambiguity listed", (await p.locator("#amb-body li").count()) >= 1);
  ok("stack framework decision", (await text(p, "#stack-body")).includes("react"));
  await p.click("#btn-approve");
  await p.waitForSelector("#action-out .notice.ok", { timeout: 8000 });
  ok("APPROVE posted scope edits", approveCalls.some((c) => c.jobId === JOB && c.body?.scope?.include?.length >= 1 && c.body.approved === true));
  // honest 404 state for the approve endpoint on the second job id
  await goto(p, `/pages/blueprint.html?job=${JOB_404}`);
  await p.waitForSelector("#btn-approve", { timeout: 8000 });
  await p.click("#btn-approve");
  await p.waitForSelector("#action-out .notice.err", { timeout: 8000 });
  const errText = await text(p, "#action-out .notice.err");
  ok("approve honest 404 error state", errText.includes("HTTP 404") && errText.includes("not mounted"));
  ok("blueprint page: no JS console errors", bucket.js.length === 0, bucket.js.join(" | "));
  await p.close();
}

// ---- page 6 — reconstruction workspace --------------------------------------
section("page 6 — reconstruction workspace");
{
  const { p, bucket } = await mkPage();
  await goto(p, `/pages/reconstruction.html?job=${JOB}`);
  ok("swarm viewer iframe embedded", (await p.locator('#swarm[src^="/progress/"]').count()) === 1);
  await p.waitForFunction(() => document.querySelector("#swarm")?.contentWindow !== null, null, { timeout: 8000 });
  await p.waitForSelector(".pill", { timeout: 8000 });
  ok("4 stage pills", (await p.locator(".pill").count()) === 4, "expected exploration/reconstruction/verification/export");
  await p.waitForFunction(() => document.querySelectorAll("#log > div").length >= 3, null, { timeout: 8000 });
  ok("build log tail from /ws catchup", (await p.locator("#log > div").count()) >= 3);
  await p.waitForFunction(() => document.querySelector('.pill[data-stage="verification"]')?.className.includes("running"), null, { timeout: 8000 });
  ok("live workflow.stage updates pills", true);
  ok("reconstruction page: no JS console errors", bucket.js.length === 0, bucket.js.join(" | "));
  await p.close();
}

// ---- page 7 — comparison & QA ------------------------------------------------
section("page 7 — comparison & QA");
{
  const { p, bucket } = await mkPage();
  await goto(p, `/pages/comparison.html?job=${JOB}`);
  await p.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".shot img")];
    return imgs.length >= 2 && imgs.every((i) => i.naturalWidth > 0);
  }, null, { timeout: 8000 });
  ok("original + clone screenshots rendered", (await p.locator(".shot img").count()) >= 2);
  await p.waitForSelector('.stage[data-stage="functional"]', { timeout: 8000 });
  ok("3 verification stage results", (await p.locator(".stage[data-stage]").count()) === 3);
  ok("visual grade extracted", (await text(p, '.stage[data-stage="visual"] .chip')).includes("grade: A"));
  await p.waitForSelector(".flow-case", { timeout: 8000 });
  ok("flow cases with pass + fail", (await p.locator('.flow-case[data-result="pass"]').count()) >= 1 && (await p.locator('.flow-case[data-result="fail"]').count()) >= 1);
  ok("bug link present", (await p.locator("a.bug-link").count()) >= 1);
  ok("defect classification summary", (await text(p, "#defects-body")).includes("double-click"));
  ok("comparison page: no JS console errors", bucket.js.length === 0, bucket.js.join(" | "));
  await p.close();
}

// ---- page 8 — final project --------------------------------------------------
section("page 8 — final project");
{
  const { p, bucket } = await mkPage();
  await goto(p, `/pages/final.html?job=${JOB}`);
  ok("preview iframe present", (await p.locator('#preview[src^="/preview/"]').count()) === 1);
  await p.waitForFunction(() => document.querySelector("#preview")?.contentWindow !== null, null, { timeout: 8000 });
  ok("download link wired", (await p.locator("#export-link").getAttribute("href")) === `/api/export/${JOB}/download`);
  await p.waitForSelector("#limits-body li", { timeout: 8000 });
  ok("known limitations rendered", (await p.locator("#limits-body li").count()) >= 1);
  await p.waitForSelector("#versions-body .notice", { timeout: 8000 });
  ok("versions honest 404 state", (await text(p, "#versions-body")).includes("HTTP 404"));
  await p.click("#btn-download");
  await p.waitForSelector('#dl-out .notice.err', { timeout: 8000 });
  ok("download honest 404 state", (await text(p, "#dl-out .notice.err")).includes("404"));
  await p.click("#btn-publish");
  await p.waitForSelector("#gh-out .notice.err", { timeout: 8000 });
  ok("github publish honest error state", (await text(p, "#gh-out .notice.err")).includes("503"));
  ok("final page: no JS console errors", bucket.js.length === 0, bucket.js.join(" | "));
  await p.close();
}

await browser.close();
server.close();
console.log(`\nRESULT: PASS=${pass} FAIL=${fail}${bucketNetNote()}`);
if (fail > 0) process.exit(1);
function bucketNetNote() { return ""; } // net-404 logs are per-page buckets (designed honest states), not failures
