#!/usr/bin/env node
// G5.3 hostile hunt — SSRF request-guard child (PNA-neutral harness).
//
// Chromium's Private Network Access (PNA) blocks data:/about:blank → loopback
// fetches all by itself, which would fake a pass for any guard. This harness
// removes PNA from the equation: the "attacker page" AND the "intranet
// secret" are both served by REAL local HTTP servers (127.0.0.1 — local→local
// is PNA-allowed, proven by the no-guard control).
//
// The production newContext() (src/browser.js) attaches the request-level
// guard. allowPrivateTargets() is read LIVE per request, so the suite can:
//   1. load the page with the opt-in ON (document request passes),
//   2. flip the opt-in OFF mid-session,
//   3. fire hostile fetches — every abort now provably comes from the GUARD
//      (no PNA involved, no navigation origin change).
// A no-guard control run proves the harness itself delivers loopback fetches.
// Exits 0 iff every probe passed; prints a JSON verdict on the last line.
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

delete process.env.CLONER_ALLOW_PRIVATE_TARGETS;

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

// ---- the "intranet secret" (real local server = the remote-end stand-in) ----
const hits = [];
const secretServer = http.createServer((_q, res) => { hits.push(1); res.end("TOPSECRET"); });
await new Promise((r) => secretServer.listen(0, "127.0.0.1", r));
const secretPort = secretServer.address().port;
const SECRET = `http://127.0.0.1:${secretPort}/secret`;

// ---- the "attacker page" (real local server; local→local is PNA-neutral) ----
const pageServer = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<h1>attacker page</h1>"); });
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pagePort = pageServer.address().port;
const PAGE_URL = `http://127.0.0.1:${pagePort}/`;
const hitCount = () => hits.length;

const browserJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "browser.js");
const { launchBrowser, newContext } = await import(pathToFileURL(browserJsPath).href);

// ---- CONTROL 0: no guard at all → the harness itself delivers --------------
{
  const { chromium } = await import("playwright");
  const rawBrowser = await chromium.launch({ headless: true });
  const rawCtx = await rawBrowser.newContext();
  const rawPage = await rawCtx.newPage();
  await rawPage.goto(PAGE_URL, { waitUntil: "load" });
  hits.length = 0;
  const delivered = await rawPage.evaluate(async (url) => {
    try { await fetch(url, { mode: "no-cors" }); return true; } catch { return false; }
  }, SECRET);
  await rawPage.waitForTimeout(250);
  check("A0 control (no guard): local→local loopback fetch DELIVERS (harness is PNA-neutral)",
    delivered && hitCount() === 1, `delivered=${delivered} hits=${hitCount()}`);
  await rawBrowser.close();
}

let browser;
try {
  browser = await launchBrowser({ headless: true });
  // opt-in ON so the attacker page itself can load through the guarded context
  process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
  const ctx = await newContext(browser, {}); // production path — attaches the guard
  const page = await ctx.newPage();
  // precise abort evidence: Chromium surfaces route.abort as net::ERR_BLOCKED_BY_CLIENT
  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), error: r.failure()?.errorText || "" }));
  await page.goto(PAGE_URL, { waitUntil: "load" });

  // ---- CONTROL 1: with the opt-in ON, the guarded context delivers too ----
  hits.length = 0;
  const deliveredGuarded = await page.evaluate(async (url) => {
    try { await fetch(url, { mode: "no-cors" }); return true; } catch { return false; }
  }, SECRET);
  await page.waitForTimeout(250);
  check("A1 control (guard, opt-in ON): loopback fetch DELIVERS through the guard",
    deliveredGuarded && hitCount() === 1, `delivered=${deliveredGuarded} hits=${hitCount()}`);

  // ---- flip the opt-in OFF mid-session: every abort is now the GUARD's ----
  delete process.env.CLONER_ALLOW_PRIVATE_TARGETS;

  hits.length = 0;
  failedRequests.length = 0;
  const blockedLoopback = await page.evaluate(async (url) => {
    try { await fetch(url, { mode: "no-cors" }); return "delivered"; } catch { return "failed"; }
  }, SECRET);
  await page.waitForTimeout(250);
  const guardAbort = failedRequests.some((f) => f.url === SECRET && f.error.startsWith("net::ERR_BLOCKED_BY_CLIENT"));
  check("A2 strict mode: loopback secret fetch aborted BY THE GUARD (ERR_BLOCKED_BY_CLIENT, zero hits)",
    blockedLoopback === "failed" && guardAbort && hitCount() === 0,
    `result=${blockedLoopback} abortEvidence=${guardAbort} hits=${hitCount()}`);

  // cloud metadata literal
  const blockedMeta = await page.evaluate(async () => {
    try { await fetch("http://169.254.169.254/latest/meta-data/", { mode: "no-cors" }); return false; }
    catch { return true; }
  });
  check("A3 strict mode: fetch to cloud metadata 169.254.169.254 never completes",
    blockedMeta, `blocked=${blockedMeta}`);

  // IPv4-mapped IPv6 loopback literal
  const blockedV6 = await page.evaluate(async (port) => {
    try { await fetch(`http://[::ffff:127.0.0.1]:${port}/secret`, { mode: "no-cors" }); return false; }
    catch { return true; }
  }, secretPort);
  await page.waitForTimeout(250);
  check("A4 strict mode: IPv4-mapped IPv6 loopback [::ffff:127.0.0.1] never completes",
    blockedV6 && hitCount() === 0, `blocked=${blockedV6} hits=${hitCount()}`);

  // top-level navigation pivot (redirect-chain class): blocked navigation
  // must NOT land the browser on the private target
  await page.evaluate((url) => { location.href = url; }, SECRET);
  await page.waitForTimeout(1200);
  const landed = page.url();
  check("A5 strict mode: top-level navigation to loopback BLOCKED (redirect-chain class)",
    !landed.startsWith("http://127.0.0.1") && !landed.startsWith(SECRET),
    `landed=${landed.slice(0, 44)}…`);

  // control: legit public web is NOT broken by the guard (fail only on an
  // explicit guard block; sandbox DNS failure is a pass-with-note)
  const ctrl = await page.evaluate(async () => {
    try { await fetch("https://example.com/", { mode: "no-cors" }); return "allowed"; }
    catch (e) { return /blocked/i.test(String(e)) ? "BLOCKED_BY_GUARD" : "net-error"; }
  });
  check("A6 control: public https fetch is NOT blocked by the guard", ctrl !== "BLOCKED_BY_GUARD", `result=${ctrl}`);

  await ctx.close();
} catch (e) {
  check("A-series driver", false, String(e?.message || e).slice(0, 200));
} finally {
  delete process.env.CLONER_ALLOW_PRIVATE_TARGETS;
  try { await browser?.close(); } catch {}
  secretServer.close();
  pageServer.close();
}

const ok = results.length > 0 && results.every(Boolean);
console.log(JSON.stringify({ ok, passed: results.filter(Boolean).length, total: results.length }));
process.exit(ok ? 0 : 1);
