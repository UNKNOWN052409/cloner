// Route discovery (spec §7A): static links, navigation menus, SPA routes
// (pushState/replaceState/hash via an init-script recorder), redirects.
// Bounded by policy.routes. Same-origin only by default.
//
// Task 3.5.5 (intelligent exploration optimization, additive):
//  - every route gets a reconstruction-value SCORE (nav placement, link-text
//    value keywords, path depth) and the `routes` array is kept score-ordered
//    (seed pinned first). The pipeline consumes
//    `discovery.routes.slice(0, maxRoutes)` directly
//    (src/pipeline/exploration-pipeline.js:256), so budget-capped exploration
//    spends its navigation slots on the highest-value pages with zero
//    pipeline changes;
//  - query-only variants of an already-queued document (same origin +
//    pathname, different search — /products vs /products?ref=footer) are
//    treated as DUPLICATE NAVIGATIONS: they are skipped before any browser
//    operation and recorded in `redundantRoutes` for coverage honesty
//    (plan §3.5.5 step 2 — detect duplicates BEFORE expensive operations).
//    The first URL for a pathname wins; a later query-less canonical URL
//    upgrades the queued one in place;
//  - both behaviors are policy-configurable for the completeness mode
//    (plan risk note): `policy.routes.prioritize === false` restores the
//    pre-3.5.5 behavior exactly (insertion order, every discovered URL kept);
//    `policy.routes.dedupeSamePath === false` keeps variants but still
//    score-orders;
//  - `planNavigations()` returns the pre-navigation execution plan
//    (scored, capped, already-explored pathnames removed) and
//    `markExplored(url)` records visited pathnames for it — hooks the
//    pipeline can adopt in one line.

// interaction-potential keywords: link text hinting at data-heavy or
// interactive regions that yield the most reconstruction evidence
const VALUE_TEXT_RE = /(data|report|dashboard|table|grid|list|detail|profile|account|settings|admin|edit|manage|catalog|product|order|search|filter|inbox|message|chart|map|calendar)/i;

function scoreUrlShape(url) {
  let s = 0;
  const depth = url.split("/").filter(Boolean).length; // shallow paths = core IA
  s += Math.max(0, 2 - (depth - 1)); // "/x" scores above "/x/y/z"
  if (/\/(index|home|main)\.html?$/i.test(url)) s += 1;
  return s;
}

export function scoreRoute({ url, nav = false, text = "", source = "" }) {
  let score = 0;
  const reasons = [];
  if (nav) { score += 4; reasons.push("nav"); }
  if (text && VALUE_TEXT_RE.test(text)) { score += 2; reasons.push("value-text"); }
  if (source === "spa-transition") { score += 2; reasons.push("spa"); } // user-reachable view
  if (source === "seed") { score += 1; reasons.push("seed"); }
  const shape = scoreUrlShape(url);
  if (shape) { score += shape; reasons.push("shallow"); }
  if (url.includes("?")) { score -= 1; reasons.push("has-query"); } // parameterized views rank below canonical
  return { score, reasons };
}

export function isQueryVariantOf(urlA, urlB) {
  try {
    const a = new URL(urlA), b = new URL(urlB);
    return a.origin === b.origin && a.pathname === b.pathname && a.search !== b.search;
  } catch {
    return false;
  }
}

// init script: record SPA navigations into a per-document ring buffer on window.
// Parameterized by policy.routes.maxSpaEvents (the buffer resets on every
// navigation, so the pipeline must harvest it before navigating away).
export function spaRecorderScript(maxEvents = 40) {
  const cap = Math.max(1, Number(maxEvents) || 40);
  return `
(() => {
  if (window.__CLONER_SPA_ROUTES) return;
  window.__CLONER_SPA_ROUTES = [];
  const push = (from, to, kind) => {
    try {
      if (window.__CLONER_SPA_ROUTES.length >= ${cap}) return;
      if (to && to !== from) window.__CLONER_SPA_ROUTES.push({ from, to, kind, at: Date.now() });
    } catch {}
  };
  const wrap = (orig, kind) => function (...a) {
    const from = location.href;
    const r = orig.apply(this, a);
    push(from, location.href, kind);
    return r;
  };
  try {
    history.pushState = wrap(history.pushState, "pushState");
    history.replaceState = wrap(history.replaceState, "replaceState");
    window.addEventListener("hashchange", () => push("", location.href, "hashchange"));
  } catch {}
})();
`;
}

// default-capability constant kept for existing importers
export const SPA_RECORDER_SCRIPT = spaRecorderScript(40);

export function createRouteDiscovery(page, policy, logger) {
  const seen = new Set();
  const routes = [];
  const redundantRoutes = []; // skipped pre-navigation duplicates (coverage record)
  const exploredPaths = new Set(); // pathnames already navigated (planNavigations hook)
  let duplicatesSkipped = 0;

  const prioritizeEnabled = policy?.routes?.prioritize !== false; // completeness mode: false
  const dedupeSamePath = prioritizeEnabled && policy?.routes?.dedupeSamePath !== false;

  function pathnameOf(url) {
    try { return new URL(url).pathname; } catch { return null; }
  }

  // stable score-order: seed first (current document — costs nothing to
  // explore), then by score desc; stable so equal scores keep discovery order
  function resort() {
    if (!prioritizeEnabled) return;
    const order = routes
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const pin = (a.r.seed ? 0 : 1) - (b.r.seed ? 0 : 1);
        if (pin) return pin;
        if (b.r.score !== a.r.score) return b.r.score - a.r.score;
        return a.i - b.i;
      })
      .map((x) => x.r);
    routes.length = 0;
    routes.push(...order);
  }

  function pathAlreadyQueued(pathname) {
    return routes.some((r) => pathnameOf(r.url) === pathname);
  }

  async function add(url, source, meta = {}) {
    try {
      const u = new URL(url, page.url ? page.url() : url);
      const clean = u.origin + u.pathname + u.search;
      const origin = new URL(page.url() || url).origin;
      if (policy.routes.sameOriginOnly && u.origin !== origin) return false;
      if (/\.(png|jpe?g|webp|gif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|mp4|webm|pdf|zip)$/i.test(u.pathname)) return false;
      if (seen.has(clean)) return false;
      seen.add(clean);
      const seed = source === "seed";
      const pn = pathnameOf(clean);

      // pre-navigation duplicate suppression (task 3.5.5): a second URL for an
      // already-queued pathname is a redundant navigation — record it and skip
      // the fetch. A query-less URL upgrades an already-queued parameterized
      // twin in place so the canonical URL is the one that gets explored.
      // SPA-recorder transitions are EXEMPT: an observed pushState/replaceState
      // is direct evidence of a distinct reachable application state (the
      // state-sync pattern /?route=x is a real view), while an anchor link's
      // query variant is only a guess — exactly the skip the plan wants.
      if (dedupeSamePath && !seed && source !== "spa-transition" && pn && pathAlreadyQueued(pn)) {
        const twin = routes.find((r) => pathnameOf(r.url) === pn);
        if (!clean.includes("?") && twin && twin.url.includes("?")) {
          const { score, reasons } = scoreRoute({ url: clean, nav: !!meta.nav, text: meta.text || "", source });
          twin.canonicalizedFrom = twin.url;
          twin.url = clean;
          twin.score = score;
          twin.reasons = reasons;
          duplicatesSkipped++;
          logger?.info?.("routes", `canonical route upgraded in place: ${clean}`, { source });
          return true;
        }
        duplicatesSkipped++;
        redundantRoutes.push({ url: clean, duplicateOf: twin.url, source, at: new Date().toISOString() });
        logger?.info?.("routes", `duplicate navigation skipped pre-navigation: ${clean} ≈ ${twin.url}`, { source });
        return false;
      }

      const { score, reasons } = prioritizeEnabled
        ? scoreRoute({ url: clean, nav: !!meta.nav, text: meta.text || "", source })
        : { score: 0, reasons: [] };
      routes.push({
        url: clean,
        source,
        discoveredAt: new Date().toISOString(),
        score,
        reasons,
        seed,
        ...(meta.text ? { text: String(meta.text).slice(0, 40) } : {}),
      });
      logger?.info?.("routes", `route discovered: ${clean}`, { source, score });
      return true;
    } catch {
      return false;
    }
  }

  return {
    routes,
    redundantRoutes,
    get count() { return routes.length; },
    async seed(url) {
      await add(url, "seed");
      resort();
    },
    // static links from the current DOM (nav + visible anchors). Link metadata
    // (nav placement + text) is returned so routes can be scored in Node.
    async fromDom(max = policy.budgets.maxRoutes) {
      const links = await page
        .evaluate((sameOriginOnly) => {
          const base = location.origin;
          const norm = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname + x.search; } catch { return null; } };
          const out = [];
          const skip = /\.(png|jpe?g|webp|gif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|mp4|webm|pdf|zip)$/i;
          for (const a of document.querySelectorAll("a[href]")) {
            const raw = a.href;
            if (!raw || !/^https?:/.test(raw)) continue;
            const n = norm(raw);
            if (!n || skip.test(new URL(n).pathname)) continue;
            if (sameOriginOnly && !n.startsWith(base)) continue;
            const nav = a.closest("nav,header,[role='navigation']");
            out.push({ url: n, nav: !!nav, text: (a.innerText || "").trim().slice(0, 40) });
          }
          // nav links first, then the rest (kept for pre-score ordering)
          out.sort((a, b) => (b.nav ? 1 : 0) - (a.nav ? 1 : 0));
          return out;
        }, policy.routes.sameOriginOnly)
        .catch(() => []);
      for (const link of links) {
        if (routes.length >= max) break;
        await add(link.url, "dom-link", { nav: link.nav, text: link.text });
      }
      resort();
      return routes.length;
    },
    // SPA transitions recorded by the init-script (call after interactions ran)
    async fromSpaEvents(max = policy.budgets.maxRoutes) {
      const events = await page.evaluate(() => (window.__CLONER_SPA_ROUTES || []).map((e) => e.to)).catch(() => []);
      for (const to of events) {
        if (routes.length >= max) break;
        await add(to, "spa-transition");
      }
      resort();
      return routes.length;
    },
    async installSpaRecorder() {
      await page.evaluate(SPA_RECORDER_SCRIPT).catch(() => {});
    },

    // ---- task 3.5.5 hooks (additive) ----

    // record a pathname as already explored so planNavigations() skips
    // equivalent navigations BEFORE they happen (pipeline hook: call with
    // page.url() after each successful goto)
    markExplored(url) {
      const pn = pathnameOf(url);
      if (pn) exploredPaths.add(pn);
    },
    isLikelyDuplicate(url) {
      const pn = pathnameOf(url);
      return !!pn && exploredPaths.has(pn);
    },
    // pre-navigation execution plan: seed first, score-ordered, capped, with
    // already-explored pathnames removed. Completeness mode (prioritize:false)
    // returns the raw discovered order. `explored` seeds the explored-pathname
    // set so a caller can pass visited URLs in one shot.
    planNavigations({ max = policy.budgets.maxRoutes, dedupeSamePath: dedupe = dedupeSamePath, explored = [] } = {}) {
      for (const u of explored) this.markExplored(u);
      const plan = dedupe && prioritizeEnabled
        ? routes.filter((r) => r.seed || !exploredPaths.has(pathnameOf(r.url)))
        : routes;
      return plan.slice(0, max);
    },
    // efficiency counters for the coverage report (task 3.5.5 step 8)
    stats() {
      return {
        discovered: routes.length,
        uniquePaths: new Set(routes.map((r) => pathnameOf(r.url) || r.url)).size,
        redundantRoutes: redundantRoutes.length,
        duplicatesSkipped,
        exploredPaths: exploredPaths.size,
        prioritized: prioritizeEnabled,
      };
    },
  };
}
