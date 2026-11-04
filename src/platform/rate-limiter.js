// Token-bucket rate limiter (task 4.0.6): per-API-key, per-minute + per-hour.
//   • Redis-backed storage when REDIS_URL (or CLONER_REDIS_URL) is set AND
//     reachable — INCR + EXPIRE are atomic, so limits hold across processes.
//   • Safe in-memory fallback (Map of windows) for development / no-Redis.
// Responses carry standard headers: X-RateLimit-Limit / -Remaining / -Reset, and
// rejections are 429 JSON with Retry-After. Key material never reaches this
// module — callers pass a stable, non-secret limiter id (the key's UUID).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const DEFAULTS = {
  perMinute: parseInt(process.env.API_RATE_LIMIT_PER_MINUTE || "60", 10),
  perHour: parseInt(process.env.API_RATE_LIMIT_PER_HOUR || "600", 10),
};

let redis = null;          // ioredis client when connected
let redisFailed = false;   // sticky — a failed Redis probe falls back to memory for the process lifetime
const memoryBuckets = new Map(); // `${id}:${window}` -> count (swept periodically)
const MAX_MEMORY_KEYS = 10_000;

function redisUrl() {
  return process.env.CLONER_REDIS_URL || process.env.REDIS_URL || "";
}

async function connectRedis() {
  if (redis || redisFailed || !redisUrl()) return redis;
  try {
    const IORedis = (await import("ioredis")).default;
    // same resilient posture as clone-queue.js: lazy connect, short timeout,
    // swallow error events (probe failure is the report path)
    redis = new IORedis(redisUrl(), { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on("error", () => {});
    await redis.connect();
    await redis.ping();
  } catch {
    try { redis?.disconnect(); } catch {}
    redis = null;
    redisFailed = true;
  }
  return redis;
}

function sweepMemory(now) {
  if (memoryBuckets.size < MAX_MEMORY_KEYS) return;
  // Bucket key layout: `${id}:${windowMs}:${windowIndex}`. A bucket is stale
  // only once its WINDOW END has passed: (windowIndex + 1) * windowMs <= now.
  // (The previous comparison — windowIndex <= now in ms — was always true, so
  // the sweep wiped ACTIVE buckets too once the map filled: at 10k+ distinct
  // limiter identities every counter reset on every request and the limit was
  // silently bypassed. Found by the G5.2 hunt.)
  for (const key of memoryBuckets.keys()) {
    const parts = key.split(":");
    const windowMs = Number(parts[parts.length - 2]);
    const windowIndex = Number(parts[parts.length - 1]);
    if (Number.isFinite(windowMs) && Number.isFinite(windowIndex) && (windowIndex + 1) * windowMs <= now) {
      memoryBuckets.delete(key);
    }
  }
}

// Fixed-window INCR in memory. `id` is a limiter identity — UUID, never a key.
function memoryHit(id, windowMs, now) {
  const bucketKey = `${id}:${windowMs}:${Math.floor(now / windowMs)}`;
  const count = (memoryBuckets.get(bucketKey) || 0) + 1;
  memoryBuckets.set(bucketKey, count);
  sweepMemory(now);
  return { count, resetAt: (Math.floor(now / windowMs) + 1) * windowMs };
}

// Fixed-window counter in Redis. Atomic window creation: SET NX PX establishes
// the TTL in the SAME command that creates the key, then INCR counts — the
// classic pattern that cannot leak a permanent key if the process dies between
// two commands (INCR-then-EXPIRE could leave an unexpiring bucket → a
// permanent 429 for that identity/window).
async function redisHit(client, id, windowMs, now) {
  const bucketKey = `rl:${id}:${Math.floor(now / windowMs)}`;
  try { await client.set(bucketKey, "0", "PX", windowMs, "NX"); } catch { /* INCR below still works; TTL fixed by the winner */ }
  const count = await client.incr(bucketKey);
  const ttl = await client.pttl(bucketKey);
  return { count, resetAt: now + (ttl > 0 ? ttl : windowMs) };
}

// Consume one request for `id` (an api_keys.id UUID). Returns:
//   { allowed: true,  limit, remaining, resetAt, backend }
//   { allowed: false, limit, remaining: 0, resetAt, retryAfterMs, backend }
export async function checkLimit(id, { perMinute = DEFAULTS.perMinute, perHour = DEFAULTS.perHour } = {}) {
  const now = Date.now();
  const client = await connectRedis();
  const hit = async (windowMs) => {
    if (client) {
      try { return await redisHit(client, id, windowMs, now); } catch { /* falls through */ }
    }
    return memoryHit(id, windowMs, now);
  };
  const minute = await hit(MINUTE);
  const hour = await hit(HOUR);
  const backend = client ? "redis" : "memory";

  const pick = (worse, other) => (worse.count > other.count ? worse : other);
  const limiting = minute.count > perMinute ? { window: "minute", ...minute, limit: perMinute }
    : hour.count > perHour ? { window: "hour", ...hour, limit: perHour }
    : null;

  if (!limiting) {
    const minuteReset = Math.min(minute.resetAt, hour.resetAt);
    return {
      allowed: true,
      backend,
      limit: Math.min(perMinute, perHour),
      remaining: Math.max(0, Math.min(perMinute - minute.count, perHour - hour.count)),
      resetAt: minuteReset,
    };
  }
  return {
    allowed: false,
    backend,
    window: limiting.window,
    limit: limiting.limit,
    remaining: 0,
    resetAt: limiting.resetAt,
    retryAfterMs: Math.max(1000, limiting.resetAt - now),
  };
}

export function rateLimitHeaders(result) {
  const headers = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.allowed) headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
  return headers;
}

export function limiterBackend() {
  return redis && !redisFailed ? "redis" : "memory";
}

export function closeLimiter() {
  try { redis?.disconnect(); } catch {}
  redis = null;
  memoryBuckets.clear();
}
