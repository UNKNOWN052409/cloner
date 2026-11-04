// Ad slots — page placements, frequency capping, operator settings, the
// delivery ledger and the HTTP surface (task 4.5.4 ad-provider-core).
//
// PLACEMENTS: every page gets the full slot set (header / mid-content /
// sidebar / footer), each an inert, clearly labelled <aside> wrapper around
// the OFFICIAL network tag produced by ad-providers.js. Slots never mimic UI
// controls: no buttons, no links, no inputs, no pointer affordances, the
// wrapper itself has pointer-events:none so it can never intercept real page
// controls, and the only human-readable text is the word "Advertisement".
//
// BROWSER-SIDE FALLBACK: when both networks are configured for a slot, the
// served markup carries a one-shot bootstrap that — ONLY if the rendered
// network's loader script fails to load — swaps in the other network's
// OFFICIAL tag exactly once (guarded by a data attribute). It never repeats,
// never re-renders later, and contains no timers of any kind.
//
// FREQUENCY CAPPING (configurable): each (viewer session, slot) pair is
// served at most N times per rolling window. N and the window come from env
// (AD_FREQUENCY_CAP_MAX / AD_FREQUENCY_CAP_WINDOW_SECONDS) with per-slot
// operator overrides in the ad_slot_settings table. Session identity is a
// random cookie id stored ONLY as a salted SHA-256 hash — never an IP, never
// an email, no PII. When the ledger is unreachable the cap check fails
// CLOSED: the slot is skipped with an honest log line (an unverifiable cap is
// treated as an exhausted cap rather than silently disabled).
//
// CLEAN DEGRADATION: with no zones configured, a dead network, a disabled
// slot or an unreachable database, every endpoint still answers HTTP 200 with
// empty slot markup and an honest per-slot status. Nothing crashes.
//
// NO-MOCKS: this module contains no simulator; it renders real official tags
// from real env configuration, or nothing.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — not edited here):
//
//   import { adsRouter, ADS_CSS } from "../monetization/ad-slots.js";
//   app.use("/api/ads", adsRouter());
//
//   ROUTES  GET  /api/ads/page/:pageKey      public — markup for every slot on a page
//           GET  /api/ads/slot/:slotKey      public — single slot markup
//           GET  /api/ads/status             authRequired — configured flags + health
//                                            (booleans only; never zone ids or URLs)
//           PUT  /api/ads/settings/:slotKey  authRequired + admin — enable/cap overrides
//
//   The page/slot endpoints set one HttpOnly cookie (cloner_ad_sid, random
//   uuid) so anonymous visitors get a stable frequency-cap session.
import express, { Router } from "express";
import crypto from "node:crypto";
import { query as dbQuery } from "../database/client.js";
import { authRequired as defaultAuthRequired, requireRole } from "../auth/auth-middleware.js";
import {
  PROVIDERS,
  SLOT_POSITIONS,
  buildOfficialTag,
  escapeHtmlAttr,
  primaryProviderId,
  providerChain,
  providerHealthState,
  resolveAd,
  resetProviderState,
} from "./ad-providers.js";

export { SLOT_POSITIONS, resetProviderState };

const DEFAULT_CAP_MAX = 1;
const DEFAULT_CAP_WINDOW_SECONDS = 3600;
const SETTINGS_CACHE_MS = 5_000;
const PURGE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AD_SID_COOKIE = "cloner_ad_sid";

const envInt = (name, fallback) => {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

// Per-process salt so stored session hashes are useless across restarts even
// if the database leaks; operators may pin AD_SESSION_SALT for stable hashes.
const SESSION_SALT = (process.env.AD_SESSION_SALT || "").trim() || crypto.randomBytes(16).toString("hex");

export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(`${SESSION_SALT}:${String(token || "")}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// schema (suite boot helper — the canonical DDL lives in migration 050)
// ---------------------------------------------------------------------------

export async function ensureAdSchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ad_slot_settings (
      slot_key                     TEXT PRIMARY KEY,
      enabled                      BOOLEAN NOT NULL DEFAULT TRUE,
      provider_override            TEXT     NULL CHECK (provider_override IS NULL OR provider_override IN ('monetag','adsterra')),
      frequency_cap_max            INT      NULL CHECK (frequency_cap_max IS NULL OR frequency_cap_max >= 0),
      frequency_cap_window_seconds INT      NULL CHECK (frequency_cap_window_seconds IS NULL OR frequency_cap_window_seconds > 0),
      updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ad_serving_events (
      id           BIGSERIAL PRIMARY KEY,
      slot_key     TEXT NOT NULL,
      provider     TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      served_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ad_serving_session_slot ON ad_serving_events (session_hash, slot_key, served_at DESC)`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ad_serving_served_at ON ad_serving_events (served_at)`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ad_delivery_log (
      id         BIGSERIAL PRIMARY KEY,
      slot_key   TEXT,
      provider   TEXT,
      outcome    TEXT NOT NULL,
      detail     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_ad_delivery_created_at ON ad_delivery_log (created_at DESC)`);
}

// ---------------------------------------------------------------------------
// honest delivery log — console line always, database row best-effort
// ---------------------------------------------------------------------------

export async function logDelivery({ slotKey, provider, outcome, detail }) {
  const line = `[ads] slot=${slotKey || "-"} provider=${provider || "-"} outcome=${outcome}${detail ? ` detail=${detail}` : ""}`;
  console.log(line);
  try {
    await dbQuery(
      "INSERT INTO ad_delivery_log (slot_key, provider, outcome, detail) VALUES ($1, $2, $3, $4)",
      [slotKey || null, provider || null, String(outcome), detail ? String(detail).slice(0, 500) : null]
    );
  } catch {
    // the console line above IS the honest log; a dead database must not
    // break ad rendering (and the cap check independently fails closed)
  }
}

// ---------------------------------------------------------------------------
// operator settings (per slot) — cached briefly, invalidated on write
// ---------------------------------------------------------------------------

const settingsCache = new Map(); // slotKey → { at, value }

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  providerOverride: null,
  capMax: null,
  capWindowSeconds: null,
});

export async function getSlotSettings(slotKey) {
  const cached = settingsCache.get(slotKey);
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
  let value = { ...DEFAULT_SETTINGS };
  try {
    const r = await dbQuery(
      `SELECT enabled, provider_override, frequency_cap_max, frequency_cap_window_seconds
       FROM ad_slot_settings WHERE slot_key = $1`,
      [slotKey]
    );
    if (r.rows[0]) {
      const row = r.rows[0];
      value = {
        enabled: row.enabled,
        providerOverride: row.provider_override,
        capMax: row.frequency_cap_max,
        capWindowSeconds: row.frequency_cap_window_seconds,
      };
    }
    settingsCache.set(slotKey, { at: Date.now(), value });
  } catch (e) {
    // no cache on error; the caller's next DB step will fail closed
    value = { ...value, dbError: String((e && e.message) || e).slice(0, 200) };
  }
  return value;
}

export async function putSlotSettings(slotKey, patch = {}) {
  const current = await getSlotSettings(slotKey);
  const merged = {
    enabled: "enabled" in patch ? patch.enabled : current.enabled,
    providerOverride: "providerOverride" in patch ? patch.providerOverride : current.providerOverride,
    capMax: "capMax" in patch ? patch.capMax : current.capMax,
    capWindowSeconds: "capWindowSeconds" in patch ? patch.capWindowSeconds : current.capWindowSeconds,
  };
  await dbQuery(
    `INSERT INTO ad_slot_settings (slot_key, enabled, provider_override, frequency_cap_max, frequency_cap_window_seconds)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slot_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       provider_override = EXCLUDED.provider_override,
       frequency_cap_max = EXCLUDED.frequency_cap_max,
       frequency_cap_window_seconds = EXCLUDED.frequency_cap_window_seconds,
       updated_at = now()`,
    [slotKey, merged.enabled, merged.providerOverride, merged.capMax, merged.capWindowSeconds]
  );
  settingsCache.delete(slotKey);
  return merged;
}

// ---------------------------------------------------------------------------
// frequency cap — serving ledger, fail-closed
// ---------------------------------------------------------------------------

let lastPurgeAt = 0;

async function purgeOldServingEvents() {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_MIN_INTERVAL_MS) return;
  lastPurgeAt = now;
  try {
    await dbQuery(`DELETE FROM ad_serving_events WHERE served_at < now() - interval '24 hours'`);
  } catch {
    // ledger maintenance is best-effort; the cap check itself decides serving
  }
}

// Returns { ok:true, served, capMax, capWindowSeconds } or { ok:false, reason }.
// A database error is a CLOSED cap (slot skipped), never an open one.
export async function capStateFor(slotKey, sessionHash, settings) {
  const capMax = settings.capMax ?? envInt("AD_FREQUENCY_CAP_MAX", DEFAULT_CAP_MAX);
  const capWindowSeconds = settings.capWindowSeconds ?? envInt("AD_FREQUENCY_CAP_WINDOW_SECONDS", DEFAULT_CAP_WINDOW_SECONDS);
  try {
    const r = await dbQuery(
      `SELECT count(*)::int AS served FROM ad_serving_events
       WHERE session_hash = $1 AND slot_key = $2
         AND served_at > now() - make_interval(secs => $3::int)`,
      [sessionHash, slotKey, capWindowSeconds]
    );
    return { ok: true, served: r.rows[0].served, capMax, capWindowSeconds };
  } catch (e) {
    return { ok: false, reason: "cap_check_unavailable", error: String((e && e.message) || e).slice(0, 200), capMax, capWindowSeconds };
  }
}

export async function recordServe(slotKey, provider, sessionHash) {
  try {
    await dbQuery(
      "INSERT INTO ad_serving_events (slot_key, provider, session_hash) VALUES ($1, $2, $3)",
      [slotKey, provider, sessionHash]
    );
  } catch (e) {
    await logDelivery({ slotKey, provider, outcome: "serve_ledger_write_failed", detail: String((e && e.message) || e).slice(0, 200) });
    return;
  }
  purgeOldServingEvents();
}

// ---------------------------------------------------------------------------
// markup — inert, labelled wrappers around official tags
// ---------------------------------------------------------------------------

// Neutral, non-interactive container styles. The wrapper can never intercept
// page controls (pointer-events:none) and nothing here looks like a button.
export const ADS_CSS = `
.cloner-ad-slot { display: block; margin: 12px 0; pointer-events: none; }
.cloner-ad-slot__label {
  display: block; font: 400 10px/1.2 system-ui, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; color: #8a8f98; margin-bottom: 4px;
}
.cloner-ad-slot__body { pointer-events: auto; min-height: 0; }
`.trim();

// One-shot loader-failure bootstrap: if the rendered network's script fails
// to load, swap in the other network's OFFICIAL tag exactly once. No timers,
// no repetition, guarded by a data attribute.
const FALLBACK_BOOTSTRAP_BODY = `
(function () {
  "use strict";
  var me = document.currentScript;
  if (!me) return;
  var cfg;
  try { cfg = JSON.parse(me.getAttribute("data-ad-fallback") || "{}"); } catch (e) { return; }
  var host = me.parentElement;
  if (!host || !cfg.fbSrc) return;
  var primary = host.querySelector('script[data-ad-provider="' + cfg.primary + '"]');
  if (!primary || host.getAttribute("data-ad-fallback-done")) return;
  primary.addEventListener("error", function () {
    if (host.getAttribute("data-ad-fallback-done")) return;
    host.setAttribute("data-ad-fallback-done", "1");
    while (host.firstChild) host.removeChild(host.firstChild);
    if (cfg.fbContainer) {
      var box = document.createElement("div");
      box.id = cfg.fbContainer;
      box.setAttribute("data-ad-container", "1");
      host.appendChild(box);
    }
    var s = document.createElement("script");
    s.async = true;
    s.setAttribute("data-cfasync", "false");
    s.setAttribute("data-ad-provider", cfg.fbProvider);
    s.src = cfg.fbSrc;
    host.appendChild(s);
  }, { once: true });
})();
`.trim();

function attrJsonForSingleQuoted(value) {
  return String(value).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

function fallbackBootstrap(slotKey, servedProvider) {
  const other = PROVIDERS.find((p) => p !== servedProvider);
  if (!other) return null;
  const tag = buildOfficialTag(other, slotKey);
  if (!tag) return null;
  const cfg = JSON.stringify({
    primary: servedProvider,
    fbProvider: other,
    fbSrc: tag.loaderUrl,
    fbContainer: tag.containerId,
  });
  return (
    `<script type="text/javascript" data-ad-fallback='${attrJsonForSingleQuoted(cfg)}'>` +
    FALLBACK_BOOTSTRAP_BODY +
    `</script>`
  );
}

export function buildSlotMarkup({ slotKey, provider, tagHtml, fallback }) {
  const parts = [tagHtml];
  if (fallback) parts.push(fallback);
  return (
    `<aside class="cloner-ad-slot" data-ad-slot="${escapeHtmlAttr(slotKey)}" role="complementary" aria-label="Advertisement">\n` +
    `  <span class="cloner-ad-slot__label">Advertisement</span>\n` +
    `  <div class="cloner-ad-slot__body"${provider ? ` data-ad-provider="${escapeHtmlAttr(provider)}"` : ""}>\n` +
    `    ${parts.join("\n    ")}\n` +
    `  </div>\n` +
    `</aside>`
  );
}

// ---------------------------------------------------------------------------
// resolution with caps → render-ready slot entries
// ---------------------------------------------------------------------------

const slotEntry = (slotKey, extra) => ({ key: slotKey, position: slotKey, ...extra });

// Resolve + cap-check + ledger + markup for ONE slot. Never throws; every
// non-serving path returns an honest status and empty markup.
export async function resolveSlotForRender(slotKey, { sessionHash = null, fetchImpl } = {}) {
  const settings = await getSlotSettings(slotKey);
  if (settings.enabled === false) {
    await logDelivery({ slotKey, provider: null, outcome: "disabled_by_settings" });
    return slotEntry(slotKey, { status: "skipped_disabled", provider: null, html: "" });
  }

  // Pure callers without a session get a one-off identity: caps still apply
  // within the call (cap 0 disables serving), just not across calls.
  const effectiveHash = sessionHash || hashSessionToken(`ephemeral-${crypto.randomUUID()}`);

  const cap = await capStateFor(slotKey, effectiveHash, settings);
  if (!cap.ok) {
    await logDelivery({ slotKey, provider: null, outcome: "cap_check_unavailable", detail: cap.error });
    return slotEntry(slotKey, { status: "skipped_cap_check_unavailable", provider: null, html: "", detail: cap.error });
  }
  if (cap.served >= cap.capMax) {
    await logDelivery({ slotKey, provider: null, outcome: "frequency_capped", detail: `served=${cap.served} cap=${cap.capMax} window=${cap.capWindowSeconds}s` });
    return slotEntry(slotKey, { status: "skipped_frequency_capped", provider: null, html: "", detail: `served=${cap.served} cap=${cap.capMax}` });
  }

  const resolution = await resolveAd(slotKey, { fetchImpl, primaryOverride: settings.providerOverride });
  if (!resolution.ok) {
    const outcome = resolution.reason === "not_configured" ? "not_configured" : "no_provider_available";
    await logDelivery({
      slotKey,
      provider: null,
      outcome,
      detail: resolution.attempts.map((a) => `${a.provider}:${a.outcome}${a.env ? `(${a.env} unset)` : ""}${a.status ? `(HTTP ${a.status})` : ""}`).join(", ") || resolution.reason,
    });
    return slotEntry(slotKey, { status: `skipped_${outcome}`, provider: null, html: "", attempts: resolution.attempts });
  }

  await recordServe(slotKey, resolution.provider, effectiveHash);
  const html = buildSlotMarkup({
    slotKey,
    provider: resolution.provider,
    tagHtml: resolution.tag.html,
    fallback: fallbackBootstrap(slotKey, resolution.provider),
  });
  await logDelivery({ slotKey, provider: resolution.provider, outcome: "served", detail: resolution.attempts.length ? `attempts=${JSON.stringify(resolution.attempts)}` : null });
  return slotEntry(slotKey, { status: "served", provider: resolution.provider, html });
}

// Full page render: every slot position, in order, each independently
// degraded. Never throws.
export async function buildPageMarkup(pageKey, opts = {}) {
  const slots = [];
  for (const slotKey of SLOT_POSITIONS) {
    slots.push(await resolveSlotForRender(slotKey, opts));
  }
  return { pageKey, slots };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function readCookie(req, name) {
  const header = (req.headers && req.headers.cookie) || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function ensureSessionCookie(req, res) {
  const existing = readCookie(req, AD_SID_COOKIE);
  if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
  const sid = crypto.randomUUID();
  // express Response.cookie needs no cookie-parser middleware
  res.cookie(AD_SID_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
  return sid;
}

export function adsRouter({ authRequired = defaultAuthRequired, adminOnly = requireRole("admin") } = {}) {
  const router = Router();
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      res.status(500).json({ error: String((e && e.message) || "internal error").slice(0, 300) });
    });
  };

  router.get("/page/:pageKey", wrap(async (req, res) => {
    const pageKey = String(req.params.pageKey || "");
    if (!PAGE_KEY_RE.test(pageKey)) {
      return res.status(400).json({ error: "invalid page key (lowercase letters, digits, dashes, max 64)" });
    }
    const sid = ensureSessionCookie(req, res);
    const out = await buildPageMarkup(pageKey, { sessionHash: hashSessionToken(sid) });
    res.json(out);
  }));

  router.get("/slot/:slotKey", wrap(async (req, res) => {
    const slotKey = String(req.params.slotKey || "");
    if (!SLOT_POSITIONS.includes(slotKey)) {
      return res.status(404).json({ error: `unknown slot; valid: ${SLOT_POSITIONS.join(", ")}` });
    }
    const sid = ensureSessionCookie(req, res);
    const slot = await resolveSlotForRender(slotKey, { sessionHash: hashSessionToken(sid) });
    res.json({ slotKey, slot });
  }));

  router.get("/status", authRequired, wrap(async (_req, res) => {
    res.json({
      ok: true,
      primary: primaryProviderId(),
      chain: providerChain(),
      providers: [...PROVIDERS],
      slots: SLOT_POSITIONS.map((k) => ({
        key: k,
        monetag: { configured: !!buildOfficialTag("monetag", k) },
        adsterra: { configured: !!buildOfficialTag("adsterra", k) },
      })),
      health: providerHealthState(),
      caps: {
        max: envInt("AD_FREQUENCY_CAP_MAX", DEFAULT_CAP_MAX),
        windowSeconds: envInt("AD_FREQUENCY_CAP_WINDOW_SECONDS", DEFAULT_CAP_WINDOW_SECONDS),
      },
    });
  }));

  router.put("/settings/:slotKey", authRequired, adminOnly, express.json({ limit: "16kb" }), wrap(async (req, res) => {
    const slotKey = String(req.params.slotKey || "");
    if (!SLOT_POSITIONS.includes(slotKey)) {
      return res.status(404).json({ error: `unknown slot; valid: ${SLOT_POSITIONS.join(", ")}` });
    }
    const body = req.body || {};
    const patch = {};
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
      patch.enabled = body.enabled;
    }
    if ("providerOverride" in body) {
      if (body.providerOverride !== null && !PROVIDERS.includes(body.providerOverride)) {
        return res.status(400).json({ error: `providerOverride must be null or one of ${PROVIDERS.join(", ")}` });
      }
      patch.providerOverride = body.providerOverride;
    }
    if ("capMax" in body) {
      const n = Number(body.capMax);
      if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: "capMax must be an integer 0..100" });
      patch.capMax = n;
    }
    if ("capWindowSeconds" in body) {
      const n = Number(body.capWindowSeconds);
      if (!Number.isInteger(n) || n < 1 || n > 604800) return res.status(400).json({ error: "capWindowSeconds must be an integer 1..604800" });
      patch.capWindowSeconds = n;
    }
    const merged = await putSlotSettings(slotKey, patch);
    await logDelivery({ slotKey, provider: null, outcome: "settings_updated", detail: JSON.stringify(patch) });
    res.json({ ok: true, slotKey, settings: merged });
  }));

  router.use((err, _req, res, _next) => {
    res.status(500).json({ error: String((err && err.message) || "internal error").slice(0, 300) });
  });

  return router;
}
