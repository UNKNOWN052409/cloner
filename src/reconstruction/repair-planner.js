// Repair planner (task 3.4.5): verification defects → minimal, bounded repair actions.
//
// Input: the defect list from 3.4.3's classifier (classifyDefects,
// ./visual-diff-classifier.js — kind/severity/salience/confidence/refs/action)
// plus interaction defects harvested from verification's dead-attribute report
// (src/reconstruction/verify.js stage-2 "no unnecessary/dead elements" check and the
// visual stage's hex.extra dead-trigger ids).
//
// Output: { actions, skipped, threshold, stats }
//   actions — the ordered repair plan. Each action:
//               { id, kind, target, payload, severity, confidence, priority,
//                 defectKinds, refs, reason, evidence }
//             kind ∈ REPAIR_KINDS:
//               css-override        scoped `.cx-N { prop: value; }` rule for
//                                   typography/stacking drift — same format as
//                                   refineTypography (visual-fidelity-analyzer.js:524)
//               token-fix           color override (`.cx-N` or body/`:root`), written
//                                   with !important — the clone-fixes.css autoRemediate
//                                   pattern (src/reconstruction/verify.js:459-472)
//               geometry-fix        scoped box correction (transform/size) built from
//                                   the classifier's adjust deltas
//               asset-remap         rewrite a broken asset reference to a local
//                                   replacement resolved from opts.assetMap
//               interaction-rewire  dead-attribute pruning (verify.js:476-485 pattern)
//   evidence — every action carries the defect's measured evidence string, so
//             a review of the plan traces each fix to the numbers that justify
//             it. Layout defects (layout-header-collapsed / -unstyled /
//             layout-overflow-x / layout-collapsed-section, from
//             analysis/layout-analyzer.js buildDetections) map onto the same
//             vocabulary: css-override for min-height/overflow-x, token-fix
//             for the header background, geometry-fix for section min-height.
//             Their gates live here, in the planner: overflow-x is emitted ONLY
//             when the defect's measured.originalHadNoOverflow is true, and a
//             measured original background is required before any background
//             override — no invented styling, ever.
//   skipped — defects below the confidence threshold or without a minimal bounded
//             action (e.g. add-component needs structural regeneration, region-only
//             pixel drift carries no measured value).
//
// Grouping: related defects merge into ONE action when they share the repair kind
// and target (e.g. two typography fields on the same `.cx-N` element → one
// css-override rule with both props; the higher-severity defect's value wins on
// prop collision). The grouped action's confidence is the MIN of its members —
// it is only as reliable as its weakest defect.
//
// Ordering: priority = severity × area. 3.4.3's severity is already area-weighted
// (severityFor, visual-diff-classifier.js:57-59: severity = areaRatio × 8 ×
// (0.35 + 0.65·intensity)), so ordering by severity IS ordering by severity×area
// by construction; a defect that carries an explicit numeric `area` field has it
// multiplied in directly. Ties break confidence desc → target asc → kind asc —
// fully deterministic.
//
// Pure function: no I/O, no browser, deterministic.
export const REPAIR_KINDS = Object.freeze([
  "css-override", "token-fix", "asset-remap", "interaction-rewire", "geometry-fix",
]);

// Defects below this confidence are skipped. Rationale: 0.6 excludes region-only
// pixel evidence (confidence 0.5, visual-diff-classifier.js:199) — pixel-grid
// drift alone must not rewrite CSS — while every element-level defect classifies
// at ≥ 0.6 (geometry 0.6+0.4·intensity, typography 0.85, color 0.8, stacking 0.7,
// missing-asset 0.8).
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const camelToKebab = (s) => String(s || "").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const unique = (arr) => [...new Set(arr)];

// mapDefect(defect, opts) → { kind, target, payload } | { multi: [...] } | { skip: reason }
// Maps one 3.4.3 classifier defect (or a verification dead-attribute defect) onto
// the minimal repair vocabulary. `opts.assetMap` resolves restore-asset defects
// to a concrete local replacement path (Map or plain object).
function mapDefect(defect, opts) {
  const a = defect.action && typeof defect.action === "object" ? defect.action : {};
  // layout-analyzer detections name their fix target `selector` (the clone-side
  // selector the analyzer measured); classifier defects use action.target/target.
  const target = String(a.target || defect.target || defect.selector || "").trim();

  switch (defect.kind) {
    case "typography": {
      // classifier: typography-override { target: ".cx-N", prop, value }
      const prop = camelToKebab(a.prop || defect.field);
      const value = a.value ?? defect.original;
      if (!target || !prop || value === null || value === undefined || value === "") {
        return { skip: "typography defect without target/field/value" };
      }
      return { kind: "css-override", target, payload: { selector: target, props: { [prop]: String(value) } } };
    }
    case "stacking": {
      // classifier: stacking-fix { target: ".cx-N", values: { zIndex: ... } }
      const values = a.values || defect.original || {};
      const props = {};
      for (const [k, v] of Object.entries(values)) {
        if (v !== null && v !== undefined && v !== "") props[camelToKebab(k)] = String(v);
      }
      if (!target || !Object.keys(props).length) return { skip: "stacking defect without target/values" };
      return { kind: "css-override", target, payload: { selector: target, props } };
    }
    case "color": {
      // classifier: color-token-fix { target: ".cx-N" | "region:N", prop, value? }
      const value = a.value ?? defect.original;
      if (!target || value === null || value === undefined || value === "") {
        return {
          skip: /^region:/.test(target)
            ? "region-level pixel drift has no measured color value — not repairable without element evidence"
            : "color defect without target/value",
        };
      }
      const prop = camelToKebab(a.prop || defect.field || "backgroundColor");
      return {
        kind: "token-fix",
        target,
        payload: { selector: target, props: { [prop]: String(value) }, important: true },
      };
    }
    case "geometry": {
      // classifier: geometry-fix { target: ".cx-N", adjust: { dx, dy, dw, dh } } and
      // defect.original = the ORIGINAL box { x, y, w, h }. Position correction is a
      // transform (no reflow of siblings); size correction resets to the measured
      // original box when it is known. keep-if-improved in the executor guards any
      // wrong guess (a non-improving fix is reverted).
      const adjust = a.adjust || {};
      const orig = defect.original || {};
      const props = {};
      if (adjust.dx || adjust.dy) props.transform = `translate(${adjust.dx || 0}px, ${adjust.dy || 0}px)`;
      if ((adjust.dw || adjust.dh) && Number(orig.w) > 0) props.width = `${orig.w}px`;
      if ((adjust.dw || adjust.dh) && Number(orig.h) > 0) props.height = `${orig.h}px`;
      if (!target || !Object.keys(props).length) return { skip: "geometry defect without target/adjustable box" };
      return { kind: "geometry-fix", target, payload: { selector: target, props } };
    }
    case "missing-asset": {
      // classifier: restore-asset { target: ".cx-N", tag, src }. The planner cannot
      // invent a local file — the replacement comes from opts.assetMap (asset-map
      // artifact) or an explicit action.to; without one the defect is skipped
      // rather than repaired with a guess.
      const from = a.src || defect.original?.src || null;
      if (!from) return { skip: "missing-asset defect without a source reference" };
      const assetMap = opts.assetMap instanceof Map ? Object.fromEntries(opts.assetMap) : (opts.assetMap || null);
      const to = (assetMap && assetMap[from]) || a.to || null;
      if (!to) return { skip: `no remap target for "${from}" — pass opts.assetMap` };
      return {
        kind: "asset-remap",
        target: target || "index.html",
        payload: { file: a.file || "index.html", attr: a.attr || "src", from, to },
      };
    }
    case "missing-component":
      return { skip: "missing components need structural regeneration — no bounded minimal action" };
    case "layout-header-collapsed":
    case "layout-collapsed-section": {
      // analysis/layout-analyzer.js detections: the original measured the region
      // at N px tall, the clone renders it (near-)zero. min-height — never a
      // fixed height, so the fix can never clip real content — from the MEASURED
      // original value; the header's captured background rides along when one
      // was recorded (empty header band = no height AND no background).
      const m = defect.measured || {};
      const origH = Number(m.originalH);
      if (!(origH > 0)) return { skip: `${defect.kind} without a measured original height` };
      if (!target) return { skip: `${defect.kind} with no clone selector — element missing from the clone needs structural regeneration` };
      const props = { "min-height": `${Math.round(origH)}px` };
      const bg = m.originalBg;
      if (defect.kind === "layout-header-collapsed" && bg && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/i.test(bg)) {
        props.background = bg; // measured captured value only — never invented
      }
      return {
        kind: defect.kind === "layout-header-collapsed" ? "css-override" : "geometry-fix",
        target,
        payload: { selector: target, props },
      };
    }
    case "layout-header-unstyled": {
      // original captured a real header background, the clone's is transparent —
      // token-fix with !important so it beats inherited/inline values.
      const bg = (defect.measured || {}).originalBg;
      if (!bg || bg === "transparent" || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/i.test(bg)) {
        return { skip: "header-unstyled without a measured original background" };
      }
      if (!target) return { skip: "header-unstyled with no clone selector" };
      return { kind: "token-fix", target, payload: { selector: target, props: { "background-color": String(bg) }, important: true } };
    }
    case "layout-overflow-x": {
      // The measured container scrolls horizontally where the original did not.
      // Two evidence gates BEFORE emitting:
      //  1. originalHadNoOverflow — when the original scrolls too, clipping
      //     would diverge from the original instead of repairing it.
      //  2. isScrollRoot — overflow-x:hidden only ever lands on the scroll
      //     root (html/body). An inner header/nav whose CONTENT is wider than
      //     itself keeps reporting scrollWidth > clientWidth no matter what
      //     overflow value it carries, so such a fix can never show a measured
      //     improvement — the executor's keep-if-improved loop would revert it
      //     and hard-stop the plan. The bounded repair for the page-level
      //     symptom is the root containment fix (already emitted for body).
      const m = defect.measured || {};
      if (m.originalHadNoOverflow !== true) {
        return { skip: "original also overflows horizontally — clipping would diverge from the original" };
      }
      if (m.isScrollRoot === false) {
        return { skip: "inner container overflow originates in its content width — the bounded repair is root scroll containment (html/body), not clipping the container" };
      }
      if (!target) return { skip: "overflow defect without a measured container selector" };
      return { kind: "css-override", target, payload: { selector: target, props: { "overflow-x": "hidden" } } };
    }
    case "interaction":
    case "dead-interaction":
    case "dead-attr":
    case "dead-trigger": {
      // verification dead-attribute defect: one interaction-rewire action per dead id
      // (strip ` attr="value"` — the autoRemediate dead-attribute pattern, verify.js:481)
      const ids = defect.deadAttrs || defect.dead || a.deadAttrs || a.dead || [];
      if (!Array.isArray(ids) || !ids.length) return { skip: "interaction defect without dead attribute ids" };
      return {
        multi: ids.map((id) => ({
          kind: "interaction-rewire",
          target: `[data-cloner-trigger="${id}"]`,
          payload: { file: a.file || "index.html", attr: a.attr || "data-cloner-trigger", value: String(id), op: a.op || "strip" },
        })),
      };
    }
    default: {
      // escape hatch: a defect whose action already carries a concrete repair kind
      // and payload passes through verbatim (callers that pre-resolved the fix)
      if (REPAIR_KINDS.includes(a.kind) && a.payload && typeof a.payload === "object") {
        return { kind: a.kind, target: target || a.kind, payload: a.payload };
      }
      return { skip: `unmapped defect kind "${defect.kind}"` };
    }
  }
}

// planRepairs(defects, opts?) → { actions, skipped, threshold, stats }
// opts: { confidenceThreshold?, assetMap? }
export function planRepairs(defects, opts = {}) {
  const threshold = Number.isFinite(opts.confidenceThreshold)
    ? clamp01(opts.confidenceThreshold)
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const list = (Array.isArray(defects) ? defects : []).filter((d) => d && typeof d === "object");

  const actions = [];
  const skipped = [];
  const byKey = new Map(); // "kind::target" → grouped action (props-mergeable kinds only)

  for (const defect of list) {
    const kindLabel = String(defect.kind || "unknown");
    const confidence = clamp01(defect.confidence);
    if (confidence < threshold) {
      skipped.push({ kind: kindLabel, confidence, reason: `confidence ${confidence} below threshold ${threshold}` });
      continue;
    }
    const mapped = mapDefect(defect, opts);
    if (mapped.skip) {
      skipped.push({ kind: kindLabel, confidence, reason: mapped.skip });
      continue;
    }
    const severity = clamp01(defect.severity);
    const area = Number.isFinite(defect.area) && defect.area > 0 ? defect.area : 1;
    const priority = severity * area;

    const emit = (one) => {
      // group related defects: same props-bearing kind + target merge into one rule
      const mergeable = one.kind === "css-override" || one.kind === "token-fix";
      const key = mergeable ? `${one.kind}::${one.target}` : null;
      if (mergeable && byKey.has(key)) {
        const prev = byKey.get(key);
        for (const [p, v] of Object.entries(one.payload.props)) {
          if (!(p in prev.payload.props)) prev.payload.props[p] = v; // most severe defect's value wins
        }
        prev.defectKinds = unique([...prev.defectKinds, kindLabel]);
        prev.refs = unique([...prev.refs, ...(defect.refs || [])]);
        prev.severity = Math.max(prev.severity, severity);
        prev.confidence = Math.min(prev.confidence, confidence); // as reliable as its weakest member
        prev.priority = Math.max(prev.priority, priority);
        // evidence chains: a grouped action cites every defect that fed it
        if (defect.evidence) prev.evidence = prev.evidence ? `${prev.evidence} | ${defect.evidence}` : defect.evidence;
        return;
      }
      const action = {
        id: `R${actions.length + 1}`,
        kind: one.kind,
        target: one.target,
        payload: one.payload,
        severity,
        confidence,
        priority,
        defectKinds: [kindLabel],
        refs: [...(defect.refs || [])],
        reason: `repair ${kindLabel} via ${one.kind}`,
        evidence: defect.evidence || null, // measured numbers this fix is justified by
      };
      actions.push(action);
      if (mergeable) byKey.set(key, action);
    };

    if (mapped.multi) mapped.multi.forEach(emit);
    else emit(mapped);
  }

  // deterministic order: severity×area (priority) desc → confidence desc → target → kind
  actions.sort((x, y) =>
    y.priority - x.priority ||
    y.confidence - x.confidence ||
    (x.target < y.target ? -1 : x.target > y.target ? 1 : 0) ||
    (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0),
  );
  actions.forEach((act, i) => { act.id = `R${i + 1}`; }); // renumber in final order

  return {
    actions,
    skipped,
    threshold,
    stats: { input: list.length, planned: actions.length, skipped: skipped.length },
  };
}
