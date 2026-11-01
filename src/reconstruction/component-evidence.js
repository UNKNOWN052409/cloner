// Component-evidence records (task 3.4.1): the shared evidence type + merge and
// confidence-aggregation logic for the unified website-understanding model
// (src/reconstruction/website-understanding.js).
//
// Design contracts:
//  - One evidence record = ONE observation from ONE source: { source, ref, note, weight }.
//    `ref` locates the observation inside the artifact page (e.g. "elements[7].tag",
//    "styles.json#7", "network:/img/photo-1.png", "vision[7]"); `note` carries the
//    specifics ("tag=nav", "position=fixed zIndex=60"); `weight` ∈ [0,1] is that
//    source's vote strength for a component kind.
//  - Confidence aggregation never double-counts within one source: per source the
//    MAXIMUM weight is kept (several class hints are one kind of signal), then the
//    per-source maxima are combined with noisy-OR across DIFFERENT sources:
//        confidence = 1 - Π(1 - w_source)
//    Independent agreement across evidence sources raises confidence; repetition of
//    the same source type does not. Capped at 0.99 — nothing is ever "certain".
//  - Everything is pure/deterministic: same input → same output, no clocks, no randomness.

import { createHash } from "node:crypto";

// The closed vocabulary of evidence sources a component record may cite.
export const EVIDENCE_SOURCES = [
  "dom-tag",     // semantic HTML tag (nav/header/aside/main/table/…)
  "dom-role",    // ARIA role attribute
  "dom-aria",    // aria-label text
  "dom-class",   // class token OR id token hint
  "geometry",    // rect ratios / sibling arrangement measured from captured boxes
  "css",         // captured computed style (position/z-index/…), styles.json-backed
  "repetition",  // repeated sibling-group membership (mirrors component-tree-builder)
  "network",     // network recorder evidence (media/endpoint actually loaded)
  "vision",      // vision-model verdict (only merged for weak deterministic records)
];

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// makeEvidence(source, ref, note, weight) → evidence record. Unknown sources are
// kept verbatim (additive contract) but flagged via EVIDENCE_SOURCES membership
// checks in tests; weight is clamped into [0,1].
export function makeEvidence(source, ref, note = "", weight = 0) {
  return {
    source: String(source || "unknown"),
    ref: String(ref || ""),
    note: String(note || ""),
    weight: clamp01(weight),
  };
}

// aggregateConfidence(evidences) → confidence ∈ [0, 0.99], 3-decimal rounded.
// Per-source max weight, then noisy-OR across sources. Zero-weight records are
// ignored (they are provenance-only). Empty input → 0. Capped at 0.99 — no
// amount of agreeing evidence makes a heuristic "certain".
export function aggregateConfidence(evidences) {
  const perSource = new Map();
  for (const ev of evidences || []) {
    if (!ev || typeof ev !== "object") continue;
    const w = clamp01(ev.weight);
    if (w <= 0) continue;
    const s = String(ev.source || "unknown");
    const cur = perSource.get(s) ?? 0;
    if (w > cur) perSource.set(s, w);
  }
  let miss = 1;
  for (const w of perSource.values()) miss *= 1 - w;
  return Math.round(Math.max(0, Math.min(0.99, 1 - miss)) * 1000) / 1000;
}

// mergeEvidenceLists(a, b) → combined list, deduplicated by (source, ref).
// First-seen position wins; a later duplicate with a HIGHER weight replaces the
// earlier record in place (records stay ordered by first appearance — stable and
// deterministic).
export function mergeEvidenceLists(a, b) {
  const out = [];
  const byKey = new Map();
  const push = (ev) => {
    if (!ev || typeof ev !== "object") return;
    const key = String(ev.source || "unknown") + "\u0000" + String(ev.ref || "");
    const existing = byKey.get(key);
    if (existing === undefined) {
      const rec = { ...ev, weight: clamp01(ev.weight) };
      byKey.set(key, out.length);
      out.push(rec);
    } else if (clamp01(ev.weight) > out[existing].weight) {
      out[existing] = { ...ev, weight: clamp01(ev.weight) };
    }
  };
  for (const ev of a || []) push(ev);
  for (const ev of b || []) push(ev);
  return out;
}

// electKind(candidates) → { kind, confidence, evidence } | null.
// candidates: [{ kind, evidence: [record] }] — the kind votes proposed for ONE
// element by the deterministic rules. Winner = highest aggregateConfidence; ties
// broken by (1) higher summed raw weight, then (2) lexicographically smaller kind —
// both deterministic. Votes for kind "unknown" are dropped (unknown is the absence
// of a kind, not a kind).
export function electKind(candidates) {
  const byKind = new Map();
  for (const c of candidates || []) {
    if (!c || !c.kind || c.kind === "unknown") continue;
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    for (const ev of c.evidence || []) byKind.get(c.kind).push(ev);
  }
  let best = null;
  for (const [kind, evs] of byKind) {
    const confidence = aggregateConfidence(evs);
    const weight = evs.reduce((s, e) => s + clamp01(e?.weight), 0);
    const better =
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && weight > best._weight) ||
      (confidence === best.confidence && weight === best._weight && kind < best.kind);
    if (better) best = { kind, confidence, evidence: mergeEvidenceLists([], evs), _weight: weight };
  }
  if (!best) return null;
  const out = { kind: best.kind, confidence: best.confidence, evidence: best.evidence };
  return out;
}

// isStrong(record, floor) — the DOM_OVERRIDE_FLOOR semantics shared with
// vision-assist.js: a deterministic record at/above the floor is strong enough
// that vision may never override it (strict `< floor` is the overridable band).
export function isStrong(record, floor = 0.5) {
  return !!record && Number(record.confidence) >= floor;
}

// ===========================================================================
// Task 3.5.2 — cross-page reusable-component pattern detection + registry.
//
// Goal: the SAME component recurring across a site's pages (site header, main
// navigation, product cards, …) is detected ONCE as a shared pattern and every
// recurring instance is linked to that single pattern id — improving
// classification consistency — WITHOUT confusing coincidentally similar
// elements. Matching therefore requires agreement on THREE independent facets:
//
//   1. STRUCTURE  (componentStructureSignature): elected kind + tag + role +
//      class tokens. Content (text/aria/href/src), geometry and the within-page
//      repeated-group signature are deliberately excluded — those are INSTANCE
//      or ARRANGEMENT properties that legitimately differ between pages (a
//      3-item card grid and a 2-item card grid carry the same shared card
//      component; the grid container's own pattern carries the repetition).
//   2. BEHAVIOR   (componentInteractionShape): interaction-binding counts
//      (trigger marks exact, network refs quantized at 4+). Two elements with
//      identical structure but different interaction shape are coincidental —
//      merging them would let one page's wiring bleed into another's.
//   3. CONTEXT    (componentContext): the classified kind of the component's
//      parent (or root). A product card inside a card grid is a different
//      pattern from the same markup inside a table cell.
//
// Only subgroups that agree on all three facets AND recur on >= minPages
// distinct pages become patterns; everyone else stays unlinked with an explicit
// reason (provenance is complete, nothing silently dropped).
//
// Pattern confidence: noisy-OR across the per-instance confidences — each
// (page, component) observation is independent evidence for the shared
// pattern, so agreement raises confidence (same model as aggregateConfidence,
// one level up), capped at 0.99 like everything else here.
//
// All functions are pure/deterministic: same input → byte-identical output.
//
// INTEGRATION HOOK (for the integrator-owned reconstruction-pipeline.js /
// website-understanding.js): this module exposes the pattern store — it never
// reaches into the pipeline itself. After per-page understanding models exist
// (one buildUnderstandingPage() per captured page), attach cross-page pattern
// links with the documented two-call sequence, e.g. in the pipeline after the
// understanding fan-out:
//     const registry = buildComponentRegistry(pageUnderstandings);
//     for (const u of pageUnderstandings) u = annotateUnderstanding(u, registry);
// (annotateUnderstanding returns a NEW model — reassign, don't mutate). The
// annotated component.pattern = { patternId, instanceCount, pages, confidence }
// then travels with the component through reconstruction/export, preserving its
// own id, evidence, provenance and interaction bindings (instance-level
// overrides are never replaced by the shared pattern).
// ===========================================================================

const tokensOf = (cls) =>
  String(cls || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort();

// componentStructureSignature(component) → "kind|tag|role|class-tokens".
// Structure-only fingerprint: page-stable shape of the component. Returns null
// for non-records.
export function componentStructureSignature(component) {
  if (!component || typeof component !== "object") return null;
  const kind = String(component.kind || "unknown");
  const tag = String(component.tag || "").toLowerCase() || "-";
  const role = String(component.role || "").toLowerCase() || "-";
  const classes = tokensOf(component.cls).join(",") || "-";
  return `${kind}|${tag}|${role}|${classes}`;
}

// componentInteractionShape(component) → "t<triggers>|n<networks>".
// Behavior-only fingerprint. Trigger marks are exact (DOM-authored behavior);
// network refs are quantized (0 / 1-3 / 4+) because WHICH media a page loads is
// page-specific and must not split an otherwise identical shared component.
export function componentInteractionShape(component) {
  const t = component?.interaction?.triggers?.length || 0;
  const n = component?.interaction?.networkRefs?.length || 0;
  return `t${t}|n${n >= 4 ? "4+" : n}`;
}

// componentContext(component, understanding) → classified kind of the parent
// component (resolved through understanding.relationships.parentChild), or
// "(root)" when the component has no classified parent.
export function componentContext(component, understanding) {
  if (!component || !understanding) return "(root)";
  const parentOf = new Map(
    (understanding.relationships?.parentChild || []).map((e) => [e.child, e.parent]),
  );
  const parentId = parentOf.get(component.id);
  if (!parentId) return "(root)";
  const parent = (understanding.components || []).find((c) => c.id === parentId);
  return parent ? String(parent.kind) : "(root)";
}

// __patternIdFor(key) → "pat-" + first 12 hex of sha256(key). Deterministic:
// the same structural/behavioral/context key yields the same id on every page
// and in every run (the "detected once and linked" contract).
const patternIdFor = (key) => "pat-" + createHash("sha256").update(key).digest("hex").slice(0, 12);

const noisyOr = (values) => {
  let miss = 1;
  for (const v of values) miss *= 1 - Math.max(0, Math.min(1, Number(v) || 0));
  return Math.round(Math.max(0, Math.min(0.99, 1 - miss)) * 1000) / 1000;
};

// normalizeRegistryInput(understandings) → [{ pageId, understanding }]. Accepts
// bare understanding models (pageId taken from the model) or { pageId,
// understanding } records (the understandArtifactsDir() shape). Malformed
// entries are skipped with a warning.
function normalizeRegistryInput(understandings, warnings) {
  const records = [];
  for (const r of understandings || []) {
    const u = r && r.understanding ? r.understanding : r;
    if (!u || typeof u !== "object" || !Array.isArray(u.components)) {
      warnings.push("registry input skipped: entry without a components array");
      continue;
    }
    const pageId = (r && r.understanding ? r.pageId : u.pageId) ?? null;
    records.push({ pageId: pageId === null ? null : String(pageId), understanding: u });
  }
  return records;
}

// buildComponentRegistry(understandings, opts) → registry (see block comment).
//
// understandings: array of understanding models (website-understanding.js
// output) or { pageId, understanding } records.
// opts: {
//   minInstances   — minimum agreeing instances for a pattern (default 2)
//   minPages       — minimum DISTINCT pages a pattern must recur on (default 2;
//                    1 opts in to same-page-only repetition as patterns)
//   minConfidence  — per-instance floor; weaker instances are never merged into
//                    a shared pattern (default 0.5 — the DOM_OVERRIDE_FLOOR)
// }
export function buildComponentRegistry(understandings, opts = {}) {
  const minInstances = Math.max(1, Number(opts.minInstances ?? 2));
  const minPages = Math.max(1, Number(opts.minPages ?? 2));
  const minConfidence = Math.max(0, Math.min(1, Number(opts.minConfidence ?? 0.5)));
  const warnings = [];

  const records = normalizeRegistryInput(understandings, warnings);

  // 1. collect every instance with its three facets
  const instances = [];
  for (const { pageId, understanding: u } of records) {
    for (const c of u.components) {
      if (!c || !c.kind) continue;
      instances.push({
        pageId,
        componentId: c.id,
        elementIndex: c.elementIndex ?? null,
        kind: String(c.kind),
        structure: componentStructureSignature(c),
        shape: componentInteractionShape(c),
        context: componentContext(c, u),
        confidence: Number(c.confidence) || 0,
        evidenceSources: [...new Set((c.evidence || []).map((e) => String(e.source)))].sort(),
      });
    }
  }

  // 2. group by structure signature, then split each structure group by the
  //    behavior+context key. A structure group that fragments into several
  //    behavior/context subgroups is the coincidental-similarity case.
  const byStructure = new Map();
  for (const inst of instances) {
    if (!byStructure.has(inst.structure)) byStructure.set(inst.structure, []);
    byStructure.get(inst.structure).push(inst);
  }

  const patterns = [];
  const unlinked = [];
  for (const structure of [...byStructure.keys()].sort()) {
    const group = byStructure.get(structure);
    // behavior+context subgroups, deterministic ordering
    const subgroups = new Map();
    for (const inst of group) {
      const key = `${inst.shape}\u0000${inst.context}`;
      if (!subgroups.has(key)) subgroups.set(key, []);
      subgroups.get(key).push(inst);
    }
    const subKeys = [...subgroups.keys()].sort();
    const patternSubgroups = [];
    for (const key of subKeys) {
      const members = subgroups.get(key);
      const weak = members.filter((m) => m.confidence < minConfidence);
      const strong = members.filter((m) => m.confidence >= minConfidence);
      // below-floor members are NEVER merged into a shared pattern, whatever
      // the rest of the subgroup does — they get their own precise reason
      for (const m of weak) {
        unlinked.push({
          pageId: m.pageId, componentId: m.componentId, kind: m.kind, structure,
          reason: `confidence ${m.confidence} below floor ${minConfidence}`,
        });
      }
      // page spread counts STRONG members only — a weak observation on another
      // page must never help a pattern reach the cross-page threshold
      const pages = [...new Set(strong.map((m) => m.pageId))].sort();
      if (strong.length < minInstances || pages.length < minPages) {
        const reason = pages.length < minPages
          ? `recurs on ${pages.length} page(s), fewer than minPages ${minPages}`
          : `only ${strong.length} qualifying instance(s), fewer than minInstances ${minInstances}`;
        for (const m of strong) {
          unlinked.push({
            pageId: m.pageId, componentId: m.componentId, kind: m.kind, structure,
            reason,
          });
        }
        continue;
      }
      patternSubgroups.push({ key, members: strong, pages });
    }
    if (patternSubgroups.length && subKeys.length > patternSubgroups.length) {
      // structure shared but behavior/context split — the leftovers were (or
      // will be) emitted as unlinked above; surface the discrimination itself
      warnings.push(
        `structure "${structure}" matched ${patternSubgroups.length} behavior/context subgroup(s) but ${subKeys.length - patternSubgroups.length} subgroup(s) stayed separate — coincidental-similarity guard`,
      );
    }
    for (const { key, members, pages } of patternSubgroups) {
      const [shape, context] = key.split("\u0000");
      const patternId = patternIdFor(`${structure}\u0000${key}`);
      const sorted = [...members].sort((a, b) =>
        a.pageId === b.pageId
          ? String(a.componentId) < String(b.componentId) ? -1 : 1
          : String(a.pageId) < String(b.pageId) ? -1 : 1);
      patterns.push({
        patternId,
        kind: sorted[0].kind,
        structure,
        interactionShape: shape,
        context,
        pages,
        instanceCount: sorted.length,
        confidence: noisyOr(sorted.map((m) => m.confidence)), // independent observations → noisy-OR
        instances: sorted.map((m) => ({ pageId: m.pageId, componentId: m.componentId, elementIndex: m.elementIndex })),
        provenance: {
          evidenceSources: [...new Set(sorted.flatMap((m) => m.evidenceSources))].sort(),
          instanceConfidences: sorted.map((m) => m.confidence),
          example: { pageId: sorted[0].pageId, componentId: sorted[0].componentId },
        },
      });
    }
  }

  patterns.sort((a, b) => (a.patternId < b.patternId ? -1 : a.patternId > b.patternId ? 1 : 0));
  unlinked.sort((a, b) =>
    a.pageId === b.pageId
      ? String(a.componentId) < String(b.componentId) ? -1 : 1
      : String(a.pageId) < String(b.pageId) ? -1 : 1);

  return {
    patterns,
    unlinked,
    stats: {
      pages: records.length,
      components: instances.length,
      patterns: patterns.length,
      linkedInstances: patterns.reduce((s, p) => s + p.instances.length, 0),
      unlinkedInstances: unlinked.length,
    },
    options: { minInstances, minPages, minConfidence },
    warnings,
  };
}

// registryForPage(registry, pageId) → { patterns, instances } limited to ONE
// page: the shared patterns available there and this page's instance bindings.
export function registryForPage(registry, pageId) {
  const want = String(pageId ?? "");
  const instances = [];
  const patternIds = new Set();
  for (const p of registry?.patterns || []) {
    for (const inst of p.instances) {
      if (String(inst.pageId) !== want) continue;
      instances.push({ ...inst, patternId: p.patternId, kind: p.kind });
      patternIds.add(p.patternId);
    }
  }
  return {
    pageId: pageId ?? null,
    patterns: (registry?.patterns || []).filter((p) => patternIds.has(p.patternId)),
    instances: instances.sort((a, b) =>
      String(a.componentId) < String(b.componentId) ? -1 : 1),
  };
}

// annotateUnderstanding(understanding, registry) → NEW understanding model with
// component.pattern = { patternId, instanceCount, pages, confidence } on every
// linked instance. Purely additive: the component keeps its own id, evidence,
// provenance and interaction bindings untouched (instance-level overrides are
// never replaced by the shared pattern), and the input model is not mutated.
export function annotateUnderstanding(understanding, registry) {
  if (!understanding || typeof understanding !== "object" || !registry) return understanding;
  const byComponentKey = new Map();
  for (const p of registry.patterns || []) {
    for (const inst of p.instances) {
      byComponentKey.set(`${inst.pageId}\u0000${inst.componentId}`, {
        patternId: p.patternId,
        instanceCount: p.instanceCount,
        pages: p.pages,
        confidence: p.confidence,
      });
    }
  }
  return {
    ...understanding,
    components: (understanding.components || []).map((c) => {
      const hit = byComponentKey.get(`${understanding.pageId}\u0000${c.id}`);
      return hit ? { ...c, pattern: hit } : c;
    }),
  };
}

// registrySummary(registry) — compact summary for pipeline reports.
export function registrySummary(registry) {
  if (!registry) return null;
  const byKind = {};
  for (const p of registry.patterns || []) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  return {
    patterns: (registry.patterns || []).length,
    patternsByKind: byKind,
    linkedInstances: registry.stats?.linkedInstances ?? 0,
    unlinkedInstances: registry.stats?.unlinkedInstances ?? 0,
    warnings: registry.warnings || [],
  };
}
