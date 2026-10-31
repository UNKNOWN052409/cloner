// Route discovery (spec §7A): static links, navigation menus, SPA routes
// (pushState/replaceState/hash via an init-script recorder), redirects.
// Bounded by policy.routes. Same-origin only by default.

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

  async function add(url, source) {
    try {
      const u = new URL(url, page.url ? page.url() : url);
      const clean = u.origin + u.pathname + u.search;
      const origin = new URL(page.url() || url).origin;
      if (policy.routes.sameOriginOnly && u.origin !== origin) return false;
      if (/\.(png|jpe?g|webp|gif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|mp4|webm|pdf|zip)$/i.test(u.pathname)) return false;
      if (seen.has(clean)) return false;
      seen.add(clean);
      routes.push({ url: clean, source, discoveredAt: new Date().toISOString() });
      logger.info("routes", `route discovered: ${clean}`, { source });
      return true;
    } catch {
      return false;
    }
  }

  return {
    routes,
    get count() { return routes.length; },
    async seed(url) { await add(url, "seed"); },
    // static links from the current DOM (nav + visible anchors)
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
          // nav links first, then the rest
          out.sort((a, b) => (b.nav ? 1 : 0) - (a.nav ? 1 : 0));
          return out.map((o) => o.url);
        }, policy.routes.sameOriginOnly)
        .catch(() => []);
      for (const link of links) {
        if (routes.length >= max) break;
        await add(link, "dom-link");
      }
      return routes.length;
    },
    // SPA transitions recorded by the init-script (call after interactions ran)
    async fromSpaEvents(max = policy.budgets.maxRoutes) {
      const events = await page.evaluate(() => (window.__CLONER_SPA_ROUTES || []).map((e) => e.to)).catch(() => []);
      for (const to of events) {
        if (routes.length >= max) break;
        await add(to, "spa-transition");
      }
      return routes.length;
    },
    async installSpaRecorder() {
      await page.evaluate(SPA_RECORDER_SCRIPT).catch(() => {});
    },
  };
}
