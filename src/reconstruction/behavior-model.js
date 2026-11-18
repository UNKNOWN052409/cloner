// Behavior model (C1 of the behavior-synthesis wave): turns recorded evidence —
// websocket/polling captures, the in-URL state graph, exploration behaviors and
// per-page DOM — into the machine-readable BEHAVIOR CONTRACT the store
// generator (generation/store-generator.js, C2) and the behavior verification
// gate (verify-behavior.js, C4) consume. Written to
// artifacts/<jobId>/behavior-model.json — a second Understanding record for
// behavior, the same role blueprint.json plays for scope/regions (ADR-0003).
//
// What each contract section means:
//   feeds    — live numeric streams the clone can replay (websocket channels
//              + JSON polling endpoints). Reuses stateful-widget-builder's
//              detection verbatim — no duplicate inference.
//   entities — data collections the app demonstrably holds: a ws frame with an
//              items array, a polled JSON endpoint, repeated row groups. Fields
//              are NUMERIC-SHAPE only (the capture redacts strings — the
//              contract states that honestly instead of inventing names).
//   actions  — things a user can do: navigate (in-URL state), open (overlay /
//              inner panel recorded), submit (form with fields), choose
//              (select/option). Every action carries its evidence pointer.
//   effects  — the observable delta an action produces: a state page exists,
//              an overlay/inner capture exists, a stream channel carries
//              numeric keys. This is what C4 asserts: dispatch → delta.
//
// Honest-absence contract (same discipline as application-state-builder):
// empty evidence → ok:true with everything empty and a note, never fabricated
// semantics. Confidence is evidence-weighted; actions with a state page or a
// documented behavior are "strong", dom-mark-only are "weak".
//
// Integration hooks (additive, one call in reconstruction-pipeline.js next to
// the streamPlan/appState builders):
//   import { buildBehaviorModel, writeBehaviorModel, summarizeBehaviorModel } from "./behavior-model.js";
//   const behavior = buildBehaviorModel(artifactsDir, {});
//   writeBehaviorModel(artifactsDir, behavior);
//   report.behaviorModel = summarizeBehaviorModel(behavior);
import fs from "node:fs";
import path from "node:path";
import { buildStreamPlan } from "./stateful-widget-builder.js";
import { stableStringify } from "../exploration/websocket-session-capture.js";

export const BEHAVIOR_MODEL_SCHEMA = "1.0.0";
export const BEHAVIOR_MODEL_FILE = "behavior-model.json";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ---------- feeds + entities from the live-data evidence ----------

// feedsAndEntities(streamPlan, wsByPage) → { feeds, entities, notes }. The
// streamPlan's channels are the feed candidates; entities group the numeric
// key paths by their first segment ("items.0.qty" → collection "items") and
// merge polled JSON endpoints as collection sources.
function feedsAndEntities(streamPlan) {
  const feeds = [];
  const entities = new Map(); // id → { id, kind, source, keys:Set, urls:Set }
  const notes = [];
  const byChannel = new Map();
  // capture-derived specs (sequenceFromCapture) carry no source field — the
  // transport tells the truth: ws(s):// → websocket, http(s):// or /path → polling
  const sourceOf = (ch) => {
    if (ch.source === "synthetic") return "synthetic";
    const url = String(ch.url || "");
    if (/^wss?:/i.test(url)) return "websocket";
    if (/^https?:/i.test(url) || url.startsWith("/")) return "polling";
    return ch.source || "synthetic";
  };
  for (const ch of streamPlan.channelSpecs || []) {
    const keys = streamPlan.channelKeys?.[ch.id] || specKeys(ch);
    const source = sourceOf(ch);
    feeds.push({ id: ch.id, source, url: ch.url || null, keys, numeric: keys.length > 0 });
    byChannel.set(ch.id, keys);
    // ws/poll channels carry capture-derived numeric keys — group them
    if (source === "websocket" || source === "polling") {
      const grouped = groupEntityKeys(keys);
      const groupedNames = new Set(Object.keys(grouped));
      for (const [ent, paths] of Object.entries(grouped)) {
        const e = entities.get(ent) || { id: ent, kind: "collection", source, keys: new Set(), urls: new Set() };
        e.source = e.source === source ? e.source : "mixed";
        for (const p of paths) e.keys.add(p);
        if (ch.url) e.urls.add(ch.url);
        entities.set(ent, e);
      }
      // flat numeric surface (bid/ask/last at top level — the common quote-feed
      // shape): the channel itself is the entity, named after its id
      if (!groupedNames.size && keys.length >= 2) {
        const e = entities.get(ch.id) || { id: ch.id, kind: "structure", source, keys: new Set(), urls: new Set() };
        for (const p of keys) e.keys.add(p);
        if (ch.url) e.urls.add(ch.url);
        entities.set(ch.id, e);
      }
    }
  }
  // a ws channel with zero numeric keys is still a feed — honest, but it cannot
  // drive entity fields (structure-only capture)
  const empty = feeds.filter((f) => !f.keys.length);
  if (empty.length) notes.push(`${empty.length} feed(s) carry no numeric keys — structure-only capture, fields stay honest-empty`);
  // synthetic fallback channel is not evidence of anything — drop it
  const realFeeds = feeds.filter((f) => f.source !== "synthetic" || f.keys.length);
  const entitiesOut = [...entities.values()].map((e) => ({ ...e, keys: [...e.keys].sort(), urls: [...e.urls] }));
  return { feeds: realFeeds, entities: entitiesOut, notes, byChannel };
}

function specKeys(ch) {
  const keys = new Set();
  for (const e of ch?.events || []) if (e?.type === "message" && e.data && typeof e.data === "object") for (const k of Object.keys(e.data)) keys.add(String(k));
  return [...keys].sort();
}

// groupEntityKeys(keys) — first path segment groups, arrays index-stripped:
// ["items.0.qty","items.1.qty","last"] → items:[items.0.qty, items.1.qty]
// (array indexes are capture positions, not schema). Bare scalars → no group.
export function groupEntityKeys(keys) {
  const out = {};
  for (const k of Array.isArray(keys) ? keys : []) {
    const seg = String(k).split(".")[0];
    if (!seg || /^\d+$/.test(seg)) continue; // top-level array index — no entity name
    if (!String(k).includes(".")) continue; // scalar channel key — no fields
    const path = String(k).split(".").filter((s) => !/^\d+$/.test(s)).join(".");
    if (!path.includes(".")) continue; // collapsed to a bare field — no shape
    const arr = out[seg] || [];
    if (!arr.includes(path)) arr.push(path);
    out[seg] = arr;
  }
  return out;
}

// ---------- actions + effects from the interaction evidence ----------

// actionsAndEffects(artifactsDir, opts) → { actions, effects, notes }. Sources,
// strongest first: states/index.json (the v2 state graph — an interaction that
// demonstrably produced a state page), exploration.json behaviors (v1 overlay
// documentation), per-page dom.json trigger marks (weak, dom-only).
function actionsAndEffects(artifactsDir, opts = {}) {
  const actions = [];
  const effects = [];
  const notes = [];
  const seen = new Map(); // trigger id → action (strongest source wins)
  const maxActions = opts.maxActions || 120;

  // 1) the v2 state graph: states/index.json entries with an interaction are
  //    documented behavior — the state page IS the effect
  const stateIndex = readJson(path.join(artifactsDir, "states", "index.json"));
  const states = Array.isArray(stateIndex?.states) ? stateIndex.states : [];
  const manifest = readJson(path.join(artifactsDir, "manifest.json"));
  const manifestFileOf = new Map();
  for (const mp of manifest?.pages || []) {
    if (mp?.pageId) manifestFileOf.set(mp.pageId, mp);
  }
  for (const s of states) {
    if (!s?.interaction || s.interaction === null) continue;
    const id = String(s.domRef || "").match(/(?:^|[/\\])(t\d+)\.html$/)?.[1] || null;
    const label = String(s.interaction).split("\n")[0].slice(0, 40);
    // a state page exists in the manifest when the URL is hash-carried
    const statePage = [...manifestFileOf.values()].find((mp) => mp.state && mp.url === s.url);
    const kind = statePage ? "navigate" : id ? "open" : "open-inner";
    const action = {
      id: `a-states-${s.id}`,
      kind,
      trigger: id,
      label,
      evidence: { source: "state-graph", stateId: s.id, domRef: s.domRef || null, url: s.url || null },
      confidence: "strong",
    };
    if (statePage) action.target = { pageId: statePage.pageId, url: statePage.url };
    actions.push(action);
    if (statePage) effects.push({ actionId: action.id, kind: "state-page", target: statePage.pageId, detail: `state page ${statePage.pageId} renders the recorded result` });
    seen.set(id || `s:${s.id}`, action);
    if (actions.length >= maxActions) break;
  }

  // 2) v1 exploration behaviors: overlay opens documented with trigger labels
  const exploration = readJson(path.join(artifactsDir, "exploration.json"));
  for (const b of exploration?.behaviors || []) {
    const tid = b.trigger?.id;
    if (tid && seen.has(tid)) continue; // state graph already documented it
    const action = {
      id: `a-beh-${actions.length}`,
      kind: b.opens ? "open" : "no-op",
      trigger: tid || null,
      label: String(b.trigger?.label || "").slice(0, 40),
      evidence: { source: "exploration-behavior", opens: b.opens || null },
      confidence: b.opens ? "strong" : "weak",
    };
    if (b.opens) action.target = { kind: "overlay", w: b.opens.w, h: b.opens.h };
    actions.push(action);
    if (b.opens) effects.push({ actionId: action.id, kind: "overlay", target: tid || null, detail: `overlay ${b.opens.w}x${b.opens.h} captured for replay` });
    seen.set(tid || `b:${actions.length}`, action);
    if (actions.length >= maxActions) break;
  }

  // 3) per-page dom marks: weak (dom-only) — included so the contract lists
  //    every interactive surface, honestly flagged
  const pagesRoot = path.join(artifactsDir, "pages");
  let pageDirs = [];
  try { pageDirs = fs.readdirSync(pagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch {}
  for (const pageId of pageDirs) {
    const dom = readJson(path.join(pagesRoot, pageId, "dom.json"));
    const elements = Array.isArray(dom?.elements) ? dom.elements : [];
    for (const el of elements) {
      if (!el?.dataClonerTrigger || seen.has(el.dataClonerTrigger)) continue;
      actions.push({
        id: `a-dom-${el.dataClonerTrigger}`,
        kind: el.tag === "form" ? "submit" : "open",
        trigger: el.dataClonerTrigger,
        label: String(el.ariaName || el.text || "").slice(0, 40),
        evidence: { source: "dom-mark", pageId, elIndex: el.i },
        confidence: "weak",
      });
      seen.set(el.dataClonerTrigger, actions[actions.length - 1]);
      if (actions.length >= maxActions) break;
    }
    // forms with fillable fields → submit actions (the store's mutation surface)
    const formFields = collectFormFields(elements);
    if (formFields.length) {
      actions.push({
        id: `a-form-${pageId}`,
        kind: "submit",
        trigger: null,
        label: formFields[0].formLabel || `form (${formFields.length} fields)`,
        evidence: { source: "dom-form", pageId, fields: formFields },
        confidence: "medium",
      });
      effects.push({ actionId: `a-form-${pageId}`, kind: "submit", target: pageId, detail: `${formFields.length} captured field(s) — values feed the generated store` });
    }
    if (actions.length >= maxActions) break;
  }

  if (!actions.length) notes.push("no interaction evidence found — actions stay empty (clone is visually faithful, behaviorally inert)");
  return { actions, effects, notes };
}

// collectFormFields(elements) — captured form surfaces: inputs/selects inside a
// form (or standalone named controls). Names/types feed the generated store's
// action payloads; redaction contract: VALUES are never read here, shapes only.
export function collectFormFields(elements) {
  const out = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!el || typeof el !== "object") continue;
    const tag = String(el.tag || "").toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;
    const type = String(el.attrs?.type || el.type || "").toLowerCase();
    if (type === "hidden" || type === "submit") continue;
    out.push({
      pageId: null,
      elIndex: el.i,
      tag,
      type: type || (tag === "select" ? "select" : "text"),
      name: String(el.attrs?.name || el.name || el.id || "").slice(0, 40) || null,
      formLabel: null,
    });
    if (out.length >= 24) break;
  }
  return out;
}

// ---------- assembly ----------

// buildBehaviorModel(artifactsDir, opts) → the behavior contract. Pure over the
// artifact files (the only fs reads are the evidence listed above).
export function buildBehaviorModel(artifactsDir, opts = {}) {
  const notes = [];
  const streamPlan = buildStreamPlan(artifactsDir, { ...opts.stream, noCapture: opts.noCapture });
  const { feeds, entities, notes: feedNotes, byChannel } = feedsAndEntities(streamPlan);
  notes.push(...feedNotes);
  if (!streamPlan.ok) notes.push(`stream plan: ${streamPlan.why || "unavailable"} — feeds inferred from dom evidence only`);

  const { actions, effects, notes: actionNotes } = actionsAndEffects(artifactsDir, opts);
  notes.push(...actionNotes);

  // effects that reference a stream channel: actions on numeric-bound surfaces
  // (a widget wired to channel keys) — the store's reactive output bus
  const wiredSurfaces = [...(streamPlan.byIndex || new Map()).values()].reduce((n, m) => n + m.size, 0);
  if (wiredSurfaces) effects.push({ actionId: "*", kind: "stream", target: null, detail: `${wiredSurfaces} element(s) wired to feed channels — store deltas propagate through data-stream-target` });

  const strong = actions.filter((a) => a.confidence === "strong").length;
  const medium = actions.filter((a) => a.confidence === "medium").length;
  const weak = actions.filter((a) => a.confidence === "weak").length;
  const confidence = {
    strong, medium, weak,
    overall: strong + medium + weak === 0 ? "none" : strong >= medium + weak ? "strong" : strong > 0 ? "medium" : "weak",
  };
  if (!feeds.length && !actions.length) notes.push("empty behavior model — the clone contract stays visual-only");

  return {
    ok: true,
    schema: BEHAVIOR_MODEL_SCHEMA,
    feeds,
    entities,
    actions,
    effects,
    channels: Object.fromEntries([...byChannel.entries()].map(([k, v]) => [k, v])),
    counts: { feeds: feeds.length, entities: entities.length, actions: actions.length, effects: effects.length, wiredSurfaces },
    confidence,
    notes,
  };
}

// writeBehaviorModel(artifactsDir, model) — deterministic serialization to
// artifacts/<jobId>/behavior-model.json (stable key order via stableStringify).
export function writeBehaviorModel(artifactsDir, model) {
  try {
    fs.writeFileSync(path.join(artifactsDir, BEHAVIOR_MODEL_FILE), stableStringify(model));
    return BEHAVIOR_MODEL_FILE;
  } catch {
    return null;
  }
}

// readBehaviorModel(artifactsDir) — the one loader for downstream consumers
// (store-generator, verify-behavior). Returns null when absent — callers stay
// honest about missing contracts.
export function readBehaviorModel(artifactsDir) {
  const m = readJson(path.join(artifactsDir, BEHAVIOR_MODEL_FILE));
  return m && m.schema === BEHAVIOR_MODEL_SCHEMA ? m : null;
}

// summarizeBehaviorModel(model) — the reconstruction-report block.
export function summarizeBehaviorModel(model) {
  if (!model) return { ok: false, why: "no behavior model" };
  return {
    ok: model.ok,
    feeds: model.counts.feeds,
    entities: model.counts.entities,
    actions: model.counts.actions,
    effects: model.counts.effects,
    confidence: model.confidence.overall,
    notes: model.notes.slice(0, 6),
  };
}
