#!/usr/bin/env node
// Swarm build viewer tests — OFFLINE ONLY (local express app on 127.0.0.1, local
// fixture file; no external sites, no database, no Redis).
//
//   A. route tests  — src/platform/progress-routes.js mounted on a test-local
//                     express app (src/platform/server.js is integrator-owned
//                     and mounts it later): page served, static assets served,
//                     bad job id 400, SSE endpoint sets text/event-stream and
//                     replays the recorded fixture events before live ones,
//                     foreign-job events filtered out.
//   B. viewer logic — the exported animation-model reducer in
//                     public/progress/viewer.js (STAGES/createModel/applyEvent/
//                     hudText) driven through fixtures/progress-events.json in
//                     Node, asserting unit/agent/HUD/stage transitions.
//   C. playwright   — optional visual check against 127.0.0.1 (demo mode);
//                     SKIPs without a hard failure if chromium is unavailable.
//                     Screenshot lands in artifacts/progress-viewer.png.
//
// Prints PASS/FAIL/SKIP lines with counts, exits 1 on any failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // fixtures/ and artifacts/ are cwd-relative

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

// Minimal stand-in shaped exactly like the Bus singleton in src/events.js
// (buffered emit → bus-shaped { type, data, t, job }, catchUp() ring buffer).
class FakeBus extends EventEmitter {
  constructor() { super(); this.buffer = []; }
  emit(type, data = {}, job = null) {
    const evt = { type, data, t: Date.now(), job };
    this.buffer.push(evt);
    if (this.buffer.length > 500) this.buffer.shift();
    return super.emit(type, evt);
  }
  catchUp() { return { meta: null, events: this.buffer }; }
}

const fixture = JSON.parse(fs.readFileSync(path.join(PROJECT, "fixtures", "progress-events.json"), "utf8"));
const fixtureEvents = fixture.events;

// Read an SSE endpoint until a predicate matches (or timeout), collecting
// `event:`/`data:` blocks. Cancels the stream once satisfied.
async function readSSE(url, { until, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", blocks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = {};
        for (const ln of block.split("\n")) {
          if (ln.startsWith("event:")) ev.event = ln.slice(6).trim();
          else if (ln.startsWith("data:")) ev.data = (ev.data || "") + ln.slice(5).trim();
        }
        if (ev.event) blocks.push(ev);
      }
      if (until && blocks.some(until)) break;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return { status: res.status, contentType: res.headers.get("content-type"), blocks };
}

const express = (await import("express")).default;
const { progressRoutes } = await import("../src/platform/progress-routes.js");
const viewer = await import("../public/progress/viewer.js");

// Boot the test-local app — progressRoutes gets an injected fake bus, so the
// shared singleton stays untouched and the test is hermetic.
const bus = new FakeBus();
const app = express();
app.use(progressRoutes({ bus }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- section A
section("A. route tests (127.0.0.1, injected bus)");

// Foreign-job traffic recorded before anything else — must never stream.
for (const e of fixtureEvents.slice(0, 3)) bus.emit(e.type, e.data, "job-other");
// Replay backlog for the viewer's own job.
for (const e of fixtureEvents) bus.emit(e.type, e.data, fixture.job);

{
  const res = await fetch(`${base}/progress/${fixture.job}`);
  const html = await res.text();
  ok("A1 GET /progress/:jobId serves the page", res.status === 200 && res.headers.get("content-type").includes("text/html"));
  ok("A1b page references viewer.js/viewer.css and canvas", html.includes("/progress/viewer.js") && html.includes("/progress/viewer.css") && html.includes("<canvas"));
  const css = await fetch(`${base}/progress/viewer.css`);
  const js = await fetch(`${base}/progress/viewer.js`);
  ok("A2 static assets served with CSS/JS types", css.status === 200 && css.headers.get("content-type").includes("text/css") && js.status === 200 && js.headers.get("content-type").includes("text/javascript"));
  const bad = await fetch(`${base}/progress/%2E%2E%2Fetc`);
  ok("A3 malformed job id → 400", bad.status === 400, `got ${bad.status}`);
  const demo = await fetch(`${base}/progress/demo-events.json`);
  const demoJson = await demo.json();
  const stages = new Set(demoJson.events.filter((e) => e.type === "workflow.stage").map((e) => e.data.stage));
  const routes = new Set(demoJson.events.filter((e) => e.type === "workflow.todo.add").map((e) => e.data.route));
  const units = demoJson.events.filter((e) => e.type === "workflow.todo.add").length;
  ok("A4 demo-events.json served", demo.status === 200 && demo.headers.get("content-type").includes("application/json"));
  ok("A4b fixture has 4 stages / 3 routes / 6 units", stages.size === 4 && routes.size === 3 && units === 6, `stages=${stages.size} routes=${routes.size} units=${units}`);

  // SSE: replay recorded events first, then the live marker emitted after the
  // client connected.
  const ssePromise = readSSE(`${base}/progress/${fixture.job}/events`, {
    until: (b) => b.event === "workflow.agent" && String(b.data).includes("agent-live"),
  });
  await new Promise((r) => setTimeout(r, 50)); // let the subscriber attach
  bus.emit("workflow.agent", { id: "agent-live", name: "latecomer" }, fixture.job);
  const sse = await ssePromise;
  ok("A5 SSE content-type is text/event-stream", sse.contentType.includes("text/event-stream"), sse.contentType);
  ok("A5b SSE opens with a hello block", sse.blocks[0]?.event === "hello" && String(sse.blocks[0]?.data).includes(fixture.job));
  // Compare type+data pairs: the bus re-stamps `t` on emit, so replayed events
  // carry the fake bus's timestamps, not the fixture file's.
  const stream = sse.blocks.filter((b) => b.event !== "hello").map((b) => { const e = JSON.parse(b.data); return { type: e.type, data: e.data }; });
  const expected = [...fixtureEvents, { type: "workflow.agent", data: { id: "agent-live", name: "latecomer" } }].map((e) => ({ type: e.type, data: e.data }));
  ok("A6 SSE replays recorded events then live, in order", JSON.stringify(stream) === JSON.stringify(expected), `got ${stream.length} events`);
  const foreignLeaked = sse.blocks.some((b) => b.event === "workflow.agent" && String(b.data).includes('"job":"job-other"'));
  ok("A7 foreign-job events filtered out", !foreignLeaked);
  const jobsOk = sse.blocks.every((b) => { try { return b.event === "hello" || JSON.parse(b.data).job === fixture.job; } catch { return false; } });
  ok("A7b every streamed event belongs to the job", jobsOk);
}

// ---------------------------------------------------------------- section B
section("B. viewer logic (reducer driven by fixture, no browser)");

ok("B0 stage table", JSON.stringify(viewer.STAGES) === JSON.stringify(["exploration", "reconstruction", "verification", "export"]));
{
  const m0 = viewer.createModel();
  ok("B1 initial model", m0.units.length === 0 && m0.agents.length === 0 && m0.doneCount === 0 && m0.stageIndex === -1);
  ok("B1b initial HUD", viewer.hudText(m0) === "0 agents · 0/0 units · —");
}
{
  const m = viewer.createModel();
  for (const e of fixtureEvents.slice(1, 4)) viewer.applyEvent(m, e);
  viewer.applyEvent(m, { type: "workflow.agent", data: { id: "agent-scout", name: "scout" } }); // duplicate id
  ok("B2 agents register with deterministic colors, duplicates ignored", m.agents.length === 3 && m.agents[0].name === "scout" && m.agents[2].color === viewer.AGENT_COLORS[2] && m.agents[0].color === viewer.AGENT_COLORS[0]);
}
{
  const m = viewer.createModel();
  viewer.applyEvent(m, { type: "workflow.stage", data: { stage: "verification" } });
  const after = viewer.hudText(m);
  viewer.applyEvent(m, { type: "workflow.stage", data: { stage: "exploration" } }); // backwards → ignored
  ok("B3 stages move forward only", m.stageIndex === 2 && after === "0 agents · 0/0 units · verification" && m.stage === "verification");
  viewer.applyEvent(m, { type: "workflow.stage", data: { stage: "warp" } }); // unknown → ignored
  ok("B3b unknown stage ignored", m.stage === "verification");
}
{
  const m = viewer.createModel();
  for (const e of fixtureEvents.filter((e) => e.type === "workflow.todo.add")) viewer.applyEvent(m, e);
  viewer.applyEvent(m, { type: "workflow.todo.add", data: { id: "u1", label: "dup", route: "/x" } }); // duplicate
  const slots = new Set(m.units.map((u) => `${u.slot.x},${u.slot.y}`));
  ok("B4 adds create pending units with distinct slots", m.units.length === 6 && m.units.every((u) => u.status === "pending") && slots.size === 6);
  ok("B4b labels/routes carried", m.units[0].label === "login page shell" && m.units[0].route === "/login" && m.units[5].route === "/settings");
}
{
  const m = viewer.createModel();
  viewer.applyEvent(m, { type: "workflow.agent", data: { id: "a1" } });
  viewer.applyEvent(m, { type: "workflow.agent", data: { id: "a2" } });
  viewer.applyEvent(m, { type: "workflow.todo.add", data: { id: "x1", label: "l" } });
  viewer.applyEvent(m, { type: "workflow.todo.add", data: { id: "x2", label: "l" } });
  viewer.applyEvent(m, { type: "workflow.todo.done", data: { id: "x1", agent: "a2" } }); // explicit agent honored
  ok("B5 explicit agent credited", m.units[0].agent === "a2" && m.agents[1].completed === 1 && m.doneCount === 1);
  viewer.applyEvent(m, { type: "workflow.todo.done", data: { id: "x2" } }); // auto → least-loaded
  ok("B5b auto-assign goes to the least-loaded agent", m.units[1].agent === "a1" && m.agents[0].completed === 1 && m.agents[1].completed === 1);
  viewer.applyEvent(m, { type: "workflow.todo.done", data: { id: "x2" } }); // duplicate done
  ok("B6 duplicate done is idempotent", m.doneCount === 2 && m.agents[0].completed === 1);
  viewer.applyEvent(m, { type: "workflow.todo.done", data: { id: "nope" } }); // done before add
  ok("B7 done for unknown unit is a no-op", m.doneCount === 2 && m.units.every((u) => u.status === "done") && m.seen === 8); // a1,a2,add×2,done,dup-done,unknown = 8 applied
}
{
  const m = viewer.createModel();
  viewer.applyEvent(m, { type: "workflow.todo.add", data: { id: "s1", label: "l" } });
  viewer.applyEvent(m, { type: "workflow.todo.done", data: { id: "s1" } });
  ok("B8 done with no agents spawns one drawer", m.agents.length === 1 && m.agents[0].id === "agent-auto-1" && m.units[0].agent === "agent-auto-1" && m.doneCount === 1);
}
{
  const m = viewer.createModel();
  for (const e of fixtureEvents) viewer.applyEvent(m, e);
  ok("B9 full fixture: 3 agents · 6/6 units · export", viewer.hudText(m) === "3 agents · 6/6 units · export");
  ok("B9b every unit done and assigned", m.units.every((u) => u.status === "done" && u.agent) && m.stageIndex === 3 && m.seen === fixtureEvents.length);
}

// ---------------------------------------------------------------- section C
section("C. playwright visual check (127.0.0.1 demo mode; optional)");
{
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/progress/${fixture.job}?demo=1&interval=20`);
    await page.waitForFunction(
      () => (document.querySelector("#hud")?.textContent || "").includes("6/6 units · export"),
      null,
      { timeout: 20000 }
    );
    const hud = await page.textContent("#hud");
    const doneRows = await page.$$eval("#todos li.done", (els) => els.length);
    const agents = await page.evaluate(() => document.querySelectorAll("#banner span").length);
    ok("C1 HUD reaches 6/6 units · export", hud.trim() === "3 agents · 6/6 units · export", hud);
    ok("C2 todo sidebar shows 6 checked rows", doneRows === 6, `got ${doneRows}`);
    ok("C3 stage banner has 4 stages", agents === 4, `got ${agents}`);
    // Agents must actually FINISH drawing: all 6 slots painted once every
    // flight queue drains (worst case: 2 flights/agent ≈ 2.5s at lerp 0.07).
    await page.waitForFunction(() => window.__swarm?.view.painted.size === 6, null, { timeout: 15000 });
    const painted = await page.evaluate(() => window.__swarm.view.painted.size);
    ok("C3b agents drew all 6 units on canvas", painted === 6, `painted=${painted}`);
    fs.mkdirSync(path.join(PROJECT, "artifacts"), { recursive: true });
    await page.screenshot({ path: path.join(PROJECT, "artifacts", "progress-viewer.png") });
    ok("C4 screenshot written to artifacts/progress-viewer.png", fs.existsSync(path.join(PROJECT, "artifacts", "progress-viewer.png")));
  } catch (e) {
    skip++;
    console.log(`SKIP  C playwright visual: ${String(e.message || e).split("\n")[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Guardrails: no CDNs/external URLs in shipped viewer assets, line limits.
section("D. guardrails");
{
  const noCdn = ["public/progress/index.html", "public/progress/viewer.js", "public/progress/viewer.css"]
    .every((f) => !/https?:\/\//.test(fs.readFileSync(f, "utf8")));
  ok("D1 viewer assets contain no external URLs/CDNs", noCdn);
  const owned = ["public/progress/index.html", "public/progress/viewer.js", "public/progress/viewer.css", "src/platform/progress-routes.js", "fixtures/progress-events.json", "scripts/test-progress-viewer.mjs"];
  const over = owned.filter((f) => fs.readFileSync(f, "utf8").split("\n").length > 350);
  ok("D2 every owned file ≤ 350 lines", over.length === 0, over.join(", ") || "");
}

server.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
