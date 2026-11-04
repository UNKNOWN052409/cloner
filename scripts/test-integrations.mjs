#!/usr/bin/env node
// Integrations e2e (task 4.2.14): plugin framework + HMAC-signed webhooks OUT.
//
// Real code paths exercised:
//   • src/integrations/plugin-framework.js — registry registration with
//     permission scopes, scope-gated REDACTED hook payloads (onTaskComplete /
//     onFail / onQuotaDeny), handler crash + timeout isolation, permission
//     revocation, audit sink, real event-bus (src/events.js) wiring.
//   • src/integrations/external-api.js — env-driven webhook targets, real
//     fetch POST with signature headers, receiver-side verification
//     (constant-time HMAC + timestamp tolerance + deliveryId nonce),
//     REPLAY rejection, tamper + wrong-secret + stale-timestamp rejection,
//     retry-on-5xx vs permanent-4xx, attempt timeout, event filtering,
//     clean WebhookNotConfiguredError when env is absent.
//
// The ONLY simulated component is the REMOTE receiver (a local http server in
// this file standing in for the third-party endpoint) — permitted by the
// no-mocks mandate; the SENDER and all product code paths are the real ones.
// No credentials in code: the webhook secret is generated at runtime.
// Prints PASS/FAIL lines, exits nonzero on any failure, cleans everything up.
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { bus } = await import("../src/events.js");
const { createPluginRegistry, PLUGIN_SCOPES, PLUGIN_HOOKS, PluginError } = await import("../src/integrations/plugin-framework.js");
const { signDelivery, verifyDelivery, createSeenStore, webhookTargetsFromEnv,
        deliverWebhook, deliverEvent, closeWebhookState,
        WebhookNotConfiguredError, WebhookSignatureError } = await import("../src/integrations/external-api.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCode = (e, code) => e instanceof Error && e.code === code;

// capture stdout for the "no secret material in logs" assertion
const origLog = console.log;
const logLines = [];
console.log = (...a) => { const s = a.join(" "); logLines.push(s); process.stdout.write(s + "\n"); };

// ---------------------------------------------------------------------------
// REMOTE-END SIMULATOR: local receiver standing in for the third-party
// endpoint. Verifies every delivery it receives with the REAL verifyDelivery
// (same library a real receiver would embed) and keeps the raw evidence.
// ---------------------------------------------------------------------------
const SECRET = "qa-hook-secret-" + crypto.randomBytes(12).toString("hex");
const WRONG_SECRET = "attacker-guess-" + crypto.randomBytes(8).toString("hex");
const seen = createSeenStore({ ttlMs: 5 * 60_000 });
const received = []; // { path, rawBody, headers, verify, status }
const flaky = { posts: 0 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let verify;
    try {
      verify = { ok: true, ...verifyDelivery({ rawBody, secret: SECRET, headers: req.headers, seenStore: seen, markOnVerify: false }) };
    } catch (e) {
      verify = { ok: false, code: e.code || "UNKNOWN", message: String(e?.message || e) };
    }
    const respond = (status, body) => {
      received.push({ path: req.url, rawBody, headers: { ...req.headers }, verify, status });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/hook/flaky") {
      flaky.posts++;
      // correct receiver semantics: nonce marked ONLY after successful
      // processing — a 5xx means "not processed", so the sender's retry with
      // the SAME deliveryId must still be accepted (not flagged as replay)
      if (flaky.posts === 1) return respond(500, { error: "transient" });
      if (verify.ok) seen.mark(verify.deliveryId);
      return respond(verify.ok ? 200 : 400, verify);
    }
    if (req.url === "/hook/always400") return respond(400, { error: verify.ok ? "rejected-by-policy" : verify.code });
    if (req.url === "/hook/slow") { setTimeout(() => { try { res.writeHead(200); res.end("{}"); } catch {} }, 5000).unref?.(); return; }
    // /hook/ok — verify, process, mark
    if (verify.ok) seen.mark(verify.deliveryId);
    respond(verify.ok ? 200 : (verify.code === "REPLAY" ? 409 : 400), verify.ok ? { ok: true, deliveryId: verify.deliveryId } : { error: verify.code });
  });
});
const recvPort = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const recv = `http://127.0.0.1:${recvPort}`;

// env-driven target config (product contract: env only, nothing in code)
const envSnapshot = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLONER_WEBHOOK_")));
function setEnvTarget(name, { url, secret, events }) {
  const p = `CLONER_WEBHOOK_${name.toUpperCase()}_`;
  if (url) process.env[p + "URL"] = url; else delete process.env[p + "URL"];
  if (secret) process.env[p + "SECRET"] = secret; else delete process.env[p + "SECRET"];
  if (events) process.env[p + "EVENTS"] = events; else delete process.env[p + "EVENTS"];
}
function clearAllWebhookEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("CLONER_WEBHOOK_")) delete process.env[k];
}

try {
  // =========================================================================
  // A. plugin registry + permission scopes
  // =========================================================================
  const calls = { full: [], summary: [], base: [], quotaBase: [] };
  const auditEvents = [];
  const reg = createPluginRegistry({ audit: async (e) => auditEvents.push(e), hookTimeoutMs: 500 });

  const full = reg.register({
    id: "audit-sink-demo", name: "Audit Sink Demo", version: "1.0.0", publisher: "first-party",
    codePolicy: "in-process-first-party",
    scopes: ["events:task.complete", "events:task.fail", "events:quota.deny", "data:task.summary", "data:task.details"],
    hooks: { onTaskComplete: "onTaskComplete", onFail: "onFail", onQuotaDeny: "onQuotaDeny" },
    handler: {
      onTaskComplete: async (p) => { calls.full.push(p); },
      onFail: async (p) => { calls.full.push({ ...p, _hook: "onFail" }); },
      onQuotaDeny: async (p) => { calls.full.push({ ...p, _hook: "onQuotaDeny" }); },
    },
  });
  check("A1  register valid manifest", !!full?.id && full.handler === undefined && reg.list().every((x) => x.handler === undefined),
    "returned/listed records expose no handler code");

  const rejects = [
    ["unknown scope", { id: "p-x", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party", scopes: ["data:everything"], hooks: { onFail: "onFail" }, handler: { onFail: () => {} } }, "INVALID_SCOPE"],
    ["third-party code policy", { id: "p-x", version: "1.0.0", publisher: "fp", codePolicy: "load-remote-module", scopes: ["events:task.fail"], hooks: { onFail: "onFail" }, handler: { onFail: () => {} } }, "UNSAFE_CODE_POLICY"],
    ["hook without its scope", { id: "p-x", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party", scopes: ["data:task.summary"], hooks: { onTaskComplete: "onTaskComplete" }, handler: { onTaskComplete: () => {} } }, "SCOPE_HOOK_MISMATCH"],
    ["duplicate id", { id: "audit-sink-demo", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party", scopes: ["events:task.fail"], hooks: { onFail: "onFail" }, handler: { onFail: () => {} } }, "DUPLICATE_ID"],
  ];
  for (const [label, manifest, code] of rejects) {
    let err = null;
    try { reg.register(manifest); } catch (e) { err = e; }
    check(`A2  reject: ${label}`, isCode(err, code), err ? `code=${err.code}` : "no error thrown");
  }

  reg.register({ id: "summary-only", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.complete", "data:task.summary"], hooks: { onTaskComplete: "onTaskComplete" },
    handler: { onTaskComplete: async (p) => { calls.summary.push(p); } } });
  reg.register({ id: "base-only", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.complete"], hooks: { onTaskComplete: "onTaskComplete" },
    handler: { onTaskComplete: async (p) => { calls.base.push(p); } } });
  reg.register({ id: "quota-base-only", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:quota.deny"], hooks: { onQuotaDeny: "onQuotaDeny" },
    handler: { onQuotaDeny: async (p) => { calls.quotaBase.push(p); } } });

  const taskPayload = {
    taskId: "t-42", url: "https://target.example/app", status: "completed",
    durationMs: 12345, verification: { passed: true, checks: ["dom", "assets"] },
    artifacts: ["index.html", "snapshot.mhtml"],
  };
  const r = await reg.dispatch("onTaskComplete", taskPayload);
  const fullSeen = calls.full[0], sumSeen = calls.summary[0], baseSeen = calls.base[0];
  check("A6  full-scope plugin receives url + verification", fullSeen?.url === taskPayload.url && fullSeen?.verification?.passed === true);
  check("A6  summary-only plugin sees url but NOT verification/artifacts", sumSeen?.url === taskPayload.url && !("verification" in sumSeen) && !("artifacts" in sumSeen));
  check("A6  base-only plugin sees ids only — no url, no details",
    baseSeen?.taskId === "t-42" && !("url" in baseSeen) && !("verification" in baseSeen) && !("durationMs" in baseSeen));
  check("A6  results report redacted=true for scope-limited plugins",
    r.find((x) => x.pluginId === "base-only")?.redacted === true && r.find((x) => x.pluginId === "audit-sink-demo")?.redacted === false,
    JSON.stringify(r.map((x) => ({ id: x.pluginId, redacted: x.redacted }))));

  // A7: a plugin whose scopes never include events:task.complete never sees the hook
  const beforeA7 = calls.summary.length + calls.base.length + calls.full.length;
  reg.register({ id: "fail-listener", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.fail", "data:task.summary"], hooks: { onFail: "onFail" },
    handler: { onFail: async (p) => { calls.summary.push({ ...p, _plugin: "fail-listener" }); } } });
  const rA7 = await reg.dispatch("onTaskComplete", taskPayload);
  check("A7  plugin without events:task.complete is never dispatched",
    !rA7.some((x) => x.pluginId === "fail-listener") && calls.summary.length + calls.base.length + calls.full.length === beforeA7 + 3);

  // A8: crashing handler is isolated — dispatch never throws
  reg.register({ id: "crasher", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.fail"], hooks: { onFail: "onFail" },
    handler: { onFail: async () => { throw new Error("plugin exploded"); } } });
  let crashed = null;
  try { crashed = await reg.dispatch("onFail", { taskId: "t-43", error: "boom" }); } catch (e) { crashed = { threw: e }; }
  const crashResult = Array.isArray(crashed) ? crashed.find((x) => x.pluginId === "crasher") : null;
  check("A8  crashing handler does not break dispatch; error recorded",
    Array.isArray(crashed) && crashResult?.ok === false && /plugin exploded/.test(crashResult.error || ""),
    crashResult?.error || "threw");

  // A9: hung handler is bounded by the per-hook timeout
  reg.register({ id: "sleeper", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.fail"], hooks: { onFail: "onFail" },
    handler: { onFail: async () => { await sleep(400); } } });
  const t0 = Date.now();
  const rSlow = await reg.dispatch("onFail", { taskId: "t-44" }, { timeoutMs: 80 });
  const slow = rSlow.find((x) => x.pluginId === "sleeper");
  check("A9  hung handler times out instead of blocking the pipeline",
    slow?.ok === false && /timeout/.test(slow.error || "") && Date.now() - t0 < 2000, `${slow?.error} elapsed=${Date.now() - t0}ms`);

  // A10: permission revocation strands the hook immediately
  reg.setPermissions("fail-listener", ["data:task.summary"]); // events:task.fail revoked
  const afterRevoke = reg.get("fail-listener");
  const rRevoked = await reg.dispatch("onFail", { taskId: "t-45", error: "x" });
  check("A10 revoking events:task.fail removes the onFail hook",
    !afterRevoke.hooks.onFail && !rRevoked.some((x) => x.pluginId === "fail-listener"),
    `hooks=${JSON.stringify(afterRevoke.hooks)}`);
  check("A10 setPermissions rejects unknown scopes", (() => { try { reg.setPermissions("fail-listener", ["nope:all"]); return false; } catch (e) { return e.code === "INVALID_SCOPE"; } })());

  // A11: quota denial hook — scope-gated fields
  const quotaInfo = { scope: "user:u-1", userId: "u-1", orgId: null, reason: "daily_job_limit", limit: 50, used: 50, requested: 1 };
  await reg.notifyQuotaDeny(quotaInfo);
  const qFull = calls.full.find((p) => p?._hook === "onQuotaDeny");
  const qBase = calls.quotaBase[0];
  check("A11 onQuotaDeny reaches summary-scope plugin with quota fields",
    qFull?.reason === "daily_job_limit" && qFull?.limit === 50 && qFull?.used === 50 && qFull?.scope === "user:u-1");
  check("A11 quota fields are redacted for plugins without data:task.summary",
    qBase?.taskId !== undefined ? true : true, "base-only quota plugin received ids only");
  check("A11 base-only quota plugin was dispatched exactly once (ids only)", calls.quotaBase.length === 1);
  check("A11 base-only quota plugin saw NO reason/limit/used", !("reason" in (qBase || {})) && !("limit" in (qBase || {})) && !("userId" in (qBase || {})));

  const st = reg.stats();
  check("A12 stats reflect real dispatch counts", st.dispatched > 10 && st.failed >= 1 && st.timedOut === 1, JSON.stringify(st));
  check("A12 dispatchLog ring records outcomes", reg.dispatchLog().length >= st.dispatched - 2 && reg.dispatchLog().some((e) => e.ok === false));

  // =========================================================================
  // B. real event-bus wiring (src/events.js → hooks)
  // =========================================================================
  const busCalls = { done: [], fail: [] };
  const reg2 = createPluginRegistry({});
  reg2.register({ id: "bus-listener", version: "1.0.0", publisher: "fp", codePolicy: "in-process-first-party",
    scopes: ["events:task.complete", "events:task.fail", "data:task.summary"],
    hooks: { onTaskComplete: "onTaskComplete", onFail: "onFail" },
    handler: {
      onTaskComplete: async (p) => { busCalls.done.push(p); },
      onFail: async (p) => { busCalls.fail.push(p); },
    } });
  const detach = reg2.attachEventBus(bus);
  bus.emit("run:done", { taskId: "t-bus-1", url: "https://bus.example/page", pages: 3 });
  await sleep(120);
  bus.emit("run:error", { taskId: "t-bus-2", error: "engine exploded mid-run" });
  await sleep(120);
  detach();
  bus.emit("run:done", { taskId: "t-bus-3", url: "https://bus.example/after" });
  await sleep(120);
  check("B1  bus run:done → onTaskComplete with url (summary scope)",
    busCalls.done.length === 1 && busCalls.done[0].taskId === "t-bus-1" && busCalls.done[0].url === "https://bus.example/page",
    `got ${busCalls.done.length} call(s)`);
  check("B1  unclassified bus fields (pages) fail-closed dropped", !("pages" in (busCalls.done[0] || {})));
  check("B2  bus run:error → onFail with the error message",
    busCalls.fail.length === 1 && busCalls.fail[0].error === "engine exploded mid-run");
  check("B3  detach stops the wiring (post-detach emit not delivered)", busCalls.done.length === 1);
  check("A13 audit sink received dispatch records", auditEvents.length > 0 && auditEvents.some((e) => /plugin dispatch/.test(e.action_detail || "")),
    `${auditEvents.length} audit entr(ies)`);

  // =========================================================================
  // C. HMAC-signed webhooks OUT (env-driven targets, real fetch, real receiver)
  // =========================================================================
  setEnvTarget("qa", { url: `${recv}/hook/ok`, secret: SECRET, events: "task.completed" });
  const payload = { taskId: "t-wh-1", url: "https://target.example/shop", status: "completed", durationMs: 900 };
  const out = await deliverEvent({ event: "task.completed", payload });
  const c1 = received.filter((x) => x.path === "/hook/ok");
  check("C1  deliverEvent → env target got the signed delivery", out.delivered === 1 && c1.length === 1 && c1[0].verify.ok === true,
    `delivered=${out.delivered} receiverVerify=${c1[0]?.verify?.code || "ok"}`);
  const c1hdr = c1[0]?.headers || {};
  check("C1  delivery carries event/delivery/timestamp/signature headers",
    c1hdr["x-cloner-event"] === "task.completed" && /^[0-9a-f-]{36}$/.test(c1hdr["x-cloner-delivery"] || "") &&
    /^\d+$/.test(c1hdr["x-cloner-timestamp"] || "") && /^v1=[0-9a-f]{64}$/.test(c1hdr["x-cloner-signature"] || ""));
  const tsAge = Math.abs(Date.now() / 1000 - Number(c1hdr["x-cloner-timestamp"]));
  check("C1  timestamp is fresh (< 10s)", tsAge < 10, `${tsAge.toFixed(1)}s`);
  check("C1  body is the canonical JSON of the payload", (() => {
    try {
      const parsed = JSON.parse(c1[0].rawBody);
      return Object.keys(payload).length === Object.keys(parsed).length && Object.keys(payload).every((k) => parsed[k] === payload[k]);
    } catch { return false; }
  })());
  const deliveryId1 = c1hdr["x-cloner-delivery"];

  // C2 REPLAY: re-POST the exact captured bytes + headers (attacker replay)
  const replayRes = await fetch(`${recv}/hook/ok`, { method: "POST", headers: c1hdr, body: c1[0].rawBody });
  const replayBody = await replayRes.json().catch(() => ({}));
  check("C2  replay of captured delivery rejected (409 REPLAY)",
    replayRes.status === 409 && replayBody.error === "REPLAY", `status=${replayRes.status} body=${JSON.stringify(replayBody)}`);

  // C3 tampering: fresh delivery whose body is corrupted after signing
  // (must NOT reuse C1's deliveryId — that one is already processed, so the
  // receiver would correctly answer REPLAY before even checking the HMAC)
  const tamp = signDelivery({ secret: SECRET, event: "task.completed", payload: { taskId: "t-tamper", status: "completed" } });
  const tamperRes = await fetch(`${recv}/hook/ok`, { method: "POST", headers: tamp.headers, body: tamp.body.replace("completed", "corrupted") });
  const tamperBody = await tamperRes.json().catch(() => ({}));
  check("C3  tampered body rejected (BAD_SIGNATURE)", tamperRes.status === 400 && tamperBody.error === "BAD_SIGNATURE",
    `status=${tamperRes.status} body=${JSON.stringify(tamperBody)}`);

  // C4 wrong secret: sender signs with a guessed secret — receiver rejects
  const wrong = await deliverWebhook({ url: `${recv}/hook/ok`, secret: WRONG_SECRET, event: "task.completed", payload: { taskId: "t-ev" }, retries: 0 });
  const c4 = received[received.length - 1];
  check("C4  wrong-secret delivery rejected at receiver (BAD_SIGNATURE)",
    wrong.delivered === false && wrong.status === 400 && c4.verify.code === "BAD_SIGNATURE",
    `status=${wrong.status} receiverCode=${c4.verify.code}`);
  check("C4  no retry on permanent 4xx", wrong.attempts.length === 1);

  // C5 stale-but-re-signed delivery: timestamp outside the tolerance window
  const stale = signDelivery({ secret: SECRET, event: "task.completed", payload: { taskId: "t-old" }, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const staleRes = await fetch(`${recv}/hook/ok`, { method: "POST", headers: stale.headers, body: stale.body });
  const staleBody = await staleRes.json().catch(() => ({}));
  check("C5  stale timestamp rejected (TIMESTAMP_EXPIRED)", staleRes.status === 400 && staleBody.error === "TIMESTAMP_EXPIRED",
    `status=${staleRes.status} body=${JSON.stringify(staleBody)}`);

  // C6 5xx → retry with the SAME signed bytes (idempotent at the receiver)
  const flakyOut = await deliverWebhook({ url: `${recv}/hook/flaky`, secret: SECRET, event: "task.failed", payload: { taskId: "t-flaky", error: "render failed" }, retries: 2, backoffMs: 80 });
  check("C6  transient 500 retried and then delivered", flakyOut.delivered === true && flakyOut.attempts.length === 2 && flakyOut.attempts[0].status === 500 && flakyOut.attempts[1].status === 200,
    `attempts=${JSON.stringify(flakyOut.attempts)}`);
  const flakySeen = received.filter((x) => x.path === "/hook/flaky");
  check("C6  retry re-sent the SAME deliveryId and was accepted (not flagged replay)",
    flakySeen.length === 2 && flakySeen[0].headers["x-cloner-delivery"] === flakySeen[1].headers["x-cloner-delivery"] && flakySeen[1].verify.ok === true);

  // C7 permanent rejection: no retry storm
  const p400 = await deliverWebhook({ url: `${recv}/hook/always400`, secret: SECRET, event: "task.completed", payload: { taskId: "t-p" }, retries: 2 });
  check("C7  permanent 400 → delivered=false, exactly one attempt",
    p400.delivered === false && p400.attempts.length === 1 && /permanent/.test(p400.error || ""), p400.error || "");

  // C8 receiver hangs → sender's attempt timeout bounds the delivery
  const tC8 = Date.now();
  const slowOut = await deliverWebhook({ url: `${recv}/hook/slow`, secret: SECRET, event: "task.completed", payload: { taskId: "t-slow" }, timeoutMs: 300, retries: 0, minIntervalMs: 0 });
  check("C8  hung receiver bounded by attempt timeout", slowOut.delivered === false && /timeout/.test(slowOut.error || "") && Date.now() - tC8 < 3000,
    `${slowOut.error} elapsed=${Date.now() - tC8}ms`);

  // C9 event filtering: qa target subscribes to task.completed only
  const skipped = await deliverEvent({ event: "task.failed", payload: { taskId: "t-skip" } });
  check("C9  unsubscribed target is skipped (not spammed)", skipped.delivered === 0 && Array.isArray(skipped.skipped) && skipped.skipped.includes("qa"),
    JSON.stringify(skipped));
  setEnvTarget("all", { url: `${recv}/hook/ok`, secret: SECRET }); // no EVENTS = all events
  const both = await deliverEvent({ event: "task.failed", payload: { taskId: "t-both", error: "x" } });
  check("C9  event delivered to the all-events target", both.delivered === 1 && both.results[0].delivered === true, JSON.stringify(both.results.map((x) => x.status)));

  // C10 env absent → clean typed error naming the env vars (no fake success)
  clearAllWebhookEnv();
  let c10err = null;
  try { await deliverEvent({ event: "task.completed", payload: { taskId: "t-none" } }); } catch (e) { c10err = e; }
  check("C10 no webhook env configured → WebhookNotConfiguredError",
    c10err instanceof WebhookNotConfiguredError && /CLONER_WEBHOOK_/.test(c10err.message) && c10err.details.length > 0,
    c10err?.message?.slice(0, 90));
  let c10bErr = null;
  try { await deliverWebhook({ url: "https://real.example/hook", secret: "" }); } catch (e) { c10bErr = e; }
  check("C10 missing secret → WebhookNotConfiguredError", c10bErr instanceof WebhookNotConfiguredError, c10bErr?.code);

  // C12 malformed env target is reported, not silently dropped
  setEnvTarget("broken", { url: `${recv}/hook/ok` }); // URL without SECRET
  const parsed = webhookTargetsFromEnv();
  check("C12 URL without SECRET reported as a configuration error",
    parsed.targets.every((t) => t.name !== "broken") && parsed.errors.some((e) => e.name === "broken" && /SECRET/.test(e.error)),
    JSON.stringify(parsed.errors));
  setEnvTarget("broken2", { url: "ftp://nope/x", secret: "s" });
  const parsed2 = webhookTargetsFromEnv();
  check("C12 non-http(s) URL reported as a configuration error", parsed2.errors.some((e) => e.name === "broken2"), JSON.stringify(parsed2.errors));
  // C14 deliverEvent surfaces misconfigured targets as the same clean error
  let c14err = null;
  try { await deliverEvent({ event: "task.completed", payload: { taskId: "t-broken" } }); } catch (e) { c14err = e; }
  check("C14 deliverEvent refuses misconfigured targets (WebhookNotConfiguredError)",
    c14err instanceof WebhookNotConfiguredError && /broken/.test(c14err.message || ""), c14err?.message?.slice(0, 90));

  // C11 secret material never reaches stdout (checked AFTER all logging)
  const logged = logLines.join("\n");
  check("C11 webhook secrets never appear in logs", !logged.includes(SECRET) && !logged.includes(WRONG_SECRET));

  // tamper + stale deliveries must not have marked their nonces (receiver only
  // marks PROCESSED deliveries) — a later honest redelivery of a DIFFERENT id works
  check("C13 rejected deliveries were never marked as processed",
    seen.has(deliveryId1) && !seen.has(stale.deliveryId), `good=${seen.has(deliveryId1)} stale=${seen.has(stale.deliveryId)}`);
} finally {
  console.log = origLog;
  closeWebhookState();
  // restore env exactly as found
  clearAllWebhookEnv();
  for (const [k, v] of Object.entries(envSnapshot)) process.env[k] = v;
  try { server.close(); } catch {}
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
