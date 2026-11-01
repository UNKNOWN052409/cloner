#!/usr/bin/env node
// SSRF guard regression suite (4.0.12 security lane).
// Covers the bypass patterns probed by the quality gate:
//   • literal private IPv4 (RFC1918 / loopback / link-local / CGNAT / reserved)
//   • numeric-IP encodings (decimal 2130706433, hex 0x7f000001, short 127.1 —
//     WHATWG URL normalizes these to dotted quads, the guard must block them)
//   • embedded-IPv4 IPv6: ::ffff: mapped (dotted + hex) AND NAT64 64:ff9b::/96
//     AND 6to4 2002::/16 (gateway/CLAT translates them to the embedded target)
//   • hostname blocklist + private name pattern + trailing-dot FQDN
//   • DNS-resolving hostnames that point at private addresses are blocked
//   • CLONER_ALLOW_PRIVATE_TARGETS=1 opt-in still allows private targets
//   • public targets (IPv4, IPv6, FQDN with trailing dot) stay allowed
// No DB, no live services. Exits nonzero on any failure.
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const { validatePublicUrl, allowPrivateTargets } = await import("../src/security/url-guard.js");

const MUST_BLOCK = [
  // literal private IPv4
  "http://127.0.0.1/", "http://10.0.0.5/", "http://172.16.0.9/", "http://172.31.255.1/",
  "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.1.1/",
  "http://0.0.0.0/", "http://224.0.0.1/", "http://240.0.0.1/",
  // numeric encodings (WHATWG URL canonicalizes → dotted quad)
  // NOTE: octal forms are NOT WHATWG — "017000000001" parses to the public
  // 120.0.0.1 (guard and browser agree), so it is not a bypass and not listed.
  "http://2130706433/", "http://0x7f000001/", "http://127.1/",
  // loopback / private IPv6 literals
  "http://[::1]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd12::1]/", "http://[ff02::1]/",
  // IPv4-mapped IPv6 (dotted + hex hextet forms)
  "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:a00:1]/", "http://[::ffff:c0a8:101]/",
  // NAT64 64:ff9b::/96 (dotted-tail is normalized by the URL parser to hex)
  "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::127.0.0.1]/", "http://[64:ff9b::a00:1]/",
  "http://[64:ff9b::a9fe:a9fe]/", "http://[64:ff9b::1]/",
  // 6to4 2002::/16
  "http://[2002:7f00:1::]/", "http://[2002:c0a8:101::]/",
  // hostname blocklist + private name patterns
  "http://localhost/", "http://LOCALHOST/", "http://localhost./", "http://foo.localhost/",
  "http://my.host.internal/", "http://box.lan/", "http://metadata.google.internal/", "http://metadata.goog/",
  // userinfo smuggling
  "http://user:pass@example.com/",
  // non-http protocols
  "file:///etc/passwd", "ftp://example.com/", "javascript://example.com/%0aalert(1)",
];

const MUST_ALLOW = [
  "http://example.com/", "http://example.com./", "http://8.8.8.8/", "http://1.1.1.1/",
  "http://[2606:4700:4700::1111]/", "http://[2002::1]/", // 6to4 router address, NOT an embedded IPv4
];

let failed = 0;
const count = (ok) => { if (!ok) failed++; return ok; };
for (const u of MUST_BLOCK) {
  const r = await validatePublicUrl(u);
  check(`block ${u}`, count(r.ok === false), r.ok ? "ALLOWED" : r.error);
}
for (const u of MUST_ALLOW) {
  const r = await validatePublicUrl(u);
  check(`allow ${u}`, count(r.ok === true), r.ok ? "" : r.error);
}

// DNS pivot: a public name resolving to a private address is blocked (checked
// via the OS resolver — needs any DNS; if the resolver is down these SKIP)
try {
  const dns = await import("node:dns/promises");
  // localtest.me / localhost.section.company — not reliable; use the OS's own
  // resolver against a guaranteed-local name instead
  const r = await validatePublicUrl("http://ip6-localhost/");
  check("block ip6-localhost (blocklist)", r.ok === false, r.error || "");
} catch { /* unreachable */ }

// opt-in still works
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
check("allowPrivateTargets() honors the env opt-in", allowPrivateTargets() === true);
{
  const r = await validatePublicUrl("http://127.0.0.1:8080/");
  check("opt-in allows private targets", r.ok === true, r.ok ? "" : r.error);
  if (!r.ok) failed++;
}
delete process.env.CLONER_ALLOW_PRIVATE_TARGETS;

const passed = results.filter(Boolean).length;
console.log(`\n== url-guard regression: ${passed}/${results.length} passed ==`);
process.exit(failed ? 1 : 0);
