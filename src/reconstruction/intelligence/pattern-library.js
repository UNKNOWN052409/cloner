// Persistent cross-clone pattern library (task 5.0.1, plan section
// "Reconstruction intelligence").
//
// What it is:
//   A learned store of COMPONENT SIGNATURES — a deterministic structure+style
//   hash computed from a website-understanding model component (plan 3.4.1
//   shape: kind/evidence/confidence/provenance). When a LATER clone produces a
//   component with the SAME structure+style signature, the library contributes
//   an evidence-gated confidence boost — so what clone A learned makes clone B's
//   classification stronger WITHOUT any target-specific hardcode (extends the
//   3.5.6 generalization contract: the signature IS the evidence match).
//
// Contracts (ChatGPT review notes, plan §6):
//   • Provenance: every learned pattern row stores its source evidence snapshot.
//   • Confidence scoring: retrieval returns a match confidence; application is
//     evidence-gated by the SAME override floor vision-assist uses (a learned
//     kind change may only happen inside the deterministic < 0.5 band, and only
//     with a strong, multiply-observed pattern).
//   • Regression protection: an empty library — or a weak/no match — leaves the
//     understanding model BYTE-IDENTICAL (deep-equal asserted in the suite).
//     Confidence can only move UP (noisy-OR aggregation is monotone in added
//     evidence records); a kind flip is separately logged as a warning.
//
// Storage:
//   • PostgreSQL (product path, migration 041) via the shared database client.
//   • In-process memory store — the mandatory deterministic fallback when PG is
//     unreachable (CI without compose) or when no persistence is requested.
//     Same semantics, same read/write API; `openPatternLibrary()` reports which
//     backend it resolved and why.
//
// Everything is pure/deterministic except wall-clock timestamps in provenance
// and PG columns, which are data, not scoring inputs.

import { createHash } from "node:crypto";
import { aggregateConfidence } from "../component-evidence.js";

// Pattern evidence source tag added to boosted components. component-evidence
// keeps unknown sources verbatim by contract (additive sources allowed; the
// closed EVIDENCE_SOURCES list is the deterministic engine's own vocabulary).
export const PATTERN_EVIDENCE_SOURCE = "pattern";

// Evidence-gate constants (same override-band philosophy as vision-assist's
// DOM_OVERRIDE_FLOOR = 0.5; a learned pattern is at least as conservative).
export const KIND_OVERRIDE_FLOOR = 0.5;        // deterministic confidence below which a learned kind may win
export const KIND_OVERRIDE_PATTERN_MIN = 0.85; // pattern source confidence required for a kind change
export const KIND_OVERRIDE_MIN_OBS = 2;        // pattern must be observed at least twice (not a one-off)
export const BOOST_MAX_WEIGHT = 0.35;          // learned evidence is weak evidence, always
export const BOOST_MAX_PROVENANCE = 8;         // provenance rows kept per pattern
export const LEARN_MIN_CONFIDENCE = 0.75;      // only strong components teach the library

// ---------- signature computation (structure + style, instance-independent) ----

// Semantic class-token slots (plan §6 cross-site generalization: the signature
// must match the SAME WIDGET in a DIFFERENT app, so site-specific vocabulary
// ("main-nav", "docs-header", "top-bar") collapses to the semantic slot it
// carries; tokens outside the vocabulary contribute nothing). The slot words
// mirror component-pattern-detector's DEFAULT_REGION_HINTS families — the same
// evidence vocabulary the deterministic engine already votes with.
const SEMANTIC_TOKEN_SLOTS = {
  nav: ["nav", "navbar", "navigation", "menu", "topnav", "mainnav", "navlinks", "breadcrumbs"],
  header: ["header", "topbar", "masthead", "appbar", "titlebar", "banner"],
  sidebar: ["sidebar", "sidepanel", "sidenav", "aside", "dock", "rail", "leftpanel", "rightpanel"],
  toolbar: ["toolbar", "actionbar", "buttonbar", "controlsbar"],
  workspace: ["workspace", "workarea", "canvas", "stage", "editor", "content", "main", "mainarea"],
  splitter: ["splitter", "gutter", "resizer", "sash", "divider", "separator"],
  card: ["card", "tile", "product", "listing", "thumbnail"],
  grid: ["grid", "cards", "cardgrid", "gallery", "feed", "mosaic", "listings", "tiles"],
  table: ["table", "datatable", "datagrid", "datagridview"],
  chart: ["chart", "graph", "plot", "sparkline", "viz", "visualization"],
  modal: ["modal", "dialog", "popup", "overlay", "lightbox", "drawer"],
  form: ["form", "signup", "login", "signin", "checkout", "fieldset"],
  footer: ["footer", "bottombar", "colophon"],
  tab: ["tab", "tabs", "tabbar", "tablist"],
  button: ["btn", "button", "cta"],
  panel: ["panel", "pane", "card-body", "section"],
};
const tokenSlotIndex = new Map(
  Object.entries(SEMANTIC_TOKEN_SLOTS).flatMap(([slot, words]) => words.map((w) => [w, slot])),
);

// semanticSlots(cls) → sorted unique slots hit by the class/id tokens.
function semanticSlots(s) {
  const tokens = String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const slots = new Set();
  for (const t of tokens) {
    const slot = tokenSlotIndex.get(t);
    if (slot) slots.add(slot);
  }
  return [...slots].sort();
}

const band = (v, edges) => {
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i;
  return edges.length;
};
const AREA_BANDS = [2000, 20000, 200000, 2000000];      // tiny/small/medium/large/xl
const ASPECT_BANDS = [0.25, 0.75, 1.5, 4, 16];          // tall/squareish/wide/vwide/strip
const Z_BANDS = [1, 10, 100];                            // auto/low/mid/high
const FONT_BANDS = [12, 16, 20, 32];                     // xs/s/m/l/xl
const RADIUS_BANDS = [0, 4, 12];                         // sharp/soft/round
const CHILD_BANDS = [0, 2, 5, 12];                       // none/few/some/many/lot
const SIBLING_BANDS = [2, 5];                            // none/few/many (repeated groups)

function edgeAnchor(rect, page) {
  const anchors = [];
  const x = rect?.x ?? 0, y = rect?.y ?? 0;
  const w = rect?.w ?? 0, h = rect?.h ?? 0;
  const pw = page?.width || (x + w) || 1, ph = page?.height || (y + h) || 1;
  if (y <= Math.max(12, ph * 0.02)) anchors.push("top");
  if (y + h >= ph - 12) anchors.push("bottom");
  if (x <= 8) anchors.push("left");
  if (x + w >= pw - 8) anchors.push("right");
  return anchors.sort().join("+") || "none";
}

// componentSignature(component, page) → { signature, features }.
// Deterministic: same component (+page metrics) → same 24-hex signature. The
// feature object deliberately EXCLUDES the classified kind, text, href/src and
// evidence records — structure and style only — and collapses class vocabulary
// to semantic slots, so the same widget structure in a DIFFERENT app (different
// class naming, different text) yields the same signature and the learned kind
// can travel across clones and fixture categories.
export function componentSignature(component, page = {}) {
  const p = component?.provenance || {};
  const rect = component?.rect || p.rect || {};
  const style = p.style || {};
  const w = Number(rect.w) || 0, h = Number(rect.h) || 0;
  const aspect = h > 0 ? w / h : 0;
  const zRaw = style.zIndex;
  const zNum = Number(zRaw);
  const z = (zRaw === undefined || zRaw === null || !Number.isFinite(zNum)) ? 0 : zNum;
  const fontSize = Number(style.fontSize) || 0;
  const radius = Number(style.borderRadius) || 0;
  const features = {
    tag: String(p.tag || component?.tag || "").toLowerCase() || null,
    role: String(p.role || component?.role || "").toLowerCase() || null,
    cls: [...new Set([...semanticSlots(p.cls || component?.cls), ...semanticSlots(p.id || component?.id)])],
    aspect: band(aspect, ASPECT_BANDS),
    area: band(w * h, AREA_BANDS),
    anchor: edgeAnchor(rect, page),
    z: band(z, Z_BANDS),
    font: band(fontSize, FONT_BANDS),
    radius: band(radius, RADIUS_BANDS),
    position: String(style.position || "").toLowerCase() || null,
    display: String(p.layout?.display || "").toLowerCase() || null,
    children: band(Number(p.childCount) || 0, CHILD_BANDS),
    repeated: component?.repeated ? band(Number(component.repeated.siblings) || 0, SIBLING_BANDS) : 0,
    depth: Number(component?.depth) || 0,
  };
  const signature = createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 24);
  return { signature, features };
}

// ---------- pattern row construction ----------

function patternRow(component, { page, source, url, pageId }) {
  const { signature, features } = componentSignature(component, page || {});
  const evidenceSnapshot = (component.evidence || []).map((e) => ({
    source: e.source, ref: e.ref, note: e.note, weight: e.weight,
  }));
  return {
    signature,
    kind: component.kind,
    confidence: component.confidence,
    features,
    evidence: evidenceSnapshot,
    provenance: [{ source: source || null, url: url || null, pageId: pageId || null, learnedAt: new Date().toISOString() }],
    observations: 1,
    hits: 0,
  };
}

// telemetry persistence is best-effort by contract — a store without the
// optional methods (memory) or a transient PG error must never break boosting
async function bump(store, delta) {
  if (!store || typeof store.recordTelemetry !== "function") return false;
  try { await store.recordTelemetry(delta); return true; } catch { return false; }
}

// ---------- stores ----------

// In-process store — the mandatory deterministic fallback backend.
export function createMemoryPatternStore() {
  const rows = new Map();
  return {
    backend: "memory",
    async ping() { return true; },
    async upsert(row) {
      const cur = rows.get(row.signature);
      if (!cur) {
        rows.set(row.signature, { ...row, evidence: [...row.evidence], provenance: [...row.provenance] });
        return { ...row };
      }
      // same signature seen again: keep the FIRST (highest-confidence) kind —
      // learned kinds are stable once taught; observations/hits accumulate.
      cur.observations += 1;
      if (row.confidence > cur.confidence) {
        cur.kind = row.kind;
        cur.confidence = row.confidence;
        cur.evidence = [...row.evidence];
      }
      cur.provenance.push(...row.provenance);
      if (cur.provenance.length > BOOST_MAX_PROVENANCE) {
        cur.provenance = cur.provenance.slice(-BOOST_MAX_PROVENANCE);
      }
      const out = { ...cur };
      rows.set(row.signature, cur);
      return out;
    },
    async get(signature) {
      const r = rows.get(signature);
      return r ? { ...r, evidence: [...r.evidence], provenance: [...r.provenance] } : null;
    },
    async delete(signature) { return rows.delete(signature); },
    async list({ kind, limit } = {}) {
      let all = [...rows.values()];
      if (kind) all = all.filter((r) => r.kind === kind);
      all.sort((a, b) => b.observations - a.observations || (a.signature < b.signature ? -1 : 1));
      if (limit) all = all.slice(0, limit);
      return all.map((r) => ({ ...r }));
    },
    async count() { return rows.size; },
    async bumpHits(signature) {
      const r = rows.get(signature);
      if (r) r.hits += 1;
      return !!r;
    },
    async close() {},
  };
}

// PostgreSQL store (product path, migration 041). Uses the shared database
// client so connection settings come from the platform env exclusively.
export async function createPgPatternStore() {
  const db = await import("../../database/client.js");
  const store = {
    backend: "postgres",
    async ping() { await db.query("SELECT 1"); return true; },
    async upsert(row) {
      const { rows } = await db.query(
        `INSERT INTO recon_patterns (signature, kind, confidence, features, evidence, provenance, observations, hits)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
         ON CONFLICT (signature) DO UPDATE SET
           observations = recon_patterns.observations + 1,
           confidence = GREATEST(recon_patterns.confidence, EXCLUDED.confidence),
           kind = CASE WHEN EXCLUDED.confidence > recon_patterns.confidence THEN EXCLUDED.kind ELSE recon_patterns.kind END,
           evidence = CASE WHEN EXCLUDED.confidence > recon_patterns.confidence THEN EXCLUDED.evidence ELSE recon_patterns.evidence END,
           provenance = (
             SELECT COALESCE(jsonb_agg(s.v ORDER BY s.ord DESC), '[]'::jsonb) FROM (
               SELECT t.v AS v, t.ord AS ord
               FROM jsonb_array_elements(recon_patterns.provenance || EXCLUDED.provenance)
                 WITH ORDINALITY AS t(v, ord)
               ORDER BY t.v->>'learnedAt' DESC, t.ord DESC
               LIMIT ${BOOST_MAX_PROVENANCE}
             ) s
           ),
           updated_at = now()
         RETURNING signature, kind, confidence, observations`,
        [row.signature, row.kind, row.confidence, JSON.stringify(row.features),
         JSON.stringify(row.evidence), JSON.stringify(row.provenance), row.observations, row.hits],
      );
      return rows[0];
    },
    async get(signature) {
      const { rows } = await db.query(
        `SELECT signature, kind, confidence, features, evidence, provenance, observations, hits
         FROM recon_patterns WHERE signature = $1`, [signature]);
      return rows[0] || null;
    },
    async delete(signature) {
      const { rowCount } = await db.query("DELETE FROM recon_patterns WHERE signature = $1", [signature]);
      return rowCount > 0;
    },
    async list({ kind, limit } = {}) {
      const { rows } = await db.query(
        `SELECT signature, kind, confidence, observations, hits FROM recon_patterns
         ${kind ? "WHERE kind = $1" : ""}
         ORDER BY observations DESC, signature ASC ${limit ? "LIMIT " + Math.max(1, Math.floor(limit)) : ""}`,
        kind ? [kind] : [],
      );
      return rows;
    },
    async count() {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM recon_patterns");
      return rows[0].n;
    },
    async bumpHits(signature) {
      const { rowCount } = await db.query(
        "UPDATE recon_patterns SET hits = hits + 1 WHERE signature = $1", [signature]);
      return rowCount > 0;
    },
    async recordTelemetry({ lookups = 0, hits = 0, boosts = 0 }) {
      await db.query(
        `INSERT INTO recon_pattern_telemetry (id, lookups, hits, boosts) VALUES (1,$1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET
           lookups = recon_pattern_telemetry.lookups + $1,
           hits = recon_pattern_telemetry.hits + $2,
           boosts = recon_pattern_telemetry.boosts + $3,
           updated_at = now()`,
        [lookups, hits, boosts]);
      return true;
    },
    async readTelemetry() {
      const { rows } = await db.query(
        `SELECT lookups, hits, boosts FROM recon_pattern_telemetry WHERE id = 1`);
      return rows[0] || { lookups: 0, hits: 0, boosts: 0 };
    },
    async close() {},
  };
  await store.ping(); // throws on unreachable — callers decide the fallback
  return store;
}

// ---------- library ----------

// openPatternLibrary({ store, allowPg }) → { learn, learnFromUnderstanding,
// match, applyBoosts, list, delete, stats, close, backend }.
// Backend resolution: injected store wins; else PostgreSQL (product path) with
// a 1.5s ping; on any PG failure → memory store + recorded reason (the
// deterministic fallback the plan mandates). Never throws for absent infra.
export async function openPatternLibrary({ store = null, allowPg = true } = {}) {
  let backend = store;
  let fallbackReason = null;
  if (!backend && allowPg) {
    try {
      backend = await createPgPatternStore();
    } catch (e) {
      fallbackReason = String(e?.message || e).slice(0, 160);
      backend = null;
    }
  }
  if (!backend) backend = createMemoryPatternStore();

  const telemetry = { lookups: 0, hits: 0, boosts: 0 };

  const lib = {
    backend: backend.backend,
    fallbackReason,
    store: backend,

    // learn(component, meta) → persisted pattern row (upsert semantics).
    async learn(component, meta = {}) {
      if (!component || typeof component !== "object" || !component.kind) {
        throw new TypeError("learn() requires an understanding-model component with a kind");
      }
      const row = patternRow(component, meta);
      const saved = await backend.upsert(row);
      return saved;
    },

    // learnFromUnderstanding(model, meta) → { learned, patterns } — teaches the
    // library from one whole understanding model: only components whose
    // confidence >= LEARN_MIN_CONFIDENCE teach (weak votes are noise, not
    // knowledge). Deterministic order (element index ascending).
    async learnFromUnderstanding(model, meta = {}) {
      const comps = (model?.components || []).slice().sort((a, b) => a.elementIndex - b.elementIndex);
      // the page metrics ride along so learned signatures are computed against
      // the SAME edge-anchor geometry applyBoosts/match will use later
      const page = { width: model?.pageMetrics?.width, height: model?.pageMetrics?.height };
      const learned = [];
      for (const c of comps) {
        if (Number(c.confidence) < LEARN_MIN_CONFIDENCE) continue;
        const row = patternRow(c, { page, source: meta.source || null, url: model?.url, pageId: model?.pageId });
        const saved = await backend.upsert(row);
        learned.push(saved);
      }
      return { learned, count: learned.length };
    },

    // match(component, page) → { hit, pattern, signature } — retrieval returns
    // the match confidence (1.0 for the exact signature the library stores).
    async match(component, page = {}) {
      const { signature } = componentSignature(component, page);
      telemetry.lookups++;
      const pattern = await backend.get(signature);
      const hit = !!pattern;
      if (hit) telemetry.hits++;
      await bump(backend, { lookups: 1, hits: hit ? 1 : 0 });
      return { hit, pattern, signature, matchConfidence: hit ? 1 : 0 };
    },

    // applyBoosts(understandingModel, opts) → { model, boosts, overrides }.
    // Evidence-gated application over a WHOLE understanding model:
    //   • every component with a library signature hit gains ONE weak "pattern"
    //     evidence record (weight ≤ BOOST_MAX_WEIGHT) → confidence can only rise;
    //   • a KIND CHANGE additionally requires deterministic confidence <
    //     KIND_OVERRIDE_FLOOR, pattern confidence ≥ KIND_OVERRIDE_PATTERN_MIN and
    //     observations ≥ KIND_OVERRIDE_MIN_OBS (strong, multiply-observed pattern
    //     overriding a WEAK deterministic classification — never a strong one);
    //   • empty library / no match / weak pattern → model unchanged.
    // Returns a NEW model object (input never mutated).
    async applyBoosts(model, opts = {}) {
      const src = model || {};
      const out = {
        ...src,
        components: (src.components || []).map((c) => ({
          ...c, evidence: [...(c.evidence || [])], rect: { ...(c.rect || {}) },
          interaction: { ...(c.interaction || {}) },
        })),
        regions: Object.fromEntries(Object.entries(src.regions || {}).map(([k, v]) => [k, [...v]])),
        relationships: {
          parentChild: [...(src.relationships?.parentChild || [])],
          repeatedGroups: [...(src.relationships?.repeatedGroups || [])],
        },
        warnings: [...(src.warnings || [])],
      };
      const page = { width: src.pageMetrics?.width, height: src.pageMetrics?.height };
      const boosts = [];
      const overrides = [];
      for (const comp of out.components) {
        if (!comp || typeof comp !== "object") continue;
        const { signature } = componentSignature(comp, page);
        telemetry.lookups++;
        const pattern = await backend.get(signature);
        if (!pattern) { await bump(backend, { lookups: 1 }); continue; }
        // idempotent: a component already carrying this pattern's evidence
        // (boost applied twice) is left untouched — re-application must never
        // double-count learned evidence
        const already = (comp.evidence || []).some(
          (e) => e && e.source === PATTERN_EVIDENCE_SOURCE && String(e.ref || "").startsWith(`pattern:${signature}`));
        if (already) continue;
        telemetry.hits++;
        await bump(backend, { lookups: 1, hits: 1 });
        // weak learned evidence — noisy-OR keeps confidence monotone up
        const weight = Math.min(BOOST_MAX_WEIGHT, Math.max(0.1, Number(pattern.confidence) * 0.4));
        const beforeConfidence = comp.confidence;
        comp.evidence.push({
          source: PATTERN_EVIDENCE_SOURCE,
          ref: `pattern:${signature}`,
          note: `learned pattern: kind=${pattern.kind} observed ${pattern.observations}× (source confidence ${pattern.confidence})`,
          weight: Math.round(weight * 1000) / 1000,
        });
        comp.confidence = aggregateConfidence(comp.evidence);
        telemetry.boosts++;
        await bump(backend, { boosts: 1 });
        // persist the per-pattern hit counter on the PG backend (memory keeps
        // hits in-row; a missing method or a transient error never breaks boosting)
        if (typeof backend.bumpHits === "function") {
          try { await backend.bumpHits(signature); } catch { /* telemetry only */ }
        }
        boosts.push({ componentId: comp.id, signature, from: beforeConfidence, to: comp.confidence });

        const kindChange = pattern.kind !== comp.kind;
        if (kindChange
          && beforeConfidence < KIND_OVERRIDE_FLOOR
          && Number(pattern.confidence) >= KIND_OVERRIDE_PATTERN_MIN
          && Number(pattern.observations) >= KIND_OVERRIDE_MIN_OBS) {
          const oldKind = comp.kind;
          comp.kind = pattern.kind;
          comp.evidence.push({
            source: PATTERN_EVIDENCE_SOURCE,
            ref: `pattern:${signature}:override`,
            note: `learned kind override ${oldKind} → ${pattern.kind} (deterministic ${beforeConfidence} < ${KIND_OVERRIDE_FLOOR})`,
            weight: Math.round(Number(pattern.confidence) * 1000) / 1000,
          });
          comp.confidence = aggregateConfidence(comp.evidence);
          out.warnings.push(`pattern override: component ${comp.id} kind ${oldKind} → ${pattern.kind} (learned, ${pattern.observations} observation(s))`);
          overrides.push({ componentId: comp.id, from: oldKind, to: pattern.kind });
          await bump(backend, { boosts: 1 });
        }
      }
      // regions index must reflect post-boost kinds (relationships unchanged —
      // containment and repeated-group structure are not kind-dependent)
      const regions = {};
      for (const c of out.components) (regions[c.kind] = regions[c.kind] || []).push(c.id);
      for (const k of Object.keys(regions)) regions[k].sort();
      out.regions = regions;
      return { model: out, boosts, overrides };
    },

    async list(opts) { return backend.list(opts); },
    async count() { return backend.count(); },
    async delete(signature) { return backend.delete(signature); },
    async pgTelemetry() { return backend.readTelemetry?.() || null; },

    // stats() → library-wide hit-rate telemetry (lookups vs hits vs boosts).
    stats() {
      const hitRate = telemetry.lookups > 0 ? Math.round((telemetry.hits / telemetry.lookups) * 1000) / 1000 : 0;
      return {
        backend: backend.backend,
        lookups: telemetry.lookups,
        hits: telemetry.hits,
        boosts: telemetry.boosts,
        hitRate,
        fallbackReason,
      };
    },

    async close() { await backend.close?.(); },
  };
  return lib;
}
