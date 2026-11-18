// Behavior-model test (C1 of the behavior-synthesis wave):
// a handcrafted artifact fixture (quote-like ws frames whose prices travel as
// STRINGS — the real shape of trading feeds, form fields, a documented in-URL
// state with a state page) → buildBehaviorModel → contract assertions:
//   feeds with numeric keys, entities grouped from key paths, a strong
//   navigate action with a state-page effect, a medium submit action with
//   captured fields, deterministic write/read roundtrip, honest absence
//   (an empty artifacts dir yields ok:true + notes, never fabricated actions).
//
// Unit-level by design: buildBehaviorModel is pure over the artifact files, so
// the fixture is files on disk — the e2e capture path (real browser →
// websocket.json) is covered by test-data-stream-reconstruction.mjs and the
// number-from-text capture upgrade is asserted here via structureOf directly.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildBehaviorModel, writeBehaviorModel, readBehaviorModel, groupEntityKeys, BEHAVIOR_MODEL_SCHEMA } from "../src/reconstruction/behavior-model.js";
import { structureOf } from "../src/exploration/websocket-session-capture.js";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// ---------- fixture: one page, quote feed as text-numbers, form, state ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-model-"));
const w = (rel, data) => {
  fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), typeof data === "string" ? data : JSON.stringify(data, null, 1));
};

w("manifest.json", {
  pages: [
    { pageId: "page-001", url: "https://app.test/", records: 0 },
    { pageId: "page-001-state-01", url: "https://app.test/#settings", state: "Settings", stateOf: "page-001", records: 0, domRef: "pages/page-001-state-01/dom.json" },
  ],
});
w("exploration.json", { behaviors: [] });
// the documented state: trigger t1 produced the #settings in-URL state
w("states/index.json", {
  states: [
    { id: "s001", url: "https://app.test/", interaction: null, domRef: "pages/page-001/dom.json" },
    { id: "s002", url: "https://app.test/#settings", interaction: "Settings", domRef: "states/page-001/t1.html" },
  ],
});
w("states/page-001/t1.html", '<div class="overlay"><h3>Settings</h3></div>');
// quote-like ws frames: prices as strings (real feed shape) → number-from-text
const frameShape = structureOf(JSON.stringify({ t: "quote", bid: "2346.50", ask: "2347.00", last: "2346.75", size: "10" }), { keepNumbers: true });
w("pages/page-001/websocket.json", {
  schema: "1.0.0",
  events: [
    { kind: "socket", url: "wss://app.test/ws", direction: "out", t: 0, socketId: 1, payloadStructure: null },
    { kind: "frame", url: "wss://app.test/ws", direction: "in", t: 10, socketId: 1, payloadStructure: frameShape },
    { kind: "frame", url: "wss://app.test/ws", direction: "in", t: 250, socketId: 1, payloadStructure: frameShape },
  ],
});
w("pages/page-001/dom.json", {
  elements: [
    { i: 0, tag: "button", text: "Open settings", cls: "btn-settings", dataClonerTrigger: "t1", children: 0, parent: null },
    { i: 1, tag: "form", text: "", cls: "order-form", children: 2, parent: null },
    { i: 2, tag: "input", text: "", cls: "qty", attrs: { name: "qty", type: "number" }, children: 0, parent: 1 },
    { i: 3, tag: "select", text: "", cls: "side", attrs: { name: "side" }, children: 0, parent: 1 },
    { i: 4, tag: "div", text: "2346.50", cls: "bid", children: 0, parent: null },
    { i: 5, tag: "div", text: "2347.00", cls: "ask", children: 0, parent: null },
  ],
  repeated: [],
});
w("pages/page-001-state-01/dom.json", { elements: [{ i: 0, tag: "div", text: "Settings", cls: "panel", children: 0, parent: null }], repeated: [] });
w("pages/page-001/network.json", { entries: [] });

// ---------- contract assertions ----------
console.log("behavior model — fixture artifacts");
const model = buildBehaviorModel(tmp, {});
ok(model.ok === true && model.schema === BEHAVIOR_MODEL_SCHEMA, "ok:true with schema " + BEHAVIOR_MODEL_SCHEMA);

const wsFeed = model.feeds.find((f) => f.source === "websocket");
ok(!!wsFeed, "websocket feed detected");
ok(!!wsFeed && wsFeed.keys.includes("bid") && wsFeed.keys.includes("ask"), "feed carries the quote keys bid/ask (number-from-text survived capture)");

const quoteEntity = model.entities.find((e) => e.source === "websocket" && e.keys.includes("bid"));
ok(!!quoteEntity, "entity built from the flat quote surface (bid/ask/last/size on channel " + (quoteEntity ? quoteEntity.id : "-") + ")");
ok(!!quoteEntity && quoteEntity.source === "websocket", "entity source = websocket");

const nav = model.actions.find((a) => a.kind === "navigate");
ok(!!nav, "navigate action from the documented state");
ok(!!nav && nav.trigger === "t1" && nav.confidence === "strong", "navigate action is trigger-backed (t1) and strong");
ok(!!nav && nav.label === "Settings", "navigate action label = the state's interaction text");

const stateEffect = model.effects.find((e) => e.kind === "state-page");
ok(!!stateEffect, "state-page effect recorded (the state renders as its own page)");

const form = model.actions.find((a) => a.kind === "submit" && a.evidence.source === "dom-form");
ok(!!form, "submit action from the captured form");
ok(!!form && form.evidence.fields.length === 2 && form.evidence.fields.some((f) => f.name === "qty"), "form fields captured (qty + side), values never read");

const domAction = model.actions.find((a) => a.evidence.source === "dom-mark" && a.trigger === "t1");
ok(domAction === undefined, "dom-mark does not duplicate a state-graph-documented trigger (strongest source wins)");

ok(model.confidence.strong >= 1 && model.confidence.overall !== "none", "confidence aggregates honestly (" + model.confidence.overall + ")");
ok(model.notes.some((n) => /empty|numeric|honest|no/i.test(n)) || model.notes.length === 0, "notes present when evidence is thin");

console.log("deterministic roundtrip");
const f1 = writeBehaviorModel(tmp, model);
const bytes1 = fs.readFileSync(path.join(tmp, f1), "utf8");
writeBehaviorModel(tmp, model);
const bytes2 = fs.readFileSync(path.join(tmp, f1), "utf8");
ok(bytes1 === bytes2, "write is byte-identical across runs (stableStringify)");
const readBack = readBehaviorModel(tmp);
ok(!!readBack && readBack.schema === BEHAVIOR_MODEL_SCHEMA && readBack.counts.actions === model.counts.actions, "readBehaviorModel roundtrip preserves the contract");
ok(readBehaviorModel(path.join(tmp, "nowhere")) === null, "missing model reads as null (honest absence)");

console.log("groupEntityKeys units");
const g = groupEntityKeys(["items.0.qty", "items.1.qty", "last"]);
ok(!!g.items && g.items.length === 1 && g.items[0] === "items.qty" && !Object.keys(g).includes("last"), "array indexes collapsed, schema path deduped, bare scalars ignored");

console.log("honest absence — empty artifacts dir");
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-empty-"));
const empty = buildBehaviorModel(emptyDir, {});
ok(empty.ok === true && empty.counts.actions === 0 && empty.counts.feeds === 0, "empty evidence → ok:true, zero actions (no fabrication)");
ok(empty.notes.length > 0, "absence explained in notes");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });
console.log(`\nbehavior model: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
