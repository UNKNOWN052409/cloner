# Browser RAM measurement — pool vs per-job browser (realignment integration)

Measured on this machine (Windows 10.0.26200 x64, Node v24.19.0, Playwright chromium,
repo `D:/project 2/cloner`) during the pipeline integration. Every number below was
captured from a real run of the existing fixture exploration
(`scripts/test-exploration-efficiency.mjs` — 5-document nav fixture + 4 redundant
query-variant links on a 127.0.0.1 fixture server; no external websites).

## What is measured and how

Peak **real browser process-tree RSS** per exploration job, sampled with
`sampleBrowserRss()` from `src/browser/browser-pool.js` (CDP `SystemInfo.getProcessInfo`
lists the browser's own process PIDs → OS query sums their WorkingSetSize on win32;
the CDP `memory` byte field is used when a build still reports it). The sampler runs
inside `runExplorationJob` after the seed load and after every page capture; the peak
lands in `artifacts/<jobId>/manifest.json` under `browserMemory`.

- `browserRootPid` — root OS PID of the chromium process tree the job ran on
- `poolBrowsersCreated` — browsers the pool had launched at job start
- `poolReusedBrowser` — this job acquired a browser that already existed before it

## Exact commands

```bash
# RUN A — legacy per-job browser (env toggle must keep working)
CLONER_BROWSER_POOL=0 node scripts/test-exploration-efficiency.mjs

# RUN B — pooled browser (default; CLONER_BROWSER_POOL unset = on)
CLONER_POOL_IDLE_TIMEOUT_MS=8000 node scripts/test-exploration-efficiency.mjs
```

(`CLONER_POOL_IDLE_TIMEOUT_MS=8000` only bounds the post-run idle sweep so the CLI
process exits quickly; the pipeline pool's shipped default is 30 s. Sampling stops at
the last page capture, so the idle setting does not affect the measured numbers.)

## Numbers (this machine, 2026-11-05)

| | RUN A — `CLONER_BROWSER_POOL=0` | RUN B — pool ON |
|---|---|---|
| chromium trees launched for 2 jobs | **2** (rootPids 39372, 42756 — one per job) | **1** (rootPid 46548 — both jobs) |
| `eff-baseline` peak browser RSS | 249.0 MB (10 samples) | 246.4 MB (10 samples) |
| `eff-optimized` peak browser RSS | 237.9 MB (6 samples) | 247.8 MB (6 samples) |
| job 2 reuse evidence | `poolReusedBrowser: null` (pool off) | `poolReusedBrowser: true`, `poolBrowsersCreated: 1` |
| test result | all checks PASS | all checks PASS |
| wall time (incl. ~16 RSS samples) | 44.5 s | 47.0 s |

Reuse proof from RUN B's job logs (`artifacts/eff-optimized/logs/job.log`):

```
pool launched a NEW browser for this job  (browsersCreated=1, rootPid=46548)   [eff-baseline]
pool REUSE confirmed: job acquired a pre-existing pooled browser
  (browsersCreated=1, rootPid=46548)                                           [eff-optimized]
```

Same root PID across both jobs = one chromium process tree served the whole run.

## Interpretation

- **Per-job peak RSS is essentially equal (~238–249 MB)** in both modes — expected:
  only one browser is alive at a time in this 2-job serial test, so the peak is one
  browser either way.
- **The RAM win scales with job count N**: per-job mode launches and tears down N full
  chromium trees (N × ~245 MB of churn plus N cold launches and page caches); pool mode
  runs all N jobs on 1 recycled-on-budget tree (recycle after 40 navigations or the
  2048 MB ceiling, `browser-pool.js` defaults). For the 2-job fixture here: 2 trees → 1.
- Warm reuse also removes the per-job browser startup from the job's critical path
  (RUN B job 2 acquired its lease ~0.4 s into the job, vs job 1 which launched the
  browser).

## Env switches (pipeline integration)

| var | default | effect |
|---|---|---|
| `CLONER_BROWSER_POOL` | on | `0` forces the legacy launch-per-job + close path |
| `CLONER_BROWSER_RSS_SAMPLE` | on | `0` disables the RSS sampler (each win32 sample costs ~1 s of OS query) |
| `CLONER_POOL_IDLE_TIMEOUT_MS` | 30 s (pipeline pool) | parked browser recycled after this idle; kept at 30 s because a parked browser holds the node event loop (one-shot CLI runs would otherwise linger 120 s = the module default) |
| `CLONER_POOL_MAX_BROWSERS`, `CLONER_POOL_RECYCLE_AFTER_NAV`, `CLONER_POOL_MEMORY_CEILING_MB` | 2 / 40 / 2048 MB | pool caps, unchanged |
