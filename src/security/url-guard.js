// SSRF guard: a cloning task drives a real browser to a user-supplied URL.
// Unvalidated, that URL can point at localhost admin panels, the Docker host,
// link-local cloud metadata (169.254.169.254), or internal RFC1918 services.
// Hostname blocklist + resolved-IP check (DNS lookup on every address);
// private targets are allowed only when the deployment opts in via
// CLONER_ALLOW_PRIVATE_TARGETS=1 (local fixture testing, intranet cloning).
import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata.google.internal", "metadata.goog",
]);

const PRIVATE_NAME_PATTERN = /(^|\.)(localhost|local|internal|lan|home|arpa|intranet)$/i;

export function isPrivateLiteralIp(host) {
  // strip brackets from IPv6 literals
  const ip = host.replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true; // RFC1918, loopback, this-host
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true; // RFC2544 benchmark 198.18/15 — used as internal infra range
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    // IPv4-mapped IPv6 literals (::ffff:127.0.0.1, ::ffff:7f00:1) are loopback /
    // RFC1918 to the OS and browser — evaluate the embedded IPv4 address instead
    // of letting the IPv6 fallthrough below mark them public (SSRF bypass).
    const mappedDotted = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedDotted) return isPrivateLiteralIp(mappedDotted[1]);
    const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
      return isPrivateLiteralIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    // NAT64 well-known prefix (64:ff9b::/96) and 6to4 (2002::/16) embed an
    // IPv4 address: a gateway/CLAT translates them to the embedded target, so a
    // browser can reach loopback/RFC1918 through them (SSRF bypass pattern).
    const nat64 = v.match(/^64:ff9b::([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/);
    if (nat64) {
      if (nat64[2]) {
        const hi = parseInt(nat64[1], 16), lo = parseInt(nat64[2], 16);
        return isPrivateLiteralIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
      // single-hextet low bits → embedded 0.0.0.N/16 (reserved — guarded as private)
      const g = parseInt(nat64[1], 16);
      return isPrivateLiteralIp(`0.0.${(g >> 8) & 255}.${g & 255}`);
    }
    const six4 = v.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
    if (six4) {
      const hi = parseInt(six4[1], 16), lo = parseInt(six4[2], 16);
      return isPrivateLiteralIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (v === "::" || v === "::1") return true; // unspecified, loopback
    if (/^f[cd]/.test(v)) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
    if (/^ff/.test(v)) return true; // multicast
    return false;
  }
  return null; // not a literal IP
}

function isBlockedAddress(ip) {
  return isPrivateLiteralIp(ip) === true;
}

// validate a user-supplied target URL. Returns { ok, url, error } — on !ok the
// caller must reject the task; never navigate on a failed check.
export async function validatePublicUrl(rawUrl, { allowPrivate = allowPrivateTargets() } = {}) {
  const raw = String(rawUrl ?? "");
  // G5.1 hunt fix: control characters (CR/LF/TAB/NUL) must be rejected BEFORE
  // anything else — the WHATWG URL parser silently STRIPS them
  // ("https://example.com/\nheader: x" parses to "https://example.com/header: x",
  // a 200 job), and a newline in a URL that later lands in logs/headers is the
  // classic request-smuggling shape.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: "URL contains control characters" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "invalid URL" };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: `protocol ${u.protocol} not allowed (http/https only)` };
  if (u.username || u.password) return { ok: false, error: "userinfo in URL not allowed" };
  const host = u.hostname.toLowerCase().replace(/\.$/, ""); // FQDN trailing dot
  if (!host) return { ok: false, error: "missing hostname" };
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, error: `host ${host} is blocked` };
  if (PRIVATE_NAME_PATTERN.test(host)) return { ok: false, error: `host ${host} looks internal` };

  const literal = isPrivateLiteralIp(host);
  if (literal !== null) {
    // literal IP — no DNS needed
    if (literal && !allowPrivate) return { ok: false, error: `private/reserved address ${host} blocked (set CLONER_ALLOW_PRIVATE_TARGETS=1 to allow)` };
    return { ok: true, url: u.toString(), resolved: [host] };
  }

  // hostname — resolve and check EVERY address (a name resolving to any
  // private address is a trivial SSRF pivot)
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: `hostname ${host} does not resolve` };
  }
  if (!addrs.length) return { ok: false, error: `hostname ${host} has no addresses` };
  const privateHits = addrs.filter((a) => isBlockedAddress(a.address));
  if (privateHits.length && !allowPrivate) {
    return { ok: false, error: `host ${host} resolves to a private address (${privateHits[0].address}) — blocked` };
  }
  return { ok: true, url: u.toString(), resolved: addrs.map((a) => a.address) };
}

export function allowPrivateTargets() {
  return process.env.CLONER_ALLOW_PRIVATE_TARGETS === "1";
}

// ---- shared sync predicates (used by the request-level guard) ----
// The entry-point guard above validates the task URL once; navigation can
// reach OTHER hosts afterwards (redirects, subresources, iframes, discovered
// tabs). The request guard re-runs these SAME predicates per request so the
// private-host policy stays in one place.

// Sync hostname check: blocklist + private-looking names + literal IPs.
// Returns { blocked, reason } — blocked true → the request must be dropped.
export function isBlockedHostname(rawHost) {
  const host = String(rawHost || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return { blocked: true, reason: "missing hostname" };
  if (BLOCKED_HOSTNAMES.has(host)) return { blocked: true, reason: `host ${host} is blocked` };
  if (PRIVATE_NAME_PATTERN.test(host)) return { blocked: true, reason: `host ${host} looks internal` };
  const literal = isPrivateLiteralIp(host);
  // isLiteral:true here lets the request-level guard honor the
  // CLONER_ALLOW_PRIVATE_TARGETS opt-in for literal IPs (hunt G5.1: without
  // it, verdict.isLiteral was undefined → loopback/private literals were
  // blocked at request time even when the opt-in allowed them at entry,
  // making local fixture cloning impossible with ERR_BLOCKED_BY_CLIENT).
  // Blocklisted NAMES never carry isLiteral — they stay blocked regardless
  // of the opt-in.
  if (literal === true) return { blocked: true, reason: `private/reserved address ${host} blocked`, isLiteral: true };
  return { blocked: false, reason: null, isLiteral: literal !== null };
}
