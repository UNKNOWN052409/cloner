// Stateful widget builder (task 3.4.4, step 3): during reconstruction, detect
// LIVE-DATA widgets — tables with changing cells, counters, ticker elements —
// from dom.json evidence (element classes/ids/text + repeated groups) plus
// network JSON evidence (repeated JSON polling, WebSocket session capture) and
// wire them to stream channels for the data-stream-replayer.
//
// Detection is deterministic and evidence-weighted:
//   - structural evidence (tag=table, ticker/counter class tokens, numeric cell
//     text from dom.json leaf elements) gives the base confidence per kind;
//   - LIVE evidence (ws frames captured, or the same JSON endpoint polled >= 2x)
//     adds a boost — a widget without any live-data evidence is still reported,
//     at lower confidence, so the limitation stays honest;
//   - channel keys come from the capture's numeric leaf paths when available
//     (strings are redacted at capture time, so capture-derived wiring is
//     numeric-only by construction).
//
// Output (buildStreamPlan): the replayer channel specs + a byIndex wiring map
// (dom element index → "channel.key") that the generator renders as
// data-stream-target attributes.
//
// Integration hooks (applied by the integration agent, additive):
//  - exploration-pipeline.js writes the capture per page (one line, see
//    websocket-session-capture.js header) → pages/<pageId>/websocket.json.
//  - reconstruction-pipeline.js (after loaded/pages are read, before generation):
//      const streamPlan = buildStreamPlan(artifactsDir, {});
//  - project-generator.js: pass streamPlan through cssCtx as `streamByIndex`
//    (per page: streamPlan.byIndex.get(lp.pageId)) and render the attr
//    (see data-stream-replayer.js header for the renderNode line).
import fs from "node:fs";
import path from "node:path";
import {
  flattenNumericStructure,
  sequenceFromCapture,
  stableStringify,
} from "../exploration/websocket-session-capture.js";
import { sanitizeChannelId } from "./data-stream-replayer.js";

const TICKER_TOKENS = ["ticker", "quote", "quotes", "price", "symbol", "rate", "fx", "ccy"];
const COUNTER_TOKENS = ["counter", "count", "stat", "total", "seq", "tick"];
const TABLE_TOKENS = ["table", "datagrid", "data-grid", "quotes", "market"];

const POLL_MIN_HITS = 2; // same JSON endpoint hit >= 2x → polling live evidence

// ---------- text / token helpers (deterministic) ----------

export function classTokens(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function tokensOf(el) {
  return [...classTokens(el.cls), ...classTokens(el.id)];
}

function hasAnyToken(el, tokens) {
  const t = tokensOf(el);
  return tokens.some((w) => t.includes(w));
}

// "1,234.5" / "$101.20" / "+0.10" / "-3%" → true; anything with letters → false.
export function isNumericText(text) {
  const t = String(text ?? "")
    .trim()
    .replace(/^[$€£]/, "")
    .replace(/%$/, "")
    .replace(/[,\s]/g, "");
  return t !== "" && /^[+-]?\d+(\.\d+)?$/.test(t);
}

const clamp = (n) => Math.max(0, Math.min(0.99, n));

// ---------- live-data evidence ----------

// Network JSON polling: entries with a JSON content type fetched from the same
// pathname >= POLL_MIN_HITS times. Returns [{ path, hits }] (descending hits).
export function pollingPaths(networkEntries) {
  const byPath = new Map();
  for (const n of Array.isArray(networkEntries) ? networkEntries : []) {
    if (!n || typeof n.url !== "string") continue;
    if (!/json/i.test(String(n.contentType || ""))) continue;
    const rt = String(n.resourceType || "").toLowerCase();
    if (rt && !/fetch|xhr|other/.test(rt)) continue;
    let p;
    try { p = new URL(n.url).pathname; } catch { continue; }
    byPath.set(p, (byPath.get(p) || 0) + 1);
  }
  return [...byPath.entries()]
    .filter(([, hits]) => hits >= POLL_MIN_HITS)
    .map(([p, hits]) => ({ path: p, hits }))
    .sort((a, b) => b.hits - a.hits);
}

export function channelFromUrl(url) {
  // last path segment, slugified — kept in sync with sequenceFromCapture's
  // urlChannelId (websocket-session-capture.js) so wiring targets and runtime
  // channel ids always agree
  try {
    const u = new URL(String(url));
    const seg = u.pathname.split("/").filter(Boolean).pop() || "ws";
    return sanitizeChannelId(seg);
  } catch {
    return "ws";
  }
}

function slugPath(p) {
  return sanitizeChannelId(String(p || "").replace(/^\//, "").replace(/[/_]+/g, "-")) || "stream";
}

// ---------- detection ----------

// detectLiveWidgets({ pageId, elements, repeated, networkEntries, wsEvents }, opts)
// → { widgets, channels, liveEvidence }.
// widgets: [{ kind, elIndex, confidence, evidence[], channel, keys[] }]
// channels: [{ id, source: "websocket"|"polling"|"synthetic", url?, keys[] }]
export function detectLiveWidgets(pageEvidence, opts = {}) {
  const elements = Array.isArray(pageEvidence?.elements) ? pageEvidence.elements : [];
  const repeated = Array.isArray(pageEvidence?.repeated) ? pageEvidence.repeated : [];
  const wsEvents = Array.isArray(pageEvidence?.wsEvents) ? pageEvidence.wsEvents : [];

  // live evidence — websocket + JSON polling
  let wsSockets = 0;
  let wsFramesIn = 0;
  const wsUrl = wsEvents.find((e) => e?.kind === "socket")?.url || null;
  for (const e of wsEvents) {
    if (e?.kind === "socket") wsSockets++;
    if (e?.kind === "frame" && e?.direction === "in") wsFramesIn++;
  }
  const polls = pollingPaths(pageEvidence?.networkEntries);
  const liveEvidence = {
    websocket: { sockets: wsSockets, framesIn: wsFramesIn, url: wsUrl },
    polling: polls,
  };
  const wsBoost = wsFramesIn > 0 ? 0.15 : 0;
  const pollBoost = polls.length ? 0.1 : 0;

  // numeric leaves + children map (dom.json parents are geometric containment)
  const numericLeaf = new Set();
  const kidsOf = new Map();
  for (const el of elements) {
    if (el === null || el === undefined || typeof el.i !== "number") continue;
    if (el.text && isNumericText(el.text) && (el.children === 0 || el.children === undefined)) numericLeaf.add(el.i);
    const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(el.i);
  }
  const descendantsOf = (rootIndex) => {
    const out = [];
    const stack = [...(kidsOf.get(rootIndex) || [])];
    const seen = new Set();
    while (stack.length) {
      const i = stack.pop();
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(i);
      const el = elements[i];
      if (el) stack.push(...(kidsOf.get(el.i) || []));
    }
    return out;
  };
  const hasRepeatedRows = repeated.some((r) => /(^|\|)(tr|td)\|/.test(String(r?.signature || "")) && r.count >= 3);
  const hasRepeatedTickerCells = repeated.some(
    (r) => /(^|\|)(span|td|div)\|/.test(String(r?.signature || "")) && r.count >= 3,
  );

  // channel candidates (best first): captured websocket > JSON polling > synthetic
  const channels = [];
  if (wsFramesIn > 0 && wsUrl) {
    const keys = new Set();
    for (const e of wsEvents) {
      if (e?.kind === "frame" && e?.direction === "in") for (const k of Object.keys(flattenNumericStructure(e.payloadStructure))) keys.add(k);
    }
    channels.push({ id: channelFromUrl(wsUrl), source: "websocket", url: wsUrl, keys: [...keys].sort() });
  }
  for (const poll of polls.slice(0, 3)) {
    channels.push({ id: sanitizeChannelId("poll-" + slugPath(poll.path)), source: "polling", url: poll.path, keys: [] });
  }
  channels.push({ id: "stream", source: "synthetic", url: null, keys: [] });
  const primary = channels[0];

  // widget candidates
  const widgets = [];
  for (const el of elements) {
    if (el === null || el === undefined || typeof el.i !== "number") continue;
    const tag = String(el.tag || "").toLowerCase();
    const selfNumeric = numericLeaf.has(el.i);
    const descNumeric = descendantsOf(el.i).filter((i) => numericLeaf.has(i));
    // ---- table: real <table>, or a table-ish container over repeated rows
    if (tag === "table") {
      const conf = clamp(0.85 + (hasRepeatedRows ? 0.05 : 0) + wsBoost + pollBoost);
      widgets.push({ kind: "table", elIndex: el.i, confidence: conf, evidence: ["tag=table", hasRepeatedRows ? "repeated rows" : null].filter(Boolean), channel: primary.id, keys: primary.keys });
      continue;
    }
    if (hasAnyToken(el, TABLE_TOKENS) && hasRepeatedRows && descNumeric.length >= 2) {
      const conf = clamp(0.7 + wsBoost + pollBoost);
      widgets.push({ kind: "table", elIndex: el.i, confidence: conf, evidence: ["table class hint", "repeated rows", "numeric cells"], channel: primary.id, keys: primary.keys });
      continue;
    }
    // ---- ticker: ticker-ish element (itself or its children) carrying numbers
    if (hasAnyToken(el, TICKER_TOKENS) && (selfNumeric || descNumeric.length >= 2)) {
      const conf = clamp(0.75 + (hasRepeatedTickerCells ? 0.05 : 0) + wsBoost + pollBoost);
      widgets.push({ kind: "ticker", elIndex: el.i, confidence: conf, evidence: ["ticker class hint", selfNumeric ? "numeric text" : `${descNumeric.length} numeric cells`], channel: primary.id, keys: primary.keys });
      continue;
    }
    // ---- counter: counter-ish leaf/parent with a number
    if (hasAnyToken(el, COUNTER_TOKENS) && (selfNumeric || descNumeric.length >= 1)) {
      const conf = clamp(0.8 + wsBoost + pollBoost);
      widgets.push({ kind: "counter", elIndex: el.i, confidence: conf, evidence: ["counter class/id hint", selfNumeric ? "numeric text" : "numeric descendant"], channel: primary.id, keys: primary.keys });
      continue;
    }
    // ---- fallback: numeric sibling strip (3+ numeric leaves in one small parent)
    const numericKids = (kidsOf.get(el.i) || []).filter((i) => numericLeaf.has(i));
    const rect = el.rect || {};
    if (numericKids.length >= 3 && (rect.h || 0) < 120) {
      const conf = clamp(0.6 + wsBoost + pollBoost);
      widgets.push({ kind: "ticker", elIndex: el.i, confidence: conf, evidence: [`${numericKids.length} numeric sibling cells`, "no semantic hint"], channel: primary.id, keys: primary.keys });
    }
  }
  widgets.sort((a, b) => b.confidence - a.confidence || a.elIndex - b.elIndex);
  const maxWidgets = opts.maxWidgets || 24;
  return { widgets: widgets.slice(0, maxWidgets), channels, liveEvidence };
}

// ---------- plan: detection + channels + wiring in one call ----------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function normalizeCapture(capture) {
  if (!capture) return [];
  if (Array.isArray(capture)) return capture;
  if (Array.isArray(capture.events)) return capture.events; // a sink or an exported fixture
  return [];
}

// buildStreamPlan(artifactsDir, opts) →
// {
//   ok, pages: { [pageId]: { widgets, channels, liveEvidence, wiring, hasLiveEvents } },
//   byIndex: Map<pageId, Map<elementIndex, "channel.key">>,
//   channelSpecs,   // ready for data-stream-replayer.buildStreamRuntime
//   channelKeys,    // channelId → sorted numeric keys (for explicit test wiring)
//   notes
// }
// opts: { capture (sink | events | exported fixture), messages: { [pageId]: channels },
//         maxWidgets, noCapture: true (force synthetic channels) }
export function buildStreamPlan(artifactsDir, opts = {}) {
  const notes = [];
  const pagesRoot = path.join(artifactsDir, "pages");
  let pageDirs = [];
  try {
    pageDirs = fs.readdirSync(pagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return { ok: false, why: "no pages/ directory under artifacts", pages: {}, byIndex: new Map(), channelSpecs: [], channelKeys: {}, notes };
  }
  const injected = normalizeCapture(opts.capture);
  if (injected.length) notes.push(`capture injected: ${injected.length} event(s)`);

  const pages = {};
  const byIndex = new Map();
  const channelSpecs = [];
  const channelKeys = {};
  const specByChannel = new Map();

  for (const pageId of pageDirs) {
    const dom = readJson(path.join(pagesRoot, pageId, "dom.json"));
    if (!dom || !Array.isArray(dom.elements)) { notes.push(`${pageId}: dom.json missing/malformed — page skipped`); continue; }
    const network = readJson(path.join(pagesRoot, pageId, "network.json"));
    const wsFixture = readJson(path.join(pagesRoot, pageId, "websocket.json"));
    const wsEvents = injected.length ? injected : normalizeCapture(wsFixture);

    const { widgets, channels, liveEvidence } = detectLiveWidgets(
      { pageId, elements: dom.elements, repeated: dom.repeated, networkEntries: network?.entries, wsEvents },
      { maxWidgets: opts.maxWidgets },
    );

    // replayer channel specs: author-supplied timeline > capture-derived > static
    let specs = [];
    let hasLiveEvents = false;
    if (opts.messages && opts.messages[pageId]) {
      specs = opts.messages[pageId];
    } else if (wsEvents.length) {
      const seq = sequenceFromCapture(wsEvents, {});
      specs = seq.channels;
      hasLiveEvents = specs.some((s) => (s.events || []).some((e) => e.type === "message"));
      if (!hasLiveEvents) notes.push(`${pageId}: websocket capture had no replayable (numeric) frames — channels are static`);
    }
    if (!specs.length) {
      const ch = channels[0] || { id: "stream", source: "synthetic", url: null };
      specs = [{ id: ch.id, transport: "replay", url: ch.url, loop: false, events: [] }];
      notes.push(`${pageId}: no message timeline available — widgets wired, stream static`);
    }

    // wiring: each detected widget's numeric leaves (document order) map onto the
    // channel's sorted numeric keys, round-robin; counters wire their own element.
    const wiring = [];
    const pageByIndex = new Map();
    const specById = new Map(specs.map((s) => [s.id, s]));
    for (const w of widgets) {
      const spec = specById.get(w.channel) || specs[0];
      const el = dom.elements[w.elIndex];
      const leaves = numericLeavesOfWidget(w, el, dom.elements);
      const keys = (spec.events || []).length ? specNumericKeys(spec) : w.keys && w.keys.length ? w.keys : null;
      if (w.kind === "counter" && !leaves.length && el?.text && isNumericText(el.text)) leaves.push(w.elIndex);
      if (!keys || !keys.length) continue; // no keys to bind — wiring stays empty (honest)
      leaves.forEach((elIndex, j) => {
        const key = keys[j % keys.length];
        const target = `${spec.id}.${key}`;
        pageByIndex.set(elIndex, target);
        wiring.push({ elIndex, target, widgetKind: w.kind, channel: spec.id, key });
      });
    }

    for (const spec of specs) {
      const id = sanitizeChannelId(spec.id);
      if (specByChannel.has(id)) continue; // first page wins — same captured socket
      specByChannel.set(id, true);
      channelSpecs.push(spec);
      channelKeys[id] = specNumericKeys(spec);
    }

    pages[pageId] = { widgets, channels, liveEvidence, wiring, hasLiveEvents };
    byIndex.set(pageId, pageByIndex);
  }

  return { ok: true, pages, byIndex, channelSpecs, channelKeys, notes };
}

function numericLeavesOfWidget(widget, rootEl, elements) {
  if (!rootEl || !Array.isArray(elements)) return [];
  const out = [];
  const kidsOf = new Map();
  for (const el of elements) {
    if (el === null || el === undefined || typeof el.i !== "number") continue;
    const p = el.parent === null || el.parent === undefined ? -1 : el.parent;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(el.i);
  }
  const stack = [rootEl.i];
  const seen = new Set();
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const el = elements[i];
    if (!el) continue;
    if (el.text && isNumericText(el.text) && (el.children === 0 || el.children === undefined)) out.push(el.i);
    for (const c of kidsOf.get(el.i) || []) stack.push(c);
  }
  return out.sort((a, b) => a - b);
}

// Sorted, deduped numeric keys of a channel spec (capture-derived specs carry
// numeric leaf paths in their message data).
export function specNumericKeys(spec) {
  const keys = new Set();
  for (const e of spec?.events || []) {
    if (e?.type === "message" && e.data && typeof e.data === "object") {
      for (const k of Object.keys(e.data)) keys.add(String(k));
    }
  }
  return [...keys].sort();
}

// Deterministic serialization of a plan (for reports/tests).
export function planToJson(plan) {
  return stableStringify({
    ok: plan.ok,
    channelSpecs: plan.channelSpecs,
    channelKeys: plan.channelKeys,
    pages: Object.fromEntries(Object.entries(plan.pages || {}).map(([k, v]) => [k, { widgets: v.widgets, wiring: v.wiring, hasLiveEvents: v.hasLiveEvents }])),
    notes: plan.notes,
  });
}
