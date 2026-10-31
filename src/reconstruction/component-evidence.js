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
