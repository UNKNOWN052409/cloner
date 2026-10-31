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

class CloneQueue extends EventEmitter {
  constructor({
    maxConcurrent = defaultMaxConcurrent(),
    failedJobTtlMs = defaultFailedJobTtl(),
    retryBackoffMs = defaultRetryBackoff(),
    redisUrl = resolveRedisUrl(),
    queueName = QUEUE_NAME,
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.maxConcurrent = maxConcurrent;
    this.failedJobTtlMs = failedJobTtlMs;
    this.retryBackoffMs = retryBackoffMs;
    this.redisUrl = redisUrl;
    this.queueName = queueName;
    this.backend = "memory"; // provisional until the (async) Redis probe settles
    this.entries = new Map(); // key (tempId | jobId) → entry — the registry the API polls
    this.aliases = new Map(); // tempId → jobId (clients poll the temp handle)
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

  enqueue({ payload = {}, run = null, jobId = null } = {}) {
    const entry = this.#createEntry(payload, jobId);
    const dispatch = { payload, run, jobId: entry.jobId || null, entry };
    this.#statusEvent(entry, "queued");
    if (!this.#resolvedFlag) this.#pendingDispatch.push(dispatch);
    else this.#dispatch(dispatch);
    return entry;
  }

  #resolvedFlag = false;

  #createEntry(payload, jobId) {
    // entry shape carried over verbatim from exploration-runner.queueExploration
    const tempId = "pending-" + Date.now().toString(36);
    const entry = {
      tempId,
      jobId: jobId || null,
      url: payload.url,
      status: "queued",
      queuedAt: nowIso(),
      sessionId: payload.sessionId !== undefined ? payload.sessionId : "local",
      credentialsProvided: !!(payload.username && payload.password),
      hasCookies: !!payload.cookies,
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
      this.#bull.queue
        .add("clone", { payload: d.payload, jobId: d.jobId }, {
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
    const start = () => {
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
        .finally(() => this.#memDone(d.entry));
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
    entry.status = "error";
    entry.error = String(error).slice(0, 300);
    entry.history?.push({ at: nowIso(), event: "failed: " + entry.error });
    this.#statusEvent(entry, "error", { error: entry.error });
    this.#scheduleEviction(entry);
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
      out.push({ jobId: e.jobId || e.tempId, url: e.url, status: e.status, queuedAt: e.queuedAt, finishedAt: e.finishedAt });
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

  // ---- backend resolution (BullMQ probe, buffered replay) ----

  async #resolveBackend() {
    if (!this.redisUrl) {
      this.#resolvedFlag = true;
      this.#flushPending();
      return "memory";
    }
    let bull = null;
    try {
      bull = await this.#connectBullmq();
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
    const events = new bullmq.QueueEvents(this.queueName, { connection: eventsConnection });
    await (events.waitUntilReady?.() ?? Promise.resolve());
    return { connection, eventsConnection, queue, events, bullmq };
  }

  // producer-side status sync: worker-side progress lands on the local registry
  #attachQueueEvents(events) {
    events.on("active", ({ jobId }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
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
      if (d && typeof d.status === "string") this.#statusEvent(entry, d.status, d);
    });
    events.on("completed", ({ jobId, returnvalue }) => {
      const entry = this.entries.get(jobId);
      if (!entry) return;
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
    try { bull.connection.quit(); } catch {}
    try { bull.eventsConnection.quit(); } catch {}
  }
}
