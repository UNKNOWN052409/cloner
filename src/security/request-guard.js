// Request-level SSRF guard for browser contexts (hunt G5.3 fix).
//
// The entry-point guard (url-guard.validatePublicUrl) validates the task URL
// ONCE, before navigation. That leaves three bypass classes open:
//   1. REDIRECT CHAINS — a public target 302s the browser to
//      http://127.0.0.1:PORT/admin or http://169.254.169.254/ and Chromium
//      follows without any re-validation.
//   2. DNS REBINDING (TOCTOU) — validatePublicUrl resolves the hostname with
//      dns.lookup, then Chromium resolves it AGAIN at connect time. A
//      rebinding DNS server answers the first lookup with a public IP and the
//      second with 127.0.0.1 / RFC1918.
//   3. TARGET-PAGE PIVOTS — the cloned site is untrusted input: its own
//      <img src>, fetch(), XHR, iframe src or discovered same-site tabs can
//      point at loopback / RFC1918 / cloud metadata from INSIDE the cloner's
//      browser context.
//
// This module attaches a Playwright route handler ("**/*") to the browser
// context. EVERY request is re-validated at REQUEST time: scheme, hostname
// blocklists, literal-IP privacy, and a FRESH dns.lookup (never cached — the
// per-request fresh resolution is what shrinks the rebinding window from
// "task duration" to "between our check and Chromium's connect").
//
// Known residual (documented, best-effort): WebSocket handshakes are not
// interceptable through context.route — guardPageWebSockets() closes WS
// connections to private hosts as soon as Playwright surfaces them, so a
// single handshake may complete before the close lands.
import dns from "node:dns/promises";
import { bus } from "../events.js";
import { isPrivateLiteralIp, isBlockedHostname, allowPrivateTargets } from "./url-guard.js";

let guardSeq = 0;

// Fresh per-request resolution. Literal IPs are decided without DNS; names
// get an all-family lookup on EVERY request (no cache — that is the point: a
// rebinding DNS server is re-asked for every single request).
// Policy env (CLONER_ALLOW_PRIVATE_TARGETS) is read LIVE per request — local
// fixture suites opt in, production stays strict without a restart.
async function hostDecision(host) {
  const verdict = isBlockedHostname(host);
  // literal-decided hosts honor the opt-in; blocklisted NAMES never pass even
  // with it (a hostname spelled "localhost" has no legitimate remote use).
  if (verdict.blocked && !verdict.isLiteral) return { blocked: true, reason: verdict.reason };
  const allowPrivate = allowPrivateTargets();
  if (verdict.blocked && verdict.isLiteral && !allowPrivate) return { blocked: true, reason: verdict.reason };
  if (verdict.blocked && verdict.isLiteral && allowPrivate) return { blocked: false };
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { blocked: true, reason: `hostname ${host} does not resolve (request dropped)` };
  }
  if (!addrs.length) return { blocked: true, reason: `hostname ${host} has no addresses` };
  // Any private address in the answer set is a pivot — same policy as the
  // entry guard (a name resolving to ANY private address is rejected).
  const hit = addrs.find((a) => isPrivateLiteralIp(a.address) === true);
  if (hit && !allowPrivate) return { blocked: true, reason: `hostname ${host} resolves to a private address (${hit.address}) — request dropped` };
  return { blocked: false };
}

function hostIsPrivateAddress(rawHost) {
  // For a URL hostname: literal IPs via the shared predicate; names are never
  // decided here (post-navigation checks only see what the browser resolved).
  return isPrivateLiteralIp(String(rawHost || "").toLowerCase()) === true;
}

// Attach the guard to a Playwright BrowserContext. Every http(s) request
// leaving the context is validated fresh; blocked requests are aborted with
// reason "blockedbyclient" (visible in the target's devtools as ERR_BLOCKED_BY_CLIENT).
// Returns { id, dispose } — dispose unroutes (test teardown).
export async function attachRequestGuard(context, { logBlocked = true } = {}) {
  const id = ++guardSeq;
  const handler = async (route) => {
    let decision = { blocked: false, reason: null };
    try {
      const u = new URL(route.request().url());
      if (!/^https?:$/.test(u.protocol)) {
        decision = { blocked: true, reason: `scheme ${u.protocol} not allowed` };
      } else {
        decision = await hostDecision(u.hostname);
      }
    } catch {
      decision = { blocked: true, reason: "unparseable request URL" };
    }
    if (decision.blocked) {
      if (logBlocked) {
        try { bus.emit("log", { level: "warn", msg: `[ssrf-guard] blocked request: ${decision.reason}` }); } catch {}
      }
      try { await route.abort("blockedbyclient"); } catch { try { await route.abort(); } catch {} }
      return;
    }
    try { await route.continue(); } catch { /* navigation raced a close — harmless */ }
  };
  await context.route("**/*", handler);
  return {
    id,
    dispose: async () => { try { await context.unroute("**/*", handler); } catch {} },
  };
}

// Post-navigation belt-and-braces: the FINAL url the browser actually landed
// on must pass the same policy. Catches anything that slips between the route
// layer and the renderer (and file:// navigations the route never sees).
export function assertSafeNavigationUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: `navigation landed on non-http(s) scheme ${u.protocol}` };
    const verdict = isBlockedHostname(u.hostname);
    // Same policy as the route layer above: a BLOCKED-LITERAL private IP passes
    // when the deployment opted in (CLONER_ALLOW_PRIVATE_TARGETS). Without the
    // isLiteral+allowPrivate escape here, an opted-in local fixture clone could
    // pass the route layer and still be killed post-navigation.
    if (verdict.blocked && !(verdict.isLiteral && allowPrivateTargets())) {
      return { ok: false, error: `navigation landed on blocked host: ${verdict.reason}` };
    }
    if (!allowPrivateTargets() && hostIsPrivateAddress(u.hostname)) {
      return { ok: false, error: `navigation landed on a private address (${u.hostname})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "navigation url unparseable" };
  }
}

// WebSocket residual: context.route does not intercept WS handshakes. Close
// any WS the page opens toward a private host (one handshake may complete —
// documented residual). Returns a detach function.
export function guardPageWebSockets(page, { logBlocked = true } = {}) {
  const onWs = (ws) => {
    let host = null;
    try { host = new URL(ws.url()).hostname; } catch { host = null; }
    const blocked = !host || isBlockedHostname(host).blocked || (!allowPrivateTargets() && hostIsPrivateAddress(host));
    if (blocked) {
      if (logBlocked) { try { bus.emit("log", { level: "warn", msg: `[ssrf-guard] closed websocket to blocked host ${host || "<unparseable>"}` }); } catch {} }
      try { ws.close(); } catch {}
    }
  };
  page.on("websocket", onWs);
  return () => { try { page.removeListener("websocket", onWs); } catch {} };
}
