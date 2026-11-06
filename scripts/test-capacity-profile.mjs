#!/usr/bin/env node
// Capacity-profile tests (realignment: docs/realignment/CAPACITY-1GB.md) —
// src/browser/browser-pool.js resolvePoolProfile / poolDefaults.
//
// 1. Preset resolution, PURE (synthetic env objects, no process.env): the
//    "default" profile reproduces the shipped numbers byte-for-byte, "compact"
//    is the 1 GB budget (2 browsers × 400 MB ceiling, tighter context/idle),
//    an explicit CLONER_POOL_* var always wins over the preset, unknown
//    profile names fail safe to default, and the input env is not mutated.
// 2. One REAL pooled launch driven end to end through the env path
//    (CLONER_PROFILE=compact → poolDefaults() → BrowserPool): 2 pooled
//    chromium trees, 2 contexts parked on about:blank, RSS sampled with the
//    pool's own sampler (CDP process list → OS working sets), one loopback
//    fixture navigation proving 127.0.0.1-only operation.
// 3. Forced recycle through the SAME env path with the ceiling set absurdly
//    low (CLONER_POOL_MEMORY_CEILING_MB=1, explicit env beats the compact
//    preset): a real chromium tree exceeds 1 MB → release({awaitMemory:true})
//    recycles the browser for "memory" and the pool recovers on a fresh tree.
//
// No external websites: chromium only sees about:blank and the 127.0.0.1
// fixture server below. No mocks — the pool talks to real chromium over CDP.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BrowserPool, sampleBrowserRss, poolDefaults, resolvePoolProfile, POOL_PROFILES,
} from "../src/browser/browser-pool.js";

// ---- tiny test harness (same shape as scripts/test-browser-pool.mjs) ---------

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (name) => console.log(`\n— ${name} ${"·".repeat(Math.max(1, 60 - name.length))}`);

// Local-loopback fixture opt-in (same convention as the other browser suites).
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

const watchdog = setTimeout(() => {
  console.log("FAIL  global timeout (240s) — killed");
  process.exit(1);
}, 240_000);
watchdog.unref();

// Every pool env var this run touches is snapshotted and restored at the end.
const ENV_KEYS = [
  "CLONER_PROFILE",
  "CLONER_POOL_MAX_BROWSERS", "CLONER_POOL_RECYCLE_AFTER_NAV",
  "CLONER_POOL_MEMORY_CEILING_MB", "CLONER_POOL_MAX_CONTEXT_USES",
  "CLONER_POOL_MAX_CONTEXTS_PER_BROWSER", "CLONER_POOL_IDLE_TIMEOUT_MS",
  "CLONER_POOL_ACQUIRE_TIMEOUT_MS", "CLONER_POOL_MEMORY_SAMPLE_MS",
  "CLONER_POOL_SWEEP_MS", "CLONER_POOL_HEADED", "MAX_CONCURRENT",
];
const savedEnv = {};
for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
};

// ---- local fixture server (loopback only) --------------------------------------

const server = http.createServer((req, res) => {
  const body = `<!doctype html><html><head><title>fixture ${req.url}</title></head>
<body><h1>${req.url}</h1><p>capacity profile fixture</p></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- A: preset resolution (pure function, synthetic env) -----------------------

section("A  resolvePoolProfile — pure preset resolution");
{
  // shipped defaults, byte-for-byte (pre-profile poolDefaults numbers)
  const d = resolvePoolProfile({ env: {} });
  check("A1  empty env → default profile", d.profile === "default" && d.envOverrides.length === 0, `profile=${d.profile}`);
  check("A2  default maxBrowsers/recycleAfter/ceiling = shipped 2/40/2048",
    d.maxBrowsers === 2 && d.recycleAfter === 40 && d.memoryCeilingMB === 2048,
    `browsers=${d.maxBrowsers} nav=${d.recycleAfter} ceiling=${d.memoryCeilingMB}`);
  check("A3  default contexts/uses/idle = shipped 4/10/120000",
    d.maxContextsPerBrowser === 4 && d.maxContextUses === 10 && d.idleTimeoutMs === 120_000,
    `ctx=${d.maxContextsPerBrowser} uses=${d.maxContextUses} idle=${d.idleTimeoutMs}`);
  check("A4  default acquire/sample/sweep/headless = shipped 30000/3000/15000/headless",
    d.acquireTimeoutMs === 30_000 && d.memorySampleMinIntervalMs === 3_000 && d.sweeperIntervalMs === 15_000 && d.headless === true,
    `acquire=${d.acquireTimeoutMs} sample=${d.memorySampleMinIntervalMs} sweep=${d.sweeperIntervalMs} headless=${d.headless}`);

  const c = resolvePoolProfile({ profile: "compact", env: {} });
  check("A5  compact profile resolved", c.profile === "compact", `profile=${c.profile}`);
  check("A6  compact = 2 browsers × 400 MB ceiling", c.maxBrowsers === 2 && c.memoryCeilingMB === 400, `browsers=${c.maxBrowsers} ceiling=${c.memoryCeilingMB}`);
  check("A7  compact tighter context/idle (2 / 30000)", c.maxContextsPerBrowser === 2 && c.idleTimeoutMs === 30_000, `ctx=${c.maxContextsPerBrowser} idle=${c.idleTimeoutMs}`);
  check("A8  compact keeps nav budget/context uses", c.recycleAfter === 40 && c.maxContextUses === 10, `nav=${c.recycleAfter} uses=${c.maxContextUses}`);

  const ov = resolvePoolProfile({ profile: "compact", env: { CLONER_POOL_MEMORY_CEILING_MB: "900" } });
  check("A9  explicit env wins over compact preset (ceiling 900)", ov.memoryCeilingMB === 900 && ov.envOverrides.includes("CLONER_POOL_MEMORY_CEILING_MB"), `ceiling=${ov.memoryCeilingMB} won=${JSON.stringify(ov.envOverrides)}`);
  check("A10 unset compact knobs keep preset values (contexts still 2)", ov.maxContextsPerBrowser === 2, `ctx=${ov.maxContextsPerBrowser}`);
  const ov2 = resolvePoolProfile({ profile: "compact", env: { CLONER_POOL_MAX_CONTEXTS_PER_BROWSER: "4", CLONER_POOL_IDLE_TIMEOUT_MS: "60000" } });
  check("A11 explicit contexts/idle win too", ov2.maxContextsPerBrowser === 4 && ov2.idleTimeoutMs === 60_000 && ov2.memoryCeilingMB === 400, `ctx=${ov2.maxContextsPerBrowser} idle=${ov2.idleTimeoutMs} ceiling=${ov2.memoryCeilingMB}`);

  const u = resolvePoolProfile({ profile: "turbo", env: {} });
  check("A12 unknown profile name fails safe to default", u.profile === "default" && u.memoryCeilingMB === 2048, `profile=${u.profile} ceiling=${u.memoryCeilingMB}`);

  const mc = resolvePoolProfile({ env: { MAX_CONCURRENT: "7" } });
  check("A13 MAX_CONCURRENT still feeds maxBrowsers (today's fallback)", mc.maxBrowsers === 7 && mc.envOverrides.includes("MAX_CONCURRENT"), `browsers=${mc.maxBrowsers}`);
  const both = resolvePoolProfile({ env: { CLONER_POOL_MAX_BROWSERS: "3", MAX_CONCURRENT: "7" } });
  check("A14 CLONER_POOL_MAX_BROWSERS beats MAX_CONCURRENT (today's precedence)", both.maxBrowsers === 3, `browsers=${both.maxBrowsers}`);

  // purity: no process.env reads, no input mutation, deterministic output
  const decoy = resolvePoolProfile({ env: { CLONER_POOL_MEMORY_CEILING_MB: "8192" } });
  check("A15 synthetic env wins — function never reads process.env", decoy.memoryCeilingMB === 8192, `ceiling=${decoy.memoryCeilingMB}`);
  const input = { profile: "compact", env: { CLONER_POOL_IDLE_TIMEOUT_MS: "45000" } };
  const before = JSON.stringify(input);
  const r1 = resolvePoolProfile(input);
  const r2 = resolvePoolProfile(input);
  check("A16 input env not mutated, repeated calls identical", JSON.stringify(input) === before && JSON.stringify(r1) === JSON.stringify(r2));

  // poolDefaults(): shipped key set, env path, override path
  const keys = Object.keys(poolDefaults()).sort();
  check("A17 poolDefaults() key set unchanged (byte-for-byte shape)",
    JSON.stringify(keys) === JSON.stringify(["acquireTimeoutMs", "headless", "idleTimeoutMs", "launchArgs", "maxBrowsers", "maxContextUses", "maxContextsPerBrowser", "memoryCeilingMB", "memorySampleMinIntervalMs", "recycleAfter", "sweeperIntervalMs"]),
    JSON.stringify(keys));
  process.env.CLONER_PROFILE = "compact";
  const pd = poolDefaults();
  check("A18 poolDefaults() honors CLONER_PROFILE=compact", pd.maxBrowsers === 2 && pd.memoryCeilingMB === 400 && pd.maxContextsPerBrowser === 2 && pd.idleTimeoutMs === 30_000, JSON.stringify({ maxBrowsers: pd.maxBrowsers, ceiling: pd.memoryCeilingMB, ctx: pd.maxContextsPerBrowser, idle: pd.idleTimeoutMs }));
  process.env.CLONER_POOL_MEMORY_CEILING_MB = "1";
  const pdo = poolDefaults();
  check("A19 poolDefaults() explicit ceiling beats compact preset", pdo.memoryCeilingMB === 1, `ceiling=${pdo.memoryCeilingMB}`);
  delete process.env.CLONER_PROFILE;
  delete process.env.CLONER_POOL_MEMORY_CEILING_MB;
}

// ---- B: REAL compact pooled launch (the CAPACITY-1GB measurement) --------------

section("B  real pooled launch, compact profile via env (about:blank ×2)");
{
  process.env.CLONER_PROFILE = "compact"; // env → poolDefaults() → BrowserPool
  const pool = new BrowserPool({ ...poolDefaults(), sweeperIntervalMs: 60_000 });
  check("B1  pool wired from the compact env profile",
    pool.maxBrowsers === 2 && pool.memoryCeilingBytes === 400 * 1024 * 1024 &&
    pool.maxContextsPerBrowser === 2 && pool.idleTimeoutMs === 30_000 && pool.headless === true,
    `browsers=${pool.maxBrowsers} ceilingMB=${pool.memoryCeilingBytes / 1048576} ctx=${pool.maxContextsPerBrowser} idle=${pool.idleTimeoutMs}`);

  const l1 = await pool.acquire({ viewport: { width: 1280, height: 800 } });
  const p1 = await l1.newPage();
  await p1.goto("about:blank");
  const l2 = await pool.acquire({ viewport: { width: 1280, height: 800 } });
  const p2 = await l2.newPage();
  await p2.goto("about:blank");

  const ps = pool.poolSize();
  check("B2  exactly 2 pooled browsers, 2 active leases (100-user queue is served by ≤2 trees)",
    ps.browsers === 2 && ps.activeLeases === 2 && l1.browser !== l2.browser && l1.browser.isConnected() && l2.browser.isConnected(),
    JSON.stringify(ps));

  // the pool's own sampler: CDP process list → OS working-set sum
  const rss1 = await sampleBrowserRss(l1.browser);
  const rss2 = await sampleBrowserRss(l2.browser);
  const mb = (b) => Number(b) / 1048576;
  check("B3  real RSS sampled for both trees via the pool sampler",
    typeof rss1 === "number" && typeof rss2 === "number" && rss1 > 30 * 1048576 && rss2 > 30 * 1048576,
    `browser1=${mb(rss1).toFixed(1)}MB browser2=${mb(rss2).toFixed(1)}MB`);
  check("B4  both trees fit the 400 MB compact ceiling (positive headroom)",
    rss1 < 400 * 1048576 && rss2 < 400 * 1048576,
    `headroom1=${(400 - mb(rss1)).toFixed(1)}MB headroom2=${(400 - mb(rss2)).toFixed(1)}MB`);
  console.log(`capacity measurement: browser1 RSS=${mb(rss1).toFixed(1)} MB (compact ceiling 400 MB, headroom ${(400 - mb(rss1)).toFixed(1)} MB)`);
  console.log(`capacity measurement: browser2 RSS=${mb(rss2).toFixed(1)} MB (compact ceiling 400 MB, headroom ${(400 - mb(rss2)).toFixed(1)} MB)`);
  console.log(`capacity measurement: node process (this run, pool loaded) RSS=${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);

  // loopback-only proof: the same leased page reaches the 127.0.0.1 fixture
  await p1.goto(`${BASE}/capacity`);
  check("B5  leased browser serves the 127.0.0.1 fixture (loopback-only)", (await p1.title()) === "fixture /capacity", `title=${JSON.stringify(await p1.title())}`);

  const rel1 = await l1.release();
  const rel2 = await l2.release();
  check("B6  releases park (no recycle) under the compact ceiling",
    rel1.recycled === false && rel2.recycled === false && pool.stats().recycles.memory === 0, JSON.stringify({ rel1, rel2 }));
  await pool.close();
  check("B7  close() → no leaks", pool.verifyNoLeaks().ok, JSON.stringify(pool.verifyNoLeaks()));
}

// ---- C: forced recycle through the env path (absurdly low ceiling) -------------

section("C  forced recycle with CLONER_POOL_MEMORY_CEILING_MB=1 (env beats preset)");
{
  process.env.CLONER_PROFILE = "compact";
  process.env.CLONER_POOL_MEMORY_CEILING_MB = "1"; // explicit env wins over compact 400
  const pool = new BrowserPool({ ...poolDefaults(), sweeperIntervalMs: 60_000 });
  check("C1  1 MB ceiling reached the pool through the env path", pool.memoryCeilingBytes === 1024 * 1024, `ceilingBytes=${pool.memoryCeilingBytes}`);

  const l1 = await pool.acquire({});
  const p = await l1.newPage();
  await p.goto("about:blank");
  const b1 = l1.browser;
  const rss = await sampleBrowserRss(b1);
  check("C2  real chromium tree is over the 1 MB ceiling", rss != null && rss > 1024 * 1024, `rssBytes=${rss}`);
  const rel = await l1.release({ awaitMemory: true });
  check("C3  release over the ceiling forces recycle (reason=memory)", rel.recycled === true && rel.reason === "memory", JSON.stringify(rel));
  check("C4  the recycle cites the measured RSS", rel.rssBytes > 1024 * 1024, `rssBytes=${rel.rssBytes}`);
  await sleep(150);
  check("C5  recycled browser is actually closed", !b1.isConnected());
  check("C6  recycle recorded as memory-driven", pool.stats().recycles.memory === 1, JSON.stringify(pool.stats().recycles));
  const l2 = await pool.acquire({});
  const p2 = await l2.newPage();
  await p2.goto(`${BASE}/recover`);
  check("C7  pool recovers on a fresh browser", l2.browser.isConnected() && l2.browser !== b1 && pool.stats().browsersCreated === 2 && (await p2.title()) === "fixture /recover", `created=${pool.stats().browsersCreated}`);
  await l2.release();
  await pool.close();
  check("C8  close() → no leaks", pool.verifyNoLeaks().ok);
}

// ---- done ----------------------------------------------------------------------

restoreEnv();
server.close();
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
