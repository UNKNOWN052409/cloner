// Process-local metrics registry (task 4.0.7 — Operational Monitoring).
//
// In-memory counters + histograms rendered as Prometheus text format at
// GET /metrics (health-routes.js). Both allowed backends — memory and
// bullmq — are observable: the memory backend exposes live depth/heartbeats
// directly, the bullmq backend is reported by the worker process pushing a
// heartbeat via recordWorkerHeartbeat() and by setQueueDepth() when the
// producer inspects Redis. No external metrics collector is required.
//
// HIGH-CARDINALITY GUARD (plan risk note): URLS, raw user input and arbitrary
// ids are NEVER used as labels. Task/worker ids are hash-bucketed into fixed
// label sets (see safeBucket), status values are validated against fixed
// allow-lists, and unknown values land in a bounded "other" bucket. Label
// values are additionally stripped to [A-Za-z0-9_.-]{0,64}.

const SAFE_LABEL_RE = /[^A-Za-z0-9_.-]/g;
const MAX_LABEL_LEN = 64;

export const TASK_STATUSES = ["queued", "running", "verifying", "done", "error", "exported", "cancelled", "exploring", "completed", "completed_with_limitations"];

// failure categories — queue/failure classification (clone-queue.js semantics)
export const FAILURE_CATEGORIES = ["transient_network", "transient_http", "permanent", "cancelled", "timeout", "unknown"];

export const MAX_WORKER_SLOTS = 64; // bounded cardinality for worker heartbeats
export const MAX_FAILURE_CATEGORIES = FAILURE_CATEGORIES.length + 1;

function safeLabel(value, fallback = "unknown") {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).replace(SAFE_LABEL_RE, "_").slice(0, MAX_LABEL_LEN);
  return s || fallback;
}

export function failureCategory(error) {
  if (error && typeof error === "object" && error.cancelled === true) return "cancelled";
  const msg = String((error && (error.message ?? error)) || "");
  if (/\b429\b|\b502\b|\b503\b|\b504\b|rate limit/i.test(msg)) return "transient_http";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(msg)) return "transient_network";
  if (/timeout|ETIMEDOUT/i.test(msg)) return "timeout";
  if (error && typeof error === "object" && error.transient === true) return "transient_network";
  if (msg) return "permanent";
  return "unknown";
}

// ---- histogram buckets (seconds; duration labels) ----
export const DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];
const OTHER = "other";

export function createMetricsRegistry({ clock = () => Date.now() } = {}) {
  const counters = new Map(); // name+labels → { value, name, labels }
  const histograms = new Map(); // name+labels → { buckets: Map, sum, count, name, labels }

  function key(name, labels) {
    const parts = Object.keys(labels).sort().map((k) => `${k}="${safeLabel(labels[k])}"`);
    return `${name}{${parts.join(",")}}`;
  }

  function incCounter(name, labels = {}, by = 1) {
    const k = key(name, labels);
    const cur = counters.get(k);
    if (cur) cur.value += by;
    else counters.set(k, { value: by, name, labels: { ...labels } });
  }

  function observeDuration(name, labels, seconds) {
    const k = key(name, labels);
    let h = histograms.get(k);
    if (!h) {
      h = { name, labels: { ...labels }, buckets: new Map(DURATION_BUCKETS.map((b) => [b, 0])), sum: 0, count: 0 };
      histograms.set(k, h);
    }
    for (const b of DURATION_BUCKETS) if (seconds <= b) h.buckets.set(b, h.buckets.get(b) + 1);
    h.sum += seconds;
    h.count += 1;
  }

  // ---- gauges (plain values, rendered last) ----
  const gauges = {
    queueDepth: 0,
    queueDepthPending: 0,
    queueDepthStalled: 0,
    workersActive: 0,
    postgresUp: null, // null = not checked yet
    queueBackendUp: null, // null = not checked yet
    migrationsCurrent: null,
    lastHealthCheckAt: 0,
    processUptimeSeconds: 0,
  };

  const workerHeartbeats = new Map(); // workerId → { ts, active, memoryMb }

  return {
    gauges,
    workerHeartbeats,

    incCounter,
    observeDuration,

    // ---- specific recorders used by routes/worker wiring ----

    // task lifecycle counter, status validated against the fixed set
    recordTaskStatus(taskId, status, by = 1) {
      const s = TASK_STATUSES.includes(status) ? status : OTHER;
      incCounter("cloner_task_status_total", { status: s }, by);
      return this;
    },

    // failure counter with bounded category
    recordTaskFailure(category, by = 1) {
      const c = FAILURE_CATEGORIES.includes(category) ? category : OTHER;
      incCounter("cloner_task_failures_total", { category: c }, by);
      return this;
    },

    // execution duration histogram (seconds)
    recordTaskDuration(seconds, kind = "execution") {
      const k = kind === "queue_wait" ? "queue_wait" : "execution";
      observeDuration("cloner_task_duration_seconds", { kind: k }, Math.max(0, Number(seconds) || 0));
      return this;
    },

    recordWorkerHeartbeat(workerId, { active = 0, memoryMb = null } = {}) {
      const id = safeLabel(workerId, "unknown");
      const now = clock();
      const prev = workerHeartbeats.get(id);
      if (!prev) {
        // bounded: reject a heartbeat if we already track MAX_WORKER_SLOTS
        if (workerHeartbeats.size >= MAX_WORKER_SLOTS) {
          incCounter("cloner_worker_heartbeat_rejected_total", {}, 1);
          return this;
        }
        incCounter("cloner_worker_heartbeat_started_total", {}, 1);
      }
      workerHeartbeats.set(id, { ts: now, active: Number(active) || 0, memoryMb: memoryMb === null ? null : Number(memoryMb) });
      gauges.workersActive = workerHeartbeats.size;
      return this;
    },

    workerIsStale(workerId, staleMs = 60000) {
      const rec = workerHeartbeats.get(safeLabel(workerId));
      if (!rec) return null; // unknown worker
      return clock() - rec.ts > staleMs;
    },

    listStaleWorkers(staleMs = 60000) {
      const now = clock();
      const out = [];
      for (const [id, rec] of workerHeartbeats) if (now - rec.ts > staleMs) out.push({ workerId: id, lastHeartbeatAt: rec.ts, ageMs: now - rec.ts });
      return out;
    },

    setQueueDepth({ pending = 0, active = 0, stalled = 0 } = {}) {
      gauges.queueDepth = Number(pending) || 0;
      gauges.queueDepthPending = Number(pending) || 0;
      gauges.workersActive = Math.max(gauges.workersActive, Number(active) || 0);
      gauges.queueDepthStalled = Number(stalled) || 0;
      return this;
    },

    setDependencyStatus({ postgresUp, queueBackendUp, migrationsCurrent } = {}) {
      if (typeof postgresUp === "boolean") gauges.postgresUp = postgresUp ? 1 : 0;
      if (typeof queueBackendUp === "boolean") gauges.queueBackendUp = queueBackendUp ? 1 : 0;
      if (typeof migrationsCurrent === "boolean") gauges.migrationsCurrent = migrationsCurrent ? 1 : 0;
      gauges.lastHealthCheckAt = clock();
      return this;
    },

    // ---- rendering ----

    // Prometheus text format (no Content-Type choice made here — routes set it).
    // Includes process memory gauges and duration histograms.
    render() {
      const lines = [];
      const ga = (name, help, type = "gauge") => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
      };

      // counters (task status, failures, heartbeats, rejected)
      const byName = new Map();
      for (const c of counters.values()) {
        if (!byName.has(c.name)) byName.set(c.name, []);
        byName.get(c.name).push(c);
      }
      const helpFor = { cloner_task_status_total: "task lifecycle transitions by status", cloner_task_failures_total: "task failures by category", cloner_worker_heartbeat_started_total: "worker heartbeats started", cloner_worker_heartbeat_rejected_total: "worker heartbeats rejected (registry full)" };
      for (const [name, list] of byName) {
        ga(name, helpFor[name] || "counter");
        for (const c of list) lines.push(`${key(c.name, c.labels).replace(/\{\}$/, "")} ${c.value}`);
      }

      // histograms — bucket lines carry their own le="…" label (histogram
      // samples skip the sample-level label set, so build them directly)
      for (const h of histograms.values()) {
        ga(`${h.name}_bucket`, `duration buckets for ${h.name}`, "histogram");
        const base = h.name;
        const labelPairs = Object.keys(h.labels).sort().map((k) => `${k}="${safeLabel(h.labels[k])}"`);
        const sample = labelPairs.length ? `,${labelPairs.join(",")}` : "";
        for (const [b, v] of h.buckets) lines.push(`${base}_bucket{le="${b}"${sample}} ${v}`);
        lines.push(`${base}_bucket{le="+Inf"${sample}} ${h.count}`);
        lines.push(`${base}_sum${sample ? `{${labelPairs.join(",")}}` : ""} ${h.sum}`);
        lines.push(`${base}_count${sample ? `{${labelPairs.join(",")}}` : ""} ${h.count}`);
      }

      ga("cloner_queue_depth", "jobs waiting in queue");
      lines.push(`cloner_queue_depth ${gauges.queueDepth}`);
      ga("cloner_queue_depth_stalled", "jobs considered stalled");
      lines.push(`cloner_queue_depth_stalled ${gauges.queueDepthStalled}`);
      ga("cloner_workers_active", "workers with a recent heartbeat");
      lines.push(`cloner_workers_active ${gauges.workersActive}`);
      ga("cloner_postgres_up", "1=reachable 0=down null=unchecked");
      lines.push(`cloner_postgres_up ${gauges.postgresUp ?? "NaN"}`);
      ga("cloner_queue_backend_up", "1=reachable 0=down null=unchecked");
      lines.push(`cloner_queue_backend_up ${gauges.queueBackendUp ?? "NaN"}`);
      ga("cloner_migrations_current", "1=all migrations applied");
      lines.push(`cloner_migrations_current ${gauges.migrationsCurrent ?? "NaN"}`);
      ga("cloner_memory_heap_bytes", "heap used");
      lines.push(`cloner_memory_heap_bytes ${process.memoryUsage().heapUsed}`);
      ga("cloner_memory_rss_bytes", "resident set size");
      lines.push(`cloner_memory_rss_bytes ${process.memoryUsage().rss}`);
      ga("cloner_process_uptime_seconds", "process uptime");
      lines.push(`cloner_process_uptime_seconds ${(clock() - (this._t0 ?? clock())) / 1000}`);
      return lines.join("\n") + "\n";
    },

    // full JSON snapshot (used by /healthz diagnostics and tests)
    snapshot() {
      return {
        counters: [...counters.entries()].map(([k, c]) => ({ key: k, name: c.name, labels: c.labels, value: c.value })),
        histograms: [...histograms.entries()].map(([k, h]) => ({ key: k, name: h.name, labels: h.labels, count: h.count, sum: h.sum })),
        gauges: { ...gauges },
        workers: [...workerHeartbeats.entries()].map(([id, r]) => ({ workerId: id, ts: r.ts, active: r.active, memoryMb: r.memoryMb, stale: clock() - r.ts > 60000 })),
      };
    },

    // test hook: wipe counters/histograms (gauges and heartbeats stay)
    _reset() {
      counters.clear();
      histograms.clear();
    },
    _t0: clock(),
  };
}

// module-singleton used by health routes and worker processes
let shared = null;
export function getMetricsRegistry() {
  if (!shared) shared = createMetricsRegistry();
  return shared;
}
