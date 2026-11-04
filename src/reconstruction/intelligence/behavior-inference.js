// Behavior inference (plan §"Reconstruction intelligence" — interaction
// reconstruction): derives DECLARATIVE behavior descriptors from
// website-understanding models (plan 3.4.1 shape). A descriptor names the
// widget behavior the captured evidence supports (tabs, accordion, carousel,
// modal flow, infinite scroll, form flow) and cites the exact model records
// that support it, so the generated runtime can replay the behavior and the
// report can audit it.
//
// Honesty contract (plan: "no invented content without evidence"): a behavior
// is emitted ONLY when its evidence rule fires on real model records. A page
// with no such evidence yields [] — never guessed behaviors. Every descriptor
// carries per-rule confidence in [0,1] computed deterministically from the
// evidence strength (no clocks, no randomness).

// Interaction-kind hints a trigger's text/class may carry, per behavior. These
// are GENERIC vocabulary rules (same spirit as regionTokenHints' extensible
// registry), not target-specific hardcodes.
const NEXT_LABELS = /(^|\W)(next|»|›|forward|arrow|slide|carousel|chevron)/i;
const PREV_LABELS = /(^|\W)(prev|previous|«|‹|arrow-left)/i;

function triggerText(t) {
  return String(t?.label || t?.text || t?.id || "").toLowerCase();
}

// map model trigger list onto component element indexes for group reasoning
function triggersByElement(model) {
  const byEl = new Map();
  for (const t of model?.interactions?.triggers || []) {
    if (typeof t.elementIndex !== "number") continue;
    if (!byEl.has(t.elementIndex)) byEl.set(t.elementIndex, []);
    byEl.get(t.elementIndex).push(t);
  }
  return byEl;
}

function groupEvidence(model, byEl) {
  const groups = model?.relationships?.repeatedGroups || [];
  const out = [];
  for (const g of groups) {
    const triggerMembers = (g.memberIndexes || []).filter((i) => byEl.has(i));
    if (triggerMembers.length) {
      out.push({ group: g, triggerMembers });
    }
  }
  return out;
}

// ALL repeated groups (no trigger-membership requirement) — the carousel rule
// keys on the strip arrangement, not on the members being triggers
function allGroups(model) {
  return (model?.relationships?.repeatedGroups || []).filter((g) => (g.memberIndexes || []).length >= 3);
}

const conf3 = (v) => Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));

// inferBehaviors(understandingModel) → descriptor list (deterministic).
export function inferBehaviors(model) {
  if (!model || typeof model !== "object") return [];
  const descriptors = [];
  const byEl = triggersByElement(model);
  const comps = model.components || [];
  const compByIndex = new Map(comps.map((c) => [c.elementIndex, c]));
  const parentChild = model.relationships?.parentChild || [];
  const childrenOf = new Map();
  for (const e of parentChild) {
    if (!childrenOf.has(e.parent)) childrenOf.set(e.parent, []);
    childrenOf.get(e.parent).push(e.child);
  }

  // ---- tabs: repeated trigger group whose members share a container with
  // pane-like siblings (same-parent children ≈ trigger count + content) ----
  for (const { group, triggerMembers } of groupEvidence(model, byEl)) {
    if (triggerMembers.length < 2) continue;
    const containerIndex = group.containerIndex;
    const containerChildren = childrenOf.get(group.containerComponentId) || [];
    const paneish = containerChildren.filter((id) => {
      const c = comps.find((x) => x.id === id);
      return c && Number(c.provenance?.childCount) > 0 && c.kind !== "navigation";
    });
    const evidence = [
      { ref: `relationships.repeatedGroups[${group.signature}]`, note: `${triggerMembers.length} repeated trigger member(s)` },
      { ref: `components[${containerIndex}]`, note: `container with ${paneish.length} content child(ren)` },
    ];
    if (paneish.length >= 1) {
      descriptors.push({
        type: "tabs",
        confidence: conf3(0.5 + 0.1 * Math.min(3, triggerMembers.length - 2) + 0.05 * Math.min(3, paneish.length)),
        evidence,
        descriptor: {
          triggers: triggerMembers.map((i) => byEl.get(i)[0]?.id),
          panes: paneish,
          behavior: "show-one-pane-per-trigger",
        },
      });
    }

    // ---- accordion: repeated trigger group whose members CONTAIN content
    // (each trigger member is itself a parent) and there are no panes ----
    const collapsible = triggerMembers.filter((i) => Number(compByIndex.get(i)?.provenance?.childCount) > 0);
    if (collapsible.length === triggerMembers.length && paneish.length === 0 && triggerMembers.length >= 2) {
      descriptors.push({
        type: "accordion",
        confidence: conf3(0.55 + 0.1 * Math.min(3, triggerMembers.length - 2)),
        evidence: [
          { ref: `relationships.repeatedGroups[${group.signature}]`, note: `${triggerMembers.length} self-contained trigger member(s)` },
          { ref: `components[${containerIndex}]`, note: "no sibling pane structure" },
        ],
        descriptor: {
          triggers: triggerMembers.map((i) => byEl.get(i)[0]?.id),
          behavior: "toggle-member-content",
        },
      });
    }
  }

  // ---- carousel: a repeated group of ≥3 same-shape children inside a
  // container much wider than one member (overflow strip) + next/prev triggers
  // (ANY repeated strip qualifies — members need not be triggers)
  const nextTriggers = [...byEl.values()].flat().filter((t) => NEXT_LABELS.test(triggerText(t)));
  const prevTriggers = [...byEl.values()].flat().filter((t) => PREV_LABELS.test(triggerText(t)));
  for (const group of allGroups(model)) {
    const container = comps.find((c) => c.elementIndex === group.containerIndex);
    if (!container) continue;
    const member = comps.find((c) => c.elementIndex === group.memberIndexes[0]);
    if (!member || !(member.rect?.w > 0)) continue;
    const overflow = container.rect?.w >= 2 * member.rect.w;
    const navTriggers = nextTriggers.length + prevTriggers.length;
    if (overflow || navTriggers >= 1) {
      descriptors.push({
        type: "carousel",
        confidence: conf3(0.45 + (overflow ? 0.2 : 0) + 0.1 * Math.min(2, navTriggers)),
        evidence: [
          { ref: `relationships.repeatedGroups[${group.signature}]`, note: `${group.memberIndexes.length} repeated member(s) of width ${member.rect.w}px` },
          { ref: `components[${container.elementIndex}]`, note: `container ${container.rect?.w}px ${overflow ? "overflows" : "wraps"} member width` },
          ...(navTriggers ? [{ ref: "interactions.triggers", note: `${nextTriggers.length} next / ${prevTriggers.length} prev trigger(s)` }] : []),
        ],
        descriptor: {
          members: group.memberIndexes,
          next: nextTriggers.map((t) => t.id),
          prev: prevTriggers.map((t) => t.id),
          behavior: "slide-through-members",
        },
      });
      break; // one carousel per page — first (deterministic) group wins
    }
  }

  // ---- modal flow: a modal-classified component + triggers that can open it ----
  const modals = comps.filter((c) => c.kind === "modal");
  const triggerCount = (model.interactions?.triggers || []).length;
  if (modals.length && triggerCount >= 1) {
    descriptors.push({
      type: "modal-flow",
      confidence: conf3(0.6 + 0.05 * Math.min(4, triggerCount)),
      evidence: [
        { ref: `components[${modals[0].elementIndex}]`, note: `modal component (confidence ${modals[0].confidence})` },
        { ref: "interactions.triggers", note: `${triggerCount} captured trigger(s)` },
      ],
      descriptor: {
        modals: modals.map((m) => m.id),
        triggers: (model.interactions?.triggers || []).map((t) => t.id),
        behavior: "open-modal-on-trigger",
      },
    });
  }

  // ---- infinite scroll: tall page + repeated content + fetch endpoints ----
  const pageH = Number(model.pageMetrics?.height) || 0;
  const imageCount = Number(model.interactions?.imageCount) || 0;
  const bigGroup = (model.relationships?.repeatedGroups || []).some((g) => (g.memberIndexes || []).length >= 6);
  const fetchEndpoints = (model.interactions?.networkEndpoints || []).length;
  if (pageH >= 3000 && bigGroup && fetchEndpoints >= 1) {
    descriptors.push({
      type: "infinite-scroll",
      confidence: conf3(0.55 + 0.05 * Math.min(4, fetchEndpoints)),
      evidence: [
        { ref: "pageMetrics.height", note: `${pageH}px page height` },
        { ref: "relationships.repeatedGroups", note: "repeated content group with ≥6 members" },
        { ref: "interactions.networkEndpoints", note: `${fetchEndpoints} fetch endpoint(s)` },
      ],
      descriptor: { behavior: "load-more-on-scroll" },
    });
  }

  // ---- form flow: form component with ≥2 fields + a captured trigger ----
  const forms = comps.filter((c) => c.kind === "form");
  if (forms.length && triggerCount >= 1) {
    for (const f of forms) {
      const fields = Number(f.provenance?.childCount) || 0;
      if (fields < 2) continue;
      descriptors.push({
        type: "form-flow",
        confidence: conf3(0.5 + 0.05 * Math.min(4, fields)),
        evidence: [
          { ref: `components[${f.elementIndex}]`, note: `form component with ${fields} field(s)` },
          { ref: "interactions.triggers", note: `${triggerCount} captured trigger(s)` },
        ],
        descriptor: { formId: f.id, behavior: "fill-and-submit" },
      });
      break; // first (element-order) form wins — deterministic
    }
  }

  return descriptors.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence);
}

// summarizeBehaviors(descriptors) → compact per-type counts for reports.
export function summarizeBehaviors(descriptors) {
  const types = {};
  for (const d of descriptors || []) types[d.type] = (types[d.type] || 0) + 1;
  return { behaviors: descriptors.length, types };
}
