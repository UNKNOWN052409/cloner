// Ad providers — REAL network integration (task 4.5.4 ad-provider-core).
//
// NO MOCKS IN PRODUCT PATHS: this module renders the OFFICIAL ad-network tags
// (Monetag, Adsterra) exactly as the owner's dashboards ship them, with the
// zone ids harvested from those dashboards via env. The only network traffic
// this module generates is a single availability GET of the official loader
// URL per (provider, slot) inside the probe cache window — a reachability
// check of a public static file. It never plays a creative and never counts
// as an ad delivery. There is NO code anywhere in this module (or in
// ad-slots.js) that simulates or inflates traffic: no timer-driven
// re-rendering, no synthetic interactions, no fabricated events.
// scripts/test-ad-providers.mjs greps these files to keep that enforced.
//
// FALLBACK CHAIN (owner directive): Monetag PRIMARY with Adsterra fallback —
// or vice versa when AD_PROVIDER_PRIMARY=adsterra. When the leading
// provider's loader probe fails, the very next resolution leads with the
// other network (round-robin on failure). When both fail — or when a zone is
// simply not configured — the slot degrades to ZERO ad output with an honest
// log line. Nothing ever throws to the caller for a missing zone or a dead
// network; a missing env var is a configuration state, not an error.
//
// OFFICIAL TAG SHAPES (and nothing else — we never wrap or rewrite network
// code, only place the exact tag the network ships):
//   Monetag:  <script async="async" data-cfasync="false" src="{loader}"
//              data-zone="{zone}"></script>
//             loader defaults to https://fpyf8.com/88/tag.min.js;
//             MONETAG_LOADER_URL overrides it (the dashboard snippet is
//             authoritative per account — copy the exact src from your
//             Monetag dashboard if yours differs).
//   Adsterra: <script async="async" data-cfasync="false" src="{invoke.js}"></script>
//             <div id="container-{key}"></div>
//             The invoke.js URL is account- and domain-specific, so
//             ADSTERRA_ZONE_ID_{SLOT} accepts EITHER the full official src
//             pasted from the dashboard OR a bare zone id plus
//             ADSTERRA_LOADER_DOMAIN + ADSTERRA_ZONE_KEY_{SLOT}.
//
// Environment (all read per call so tests can toggle; documented in
// .env.example):
//   AD_PROVIDER_PRIMARY            monetag (default) | adsterra
//   MONETAG_ZONE_ID_{SLOT}         Monetag zone id (upper-snake slot name)
//   MONETAG_LOADER_URL             official Monetag loader URL (see default)
//   ADSTERRA_ZONE_ID_{SLOT}        full invoke.js URL or bare zone id
//   ADSTERRA_ZONE_KEY_{SLOT}       invoke.js path key (bare-zone-id form)
//   ADSTERRA_LOADER_DOMAIN         network domain (bare-zone-id form)
//   AD_PROBE_TIMEOUT_MS            loader availability probe timeout (default 3000)
//   AD_PROBE_CACHE_MS              probe result cache window (default 60000; 0 disables)
//
// Slots: HEADER, MID_CONTENT, SIDEBAR, FOOTER — exported as SLOT_POSITIONS
// and consumed by src/monetization/ad-slots.js.

export const PROVIDERS = Object.freeze(["monetag", "adsterra"]);
export const SLOT_POSITIONS = Object.freeze(["header", "mid-content", "sidebar", "footer"]);

const MONETAG_LOADER_DEFAULT = "https://fpyf8.com/88/tag.min.js";

const PROBE_TIMEOUT_MS_DEFAULT = 3_000;
const PROBE_CACHE_MS_DEFAULT = 60_000;

// ---------------------------------------------------------------------------
// small helpers (no dependencies)
// ---------------------------------------------------------------------------

export function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function envInt(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// "mid-content" → "MID_CONTENT" (env suffix per slot)
function envSuffix(slotKey) {
  return String(slotKey || "").replace(/-/g, "_").toUpperCase();
}

function providerEnvName(providerId, slotKey) {
  return providerId === "monetag"
    ? `MONETAG_ZONE_ID_${envSuffix(slotKey)}`
    : `ADSTERRA_ZONE_ID_${envSuffix(slotKey)}`;
}

function normalizeHttpUrl(raw) {
  const url = String(raw || "").trim();
  if (/^\/\//.test(url)) return "https:" + url;
  if (/^https?:\/\//i.test(url)) return url;
  return null; // relative or malformed — never guess a host for a network tag
}

// Adsterra's official invoke.js URL embeds the container key as its final
// path segment: //pl123456.profitablecpmrate.com/<key>/invoke.js
function invokePathKey(url) {
  const m = String(url || "").match(/\/([A-Za-z0-9_-]+)\/invoke\.js(?:[?#].*)?$/i);
  return m ? m[1] : null;
}

function valueIsSane(value) {
  // Zone ids and keys come from the owner's dashboards; accept their normal
  // alphabets and reject anything that could break out of an attribute.
  return /^[A-Za-z0-9_.:/?#[\]@!$&()*+,;=%~-]*$/.test(String(value));
}

// ---------------------------------------------------------------------------
// official tag builders — the ONLY place ad markup is produced
// ---------------------------------------------------------------------------

// Returns { html, loaderUrl, containerId } for a configured provider+slot, or
// null when the zone env for that slot is unset/incomplete. Null means "zero
// ad output + honest log" — never an error, never a crash.
export function buildOfficialTag(providerId, slotKey) {
  if (providerId === "monetag") {
    const envName = providerEnvName("monetag", slotKey);
    const zone = (process.env[envName] || "").trim();
    if (!zone || !valueIsSane(zone)) return null;
    const loaderRaw = (process.env.MONETAG_LOADER_URL || MONETAG_LOADER_DEFAULT).trim();
    const loaderUrl = normalizeHttpUrl(loaderRaw);
    if (!loaderUrl || !valueIsSane(loaderUrl)) return null;
    const html =
      `<script async="async" data-cfasync="false" data-ad-provider="monetag"` +
      ` src="${escapeHtmlAttr(loaderUrl)}" data-zone="${escapeHtmlAttr(zone)}"></script>`;
    return { html, loaderUrl, containerId: null };
  }

  if (providerId === "adsterra") {
    const envName = providerEnvName("adsterra", slotKey);
    const raw = (process.env[envName] || "").trim();
    if (!raw || !valueIsSane(raw)) return null;

    let loaderUrl = null;
    let key = null;
    if (/^(https?:)?\/\//i.test(raw)) {
      // full official src pasted from the dashboard
      loaderUrl = normalizeHttpUrl(raw);
      key = loaderUrl ? invokePathKey(loaderUrl) : null;
      if (!loaderUrl || !key) return null; // malformed or non-invoke URL → honest skip
    } else {
      const domain = (process.env.ADSTERRA_LOADER_DOMAIN || "").trim();
      const keyEnv = `ADSTERRA_ZONE_KEY_${envSuffix(slotKey)}`;
      const zoneKey = (process.env[keyEnv] || "").trim();
      if (!domain || !zoneKey || !valueIsSane(domain) || !valueIsSane(zoneKey)) return null;
      loaderUrl = `https://pl${raw}.${domain}/${zoneKey}/invoke.js`;
      key = zoneKey;
    }
    const containerId = `container-${key}`;
    const html =
      `<script async="async" data-cfasync="false" data-ad-provider="adsterra"` +
      ` src="${escapeHtmlAttr(loaderUrl)}"></script>` +
      `<div id="${escapeHtmlAttr(containerId)}" data-ad-container="1"></div>`;
    return { html, loaderUrl, containerId };
  }

  return null;
}

export function primaryProviderId() {
  const raw = (process.env.AD_PROVIDER_PRIMARY || "").trim().toLowerCase();
  if (PROVIDERS.includes(raw)) return raw;
  if (raw) {
    console.log(`[ads] AD_PROVIDER_PRIMARY="${raw}" is not one of ${PROVIDERS.join("|")} — using monetag`);
  }
  return "monetag";
}

export function fallbackProviderId(primary = primaryProviderId()) {
  return PROVIDERS.find((p) => p !== primary) || PROVIDERS[1];
}

// Ordered chain for a resolution: primary first, then the fallback. An
// operator pin (settings.provider_override) reorders the chain but never
// removes the fallback — availability always wins over preference.
export function providerChain(primaryOverride = null) {
  const primary = PROVIDERS.includes(primaryOverride) ? primaryOverride : primaryProviderId();
  const chain = [primary, fallbackProviderId(primary)];
  return chain;
}

// ---------------------------------------------------------------------------
// provider health + loader availability probe
// ---------------------------------------------------------------------------

const health = new Map();     // providerId → health snapshot
const probeCache = new Map(); // `${providerId}:${slotKey}` → { at, entry }

export function providerHealthState() {
  const out = {};
  for (const [id, h] of health.entries()) out[id] = { ...h };
  return out;
}

// Test/lifecycle hook: clears probe cache, health counters and the rotation
// cursor. Callers that toggle env between scenarios use this.
export function resetProviderState() {
  health.clear();
  probeCache.clear();
  rotateCursor = 0;
}

function noteProbe(providerId, { healthy, status, error }) {
  const h = health.get(providerId) || {
    consecutiveFailures: 0,
    totalOk: 0,
    totalFailures: 0,
    lastOkAt: null,
    lastFailureAt: null,
    lastStatus: null,
    lastError: null,
  };
  if (healthy) {
    h.consecutiveFailures = 0;
    h.totalOk += 1;
    h.lastOkAt = new Date().toISOString();
  } else {
    h.consecutiveFailures += 1;
    h.totalFailures += 1;
    h.lastFailureAt = new Date().toISOString();
    h.lastStatus = status;
    h.lastError = error;
  }
  health.set(providerId, h);
}

async function probeLoaderOnce(loaderUrl, fetchImpl, timeoutMs) {
  try {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const resp = await fetchImpl(loaderUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "cloner-ad-slot-health/1.0" },
      signal,
    });
    let bodyLen = 0;
    try {
      const text = await resp.text();
      bodyLen = text ? text.length : 0;
    } catch {
      bodyLen = 0;
    }
    const ok = resp && resp.status >= 200 && resp.status < 300 && bodyLen > 0;
    return {
      healthy: ok,
      status: resp ? resp.status : 0,
      error: ok ? null : `loader returned HTTP ${resp ? resp.status : "none"}${bodyLen === 0 ? " (empty body)" : ""}`,
    };
  } catch (e) {
    return { healthy: false, status: 0, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Availability probe of the official loader URL for one provider+slot. Not
// configured → { healthy:false, skipped:"not_configured" } WITHOUT touching
// health counters or the cache (absence of config is a state, not a failure).
// Healthy probes are cached for AD_PROBE_CACHE_MS so a busy page never
// generates extra network traffic.
export async function probeProvider(providerId, slotKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const tag = buildOfficialTag(providerId, slotKey);
  if (!tag) return { healthy: false, skipped: "not_configured", env: providerEnvName(providerId, slotKey), cached: false };

  const timeoutMs = opts.timeoutMs ?? envInt("AD_PROBE_TIMEOUT_MS", PROBE_TIMEOUT_MS_DEFAULT);
  const cacheMs = opts.cacheMs ?? envInt("AD_PROBE_CACHE_MS", PROBE_CACHE_MS_DEFAULT);
  const cacheKey = `${providerId}:${slotKey}`;
  const now = Date.now();

  if (!opts.forceProbe && cacheMs > 0) {
    const cached = probeCache.get(cacheKey);
    if (cached && now - cached.at < cacheMs) return { ...cached.entry, cached: true };
  }

  const result = await probeLoaderOnce(tag.loaderUrl, fetchImpl, timeoutMs);
  const entry = { ...result, cached: false };
  probeCache.set(cacheKey, { at: now, entry });
  noteProbe(providerId, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// resolution — the fallback chain with round-robin on failure
// ---------------------------------------------------------------------------

// Round-robin cursor over the provider chain. Starts at 0 (primary first).
// Each time the LEADING candidate fails its probe, the cursor advances so the
// next resolution leads with the other network — Monetag PRIMARY with
// Adsterra fallback, and vice versa after a Monetag failure.
let rotateCursor = 0;

// Resolve one slot to a provider + its official tag.
//
//   { ok: true,  provider, tag: { html, loaderUrl, containerId }, attempts }
//   { ok: false, reason: "not_configured" | "all_providers_failed", attempts }
//
// `attempts` records every candidate tried, with the env name when a zone was
// missing — this is what the honest delivery log is built from. Never throws.
export async function resolveAd(slotKey, opts = {}) {
  const chain = providerChain(opts.primaryOverride);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const attempts = [];
  let advanced = false;

  // Snapshot the visit order from the current cursor BEFORE iterating: an
  // in-flight rotation must never re-order this resolution mid-loop (that
  // would re-probe the failed primary instead of reaching the fallback).
  const start = ((rotateCursor % chain.length) + chain.length) % chain.length;
  const order = [];
  for (let i = 0; i < chain.length; i++) order.push(chain[(start + i) % chain.length]);

  for (let i = 0; i < order.length; i++) {
    const providerId = order[i];
    const tag = buildOfficialTag(providerId, slotKey);
    if (!tag) {
      attempts.push({ provider: providerId, outcome: "not_configured", env: providerEnvName(providerId, slotKey) });
      continue;
    }
    const probe = await probeProvider(providerId, slotKey, { fetchImpl, ...opts });
    if (probe.skipped === "not_configured") {
      attempts.push({ provider: providerId, outcome: "not_configured", env: probe.env });
      continue;
    }
    if (!probe.healthy) {
      attempts.push({ provider: providerId, outcome: "probe_failed", status: probe.status, error: probe.error, cached: probe.cached });
      // Only the leading candidate's failure rotates the cursor, and at most
      // one step per resolution — one failed request must not spin the chain.
      // The advance takes effect on the NEXT resolution (order is a snapshot).
      if (i === 0 && !advanced) {
        rotateCursor = (start + 1) % chain.length;
        advanced = true;
      }
      continue;
    }
    return { ok: true, provider: providerId, tag, attempts };
  }

  const anyConfigured = attempts.some((a) => a.outcome === "probe_failed");
  return {
    ok: false,
    reason: anyConfigured ? "all_providers_failed" : "not_configured",
    attempts,
  };
}
