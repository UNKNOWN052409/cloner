// In-URL state walker (SPA STATE DEPTH) — split out of state-discovery.js for
// the file-size cap and re-exported from there verbatim: every consumer keeps
// importing these symbols from ../exploration/state-discovery.js unchanged.
import { DEFAULT_POLICY } from "./exploration-policy.js";
import { DOM_SIGNATURE_SCRIPT } from "./state-discovery.js";

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
