// State graph (spec §8): nodes = page/interaction states with fingerprints and
// evidence references; edges = interactions with expected/actual transitions.
// Deduplication via url + DOM-signature fingerprint prevents re-exploration.
import { createHash } from "node:crypto";

export function createStateGraph() {
  const nodes = new Map();
  const edges = [];
  const byFingerprint = new Map();

  function fingerprint(url, domSig) {
    return createHash("sha1").update(url + "::" + domSig).digest("hex").slice(0, 16);
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
      const id = "s" + String(nodes.size + 1).padStart(3, "0");
      const node = {
        id,
        url,
        parentStateId,
        fingerprint: fp,
        interaction,
        viewport,
        screenshotRef,
        domRef,
        timestamp: new Date().toISOString(),
        status,
      };
      nodes.set(id, node);
      byFingerprint.set(fp, node);
      return { node, duplicate: false };
    },
    // record a transition edge between states
    addEdge({ fromStateId, toStateId, trigger, action, expected, actual, success, evidence = null }) {
      edges.push({
        id: "e" + String(edges.length + 1).padStart(3, "0"),
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
    serialize() {
      return {
        nodes: [...nodes.values()],
        edges,
        stats: { nodes: nodes.size, edges: edges.length },
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
