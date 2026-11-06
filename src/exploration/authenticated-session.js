// Authenticated-session establishment for the cloner engine (spec: "login
// ONCE, persist context.storageState({ path }), later contexts start with
// { storageState }" — playwright.dev/docs/auth pattern).
//
// Closes the audit gap in src/pipeline/exploration-pipeline.js:112-133, which
// detects a login form, types credentials and submits — but never VERIFIES the
// login succeeded, never persists the session, and has no MFA/CAPTCHA pause.
//
// Contract:
//   authenticateSession({ url, username, password, policy, logger, artifactsDir })
//   → { ok: true,  needsHuman: false, storageStatePath, indicators[], warnings[] }
//     when the password field is gone AND at least one logged-in indicator
//     (cookie-count increase, logout/sign-out control, avatar element) holds
//     and the context storage state has been persisted to an artifactsDir-safe
//     path. storageStatePath can be handed to browser.newContext({ storageState }).
//   → { ok: false, needsHuman: true,  reason, ... } when the post-submit page
//     still presents an OTP/captcha-style input or text matching
//     /mfa|2fa|verification code|captcha|otp/i — we NEVER attempt to bypass;
//     the caller must pause and surface this to the user.
//   → { ok: false, needsHuman: false, reason, ... } for plain failures (wrong
//     credentials, no login form, no indicators). No storage state is written.
//
// Destructive-action guard: the ONLY thing this module ever submits is the one
// <form> containing the login password input (click scoped inside that form, or
// Enter pressed in that form's password field as fallback). Candidate submit
// controls whose label matches destructive verbs are refused; nothing else is
// ever clicked.
//
// Engine-clean: imports are node builtins + playwright + src/security
// (request-guard — itself node builtins + src/events only). No src/platform.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { attachRequestGuard, assertSafeNavigationUrl, guardPageWebSockets } from "../security/request-guard.js";

// exact pattern from the engine spec for MFA/CAPTCHA pause
const MFA_TEXT_PATTERN = /mfa|2fa|verification code|captcha|otp/i;
// attribute-level signal for challenge inputs (otp/one-time/captcha/…). Bare
// "code" is included deliberately: a false positive here only fails safe into
// a needsHuman pause, while a missed challenge would leak an unverified state.
const CHALLENGE_ATTR_PATTERN = /otp|one[-_ ]?time|\bcode\b|captcha|verif|authenticator|\bmfa\b|\b2fa\b/i;
// verbs that must never appear on a control we are about to submit/click
const DESTRUCTIVE_LABEL_PATTERN = /(purchase|checkout|\bpay\b|\bbuy\b|delete|remove|confirm|withdraw|deposit|transfer|place\s+order|flatten|reverse|cancel\s+order|upgrade\s+plan|subscribe)/i;

const USERNAME_SELECTOR = 'input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]';
const PASSWORD_SELECTOR = 'input[type="password"]';
const LOGIN_FORM_SELECTOR = `form:has(${PASSWORD_SELECTOR})`;

const DEFAULT_AUTH_POLICY = {
  navigationTimeoutMs: 30000,
  fillTimeoutMs: 8000,
  submitClickTimeoutMs: 6000,
  // settle window after submit before we judge the page (mirrors the pipeline's
  // post-submit wait at src/pipeline/exploration-pipeline.js:131)
  postSubmitWaitMs: 6000,
};

function noop() {}

function adaptLogger(logger) {
  if (logger && typeof logger.info === "function" && typeof logger.warn === "function") return logger;
  return { info: noop, warn: noop, error: noop };
}

// merge: defaults ← policy (flat overrides) ← policy.authSession (nested)
function resolveAuthPolicy(policy) {
  const flat = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  const nested = flat.authSession && typeof flat.authSession === "object" ? flat.authSession : {};
  return { ...DEFAULT_AUTH_POLICY, ...flat, ...nested };
}

function sanitizeKey(raw) {
  return String(raw).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "").slice(0, 64) || "session";
}

// post-submit page probe, single round-trip into the renderer. NOTE: this runs
// serialized inside the page — it must not close over module-level variables
// (the challenge pattern is therefore defined inline).
const PAGE_PROBE_SCRIPT = () => {
  const CHALLENGE_ATTR_PATTERN = /otp|one[-_ ]?time|\bcode\b|captcha|verif|authenticator|\bmfa\b|\b2fa\b/i;
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({
    type: (i.getAttribute("type") || "").toLowerCase(),
    name: i.getAttribute("name") || "",
    id: i.id || "",
    placeholder: i.getAttribute("placeholder") || "",
    autocomplete: i.getAttribute("autocomplete") || "",
    aria: i.getAttribute("aria-label") || "",
    visible: visible(i),
  }));
  const text = (document.body && document.body.innerText) || "";
  const hasPassword = inputs.some((i) => i.type === "password" && i.visible);
  const hasUsername = inputs.some(
    (i) => i.visible && (i.type === "text" || i.type === "email" || /user|email|login/i.test(i.name + " " + i.id))
  );
  const challenge = inputs.find(
    (i) => i.visible && CHALLENGE_ATTR_PATTERN.test([i.name, i.id, i.placeholder, i.autocomplete, i.aria].join(" "))
  );
  return {
    text,
    hasPassword,
    hasUsername,
    challenge: challenge ? { name: challenge.name, id: challenge.id, type: challenge.type } : null,
  };
};

// logged-in indicator probe (logout/sign-out control + avatar element)
const INDICATOR_PROBE_SCRIPT = () => {
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).slice(0, 2).join(".");
    const href = el.getAttribute && el.getAttribute("href");
    const label = ((el.innerText || el.textContent || "") + "").trim().replace(/\s+/g, " ").slice(0, 40);
    return tag + (cls ? "." + cls : "") + (href ? `[href="${href}"]` : "") + (label ? ` "${label}"` : "");
  };
  const logoutEl = Array.from(document.querySelectorAll("a, button, [role='button']")).find((el) => {
    if (el.tagName !== "A" && el.offsetParent === null) return false;
    const hay = ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("href") || "")).toLowerCase();
    return /log\s?out|sign\s?out|logout|signout/.test(hay);
  });
  const avatarEl = document.querySelector(
    '[class*="avatar" i], [id*="avatar" i], img[alt*="avatar" i], img[alt*="profile" i], [data-testid*="avatar" i], [data-avatar]'
  );
  return { logout: logoutEl ? describe(logoutEl) : null, avatar: avatarEl ? describe(avatarEl) : null };
};

function failed(reason, warnings, extra = {}) {
  return { ok: false, needsHuman: false, reason, indicators: [], warnings, storageStatePath: null, ...extra };
}

export async function authenticateSession(args = {}) {
  const {
    url,
    username,
    password,
    policy,
    logger,
    artifactsDir = "artifacts",
    storageStatePath: forcedPath = null,
    sessionKey = null,
    headless = true,
  } = args;
  const cfg = resolveAuthPolicy(policy);
  const log = adaptLogger(logger);
  const warnings = [];

  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return failed("invalid-url: authenticateSession needs an http(s) URL", warnings);
  }
  if (!username || !password) {
    return failed("missing-credentials: username and password are both required", warnings);
  }

  const key = sanitizeKey(sessionKey || `auth-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`);
  const storagePath = forcedPath ? path.resolve(forcedPath) : path.resolve(artifactsDir, "auth-sessions", `session-${key}.json`);

  let browser = null;
  let detachWsGuard = null;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // SSRF guard on THIS context too — same per-request policy as the pipeline
    // context (src/browser.js:85): the login target may 302 into a redirect
    // chain, its subresources come from untrusted input, and names are
    // re-resolved per request (src/security/request-guard.js classes 1–3).
    await attachRequestGuard(context);
    const page = await context.newPage();
    // WS residual (context.route does not intercept websocket handshakes)
    detachWsGuard = guardPageWebSockets(page, { logBlocked: false });

    log.info("auth", "navigating to login target", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navigationTimeoutMs });
    // post-navigation assertion (src/browser.js:197 idiom): where did we
    // ACTUALLY land? A redirect chain into a private/loopback target must fail
    // the session BEFORE any credential is typed.
    const landedCheck = assertSafeNavigationUrl(page.url());
    if (!landedCheck.ok) {
      log.warn("auth", `ssrf-guard: ${landedCheck.error}`);
      return failed(`ssrf-guard: ${landedCheck.error}`, warnings);
    }
    const cookiesBefore = (await context.cookies()).length;

    const entry = await page.evaluate(() => ({ hasPassword: !!document.querySelector('input[type="password"]') })).catch(() => ({ hasPassword: false }));
    if (!entry.hasPassword) {
      // SPAs hydrate late (measured on trader.tradovate.com: the login form
      // mounts ~4s after domcontentloaded) — WAIT for the form before giving
      // up, instead of failing a site that simply has not rendered it yet.
      const waitMs = Number(process.env.CLONER_AUTH_FORM_WAIT_MS || 15000);
      const appeared = await page.waitForSelector(PASSWORD_SELECTOR, { state: "visible", timeout: waitMs }).then(() => true, () => false);
      if (!appeared) {
        warnings.push(`no login form detected at the target url (no visible password input after ${waitMs}ms wait) — nothing submitted`);
        return failed("no-login-form", warnings);
      }
      warnings.push("login form appeared after hydration wait");
    }

    // ---- fill the ONE login form ----
    const userOk = await page.locator(USERNAME_SELECTOR).first().fill(username, { timeout: cfg.fillTimeoutMs }).then(() => true, () => false);
    if (!userOk) warnings.push("login: username/email field not found — credentials were not typed");
    const passOk = await page.locator(PASSWORD_SELECTOR).first().fill(password, { timeout: cfg.fillTimeoutMs }).then(() => true, () => false);
    if (!passOk) warnings.push("login: password field not fillable — credentials were not typed");
    if (!userOk || !passOk) return failed("login-form-fill-failed", warnings);

    // ---- submit exactly once, destructively-guarded ----
    const submitted = await submitLoginFormOnce(page, cfg, warnings, log);
    if (!submitted) return failed("login-form-submit-failed", warnings);

    await page.waitForLoadState("domcontentloaded", { timeout: cfg.navigationTimeoutMs }).catch(() => {});
    await page.waitForTimeout(cfg.postSubmitWaitMs);

    // the submit is a second navigation and this is the page the session state
    // is persisted from — it passes the same post-navigation policy
    const postCheck = assertSafeNavigationUrl(page.url());
    if (!postCheck.ok) {
      log.warn("auth", `ssrf-guard: ${postCheck.error}`);
      return failed(`ssrf-guard: ${postCheck.error}`, warnings);
    }

    // ---- post-submit triage: MFA/CAPTCHA pause vs failed login vs authed ----
    const probe = await page.evaluate(PAGE_PROBE_SCRIPT).catch(() => null);
    if (!probe) return failed("post-submit-page-unreadable", warnings);

    if (probe.challenge) {
      const sig = [probe.challenge.name, probe.challenge.id, probe.challenge.type].filter(Boolean).join("/") || "input";
      log.warn("auth", "mfa/captcha challenge detected — pausing for human", { signal: sig });
      return failed(`mfa-challenge: visible OTP/captcha-style input (${sig}) — not bypassing, needs human`, warnings, { needsHuman: true });
    }
    if (MFA_TEXT_PATTERN.test(probe.text)) {
      log.warn("auth", "mfa/captcha text detected — pausing for human");
      return failed("mfa-challenge: page text matches /mfa|2fa|verification code|captcha|otp/i — not bypassing, needs human", warnings, { needsHuman: true });
    }
    // A genuine second step can re-ask for the password without a username
    // field; a plain failed login re-renders the original form (both fields).
    if (probe.hasPassword && !probe.hasUsername) {
      return failed("mfa-challenge: post-submit page still asks for credentials without a username field — second-step challenge, not bypassing", warnings, { needsHuman: true });
    }
    if (probe.hasPassword) {
      log.warn("auth", "login did not succeed — password field still present");
      return failed("login-failed: password field still present after submit (credentials rejected)", warnings);
    }

    // ---- verify authed state via logged-in indicators ----
    const dom = await page.evaluate(INDICATOR_PROBE_SCRIPT).catch(() => ({}));
    const cookiesAfter = (await context.cookies()).length;
    const indicators = ["password-field-gone"];
    if (cookiesAfter > cookiesBefore) indicators.push(`cookie-count-increased:${cookiesBefore}->${cookiesAfter}`);
    if (dom.logout) indicators.push(`logout-link:${dom.logout}`);
    if (dom.avatar) indicators.push(`avatar-element:${dom.avatar}`);

    if (indicators.length < 2) {
      warnings.push(`password field gone but no logged-in indicator found (cookies ${cookiesBefore}->${cookiesAfter}, no logout control, no avatar) — refusing to persist an unverified session`);
      return failed("no-login-indicators", warnings, { indicators });
    }

    // ---- persist context storage state (the official pattern) ----
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    await context.storageState({ path: storagePath });
    const written = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    if (!Array.isArray(written.cookies) || written.cookies.length === 0) {
      warnings.push("storage state written but contains no cookies — downstream contexts will start unauthenticated");
      return failed("storage-state-empty", warnings, { indicators });
    }

    log.info("auth", "authenticated session established", {
      storageStatePath: storagePath,
      indicators: indicators.length,
    });

    // ---- persist sessionStorage (Playwright's storageState captures cookies +
    // localStorage only — measured on trader.tradovate.com: the SPA keeps its
    // auth token in sessionStorage, so a storageState-only context lands back
    // on the login screen. Sidecar file; the exploration context injects it
    // via addInitScript before the first navigation.) ----
    let sessionStoragePath = null;
    try {
      const sessionData = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          items[k] = sessionStorage.getItem(k);
        }
        return { origin: location.origin, items };
      });
      if (sessionData && Object.keys(sessionData.items || {}).length) {
        sessionStoragePath = path.join(path.dirname(storagePath), "session-storage.json");
        fs.writeFileSync(sessionStoragePath, JSON.stringify(sessionData, null, 2));
        log.info("auth", `sessionStorage captured: ${Object.keys(sessionData.items).length} keys (${sessionData.origin})`);
      }
    } catch (e) {
      warnings.push("sessionStorage capture failed (context will rely on cookies/localStorage only): " + String(e?.message || e).slice(0, 100));
    }

    return { ok: true, needsHuman: false, storageStatePath: storagePath, sessionStoragePath, indicators, warnings };
  } catch (err) {
    warnings.push(`authenticateSession error: ${err && err.message ? err.message : String(err)}`);
    return failed("error", warnings);
  } finally {
    if (detachWsGuard) detachWsGuard();
    if (browser) await browser.close().catch(() => {});
  }
}

// Submit the one login form, exactly once, under the destructive-action guard:
// the click target is scoped INSIDE the form that contains the password input,
// and any candidate whose label matches destructive verbs is refused (keyboard
// submit on the login form's password field is the only fallback). Nothing
// outside that form is ever clicked or submitted.
async function submitLoginFormOnce(page, cfg, warnings, log) {
  const loginForm = page.locator(LOGIN_FORM_SELECTOR).first();
  const candidate = loginForm.locator('button[type="submit"], input[type="submit"], button:not([type])').first();

  let clickTarget = null;
  if ((await loginForm.count()) > 0 && (await candidate.count()) > 0) {
    const label = await candidate
      .evaluate((el) => ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("value") || "")).trim())
      .catch(() => "");
    if (DESTRUCTIVE_LABEL_PATTERN.test(label)) {
      warnings.push(`destructive-action guard: refused to click login submit control labeled "${label.slice(0, 60)}" — falling back to keyboard submit on the login form only`);
    } else {
      clickTarget = candidate;
    }
  }

  if (clickTarget) {
    const clicked = await clickTarget.click({ timeout: cfg.submitClickTimeoutMs }).then(() => true, () => false);
    if (clicked) {
      log.info("auth", "login form submitted (button click)");
      return true;
    }
    warnings.push("login submit button click failed — falling back to keyboard submit on the login form only");
  }
  const enter = await page
    .locator(PASSWORD_SELECTOR)
    .first()
    .press("Enter", { timeout: cfg.submitClickTimeoutMs })
    .then(() => true, () => false);
  if (enter) {
    log.info("auth", "login form submitted (Enter in password field)");
    return true;
  }
  warnings.push("could not submit the login form (no submit control, Enter failed)");
  return false;
}
