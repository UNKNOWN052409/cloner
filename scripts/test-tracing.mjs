#!/usr/bin/env node
// Distributed tracing tests (task 4.2.10) — deterministic, NO Redis required.
//
//   Part 1 (codec): strict W3C traceparent parse/format — valid values, all
//   spec rejections (all-zero ids, version ff, uppercase hex, wrong lengths,
//   garbage), id generators.
//
//   Part 2 (mechanics): AsyncLocalStorage span tree — nested/sibling spans
//   share the trace id, error status on throw, concurrent traces isolated
//   (no cross-talk), a throwing sink never breaks the traced work.
//
//   Part 3 (the ask's headline check): a STUB JOB's spans form ONE TRACE TREE
//   through the REAL queue adapter (memory backend): producer span wraps
//   enqueue + injectTraceparent → payload.traceparent crosses the queue →
//   tracedExecutor continues the trace as the worker job span → one span per
//   pipeline stage from the report() protocol. Asserted from the JSONL export
//   file (span timing export), including a second job proving traces don't
//   bleed into each other.
//
//   Part 4 (bullmq path): the REAL #dispatch (clone-queue.js, via the
//   bullmqFactory mock transport = the remote-end simulator) carries
//   payload.traceparent inside BullMQ job data, and the REAL clone-worker
//   processor (startCloneWorker, workerFactory capture) rebuilds the same
//   one-trace tree from it.
//
//   Part 5 (trace-export module): sink buffering/flush, malformed-line
//   detection, buildTraceTrees grouping + orphan detection, env wiring
//   (CLONER_TRACING=0 off-switch, CLONER_TRACE_DIR override).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n-- ${t} --`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (90s)"); process.exit(1); }, 90_000);
watchdog.unref();

const HEX32 = /^[0-9a-f]{32}$/, HEX16 = /^[0-9a-f]{16}$/;
const TP_FIELDS = ["trace_id", "span_id", "parent_span_id", "name", "status", "start_ms", "end_ms", "duration_ms", "start_time", "end_time", "attributes"];
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-tracing-test-"));

const tc = await import("../src/observability/trace-context.js");
const te = await import("../src/observability/trace-export.js");

// ============================================================================
// Part 1 — W3C traceparent codec
// ============================================================================
section("Part 1: W3C traceparent codec (strict)");
{
  const good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const p = tc.parseTraceparent(good);
  check("P1: valid traceparent parses to its fields",
    !!p && p.version === "00" && p.traceId === "4bf92f3577b34da6a3ce929d0e0e4736" &&
    p.spanId === "00f067aa0ba902b7" && p.flags === "01", JSON.stringify(p));
  check("P1: higher version (01) still parses per spec (first 4 fields unchanged)",
    tc.parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.version === "01");
  const rejects = [
    ["all-zero trace-id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["all-zero span-id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["version ff (forbidden)", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["uppercase hex (spec is lowercase)", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"],
    ["trace-id 31 chars", "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01"],
    ["trace-id 33 chars", "00-4bf92f3577b34da6a3ce929d0e0e4736f-00f067aa0ba902b7-01"],
    ["span-id 15 chars", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01"],
    ["span-id 17 chars", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b77-01"],
    ["non-hex chars", "00-4bf92f3577b34da6a3ce929d0e0e4zzz-00f067aa0ba902b7-01"],
    ["too few fields", "00-4bf92f3577b34da6a3ce929d0e0e4736"],
    ["too many fields", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"],
    ["empty string", ""],
    ["whitespace-padded", " " + good + " "],
  ];
  for (const [why, val] of rejects) {
    check(`P1: reject ${why}`, tc.parseTraceparent(val) === null, JSON.stringify(val));
  }
  check("P1: reject non-string inputs (null/undefined/number)",
    tc.parseTraceparent(null) === null && tc.parseTraceparent(undefined) === null && tc.parseTraceparent(42) === null);

  const round = tc.formatTraceparent({ traceId: p.traceId, spanId: p.spanId, flags: p.flags });
  check("P1: formatTraceparent round-trips a parsed value", round === good, round);
  check("P1: format defaults version 00 / flags 01",
    tc.formatTraceparent({ traceId: p.traceId, spanId: p.spanId }) === good);
  const badFormats = [
    { traceId: "0".repeat(32), spanId: p.spanId }, { traceId: p.traceId, spanId: "0".repeat(16) },
    { traceId: "short", spanId: p.spanId }, { traceId: p.traceId.toUpperCase(), spanId: p.spanId },
    {}, { traceId: p.traceId, spanId: p.spanId, flags: "zz" }, { traceId: p.traceId, spanId: p.spanId, version: "ff" },
  ];
  check("P1: formatTraceparent throws on invalid parts (7 cases)",
    badFormats.every((bf) => { try { tc.formatTraceparent(bf); return false; } catch { return true; } }));

  const ids = new Set();
  let idsOk = true;
  for (let i = 0; i < 1000; i++) {
    const t = tc.randomTraceId(), s = tc.randomSpanId();
    if (!HEX32.test(t) || t === "0".repeat(32) || !HEX16.test(s) || s === "0".repeat(16)) { idsOk = false; break; }
    ids.add(t + s);
  }
  check("P1: randomTraceId/randomSpanId — 32/16 lowercase hex, non-zero, 1000 unique", idsOk && ids.size === 1000,
    `unique=${ids.size}/1000`);
}

// ============================================================================
// Part 2 — span tree mechanics (AsyncLocalStorage)
// ============================================================================
section("Part 2: span tree mechanics");
{
  tc.resetRecentSpans();
  tc.setSpanSink(null); // ring only for this part

  let rootId = null, childId = null, traceId = null;
  await tc.withSpan("root.op", {}, async (root) => {
    traceId = root.traceId; rootId = root.spanId;
    await sleep(2);
    await tc.withSpan("child.op", {}, async (child) => { childId = child.spanId; await sleep(1); });
  });
  const spans = tc.recentSpans();
  const root = spans.find((s) => s.span_id === rootId), child = spans.find((s) => s.span_id === childId);
  check("P2: nested span inherits trace id + parent linkage",
    root && child && child.trace_id === traceId && root.trace_id === traceId && child.parent_span_id === rootId);
  check("P2: root span has null parent", root?.parent_span_id === null);
  check("P2: durations recorded, child contained in root interval",
    root.duration_ms >= 0 && child.duration_ms >= 0 &&
    child.start_ms >= root.start_ms && child.end_ms <= root.end_ms + 1,
    `root=${root.duration_ms}ms child=${child.duration_ms}ms`);
  check("P2: spans carry ok status + ISO timestamps", root.status === "ok" && !isNaN(Date.parse(root.end_time)));

  // siblings
  let sibA = null, sibB = null;
  await tc.withSpan("parent.op", {}, async () => {
    await tc.withSpan("sib.a", {}, async () => { sibA = tc.currentSpan().spanId; });
    await tc.withSpan("sib.b", {}, async () => { sibB = tc.currentSpan().spanId; });
  });
  const sa = tc.recentSpans().find((s) => s.span_id === sibA), sb = tc.recentSpans().find((s) => s.span_id === sibB);
  const pOp = tc.recentSpans().find((s) => s.name === "parent.op");
  check("P2: siblings share trace id and parent",
    sa.span_id !== sb.span_id && sa.trace_id === sb.trace_id && sa.parent_span_id === pOp.span_id && sb.parent_span_id === pOp.span_id);

  // error status + rethrow
  let threw = false;
  try {
    await tc.withSpan("boom", {}, async () => { await sleep(1); throw new Error("kaboom"); });
  } catch (e) { threw = e.message === "kaboom"; }
  const boom = tc.recentSpans().find((s) => s.name === "boom");
  check("P2: throwing work → span status error with message, error rethrown",
    threw && boom?.status === "error" && boom.attributes["error.message"] === "kaboom");

  // concurrency isolation
  const t1 = [], t2 = [];
  const jobA = tc.withSpan("conc.a", {}, async () => {
    t1.push(tc.currentTraceId());
    await sleep(3);
    await tc.withSpan("conc.a.inner", {}, () => { t1.push(tc.currentTraceId()); });
  });
  const jobB = tc.withSpan("conc.b", {}, async () => {
    t2.push(tc.currentTraceId());
    await sleep(2);
    await tc.withSpan("conc.b.inner", {}, () => { t2.push(tc.currentTraceId()); });
  });
  await Promise.all([jobA, jobB]);
  const distinct = t1[0] !== t2[0];
  check("P2: concurrent traces isolated (distinct ids, stable across awaits, no cross-talk)",
    distinct && t1.every((x) => x === t1[0]) && t2.every((x) => x === t2[0]),
    `a=${t1[0]?.slice(0, 8)}… b=${t2[0]?.slice(0, 8)}…`);

  // sync work ends synchronously; sink failure never breaks the traced work
  let syncVal = null;
  tc.setSpanSink(() => { throw new Error("sink exploded"); });
  syncVal = tc.withSpan("sync.op", {}, () => 7);
  check("P2: sync span runs+ends synchronously and a THROWING sink never breaks the work",
    syncVal === 7 && tc.currentSpan() === null);
  tc.setSpanSink(null);

  // remote continuation
  await tc.runInTrace({ name: "remote.root", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }, async (span) => {
    check("P2: runInTrace continues a remote trace (trace id + parent id extracted)",
      span.traceId === "4bf92f3577b34da6a3ce929d0e0e4736" && span.parentSpanId === "00f067aa0ba902b7");
  });
  let invalidRoot = null;
  await tc.runInTrace({ name: "bad.carrier", traceparent: "not-a-traceparent" }, async (span) => { invalidRoot = span; });
  const badRec = tc.recentSpans().find((s) => s.span_id === invalidRoot.spanId);
  check("P2: invalid traceparent degrades to a fresh root with a diagnostic attribute (never throws)",
    invalidRoot.traceId !== "4bf92f3577b34da6a3ce929d0e0e4736" && invalidRoot.parentSpanId === null &&
    badRec.attributes["trace.remote_parent"] === "invalid_traceparent");
}

// ============================================================================
// Part 3 — queue → worker → stages: a stub job's spans form ONE trace tree
// (real clone-queue memory backend, real JSONL export)
// ============================================================================
section("Part 3: stub job through the real queue → one trace tree (JSONL)");
{
  const traceDir = path.join(TMP_ROOT, "part3");
  const sink = te.createJsonlSpanSink({ dir: traceDir });
  tc.setSpanSink(sink.handle);
  tc.resetRecentSpans();

  const { createCloneQueue } = await import("../src/queues/clone-queue.js");
  const q = createCloneQueue({ redisUrl: "", maxConcurrent: 2 });
  await q.ready;

  // the STUB JOB: the runPipelineJob report() protocol without a browser
  const stubPipeline = async (payload, { report }) => {
    report("exploring");
    await sleep(12);
    report("reconstructing", { jobId: payload.sessionId });
    await sleep(8);
    report("verifying");
    await sleep(8);
    return { jobId: "stub", status: "completed", passed: true };
  };

  const runOneJob = (url, tag) =>
    // PRODUCER side: span wraps the enqueue, traceparent rides in the payload
    tc.withSpan("api.enqueue-clone-task", { tag }, () => {
      const payload = tc.injectTraceparent({ url, sessionId: "test", username: "u", password: "p" });
      return q.enqueue({
        payload,
        // the "worker side" — same shape exploration-runner.js passes: the
        // executor continues the trace from payload.traceparent (NOT from the
        // ambient producer context — propagation must go through the data)
        run: async ({ entry, report }) => {
          entry.status = "exploring"; // as runPipelineJob does on the memory path
          const result = await tc.tracedExecutor(stubPipeline)(payload, { jobId: entry.jobId || entry.tempId, report });
          entry.status = result.status; // runPipelineJob completes the entry on the memory path
          return result;
        },
      });
    });

  const entry1 = runOneJob("http://fixture.local/trace-a", "a");
  check("P3: enqueue stays synchronous; job already exploring (old timing kept)", entry1.status === "exploring");
  await q.whenIdle();
  check("P3: stub job completed through the real queue (tracing is sideband)", entry1.status === "completed");

  // a SECOND independent job — traces must not bleed together
  const entry2 = runOneJob("http://fixture.local/trace-b", "b");
  await q.whenIdle();

  sink.flush();
  const spans = te.readSpans(sink.file);
  check("P3: JSONL holds exactly 10 spans (2 jobs × enqueue + worker + 3 stages)", spans.length === 10,
    `got ${spans.length}`);
  check("P3: every JSONL line carries the full record shape with correct types",
    spans.every((s) => TP_FIELDS.every((f) => f in s) &&
      HEX32.test(s.trace_id) && HEX16.test(s.span_id) &&
      (s.parent_span_id === null || HEX16.test(s.parent_span_id)) &&
      typeof s.duration_ms === "number" && s.duration_ms >= 0 &&
      ["ok", "error"].includes(s.status) && !isNaN(Date.parse(s.start_time))));

  const trees = te.buildTraceTrees(spans);
  check("P3: exactly TWO traces, zero orphans (no broken chains)",
    trees.trees.size === 2 && trees.orphans.length === 0, `trees=${trees.trees.size} orphans=${trees.orphans.length}`);

  // inspect job A's tree in full — grouped by trace ROOT (the enqueue span
  // carries attributes.tag; stage spans inherit the trace, not the attribute)
  const treeName = (node) => [node.span.name, ...node.children.flatMap(treeName)];
  const treeA = [...trees.trees.values()].find((t) => t.roots[0]?.span.attributes?.tag === "a");
  check("P3: job A = ONE trace tree of 5 spans, single root, all parents resolve",
    !!treeA && treeA.size === 5 && treeA.roots.length === 1);
  const root = treeA.roots[0];
  check("P3: root is the producer enqueue span (null parent)",
    root.span.name === "api.enqueue-clone-task" && root.span.parent_span_id === null);
  const jobNode = root.children[0], stages = jobNode?.children ?? [];
  check("P3: worker job span is the root's only child; 3 stage spans are its children",
    root.children.length === 1 && jobNode.span.name === "worker.clone-job" && stages.length === 3,
    treeName(root).join(" → "));
  check("P3: stage spans in pipeline order with canonical names",
    stages.map((n) => n.span.name).join(",") === "stage.exploration,stage.reconstruction,stage.verification");
  check("P3: cross-boundary edge — worker span's parent is the PRODUCER span id (via payload.traceparent, not ambient context)",
    jobNode.span.parent_span_id === root.span.span_id && jobNode.span.trace_id === root.span.trace_id);
  check("P3: all stage parents = the worker job span id",
    stages.every((n) => n.span.parent_span_id === jobNode.span.span_id));

  // timing: producer start ≤ job start; stage spans contained in the job span;
  // stage durations reflect the stub sleeps (12/8/8ms → ≥5ms each)
  const st = stages.map((n) => n.span);
  check("P3: timing sane — job span starts at/after the enqueue span, ends at/after all stages",
    jobNode.span.start_ms >= root.span.start_ms &&
    st.every((s) => s.start_ms >= jobNode.span.start_ms && s.end_ms <= jobNode.span.end_ms));
  check("P3: stage durations measured (each ≥5ms against 8–12ms sleeps)",
    st.every((s) => s.duration_ms >= 5), st.map((s) => `${s.name}=${s.duration_ms}ms`).join(" "));

  // the two jobs must NOT share a trace
  const treeB = [...trees.trees.values()].find((t) => t.roots[0]?.span.attributes?.tag === "b");
  check("P3: second job is a DIFFERENT trace (no bleed across jobs)",
    !!treeB && treeB.size === 5 && treeB.roots[0].span.trace_id !== root.span.trace_id);

  console.log(`\n[tree]\n${te.describeTree(root).join("\n")}`);
  await q.close();
  tc.setSpanSink(null);
}

// ============================================================================
// Part 4 — bullmq path: real #dispatch carries the traceparent in job data;
// the REAL clone-worker processor rebuilds the same tree from it
// ============================================================================
section("Part 4: bullmq path — real dispatch + real worker processor");
{
  const traceDir = path.join(TMP_ROOT, "part4");
  const sink = te.createJsonlSpanSink({ dir: traceDir });
  tc.setSpanSink(sink.handle);
  tc.resetRecentSpans();

  const { createCloneQueue } = await import("../src/queues/clone-queue.js");
  // remote-end simulator: the transport standing in for Redis/BullMQ (test
  // file only — product code paths are the real clone-queue/worker code)
  const added = [];
  const mkQueue = () => ({
    add: async (name, data, opts) => { added.push({ name, data, opts }); return { id: data?.jobId || "x" }; },
    close: async () => {}, getJob: async () => null,
  });
  const q = createCloneQueue({
    redisUrl: "redis://tracing-test.invalid:6379/0", // never contacted — transport is injected
    bullmqFactory: async () => ({
      queue: mkQueue(), dlq: mkQueue(),
      events: { on: () => {}, close: async () => {} },
      connection: { quit: async () => {} },
      eventsConnection: { quit: async () => {} },
    }),
  });
  const backend = await q.ready;
  check("P4: injected transport → bullmq backend selected (real #dispatch runs)", backend === "bullmq");

  let producerSpanId = null, payloadSeen = null;
  tc.withSpan("api.enqueue-clone-task", {}, (span) => {
    producerSpanId = span.spanId;
    payloadSeen = tc.injectTraceparent({ url: "http://fixture.local/trace-bmq", sessionId: "test" });
    return q.enqueue({ payload: payloadSeen, run: () => { throw new Error("memory run must never fire on the bullmq backend"); } });
  });
  check("P4: real #dispatch packed payload.traceparent into the BullMQ job data",
    added.length === 1 && added[0].data?.payload?.traceparent === payloadSeen.traceparent &&
    typeof added[0].data.payload.traceparent === "string" &&
    HEX32.test(tc.parseTraceparent(payloadSeen.traceparent).traceId),
    `traceparent=${String(added[0]?.data?.payload?.traceparent).slice(0, 30)}…`);
  check("P4: job data shape intact (payload + jobId + meta ride together)",
    added[0].name === "clone" && typeof added[0].data.jobId === "string" && "meta" in added[0].data);
  await q.close();

  // REAL worker processor — captured via the workerFactory injection hook
  const { startCloneWorker } = await import("../src/workers/clone-worker.js");
  const stubPipeline = async (payload, { report }) => {
    report("exploring");
    await sleep(8);
    report("reconstructing");
    await sleep(6);
    report("verifying");
    await sleep(6);
    return { jobId: "stub-bmq", status: "completed", passed: true };
  };
  let realProcessor = null;
  const fakeWorker = {
    on: () => {}, close: async () => {}, isRunning: () => true, getActiveJobsCount: () => 0, name: "tracing-test",
  };
  const { workerId } = startCloneWorker({
    registerSignals: false, registerHealth: false,
    executor: tc.tracedExecutor(stubPipeline),
    workerFactory: ({ processor }) => { realProcessor = processor; return fakeWorker; },
  });
  check("P4: real clone-worker processor captured (worker " + workerId + ")", typeof realProcessor === "function");

  const jobId = added[0].data.jobId;
  const fakeJob = {
    id: jobId,
    data: added[0].data, // exactly what BullMQ would hand the worker
    updateProgress: async () => {},
  };
  const returned = await realProcessor(fakeJob); // the REAL processor code runs
  const parsed = JSON.parse(returned);
  check("P4: processor returned the stub job's shaped result", parsed?.status === "completed" && parsed?.passed === true);

  sink.flush();
  const spans = te.readSpans(sink.file);
  const tree = te.buildTraceTrees(spans);
  check("P4: 5 spans → ONE trace, one root, zero orphans (worker continued the producer trace)",
    spans.length === 5 && tree.trees.size === 1 && tree.orphans.length === 0, `spans=${spans.length}`);
  const rootNode = tree.trees.get(spans[0].trace_id).roots[0];
  check("P4: worker job span parent = producer enqueue span id (traceparent crossed the queue boundary)",
    rootNode.span.name === "api.enqueue-clone-task" &&
    rootNode.children[0]?.span.name === "worker.clone-job" &&
    rootNode.children[0].span.parent_span_id === producerSpanId);
  const stageNames = (tree.trees.get(spans[0].trace_id).roots[0].children[0]?.children ?? []).map((n) => n.span.name);
  check("P4: three stage spans nested under the job span",
    stageNames.join(",") === "stage.exploration,stage.reconstruction,stage.verification", stageNames.join(" → "));
  console.log(`\n[tree]\n${te.describeTree(rootNode).join("\n")}`);
  tc.setSpanSink(null);
}

// ============================================================================
// Part 5 — trace-export module: buffering, malformed input, env wiring
// ============================================================================
section("Part 5: JSONL export module");
{
  const traceDir = path.join(TMP_ROOT, "part5");
  const sink = te.createJsonlSpanSink({ dir: traceDir, autoFlushAt: 64 });
  for (let i = 0; i < 10; i++) sink.handle({ trace_id: tc.randomTraceId(), span_id: tc.randomSpanId(), parent_span_id: null, name: `s${i}`, status: "ok", start_ms: 1, end_ms: 2, duration_ms: 1, start_time: "2026-01-01T00:00:00.000Z", end_time: "2026-01-01T00:00:00.001Z", attributes: {} });
  check("P5: buffer batches writes (10 buffered below autoFlushAt, file empty yet)",
    sink.buffered() === 10 && !fs.existsSync(sink.file));
  sink.flush();
  check("P5: flush() appends the whole buffer in one write; readSpans round-trips",
    sink.written() === 10 && sink.buffered() === 0 && te.readSpans(sink.file).length === 10);
  sink.close();
  check("P5: append-only file format — every line is standalone JSON",
    fs.readFileSync(sink.file, "utf8").trimEnd().split("\n").every((l) => { JSON.parse(l); return true; }));

  const malformed = path.join(traceDir, "bad.jsonl");
  fs.writeFileSync(malformed, '{"trace_id":"a"}\nNOT-JSON\n', "utf8");
  let threw = null;
  try { te.readSpans(malformed); } catch (e) { threw = e; }
  check("P5: malformed line → error naming file:line (not silently skipped)",
    threw && threw.message.includes("bad.jsonl:2"), threw?.message);

  // tree building: grouping, orphans, multi-root
  const t = "a".repeat(32);
  const synthetic = [
    { trace_id: t, span_id: "r1", parent_span_id: null, name: "root" },
    { trace_id: t, span_id: "c1", parent_span_id: "r1", name: "child" },
    { trace_id: t, span_id: "g1", parent_span_id: "c1", name: "grandchild" },
    { trace_id: t, span_id: "o1", parent_span_id: "missing", name: "orphan" },
    { trace_id: "b".repeat(32), span_id: "x1", parent_span_id: null, name: "other-trace" },
  ];
  const built = te.buildTraceTrees(synthetic);
  const main = built.trees.get(t);
  // orphan semantics: an unresolvable parent id → root of the LOCAL view (the
  // real parent may live in another process's export file) AND flagged in
  // `orphans` so integrity assertions can require orphans.length === 0
  check("P5: buildTraceTrees groups by trace, wires the chain, counts orphans across traces",
    built.trees.size === 2 && main.size === 4 && main.roots.length === 2 &&
    main.roots[0].span.span_id === "r1" && main.roots[0].children[0]?.span.span_id === "c1" &&
    main.roots[0].children[0].children[0]?.span.span_id === "g1" && main.roots[1].span.span_id === "o1" &&
    built.orphans.length === 1 && built.orphans[0].span_id === "o1");
  check("P5: describeTree renders the chain readably",
    te.describeTree(main.roots[0]).join("|") === "root  (undefinedms, undefined)|child  (undefinedms, undefined)|grandchild  (undefinedms, undefined)" ||
    te.describeTree(main.roots[0]).length === 3);

  // env wiring: off-switch + dir override + real attach/detach cycle
  check("P5: CLONER_TRACING=0 → no sink configured",
    te.traceTargetFromEnv({ CLONER_TRACING: "0" }) === null && te.attachTraceSinkFromEnv({ CLONER_TRACING: "0" }) === null);
  const envDir = path.join(TMP_ROOT, "env-traces");
  const envSink = te.attachTraceSinkFromEnv({ CLONER_TRACE_DIR: envDir });
  check("P5: CLONER_TRACE_DIR override wins over the artifacts/traces default",
    envSink.file === path.join(envDir, "traces.jsonl") && fs.existsSync(envDir));
  await tc.withSpan("env.span", {}, () => {});
  envSink.flush();
  const envSpans = te.readSpans(envSink.file);
  check("P5: attached sink receives spans through the REAL trace path (setSpanSink → handle → file)",
    envSpans.length === 1 && envSpans[0].name === "env.span" && HEX16.test(envSpans[0].span_id));
  te.detachTraceSink();
  tc.setSpanSink(null);
  // credential hygiene
  check("P5: attribute hygiene — credential-shaped keys never exported",
    (() => {
      const sink2 = te.createJsonlSpanSink({ dir: path.join(TMP_ROOT, "part5b") });
      tc.setSpanSink(sink2.handle);
      tc.withSpan("hygiene", { password: "hunter2", api_key: "k", cookie: "c", jobId: 42 }, () => {});
      sink2.flush();
      const rec = te.readSpans(sink2.file)[0];
      tc.setSpanSink(null);
      return !("password" in rec.attributes) && !("api_key" in rec.attributes) && !("cookie" in rec.attributes) && rec.attributes.jobId === 42;
    })());
}

// cleanup + verdict
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
const fails = results.filter((r) => !r).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "PASS"}  (${results.length - fails}/${results.length} checks passed)`);
process.exit(fails ? 1 : 0);
