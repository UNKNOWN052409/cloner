// Vision-assisted reconstruction (task 3.3.5): uses the exploration screenshots
// (artifacts/<jobId>/pages/<pageId>/screenshot-viewport.png) as ADDITIONAL
// evidence to improve component classification for AMBIGUOUS regions only.
//
// Hard contract:
//  - Vision NEVER overrides strong DOM/geometry evidence. mergeVerdicts() only
//    lets a vision verdict win when domConfidence < 0.5 AND visionConfidence >= 0.7
//    and the vision kind is concrete (not "unknown").
//  - Vision is never REQUIRED. With no provider/key/verdict everything falls back
//    deterministically to DOM-only classification ({ kind: "unknown", confidence: 0 }
//    for the vision side). Tests run with an injected mock visionFn and zero network.
//
// Coordinates: the DOM extractor captures getBoundingClientRect() (viewport CSS px,
// src/intelligence/dom-extractor.js) and the exploration pipeline screenshots the
// viewport (fullPage: false, src/pipeline/exploration-pipeline.js) — so element
// rects map 1:1 onto screenshot-viewport.png pixels at the default DPR 1. Pure-JS
// PNG cropping is NOT required: the full screenshot is sent to the model together
// with the region coordinates, and the prompt marks the region by its box.
import fs from "node:fs";
import { routeChat, getProviders } from "../platform/model-router.js";
import { loadConfig } from "../config.js";

// The component-kind vocabulary the vision model must pick from (strict JSON verdict).
export const COMPONENT_KINDS = ["nav", "table", "chart", "card-grid", "form", "sidebar", "unknown"];

// mergeVerdicts thresholds — documented, tested, and frozen by the task contract:
// vision wins ONLY when domConfidence < DOM_OVERRIDE_FLOOR AND visionConfidence >= VISION_MIN_CONFIDENCE.
export const DOM_OVERRIDE_FLOOR = 0.5;
export const VISION_MIN_CONFIDENCE = 0.7;

// Deterministic fallback verdict: whenever no provider/key/verdict is available the
// vision side reports this, and mergeVerdicts() then always keeps the DOM verdict.
export const FALLBACK_VERDICT = Object.freeze({
  kind: "unknown",
  confidence: 0,
  reason: "vision unavailable — deterministic fallback, DOM-only classification kept",
});

// Ask budget + region sanity: never interrogate the model for tiny/noise boxes, and
// cap the number of vision asks per call so a pathological page cannot explode cost.
const MAX_ASK_PER_CALL = 12;
const MIN_REGION_W = 40;
const MIN_REGION_H = 24;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// ---------- DOM-kind evidence (deterministic, no model involved) ----------

// Tokenize a class string so "contact_form" yields ["contact","form"] — substring
// matching would misfire on "platform".toLowerCase().split(...)
const clsTokens = (cls) => String(cls || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const tokenIn = (cls, words) => clsTokens(cls).some((t) => words.includes(t));

// DOM evidence for a component kind. Tag/role are strong (0.9); class-name hints are
// weaker (0.6-0.65) because class strings are stylistic. No evidence → kind "unknown"
// with a low confidence (0.3 for repeated-group members — repetition is itself weak
// structural evidence; 0.2 for plain containers). Layout confidence is deliberately
// NOT part of this score: analyzeLayout's flex/grid/row/column axis is orthogonal to
// the component-kind axis and is only used below for ambiguity DETECTION.
export function domKindOf(el, { repeatedGroup = false } = {}) {
  const tag = String(el.tag || "").toLowerCase();
  const role = String(el.role || "").toLowerCase();
  const cls = el.cls || "";
  if (tag === "nav" || role === "navigation") return { kind: "nav", confidence: 0.9, evidence: `tag=${tag} role=${role}` };
  if (tag === "table") return { kind: "table", confidence: 0.9, evidence: "tag=table" };
  if (tag === "canvas" || tag === "svg") return { kind: "chart", confidence: 0.9, evidence: `tag=${tag}` };
  if (tag === "form") return { kind: "form", confidence: 0.9, evidence: "tag=form" };
  if (tag === "aside" || role === "complementary") return { kind: "sidebar", confidence: 0.9, evidence: `tag=${tag} role=${role}` };
  if (tokenIn(cls, ["nav", "navbar", "navigation", "menu", "mainnav", "topnav"])) return { kind: "nav", confidence: 0.6, evidence: "class hint" };
  if (tokenIn(cls, ["table", "datatable", "datagrid", "data-grid"])) return { kind: "table", confidence: 0.6, evidence: "class hint" };
  if (tokenIn(cls, ["chart", "graph", "plot", "sparkline"])) return { kind: "chart", confidence: 0.6, evidence: "class hint" };
  if (tokenIn(cls, ["form", "fieldsets", "signup", "login", "checkout"])) return { kind: "form", confidence: 0.6, evidence: "class hint" };
  if (tokenIn(cls, ["sidebar", "sidepanel", "aside"])) return { kind: "sidebar", confidence: 0.6, evidence: "class hint" };
  // a container of repeated card/tile-like blocks is weakly a card-grid (0.65):
  // repetition plus a grid-ish class name is decent but not semantic evidence
  if (repeatedGroup && tokenIn(cls, ["card", "cards", "tile", "tiles", "grid", "products", "listings"])) {
    return { kind: "card-grid", confidence: 0.65, evidence: "class hint + repeated group" };
  }
  return { kind: "unknown", confidence: repeatedGroup ? 0.3 : 0.2, evidence: repeatedGroup ? "repeated group, no semantic hint" : "no semantic hint" };
}

// ---------- repeated-group detection (mirrors component-tree-builder's pass) ----------

// A repeated sibling group = elements sharing the same parent and the same trimmed
// class signature, with >= 3 members (same threshold as
// src/reconstruction/analysis/component-tree-builder.js walk()).
// Returns Map<elementIndex, { sig, siblings, parentIndex }>.
export function repeatedGroups(elements) {
  const out = new Map();
  const byParent = new Map();
  for (const el of elements) {
    const sig = String(el.cls || "").trim();
    if (!sig) continue;
    const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
    if (!byParent.has(p)) byParent.set(p, new Map());
    const sigs = byParent.get(p);
    if (!sigs.has(sig)) sigs.set(sig, []);
    sigs.get(sig).push(el);
  }
  for (const [parentIndex, sigs] of byParent) {
    for (const [sig, members] of sigs) {
      if (members.length < 3) continue;
      for (const m of members) out.set(m.i, { sig: sig.slice(0, 50), siblings: members.length, parentIndex });
    }
  }
  return out;
}

// ---------- ambiguity detection ----------

// layoutConfidenceUnknown(): which containers count as layout-ambiguous.
// The ask's literal rule is "confidence < 0.5 from analyzeLayout", but analyzeLayout's
// floor for any container with >= 2 measured children is 0.5 (base 0.4 + horizontal 0.1,
// src/reconstruction/analysis/layout-analyzer.js:20-22) — a literal "< 0.5" only ever
// selects null entries. So the honest low-confidence band is: no layout record at all,
// OR confidence < 0.5, OR the analyzer's own uncertainty flag (uncertain = conf < 0.6).
function layoutConfidenceUnknown(layout) {
  return !layout || !(layout.confidence >= DOM_OVERRIDE_FLOOR) || layout.uncertain === true;
}

function childCount(elements, index) {
  let n = 0;
  for (const el of elements) {
    if ((el.parent === null || el.parent === undefined ? -1 : el.parent) === index) n++;
  }
  return n;
}

// Find ambiguous containers: (a) containers whose layout record is missing or in the
// low-confidence band, OR (b) containers holding a repeated sibling group whose own
// DOM kind is unclear ("repeated-group members whose kind is unclear" — the container
// of the unclear members is the region worth classifying, e.g. a card grid).
// Returns [{ el, layout, dom, repeated }] sorted weakest-DOM-evidence first, capped.
export function findAmbiguousContainers(elements, layoutByIndex, { maxAsk = MAX_ASK_PER_CALL } = {}) {
  const layoutGet = (i) => (layoutByIndex instanceof Map ? layoutByIndex.get(i) : layoutByIndex?.[i]) ?? null;
  const repeated = repeatedGroups(elements);
  const ambiguous = [];
  for (const el of elements) {
    if (childCount(elements, el.i) < 2) continue; // containers only
    const rect = el.rect || {};
    if (!(rect.w >= MIN_REGION_W) || !(rect.h >= MIN_REGION_H)) continue; // noise boxes
    const repeatedChildren = [...repeated.values()].some((g) => g.parentIndex === el.i);
    const layout = layoutGet(el.i);
    const layoutAmbiguous = layoutConfidenceUnknown(layout);
    const dom = domKindOf(el, { repeatedGroup: repeatedChildren });
    const repeatedAmbiguous = repeatedChildren && dom.kind === "unknown";
    if (!layoutAmbiguous && !repeatedAmbiguous) continue;
    ambiguous.push({ el, layout, dom, repeated: repeatedChildren });
  }
  ambiguous.sort((a, b) => a.dom.confidence - b.dom.confidence || (a.layout?.confidence ?? 0) - (b.layout?.confidence ?? 0));
  return ambiguous.slice(0, maxAsk);
}

// ---------- vision ask (existing model-router pattern) ----------

const REGION_PROMPT = (region, extra) =>
  [
    "You are analyzing a web page screenshot to classify ONE UI region.",
    `The region of interest is the box at CSS-pixel coordinates relative to the top-left of this (viewport) screenshot: x=${region.x}, y=${region.y}, width=${region.w}, height=${region.h}.${extra || ""}`,
    "Look at that box (and enough surrounding context to understand its role).",
    "Classify what the region IS as a UI component. Respond with ONLY a JSON object — no prose, no markdown fences:",
    '{"kind":"nav|table|chart|card-grid|form|sidebar|unknown","confidence":0.0-1.0,"reason":"one short sentence"}',
    'kind meanings: nav=site/navigation bar, table=tabular data, chart=data visualization, card-grid=repeated card/tile blocks, form=input controls, sidebar=side panel, unknown=none of these or the region is not visible in the screenshot.',
  ].join("\n");

// Parse the model's strict-JSON verdict. Tolerates markdown fences / surrounding
// prose by slicing from the first "{" to the last "}". Invalid shape → null.
export function parseVisionVerdict(text, provider = null) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const kind = String(j.kind || "").toLowerCase();
  const confidence = Number(j.confidence);
  if (!COMPONENT_KINDS.includes(kind)) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { kind, confidence, reason: String(j.reason || "").slice(0, 300), provider: provider || null };
}

// askVision(region, imageBase64, opts) — one vision ask via the EXISTING model-router
// pattern (routeChat + getProviders, purpose "screenshot-classify" so vision-capable
// providers are preferred, src/platform/model-router.js:53-54). Config comes from
// opts.cfg when given, else loadConfig() (reads gitignored cloner.config.json when
// present; with no file and no env keys there is no provider). Returns the parsed
// verdict, or null when nothing is configured / the call fails / the verdict is
// unparsable — callers then apply the deterministic fallback. Never throws.
export async function askVision(region, imageBase64, opts = {}) {
  try {
    const cfg = opts.cfg || loadConfig();
    if (!region || !imageBase64) return null;
    // provider "none" is an explicit off-switch (matches the platform contract in
    // src/vision.js: "none (model-dependent steps are skipped gracefully)"). Checked
    // BEFORE getProviders because the router unconditionally appends env-key
    // providers (model-router.js:46-48) — honoring "none" here keeps the
    // no-provider path deterministic (and fetch-free) even on machines with
    // OPENAI_API_KEY / ANTHROPIC_API_KEY exported.
    if (cfg?.model?.provider === "none") return null;
    if (!getProviders(cfg).length) return null; // deterministic no-provider path — no fetch is attempted
    const dataUrl = String(imageBase64).startsWith("data:") ? String(imageBase64) : `data:image/png;base64,${imageBase64}`;
    const messages = [{
      role: "user",
      content: [
        { type: "image", dataUrl, mediaType: "image/png" },
        { type: "text", text: REGION_PROMPT(region, opts.regionNote || "") },
      ],
    }];
    const { out, provider } = await routeChat(cfg, messages, { maxTokens: 300, timeoutMs: opts.timeoutMs || 60000 }, "screenshot-classify");
    return parseVisionVerdict(out, provider);
  } catch {
    return null; // any provider/network/parse failure → deterministic fallback
  }
}

// Normalize an injected visionFn's result into a verdict or the deterministic
// fallback. The injectable contract (used by tests and by callers that already
// have a vision transport): async visionFn(region, imageBase64, ctx) =>
//   { kind, confidence, reason? } | null | anything invalid → FALLBACK_VERDICT.
async function resolveVerdict(visionFn, region, imageBase64, ctx) {
  if (!visionFn) return { verdict: FALLBACK_VERDICT, injected: false, provider: null };
  try {
    const raw = await visionFn(region, imageBase64, ctx);
    const parsed = raw && typeof raw === "object" ? parseVisionVerdict(JSON.stringify(raw)) : null;
    return { verdict: parsed || FALLBACK_VERDICT, injected: true, provider: "injected" };
  } catch {
    return { verdict: FALLBACK_VERDICT, injected: true, provider: "injected-error" };
  }
}

// ---------- merge rule (pure, documented) ----------

// mergeVerdicts(domKind, domConfidence, visionKind, visionConfidence) → { kind, confidence, source }.
//
// Merge rule: vision wins ONLY when BOTH hold —
//   1. domConfidence < DOM_OVERRIDE_FLOOR (0.5): the DOM/geometry evidence itself was
//      weak or unclear, so there is nothing strong to protect; AND
//   2. visionConfidence >= VISION_MIN_CONFIDENCE (0.7) AND visionKind is concrete
//      (i.e. not "unknown"): the model must be confident about a real kind.
// Every other combination keeps the DOM verdict ("the caller keeps DOM-only
// classification"). Boundaries: domConfidence === 0.5 → DOM wins (strict <);
// visionConfidence === 0.7 → vision may win (>=). A vision "unknown" or a
// sub-threshold confidence never overrides anything, and strong DOM evidence
// (confidence >= 0.5) is never overridden — vision is additional evidence for
// AMBIGUOUS regions, never a replacement for captured DOM/geometry truth.
export function mergeVerdicts(domKind, domConfidence, visionKind, visionConfidence) {
  const domValid = COMPONENT_KINDS.includes(domKind) && domKind !== "unknown";
  const dom = {
    kind: domValid ? domKind : "unknown",
    confidence: clamp01(domConfidence),
  };
  const visionUsable =
    COMPONENT_KINDS.includes(visionKind) && visionKind !== "unknown" &&
    clamp01(visionConfidence) >= VISION_MIN_CONFIDENCE &&
    clamp01(domConfidence) < DOM_OVERRIDE_FLOOR;
  if (visionUsable) return { kind: visionKind, confidence: clamp01(visionConfidence), source: "vision" };
  return { kind: dom.kind, confidence: dom.confidence, source: "dom" };
}

// ---------- classify + integrate ----------

// classifyAmbiguous(elements, layoutByIndex, screenshotPath, opts):
//  1. find ambiguous containers (findAmbiguousContainers),
//  2. read the screenshot once (element rects are viewport CSS px, matching the
//     viewport screenshot 1:1 at DPR 1),
//  3. for each ambiguous container pass { full image + region coords } to the
//     injected visionFn (or askVision via the model router when none is injected),
//  4. merge each verdict with the DOM verdict via mergeVerdicts.
//
// opts: { visionFn, cfg, maxAsk, regionNote, timeoutMs }
// Returns { screenshotFound, ambiguousCount, visionUsed, classifications, byIndex } —
// byIndex: Map<elementIndex, final { kind, confidence, source, domKind, domConfidence,
// visionKind, visionConfidence, reason }>.
export async function classifyAmbiguous(elements, layoutByIndex, screenshotPath, opts = {}) {
  const candidates = findAmbiguousContainers(elements, layoutByIndex, { maxAsk: opts.maxAsk });
  // read the screenshot once; missing screenshot → no asks, everything DOM-only
  let imageBase64 = null;
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    try { imageBase64 = fs.readFileSync(screenshotPath).toString("base64"); } catch { imageBase64 = null; }
  }
  const classifications = [];
  for (const { el, layout, dom, repeated } of candidates) {
    const region = { x: el.rect?.x ?? 0, y: el.rect?.y ?? 0, w: el.rect?.w ?? 0, h: el.rect?.h ?? 0 };
    const ctx = { index: el.i, tag: el.tag, cls: el.cls || null, layoutKind: layout?.kind || null, layoutConfidence: layout?.confidence ?? null, repeatedGroup: repeated, domKind: dom.kind, domConfidence: dom.confidence };
    let verdict = FALLBACK_VERDICT;
    let provider = null;
    if (imageBase64) {
      if (opts.visionFn) {
        const asked = await resolveVerdict(opts.visionFn, region, imageBase64, ctx);
        verdict = asked.verdict;
        provider = asked.provider || null;
      } else {
        const v = await askVision(region, imageBase64, { cfg: opts.cfg, regionNote: opts.regionNote, timeoutMs: opts.timeoutMs });
        if (v) { verdict = v; provider = v.provider || null; } // keep the router's provider name for provenance
      }
    }
    const merged = mergeVerdicts(dom.kind, dom.confidence, verdict.kind, verdict.confidence);
    classifications.push({
      i: el.i,
      tag: el.tag,
      cls: el.cls || null,
      rect: region,
      layoutKind: layout?.kind || null,
      layoutConfidence: layout?.confidence ?? null,
      domKind: dom.kind,
      domConfidence: dom.confidence,
      domEvidence: dom.evidence,
      visionKind: verdict.kind,
      visionConfidence: verdict.confidence,
      visionProvider: provider,
      visionReason: verdict.reason || "",
      kind: merged.kind,
      confidence: merged.confidence,
      source: merged.source,
    });
  }
  return {
    screenshotFound: !!imageBase64,
    ambiguousCount: candidates.length,
    visionUsed: classifications.some((c) => c.source === "vision"),
    classifications,
    byIndex: new Map(classifications.map((c) => [c.i, c])),
  };
}

// mergeVisionIntoLayout(layoutByIndex, elements, screenshotPath, opts) — the ONE-CALL
// integration hook for reconstructFromArtifacts (src/reconstruction/reconstruction-pipeline.js).
//
// Integration (one line after the per-page layoutByIndex is built, ~line 95):
//   const vision = await mergeVisionIntoLayout(layoutByIndex, lp.elements,
//     path.join(artifactsDir, "pages", lp.pageId, "screenshot-viewport.png"));
//   layoutByIndex = vision.layoutByIndex; // additive: unannotated entries are untouched
//
// Additive guarantee: entries whose layout record exists and were classified gain
// componentKind / componentConfidence / componentSource / componentReason fields;
// entries with a null layout record stay null (no fake records are invented — read
// the full classification from the returned byIndex/classifications instead), and
// every other entry is the SAME record object it came in as. Vision failures are
// non-fatal: the function never throws and always returns a usable layout map.
export async function mergeVisionIntoLayout(layoutByIndex, elements, screenshotPath, opts = {}) {
  const result = await classifyAmbiguous(elements, layoutByIndex, screenshotPath, opts);
  const classified = result.byIndex;
  const merged = new Map();
  const entries = layoutByIndex instanceof Map ? [...layoutByIndex.entries()] : Object.entries(layoutByIndex || {}).map(([k, v]) => [Number(k), v]);
  for (const [k, v] of entries) {
    const c = classified.get(Number(k));
    if (!c || !v) { merged.set(Number(k), v); continue; } // null records stay null — additive only
    merged.set(Number(k), {
      ...v,
      componentKind: c.kind,
      componentConfidence: c.confidence,
      componentSource: c.source,
      componentReason: c.visionReason || "",
    });
  }
  return { ...result, layoutByIndex: merged };
}
