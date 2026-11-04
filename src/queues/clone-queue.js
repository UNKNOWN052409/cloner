// Clone-job queue adapter (task 3.3.3): one surface, two backends.
//
//   • "bullmq" — when REDIS_URL (or CLONER_REDIS_URL) is set AND reachable:
//     jobs go to the BullMQ queue "clone-jobs" (data = the queueExploration
//     payload + jobId) and are executed by src/workers/clone-worker.js in any
//     process. Producer-side status flows back via QueueEvents (active /
//     progress / completed / failed) onto the local registry entries.
//
//   • "memory" — the default and the fallback (Redis unset, unreachable, or
//     bullmq/ioredis not installed): the bounded in-process queue extracted
//     verbatim from src/platform/exploration-runner.js (running Set + FIFO
//     queue array + MAX_CONCURRENT cap + 30-min failed-job eviction), so the
//     no-Redis path is behaviorally byte-for-byte the old queue.
//
// Surface (identical on both backends): enqueue(job), status events
// ("status" / onStatus), getEntry/getJob(jobId), listJobs(), rekey(),
// linkJobId(), whenIdle(), close(). enqueue() stays SYNCHRONOUS-returning (the
// entry is created and returned immediately); backend resolution is async but
// buffered — with no Redis URL it resolves synchronously, preserving the old
// "first job starts exploring before queueExploration returns" timing.
import { EventEmitter } from "node:events";

export const QUEUE_NAME = "clone-jobs";

// dead-letter queue (task 4.0.3): jobs that exhaust every attempt land here on
// the bullmq backend (same Redis, own queue) so operators can inspect/replay
// them; the memory backend records the same shape in the in-memory
// `deadLetter` list (see listDeadLetter()).
export const DLQ_NAME = QUEUE_NAME + "-dead";

// total attempts per job (1 initial + 2 retries with exponential backoff)
export const JOB_ATTEMPTS = 3;

const FAILED_JOB_TTL_DEFAULT_MS = 30 * 60 * 1000;

// env is read per-construction (not at module load) so tests can pin it
const defaultMaxConcurrent = () => Number(process.env.MAX_EXPLORATION_JOBS || 2);
const defaultFailedJobTtl = () => Number(process.env.CLONER_FAILED_JOB_TTL_MS || FAILED_JOB_TTL_DEFAULT_MS);
const defaultRetryBackoff = () => Number(process.env.CLONER_RETRY_BACKOFF_MS || 2000);

export function resolveRedisUrl() {
  return process.env.CLONER_REDIS_URL || process.env.REDIS_URL || "";
}

// Transient (infrastructure) failures are worth a retry with backoff; anything
// else fails the job on its first attempt (the worker wraps those in BullMQ's
// UnrecoverableError). Callers can force classification with err.transient.
const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPROTO|socket hang up|network error|temporarily unavailable|rate limit|\b429\b|\b502\b|\b503\b|\b504\b/i;

export function isTransientError(err) {
  if (!err) return false;
  if (err.transient === true) return true;
  if (err.transient === false) return false;
  const msg = String(err.message || err);
  return TRANSIENT_RE.test(msg) || TRANSIENT_RE.test(String(err.code || ""));
}

export function createCloneQueue(opts = {}) {
  return new CloneQueue(opts);
}

// shared singleton used by src/platform/exploration-runner.js (lazy — created
// on first queueExploration so env has settled and no probe runs at import)
let singleton = null;
export function getCloneQueue() {
  if (!singleton) singleton = createCloneQueue();
  return singleton;
}

const nowIso = () => new Date().toISOString();
const noop = () => {};

// G5.3 secret-leak fix: dead-letter copies never carry raw credentials —
// they would sit in Redis for the DLQ retention window. Values are replaced
// with markers; an operator replay re-supplies credentials explicitly.
export function redactCredentials(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  for (const k of ["username", "password", "cookies", "storage"]) {
    if (out[k] === undefined) continue;
    out[k] = k === "username" ? "[redacted-user]" : null;
  }
  out.credentialsRedacted = true;
  return out;
}

// per-process entry sequence — see #createEntry for why tempId needs it
let TEMP_SEQ = 0n;

class CloneQueue extends EventEmitter {
  constructor({
    maxConcurrent = defaultMaxConcurrent(),
    failedJobTtlMs = defaultFailedJobTtl(),
    retryBackoffMs = defaultRetryBackoff(),
    redisUrl = resolveRedisUrl(),
    queueName = QUEUE_NAME,
    deadLetterCapacity = 100,
    bullmqFactory = null,
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.maxConcurrent = maxConcurrent;
    this.failedJobTtlMs = failedJobTtlMs;
    this.retryBackoffMs = retryBackoffMs;
    this.redisUrl = redisUrl;
    this.queueName = queueName;
    // test-only injection hook (task 4.0.3): replaces #connectBullmq with a
    // factory returning { connection, eventsConnection, queue, dlq, events }
    // so tests can drive the REAL bullmq dispatch/QueueEvents code path over a
    // local mock transport (null = the real ioredis+bullmq connection)
    this.bullmqFactory = bullmqFactory;
    this.backend = "memory"; // provisional until the (async) Redis probe settles
    this.entries = new Map(); // key (tempId | jobId) → entry — the registry the API polls
    this.aliases = new Map(); // tempId → jobId (clients poll the temp handle)
    this.deadLetterCapacity = deadLetterCapacity;
    this.deadLetter = []; // memory-backend dead letters (bounded; newest last)
    this.#mem = { running: new Set(), pending: [] };
    this.#idleWaiters = [];
    this.#pendingDispatch = [];
    this.#bull = null;
    // Redis unset → resolves synchronously (no await before the return), so
    // enqueue dispatches inline exactly like the old exploration-runner queue.
    this.#resolving = this.#resolveBackend();
  }

  #mem;
  #idleWaiters;
  #pendingDispatch;
  #bull;
  #resolving;

  get ready() {
    return this.#resolving;
  }

  // ---- enqueue (synchronous entry creation, buffered dispatch) ----

  enqueue({ payload = {}, run = null, jobId = null, owner = null } = {}) {
    // idempotent duplicate-submission guard (plan 4.0.3 step 6): the SAME
    // explicit jobId resubmitted while an entry already exists returns THAT
    // entry — no second entry, no second dispatch, no double execution. Both
    // the memory and the bullmq backend take the guard (bullmq itself ignores
    // same-id adds while the first job is active, but the registry would
    // otherwise grow a second, forever-"queued" entry).
    if (jobId && this.entries.has(jobId)) {
      const existing = this.entries.get(jobId);
      existing.history?.push({ at: nowIso(), event: "duplicate submission ignored (idempotent enqueue)" });
      return existing;
    }
    const entry = this.#createEntry(payload, jobId, owner);
    const dispatch = { payload, run, jobId: entry.jobId || null, entry };
    this.#statusEvent(entry, "queued");
    if (!this.#resolvedFlag) this.#pendingDispatch.push(dispatch);
    else this.#dispatch(dispatch);
    return entry;
  }

  #resolvedFlag = false;

  #createEntry(payload, jobId, owner = null) {
    // entry shape carried over verbatim from exploration-runner.queueExploration.
    // `owner` (4.0.12 quality gate): { userId, orgId } — established by the
    // API layer that accepted the request, so every read surface (task list,
    // task detail, artifacts, export, WS fan-out) can gate on it. null means
    // legacy/anonymous (local dashboard), which keeps the pre-Phase-4 posture.
    // tempId uniqueness: the timestamp alone COLLIDES when two submissions
    // land in the same millisecond (concurrent double-submit storm — found by
    // the G5.2 hunt: 400 same-ms enqueues → 396 collisions, one entry
    // silently overwriting another in the registry). A process-wide sequence
    // plus random suffix makes the handle unique per entry.
    const tempId = "pending-" + Date.now().toString(36) + "-" + (++TEMP_SEQ).toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = {
      tempId,
      jobId: jobId || null,
      url: payload.url,
      // 4.5.5 QA fix companion: remember the payload kind so listJobs() can
      // keep INTERNAL bookkeeping jobs (artifact-lifecycle sweep) out of the
      // user-facing task list — they surfaced as phantom "undefined ·
      // completed" rows in the task list output (GET /api/tasks merges
      // listJobs output).
      kind: payload && payload.kind ? String(payload.kind).slice(0, 32) : null,
      status: "queued",
      queuedAt: nowIso(),
      sessionId: payload.sessionId !== undefined ? payload.sessionId : "local",
      credentialsProvided: !!(payload.username && payload.password),
      hasCookies: !!payload.cookies,
      owner: owner && (owner.userId || owner.orgId) ? { userId: owner.userId || null, orgId: owner.orgId || null } : null,
      history: [],
    };
    this.entries.set(tempId, entry);
    if (jobId) {
      // BullMQ mode decides the id at enqueue time: both handles resolve now
      this.entries.set(jobId, entry);
      this.aliases.set(tempId, jobId);
    }
    return entry;
  }

  #dispatch(d) {
    if (this.backend === "bullmq" && this.#bull) {
      // execution happens in the worker process — the run closure is ignored.
      // The job id is decided HERE (producer side) so the job data can carry it
      // and QueueEvents map back onto the registry entry.
      if (!d.jobId) this.#attachJobId(d);
      // task metadata rides in the job data (plan 4.0.3 step 3: task id, user
      // id, tenant id) — the worker uses meta.taskId to persist progress into
      // task_stages; all optional, absent payloads simply carry undefined
      const meta = {
        taskId: d.payload?.taskId ?? null,
        userId: d.payload?.userId ?? null,
        tenantId: d.payload?.tenantId ?? null,
      };
      this.#bull.queue
        .add("clone", { payload: d.payload, jobId: d.jobId, meta }, {
          jobId: d.jobId,
          attempts: JOB_ATTEMPTS, // exponential backoff; the worker classifies transient errors
          backoff: { type: "exponential", delay: this.retryBackoffMs },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        })
        .catch((e) => this.#fail(d.entry, String(e?.message || e)));
      return;
    }
    this.#memDispatch(d);
  }

  // BullMQ mode names the job at enqueue time (the memory path leaves the id to
  // the exploration pipeline, as it always has). Format mirrors
  // exploration-pipeline.js makeJobId — that generator is unexported; if it is
  // ever exported, delegate to it (one-line integration step for this hook).
  #attachJobId(d) {
    const jobId = "exp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    d.jobId = jobId;
    d.entry.jobId = jobId;
    this.entries.set(jobId, d.entry);
    this.aliases.set(d.entry.tempId, jobId);
  }

  // ---- memory backend: the bounded in-process queue, extracted verbatim ----

  #memDispatch(d) {
    const mem = this.#mem;
    // duplicate-execution guard (plan 4.0.3 steps 6+10): an entry may only be
    // dispatched once while it is still "queued" — a replayed dispatch (or a
    // cancelled entry) can never start a second execution
    if (d.entry.status !== "queued") return;
    const start = () => {
      if (d.entry.status === "cancelled") { this.#memDone(d.entry); return; } // cancelled while queued
      const report = (status, data) => this.#statusEvent(d.entry, status, data);
      let p;
      try {
        // invoked synchronously — a job with a free slot flips to "exploring"
        // before enqueue() returns, exactly like the old launch()
        p = d.run ? d.run({ entry: d.entry, report }) : Promise.resolve(this.#placeholderRun(d.entry));
      } catch (e) {
        this.#fail(d.entry, String(e?.message || e));
        this.#memDone(d.entry);
        return;
      }
      Promise.resolve(p)
        .catch((e) => this.#fail(d.entry, String(e?.message || e)))
        .finally(() => {
          // cancel wins over whatever the run closure set afterwards: a job
          // cancelled mid-run stays "cancelled" instead of flipping back to
          // completed/error when the underlying pipeline finishes
          if (d.entry.cancelRequested) {
            d.entry.status = "cancelled";
            d.entry.finishedAt = d.entry.finishedAt || nowIso();
            delete d.entry.error; // an intentional cancel is not an error
            // an intentional cancel must not sit in the dead-letter list
            const key = d.entry.jobId || d.entry.tempId;
            this.deadLetter = this.deadLetter.filter((x) => x.jobId !== key);
          }
          this.#memDone(d.entry);
        });
    };
    if (mem.running.size < this.maxConcurrent) {
      mem.running.add(d.entry);
      start();
    } else {
      mem.pending.push({ entry: d.entry, start });
    }
  }

  // enqueue without a run closure cannot execute in-process; complete it as a
  // no-op so standalone adapter use stays harmless (the runner always passes run)
  #placeholderRun(entry) {
    entry.status = "completed";
  }

  #memDone(entry) {
    this.#mem.running.delete(entry);
    // drain — same mechanics as exploration-runner.drain(): size-counted, FIFO
    while (this.#mem.running.size < this.maxConcurrent && this.#mem.pending.length) {
      const next = this.#mem.pending.shift();
      this.#mem.running.add(next.entry);
      next.start();
    }
    if (this.#mem.running.size === 0 && this.#mem.pending.length === 0) {
      const waiters = this.#idleWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  // resolves when the memory backend has nothing running and nothing queued
  whenIdle() {
    if (this.backend === "memory" && this.#mem.running.size === 0 && this.#mem.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  // ---- failure handling + 30-min failed-job eviction (short-circuitable for tests) ----

  #fail(entry, error) {
    // a cancelled job must not flip back to "error" if its underlying run
    // later throws (memory path) or reports a failure (QueueEvents path)
    if (entry.status === "cancelled") return;
    entry.status = "error";
    entry.error = String(error).slice(0, 300);
    entry.history?.push({ at: nowIso(), event: "failed: " + entry.error });
    this.#recordDeadLetter(entry, entry.error);
    this.#statusEvent(entry, "error", { error: entry.error });
    this.#scheduleEviction(entry);
  }

  // dead-letter bookkeeping for the memory backend (bounded, newest last) —
  // the bullmq backend additionally copies the job into the "-dead" Redis
  // queue (see #attachQueueEvents). Both paths feed the same shape:
  // { jobId, url, error, failedAt }
  #recordDeadLetter(entry, error) {
    this.deadLetter.push({
      jobId: entry.jobId || entry.tempId,
      url: entry.url,
      error: String(error).slice(0, 300),
      failedAt: nowIso(),
    });
    while (this.deadLetter.length > this.deadLetterCapacity) this.deadLetter.shift();
  }

  listDeadLetter() {
    return this.deadLetter.slice();
  }

  #scheduleEviction(entry) {
    const ttl = this.failedJobTtlMs;
    if (!(ttl > 0)) return;
    const t = setTimeout(() => {
      // only the temp handle is evicted (matches the old runner): the entry
      // stays reachable under its real jobId if exploration got that far
      if (this.entries.get(entry.tempId) === entry) this.entries.delete(entry.tempId);
    }, ttl);
    t.unref?.();
  }

  // ---- status events ----

  #statusEvent(entry, status, data = null) {
    this.emit("status", { tempId: entry.tempId, jobId: entry.jobId || null, status, entry, data });
  }

  onStatus(cb) {
    this.on("status", cb);
    return () => this.off("status", cb);
  }

  // ---- registry (job-id → entry stays here for status polling) ----

  getEntry(jobId) {
    const resolved = this.aliases.get(jobId) || jobId;
    return this.entries.get(resolved) || null;
  }

  getJob(jobId) {
    return this.getEntry(jobId);
  }

  listJobs() {
    const seen = new Set();
    const out = [];
    for (const e of this.entries.values()) {
      if (seen.has(e)) continue; // same entry keyed under tempId + jobId
      seen.add(e);
      // `owner` is INTERNAL access metadata — never shipped to API clients
      // G5.1 hunt: `id` + `createdAt` mirror the legacy task shape so the
      // unified GET /api/tasks list ([...legacy, ...v2]) is consumable by the
      // task list consumers without per-entry shape branching; jobId /
      // queuedAt stay for the existing API consumers.
      // 4.5.5 QA fix: internal bookkeeping jobs (artifact-lifecycle sweep)
      // are NOT clone tasks — listing them put phantom "undefined ·
      // completed" rows into the task list output. The sweep still runs
      // and reports through its own entry object; it is only unlisted here.
      if (e.kind === "artifact-sweep") continue;
      out.push({ jobId: e.jobId || e.tempId, id: e.jobId || e.tempId, url: e.url, status: e.status, createdAt: e.queuedAt, queuedAt: e.queuedAt, finishedAt: e.finishedAt });
    }
    return out;
  }

  // entry becomes reachable under BOTH handles after exploration names the job
  // (was: aliases.set(tempId, jobId) + jobs.set(jobId, entry) in the old launch)
  linkJobId(tempId, jobId) {
    const entry = this.entries.get(tempId);
    if (!entry) return;
    this.aliases.set(tempId, jobId);
    this.entries.set(jobId, entry);
  }

  // rekeyJob compat: tempId key REPLACED by jobId (used by server-side callers)
  rekey(tempId, jobId) {
    const entry = this.entries.get(tempId);
    if (entry) {
      this.entries.delete(tempId);
      entry.jobId = jobId;
      this.entries.set(jobId, entry);
    }
  }

  // ---- cancellation (plan 4.0.3: task cancellation) ----
  //
  // Contract expected by src/platform/admin-service.js createQueueAdapter:
  // once the queue grows cancel(), the admin adapter delegates to it. Returns
  // true when a non-terminal entry was cancelled, false otherwise.
  //
  //   • memory path: a PENDING job is removed from the FIFO queue and never
  //     executes; a RUNNING job is flagged — the pipeline finishes naturally
  //     (no unsafe browser teardown) but the entry stays "cancelled" and its
  //     late completion/failure events can no longer overwrite that state.
  //   • bullmq path: a WAITING job is removed from the Redis queue (never
  //     executes); an ACTIVE job is flagged the same way — its worker-side
  //     completion event keeps arriving but cannot overwrite "cancelled".
  async cancel(jobId) {
    const entry = this.getEntry(jobId);
    if (!entry) return false;
    if (["completed", "completed_with_limitations", "error", "cancelled"].includes(entry.status)) return false;
    entry.cancelRequested = true;

    if (this.backend === "bullmq" && this.#bull) {
      try {
        const job = await this.#bull.queue.getJob(entry.jobId || jobId);
        if (job) {
          const state = await job.getState().catch(() => null);
          if (state === "waiting" || state === "delayed") await job.remove().catch(() => {});
          // active/completed jobs cannot be force-removed by the producer —
          // the registry flip below is the source of truth for the API
        }
      } catch {}
    } else {
      // pending FIFO entry → drop it so it never starts
      const idx = this.#mem.pending.findIndex((p) => p.entry === entry);
      if (idx >= 0) {
        const [removed] = this.#mem.pending.splice(idx, 1);
        removed.entry.status = "cancelled";
        removed.entry.finishedAt = nowIso();
        removed.entry.history?.push({ at: nowIso(), event: "cancelled before start" });
        this.#statusEvent(removed.entry, "cancelled", { reason: "cancel" });
        this.#memDone(removed.entry); // frees waiters if the queue is now empty
        return true;
      }
    }

    entry.status = "cancelled";
    entry.finishedAt = entry.finishedAt || nowIso();
    entry.history?.push({ at: nowIso(), event: "cancelled" });
    this.#statusEvent(entry, "cancelled", { reason: "cancel" });
    return true;
  }

  // ---- backend resolution (BullMQ probe, buffered replay) ----

  async #resolveBackend() {
    // G5.1 hunt fix: an explicit CLONER_QUEUE_BACKEND=memory forces the
    // in-process queue even with Redis reachable. The platform process executes
    // jobs through the run closure it owns (exploration-runner), so jobs keep
    // working on hosts where no standalone clone-worker process is running —
    // previously a reachable Redis silently switched the backend to bullmq and
    // every job sat in "active" forever (no worker process consuming the
    // queue), reproducing run-3's clone that never reached a terminal state.
    if (String(process.env.CLONER_QUEUE_BACKEND || "").toLowerCase() === "memory") {
      console.log("[clone-queue] backend=memory (forced via CLONER_QUEUE_BACKEND)");
      this.backend = "memory";
      this.#resolvedFlag = true;
      this.#flushPending();
      return "memory";
    }
    if (!this.redisUrl) {
      this.#resolvedFlag = true;
      this.#flushPending();
      return "memory";
    }
    let bull = null;
    try {
      bull = this.bullmqFactory
        ? await this.bullmqFactory(this.redisUrl, this.queueName)
        : await this.#connectBullmq();
    } catch (e) {
      console.warn(`[clone-queue] redis unreachable (${e?.code || e?.message || e}) — falling back to in-process queue`);
    }
    if (bull) {
      this.#bull = bull;
      this.backend = "bullmq";
      this.#attachQueueEvents(bull.events);
      console.log(`[clone-queue] backend=bullmq queue=${this.queueName} (retry ${JOB_ATTEMPTS} attempts, exponential backoff ${this.retryBackoffMs}ms)`);
    } else {
      this.backend = "memory";
      console.log("[clone-queue] backend=memory (in-process bounded queue)");
    }
    this.#resolvedFlag = true;
    this.#flushPending();
    return this.backend;
  }

  async #connectBullmq() {
    let IORedis;
    let bullmq;
    try {
      IORedis = (await import("ioredis")).default;
      bullmq = await import("bullmq");
    } catch {
      console.warn("[clone-queue] bullmq/ioredis not installed — falling back to in-process queue");
      return null;
    }
    const opts = { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: null, retryStrategy: (t) => (t <= 1 ? 100 : null), enableOfflineQueue: false };
    // Queue + QueueEvents each get their OWN connection: QueueEvents drives the
    // connection into subscriber/blocking mode and must not share it.
    // Swallow error events — the connect() rejection below is the report path;
    // without a listener ioredis logs "[ioredis] Unhandled error event".
    const connection = new IORedis(this.redisUrl, opts);
    const eventsConnection = new IORedis(this.redisUrl, opts);
    connection.on("error", () => {});
    eventsConnection.on("error", () => {});
    try {
      await connection.connect();
      await connection.ping(); // reachability probe — short, fail-fast strategy above
      await eventsConnection.connect();
    } catch (e) {
      try { connection.disconnect(); } catch {}
      try { eventsConnection.disconnect(); } catch {}
      throw e;
    }
    const queue = new bullmq.Queue(this.queueName, { connection });
    // dead-letter queue shares the plain (non-blocking) queue connection —
    // Queues never issue blocking commands, so sharing is safe
    const dlq = new bullmq.Queue(DLQ_NAME, { connection });
    const events = new bullmq.QueueEvents(this.queueName, { connection: eventsConnection });
    await (events.waitUntilReady?.() ?? Promise.resolve());
    return { connection, eventsConnection, queue, dlq, events, bullmq };
  }

  // producer-side status sync: worker-side progress lands on the local registry
  #attachQueueEvents(events) {
    events.on("active", ({ jobId }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
      if (entry.status === "cancelled") return; // cancel wins even if the job is picked up later
      entry.status = "exploring";
      entry.startedAt = nowIso();
      this.#statusEvent(entry, "exploring");
    });
    events.on("progress", ({ jobId, data }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
      let d = data;
      if (typeof d === "string") {
        try { d = JSON.parse(d); } catch { return; }
      }
      if (d && typeof d.status === "string") {
        // G5.5 human-journey fix: the worker path never wrote intermediate
        // stage transitions back into the registry entry (only "active" →
        // exploring and the terminal states did) — a human polling
        // GET /api/tasks/:id saw "exploring" frozen for the whole run while
        // the job moved through reconstructing/verifying in the worker
        // process. Mirror the memory path (pipeline-job.js writes entry.status
        // per stage) without ever overriding a terminal/cancel verdict.
        if (!["cancelled", "error", "completed", "completed_with_limitations"].includes(entry.status)) {
          entry.status = d.status;
        }
        entry.history?.push({ at: nowIso(), event: `worker: ${d.status}` });
        this.#statusEvent(entry, d.status, d);
      }
    });
    events.on("completed", ({ jobId, returnvalue }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
      if (entry.status === "cancelled") return; // cancel wins over late completion events
      let result = null;
      try { result = typeof returnvalue === "string" ? JSON.parse(returnvalue) : returnvalue; } catch {}
      if (result && typeof result === "object") {
        entry.artifactsDir = result.artifactsDir ?? entry.artifactsDir;
        entry.manifest = result.manifest ?? entry.manifest;
        entry.reconstruction = result.reconstruction ?? entry.reconstruction;
        entry.verification = result.verification ?? entry.verification;
        entry.status = result.status || (result.passed ? "completed" : "completed_with_limitations");
      } else {
        entry.status = "completed";
      }
      this.#statusEvent(entry, entry.status);
    });
    events.on("failed", async ({ jobId, failedReason }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
      if (entry.status === "cancelled") return; // cancel wins over late failure events
      // BullMQ emits "failed" per attempt — only treat the terminal failure
      // (no attempt left, or job actually reached the failed state, which also
      // covers UnrecoverableError short-circuits) as a registry error
      try {
        const job = await this.#bull.queue.getJob(jobId);
        if (job) {
          const attempts = Number(job.opts?.attempts ?? 1);
          const made = Number(job.attemptsMade ?? 0);
          let state = null;
          try { state = await job.getState(); } catch {}
          if (made < attempts && state !== "failed") return; // another attempt is coming
          // dead-letter (plan 4.0.3): the job exhausted every attempt — copy it
          // into the "-dead" queue (same Redis, own queue) for inspection and
          // replay. Best-effort: a DLQ failure must not mask the registry error.
          // G5.3 secret-leak fix: the DLQ copy strips credentials — the raw
          // password/cookies/storage would otherwise sit in Redis dead-letter
          // storage indefinitely. credentialsRedacted marks the shape; an
          // operator replay re-supplies credentials explicitly.
          const dlqPayload = job.data?.payload ? redactCredentials(job.data.payload) : null;
          await this.#bull.dlq
            .add("clone", {
              jobId,
              payload: dlqPayload,
              meta: job.data?.meta ?? null,
              failedReason: String(failedReason || "unknown error"),
              failedAt: nowIso(),
              attemptsMade: made,
            }, { jobId })
            .catch(() => {});
        }
      } catch {}
      this.#fail(entry, failedReason || "unknown error");
    });
  }

  #flushPending() {
    const list = this.#pendingDispatch.splice(0);
    for (const d of list) this.#dispatch(d);
  }

  async close() {
    if (!this.#bull) return;
    const bull = this.#bull;
    this.#bull = null;
    if (this.backend === "bullmq") this.backend = "memory";
    try { await bull.events.close(); } catch {}
    try { await bull.queue.close(); } catch {}
    try { await bull.dlq?.close(); } catch {}
    try { bull.connection.quit(); } catch {}
    try { bull.eventsConnection.quit(); } catch {}
  }
}
