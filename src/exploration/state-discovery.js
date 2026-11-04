// State graph (spec §8): nodes = page/interaction states with fingerprints and
// evidence references; edges = interactions with expected/actual transitions.
// Deduplication via url + DOM-signature fingerprint prevents re-exploration.
//
// Task 3.5.5 (intelligent exploration optimization, additive): the graph now
// also keeps a CANDIDATE queue. Candidates are states we could produce
// (navigate to a route / click an interaction) known BEFORE the expensive
// browser operation runs. Each candidate is
//   - deduplicated by the SAME fingerprint addState uses, plus a
//     content-equivalence key (pathname + DOM signature, query noise ignored),
//     so equivalent states are skipped before navigating, not after (plan
//     §3.5.5 step 2);
//   - scored by interaction potential (interactive-element counts embedded in
//     the DOM signature) with an unexplored bonus, so high-value unexplored
//     states are planned first (step 3);
//   - capped by planStates({ budget }) — a binding budget explores the
//     best-scored candidates first and counts every skipped duplicate as a
//     navigation saved (steps 5, 8).
// addState/addEdge/setStatus/serialize keep their exact prior semantics; all
// new capability is behind new exports and new methods.
import { createHash } from "node:crypto";

function sha1(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

// state fingerprint: url + DOM signature (unchanged — identical to the
// fingerprint addState has always computed)
export function stateFingerprint(url, domSig) {
  return sha1(url + "::" + domSig);
}

// content-equivalence key: same pathname + same DOM signature = same documented
// state even when the URL query differs (/products vs /products?ref=menu).
// Query noise is ignored; the path and rendered structure decide identity.
export function contentKey(url, domSig) {
  let path = url;
  try { path = new URL(url).pathname; } catch {}
  return sha1(path + "::" + domSig);
}

// interaction potential: expected reconstruction value of a state derived from
// the interactive-element counts of its DOM signature. Weights favor controls
// that reliably yield NEW states (tabs/modals/dialogs over static text).
export function interactionPotentialScore(counts = {}, { parentExplored = false } = {}) {
  const c = {
    buttons: Number(counts.buttons) || 0,
    links: Number(counts.links) || 0,
    inputs: Number(counts.inputs) || 0,
    tables: Number(counts.tables) || 0,
    canvases: Number(counts.canvases) || 0,
    modals: Number(counts.modals) || 0,
    tabs: Number(counts.tabs) || 0,
    headers: Number(counts.headers) || 0,
  };
  let s =
    c.buttons * 3 +
    c.tabs * 6 +
    c.modals * 5 +
    c.inputs * 2 +
    c.canvases * 2 +
    c.tables * 1 +
    c.links * 0.5 +
    c.headers * 0.25;
  if (s === 0) s = 0.5; // static page still worth one visit, lowest rank
  if (parentExplored) s += 1; // cheap to reach from an already-explored parent
  return Math.round(s * 100) / 100;
}

// parse the DOM_SIGNATURE_SCRIPT payload ({ c: counts, t: textHash }) so
// candidates can be scored from a signature the pipeline already evaluates —
// no extra browser round-trip needed for scoring
export function parseSignatureCounts(domSig) {
  try {
    const parsed = JSON.parse(domSig);
    if (parsed && typeof parsed === "object" && parsed.c) return parsed.c;
  } catch {}
  return {};
}

export function createStateGraph({ restore = null } = {}) {
  const nodes = new Map();
  const edges = [];
  const byFingerprint = new Map();
  const byContent = new Map(); // contentKey → node (same view re-queued under a new query)
  const candidates = new Map(); // id -> candidate (pending = not yet explored)
  const knownContentKeys = new Set(); // equivalence keys of explored nodes + queued candidates
  const counters = {
    candidatesQueued: 0,
    candidateDuplicates: 0, // skipped pre-navigation: fingerprint or content-equivalent already known
    navigationsSaved: 0,    // expensive browser ops avoided (superset of candidateDuplicates)
    plannedTotal: 0,
    restoredStates: 0,
  };

  // resumption (task 3.5.5 step 7): re-seed the dedup index from a previously
  // serialized graph so an interrupted job continues without re-exploring
  // states it already captured. Nodes carry their fingerprint; content keys
  // rebuild from the stored domSig when present (older artifacts may not have one).
  if (restore && Array.isArray(restore.nodes)) {
    for (const n of restore.nodes) {
      if (!n || !n.fingerprint) continue;
      byFingerprint.set(n.fingerprint, { ...n, restored: true });
      if (n.domSig) byContent.set(contentKey(n.url, n.domSig), { ...n, restored: true });
      counters.restoredStates++;
      if (n.domSig) knownContentKeys.add(contentKey(n.url, n.domSig));
    }
  }

  function fingerprint(url, domSig) {
    return stateFingerprint(url, domSig);
  }

  function nextId(prefix, size) {
    return prefix + String(size + 1).padStart(3, "0");
  }

  return {
    // live view (a plain property here would be a permanently-empty snapshot)
    get nodes() { return [...nodes.values()]; },
    get edges() { return edges; },
    // add a state; returns { node, duplicate }
    addState({ url, domSig, parentStateId = null, interaction = null, screenshotRef = null, domRef = null, viewport = null, status = "discovered" }) {
      const fp = fingerprint(url, domSig);
      if (byFingerprint.has(fp)) {
        return { node: byFingerprint.get(fp), duplicate: true };
      }
      // task 3.4.x fix: content-equivalent states (same pathname + DOM signature —
      // e.g. GA rewriting ?_gl per click) must NOT become new documented pages.
      // The equivalence set existed for pre-navigation candidates only; consult
      // it here so interaction-driven captures dedupe too.
      const ck = contentKey(url, domSig);
      if (byContent.has(ck)) {
        return { node: byContent.get(ck), duplicate: true };
      }
      const id = nextId("s", nodes.size);
      const node = {
        id,
        url,
        parentStateId,
        fingerprint: fp,
        interaction,
        viewport,
        screenshotRef,
        domRef,
        domSig: domSig == null ? null : String(domSig).slice(0, 200), // 3.5.5: enables coverage-vs-visitation analysis
        timestamp: new Date().toISOString(),
        status,
      };
      nodes.set(id, node);
      byFingerprint.set(fp, node);
      byContent.set(ck, node);
      knownContentKeys.add(ck);
      return { node, duplicate: false };
    },
    // record a transition edge between states
    addEdge({ fromStateId, toStateId, trigger, action, expected, actual, success, evidence = null }) {
      edges.push({
        id: nextId("e", edges.length),
        fromStateId,
        toStateId,
        trigger: String(trigger || "").slice(0, 80),
        action,
        expected: String(expected || "").slice(0, 80),
        actual: String(actual || "").slice(0, 120),
        success: !!success,
        evidence,
      });
    },
    // mark a state's exploration outcome
    setStatus(stateId, status) {
      const n = nodes.get(stateId);
      if (n) n.status = status;
    },

    // ---- task 3.5.5 candidate layer (additive) ----

    // queue a state candidate BEFORE the browser operation that would produce
    // it. Deduplicates against explored nodes and other queued candidates by
    // exact fingerprint AND content equivalence, and scores by interaction
    // potential (counts parsed from the DOM signature when present).
    // Returns { candidate, duplicate, reason } — duplicate=true means the
    // expensive operation can be skipped entirely.
    addCandidate({ url, domSig, interaction = null, parentStateId = null, parentExplored = false, meta = null }) {
      const fp = fingerprint(url, domSig);
      const ck = contentKey(url, domSig);
      counters.candidatesQueued++;
      if (byFingerprint.has(fp)) {
        counters.candidateDuplicates++;
        counters.navigationsSaved++;
        return { candidate: null, duplicate: true, reason: "fingerprint-explored" };
      }
      if (knownContentKeys.has(ck)) {
        counters.candidateDuplicates++;
        counters.navigationsSaved++;
        return { candidate: null, duplicate: true, reason: "content-equivalent" };
      }
      const counts = parseSignatureCounts(domSig);
      const candidate = {
        id: nextId("c", candidates.size),
        url,
        domSig: String(domSig).slice(0, 200),
        fingerprint: fp,
        contentKey: ck,
        interaction,
        parentStateId,
        parentExplored: !!parentExplored,
        score: interactionPotentialScore(counts, { parentExplored: !!parentExplored }),
        meta,
        status: "queued",
      };
      candidates.set(candidate.id, candidate);
      knownContentKeys.add(ck); // equivalent future candidates dedupe against this queue too
      return { candidate, duplicate: false, reason: null };
    },
    // budget-capped execution plan: unexplored candidates only, best
    // interaction potential first, at most `budget` of them. Everything the
    // plan drops because it is a duplicate was already counted as saved.
    planStates({ budget = 20 } = {}) {
      const plan = [...candidates.values()]
        .filter((c) => c.status === "queued")
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Math.max(0, budget));
      counters.plannedTotal += plan.length;
      return plan;
    },
    // fold an explored candidate into the graph (same semantics as addState)
    // and release it from the queue
    markCandidateExplored(candidateId, evidence = {}) {
      const c = candidates.get(candidateId);
      if (!c) return { node: null, duplicate: false };
      c.status = "explored";
      const res = this.addState({
        url: c.url,
        domSig: c.domSig,
        parentStateId: c.parentStateId,
        interaction: c.interaction,
        screenshotRef: evidence.screenshotRef ?? null,
        domRef: evidence.domRef ?? null,
        viewport: evidence.viewport ?? null,
        status: evidence.status ?? "explored",
      });
      return res;
    },
    get candidates() { return [...candidates.values()]; },

    // efficiency counters for the coverage report (task 3.5.5 step 8)
    stats() {
      return {
        nodes: nodes.size,
        edges: edges.length,
        candidatesQueued: counters.candidatesQueued,
        candidateDuplicates: counters.candidateDuplicates,
        navigationsSaved: counters.navigationsSaved,
        plannedTotal: counters.plannedTotal,
        restoredStates: counters.restoredStates,
      };
    },
    serialize() {
      return {
        nodes: [...nodes.values()],
        edges,
        stats: { nodes: nodes.size, edges: edges.length, ...counters },
      };
    },
  };
}

// light DOM signature for dedup: url + counts of key structures + text hash.
// Runs inside the page — must be self-contained.
export const DOM_SIGNATURE_SCRIPT = `(() => {
  const counts = {
    buttons: document.querySelectorAll("button, [role='button']").length,
    links: document.querySelectorAll("a[href]").length,
    inputs: document.querySelectorAll("input, select, textarea").length,
    tables: document.querySelectorAll("table").length,
    canvases: document.querySelectorAll("canvas").length,
    modals: document.querySelectorAll("[role='dialog'], [class*='modal']").length,
    tabs: document.querySelectorAll("[role='tab']").length,
    headers: document.querySelectorAll("h1,h2,h3").length,
  };
  let text = (document.body.innerText || "").replace(/\\d+/g, "#").replace(/\\s+/g, " ").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return JSON.stringify({ c: counts, t: h });
})()`;
