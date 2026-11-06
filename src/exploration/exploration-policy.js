// Risk-aware interaction policy + bounded exploration budgets (spec §7, §13).
// Every budget is configurable per job while preventing infinite loops and
// destructive actions. The knobs that size a run (override via
// config.policy.budgets / config.policy.routes, or the flat
// config.policy.maxTotalTimeMs shorthand):
//   budgets.maxRoutes        — pages to explore (including the seed); default 30
//   budgets.maxTotalTimeMs   — whole-job wall clock; default 900000 (15 min)
//   budgets.maxTimePerPageMs — per-page wall clock; default 120000 (2 min)
// CLONER_PROFILE=compact (the 1 GB capacity profile,
// docs/realignment/CAPACITY-1GB.md) keeps the previous smaller exploration
// footprint via the COMPACT_BUDGET_OVERRIDES preset below (12 routes / 600000
// ms); an explicit userPolicy.budgets value always beats the preset.

export const DEFAULT_POLICY = {
  budgets: {
    maxRoutes: 30,             // pages to explore (including the seed)
    maxStatesPerPage: 20,      // interaction states per route
    maxInteractionsPerState: 30,
    maxDepth: 2,               // state graph depth (state → sub-state)
    maxTimePerPageMs: 120000,  // 2 min per page
    maxTotalTimeMs: 900000,    // 15 min whole job
  },
  viewports: [
    { name: "desktop", width: 1440, height: 900, primary: true },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
  ],
  // selectors/controls the explorer must never touch
  risk: {
    forbiddenText:
      /(buy|sell|flatten|reverse|place|submit|confirm|pay|purchase|checkout|withdraw|deposit|transfer|logout|log\s?out|sign\s?out|delete|remove|cancel\s?order|exit|cxl\b)/i,
    forbiddenTypes: ["submit"],                    // form submit buttons
    forbiddenContainers: ["[role='dialog'] form"], // forms inside dialogs
    allowedAnchorHref: /^(#|javascript:)?$/i,       // anchor-buttons yes, real links no
  },
  // SPA route-discovery knobs
  routes: {
    sameOriginOnly: true,
    maxSpaEvents: 40,          // pushState/replaceState/hash events captured per page
    recheckDelayMs: 800,
  },
};

// compact profile (CLONER_PROFILE=compact): the pre-raise route/time numbers so
// the 1 GB capacity profile keeps its smaller exploration footprint. Everything
// else stays at the shared defaults; explicit userPolicy.budgets still win.
const COMPACT_BUDGET_OVERRIDES = { maxRoutes: 12, maxTotalTimeMs: 600000 };

export function resolvePolicy(userPolicy = {}) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  // same live-env preset pattern as resolvePoolProfile (src/browser/browser-pool.js)
  if (process.env.CLONER_PROFILE === "compact") Object.assign(merged.budgets, COMPACT_BUDGET_OVERRIDES);
  if (userPolicy.budgets) Object.assign(merged.budgets, userPolicy.budgets);
  if (userPolicy.viewports?.length) merged.viewports = userPolicy.viewports;
  if (userPolicy.routes) Object.assign(merged.routes, userPolicy.routes);
  if (userPolicy.risk) merged.risk = { ...merged.risk, ...userPolicy.risk }; // was silently dropped before
  if (userPolicy.maxTotalTimeMs) merged.budgets.maxTotalTimeMs = userPolicy.maxTotalTimeMs;
  return merged;
}

// is this interaction safe to perform? (semantic + text + type checks)
export function isSafeInteraction(el, policy = DEFAULT_POLICY.risk) {
  try {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" && policy.forbiddenTypes.includes(type)) return { safe: false, why: "submit-button" };
    if (tag === "input" && ["password", "file", "hidden"].includes(type)) return { safe: false, why: "sensitive-input" };
    const text = ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + String(el.className || ""));
    if (policy.forbiddenText.test(text)) return { safe: false, why: "risky-text" };
    if (el.closest && policy.forbiddenContainers.some((sel) => el.closest(sel))) return { safe: false, why: "forbidden-container" };
    const href = el.getAttribute ? el.getAttribute("href") : null;
    if (tag === "a" && href && !policy.allowedAnchorHref.test(href.trim())) return { safe: false, why: "external-nav" };
    return { safe: true };
  } catch {
    return { safe: false, why: "evaluate-error" };
  }
}

// state fingerprint: url + a light DOM signature for dedup (spec §8)
export function stateFingerprint(url, domSig) {
  return `${url}::${domSig}`;
}
