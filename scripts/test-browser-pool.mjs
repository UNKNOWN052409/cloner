#!/usr/bin/env node
// Browser-pool tests (task 4.2.6) — src/browser/browser-pool.js.
//
// REAL chromium end to end (bundled headless shell via the production launch
// chain), 2-3 browsers at a time, every pool policy driven through an actual
// browser: sequential context reuse, parallel acquires across maxBrowsers,
// recycle after N REAL navigations, the memory ceiling against a REAL OS RSS
// sample (PowerShell CIM working sets of the browser's CDP-listed pids), dirty
// releases, acquire timeout, crash recovery (the browser process is actually
// killed), per-worker pools, withLease, and a no-leak verification after close.
//
// The only simulated side is the remote: a local http fixture server plays the
// origin the leases navigate to (the mandate permits a remote-end simulator in
// tests only — the pool itself talks to real chromium over CDP).
import http from "node:http";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BrowserPool, PoolAcquireTimeoutError, sampleBrowserRss, getBrowserRootPid,
  createWorkerPool, getWorkerPool, closeWorkerPool, workerPoolIds, withLease,
} from "../src/browser/browser-pool.js";

// ---- tiny test harness --------------------------------------------------------

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (name) => console.log(`\n— ${name} ${"·".repeat(Math.max(1, 60 - name.length))}`);

// Local-loopback fixture opt-in (same convention as the other browser suites):
// the request guard aborts 127.0.0.1 navigations unless explicitly allowed.
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

const watchdog = setTimeout(() => {
  console.log("FAIL  global timeout (240s) — killed");
  process.exit(1);
}, 240_000);
watchdog.unref();

// ---- local fixture server (the simulated remote side) --------------------------

const hits = new Map();
const server = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) || 0) + 1);
  const body = req.url === "/shell"
    ? `<!doctype html><html><head><title>shell ${Date.now()}</title></head><body>
       <div id="app"><h1>Shell</h1><p>fixture page for pool tests</p><button id="b">ok</button></div></body></html>`
    : `<!doctype html><html><head><title>fixture ${req.url}</title></head><body><h1>${req.url}</h1><p>pool test fixture</p></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- A: sequential acquire/release reuses browser AND context ------------------

section("A  sequential reuse (1 browser, 6 leases)");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const first = await pool.acquire({ viewport: { width: 1280, height: 800 } });
  const firstCtx = first.context;
  let p = await first.newPage();
  await p.goto(`${BASE}/a`);
  await first.release();

  let ctxIdentityReused = true;
  for (let i = 0; i < 5; i++) {
    const lease = await pool.acquire({ viewport: { width: 1280, height: 800 } });
    if (lease.context !== firstCtx) ctxIdentityReused = false;
    p = await lease.newPage();
    await p.goto(`${BASE}/a`);
    const title = await p.title();
    if (i === 0) check("A1  leased page really navigated (fixture title)", title === "fixture /a", `title=${JSON.stringify(title)}`);
    await lease.release();
  }
  const s = pool.stats();
  check("A2  exactly 1 browser launched across 6 leases", s.browsersCreated === 1, `created=${s.browsersCreated}`);
  check("A3  context reused on 5 of 6 acquires", s.contextsReused === 5 && s.contextsCreated === 1, `reused=${s.contextsReused} created=${s.contextsCreated}`);
  check("A4  reused context is the SAME object (warm state)", ctxIdentityReused);
  check("A5  6 real navigations counted", s.navigations === 6, `navigations=${s.navigations}`);
  const ps = pool.poolSize();
  check("A6  pool state idle after releases", ps.browsers === 1 && ps.idleBrowsers === 1 && ps.activeLeases === 0 && ps.pooledContexts === 1, JSON.stringify(ps));
  await pool.close();
  check("A7  close() → no leaks", pool.verifyNoLeaks().ok, JSON.stringify(pool.verifyNoLeaks()));
}

// ---- B: parallel acquires fan out to 3 real browsers ---------------------------

section("B  parallel acquires (3 browsers) + park/reuse");
{
  const pool = new BrowserPool({ maxBrowsers: 3, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const cfg = { viewport: { width: 1440, height: 900 } };
  const leases = await Promise.all([pool.acquire(cfg), pool.acquire(cfg), pool.acquire(cfg)]);
  const s1 = pool.stats();
  check("B1  3 concurrent acquires → 3 real browsers", s1.browsersCreated === 3, `created=${s1.browsersCreated}`);
  check("B2  3 distinct browser instances handed out", new Set(leases.map((l) => l.browser)).size === 3);
  check("B3  all 3 are connected real browsers", leases.every((l) => l.browser.isConnected()));
  const pages = await Promise.all(leases.map((l) => l.newPage()));
  await Promise.all(pages.map((pg, i) => pg.goto(`${BASE}/${["a", "b", "c"][i]}`)));
  const sizes = pages.map((pg) => pg.viewportSize().width);
  check("B4  leased pages serve real traffic with the config viewport", sizes.every((w) => w === 1440), JSON.stringify(sizes));
  await Promise.all(leases.map((l) => l.release()));

  // everything parked → the next acquire reuses a parked browser, no new launch
  const parked = pool.poolSize();
  check("B7  3 real browsers alive and idle while parked", parked.browsers === 3 && parked.idleBrowsers === 3 && parked.activeLeases === 0, JSON.stringify(parked));
  const before = pool.stats();
  const l4 = await pool.acquire(cfg);
  const s2 = pool.stats();
  check("B5  post-release acquire reuses a parked browser (no new launch)", s2.browsersCreated === before.browsersCreated, `created=${s2.browsersCreated}`);
  check("B6  parked context reused", s2.contextsReused === before.contextsReused + 1, `reused=${s2.contextsReused}`);
  await l4.release();
  await pool.close();
  check("B8  close() → no leaks", pool.verifyNoLeaks().ok);
}

// ---- C: different signature → fresh context, browser still reused --------------

section("C  config signature separation");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const l1 = await pool.acquire({ viewport: { width: 1024, height: 768 } });
  let p = await l1.newPage();
  await p.goto(`${BASE}/a`);
  await l1.release();
  const l2 = await pool.acquire({ viewport: { width: 800, height: 600 } });
  p = await l2.newPage();
  await p.goto(`${BASE}/b`);
  const w = p.viewportSize().width;
  await l2.release();
  const s = pool.stats();
  check("C1  different signature → NEW context", s.contextsCreated === 2 && s.contextsReused === 0, `created=${s.contextsCreated} reused=${s.contextsReused}`);
  check("C2  new context carries its own viewport", w === 800, `width=${w}`);
  check("C3  same browser serves both signatures", s.browsersCreated === 1, `created=${s.browsersCreated}`);
  await pool.close();
}

// ---- D: recycle after N real navigations --------------------------------------

section("D  recycle after N navigations");
{
  const pool = new BrowserPool({ maxBrowsers: 1, recycleAfter: 6, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const l1 = await pool.acquire({});
  const p = await l1.newPage();
  for (let i = 0; i < 6; i++) await p.goto(`${BASE}/a?nav=${i}`);
  check("D1  6 real navigations registered on the lease", l1.navigations === 6, `lease.navigations=${l1.navigations}`);
  const b1 = l1.browser;
  const rel = await l1.release();
  check("D2  release recycles at the navigation budget", rel.recycled === true && rel.reason === "navigation", JSON.stringify(rel));
  const s = pool.stats();
  check("D3  recycle recorded as navigation-driven", s.recycles.navigation === 1 && s.recycles.total === 1, JSON.stringify(s.recycles));
  await sleep(150);
  check("D4  recycled browser is actually closed", !b1.isConnected());
  const l2 = await pool.acquire({});
  check("D5  next acquire launches a FRESH browser", pool.stats().browsersCreated === 2, `created=${pool.stats().browsersCreated}`);
  const p2 = await l2.newPage();
  await p2.goto(`${BASE}/b`);
  check("D6  fresh browser serves traffic", (await p2.title()) === "fixture /b");
  await l2.release();
  await pool.close();
  check("D7  close() → no leaks", pool.verifyNoLeaks().ok);
}

// ---- E: memory ceiling enforced against a REAL RSS sample ----------------------

section("E  memory ceiling (real OS RSS)");
{
  // sanity: the sampler reports a plausible real number for a live chromium
  const probe = new BrowserPool({ maxBrowsers: 1, memoryCeilingMB: 4096, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const lp = await probe.acquire({});
  const pp = await lp.newPage();
  await pp.goto(`${BASE}/a`);
  const rss = await sampleBrowserRss(lp.browser);
  check("E1  real RSS sample of a live chromium is sane",
    typeof rss === "number" && rss > 30 * 1024 * 1024 && rss < 8 * 1024 * 1024 * 1024,
    `rss=${(Number(rss) / 1048576).toFixed(1)}MB`);
  await lp.release();
  await probe.close();

  // ceiling of 1MB: any real chromium exceeds it → forced recycle on release
  const pool = new BrowserPool({ maxBrowsers: 1, memoryCeilingMB: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const l1 = await pool.acquire({});
  const b1 = l1.browser;
  const rel = await l1.release({ awaitMemory: true });
  check("E2  release over the ceiling recycles the browser", rel.recycled === true && rel.reason === "memory", JSON.stringify(rel));
  check("E3  the recycle cites the measured RSS (> ceiling)", rel.rssBytes > 1024 * 1024, `rssBytes=${rel.rssBytes}`);
  await sleep(150);
  check("E4  recycled browser is actually closed", !b1.isConnected());
  check("E5  recycle recorded as memory-driven", pool.stats().recycles.memory === 1, JSON.stringify(pool.stats().recycles));
  const l2 = await pool.acquire({});
  const p2 = await l2.newPage();
  await p2.goto(`${BASE}/a`);
  check("E6  pool recovers with a fresh browser", (await p2.title()) === "fixture /a" && pool.stats().browsersCreated === 2);
  await l2.release();
  await pool.close();
  check("E7  close() → no leaks", pool.verifyNoLeaks().ok);
}

// ---- F: dirty release drops the context (no cross-job state) -------------------

section("F  dirty releases");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const cfg = { viewport: { width: 1280, height: 800 } };
  const l1 = await pool.acquire(cfg);
  const p1 = await l1.newPage();
  await p1.goto(`${BASE}/a`);
  await p1.context().addCookies([{ name: "job", value: "state-should-not-leak", url: BASE }]);
  await l1.release({ dirty: true });
  check("F1  dirty release closes the context", pool.poolSize().pooledContexts === 0, JSON.stringify(pool.poolSize()));
  const s1 = pool.stats();
  const l2 = await pool.acquire(cfg);
  const p2 = await l2.newPage();
  await p2.goto(`${BASE}/a`);
  const cookies = await p2.context().cookies();
  check("F2  fresh context for the next lease — no cookie leak", !cookies.some((c) => c.name === "job"), `cookies=${cookies.map((c) => c.name).join(",") || "(none)"}`);
  const s2 = pool.stats();
  check("F3  new context created (none reused after dirty)", s2.contextsCreated === s1.contextsCreated + 1 && s2.contextsReused === s1.contextsReused && s2.dirtyReleases === 1,
    `created=${s2.contextsCreated} reused=${s2.contextsReused} dirty=${s2.dirtyReleases}`);
  await l2.release();
  await pool.close();
}

// ---- G: acquire timeout when all browsers are busy ------------------------------

section("G  acquire timeout");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const held = await pool.acquire({});
  let timedOut = false, timeoutErr = null;
  try {
    await pool.acquire({}, { acquireTimeoutMs: 300 });
  } catch (e) {
    timedOut = e instanceof PoolAcquireTimeoutError;
    timeoutErr = e;
  }
  check("G1  second acquire times out with PoolAcquireTimeoutError", timedOut, timeoutErr?.message || "no error");
  check("G2  waiter bookkeeping clean after timeout", pool.poolSize().waiters === 0, JSON.stringify(pool.poolSize()));
  await held.release();
  const ok = await pool.acquire({});
  check("G3  acquire succeeds again after the slot frees", ok.browser.isConnected());
  await ok.release();
  await pool.close();
}

// ---- H: crash recovery (real browser process killed) ---------------------------

section("H  crash recovery (browser process killed)");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const l1 = await pool.acquire({});
  const p = await l1.newPage();
  await p.goto(`${BASE}/a`);
  const pid = await getBrowserRootPid(l1.browser);
  check("H1  resolved the browser's real root pid via CDP", Number.isInteger(pid) && pid > 0, `pid=${pid}`);
  if (process.platform === "win32") {
    await new Promise((res) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => res()));
  } else {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  let dead = false;
  for (let i = 0; i < 50 && !dead; i++) {
    dead = !l1.browser.isConnected();
    if (!dead) await sleep(100);
  }
  check("H2  browser really died after the kill", dead);
  const rel = await l1.release();
  check("H3  release of a crashed lease reports crashed", rel.recycled === true && rel.reason === "crashed", JSON.stringify(rel));
  const l2 = await pool.acquire({});
  const p2 = await l2.newPage();
  await p2.goto(`${BASE}/b`);
  check("H4  pool self-heals — fresh browser serves traffic", l2.browser.isConnected() && l2.browser !== l1.browser && (await p2.title()) === "fixture /b");
  await l2.release();
  const s = pool.stats();
  check("H5  crash recorded in recycle stats", s.recycles.crashed === 1 && s.browsersCreated === 2, JSON.stringify({ recycles: s.recycles, created: s.browsersCreated }));
  await pool.close();
  check("H6  close() → no leaks after a crash", pool.verifyNoLeaks().ok);
}

// ---- I: maxContextUses retires a warm context ---------------------------------

section("I  context retirement at maxContextUses");
{
  const pool = new BrowserPool({ maxBrowsers: 1, maxContextUses: 3, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const cfg = { viewport: { width: 1280, height: 800 } };
  let firstCtx = null;
  let reused = 0;
  for (let i = 0; i < 4; i++) {
    const l = await pool.acquire(cfg);
    if (firstCtx && l.context === firstCtx) reused++;
    if (!firstCtx) firstCtx = l.context;
    const p = await l.newPage();
    await p.goto(`${BASE}/a`);
    await l.release();
  }
  const s = pool.stats();
  check("I1  context served exactly 3 leases, then a fresh one", s.contextsCreated === 2 && s.contextsReused === 2, `created=${s.contextsCreated} reused=${s.contextsReused}`);
  check("I2  identical context object handed out while warm", reused === 2, `reuses=${reused}`);
  await pool.close();
}

// ---- J: per-worker pools are isolated -----------------------------------------

section("J  per-worker pools");
{
  const w1 = createWorkerPool("test-worker-1", { maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const w2 = createWorkerPool("test-worker-2", { maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  check("J1  getWorkerPool returns the same instance", getWorkerPool("test-worker-1") === w1 && getWorkerPool("test-worker-2") === w2);
  let dupThrew = false;
  try { createWorkerPool("test-worker-1", {}); } catch { dupThrew = true; }
  check("J2  duplicate createWorkerPool rejected", dupThrew);
  const l1 = await w1.acquire({});
  const b1 = l1.browser;
  const l2 = await w2.acquire({});
  check("J3  two workers each launch their own browser", b1 !== l2.browser && w1.stats().browsersCreated === 1 && w2.stats().browsersCreated === 1);
  await l1.release();
  await closeWorkerPool("test-worker-1");
  await sleep(150);
  check("J4  closeWorkerPool closes worker 1's browsers", !b1.isConnected());
  check("J5  worker 2 untouched", w2.poolSize().browsers === 1 && b1 !== l2.browser && l2.browser.isConnected());
  await l2.release();
  const l2b = await w2.acquire({});
  check("J6  worker 2 keeps serving", l2b.browser.isConnected());
  await l2b.release();
  await closeWorkerPool("test-worker-2");
  check("J7  registry empty after both closed", workerPoolIds().filter((id) => id.startsWith("test-worker")).length === 0, JSON.stringify(workerPoolIds()));
}

// ---- K: withLease helper -------------------------------------------------------

section("K  withLease helper");
{
  const pool = new BrowserPool({ maxBrowsers: 1, sweeperIntervalMs: 60_000, idleTimeoutMs: 0 });
  const out = await withLease(pool, { viewport: { width: 1280, height: 800 } }, async (lease) => {
    const p = await lease.newPage();
    await p.goto(`${BASE}/a`);
    return { title: await p.title(), navs: lease.navigations };
  });
  check("K1  withLease returns the fn result with a real navigation", out.title === "fixture /a" && out.navs === 1, JSON.stringify(out));
  check("K2  lease auto-released", pool.poolSize().activeLeases === 0, JSON.stringify(pool.poolSize()));

  let threw = false;
  try {
    await withLease(pool, { viewport: { width: 1280, height: 800 } }, async () => { throw new Error("boom"); });
  } catch { threw = true; }
  check("K3  fn throw propagates", threw);
  const s = pool.stats();
  check("K4  throwing fn still releases AND marks the context dirty", pool.poolSize().activeLeases === 0 && s.dirtyReleases >= 1, `dirty=${s.dirtyReleases} active=${pool.poolSize().activeLeases}`);
  await pool.close();
  check("K5  close() → no leaks", pool.verifyNoLeaks().ok);
}

// ---- done ----------------------------------------------------------------------

server.close();
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
