// Workspace reach (post-login reachability): fresh logins on trading platforms
// land on welcome/onboarding/trading-mode pages, NOT the authenticated
// workspace — and the workspace is where the quote websocket and the app's
// real data live. Measured on trader.tradovate.com (exp-mwmir4t3b72n): a fresh
// login explored /welcome + /help + /privacy-policy (0 ws frames, 0 first-party
// API calls) while the pre-warmed session run (exp-mw6uq90bgx59) explored the
// dashboard directly. This pass closes that gap, evidence-driven and bounded:
//   1. TRADING-MODE GATE: a visible control whose text matches the simulation
//      side is clicked (paper/demo/simulation) — the LIVE side is NEVER
//      clicked, by hard regex guard, whatever it looks like.
//   2. WELCOME/ONBOARDING: a landing path that is not the app root gets ONE
//      navigation to the origin root (where the workspace boots).
//   3. Settle after each action (hydration marker + fixed settle), same gates
//      the seed load uses.
// Non-fatal by contract: every failure is a note; exploration continues from
// wherever the page actually is.
//
// Integration (exploration-pipeline, after the seed settle gate, BEFORE
// discovery.seed — one call):
//   const reach = await reachAuthenticatedWorkspace(page, { logger, enabled: authOk });
//   // → auth.workspaceReach in the manifest
export const WORKSPACE_REACH_VERSION = "1.0.0";

const GATE_PATH_RE = /\/(welcome|trading-mode|trading_mode|choose-mode|select-mode|onboarding)([/?#]|$)/i;
const SIM_RE = /(simulation|paper trading|paper|demo)/i;
const LIVE_GUARD_RE = /(live|real money|fund|deposit|open live)/i;

const SETTLE_SNIPPET = () => {
  const shell = document.querySelector(".app-initializing, [class*='app-initializing' i]");
  if (shell && document.contains(shell)) return false;
  const els = document.body ? document.body.querySelectorAll("*") : [];
  let visible = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 12 && r.top >= 0 && r.top < innerHeight && el.children.length === 0 && (el.textContent || "").trim()) visible++;
    if (visible >= 8) return true;
  }
  return false;
};

async function settle(page, settleMs) {
  await page.waitForFunction(SETTLE_SNIPPET, { timeout: settleMs }).catch(() => {});
  await page.waitForTimeout(Math.min(settleMs, 3000)).catch(() => {});
}

// findGateControl(page) → the visible simulation-side control, or null.
// Text match over the button/link/tab role surface — the gate is a plain
// choice UI; anything guarded by LIVE_GUARD_RE is excluded FIRST.
async function findGateControl(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 30 && r.height > 15 && cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
      };
      const textOf = (el) => ((el.innerText || el.textContent || "") + " " + String(el.getAttribute("aria-label") || "") + " " + String(el.getAttribute("data-testid") || "")).trim();
      const cands = [...document.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem']")].filter(visible);
      const live = cands.filter((el) => /live|real money/i.test(textOf(el)));
      for (const el of cands) {
        const t = textOf(el);
        if (/simulation|paper|demo/i.test(t) && t.length <= 60) {
          // a LIVE twin next to a simulation control confirms this IS the gate —
          // and the live control itself is never returned
          const twin = live.some((l) => l !== el && Math.abs(l.getBoundingClientRect().top - el.getBoundingClientRect().top) < 80);
          return { text: t.slice(0, 40), twinConfirmed: twin, summary: "control:" + t.slice(0, 20) };
        }
      }
      return null;
    })
    .catch(() => null);
}

// reachAuthenticatedWorkspace(page, opts) →
// { version, acted, gatePassed, landedUrl, notes } — notes are manifest-ready.
export async function reachAuthenticatedWorkspace(page, opts = {}) {
  const notes = [];
  const out = { version: WORKSPACE_REACH_VERSION, acted: false, gatePassed: false, landedUrl: null, notes };
  if (!opts.enabled) {
    notes.push("no verified session — reach pass disabled");
    return out;
  }
  const settleMs = Number(process.env.CLONER_SPA_SETTLE_MS ?? 8000);

  let here = String(page.url() || "");
  // 1. trading-mode gate (by path OR by visible control pair)
  const onGatePath = GATE_PATH_RE.test(here);
  const gate = await findGateControl(page);
  if (onGatePath || gate) {
    if (gate) {
      notes.push(`trading-mode gate: simulation-side control "${gate.text}"${gate.twinConfirmed ? " (live twin visible — gate confirmed)" : ""}`);
      const clicked = await page
        .evaluate((t) => {
          const textOf = (el) => ((el.innerText || el.textContent || "") + " " + String(el.getAttribute("aria-label") || "")).trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 30 && r.height > 15;
          };
          for (const el of document.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem']")) {
            if (!visible(el)) continue;
            const t = textOf(el);
            if (/live|real money|fund|deposit/i.test(t)) continue; // hard guard
            if (/simulation|paper|demo/i.test(t) && t.length <= 60) {
              el.click();
              return true;
            }
          }
          return false;
        }, null)
        .catch(() => false);
      if (clicked) {
        out.acted = true;
        out.gatePassed = true;
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await settle(page, settleMs);
        here = String(page.url() || "");
        notes.push("simulation selected — landed " + here.slice(0, 80));
      } else {
        notes.push("gate detected but no clickable simulation-side control — continuing from " + here.slice(0, 80));
      }
    } else {
      notes.push("gate-like path without a visible mode control — continuing from " + here.slice(0, 80));
    }
  }

  // 2. welcome/onboarding landing: ONE navigation to the app root
  if (GATE_PATH_RE.test(here)) {
    try {
      const u = new URL(here);
      await page.goto(u.origin + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
      await settle(page, settleMs);
      out.acted = true;
      here = String(page.url() || "");
      notes.push("welcome/onboarding page — navigated to app root, landed " + here.slice(0, 80));
    } catch (e) {
      notes.push("root navigation failed: " + String(e?.message || e).slice(0, 80));
    }
  }

  out.landedUrl = here;
  return out;
}
