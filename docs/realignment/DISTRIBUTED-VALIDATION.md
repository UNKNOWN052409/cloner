# Distributed worker plane — P2 validation (R-P2.2)

**Scope:** validate the distributed/concurrency plane (realignment spec §4.6 R-P2.2). Audit-only —
no product files were modified. Everything below was executed during this session; every claim
carries the command that produced it.

**Validator:** `scripts/test-distributed-plane.mjs` (NEW, this task) — boots the plane in-process on
loopback with the existing modules only: region-registry register → dispatcher over real loopback
HTTP → job-leases acquire/renew/release/steal on stub executors → failover re-route on a fake dead
worker → cost-aware ranking → autoscaler on queue depth.

```
$ node scripts/test-distributed-plane.mjs
...
== distributed plane: 40 PASS / 0 FAIL ==
$ echo $?
0
```

Run three consecutive times on 2026-11-07: **40 PASS / 0 FAIL, exit 0, all three runs** (real-clock
timing + one concurrent PG race inside). Exit code is 1 on any failure.

**Environment observed this session:**

| Service | State | Command |
| --- | --- | --- |
| PostgreSQL 127.0.0.1:5433 | UP; `job_leases` table exists | `node -e "…query to_regclass('public.job_leases')…"` → `{"tbl":"job_leases"}` |
| Redis 127.0.0.1:6379 | UP | `ioredis` connect + `PING` → `PONG` |
| `REDIS_URL`/`CLONER_REDIS_URL` in env | UNSET → clone-queue/failover/leases resolve their documented memory backends by default | `env \| grep -i redis` → empty |

No Redis is required for any validated path (the modules do **not** hard-require it): clone-queue is
forced to memory mode via `CLONER_QUEUE_BACKEND=memory` (`src/queues/clone-queue.js:476-481`),
failover falls back to its memory store (`src/distributed/failover.js:206-222`), and job-leases has
an explicit memory backend (`src/distributed/job-leases.js:204-268`). Redis- and PG-mode contracts
were additionally probed against the live local services (below).

---

## Claim-by-claim results

### 1. job-leases: lease + release + expire — **PASS** (memory backend and live PostgreSQL)

- Memory backend, deterministic injected clock: acquire grants exactly one owner (epoch 1, TTL
  honored); a live lease blocks a second worker (`reason:"held"`, even the owner itself); renew is
  owner-only and extends; after TTL passes with no renew, another worker `steal`s (epoch 1→2);
  non-owner release/renew are rejected; owner release frees the job; a same-owner re-acquire after
  expiry gets a NEW epoch and the old epoch is fenced (`validateOwnership` → `stale-epoch`).
  `src/distributed/job-leases.js:207-254` (memory backend), `:367-374` (fencing).
- **Live PostgreSQL backend** (`backend:"postgres"`, real `job_leases` table on 127.0.0.1:5433 via
  `src/database/client.js` defaults): acquire/blocked/held/release/owner-transfer all verified; a
  **true concurrent race** — two managers `Promise.all`-acquiring the same job — produced exactly ONE
  winner (the `ON CONFLICT … WHERE expires_at <= now()` re-check, `job-leases.js:104-126`); a lease
  acquired with a 300 ms TTL was taken over by another region's worker after 450 ms real time
  (DB `now()` is the clock authority), epoch bump 1→2.

### 2. failover: does it reassign on a dead region? — **PASS**, with one real wiring gap found

Memory store, injected clock, two regions with real storage dirs:

- Heartbeat loss on regionA (silent past `heartbeatTtlMs`) → sweep (`failover.js:552-588`) emits
  `region-down`, re-routes the non-terminal job to regionB (`job-rerouted`, `regionB`), leaves the
  terminal (`completed`) job untouched, replicates the job's artifact set to regionB with sha256
  verification (`replication-replicated`, `verifyReplica → ok:true` on real files), does not ping-pong
  on the next sweep, and observes recovery when the region beats again.
- Re-route handoff runs through `createQueueDispatcher` over a real (memory) clone-queue; the
  re-routed entry **re-executes** when the run closure is re-attached via `resolveRun` returning the
  closure directly.
- **Real gap (confirmed by execution, not just by reading):** the shipped wiring at
  `src/platform/server.js:144-145` passes `resolveRun = (job) => (job?.payload.run ? { run: job.payload.run } : null)`.
  (a) A run closure carried on `job.payload` never survives the assignment-ledger round-trip — the
  controller's store serializes records to JSON (`failover.js:116-127`), so functions are dropped
  (`payload.run present at dispatch=false` in the run output) — audit finding #30 confirmed. (b) Even
  the `{ run: fn }` shape resolveRun returns breaks memory-mode re-execution: `createQueueDispatcher`
  assigns it directly as the adapter's `run` (`failover.js:817`), the memory queue then calls it as a
  function and the re-routed entry lands in **error** status — reproduced exactly:
  `status=error error=d.run is not a function`. In BullMQ mode the closure is ignored, which is why
  this never surfaced before. Re-execution works when `resolveRun` returns the closure itself.
- Redis-mode contract probed against the live local Redis: `createFailoverController({ redisUrl:
  "redis://127.0.0.1:6379" })` → `backend:"redis"`, region registers, heartbeat round-trips with a
  real server-side TTL, state `healthy`.

### 3. cost-aware scheduler: does it rank by cost/SLA? — **PASS**

Oracle-base mode, two regions with hourly rates eu=1 / us=3, 10–16 UTC peak window, injected clock
(`src/distributed/cost-aware-scheduler.js:342-434`):

- Slack job off-peak → `run` on the cheapest region (eu, `reason:"cheapest_region"`).
- Slack job inside the peak window → `defer` to the 16:00 off-peak boundary
  (`reason:"off_peak_deferral"`); `poll(startAt)` releases it and it then `run`s off-peak.
- Urgent job at peak → runs immediately, **never deferred** (`"urgent_region_selected"`).
- Cheap region congested (queue depth 1000 → delay ≫ `urgentMaxDelayMs`) → SLA beats cost: the
  expensive-but-fast region (us) wins.

### 4. autoscaler: does it scale on queue depth? — **PASS** (both metrics seams)

- Decision + apply loop (`src/workers/autoscaler.js:149-202`, `src/workers/scaling-policy.js:121-248`)
  with a stub worker-factory pool (`src/workers/worker-pool-manager.js`): depth 12 on 1 worker (≥ 4
  per worker) → `scale-up` applied, pool 1→3; depth 48 at `maxWorkers:3` → `hold("pool-max")` (hard
  cap, no overprovision); fully idle pool → `scale-down` applied, 3→2.
- **Default REAL metrics source probed against the live Redis** (not covered by the suite file, run
  separately):
  ```
  $ node -e "…createQueueMetricsProvider({poolManager: stub, redisUrl: 'redis://127.0.0.1:6379', queueName: 'clone-jobs'})… metrics()"
  DEFAULT METRICS PROVIDER (real BullMQ on 127.0.0.1:6379):
  {"queueDepth":0,"oldestJobAgeMs":0,"activeJobs":0,"workerCount":1,"workerUtilization":0,"regionalWorkerCount":1}
  EXIT=0
  ```

### 5. Region registry + HTTP dispatcher: register → dispatch → fail over on a dead node — **PASS**

- Two real `http.createServer` region nodes on loopback (`region-registry.js:375-584`), HMAC-token
  auth via `CLONER_REGION_SECRET` (≥16 chars enforced by `contracts.js:282-296`), real `fetch`
  handshake (`contractVersion 4.2.1`) and execution dispatch.
- Killing one node (`close()`) and re-dispatching: the dead node is skipped (connection refused →
  candidate loop continues, `region-registry.js:721-739`) and the job runs on the healthy region.
- Control-plane semantics verified: `acquireWorker`/release slot accounting, `selectRegion` ranked by
  free worker capacity, duplicate registration refused without `replace:true`.

### 6. worker-plane (control + execution): staleness, pruning, embedded dispatch — **PASS**

- Silent worker → `stale` and excluded from routing with reason `stale heartbeat`; heartbeat
  recovers; stale beyond `deregisterAfterMs` → `pruned` (`worker-plane.js:388-417`).
- End-to-end embedded dispatch on the real clone-queue memory adapter: `dispatchJob` → worker's
  executor acquires the job lease → executes → releases → route `completed`, lease gone.
- **Dead-worker failover at the lease level:** the hung worker holds the lease (`owner=ep-a`,
  `active=true`, epoch 1); after TTL expiry the healthy worker steals it (epoch 1→2, `owner=ep-b`);
  the zombie's renew and ownership validation both fail (`not-owner`) — a slow zombie cannot
  double-write.

### 7. Resource scheduler: packing, unfittable, worker-down — **PASS**

Best-fit packing with no overcommit (j1→s-a, j2→s-b at 60/100 MB each); a 200 MB job against a
100 MB fleet is rejected eagerly (`UNFITTABLE`); `markWorkerDown` requeues the running job
(attempts++ ) and the requeued job re-places once capacity frees (`scheduler.js:337-358`, `:561-618`).

---

## Gaps found during validation (evidence-backed)

1. **`server.js` failover `resolveRun` shape breaks memory-mode re-execution** — `server.js:144-145`
   returns `{ run: fn }`; `createQueueDispatcher` (`failover.js:817`) needs the closure itself. The
   re-routed queue entry errors (`d.run is not a function`). One-line fix (out of this task's
   ownership): return the closure, or unwrap `{run}` inside `createQueueDispatcher`.
2. **`job.payload.run` cannot survive the failover ledger** (JSON store, `failover.js:116-127`) —
   re-execution must come from a `resolveRun` registry keyed by jobId, not from the payload.
   Confirms realignment audit finding #30.
3. **`registerRegion({replace:true})` resets `capabilities`/`weight` when omitted**
   (`region-registry.js:120-137`) — a re-registration that only updates the endpoint silently wipes
   the advertised capabilities (observed: dispatcher then rejects every job with
   `no region can satisfy required capabilities`). Sharp edge for operators; pass full descriptors.
4. **worker-plane tie-break is "newest beat wins"** (`worker-plane.js:449-456`) before the
   deterministic workerId rule — two registrations in different milliseconds route to the newer one,
   which is fine in production but makes tie-sensitive tests nondeterministic unless the clock is
   pinned. Behavior, not a bug.

## Productionization verdict

**The distributed plane is a hybrid: two of its modules are genuinely product-wired, the rest are
built and proven but test-only.** `region-registry` (mounted at `/api/regions`,
`server.js:41,184`) and the failover controller (started at boot with the real queue dispatcher,
`server.js:143-147`, admin routes at `/api/distributed`, `server.js:202`) run inside the platform
server today; `job-leases`, `worker-plane`/`ExecutionPlane`, `ResourceScheduler`,
`cost-aware-scheduler`, `autoscaler`, `worker-pool-manager` and `scaling-policy` are imported by
nothing in `src/` outside their own directories (grep-verified) — they execute only in test scripts,
including the new `scripts/test-distributed-plane.mjs`, which proves all of them work end-to-end
against live PostgreSQL and Redis with zero mocks in product code. Exact gaps to productionize:
(1) wire lease guarding into real execution — `clone-worker`/`pipeline-job` must wrap each job as
`acquire → renew(ttl/3) → release` and fence artifact writes with `validateOwnership` (the integration
seam documented at `job-leases.js:46-48`); today duplicate-execution protection is BullMQ's own lock
only; (2) fix the `server.js:144-145` `resolveRun` shape so memory-mode failover re-executes instead
of erroring, and stop carrying run closures in `job.payload` (they cannot survive the ledger);
(3) add a product entrypoint that constructs `WorkerPlane`+`ExecutionPlane` (or the region
dispatcher) and routes clone submissions through it — right now no product path calls
`dispatchJob`/`createRegionDispatcher`; (4) decide the Redis requirement per deployment: everything
validated here runs memory-first, but cross-process leases/queues need Redis (BullMQ) or the PG lease
backend plus per-region queue consumers — neither is booted by any entrypoint today; (5) the
autoscaler's default metrics path needs `REDIS_URL` plus a real pool manager fed by
`worker-pool-manager` — also unwired; (6) minor operator sharp edges: `registerRegion(replace)`
resets omitted capabilities, and `CLONER_REGION_SECRET` is mandatory for any cross-region HTTP call
(`contracts.js:282-296`). Until (1)–(3) land, the plane's correctness claims hold for its modules,
not yet for the product's execution path.
