# Performance audit — job exp-mw60jhf5pwjh (authed Tradovate, v2 pipeline)

Date: 2026-11-07 · Auditor: performance auditor (workflow subagent) · HEADLESS evidence only

**Sources (all read in this session):**
- `artifacts/exp-mw60jhf5pwjh/logs/job.log` (61 NDJSON lines) + `manifest.json` + `_reference/verification.json` + `states/index.json`
- Prior run A: `artifacts/exp-mw5bzqgnzsni/logs/job.log` (127 lines) + `manifest.json` — PUBLIC site, 17 pages
- Prior run B: `artifacts/exp-mw5gb24neicl/logs/job.log` (57 lines) + `manifest.json` — AUTHED, 1 page (v1 pipeline)

Stage duration method: wall time between consecutive `scope:"stage"` completion timestamps in each
job.log; exploration starts at the `exploration job started` line. Both timestamp deltas and the
logs' self-reported `elapsedMs` fields were cross-checked and agree (e.g. this run verification
line: `elapsedMs = 45567` = 37.5s after reconstruction at 06:22:02 → 06:22:39.580).

---

## 1. Stage table (this run vs both priors)

| Stage | This run (authed v2) | Prior A public (17pg) | Prior B authed v1 | Δ vs A | Δ vs B |
|---|---|---|---|---|---|
| exploration | 161.9s | 173.6s | 151.8s | −11.7s | +10.1s |
| artifact_validation | 1.2s | 1.9s | 1.0s | −0.7s | +0.2s |
| reconstruction | 8.0s | 28.9s | 0.4s | −20.9s | +7.6s |
| verification | 37.5s | 14.8s | 29.5s | +22.7s | +8.0s |
| export | 13.4s | 20.5s | 11.6s | −7.1s | +1.8s |
| **Total (5 stages)** | **222.0s** | **239.7s** | **194.3s** | **−17.7s** | **+27.7s** |

Notes:
- Exploration is not comparable to prior A (17 public pages vs 1 authed page). The like-for-like
  comparison is prior B (same login target, 1 page): +10.1s slower this run.
- Reconstruction vs prior A is apples-to-oranges (17 files vs 6); vs prior B (+7.6s) is like-for-like.
- Verification is slower than BOTH priors even though it only renders 6 pages: +22.7s vs a 17-page
  run, +8.0s vs a 1-page run. This is the anomaly.

## 2. Per-page navigation / cycle numbers (from logs, not estimates)

- Per-page `navigationMs` is **not recorded per page** in any of the three manifests (checked:
  `manifest.json → pages[]` has no `navigationMs` field; per-page value = `None` for all 6 pages
  this run, 17 pages run A). Only run-level aggregate `metrics.navigationMs` exists.
- Run-level `metrics.navigationMs`: this run **268 ms**, run A **73,018 ms** (17 pages ≈ 4.3s/page),
  run B **254 ms**. DOM extraction: 98 ms / 2,614 ms / 46 ms. Screenshot: 311 / 1,517 / 55 ms.
- Navigation is NOT the cost center anymore (268 ms). The cost is the interaction-probe loop:
  - This run: 6 × `engine | click failed: Timeout 3000ms` events, first→last span 66.1s,
    mean cycle **13.2s** (min 12.5s, max 13.5s) — i.e. each dead-target probe costs ~13s wall.
  - Prior B: 5 click-fail events, mean cycle 12.9s — same behavior, so this run's +10.1s
    exploration regression vs B is one extra failed cycle (6 vs 5) plus small jitter.

### Exploration decomposition (this run, 161.6s total, from job.log timestamps)

| Segment | Duration | Share |
|---|---|---|
| auth (navigate → session established) | 13.9s | 8.6% |
| auth persist → browser+context ready | 0.4s | 0.2% |
| browser ready → route discovered | 8.3s | 5.1% |
| route → responsive viewport check | 2.5s | 1.5% |
| responsive → last state-depth (interaction probing) | **117.4s** | **72.6%** |
| state-depth → exploration complete (assets+fonts manifest) | 19.2s | 11.9% |

Inside the 117.4s probe segment: 45 states were recorded (states/index.json first→last span only
6.6s, mean gap 0.2s), so most of the segment is click attempts against dead targets — 6 failed
cycles × 13.2s = 79.2s of it (67%) is pure timeout burn, plus per-click settle waits.

## 3. Verification breakdown (this run, 37.5s wall, 3 rounds)

From `_reference/verification.json`:
- Round 1 failed `functional, optimization-completeness, visual`; rounds 2–3 failed `visual` only.
- Per-stage load: functional `loadMs=860`, optimization-completeness `loadMs=141`
  (clone renders in 141ms, budget 8s), visual `loadMs` not recorded.
- Visual stage is what keeps failing: token drift (text 2/10, backgrounds 6/10), exact-HEX
  (colors 7/10 — live `#ffa500`,`#35a24a`,`#616873` vs clone null), dynamic-region gating
  (canvas `svg` missing in clone) → the pipeline burns 2 extra full rounds (~25s) on data-drift
  it can never fix by re-rendering.
- flow-matrix: `flows=[] bugs=[]` — no replayable interaction clusters, so 0 flow time.

## 4. Memory + pool stats (manifest.browserMemory)

| Run | peakRssMB | samples | poolBrowsersCreated | poolReusedBrowser |
|---|---|---|---|---|
| this run | **1,923.8** | 2 | 1 | false |
| A public (17pg) | 4,810.0 | 18 | 1 | false |
| B authed v1 | 1,892.6 | 2 | 1 | false |

- Peak RSS is flat vs prior B (+31 MB / +1.6%) — memory is healthy, the 1-page budget is light.
- Only 2 RSS samples this run and B (18 in A) → sampling is too sparse to catch a spike
  between samples; not a performance bug, but a measurement-coverage gap.
- Pool: 1 browser created, 0 reused in ALL three runs (each job is a fresh pool). Within-run
  reuse across the 6 verification rounds/pages is what matters and is not exposed as a metric.

## 5. TOP bottleneck

**Interaction probing with 3s click timeouts serially burns exploration time** — and **verification
re-runs 3 full rounds on a permanent visual drift** — these two dominate the 222s run:

1. Exploration = 161.9s (73% of total). Inside it: 6 failed click cycles × 13.2s ≈ 79s (49% of
   exploration, 36% of the entire job) is spent proving targets are dead, one at a time.
   Evidence: 6 `click failed` log lines spanning 66.1s (`exp-mw60jhf5pwjh/logs/job.log` events at
   06:20:09→06:21:15), mean cycle 13.2s.
2. Verification = 37.5s (+8.0s vs prior B). 2 of 3 rounds (~25s) re-run purely for visual token/HEX
   drift that is deterministic — it cannot pass on a retry, so the retry is wasted time.

Everything else (navigation 268 ms, render 141 ms, auth 13.9s, asset capture 17.8s) is noise.

## 6. Three concrete, measure-backed speed options

1. **Fail the click target fast + parallelize probes.** A dead click costs 13.2s (3s Playwright
   timeout ×2 for actionability retries + settle waits). Lower the per-click timeout to 1s for
   non-candidate targets and probe 2–3 candidate clicks concurrently on the pooled context.
   Expected: 6 cycles ≈ 79s → ~15–20s, i.e. −55–60s on this run (~25% of total job). Backed by:
   mean cycle 13.2s (log-derived) and the 72.6% interaction-probe share.
2. **Cap visual round retries at 1 when the failure set is unchanged.** Round 2 and round 3 failed
   on the identical `visual` set (verification.json rounds[]). If round N's failed stage set equals
   round N−1's, a deterministic check will fail again — stop after 1 retry instead of 2.
   Expected: 37.5s → ~25s (−12.5s), and the same saving on every future authed job (prior B
   burned the same 3 rounds in 29.5s).
3. **Budget tuning on maxInteractionsPerState / maxInUrlStates.** This run recorded 45 states and
   44 interactions in 6.6s of actual capture — capture is cheap; the surrounding probing is not.
   Cutting `maxInteractionsPerState` from 30 to ~20 (coverage-report shows 44 interactions across
   1 page) and skipping re-probe of hash-navigations already recorded in `states/index.json`
   (45 states on file) removes whole probe cycles. Expected: another −10–15s exploration; keep
   `maxTimePerPageMs=120s` as the hard backstop unchanged.

## 7. What was NOT run / limits

- No new Playwright run was executed for this audit: the ask is a log parse of three existing real
  jobs; all numbers above come from reading those artifacts (commands shown in-session).
- Per-page `navigationMs` is genuinely absent from all three manifests (verified via
  `manifest.json pages[]` field dump) — the per-page navigation table the ask describes can only be
  reported as the run-level `metrics.navigationMs` plus the log-derived click-cycle pacing above.
- Pool reuse: cross-job reuse is false in all three runs by design (fresh pool per job);
  within-run reuse stats are not exported by the pipeline, so they could not be audited.
