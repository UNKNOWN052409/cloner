// Behavior store + verification e2e (C2 + C4 of the behavior-synthesis wave):
// a minimal clone fixture (order form + trigger button + a feed-bound element)
// + a behavior-model.json contract → augmentProjectWithStore → the generated
// runtime/store.js linked into the clone → runBehaviorVerification (real
// headless Chromium) asserts the mechanical 100% gate:
//   store live with model counts, feed keys drift after the tape window,
//   a trigger click lands a submit delta in __CLONER_STORE_LOG (rows grow,
//   user input captured), log entries carry t + delta.
// Honest-absence cases: no contract on disk → contract skip; empty model →
// store not emitted with an honest note.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { augmentProjectWithStore, buildStoreRuntime } from "../src/reconstruction/generation/store-generator.js";
import { runBehaviorVerification, summarizeBehaviorVerification } from "../src/reconstruction/verify-behavior.js";
import { writeBehaviorModel } from "../src/reconstruction/behavior-model.js";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-store-"));
const cloneDir = path.join(tmp, "clone");
const artifactsDir = path.join(tmp, "artifacts");
fs.mkdirSync(path.join(cloneDir, "runtime"), { recursive: true });
fs.mkdirSync(artifactsDir, { recursive: true });

fs.writeFileSync(
  path.join(cloneDir, "index.html"),
  `<!DOCTYPE html><html><head><title>fixture</title></head><body>
  <form class="order-form">
    <input name="qty" type="number" value="5">
    <select name="side"><option>BUY</option><option>SELL</option></select>
    <button data-cloner-trigger="t9" type="button">Place order</button>
  </form>
  <div class="bid" data-stream-target="ws.bid">—</div>
  </body></html>`,
);

const model = {
  ok: true,
  schema: "1.0.0",
  feeds: [{ id: "ws", source: "websocket", url: "wss://app.test/ws", keys: ["ask", "bid"], numeric: true }],
  entities: [{ id: "ws", kind: "structure", source: "websocket", keys: ["ask", "bid"], urls: ["wss://app.test/ws"] }],
  actions: [{ id: "a-form-page-001", kind: "submit", trigger: "t9", label: "Place order", evidence: { source: "dom-form", pageId: "page-001", fields: [{ tag: "input", name: "qty", type: "number" }, { tag: "select", name: "side" }] }, confidence: "medium" }],
  effects: [{ actionId: "a-form-page-001", kind: "submit", target: "page-001", detail: "2 captured field(s)" }],
  channels: {},
  counts: { feeds: 1, entities: 1, actions: 1, effects: 1, wiredSurfaces: 0 },
  confidence: { strong: 0, medium: 1, weak: 0, overall: "medium" },
  notes: [],
};
writeBehaviorModel(artifactsDir, model);

console.log("store generation");
const aug = augmentProjectWithStore(cloneDir, model, { artifactsDir, pages: ["index.html"] });
ok(aug.applied === true && aug.linked === 1, "store runtime emitted + linked into the clone page");
ok(fs.existsSync(path.join(cloneDir, "runtime", "store.js")), "runtime/store.js exists on disk");
ok(fs.readFileSync(path.join(cloneDir, "index.html"), "utf8").includes('runtime/store.js'), "clone page carries the store script tag");
const rt = buildStoreRuntime(model);
ok(/mulberry32|6D2B79F5/.test(rt) && /__CLONER_STORE_LOG/.test(rt), "runtime embeds deterministic PRNG + the C4 log surface");

console.log("behavior verification (headless chromium)");
const report = await runBehaviorVerification(cloneDir, artifactsDir);
const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
ok(byId["store-live"]?.result === "pass", "store-live: " + (byId["store-live"]?.detail || "").slice(0, 80));
ok(byId["feed-continuation"]?.result === "pass", "feed-continuation: " + (byId["feed-continuation"]?.detail || "").slice(0, 100));
ok(byId["dispatch-t9"]?.result === "pass", "dispatch-t9: " + (byId["dispatch-t9"]?.detail || "").slice(0, 110));
ok(byId["log-honesty"]?.result === "pass", "log-honesty: " + (byId["log-honesty"]?.detail || ""));
ok(report.ok === true, "overall behavior gate: ok=true");
const summary = summarizeBehaviorVerification(report);
ok(summary.ok === true && summary.model.feeds === 1 && summary.model.actions === 1, "battery summary carries the model counts");

console.log("honest absence");
fs.rmSync(path.join(artifactsDir, "behavior-model.json"));
const noModel = await runBehaviorVerification(cloneDir, artifactsDir);
ok(noModel.checks[0]?.id === "contract" && noModel.checks[0]?.result === "skip", "no contract on disk → honest contract skip");
const emptyModel = { ...model, feeds: [], entities: [], actions: [], counts: { feeds: 0, entities: 0, actions: 0, effects: 0, wiredSurfaces: 0 } };
const augEmpty = augmentProjectWithStore(cloneDir, emptyModel, { artifactsDir, pages: ["index.html"] });
ok(augEmpty.applied === false && augEmpty.notes.some((n) => /honest skip/i.test(n)), "empty model → store not emitted (honest skip note)");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nbehavior store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
