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

function isPrivateLiteralIp(host) {
  // strip brackets from IPv6 literals
  const ip = host.replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true; // RFC1918, loopback, this-host
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
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
  let u;
  try {
    u = new URL(String(rawUrl));
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
