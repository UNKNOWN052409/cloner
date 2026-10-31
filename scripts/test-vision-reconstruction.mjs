// Vision-assisted reconstruction tests (task 3.3.5) — ZERO NETWORK by default.
//
// What is verified (all deterministic, no live API):
//  1. classifyAmbiguous finds exactly the ambiguous containers in a synthetic
//     elements+layout input (built against the REAL analyzeLayout) — a
//     layout-uncertain nav and a repeated-group container, and never consults
//     strong containers (control: a well-formed form).
//  2. Strong DOM evidence is preserved: an injected vision verdict ("table"@0.9)
//     does NOT override nav@0.9 DOM evidence.
//  3. Weak DOM + strong vision flips: unknown@0.3 + card-grid@0.92 → card-grid
//     with source "vision".
//  4. No-provider path is deterministic: no visionFn + config pinned to
//     provider "none" → every classification keeps the DOM verdict with the
//     vision side reported as unknown@0 — and NO fetch is ever attempted
//     (globalThis.fetch is replaced by a recording tripwire for the whole run).
//  5. mergeVerdicts respects the documented thresholds (including boundaries
//     0.5 and 0.7) as a pure function.
//  6. mergeVisionIntoLayout annotates layout records additively — unclassified
//     entries keep object identity, null layout records stay null.
//  7. parseVisionVerdict strict-JSON handling (fences, prose, invalid shapes).
//
// Optional live smoke (OFF by default so the default run never touches the
// network): set CLONER_VISION_SMOKE=1 AND have a vision key configured in
// cloner.config.json — classifies a real artifact screenshot's ambiguous
// regions through the real model router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeLayout } from "../src/reconstruction/analysis/layout-analyzer.js";
import {
  classifyAmbiguous, mergeVisionIntoLayout, mergeVerdicts, askVision, parseVisionVerdict,
  findAmbiguousContainers, DOM_OVERRIDE_FLOOR, VISION_MIN_CONFIDENCE, COMPONENT_KINDS,
} from "../src/reconstruction/vision-assist.js";

const ROOT = path.resolve(".");
let pass = 0, fail = 0, smoke = "skipped";
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- zero-network tripwire: any attempted fetch is recorded and fails the run ----
const fetchAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetchAttempts.push(String(args[0]));
  return Promise.reject(new Error("NETWORK_BLOCKED_BY_TEST"));
};

const NO_CFG = { model: { provider: "none" } }; // deterministic: getProviders → [], no fetch

// ---- synthetic captured-elements input (mirrors dom.json element shape) ----
const mk = (i, tag, cls, rect, extra = {}) => ({
  i, tag, cls: cls || null, role: null, id: null, parent: null, children: 0,
  text: null, rect, layout: null, style: {}, ...extra,
});
const elements = [
  // container A: nav with STRONG DOM kind but weak/uncertain layout (display block)
  mk(0, "nav", "topbar", { x: 0, y: 0, w: 1200, h: 64 }, { layout: { display: "block" } }),
  mk(1, "a", "link", { x: 10, y: 20, w: 60, h: 24 }, { parent: 0 }),
  mk(2, "a", "link", { x: 80, y: 20, w: 60, h: 24 }, { parent: 0 }),
  mk(3, "a", "link", { x: 150, y: 20, w: 60, h: 24 }, { parent: 0 }),
  // container B: repeated-group parent (3× .panel-item) with NO semantic class hint
  mk(4, "div", "wrap-zone", { x: 0, y: 100, w: 1200, h: 400 }, { layout: { display: "flex" } }),
  mk(5, "div", "panel-item", { x: 0, y: 110, w: 380, h: 380 }, { parent: 4 }),
  mk(6, "div", "panel-item", { x: 410, y: 110, w: 380, h: 380 }, { parent: 4 }),
  mk(7, "div", "panel-item", { x: 820, y: 110, w: 380, h: 380 }, { parent: 4 }),
  // control: strong form container (flex-declared) — must never be asked about
  mk(8, "form", "signup", { x: 0, y: 520, w: 600, h: 300 }, { layout: { display: "flex" } }),
  mk(9, "input", "field", { x: 10, y: 540, w: 280, h: 32 }, { parent: 8 }),
  mk(10, "button", "submit", { x: 300, y: 540, w: 80, h: 32 }, { parent: 8 }),
];
// real analyzer output (the pipeline builds layoutByIndex exactly this way)
const rectMap = new Map(elements.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
const layoutByIndex = new Map();
for (const el of elements) layoutByIndex.set(el.i, analyzeLayout(elements, rectMap)[el.i] || null);

// 1x1 transparent PNG so classifyAmbiguous exercises the real screenshot read path
const tmpShot = path.join(os.tmpdir(), "vision-assist-test-shot.png");
fs.writeFileSync(tmpShot, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
));

console.log("\n[1] ambiguity detection (real analyzeLayout output)");
{
  const amb = findAmbiguousContainers(elements, layoutByIndex);
  check("exactly two ambiguous containers", amb.length === 2, amb.map((a) => a.el.i).join(","));
  check("nav container ambiguous via uncertain layout (conf " + layoutByIndex.get(0)?.confidence + ", uncertain=" + layoutByIndex.get(0)?.uncertain + ")", amb.some((a) => a.el.i === 0 && a.layout?.uncertain === true));
  check("repeated-group container ambiguous via unclear kind", amb.some((a) => a.el.i === 4 && a.repeated === true && a.dom.kind === "unknown"));
  check("strong form container NOT ambiguous", !amb.some((a) => a.el.i === 8));
  const formLayout = layoutByIndex.get(8);
  check("control's layout really is strong (guards the test itself)", formLayout?.confidence >= DOM_OVERRIDE_FLOOR && formLayout?.uncertain === false);
  check("kind vocabulary fixed", JSON.stringify(COMPONENT_KINDS) === JSON.stringify(["nav", "table", "chart", "card-grid", "form", "sidebar", "unknown"]));
}

console.log("\n[2] injected vision: strong DOM preserved, weak DOM flips");
{
  const asked = [];
  const visionFn = async (region, imageBase64, ctx) => {
    asked.push({ index: ctx.index, region, imageBytes: imageBase64.length });
    if (ctx.index === 0) return { kind: "table", confidence: 0.9, reason: "mock: looks like rows" };
    if (ctx.index === 4) return { kind: "card-grid", confidence: 0.92, reason: "mock: three repeated tiles" };
    return null;
  };
  const res = await classifyAmbiguous(elements, layoutByIndex, tmpShot, { visionFn, cfg: NO_CFG });
  check("screenshot read and passed to the model", res.screenshotFound === true);
  check("exactly one ask per ambiguous container", asked.length === 2, asked.map((a) => a.index).join(","));
  check("full image + region coords passed (no cropping needed)", asked.every((a) => a.imageBytes > 0 && Number.isFinite(a.region.x)), asked.map((a) => JSON.stringify(a.region)).join(" "));
  const nav = res.byIndex.get(0);
  check("STRONG DOM evidence preserved (nav stays nav despite vision table@0.9)", nav.kind === "nav" && nav.source === "dom" && nav.confidence === 0.9, JSON.stringify({ kind: nav.kind, source: nav.source }));
  const grid = res.byIndex.get(4);
  check("WEAK DOM + strong vision flips to vision kind (card-grid@0.92)", grid.kind === "card-grid" && grid.source === "vision" && grid.confidence === 0.92, JSON.stringify({ kind: grid.kind, source: grid.source, conf: grid.confidence }));
  check("visionUsed reported", res.visionUsed === true);
  check("no fetch attempted with injected visionFn", fetchAttempts.length === 0);
}

console.log("\n[3] no-provider deterministic fallback (keeps DOM-only)");
{
  const res = await classifyAmbiguous(elements, layoutByIndex, tmpShot, { cfg: NO_CFG });
  check("both ambiguous containers still classified", res.byIndex.size === 2);
  for (const c of res.classifications) {
    check(`#${c.i} keeps DOM verdict (vision unknown@0)`, c.visionKind === "unknown" && c.visionConfidence === 0 && c.source === "dom" && c.kind === c.domKind,
      `dom=${c.domKind}@${c.domConfidence} vision=${c.visionKind}@${c.visionConfidence} final=${c.kind}(${c.source})`);
  }
  check("askVision returns null with provider none (no fetch, no throw)", (await askVision({ x: 0, y: 0, w: 100, h: 50 }, "aGk=", { cfg: NO_CFG })) === null);
  check("askVision returns null for missing image", (await askVision({ x: 0, y: 0, w: 100, h: 50 }, "", { cfg: NO_CFG })) === null);
  check("still zero fetch attempts", fetchAttempts.length === 0);
}

console.log("\n[4] missing screenshot → DOM-only, visionFn never called");
{
  let called = 0;
  const visionFn = async () => { called++; return { kind: "nav", confidence: 0.99 }; };
  const res = await classifyAmbiguous(elements, layoutByIndex, path.join(os.tmpdir(), "definitely-missing-shot.png"), { visionFn, cfg: NO_CFG });
  check("no screenshot → no vision ask", res.screenshotFound === false && called === 0);
  check("classifications still produced (DOM-only)", res.byIndex.size === 2 && res.visionUsed === false);
}

console.log("\n[5] mergeVerdicts threshold contract (pure function)");
{
  const cases = [
    ["strong DOM beats confident vision", "nav", 0.9, "card-grid", 0.95, "nav", "dom"],
    ["weak DOM + strong vision flips", "unknown", 0.3, "card-grid", 0.9, "card-grid", "vision"],
    ["vision below 0.7 never wins", "unknown", 0.3, "card-grid", 0.69, "unknown", "dom"],
    ["boundary: domConfidence 0.5 is NOT overridable (strict <)", "unknown", 0.5, "card-grid", 0.9, "unknown", "dom"],
    ["boundary: visionConfidence 0.7 suffices (>=)", "unknown", 0.4, "table", 0.7, "table", "vision"],
    ["vision 'unknown' never overrides", "unknown", 0.3, "unknown", 0.99, "unknown", "dom"],
    ["no DOM evidence at all + confident vision", null, 0, "sidebar", 0.7, "sidebar", "vision"],
    ["invalid DOM kind treated as unknown", "banner", 0.4, "form", 0.8, "form", "vision"],
    ["no DOM evidence + weak vision keeps DOM side", null, 0, "chart", 0.5, "unknown", "dom"],
  ];
  for (const [name, dk, dc, vk, vc, ek, es] of cases) {
    const m = mergeVerdicts(dk, dc, vk, vc);
    check(name, m.kind === ek && m.source === es, JSON.stringify(m));
  }
  check("threshold constants are the documented ones", DOM_OVERRIDE_FLOOR === 0.5 && VISION_MIN_CONFIDENCE === 0.7);
}

console.log("\n[6] mergeVisionIntoLayout — additive annotation of the layout map");
{
  const asked = [];
  const visionFn = async (region, imageBase64, ctx) => {
    asked.push(ctx.index);
    if (ctx.index === 0) return { kind: "table", confidence: 0.9, reason: "mock: dense rows" };
    if (ctx.index === 4) return { kind: "card-grid", confidence: 0.92, reason: "mock: three repeated tiles" };
    return null;
  };
  const vision = await mergeVisionIntoLayout(layoutByIndex, elements, tmpShot, { visionFn, cfg: NO_CFG });
  const navRec = vision.layoutByIndex.get(0);
  const gridRec = vision.layoutByIndex.get(4);
  const untouched = vision.layoutByIndex.get(8);
  check("nav record annotated, kind still nav (source dom)", navRec.componentKind === "nav" && navRec.componentSource === "dom");
  check("original layout fields intact on annotated records", navRec.kind === "row" && navRec.gapPx !== undefined);
  check("grid record annotated from vision", gridRec.componentKind === "card-grid" && gridRec.componentSource === "vision");
  check("unclassified record keeps object identity (additive)", untouched === layoutByIndex.get(8) && untouched.componentKind === undefined);
  check("null layout records stay null (no fake records)", vision.layoutByIndex.get(5) === null);
  check("full detail still available via byIndex", vision.byIndex.get(4).visionReason === "mock: three repeated tiles");
  check("hook returns a Map of the same size", vision.layoutByIndex.size === layoutByIndex.size);
}

console.log("\n[7] parseVisionVerdict strict-JSON handling");
{
  const v1 = parseVisionVerdict('```json\n{"kind":"nav","confidence":0.8,"reason":"top bar"}\n```');
  check("markdown-fenced JSON parsed", v1?.kind === "nav" && v1.confidence === 0.8);
  const v2 = parseVisionVerdict('Sure! {"kind":"chart","confidence":0.55,"reason":"bars"} hope that helps');
  check("prose-wrapped JSON parsed", v2?.kind === "chart");
  check("invalid kind rejected", parseVisionVerdict('{"kind":"banner","confidence":0.9}') === null);
  check("out-of-range confidence rejected", parseVisionVerdict('{"kind":"nav","confidence":1.5}') === null);
  check("negative confidence rejected", parseVisionVerdict('{"kind":"nav","confidence":-0.1}') === null);
  check("confidence 0 accepted (deterministic fallback shape)", parseVisionVerdict('{"kind":"table","confidence":0}')?.confidence === 0);
  check("non-JSON rejected", parseVisionVerdict("no json here") === null);
  check("empty rejected", parseVisionVerdict("") === null);
}

// ---- optional live smoke: explicitly opted in, uses real key + real artifact ----
if (process.env.CLONER_VISION_SMOKE === "1") {
  globalThis.fetch = realFetch; // restore real transport for the smoke only
  console.log("\n[8] live smoke (opt-in via CLONER_VISION_SMOKE=1)");
  const shots = fs.readdirSync(path.join(ROOT, "artifacts"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("exp-"))
    .map((e) => path.join(ROOT, "artifacts", e.name, "pages", "page-001", "screenshot-viewport.png"))
    .filter((p) => fs.existsSync(p));
  const { loadConfig } = await import("../src/config.js");
  const { getProviders } = await import("../src/platform/model-router.js");
  const providers = getProviders(loadConfig());
  if (!shots.length || !providers.length) {
    smoke = "skipped";
    console.log(`  SKIP live smoke: ${!shots.length ? "no artifact screenshot found" : "no vision key/provider configured"}`);
  } else {
    const shot = shots.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const jobDir = path.resolve(path.dirname(path.dirname(path.dirname(shot))));
    let els = [];
    try { els = JSON.parse(fs.readFileSync(path.join(jobDir, "pages", "page-001", "dom.json"), "utf8")).elements || []; } catch {}
    const rMap = new Map(els.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
    const lMap = new Map();
    for (const el of els) lMap.set(el.i, analyzeLayout(els, rMap)[el.i] || null);
    const res = await classifyAmbiguous(els, lMap, shot, { maxAsk: 2, timeoutMs: 90000 });
    const flipped = res.classifications.filter((c) => c.source === "vision");
    smoke = flipped.length ? "ok" : (res.classifications.length ? "no-flip" : "no-ambiguous");
    if (!res.classifications.length) {
      console.log(`  NOTE live smoke: no ambiguous regions found in ${path.basename(jobDir)} page-001 — nothing to classify (not a failure)`);
    } else {
      check("live smoke: classified real artifact screenshot", true, `${res.classifications.length} ambiguous region(s) in ${path.basename(jobDir)}`);
    }
    for (const c of res.classifications) {
      console.log(`    #${c.i} ${c.tag}.${c.cls || "-"} dom=${c.domKind}@${c.domConfidence} vision=${c.visionKind}@${c.visionConfidence} (provider: ${c.visionProvider || "-"}) → final=${c.kind}(${c.source})`);
    }
    check("live smoke: vision verdicts are parseable when present", res.classifications.every((c) => c.visionKind === "unknown" || COMPONENT_KINDS.includes(c.visionKind)));
  }
} else {
  console.log("\n[8] live smoke: SKIPPED (default — set CLONER_VISION_SMOKE=1 with a configured key to run)");
}

check("ZERO NETWORK: no fetch attempted during the deterministic suite", fetchAttempts.length === 0, fetchAttempts.length ? fetchAttempts.join("; ").slice(0, 200) : "0 attempts");

fs.rmSync(tmpShot, { force: true });
const resultPath = path.join(ROOT, "artifacts", "test-vision-reconstruction-result.json");
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify({ pass, fail, smoke, fetchAttempts: fetchAttempts.length }, null, 2));
console.log(`\n${pass} passed, ${fail} failed (live smoke: ${smoke})`);
process.exit(fail ? 1 : 0);
