// Vision API reliability tests (task 3.4.6) — MOCK PROVIDER ONLY.
//
// The "provider" is a local http server (127.0.0.1, ephemeral port) that emits
// crafted OpenAI-style SSE (data: {"choices":[{"delta":{"content":...}}]}\n\n,
// ending with "data: [DONE]") — the exact stream shape the reused request path
// (model-router → src/vision.js VisionClient.chat with onDelta → stream:true)
// consumes. The DEFAULT RUN IS FULLY OFFLINE: the only network traffic is to
// this in-process mock; no live kiosapi/vision API is contacted.
//
// What is verified:
//   [1] streamed chunks (incl. one data-line split across two writes) assemble
//       into the exact final text; final JSON parses (partial-chunk assembly).
//   [2] interrupted stream (server destroys the socket mid-stream) is retried
//       and the next attempt succeeds.
//   [3] 429 then success recovers (rate-limit class is retryable).
//   [4] permanent 401 does NOT retry: exactly one request → deterministic
//       fallback; no API key (mock-echoed or client-owned) appears anywhere —
//       result reason, emitted events, or captured console output.
//   [5] request timeout triggers REAL cancellation: the mock observes the
//       socket close at ~the per-attempt deadline for every attempt.
//   [6] retry exhaustion → { ok:false, fallback:true, reason } verdict.
//   [7] strict budget: with no budget room for backoff+request, the retry is
//       never started (outage amplification impossible).
//   [8] SHA1(prompt+imageBytes+model) cache hit avoids the second request;
//       different prompt still requests.
//   [9] concurrency cap: 5 parallel completes, mock observes max 2 in flight.
//  [10] caller AbortSignal: complete() returns promptly, no retry afterwards.
//  [11] units: default policy frozen, error classification table, redact(),
//       input validation, provider "none" → null (deterministic, fetch-free),
//       asVisionFn adoption contract for vision-assist.js.
//
// Optional live smoke (OFF by default): set CLONER_LIVE_VISION_SMOKE=1 to fire
// one real request through the configured provider (kiosapi/glm-5.3-flash-free
// or whatever cloner.config.json holds). Its result is reported honestly — a
// flaky live provider failing does NOT fail the offline suite, but the smoke
// line shows exactly what happened.
import http from "node:http";
import util from "node:util";

import {
  createVisionClient,
  createVisionClientForConfig,
  extractJson,
  DEFAULT_MODEL,
} from "../src/platform/vision-client.js";
import {
  VISION_RETRY_POLICY,
  normalizePolicy,
  classifyError,
  redact,
  RETRYABLE,
  PERMANENT,
  CANCELLED,
} from "../src/platform/vision-retry-policy.js";

let pass = 0, fail = 0, smoke = "skipped (set CLONER_LIVE_VISION_SMOKE=1)";
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- capture ALL console output so we can prove no secret ever leaks ----
const consoleBuf = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ["log", "warn", "error"]) {
  console[k] = (...a) => {
    consoleBuf.push(a.map((x) => util.format(x)).join(" "));
    origConsole[k](...a);
  };
}

// ---- fixtures (constants; never logged, only hashed/sent to the mock) ----
const MODEL = "glm-5.3-flash-free";
const CLIENT_KEY = "sk-livetest-client-key-AA00";          // key the client holds — must never surface
const ECHOED_KEY = "sk-echoedserversecret123456";          // key the mock's 401 body echoes — must never surface
const IMG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const EXPECTED_TEXT = '{"kind":"card-grid","confidence":0.92,"reason":"three repeated tiles"}';
const DELTAS = ['{"kind":"card', '-grid","confid', 'ence":0.92,', '"reason":"three repeated tiles"}'];
const FAST_POLICY = { maxAttempts: 3, backoffMs: [25, 50, 100], budgetMs: 5000 };

// ---- mock provider: local SSE server with per-case behaviours ----
const routes = new Map();
const route = (name) => {
  let r = routes.get(name);
  if (!r) {
    r = { count: 0, active: 0, maxActive: 0, closeGapsMs: [], sawAuth: false };
    routes.set(name, r);
  }
  return r;
};

function sseStream(res, deltas, { splitAt = -1, startDelayMs = 0 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.socket?.setNoDelay(true);
  let i = 0;
  const writeNext = () => {
    if (i >= deltas.length) {
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i] } }] })}\n\n`;
    if (i === splitAt) {
      const half = Math.floor(line.length / 2);
      res.write(line.slice(0, half)); // half a data-line — assembly must bridge the chunk boundary
      setTimeout(() => {
        res.write(line.slice(half));
        i++;
        writeNext();
      }, 10);
    } else {
      res.write(line);
      i++;
      writeNext();
    }
  };
  if (startDelayMs > 0) setTimeout(writeNext, startDelayMs);
  else writeNext();
}

function errorJson(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function stall(res) {
  // headers + one delta, then never finish — the client's deadline must abort
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "{" } }] })}\n\n`);
  const ka = setInterval(() => res.write(": keepalive\n\n"), 250);
  res.on("close", () => clearInterval(ka));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://mock");
  const m = u.pathname.match(/^\/case\/([a-z0-9-]+)\/chat\/completions$/);
  req.resume(); // drain the request body (prompt+image) — never inspected, never logged
  if (!m) {
    errorJson(res, 404, "no such route");
    return;
  }
  const r = route(m[1]);
  r.count++;
  r.active++;
  r.maxActive = Math.max(r.maxActive, r.active);
  const opened = Date.now();
  res.on("close", () => {
    r.active--;
    r.closeGapsMs.push(Date.now() - opened);
  });
  if (String(req.headers.authorization || "").startsWith("Bearer ")) r.sawAuth = true;

  switch (m[1]) {
    case "stream-ok":
      sseStream(res, DELTAS, { splitAt: 2 });
      break;
    case "stream-interrupt":
      if (r.count === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: DELTAS[0] } }] })}\n\n`);
        setTimeout(() => res.socket.destroy(), 15); // interrupted stream: socket torn down mid-response
      } else {
        sseStream(res, DELTAS);
      }
      break;
    case "rate-limit":
      if (r.count === 1) errorJson(res, 429, "rate limited, slow down");
      else sseStream(res, DELTAS);
      break;
    case "auth-fail":
      errorJson(res, 401, `invalid api key ${ECHOED_KEY} for model ${MODEL}`); // echoes a key-shaped secret
      break;
    case "stall":
    case "stall-2":
      stall(res);
      break;
    case "five-thirty":
      errorJson(res, 530, "origin unreachable (cloudflare 530)");
      break;
    case "slow-ok":
      sseStream(res, DELTAS, { startDelayMs: 150 }); // overlap window for the concurrency test
      break;
    case "cache-ok":
      sseStream(res, DELTAS);
      break;
    default:
      errorJson(res, 404, "no such case");
  }
});

await new Promise((res, rej) => {
  server.once("error", rej);
  server.listen(0, "127.0.0.1", res);
});
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

const mkClient = (caseName, { events = [], requestTimeoutMs = 2000, policy = FAST_POLICY, clientOpts = {} } = {}) =>
  createVisionClient(
    { name: "mock", provider: "custom", model: MODEL, baseUrl: `${BASE}/case/${caseName}`, apiKey: CLIENT_KEY },
    { policy, requestTimeoutMs, onEvent: (e) => events.push(e), ...clientOpts },
  );

// Safety guard: if something leaks a socket/timer the process would hang —
// fail loudly instead (unref'd so it never fires on a healthy run).
setTimeout(() => {
  origConsole.error("TIMEOUT GUARD: test run did not finish within 60s — leaked handle suspected");
  process.exit(1);
}, 60_000).unref();

try {
  console.log("\n[0] policy + classifier units (pure functions)");
  {
    check(
      "default policy frozen and exact: { maxAttempts: 3, backoffMs: [5000,15000,45000], budgetMs: 90000 }",
      JSON.stringify(VISION_RETRY_POLICY) === JSON.stringify({ maxAttempts: 3, backoffMs: [5000, 15000, 45000], budgetMs: 90_000 }),
      JSON.stringify(VISION_RETRY_POLICY),
    );
    check("normalizePolicy fills defaults and freezes", JSON.stringify(normalizePolicy({})) === JSON.stringify(VISION_RETRY_POLICY));
    let threw = false;
    try { normalizePolicy({ maxAttempts: 0 }); } catch { threw = true; }
    check("normalizePolicy rejects maxAttempts < 1", threw);
    const cases = [
      [{ status: 429 }, RETRYABLE], [{ status: 500 }, RETRYABLE], [{ status: 524 }, RETRYABLE],
      [{ status: 530 }, RETRYABLE], [{ status: 503 }, RETRYABLE],
      [{ status: 401 }, PERMANENT], [{ status: 400 }, PERMANENT], [{ status: 404 }, PERMANENT],
      [{ status: 403 }, PERMANENT],
      [Object.assign(new Error("custom API 429: quota"), {}), RETRYABLE],
      [Object.assign(new Error("custom API 401: bad key"), {}), PERMANENT],
      [new Error("model glm-x does not exist"), PERMANENT],
      [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), RETRYABLE], // our deadline, not caller's
      [new TypeError("fetch failed"), RETRYABLE],
      [new Error("terminated"), RETRYABLE],
      [new Error("socket hang up"), RETRYABLE],
    ];
    for (const [err, kind] of cases) {
      const c = classifyError(err);
      check(`classifyError(${JSON.stringify(err.status ?? err.message?.slice(0, 40) ?? String(err))}) → ${kind}`, c.kind === kind, `got ${c.kind}`);
    }
    check("classifyError honours caller abort → cancelled", classifyError(new Error("aborted"), { signalAborted: true }).kind === CANCELLED);
    const r = redact(`Bearer ${CLIENT_KEY} and key ${ECHOED_KEY} blob ${"A".repeat(120)}`);
    check("redact() strips Bearer + sk- keys + base64 blobs", !r.includes(CLIENT_KEY) && !r.includes(ECHOED_KEY) && r.includes("[redacted]"), r.slice(0, 80));
  }

  console.log("\n[1] streamed chunks assembled correctly (incl. a split data-line)");
  {
    const events = [];
    const c = mkClient("stream-ok", { events });
    const r = await c.complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("ok result", r.ok === true, JSON.stringify(r).slice(0, 120));
    check("text assembled exactly from 4 deltas", r.text === EXPECTED_TEXT, JSON.stringify(r.text));
    check("final response parses to JSON verdict", r.json && r.json.kind === "card-grid" && r.json.confidence === 0.92, JSON.stringify(r.json));
    check("single attempt, not cached", r.attempts === 1 && r.cached === false);
    check("auth header reached the provider path", route("stream-ok").sawAuth === true);
    check("events: one success, no attempt-failed", events.filter((e) => e.type === "success").length === 1 && !events.some((e) => e.type === "attempt-failed"), JSON.stringify(events.map((e) => e.type)));
  }

  console.log("\n[2] interrupted stream is retried, second attempt succeeds");
  {
    const r = await mkClient("stream-interrupt").complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("recovered after mid-stream socket teardown", r.ok === true && r.text === EXPECTED_TEXT, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
    check("exactly 2 attempts (interrupt + success)", r.attempts === 2 && route("stream-interrupt").count === 2, `attempts=${r.attempts} serverCount=${route("stream-interrupt").count}`);
  }

  console.log("\n[3] 429 then success recovers");
  {
    const events = [];
    const r = await mkClient("rate-limit", { events }).complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("recovered after 429", r.ok === true && r.attempts === 2 && route("rate-limit").count === 2, `attempts=${r.attempts} serverCount=${route("rate-limit").count}`);
    const failed = events.find((e) => e.type === "attempt-failed");
    check("failure event recorded as retryable 429", failed && failed.errorKind === RETRYABLE && failed.status === 429, JSON.stringify(failed));
  }

  console.log("\n[4] permanent 401: no retry, deterministic fallback, no key leak");
  {
    const events = [];
    const r = await mkClient("auth-fail", { events }).complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("fallback verdict contract: { ok:false, fallback:true, reason }", r.ok === false && r.fallback === true && typeof r.reason === "string" && r.reason.length > 0, JSON.stringify({ ok: r.ok, fallback: r.fallback }));
    check("NO retry on permanent error (exactly 1 request)", r.attempts === 1 && route("auth-fail").count === 1, `attempts=${r.attempts} serverCount=${route("auth-fail").count}`);
    check("errorKind permanent", r.errorKind === PERMANENT, r.errorKind);
    const surfaces = [r.reason, JSON.stringify(events), consoleBuf.join("\n")];
    for (const secret of [ECHOED_KEY, CLIENT_KEY]) {
      check(`secret ${secret.slice(0, 6)}… never appears in reason/events/console`, surfaces.every((s) => !s.includes(secret)));
    }
    check("reason mentions 401 (diagnosable, not silent)", /401/.test(r.reason), r.reason.slice(0, 100));
  }

  console.log("\n[5] request timeout triggers real cancellation (socket aborted at deadline)");
  {
    const r = await mkClient("stall", { requestTimeoutMs: 300 }).complete({ prompt: "classify region", imageBase64: IMG_1PX });
    await new Promise((res) => setTimeout(res, 150)); // let the last socket 'close' event reach the mock
    const rt = route("stall");
    check("all attempts timed out → fallback", r.ok === false && r.fallback === true && r.attempts === FAST_POLICY.maxAttempts, `attempts=${r.attempts}`);
    check("each attempt really hit the provider", rt.count === FAST_POLICY.maxAttempts, `serverCount=${rt.count}`);
    check("mock observed socket CLOSE at ~300ms deadline for every attempt (real abort, no hang)", rt.closeGapsMs.length === FAST_POLICY.maxAttempts && rt.closeGapsMs.every((g) => g >= 200 && g <= 2000), JSON.stringify(rt.closeGapsMs.map((g) => Math.round(g))));
    check("classified retryable (timeout), finished well under budget", r.errorKind === RETRYABLE && r.elapsedMs < FAST_POLICY.budgetMs, `errorKind=${r.errorKind} elapsed=${r.elapsedMs}ms`);
  }

  console.log("\n[6] retry exhaustion → deterministic fallback verdict");
  {
    const r = await mkClient("five-thirty").complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("exhausted all attempts", r.attempts === FAST_POLICY.maxAttempts && route("five-thirty").count === FAST_POLICY.maxAttempts, `attempts=${r.attempts} serverCount=${route("five-thirty").count}`);
    check("fallback contract honoured on 530 exhaustion", r.ok === false && r.fallback === true && typeof r.reason === "string" && /exhausted/i.test(r.reason), r.reason.slice(0, 100));
    check("last error classified retryable", r.errorKind === RETRYABLE, r.errorKind);
  }

  console.log("\n[7] strict budget: a retry that does not fit is never started");
  {
    const before = route("five-thirty").count;
    const r = await mkClient("five-thirty", { policy: { maxAttempts: 6, backoffMs: [3000, 3000, 3000, 3000, 3000], budgetMs: 1500 } }).complete({ prompt: "classify region", imageBase64: IMG_1PX });
    check("budget exhausted after attempt 1 (no retry started)", r.ok === false && r.fallback === true && r.attempts === 1, `attempts=${r.attempts}`);
    check("provider hit exactly once — retries never amplify the outage", route("five-thirty").count === before + 1, `serverCount=${route("five-thirty").count}`);
    check("reason says budget exhausted", /budget/i.test(r.reason), r.reason.slice(0, 100));
    check("returned within the budget (no overshoot)", r.elapsedMs <= 1500 + 250, `elapsed=${r.elapsedMs}ms`);
  }

  console.log("\n[8] cache: SHA1(prompt+imageBytes+model) hit avoids the second request");
  {
    const c = mkClient("cache-ok");
    const r1 = await c.complete({ prompt: "prompt A", imageBase64: IMG_1PX });
    const r2 = await c.complete({ prompt: "prompt A", imageBase64: IMG_1PX });
    const countAfterTwo = route("cache-ok").count; // captured BEFORE the third call can bump it
    const r3 = await c.complete({ prompt: "prompt B", imageBase64: IMG_1PX });
    check("first call requests and succeeds", r1.ok === true && r1.cached === false);
    check("second identical call served from cache (no request)", r2.ok === true && r2.cached === true && r2.attempts === 0, `cached=${r2.cached} attempts=${r2.attempts}`);
    check("server saw exactly ONE request for the two identical calls", countAfterTwo === 1, `serverCount=${countAfterTwo}`);
    check("different prompt = different SHA1 key → real request", r3.ok === true && r3.cached === false && route("cache-ok").count === 2, `serverCount=${route("cache-ok").count}`);
  }

  console.log("\n[9] concurrency cap holds (max 2 in flight)");
  {
    const rt = route("slow-ok");
    const c = mkClient("slow-ok");
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => c.complete({ prompt: `concurrent prompt ${i}`, imageBase64: IMG_1PX })),
    );
    const wall = Date.now() - t0;
    check("all 5 completes succeeded", results.every((r) => r.ok === true), results.map((r) => r.ok).join(","));
    check("mock never observed more than 2 in-flight requests", rt.maxActive <= 2, `maxActive=${rt.maxActive}`);
    check("cap actually binding (requests overlapped, not serialised by chance)", rt.maxActive === 2 && wall < 5 * 400, `maxActive=${rt.maxActive} wall=${wall}ms`);
  }

  console.log("\n[10] caller AbortSignal: prompt return, no retry afterwards");
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const t0 = Date.now();
    const r = await mkClient("stall-2", { requestTimeoutMs: 2500 }).complete({ prompt: "classify region", imageBase64: IMG_1PX, signal: ac.signal });
    const wall = Date.now() - t0;
    check("returned promptly after the caller abort (not at the 2.5s deadline)", r.ok === false && wall < 1000, `wall=${wall}ms`);
    check("classified cancelled", r.errorKind === CANCELLED, r.errorKind);
    check("no retry after cancellation (exactly 1 request)", r.attempts === 1 && route("stall-2").count === 1, `attempts=${r.attempts} serverCount=${route("stall-2").count}`);
  }

  console.log("\n[11] units: input validation, provider 'none', asVisionFn adoption contract");
  {
    const before = route("stream-ok").count;
    const r0 = await mkClient("stream-ok").complete({ imageBase64: IMG_1PX });
    check("missing prompt → fallback, no fetch", r0.ok === false && r0.fallback === true && /prompt/.test(r0.reason) && route("stream-ok").count === before, r0.reason);
    check("provider 'none' → createVisionClientForConfig returns null (deterministic off-switch)", createVisionClientForConfig({ model: { provider: "none" } }) === null);
    // true no-provider path: model-router appends env-key providers
    // (model-router.js:46-48), so hide OPENAI_API_KEY for this hermetic check
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let noProvider = null;
    try { noProvider = createVisionClientForConfig({}); } finally { if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; }
    check("empty config → null (no provider, no throw)", noProvider === null);
    const c = createVisionClient({ baseUrl: "http://unused.invalid", apiKey: "k" });
    check("default model is glm-5.3-flash-free", c.model === DEFAULT_MODEL && DEFAULT_MODEL === "glm-5.3-flash-free", c.model);
    const verdict = await mkClient("stream-ok").asVisionFn()({ x: 10, y: 20, w: 300, h: 80 }, IMG_1PX, { index: 4 });
    check("asVisionFn returns a verdict object for vision-assist's injectable contract", verdict && verdict.kind === "card-grid" && typeof verdict.confidence === "number" && typeof verdict.reason === "string", JSON.stringify(verdict));
    const nullVerdict = await mkClient("auth-fail").asVisionFn()({ x: 0, y: 0, w: 100, h: 50 }, IMG_1PX, {});
    check("asVisionFn returns null on fallback → vision-assist keeps DOM verdict (FALLBACK_VERDICT path)", nullVerdict === null);
    check("extractJson tolerates prose + fences", extractJson('```json\nnoise {"kind":"nav","confidence":0.8,"reason":"r"} trailing')?.kind === "nav" && extractJson("no json here") === null);
  }

  // ---- optional live smoke — only with the explicit env switch ----
  if (process.env.CLONER_LIVE_VISION_SMOKE === "1") {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    const client = createVisionClientForConfig(cfg, { requestTimeoutMs: 45_000 });
    if (!client) {
      smoke = "no provider configured — skipped";
      check("live smoke: provider availability", false, "createVisionClientForConfig returned null");
    } else {
      try {
        const r = await client.complete({
          prompt: 'Reply with ONLY this JSON: {"kind":"nav","confidence":0.9,"reason":"smoke test"}',
          imageBase64: IMG_1PX,
        });
        // Honest reporting: a flaky live provider failing is a REPORTED outcome,
        // not a suite failure — the offline contract is what the suite enforces.
        if (r.ok) {
          smoke = `live OK via ${r.provider}/${r.model} (attempts=${r.attempts}, cached=${r.cached})`;
          check("live smoke: request completed", true, JSON.stringify(r.text || "").slice(0, 80));
        } else {
          smoke = `live fallback via ${client.providerName} (reason: ${r.reason})`;
          check("live smoke: request completed with deterministic fallback", true, r.reason.slice(0, 80));
        }
      } catch (e) {
        smoke = `live smoke threw: ${redact(e?.message)}`;
        check("live smoke: request completed", false, redact(e?.message || String(e)));
      }
    }
  }
} finally {
  for (const k of ["log", "warn", "error"]) console[k] = origConsole[k];
  server.closeAllConnections?.();
  await new Promise((res) => server.close(res));
}

console.log("\n----- summary -----");
console.log(`vision-reliability: ${pass} passed, ${fail} failed`);
console.log(`live smoke: ${smoke}`);
process.exitCode = fail > 0 ? 1 : 0;
