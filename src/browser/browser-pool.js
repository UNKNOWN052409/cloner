// Task 4.2.6 — Browser pooling and reuse (per-worker browser lifecycle).
//
// Every clone worker (src/workers/clone-worker.js, MAX_CONCURRENT parallel jobs)
// used to launch a FRESH chromium per exploration and tear it down afterwards
// (src/pipeline/exploration-pipeline.js launches/closes around each run). For a
// queue of jobs that is seconds of startup per job and a fresh process for every
// page — no warm HTTP cache, no connection pool, and unbounded process churn.
// This module gives a worker a bounded, reusable set of REAL chromium browsers:
//
//   • pool per worker — one BrowserPool per worker identity, created through
//     createWorkerPool(workerId) / torn down with closeWorkerPool(workerId).
//     Pools are never shared across workers; each worker's browsers belong to it.
//   • acquire/release — acquireLease(config) hands out a lease wrapping a live
//     browser + context; releaseLease(lease) parks the browser back into the
//     idle set (or recycles it — see below). Browsers are lazily launched (the
//     real launchBrowser fallback chain: bundled chromium → msedge → chrome)
//     and capped at maxBrowsers; acquires beyond that queue (FIFO) and time out.
//   • context reuse — contexts are pooled per config signature (cookies +
//     viewport + storage + extra options). A warm context with the SAME
//     signature is handed out again (cookies/localStorage/service workers stay
//     hot) up to maxContextUses; a dirty context (interaction recording mutated
//     app state, caller-marked) is always closed, never re-handed out.
//   • recycle after N navigations — every main-frame navigation on lease pages
//     is counted (page 'framenavigated'); a browser that crosses recycleAfter
//     navigations is closed on release and a fresh one launches next time.
//     Chrome processes grow with use (renderer bloat, cache, JIT); this bounds it.
//   • memory ceiling — real browser RSS is measured (not estimated): CDP
//     SystemInfo.getProcessInfo lists the browser's actual process PIDs, and the
//     sampler sums their OS RSS (win32: PowerShell Get-CimInstance
//     WorkingSetSize; unix: ps -o rss=). Chromium 156 dropped the memory field
//     from getProcessInfo, so the OS query is the measurement of record here;
//     the CDP `memory` byte field is used when a build still reports it. A
//     browser over memoryCeilingMB is recycled on release and by the sweeper.
//   • leak accounting — every browser/context/page the pool ever creates is
//     tracked; verifyNoLeaks() fails closed if anything survives close().
//
// Product paths call REAL endpoints only (this module talks to locally launched
// chromium over CDP); tests drive it against a local fixture server standing in
// for the remote side. No credentials, no mocks.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, newContext } from "../browser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- tunables (env overridable; plain config, no secrets) -------------------

export const poolDefaults = () => ({
  maxBrowsers: Number(process.env.CLONER_POOL_MAX_BROWSERS || process.env.MAX_CONCURRENT || 2),
  // main-frame navigations a browser may serve before it is closed and replaced
  recycleAfter: Number(process.env.CLONER_POOL_RECYCLE_AFTER_NAV || 40),
  // real OS RSS (MB) a browser process tree may reach before forced recycle
  memoryCeilingMB: Number(process.env.CLONER_POOL_MEMORY_CEILING_MB || 2048),
  // how many leases a warm context can serve before it is retired
  maxContextUses: Number(process.env.CLONER_POOL_MAX_CONTEXT_USES || 10),
  // hard cap of live contexts parked in one browser
  maxContextsPerBrowser: Number(process.env.CLONER_POOL_MAX_CONTEXTS_PER_BROWSER || 4),
  // an idle parked browser is closed after this long
  idleTimeoutMs: Number(process.env.CLONER_POOL_IDLE_TIMEOUT_MS || 120_000),
  // acquire waits at most this long for a free slot
  acquireTimeoutMs: Number(process.env.CLONER_POOL_ACQUIRE_TIMEOUT_MS || 30_000),
  // RSS samples are cached this long (OS query costs ~0.8s on win32)
  memorySampleMinIntervalMs: Number(process.env.CLONER_POOL_MEMORY_SAMPLE_MS || 3_000),
  sweeperIntervalMs: Number(process.env.CLONER_POOL_SWEEP_MS || 15_000),
  headless: process.env.CLONER_POOL_HEADED !== "1",
  // extra args passed straight to chromium.launch (real production launch path)
  launchArgs: ["--disable-blink-features=AutomationControlled"],
});

// ---- real browser RSS measurement -------------------------------------------
// CDP SystemInfo.getProcessInfo on Chromium 156 returns the process tree with
// {type, id(PID), cpuTime} and NO memory field (removed upstream), so the RSS
// comes from the OS. The CDP `memory` bytes field is honored when present so
// older/future builds without OS sampling still enforce the ceiling.

async function cdpProcessList(browser) {
  let cdp = null;
  try {
    cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send("SystemInfo.getProcessInfo");
    return Array.isArray(info?.processInfo) ? info.processInfo : null;
  } catch {
    return null;
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
}

// Root OS pid of a locally launched chromium (the CDP "browser"-type process).
export async function getBrowserRootPid(browser) {
  const list = await cdpProcessList(browser);
  const browserEntry = list?.find((p) => p.type === "browser");
  return browserEntry ? browserEntry.id : null;
}

// Sum real RSS of the given pids. win32 → PowerShell CIM WorkingSetSize (bytes);
// unix → `ps -o rss=` (KB). Returns null when the OS query is unavailable so the
// ceiling check degrades gracefully instead of guessing.
export async function sumRssForPids(pids) {
  if (!pids?.length) return null;
  const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!valid.length) return null;
  try {
    if (process.platform === "win32") {
      const filter = valid.map((p) => `ProcessId=${p}`).join(" OR ");
      const out = await runCmd(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,WorkingSetSize | ConvertTo-Json -Compress`,
        ],
        30_000,
      );
      if (!out || !out.trim() || out.trim() === "null") return null;
      const rows = JSON.parse(out);
      const list = Array.isArray(rows) ? rows : [rows];
      let total = 0, matched = 0;
      for (const r of list) {
        if (r && Number.isFinite(Number(r.WorkingSetSize))) { total += Number(r.WorkingSetSize); matched++; }
      }
      return matched ? total : null;
    }
    // unix (linux/darwin): rss is KB in ps output
    const out = await runCmd("ps", ["-o", "rss=", "-p", valid.join(",")], 15_000);
    if (!out || !out.trim()) return null;
    let total = 0, matched = 0;
    for (const line of out.split(/\r?\n/)) {
      const kb = Number(line.trim());
      if (Number.isFinite(kb) && kb > 0) { total += kb * 1024; matched++; }
    }
    return matched ? total : null;
  } catch {
    return null;
  }
}

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

// Real RSS of one browser's process tree, in bytes (or null if unmeasurable).
export async function sampleBrowserRss(browser) {
  const list = await cdpProcessList(browser);
  if (!list?.length) return null;
  if (list.every((p) => typeof p.memory === "number")) {
    // build that still reports per-process memory (bytes) — no OS call needed
    return list.reduce((s, p) => s + p.memory, 0);
  }
  return sumRssForPids(list.map((p) => p.id));
}

// ---- pool -------------------------------------------------------------------

export class PoolAcquireTimeoutError extends Error {
  constructor(waitedMs) {
    super(`browser pool acquire timed out after ${waitedMs}ms (all browsers busy, maxBrowsers reached)`);
    this.name = "PoolAcquireTimeoutError";
    this.waitedMs = waitedMs;
  }
}

let leaseSeq = 0;

function configSignature(config = {}) {
  const norm = {
    cookies: (config.cookies || []).map((c) => `${c.name}|${c.domain || ""}|${c.path || "/"}|${c.value}`).sort(),
    viewport: config.viewport ? { width: config.viewport.width, height: config.viewport.height } : null,
    storage: config.storage ? JSON.stringify(config.storage) : null,
    extra: config.extra ? JSON.stringify(config.extra) : null,
  };
  return JSON.stringify(norm);
}

export class BrowserPool {
  constructor(opts = {}) {
    const d = poolDefaults();
    this.maxBrowsers = Math.max(1, Number(opts.maxBrowsers ?? d.maxBrowsers));
    this.recycleAfter = Math.max(1, Number(opts.recycleAfter ?? d.recycleAfter));
    this.memoryCeilingBytes = Math.max(1, Number(opts.memoryCeilingMB ?? d.memoryCeilingMB)) * 1024 * 1024;
    this.maxContextUses = Math.max(1, Number(opts.maxContextUses ?? d.maxContextUses));
    this.maxContextsPerBrowser = Math.max(1, Number(opts.maxContextsPerBrowser ?? d.maxContextsPerBrowser));
    this.idleTimeoutMs = Number(opts.idleTimeoutMs ?? d.idleTimeoutMs);
    this.acquireTimeoutMs = Number(opts.acquireTimeoutMs ?? d.acquireTimeoutMs);
    this.memorySampleMinIntervalMs = Number(opts.memorySampleMinIntervalMs ?? d.memorySampleMinIntervalMs);
    this.sweeperIntervalMs = Number(opts.sweeperIntervalMs ?? d.sweeperIntervalMs);
    this.headless = opts.headless ?? d.headless;
    this.launchArgs = opts.launchArgs ?? d.launchArgs;

    this._closed = false;
    this._browsers = [];        // { browser, navigations, contexts:Map, lastRss, lastRssAt, sampled, alive, parkedAt, launching }
    this._waiters = [];         // { resolve, reject, timer }
    this._stats = {
      browsersCreated: 0, contextsCreated: 0, contextsReused: 0, pagesCreated: 0,
      navigations: 0, releases: 0, dirtyReleases: 0, acquireWaits: 0,
      recycles: { total: 0, navigation: 0, memory: 0, crashed: 0, idle: 0, manual: 0 },
      memorySamples: 0, memorySampleFailures: 0,
    };
    this._sweeper = setInterval(() => { this._sweep().catch(() => {}); }, Math.max(1_000, this.sweeperIntervalMs));
    this._sweeper.unref();
  }

  // -- counters ---------------------------------------------------------------

  stats() { return JSON.parse(JSON.stringify(this._stats)); }

  poolSize() {
    const live = this._browsers.filter((b) => b.alive);
    const idle = live.filter((b) => b.activeLeases.size === 0);
    return {
      browsers: live.length,
      idleBrowsers: idle.length,
      activeBrowsers: live.length - idle.length,
      pooledContexts: live.reduce((s, b) => s + b.contexts.size, 0),
      activeLeases: this._activeLeaseCount(),
      waiters: this._waiters.length,
    };
  }

  _activeLeaseCount() {
    let n = 0;
    for (const b of this._browsers) n += b.activeLeases.size;
    return n;
  }

  // Drop records of browsers that died (crash/kill) once nothing is leased on
  // them — keeps accounting honest without hiding live objects.
  _pruneDead() {
    for (let i = this._browsers.length - 1; i >= 0; i--) {
      const b = this._browsers[i];
      if (!b.alive && !b.browser.isConnected() && b.activeLeases.size === 0) {
        this._browsers.splice(i, 1);
      }
    }
  }

  // -- acquire ----------------------------------------------------------------

  // Acquire a lease: { id, browser, context, config, navigations, uses, pages,
  // newPage(opts), release(opts) }. Reuses a warm context when the signature
  // matches, otherwise creates one in a parked or freshly launched browser.
  async acquire(config = {}, { acquireTimeoutMs } = {}) {
    if (this._closed) throw new Error("browser pool is closed");
    this._pruneDead();
    const signature = configSignature(config);

    // 1. warm context with the same signature → straight reuse (same browser)
    for (const rec of this._browsers) {
      if (!rec.alive) continue;
      const ctxRec = rec.contexts.get(signature);
      if (ctxRec && ctxRec.uses < this.maxContextUses) {
        rec.contexts.delete(signature); // leave the pooled set while leased
        ctxRec.uses++;
        this._stats.contextsReused++;
        return this._makeLease(rec, ctxRec, config, signature);
      }
    }

    // 2. a parked browser with room (FIFO: oldest parked first → even reuse)
    let rec = this._browsers.find((b) => b.alive && b.activeLeases.size === 0 && b.contexts.size < this.maxContextsPerBrowser);

    // 3. launch a new browser if under the cap
    if (!rec) {
      const liveCount = this._browsers.filter((b) => b.alive).length;
      if (liveCount < this.maxBrowsers) {
        rec = await this._launch();
      }
    }

    // 4. otherwise wait for a release to hand us a slot (FIFO, bounded)
    if (!rec) {
      this._stats.acquireWaits++;
      rec = await this._waitForSlot(acquireTimeoutMs ?? this.acquireTimeoutMs);
      if (this._closed) throw new Error("browser pool closed while waiting for a browser");
    }

    const ctxRec = await this._newContext(rec, config, signature);
    return this._makeLease(rec, ctxRec, config, signature);
  }

  async _waitForSlot(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._waiters.findIndex((w) => w.reject === reject);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new PoolAcquireTimeoutError(timeoutMs));
      }, Math.max(1, timeoutMs));
      timer.unref();
      this._waiters.push({ resolve, reject, timer });
    });
  }

  async _launch() {
    const browser = await launchBrowser({
      headless: this.headless,
      launch: { args: this.launchArgs },
    });
    const rec = {
      browser, alive: true, navigations: 0, contexts: new Map(),
      activeLeases: new Map(), // leaseId → lease (outstanding; counts toward concurrency)
      lastRss: null, lastRssAt: 0, parkedAt: 0,
      onDisconnected: () => {
        if (!rec.alive) return;
        rec.alive = false;
        this._stats.recycles.total++;
        this._stats.recycles.crashed++;
        // every context inside a dead browser is gone
        rec.contexts.clear();
        rec.activeLeases.clear();
      },
    };
    browser.on("disconnected", rec.onDisconnected);
    this._browsers.push(rec);
    this._stats.browsersCreated++;
    return rec;
  }

  async _newContext(browserRec, config, signature) {
    const ctx = await newContext(browserRec.browser, {
      cookies: config.cookies,
      viewport: config.viewport,
      storage: config.storage,
    });
    const ctxRec = { context: ctx, signature, uses: 1, navigations: 0, config: JSON.parse(JSON.stringify(config)) };
    this._stats.contextsCreated++;
    return ctxRec;
  }

  _makeLease(browserRec, ctxRec, config, signature) {
    const lease = {
      id: `lease-${++leaseSeq}`,
      browser: browserRec.browser,
      context: ctxRec.context,
      config: JSON.parse(JSON.stringify(config)),
      createdAt: Date.now(),
      navigations: 0,       // main-frame navigations on this lease's pages
      contextNavigations: ctxRec.navigations,
      uses: ctxRec.uses,
      released: false,
      pages: new Set(),
      _pool: this,
      _browserRec: browserRec,
      _ctxRec: ctxRec,
      _dirty: false,
    };
    browserRec.activeLeases.set(lease.id, lease);

    lease.newPage = async (pageOpts = {}) => {
      if (lease.released) throw new Error(`lease ${lease.id} already released`);
      const page = await ctxRec.context.newPage(pageOpts);
      this._stats.pagesCreated++;
      const onNav = (frame) => {
        if (frame !== page.mainFrame()) return;
        lease.navigations++;
        ctxRec.navigations++;
        browserRec.navigations++;
        this._stats.navigations++;
      };
      page.on("framenavigated", onNav);
      page.once("close", () => {
        try { page.off("framenavigated", onNav); } catch {}
        lease.pages.delete(page);
      });
      lease.pages.add(page);
      return page;
    };

    lease.markDirty = () => { lease._dirty = true; };

    lease.release = (releaseOpts = {}) => this.releaseLease(lease, releaseOpts);
    return lease;
  }

  // -- release ----------------------------------------------------------------

  // Return a lease. The lease's pages are closed (renderer memory drops; the
  // context stays warm). Recycle decisions, in order:
  //   crashed → memory ceiling → navigation count → park.
  // opts: { dirty = false — never reuse the context (interaction recording etc.),
  //         awaitMemory = false — sample RSS before deciding (deterministic) }
  async releaseLease(lease, { dirty = false, awaitMemory = false } = {}) {
    if (lease.released) return { recycled: false, reason: null };
    lease.released = true;
    this._stats.releases++;
    const isDirty = dirty || lease._dirty;
    if (isDirty) this._stats.dirtyReleases++;

    const rec = lease._browserRec;
    const ctxRec = lease._ctxRec;
    rec.activeLeases.delete(lease.id);

    // close this lease's pages (context stays warm when reusable)
    for (const page of [...lease.pages]) {
      await page.close().catch(() => {});
    }
    lease.pages.clear();

    if (!rec.alive || !rec.browser.isConnected()) {
      // browser died under us — accounting already done by the disconnected hook
      this._pruneDead();
      this._handOffSlot();
      return { recycled: true, reason: "crashed" };
    }

    // memory ceiling — real measurement; await makes the decision deterministic
    if (awaitMemory || Date.now() - rec.lastRssAt > this.memorySampleMinIntervalMs) {
      const rss = await this._sampleMemory(rec, { refresh: true });
      if (rss != null && rss > this.memoryCeilingBytes) {
        await this._recycle(rec, "memory");
        this._handOffSlot();
        return { recycled: true, reason: "memory", rssBytes: rss };
      }
    }

    // navigation budget exhausted → replace the whole browser
    if (rec.navigations >= this.recycleAfter) {
      await this._recycle(rec, "navigation");
      this._handOffSlot();
      return { recycled: true, reason: "navigation", navigations: rec.navigations };
    }

    // park (or drop) the context
    if (isDirty || ctxRec.uses >= this.maxContextUses) {
      rec.contexts.delete(ctxRec.signature);
      await ctxRec.context.close().catch(() => {});
    } else if (!rec.contexts.has(ctxRec.signature)) {
      rec.contexts.set(ctxRec.signature, ctxRec);
      rec.parkedAt = Date.now();
    }
    this._handOffSlot();
    return { recycled: false, reason: null };
  }

  _handOffSlot() {
    // a slot just freed: the oldest waiter gets a parked browser (any live one)
    const waiter = this._waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const rec = this._browsers.find((b) => b.alive && b.activeLeases.size === 0 && b.contexts.size < this.maxContextsPerBrowser)
      || this._browsers.find((b) => b.alive);
    if (!rec) {
      waiter.reject(new Error("browser pool has no live browser to hand off"));
      return;
    }
    waiter.resolve(rec);
  }

  async _sampleMemory(rec, { refresh = false } = {}) {
    const fresh = Date.now() - rec.lastRssAt < this.memorySampleMinIntervalMs;
    if (!refresh && fresh) return rec.lastRss;
    this._stats.memorySamples++;
    const rss = await sampleBrowserRss(rec.browser);
    if (rss == null) {
      this._stats.memorySampleFailures++;
    } else {
      rec.lastRss = rss;
      rec.lastRssAt = Date.now();
    }
    return rss;
  }

  async _recycle(rec, reason) {
    rec.alive = false;
    this._stats.recycles.total++;
    this._stats.recycles[reason] = (this._stats.recycles[reason] || 0) + 1;
    for (const ctxRec of rec.contexts.values()) {
      await ctxRec.context.close().catch(() => {});
    }
    rec.contexts.clear();
    const i = this._browsers.indexOf(rec);
    if (i >= 0) this._browsers.splice(i, 1);
    await rec.browser.close().catch(() => {});
  }

  // -- sweeper ----------------------------------------------------------------

  async _sweep() {
    if (this._closed) return;
    const now = Date.now();
    this._pruneDead();
    for (const rec of [...this._browsers]) {
      if (!rec.alive) continue;
      if (rec.activeLeases.size > 0) continue; // actively leased
      // memory ceiling for idle browsers too (bloat from the last job)
      const rss = await this._sampleMemory(rec, { refresh: true }).catch(() => null);
      if (rss != null && rss > this.memoryCeilingBytes) {
        await this._recycle(rec, "memory").catch(() => {});
        continue;
      }
      if (this.idleTimeoutMs > 0 && now - rec.parkedAt > this.idleTimeoutMs) {
        await this._recycle(rec, "idle").catch(() => {});
      }
    }
  }

  // -- teardown ---------------------------------------------------------------

  // Close everything. Waits (bounded) for active leases, force-closes the rest.
  async close({ waitMs = 10_000 } = {}) {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._sweeper);
    // reject queued waiters
    for (const w of this._waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("browser pool closed while waiting"));
    }
    const deadline = Date.now() + waitMs;
    while (this._activeLeaseCount() > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    for (const rec of [...this._browsers]) {
      for (const ctxRec of rec.contexts.values()) await ctxRec.context.close().catch(() => {});
      rec.contexts.clear();
      rec.alive = false;
      await rec.browser.close().catch(() => {});
    }
    this._browsers.length = 0;
  }

  // Fails closed: every tracked object must be gone after close(). Problems are
  // returned rather than thrown so callers can log the full picture.
  verifyNoLeaks() {
    const problems = [];
    const live = this._browsers.filter((b) => b.alive && b.browser.isConnected());
    if (live.length) problems.push(`${live.length} live browser(s) remain`);
    if (this._browsers.length) problems.push(`${this._browsers.length} browser record(s) not deregistered`);
    let openCtx = 0, openPages = 0;
    for (const b of this._browsers) {
      try {
        openCtx += b.browser.contexts().length;
      } catch {}
      for (const l of b.activeLeases.values()) openPages += l.pages.size;
    }
    if (openCtx) problems.push(`${openCtx} context(s) still open on tracked browsers`);
    if (openPages) problems.push(`${openPages} page(s) still open on tracked leases`);
    if (this._activeLeaseCount()) problems.push(`${this._activeLeaseCount()} lease(s) never released`);
    if (this._waiters.length) problems.push(`${this._waiters.length} acquire waiter(s) still queued`);
    return { ok: problems.length === 0, problems };
  }
}

// ---- per-worker pool registry -------------------------------------------------

const workerPools = new Map();

export function createWorkerPool(workerId, opts = {}) {
  if (workerPools.has(workerId)) {
    throw new Error(`worker pool for "${workerId}" already exists — close it first`);
  }
  const pool = new BrowserPool(opts);
  workerPools.set(workerId, pool);
  return pool;
}

export function getWorkerPool(workerId) {
  return workerPools.get(workerId) || null;
}

export async function closeWorkerPool(workerId) {
  const pool = workerPools.get(workerId);
  if (!pool) return false;
  workerPools.delete(workerId);
  await pool.close();
  return true;
}

export function workerPoolIds() {
  return [...workerPools.keys()];
}

// ---- convenience ---------------------------------------------------------------

// One-shot helper: acquire → fn(lease) → release in finally. dirty marks the
// context non-reusable (set after interaction recording or login flows).
export async function withLease(pool, config, fn, { dirty = false } = {}) {
  const lease = await pool.acquire(config);
  try {
    return await fn(lease);
  } catch (e) {
    lease.markDirty();
    throw e;
  } finally {
    await lease.release({ dirty }).catch(() => {});
  }
}

export default BrowserPool;
