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
import { DEFAULT_POLICY } from "./exploration-policy.js";

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

// ============================================================ SPA STATE DEPTH
// Authed app shells (dashboards, workspace UIs) switch client-side views by
// CLICKING in-app nav/tab controls while the URL stays put. Route discovery
// never sees those switches (no navigation event), and the overlay/module
// explorer only documents panels — so a data-driven dashboard documents its
// views nowhere. enumerateInAppStates walks the visible in-app nav controls on
// the already-loaded page, clicks the SAFE ones, and records every DOM change
// that kept the URL identity (origin+path+query) identical as a state keyed
// url#state — the same `url + "#" + name` page-level shape the reconstruction
// emits via manifest.pages entries (one page per entry, artifact-loader reads
// pages/<pageId>/dom.json exactly like a route page).
//
// Guardrails (spec §7 DANGEROUS guard + budgets):
//   - candidates are filtered with the SAME risk rules isSafeInteraction
//     applies — forbiddenText/forbiddenTypes/anchor policy run in Node against
//     the real policy; the forbiddenContainers check needs the DOM, so the
//     in-page snippet answers closest() for the policy's own selectors;
//   - at most budgets.maxInUrlStates recorded switches per page, bounded by
//     budgetMs wall clock (policy.budgets.maxInUrlStates, default 12);
//   - a candidate that NAVIGATES (URL identity changes) is a route, not a
//     state: it is restored and skipped — routes belong to route-discovery;
//   - a candidate that does not change the DOM signature is not a view switch.

// runs inside the page — returns descriptor objects for every visible in-app
// nav/tab/menu control and tags each with data-inapp-cand="<idx>" so the Node
// side can click it by selector afterwards
export const IN_APP_CANDIDATES_FN = (forbiddenContainers) => {
  const sel = "[role='tab'], [role='menuitem'], [role='tablist'] button, nav button, nav a[href='#'], [class*='nav' i] button, [class*='tab' i] button, [class*='menu' i] button";
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const key = el.tagName + "|" + (el.innerText || "").trim().slice(0, 60) + "|" + Math.round(r.x) + "," + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    el.setAttribute("data-inapp-cand", String(out.length));
    out.push({
      idx: out.length,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      text: (el.innerText || "").trim().slice(0, 60),
      ariaLabel: el.getAttribute("aria-label"),
      title: el.getAttribute("title"),
      cls: String(el.className || "").slice(0, 80),
      href: el.tagName === "A" ? el.getAttribute("href") : null,
      // forbiddenContainers needs the real DOM — closest() is the one guard the
      // Node side cannot evaluate from a descriptor
      inForbidden: (forbiddenContainers || []).some((s) => { try { return !!el.closest(s); } catch { return false; } }),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
};

// the DANGEROUS guard, Node side: mirror of exploration-policy.isSafeInteraction
// applied to a candidate descriptor (same rule order, same policy fields)
export function inAppCandidateSafe(desc, risk = DEFAULT_POLICY.risk) {
  if (!desc || desc.inForbidden) return { safe: false, why: "forbidden-container" };
  // defensive regex re-hydration: a risk object that lost its RegExp values in
  // a JSON round-trip must fall back to the module defaults, never fail-open
  const forbiddenText = risk.forbiddenText instanceof RegExp ? risk.forbiddenText : DEFAULT_POLICY.risk.forbiddenText;
  const allowedAnchorHref = risk.allowedAnchorHref instanceof RegExp ? risk.allowedAnchorHref : DEFAULT_POLICY.risk.allowedAnchorHref;
  const tag = String(desc.tag || "").toLowerCase();
  const type = String(desc.type || "").toLowerCase();
  if (tag === "button" && risk.forbiddenTypes.includes(type)) return { safe: false, why: "submit-button" };
  if (tag === "input" && ["password", "file", "hidden"].includes(type)) return { safe: false, why: "sensitive-input" };
  const text = [desc.text, desc.ariaLabel, desc.title, desc.cls].filter(Boolean).join(" ");
  if (forbiddenText.test(text)) return { safe: false, why: "risky-text" };
  if (tag === "a" && desc.href && !allowedAnchorHref.test(String(desc.href).trim())) return { safe: false, why: "external-nav" };
  return { safe: true };
}

// document identity: origin + path + query. A hash difference is an in-document
// view switch, not a navigation — the same document, so "the URL does not change".
function sameDocUrl(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.origin + A.pathname + A.search === B.origin + B.pathname + B.search;
  } catch { return a === b; }
}
function docUrlOf(u) {
  try { const U = new URL(u); return U.origin + U.pathname + U.search; } catch { return u; }
}
function stateSlugOf(text) {
  const s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s;
}

// walk the in-app view switches of a loaded page and record each DOM change
// that kept the URL identical as a state + edge on the graph. captureState is
// the caller's evidence writer (screenshot + DOM extraction → artifact paths);
// it receives { page, name, index, domSig, candidate } and returns
// { screenshotRef, domRef }. Returns a summary with the honest skip ledger.
export async function enumerateInAppStates(page, {
  graph,
  parentNode = null,
  policy = null,
  captureState = null,
  logger = null,
  settleMs = null,
  budgetMs = 60000,
} = {}) {
  const risk = (policy && policy.risk) || DEFAULT_POLICY.risk;
  const budgets = (policy && policy.budgets) || {};
  const maxStates = Number(budgets.maxInUrlStates) || 12;
  const settle = settleMs ?? (policy?.routes?.recheckDelayMs ?? 800);
  const deadline = Date.now() + Math.max(1000, budgetMs);
  const summary = {
    candidates: 0, safe: 0, recorded: 0, duplicates: 0,
    skipped: { unsafe: 0, "url-changed": 0, "same-dom": 0, "not-clickable": 0, budget: 0 },
    restoredNavigations: 0,
    states: [],
  };
  let cands = [];
  try {
    cands = await page.evaluate(IN_APP_CANDIDATES_FN, risk.forbiddenContainers || []);
  } catch (e) {
    if (logger?.warn) logger.warn("state-depth", "candidate enumeration failed: " + String(e?.message || e).slice(0, 80));
    return summary;
  }
  const baseDocUrl = docUrlOf(page.url());
  try {
    for (const desc of cands) {
      if (summary.recorded >= maxStates || Date.now() > deadline) { summary.skipped.budget++; continue; }
      summary.candidates++;
      const guard = inAppCandidateSafe(desc, risk);
      if (!guard.safe) {
        summary.skipped.unsafe++;
        if (logger?.debug) logger.debug("state-depth", `candidate skipped (unsafe: ${guard.why}): ${desc.text || "control #" + desc.idx}`);
        continue;
      }
      summary.safe++;
      const sel = `[data-inapp-cand="${desc.idx}"]`;
      const beforeSig = await page.evaluate(DOM_SIGNATURE_SCRIPT).catch(() => null);
      try { await page.click(sel, { timeout: 2000 }); } catch {
        summary.skipped["not-clickable"]++;
        continue;
      }
      await page.waitForTimeout(settle);
      if (!sameDocUrl(page.url(), baseDocUrl)) {
        // a real navigation — restore the shell and leave the route to
        // route-discovery; this walker only documents same-URL view switches
        summary.skipped["url-changed"]++;
        summary.restoredNavigations++;
        try {
          await page.goto(baseDocUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(settle);
        } catch {}
        continue;
      }
      const sig = await page.evaluate(DOM_SIGNATURE_SCRIPT).catch(() => null);
      if (!sig || sig === beforeSig) { summary.skipped["same-dom"]++; continue; }
      const name = stateSlugOf(desc.text) || `state-${summary.recorded + 1}`;
      const res = graph.addState({
        url: baseDocUrl + "#" + name, // keyed url#state — the URL did not change
        domSig: sig,
        parentStateId: parentNode ? parentNode.id : null,
        interaction: desc.text || sel,
        status: "in-url",
      });
      if (res.duplicate) { summary.duplicates++; summary.skipped["same-dom"]++; continue; }
      let refs = { screenshotRef: null, domRef: null };
      if (captureState) {
        try {
          refs = (await captureState({ page, name, index: summary.recorded + 1, domSig: sig, candidate: desc })) || refs;
        } catch (e) {
          if (logger?.warn) logger.warn("state-depth", `capture failed for ${name}: ` + String(e?.message || e).slice(0, 80));
        }
      }
      res.node.screenshotRef = refs.screenshotRef ?? res.node.screenshotRef;
      res.node.domRef = refs.domRef ?? res.node.domRef;
      graph.addEdge({
        fromStateId: parentNode ? parentNode.id : null,
        toStateId: res.node.id,
        trigger: desc.text || sel,
        action: "click",
        expected: "in-app view switch (same URL)",
        actual: "captured in-URL state",
        success: true,
        evidence: refs.screenshotRef || refs.domRef || null,
      });
      summary.states.push({
        id: res.node.id, name, url: res.node.url, interaction: res.node.interaction,
        screenshotRef: refs.screenshotRef || null, domRef: refs.domRef || null,
      });
      summary.recorded++;
      if (logger?.debug) logger.debug("state-depth", `recorded in-URL state "${name}" (${summary.recorded}/${maxStates})`);
    }
  } finally {
    // the marker attrs are walker bookkeeping — never leave them on the page
    try { await page.evaluate(() => document.querySelectorAll("[data-inapp-cand]").forEach((n) => n.removeAttribute("data-inapp-cand"))); } catch {}
  }
  return summary;
}

// artifact directory name for an in-URL state: pages/<pageId>-state-NN/ so the
// reconstruction's artifact-loader reads it exactly like a route page
export function statePageId(basePageId, index) {
  return `${basePageId}-state-${String(index).padStart(2, "0")}`;
}

// manifest.pages-level entries for recorded in-URL states: one page entry per
// state, keyed url#state (the URL did not change), pointing at the state's own
// screenshot + dom evidence. The reconstruction emits one page per entry.
export function statePageEntries(pageEntry, states) {
  return (states || [])
    .filter((s) => s && s.url && String(s.url).includes("#"))
    .map((s, i) => ({
      pageId: statePageId(pageEntry.pageId, i + 1),
      url: s.url,
      route: pageEntry.route ?? null,
      state: s.interaction ?? null,
      stateOf: pageEntry.pageId,
      records: 0,
      domSampled: 0,
      screenshotRef: s.screenshotRef || null,
      domRef: s.domRef || null,
    }));
}
