# The 1 GB compact capacity profile (`CLONER_PROFILE=compact`)

Owner mandate this profile serves: **~100 queued users managed by ≤2 pooled
browsers inside a 1 GB RAM budget, headless.** `CLONER_PROFILE=compact` selects
the preset; preset resolution is the pure exported function
`resolvePoolProfile({ profile, env })` in `src/browser/browser-pool.js:92`
(`POOL_PROFILES` presets at `src/browser/browser-pool.js:62`, consumed by
`poolDefaults()` at `src/browser/browser-pool.js:122`). An explicit
`CLONER_POOL_*` env var (and `MAX_CONCURRENT` for `maxBrowsers`) **always wins
over the preset** — the profile only fills the knobs the operator left unset.
An unknown profile name fails safe to `default`. Validation lives in
`src/config-schema.js:146` (`CLONER_PROFILE` must be `default` | `compact`).

Every number below was measured on this machine (Windows 10.0.26200 x64,
Node v24.19.0, Playwright 1.49.x bundled chromium, repo `D:/project 2/cloner`)
from the real runs shown in this document — chromium saw only `about:blank` and
a 127.0.0.1 fixture; no external websites.

## Presets (default = today's numbers, byte-for-byte)

| knob (env) | `default` (shipped) | `compact` (1 GB budget) |
|---|---|---|
| `CLONER_POOL_MAX_BROWSERS` (`MAX_CONCURRENT` fallback) | 2 | 2 |
| `CLONER_POOL_MEMORY_CEILING_MB` (real OS RSS per browser tree, recycle above) | 2048 | **400** |
| `CLONER_POOL_MAX_CONTEXTS_PER_BROWSER` | 4 | **2** |
| `CLONER_POOL_IDLE_TIMEOUT_MS` | 120000 | **30000** |
| `CLONER_POOL_RECYCLE_AFTER_NAV` | 40 | 40 |
| `CLONER_POOL_MAX_CONTEXT_USES` | 10 | 10 |
| `CLONER_POOL_ACQUIRE_TIMEOUT_MS` | 30000 | 30000 |
| `CLONER_POOL_MEMORY_SAMPLE_MS` | 3000 | 3000 |
| `CLONER_POOL_SWEEP_MS` | 15000 | 15000 |
| headless | yes (`CLONER_POOL_HEADED!=1`) | yes |

## Honest arithmetic vs the 1 GB budget

Measured baselines (exact commands in the run log below):

| component | RSS | how measured |
|---|---|---|
| bare Node runtime | **40.9 MB** | `node -e "console.log(process.memoryUsage().rss)"` |
| Node + playwright module imported | **110.7 MB** | `node --input-type=module -e "await import('playwright'); …"` |
| Node + bullmq module imported (queue overhead, no connection) | **55.1 MB** | same pattern with `import('bullmq')` |
| Node + browser-pool module | **45.6 MB** | `import('./src/browser/browser-pool.js')` |
| full worker-shape process mid-run (pool + playwright loaded + 2 chromium trees live) | **117.3 MB** | printed by `scripts/test-capacity-profile.mjs` during the run below |

Compact worst-case arithmetic, using the **ceiling** (what the pool actually
enforces, not a hope):

```
  Node control plane (worker process, playwright + queue code loaded)   ~120 MB
  2 browser trees × 400 MB ceiling                                   2 × 400 = 800 MB
  BullMQ/queue overhead (module measured; connection buffers small)     ~15 MB
  ─────────────────────────────────────────────────────────────────────────────
  accounted worst case                                                  ~935 MB
  1 GB budget                                                          1024 MB
  headroom at ceiling                                                    ~89 MB
```

At the **measured** about:blank RSS instead of the ceiling the same arithmetic
is `117.3 + 190.2 + 250.9 ≈ 558 MB` — roughly **466 MB of slack** before any
ceiling even fires. The gap between those two lines is exactly what the 400 MB
ceiling is for: real pages grow toward it and get recycled when they cross it.

Honest caveats (read before quoting the 935 MB):

- RSS includes shared pages counted per process; two chromium trees overlap
  more than the sum suggests. The 935 MB is therefore an **upper bound**, not a
  promise of precision.
- PostgreSQL and Redis **server** processes are separate services (own
  containers/processes) and are NOT in this budget; only the Node worker's
  client-side usage is.
- The ceiling is enforced on release and by the sweeper for parked browsers
  (`releaseLease` in `src/browser/browser-pool.js`; sweep `_sweep`). A browser
  that bloats mid-job while actively leased is recycled at its next release —
  there is no mid-job kill. One actively bloating tree can therefore transiently
  exceed 400 MB.
- Per-machine numbers vary (ASLR/fonts/GPU). The guarantee is the **enforced
  ceiling** (`CLONER_POOL_MEMORY_CEILING_MB`), not any measured sample.

## Real measurement — exact command and output

Command:

```bash
node scripts/test-capacity-profile.mjs
```

The pooled launch inside section B drives the real path end to end:
`CLONER_PROFILE=compact` → `poolDefaults()` → `new BrowserPool(...)`, 2 leases,
each a context parked on `about:blank` (2 contexts, 2 trees), RSS sampled with
the pool's own sampler (`sampleBrowserRss`: CDP `SystemInfo.getProcessInfo`
process list → OS working-set sum), then one 127.0.0.1 fixture navigation to
prove loopback-only operation. Measured output from the run:

```
PASS  B2  exactly 2 pooled browsers, 2 active leases (100-user queue is served by ≤2 trees) — {"browsers":2,"idleBrowsers":0,"activeBrowsers":2,"pooledContexts":0,"activeLeases":2,"waiters":0}
PASS  B3  real RSS sampled for both trees via the pool sampler — browser1=190.2MB browser2=250.9MB
PASS  B4  both trees fit the 400 MB compact ceiling (positive headroom) — headroom1=209.8MB headroom2=149.1MB
capacity measurement: browser1 RSS=190.2 MB (compact ceiling 400 MB, headroom 209.8 MB)
capacity measurement: browser2 RSS=250.9 MB (compact ceiling 400 MB, headroom 149.1 MB)
capacity measurement: node process (this run, pool loaded) RSS=117.3 MB
PASS  B5  leased browser serves the 127.0.0.1 fixture (loopback-only) — title="fixture /capacity"
PASS  B6  releases park (no recycle) under the compact ceiling — {"rel1":{"recycled":false,"reason":null},"rel2":{"recycled":false,"reason":null}}
RESULT: PASS  (34/34 checks passed)
```

**Measured ceiling headroom**: idle `about:blank` trees sit at 190.2 / 250.9 MB
against the 400 MB ceiling — **209.8 / 149.1 MB headroom** per tree. For scale,
the real fixture exploration in `docs/realignment/RAM-MEASUREMENT.md` peaked at
~238–250 MB per tree, so real jobs keep ~150 MB of headroom before the ceiling
recycles them; a genuinely heavy SPA can cross 400 MB, and crossing it is a
deliberate recycle-and-relaunch (RAM recovered) rather than a failure.

## Forced-recycle proof (ceiling env set absurdly low)

Section C of the same run sets `CLONER_POOL_MEMORY_CEILING_MB=1` through the
env path (explicit env beating the compact preset, ceiling reaching the pool as
1048576 bytes) and proves a real chromium tree over 1 MB is force-recycled:

```
PASS  C1  1 MB ceiling reached the pool through the env path — ceilingBytes=1048576
PASS  C2  real chromium tree is over the 1 MB ceiling — rssBytes=193286144
PASS  C3  release over the ceiling forces recycle (reason=memory) — {"recycled":true,"reason":"memory","rssBytes":136130560}
PASS  C5  recycled browser is actually closed
PASS  C6  recycle recorded as memory-driven — {"total":1,"navigation":0,"memory":1,"crashed":0,"idle":0,"manual":0}
PASS  C7  pool recovers on a fresh browser — created=2
```

## Queue shape for ~100 users

`MAX_CONCURRENT=2` (compact keeps it) means at most 2 clone jobs execute at
once; the other ~98 sit in BullMQ/Redis as queued jobs — no browser, no RAM per
waiting user. Each running job acquires one lease from the pool; the 3rd
concurrent acquire waits (`CLONER_POOL_ACQUIRE_TIMEOUT_MS`, 30 s) instead of
launching a 3rd tree. Compact's `maxContextsPerBrowser=2` +
`idleTimeoutMs=30000` keeps parked browsers cheap between bursts; the 400 MB
ceiling + `recycleAfter=40` navigations bound how fat a tree can get while it
serves the queue.

## Env tuning reference

| goal | set |
|---|---|
| adopt the 1 GB profile | `CLONER_PROFILE=compact` |
| keep compact but pin one knob | e.g. `CLONER_PROFILE=compact` + `CLONER_POOL_MEMORY_CEILING_MB=350` (explicit env wins) |
| even tighter per-tree cap | `CLONER_POOL_MEMORY_CEILING_MB` (recycle happens earlier; expect more relaunches) |
| fewer parked browsers idle | `CLONER_POOL_IDLE_TIMEOUT_MS` (compact 30 s; lower closes sooner) |
| more parallel jobs per browser | `CLONER_POOL_MAX_CONTEXTS_PER_BROWSER` (compact 2) |
| host with more RAM | leave `CLONER_PROFILE` unset (default profile: 2048 MB ceiling) |
| verify a machine | `node scripts/test-capacity-profile.mjs` (34 checks, exit 1 on failure) |
