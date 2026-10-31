// Task 3.4.4 verification — stateful data / WebSocket reconstruction.
//
// Sections:
//   A. Unit — WS capture redaction contract (stub page: strings redacted, numbers
//      kept, credential keys collapsed, URLs sanitized, binary opaque).
//   B. Unit — sanitized fixture export determinism + sequenceFromCapture
//      (socket→connect, close→disconnect, new socket→reconnect).
//   C. Unit — replayer timeline validation (credential keys are HARD errors) +
//      deterministic runtime build + flattenData.
//   D. Integration — REAL Playwright browser on the ticker-stream fixture:
//      page.on("websocket") capture (both sockets, in/out frames, close), page
//      state through the scripted outage (disconnect → reconnect → replayed
//      delayed updates), DOM extraction for the artifact evidence.
//   E. Widget detection/plan — buildStreamPlan over the mini artifact dir
//      (dom.json + network.json + websocket.json): table/ticker/counter detected,
//      channel keys from the capture, wiring map, timeline from the capture.
//   F. Generated clone replay — clone HTML wired from the PLAN + embedded
//      runtime, opened via file:// with ZERO network: ordered replay visible in
//      the DOM (MutationObserver), disconnect/reconnect state rendered, final
//      values equal the captured sequence.
//   G. Synthetic pause/reconnect/delayed-states timeline — held messages flush in
//      order after reconnect/resume with the held count rendered.
//   H. Hygiene — no external URLs in the clone, no credential-shaped keys in any
//      JSON, direct HTTP sanity of the fixture polling endpoints, and the
//      polling-fallback page path (site object served without WS upgrade).
//
// Run: node scripts/test-data-stream-reconstruction.mjs   (exit 1 on any failure)
// Fully offline: fixture on 127.0.0.1 (ephemeral port), clone on file://, no
// external service anywhere.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  attachWebSocketCapture,
  createWebSocketSink,
  structureOf,
  sanitizeUrl,
  exportWebSocketSink,
  exportWebSocketFixture,
  stableStringify,
  flattenNumericStructure,
  sequenceFromCapture,
} from "../src/exploration/websocket-session-capture.js";
import {
  buildStreamRuntime,
  validateTimeline,
  normalizeChannels,
  flattenData,
} from "../src/reconstruction/data-stream-replayer.js";
import {
  detectLiveWidgets,
  buildStreamPlan,
  specNumericKeys,
} from "../src/reconstruction/stateful-widget-builder.js";
import { DOM_EXTRACTOR_SCRIPT, analyzeTypography } from "../src/intelligence/dom-extractor.js";
import { attachNetworkRecorder } from "../src/network/network-recorder.js";
import { redact } from "../src/storage/artifact-store.js";
import {
  startTickerStreamServer,
  tickerStreamSite,
  quoteMap,
  quoteFor,
  SYMBOLS,
} from "./fixtures/ticker-stream.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(os.tmpdir(), "cloner-3-4-4-" + Date.now());
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CRED_KEY_RE = /"(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|cookie|private[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|credentials?)"\s*:/i;
const CRED_VALUE_RE = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;

// stub socket object that behaves like a Playwright WebSocket for the capture
function stubSocket(url) {
  const sock = new EventEmitter();
  sock.url = () => url;
  return sock;
}

// ============================== A. capture redaction ==============================
console.log("\n== A. websocket-session-capture: redaction contract (stub page) ==");
{
  const page = new EventEmitter();
  const sink = createWebSocketSink();
  attachWebSocketCapture(page, sink);

  const sock = stubSocket("wss://live.example.com/ws?token=supersecret123&session=abc");
  page.emit("websocket", sock);
  const iso = /^\d{4}-\d{2}-\d{2}T/;

  sock.emit("framereceived", { payload: () => JSON.stringify({
    type: "login", user: "ada", password: "hunter2", balance: 123.5,
    flags: [true, false], meta: { a: 1 },
  }) });
  sock.emit("framereceived", { payload: () => "PING" });
  sock.emit("framereceived", { payload: () => Buffer.from([1, 2, 3, 4]) });
  sock.emit("framesent", { payload: () => JSON.stringify({ type: "subscribe", symbols: ["AAPL", "MSFT", "ES"] }) });

  const socketEvt = sink.events.find((e) => e.kind === "socket");
  const frames = sink.events.filter((e) => e.kind === "frame");
  check("A: socket + 4 frame events captured", sink.events.length === 5 && !!socketEvt && frames.length === 4, `events=${sink.events.length} frames=${frames.length}`);
  check("A: frame event carries the ask's {url, direction, timestamp, payloadStructure}",
    frames.every((f) => typeof f.url === "string" && typeof f.direction === "string" && iso.test(f.timestamp) && f.payloadStructure && typeof f.t === "number"),
    JSON.stringify(Object.keys(frames[0])));

  const url = sanitizeUrl("wss://live.example.com/ws?token=supersecret123&session=abc");
  check("A: socket URL query values redacted, param names kept", socketEvt.url === url && url.includes("token=<redacted>") && !url.includes("supersecret123"), socketEvt.url);

  const blob = JSON.stringify(sink.events);
  check("A: no string values leak (login/ada/PING/hunter2 all absent)",
    !blob.includes("login") && !blob.includes('"ada"') && !blob.includes("PING") && !blob.includes("hunter2"));

  const s1 = frames[0].payloadStructure;
  check("A: strings → type+len only", s1.f.type.t === "string" && s1.f.type.len === 5 && s1.f.user.t === "string" && s1.f.user.len === 3 && !("v" in s1.f.user));
  check("A: credential-named key collapses fully (no len/type)", s1.f.password.t === "redacted-credential" && !("len" in s1.f.password) && !("v" in s1.f.password));
  check("A: numbers kept by default (ticker contract)", s1.f.balance.t === "number" && s1.f.balance.v === 123.5);
  check("A: booleans shape-only by default", s1.f.flags.t === "array" && s1.f.flags.len === 2 && s1.f.flags.items[0].t === "boolean" && !("v" in s1.f.flags.items[0]));
  check("A: nested objects recurse", s1.f.meta.t === "object" && s1.f.meta.f.a.v === 1);
  check("A: non-JSON text → opaque shape, no content", frames[1].payloadStructure.t === "text" && frames[1].payloadStructure.len === 4);
  check("A: binary → {t:binary,len}", frames[2].payloadStructure.t === "binary" && frames[2].payloadStructure.len === 4);

  const outFrame = frames.find((f) => f.direction === "out");
  check("A: outbound frames captured with direction=out", !!outFrame && outFrame.payloadStructure.f.type.len === 9 && outFrame.payloadStructure.f.symbols.t === "array" && outFrame.payloadStructure.f.symbols.len === 3);

  // keepNumbers:false and safeStringKeys
  const sink2 = createWebSocketSink();
  attachWebSocketCapture(page, sink2, { keepNumbers: false, safeStringKeys: ["user"] });
  const sock2 = stubSocket("wss://x.example/ws");
  page.emit("websocket", sock2);
  sock2.emit("framereceived", { payload: () => JSON.stringify({ user: "ada", balance: 123.5 }) });
  const s2 = sink2.events.find((e) => e.kind === "frame").payloadStructure;
  check("A: keepNumbers:false redacts numeric values", s2.f.balance.t === "number" && !("v" in s2.f.balance));
  check("A: safeStringKeys allowlist keeps an explicit string", s2.f.user.t === "string" && s2.f.user.v === "ada");

  // oversized payload → opaque, never analyzed
  const sink3 = createWebSocketSink();
  attachWebSocketCapture(page, sink3, { maxPayloadAnalyzed: 16 });
  const sock3 = stubSocket("wss://x.example/ws");
  page.emit("websocket", sock3);
  sock3.emit("framereceived", { payload: () => JSON.stringify({ secretContent: "x".repeat(64) }) });
  check("A: oversized payload → truncated opaque shape", sink3.events.find((e) => e.kind === "frame").payloadStructure.truncated === true);
}

// ============================== B. fixture export + sequence ==============================
console.log("\n== B. sanitized fixture export determinism + sequenceFromCapture ==");
{
  // synthetic sink with FIXED t values (determinism of the export transform)
  const sink = {
    startedAt: 1000, sockets: 2, dropped: 0,
    events: [
      { kind: "socket", url: "ws://127.0.0.1:51791/ws", direction: null, timestamp: "2026-01-01T00:00:00.000Z", t: 0, socketId: 1 },
      { kind: "frame", url: "ws://127.0.0.1:51791/ws", direction: "out", timestamp: "2026-01-01T00:00:00.010Z", t: 13, socketId: 1, payloadStructure: structureOf(JSON.stringify({ type: "subscribe" })) },
      { kind: "frame", url: "ws://127.0.0.1:51791/ws", direction: "in", timestamp: "2026-01-01T00:00:00.300Z", t: 305, socketId: 1, payloadStructure: structureOf(JSON.stringify({ type: "quote", seq: 1, quotes: { AAPL: { price: 101.25 } } })) },
      { kind: "close", url: "ws://127.0.0.1:51791/ws", direction: null, timestamp: "2026-01-01T00:00:02.000Z", t: 2001, socketId: 1 },
      { kind: "socket", url: "ws://127.0.0.1:51791/ws", direction: null, timestamp: "2026-01-01T00:00:02.400Z", t: 2402, socketId: 2 },
      { kind: "frame", url: "ws://127.0.0.1:51791/ws", direction: "in", timestamp: "2026-01-01T00:00:02.700Z", t: 2703, socketId: 2, payloadStructure: structureOf(JSON.stringify({ type: "quote", seq: 2, quotes: { AAPL: { price: 102.5 } } })) },
    ],
  };
  const fx1 = exportWebSocketSink(sink);
  const fx2 = exportWebSocketSink(sink);
  const json1 = stableStringify(fx1), json2 = stableStringify(fx2);
  check("B: export is a pure function (identical input → identical bytes)", json1 === json2);
  const file = path.join(TMP, "ws-fixture.json");
  exportWebSocketFixture(sink, file);
  check("B: exportWebSocketFixture writes the same stable JSON", fs.readFileSync(file, "utf8") === json1);
  check("B: no wall clock in the fixture (no ISO timestamps)", !/\d{4}-\d{2}-\d{2}T/.test(json1));
  check("B: fixture marked redacted + schema version", fx1.redacted === true && fx1.schemaVersion === "1.0.0" && fx1.channels.length === 2 && fx1.channels[0].framesIn === 1 && fx1.channels[0].framesOut === 1 && fx1.channels[0].closes === 1);

  const seq = sequenceFromCapture(sink.events, {});
  check("B: sequenceFromCapture groups one channel per socket url", seq.channels.length === 1 && seq.channels[0].id === "ws" && seq.channels[0].url === "ws://127.0.0.1:51791/ws");
  const types = seq.channels[0].events.map((e) => e.type);
  check("B: socket→connect, close→disconnect, new socket→reconnect, frames→messages",
    types[0] === "connect" && types.includes("message") && types.includes("disconnect") && types.includes("reconnect"), types.join(","));
  const msgs = seq.channels[0].events.filter((e) => e.type === "message");
  check("B: message data carries the numeric leaves (redaction-safe replay)",
    msgs.length === 2 && msgs[0].data["seq"] === 1 && msgs[0].data["quotes.AAPL.price"] === 101.25 && msgs[1].data["quotes.AAPL.price"] === 102.5);
  check("B: messages ordered by t", msgs[0].t < msgs[1].t);
}

// ============================== C. replayer validation ==============================
console.log("\n== C. data-stream-replayer: timeline validation + runtime build ==");
{
  const good = [{ id: "quotes", loop: false, events: [
    { t: 0, type: "connect" },
    { t: 100, type: "message", data: { "a.b": 1, label: "x" } },
    { t: 400, type: "disconnect" },
    { t: 900, type: "reconnect" },
    { t: 1000, type: "message", data: { "a.b": 2 } },
  ] }];
  const v = validateTimeline(good);
  check("C: valid timeline passes", v.ok === true && v.errors.length === 0, JSON.stringify(v.stats));

  const bad = [
    { id: "x", events: [{ t: -5, type: "message", data: { a: 1 } }] },
    { id: "x", events: [{ t: 0, type: "message", data: { a: 1 } }] },          // duplicate id
    { id: "y", events: [{ t: 0, type: "warp" }] },                              // unknown type
    { id: "z", events: [{ t: 0, type: "message", data: {} }] },                 // empty data
    { id: "w", events: [{ t: 0, type: "message", data: { nested: { a: 1 } } }] }, // non-scalar
    { id: "v", events: [{ t: 0, type: "message", data: { apiKey: "should-not-exist" } }] }, // credential key
    { id: "u" },                                                                // events missing
  ];
  const vb = validateTimeline(bad);
  check("C: contract violations are errors (7 channels flagged)", !vb.ok && vb.errors.length >= 7, `${vb.errors.length} error(s): ${vb.errors[0]}...`);
  check("C: credential-shaped data key is a HARD error", vb.errors.some((e) => e.includes("apiKey") && e.includes("forbidden")));

  const rt1 = buildStreamRuntime(good);
  const rt2 = buildStreamRuntime(good);
  check("C: runtime build is deterministic", rt1 === rt2 && rt1.includes("window.__CLONER_STREAMS = ") && rt1.includes("__CLONER_STREAMS_DONE"));
  check("C: runtime embeds the normalized timeline", rt1.includes('"events":[{"t":0,"type":"connect"}') && rt1.includes('"data":{"a.b":1,"label":"x"}'));

  const vn = validateTimeline(normalizeChannels([{ id: "m", events: [{ t: 300, type: "message", data: { a: 1 } }, { t: 100, type: "message", data: { a: 0 } }] }]).channels);
  check("C: normalizeChannels sorts unsorted events and validates", vn.ok && vn.stats.messages === 2);

  const flat = flattenData({ a: { b: 1 }, c: [2, 3], "d.e": "s" });
  check("C: flattenData produces dot paths (arrays indexed, dots in keys underscored)",
    flat["a.b"] === 1 && flat["c.0"] === 2 && flat["c.1"] === 3 && flat["d_e"] === "s");
}

// ============================== D. real browser exploration of the fixture ==============================
console.log("\n== D. real Playwright run against the ticker-stream fixture (WS capture) ==");
const fxServer = await startTickerStreamServer();
const artifactsDir = path.join(TMP, "artifacts");
let browser = null;
let page = null;
let wsFixtureExport = null; // shared with section E (confidence boost comparison)
try {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  page = await ctx.newPage();

  const network = { entries: [] };
  attachNetworkRecorder(ctx, network).attach(page);
  const wsSink = createWebSocketSink();
  attachWebSocketCapture(page, wsSink);

  await page.goto(fxServer.base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForFunction(() => window.__FIXTURE_DONE === true, null, { timeout: 25000 });

  const pageState = await page.evaluate(() => ({
    wsUsed: window.__WS_USED, statusLog: window.__STATUS_LOG, replays: window.__REPLAYS,
    seq: document.getElementById("seq-counter").textContent,
    aapl: document.querySelector('[data-sym="AAPL"] .price').textContent,
    status: document.getElementById("stream-status").getAttribute("data-stream-state"),
  }));
  check("D: page used the real WebSocket transport", pageState.wsUsed === true);
  check("D: page observed the scripted outage (connected → disconnecting → disconnected → connected)",
    pageState.statusLog.includes("connected") && pageState.statusLog.includes("disconnecting") && pageState.statusLog.includes("disconnected") &&
    pageState.statusLog.indexOf("disconnected") < pageState.statusLog.lastIndexOf("connected"),
    pageState.statusLog.join(" → "));
  check("D: page rendered the 2 delayed updates after reconnect", pageState.replays === 2, `replays=${pageState.replays}`);
  check("D: final seq counter = 8", pageState.seq === "8", pageState.seq);
  check("D: final AAPL ticker price matches the deterministic quote math",
    pageState.aapl === quoteFor(8, "AAPL").price.toFixed(2), `${pageState.aapl} vs ${quoteFor(8, "AAPL").price.toFixed(2)}`);
  check("D: page ends connected", pageState.status === "connected", pageState.status);

  // ---- capture assertions (the page.on("websocket") hook) ----
  const socketEvts = wsSink.events.filter((e) => e.kind === "socket");
  const closeEvts = wsSink.events.filter((e) => e.kind === "close");
  const inFrames = wsSink.events.filter((e) => e.kind === "frame" && e.direction === "in");
  const outFrames = wsSink.events.filter((e) => e.kind === "frame" && e.direction === "out");
  check("D: both sockets captured (original + reconnect)", wsSink.sockets === 2 && socketEvts.length === 2, `sockets=${wsSink.sockets}`);
  check("D: close of the first socket captured", closeEvts.length >= 1 && closeEvts[0].socketId === 1);
  check("D: socket url sanitized to origin+path", socketEvts[0].url === `ws://127.0.0.1:${fxServer.port}/ws`, socketEvts[0].url);
  check("D: inbound + outbound frames captured", inFrames.length >= 8 && outFrames.length >= 1, `in=${inFrames.length} out=${outFrames.length}`);
  const sub = outFrames[0].payloadStructure;
  check("D: outbound subscribe frame shape (strings redacted, array len kept)",
    sub.t === "object" && sub.f.type.len === 9 && sub.f.symbols.t === "array" && sub.f.symbols.len === 3 && sub.f.symbols.items[0].len === 4);

  // numeric replay content: inbound quote frames carry the deterministic price sequence
  const priceSeq = inFrames
    .map((f) => flattenNumericStructure(f.payloadStructure))
    .filter((d) => "quotes.AAPL.price" in d)
    .map((d) => d["quotes.AAPL.price"]);
  const expectedPrices = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => quoteFor(n, "AAPL").price);
  check("D: captured numeric sequence equals the fixture's deterministic quote math (ordered)",
    JSON.stringify(priceSeq) === JSON.stringify(expectedPrices), `${priceSeq.length} frames: ${priceSeq.slice(0, 3).join(",")}...`);
  check("D: string payload values never captured (no symbol strings in structures)",
    !JSON.stringify(wsSink.events).includes('"v":"AAPL"') && !JSON.stringify(wsSink.events).includes('"v":"ticker-fixture"'));

  // ---- write the mini artifact dir exactly like the exploration pipeline would ----
  const domIntel = await page.evaluate(DOM_EXTRACTOR_SCRIPT);
  domIntel.typography = analyzeTypography(domIntel.elements);
  const pageId = "page-001";
  const pageDir = path.join(artifactsDir, "pages", pageId);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, "dom.json"), JSON.stringify({ pageId, url: page.url(), total: domIntel.total, sampled: domIntel.sampled, elements: domIntel.elements, repeated: domIntel.repeated, fixed: domIntel.fixed, sticky: domIntel.sticky, typography: domIntel.typography }));
  fs.writeFileSync(path.join(pageDir, "network.json"), JSON.stringify({ pageId, url: page.url(), entries: redact(network.entries) }));
  // documented exploration hook output: pages/<pageId>/websocket.json
  wsFixtureExport = exportWebSocketSink(wsSink);
  fs.writeFileSync(path.join(pageDir, "websocket.json"), stableStringify(wsFixtureExport));

  const snapshotEntry = network.entries.find((e) => (e.url || "").includes("/api/snapshot") && e.phase === "response");
  check("D: network.json evidence has the JSON snapshot fetch", !!snapshotEntry && /json/i.test(snapshotEntry.contentType || ""), snapshotEntry ? `${snapshotEntry.status} ${snapshotEntry.contentType}` : "missing");
  check("D: dom.json sampled the live page (elements + repeated groups)", domIntel.sampled > 20 && domIntel.repeated.some((r) => r.count >= 3), `sampled=${domIntel.sampled} repeated=${domIntel.repeated.length}`);
} catch (e) {
  check("D: browser run completed", false, String((e && e.stack) || e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
}

// ============================== E. widget detection + plan ==============================
console.log("\n== E. stateful-widget-builder: detection + stream plan ==");
let plan = null;
let chId = null;
try {
  plan = buildStreamPlan(artifactsDir, {});
  check("E: plan built from the artifact dir (capture read from websocket.json)", plan.ok === true);
  const p = plan.pages["page-001"];
  check("E: page-001 planned", !!p, p ? `${p.widgets.length} widget(s)` : "missing");
  const table = p.widgets.find((w) => w.kind === "table");
  const ticker = p.widgets.find((w) => w.kind === "ticker");
  const counter = p.widgets.find((w) => w.kind === "counter");
  check("E: table widget detected (tag=table + live boost)", !!table && table.confidence >= 0.85, table ? `conf=${table.confidence.toFixed(2)} ev=${table.evidence.join(",")}` : "missing");
  check("E: ticker widget detected (class hint + numeric cells)", !!ticker && ticker.confidence >= 0.8, ticker ? `conf=${ticker.confidence.toFixed(2)}` : "missing");
  check("E: counter widget detected (counter id hint + numeric text)", !!counter && counter.confidence >= 0.8, counter ? `conf=${counter.confidence.toFixed(2)}` : "missing");
  check("E: live evidence recorded (websocket frames)", p.liveEvidence.websocket.framesIn >= 8 && p.liveEvidence.websocket.sockets === 2, JSON.stringify(p.liveEvidence.websocket));

  chId = p.channels[0]?.id;
  check("E: channel derived from the captured socket url", chId === "ws" && p.channels[0].source === "websocket", chId);
  const keys = plan.channelKeys[chId] || [];
  check("E: channel keys are the capture's numeric leaf paths",
    ["quotes.AAPL.price", "quotes.MSFT.price", "quotes.ES.price", "seq"].every((k) => keys.includes(k)), keys.join(", "));
  const spec = plan.channelSpecs.find((s) => s.id === chId);
  const types = spec.events.map((e) => e.type);
  check("E: timeline from capture: connect → messages → disconnect → reconnect → messages",
    types[0] === "connect" && types.includes("disconnect") && types.includes("reconnect") && spec.events.filter((e) => e.type === "message").length >= 8, types.join(","));
  const ts = spec.events.map((e) => e.t);
  check("E: timeline ordered by relative t", ts.every((t, i) => i === 0 || t >= ts[i - 1]));
  const discT = spec.events.find((e) => e.type === "disconnect").t;
  const recT = spec.events.find((e) => e.type === "reconnect").t;
  check("E: disconnect precedes reconnect", discT < recT, `disconnect@${discT}ms reconnect@${recT}ms`);
  check("E: no messages scheduled between disconnect and reconnect (socket was closed)",
    !spec.events.some((e) => e.type === "message" && e.t > discT && e.t < recT));

  const wiring = p.wiring;
  check("E: wiring map non-empty and targets well-formed", wiring.length >= 6 && wiring.every((w) => new RegExp(`^${chId}\\.[A-Za-z0-9_.]+$`).test(w.target)), `${wiring.length} wiring(s): ${wiring[0]?.target}`);
  const byIndex = plan.byIndex.get("page-001");
  check("E: byIndex Map exposes elIndex → data-stream-target value", byIndex instanceof Map && byIndex.size >= 6 && [...byIndex.values()].every((v) => v.includes(chId + ".")));
  const specKeys = specNumericKeys(spec);
  check("E: specNumericKeys matches channelKeys for the capture channel", JSON.stringify(specKeys) === JSON.stringify(plan.channelKeys[chId]));

  // confidence honesty: the same page WITHOUT live evidence scores lower
  const dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", "page-001", "dom.json"), "utf8"));
  const cold = detectLiveWidgets({ elements: dom.elements, repeated: dom.repeated, networkEntries: [], wsEvents: [] });
  const warm = detectLiveWidgets({ elements: dom.elements, repeated: dom.repeated, networkEntries: [], wsEvents: wsFixtureExport.events });
  const coldTable = cold.widgets.find((w) => w.kind === "table");
  const warmTable = warm.widgets.find((w) => w.kind === "table");
  check("E: live-evidence boost is real (same DOM scores higher with captured frames)",
    coldTable && warmTable && warmTable.confidence > coldTable.confidence, `cold=${coldTable.confidence.toFixed(2)} warm=${warmTable.confidence.toFixed(2)}`);
} catch (e) {
  check("E: plan built", false, String((e && e.stack) || e).slice(0, 300));
}

// ============================== F. generated clone replay (file://, zero network) ==============================
console.log("\n== F. generated clone: ordered replay via the embedded runtime ==");
try {
  if (!plan || !chId) throw new Error("plan missing from section E");
  const spec = plan.channelSpecs.find((s) => s.id === chId);
  const msgs = spec.events.filter((e) => e.type === "message");
  const lastWithKey = (k) => [...msgs].reverse().find((m) => k in m.data)?.data[k];
  const ordered = (k) => msgs.filter((m) => k in m.data).map((m) => m.data[k]);
  const priceKey = "quotes.AAPL.price";
  const finalPrice = lastWithKey(priceKey);
  const finalSeq = lastWithKey("seq");
  const expectedPriceOrder = ordered(priceKey);

  const tickerRow = SYMBOLS.map((sym) => `  <span class="ticker" data-sym="${sym}"><span class="symbol">${sym}</span><span class="price" data-stream-target="${chId}.quotes.${sym}.price">0.00</span><span class="change" data-stream-target="${chId}.quotes.${sym}.change">+0.00</span></span>`).join("\n");
  const tableRows = SYMBOLS.map((sym) => `    <tr class="quote-row" data-row="${sym}"><td class="sym">${sym}</td><td class="cell-price" data-stream-target="${chId}.quotes.${sym}.price">0.00</td><td class="cell-change" data-stream-target="${chId}.quotes.${sym}.change">+0.00</td></tr>`).join("\n");
  const cloneHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clone — Meridian Markets (stream replay)</title><style>
body{font-family:Georgia,serif;margin:0;background:#101418;color:#e8ecf1}
main{max-width:640px;margin:34px auto;padding:20px;background:#181e26;border:1px solid #2c3542}
.ticker{display:inline-block;padding:10px 12px;border:1px solid #2c3542;min-width:120px;margin-right:10px}
.quotes-table{border-collapse:collapse}.quotes-table td{border:1px solid #2c3542;padding:8px 10px}
.stream-up{color:#7be3a2}.stream-down{color:#ff9aa2}.stream-flat{color:#e8ecf1}
</style></head><body>
<main>
<h1>Meridian Markets</h1>
<div id="status" data-stream-status="${chId}" data-stream-state="connected">connected</div>
<p id="backlog-note"></p>
<div class="ticker-row" id="ticker-row">
${tickerRow}
</div>
<table class="quotes-table" id="quotes-table"><tbody>
${tableRows}
</tbody></table>
<div class="counter">Updates received: <span id="seq-counter" data-stream-target="${chId}.seq">0</span></div>
</main>
<script src="runtime/streams.js"></script>
</body></html>`;

  const cloneDir = path.join(TMP, "clone");
  fs.mkdirSync(path.join(cloneDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, "index.html"), cloneHtml);
  fs.writeFileSync(path.join(cloneDir, "runtime", "streams.js"), buildStreamRuntime(plan.channelSpecs));

  const browser2 = await chromium.launch({ headless: true });
  try {
    const ctx = await browser2.newContext();
    const cpage = await ctx.newPage();
    await cpage.addInitScript(`
      window.__NET_CALLS = { fetch: 0, xhr: 0, ws: 0, beacon: 0 };
      window.__MUT_LOG = [];
      (function () {
        var of_ = window.fetch;
        if (of_) window.fetch = function () { window.__NET_CALLS.fetch++; return of_.apply(this, arguments); };
        var oo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () { window.__NET_CALLS.xhr++; return oo.apply(this, arguments); };
        if (window.WebSocket) {
          var OW = window.WebSocket;
          var NW = function (u, p) { window.__NET_CALLS.ws++; return p === undefined ? new OW(u) : new OW(u, p); };
          NW.prototype = OW.prototype;
          window.WebSocket = NW;
        }
        if (navigator.sendBeacon) {
          var ob = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function () { window.__NET_CALLS.beacon++; return ob.apply(null, arguments); };
        }
        var mo = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var t = muts[i].target;
            var el = t && t.nodeType === 1 ? t : t && t.parentElement; // characterData target is a text node
            if (el && el.matches && el.matches("[data-stream-target].price")) {
              window.__MUT_LOG.push({ key: el.getAttribute("data-stream-target"), text: String(el.textContent) });
            }
          }
        });
        var armed = false;
        function arm() { if (armed || !document.documentElement) return; armed = true; mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); }
        document.addEventListener("readystatechange", arm);
        document.addEventListener("DOMContentLoaded", arm);
        arm();
      })();
    `);
    await cpage.goto("file:///" + path.join(cloneDir, "index.html").replace(/\\/g, "/"), { waitUntil: "domcontentloaded", timeout: 20000 });
    await cpage.waitForFunction(() => window.__CLONER_STREAMS_DONE === true, null, { timeout: 25000 });

    const net = await cpage.evaluate(() => window.__NET_CALLS);
    check("F: clone made ZERO network calls (fetch/xhr/ws/beacon all 0)", net.fetch === 0 && net.xhr === 0 && net.ws === 0 && net.beacon === 0, JSON.stringify(net));

    const dom = await cpage.evaluate(() => ({
      tickerAapl: document.querySelector('[data-sym="AAPL"] .price').textContent,
      tableAapl: document.querySelector('tr[data-row="AAPL"] .cell-price').textContent,
      seq: document.getElementById("seq-counter").textContent,
      status: document.getElementById("status").getAttribute("data-stream-state"),
      held: document.getElementById("status").getAttribute("data-stream-held"),
      tickerClass: document.querySelector('[data-sym="AAPL"] .price').className,
    }));
    check("F: ticker cell updated to the final captured price (visible in DOM)", dom.tickerAapl === String(finalPrice), `${dom.tickerAapl} vs ${finalPrice}`);
    check("F: table cell bound to the SAME key updated identically (multi-target)", dom.tableAapl === String(finalPrice), dom.tableAapl);
    check("F: counter reached the final seq", dom.seq === String(finalSeq), `${dom.seq} vs ${finalSeq}`);
    check("F: status element ends connected", dom.status === "connected", dom.status);
    check("F: reconnect held-count rendered (0 held for a clean capture)", dom.held === "0", String(dom.held));
    check("F: direction class rendered on the last numeric update", /stream-(up|down|flat)/.test(dom.tickerClass), dom.tickerClass);

    const log = await cpage.evaluate(() => window.__CLONER_STREAM_LOG);
    const updates = log.filter((e) => e.type === "update" && e.key === `${chId}.${priceKey}`);
    check("F: ORDERED replay — applied price values equal the captured sequence exactly",
      JSON.stringify(updates.map((u) => u.value)) === JSON.stringify(expectedPriceOrder), `${updates.length} updates: ${updates.map((u) => u.value).slice(0, 4).join(",")}...`);
    check("F: replay order strictly follows capture time", updates.every((u, i) => i === 0 || u.t >= updates[i - 1].t));
    const discT = spec.events.find((e) => e.type === "disconnect").t;
    const recT = spec.events.find((e) => e.type === "reconnect").t;
    check("F: NO updates applied inside the disconnect window", !updates.some((u) => u.t > discT && u.t < recT), `window ${discT}–${recT}ms`);
    const states = log.filter((e) => e.type === "state").map((e) => e.value);
    check("F: state timeline rendered: connected → disconnected → connected",
      states.includes("disconnected") && states.indexOf("disconnected") < states.lastIndexOf("connected") && states[states.length - 1] === "connected", states.join(" → "));

    const mutLog = await cpage.evaluate(() => window.__MUT_LOG);
    const aaplMuts = mutLog.filter((m) => m.key === `${chId}.quotes.AAPL.price`);
    check("F: MutationObserver saw >= 4 live DOM updates on the ticker cell", aaplMuts.length >= 4 && new Set(aaplMuts.map((m) => m.text)).size >= 2, `${aaplMuts.length} mutation(s), ${new Set(aaplMuts.map((m) => m.text)).size} distinct values`);
  } finally {
    await browser2.close().catch(() => {});
  }

  // no external URLs anywhere in the generated clone
  const cloneFiles = ["index.html", "runtime/streams.js"];
  const offenders = [];
  for (const f of cloneFiles) {
    const text = fs.readFileSync(path.join(cloneDir, f), "utf8");
    if (/https?:\/\//i.test(text) || /wss?:\/\/(?!127\.0\.0\.1)/i.test(text)) offenders.push(f);
  }
  check("F: generated clone contains no external URLs", offenders.length === 0, offenders.join(", ") || "clean");
} catch (e) {
  check("F: clone replay run completed", false, String((e && e.stack) || e).slice(0, 300));
}

// ============================== G. pause / reconnect / delayed states ==============================
console.log("\n== G. synthetic timeline: pause, reconnect, delayed (held) updates ==");
try {
  const heldChannel = { id: "held-demo", loop: false, events: [
    { t: 0, type: "connect" },
    { t: 100, type: "message", data: { value: 1 } },
    { t: 400, type: "disconnect" },
    { t: 600, type: "message", data: { value: 2 } }, // arrives while down → HELD
    { t: 700, type: "message", data: { value: 3 } }, // arrives while down → HELD
    { t: 900, type: "reconnect" },                   // flush 2 held, in order
    { t: 1100, type: "message", data: { value: 4 } },
    { t: 1300, type: "pause" },
    { t: 1400, type: "message", data: { value: 5 } }, // arrives while paused → HELD
    { t: 1600, type: "resume" },                      // flush 1 held
    { t: 1900, type: "message", data: { value: 6 } },
  ] };
  const v = validateTimeline([heldChannel]);
  check("G: synthetic held/pause timeline validates", v.ok, v.errors.join("; "));

  const dir = path.join(TMP, "clone-held");
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>held demo</title></head><body>
<div id="status" data-stream-status="held-demo" data-stream-state="connected">connected</div>
<div id="value" data-stream-target="held-demo.value">0</div>
<script src="runtime/streams.js"></script></body></html>`);
  fs.writeFileSync(path.join(dir, "runtime", "streams.js"), buildStreamRuntime([heldChannel]));

  const browser3 = await chromium.launch({ headless: true });
  try {
    const ctx = await browser3.newContext();
    const gpage = await ctx.newPage();
    await gpage.addInitScript(`
      window.__NET_CALLS = { fetch: 0, xhr: 0, ws: 0, beacon: 0 };
      (function () { var o = window.fetch; if (o) window.fetch = function () { window.__NET_CALLS.fetch++; return o.apply(this, arguments); }; })();
    `);
    await gpage.goto("file:///" + path.join(dir, "index.html").replace(/\\/g, "/"), { waitUntil: "domcontentloaded", timeout: 20000 });
    await gpage.waitForFunction(() => window.__CLONER_STREAMS_DONE === true, null, { timeout: 25000 });
    const st = await gpage.evaluate(() => ({
      value: document.getElementById("value").textContent,
      state: document.getElementById("status").getAttribute("data-stream-state"),
      held: document.getElementById("status").getAttribute("data-stream-held"),
      log: window.__CLONER_STREAM_LOG,
      net: window.__NET_CALLS,
    }));
    check("G: zero network calls in the held-scenario clone", st.net.fetch === 0 && st.net.xhr === 0 && st.net.ws === 0);
    check("G: all 6 values applied in order (delayed ones included)", st.value === "6", st.value);
    const updates = st.log.filter((e) => e.type === "update").map((e) => e.value);
    check("G: update values applied in the recorded order 1..6", JSON.stringify(updates) === JSON.stringify([1, 2, 3, 4, 5, 6]), updates.join(","));
    const logTypes = st.log.map((e) => `${e.type}${e.type === "update" ? ":" + e.value : e.type === "state" ? ":" + e.value : e.type === "flush" ? ":" + e.count : ""}`);
    const idxOf = (pred) => st.log.findIndex(pred);
    const recIdx = idxOf((e) => e.type === "state" && e.value === "connected" && e.t === 900); // the reconnect entry
    const upd2Idx = idxOf((e) => e.type === "update" && e.value === 2);
    const upd3Idx = idxOf((e) => e.type === "update" && e.value === 3);
    check("G: held updates flush AFTER the reconnect state entry, in original order",
      recIdx >= 0 && upd2Idx > recIdx && upd3Idx > upd2Idx, logTypes.join(" | "));
    check("G: reconnect rendered held-count 2, resume rendered held-count 1",
      st.log.some((e) => e.type === "flush" && e.count === 2) && st.log.some((e) => e.type === "flush" && e.count === 1) && st.held === "1", `final held=${st.held}`);
    check("G: paused state rendered then resumed to connected",
      st.log.some((e) => e.type === "state" && e.value === "paused") && st.state === "connected", st.state);
  } finally {
    await browser3.close().catch(() => {});
  }
} catch (e) {
  check("G: held-scenario run completed", false, String((e && e.stack) || e).slice(0, 300));
}

// ============================== H. hygiene + polling fallback ==============================
console.log("\n== H. hygiene + polling fallback ==");
{
  // credential scan over every JSON this test produced
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".json")) {
        const text = fs.readFileSync(full, "utf8");
        if (CRED_KEY_RE.test(text) || CRED_VALUE_RE.test(text)) offenders.push(path.relative(TMP, full));
      }
    }
  };
  walk(TMP);
  check("H: no credential-shaped keys/values in any produced JSON", offenders.length === 0, offenders.join(", ") || "clean");

  // direct HTTP sanity of the fixture polling endpoints (no browser)
  const snap = await (await fetch(fxServer.base + "/api/snapshot")).json();
  check("H: /api/snapshot returns the quote map", snap.quotes && snap.quotes.AAPL && typeof snap.quotes.AAPL.price === "number", `AAPL=${snap.quotes.AAPL.price}`);
  const q1 = await (await fetch(fxServer.base + "/api/quotes?seq=1")).json();
  check("H: /api/quotes?seq=1 serves all symbols", SYMBOLS.every((s) => q1.quotes[s]), Object.keys(q1.quotes).join(","));
  const q6 = await fetch(fxServer.base + "/api/quotes?seq=6");
  check("H: outage window returns 503", q6.status === 503, String(q6.status));
  const q9 = await (await fetch(fxServer.base + "/api/quotes?seq=9")).json();
  check("H: polling timeline ends with done", q9.done === true, JSON.stringify(q9).slice(0, 80));

  // the site object served WITHOUT upgrade handling → page falls back to polling
  const pollServer = await startFixtureServer(tickerStreamSite);
  let pollBrowser = null;
  try {
    pollBrowser = await chromium.launch({ headless: true });
    const pctx = await pollBrowser.newContext();
    const ppage = await pctx.newPage();
    await ppage.goto(pollServer.base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
    await ppage.waitForFunction(() => window.__FIXTURE_DONE === true, null, { timeout: 25000 });
    const st = await ppage.evaluate(() => ({ wsUsed: window.__WS_USED, seq: document.getElementById("seq-counter").textContent, statusLog: window.__STATUS_LOG }));
    check("H: polling fallback completes the timeline without WebSocket", st.wsUsed === false && st.seq !== "0", `wsUsed=${st.wsUsed} seq=${st.seq}`);
    check("H: polling fallback observed the simulated outage", st.statusLog.includes("disconnected"), st.statusLog.join(" → "));
  } finally {
    if (pollBrowser) await pollBrowser.close().catch(() => {});
    await pollServer.close();
  }
}

await fxServer.close();
fs.rmSync(TMP, { recursive: true, force: true });

const totalS = "n/a (see section timings above)";
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
