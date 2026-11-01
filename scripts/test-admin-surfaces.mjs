#!/usr/bin/env node
// Admin surfaces e2e (task 4.0.8).
//
// Boots a real express app on an EPHEMERAL port with src/platform/admin-routes.js
// mounted at /api/admin, backed by the REAL PostgreSQL (compose instance, port
// 5433) and the REAL auth middleware/auth-service — the only injected pieces
// are the interfaces owned by parallel tasks: the 4.0.9 audit service, the
// queue (cancel) adapter, the 4.0.6 api-keys store and the retention sweep.
//
// Asserts (per the ask):
//   • no token → 401; non-admin (member role) → 403 on EVERY admin route,
//     and each denial emits an admin.access.denied audit event
//   • admin flows work: list users (no password hashes leak), user detail,
//     org listing (tolerant of the 4.0.2 schema), list/view any task read-only
//     (owner email surfaced), quota adjust + persist, api-key revoke (mock
//     store), retention sweep (mock sweep)
//   • forced cancel propagates: POST /tasks/:id/cancel goes through the queue
//     adapter (mock records the call) AND the persistent task row flips to
//     'cancelled' with a task.cancelled_by_admin event
//   • default queue adapter against the REAL memory clone-queue: cancel flips
//     the live registry entry to 'cancelled'
//   • every successful admin action emits exactly one audit event through the
//     injected audit interface, with actor + correlationId + outcome
//
// Runtime-generated throwaway passwords only — nothing hardcoded. If the
// compose PostgreSQL is unreachable the test prints a SKIP line and exits 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data / artifacts/ are cwd-relative

// dynamic imports AFTER chdir (tasks.js pins ROOT to process.cwd() at load)
const { migrate, query, closePool } = await import("../src/database/client.js");
const auth = await import("../src/auth/auth-service.js");
const taskRepo = await import("../src/database/task-repository.js");
const { adminRouter } = await import("../src/platform/admin-routes.js");
const { createAdminService, createMemoryAudit, createQueueAdapter, auditBridgeFromAuditService } = await import("../src/platform/admin-service.js");
const { createCloneQueue } = await import("../src/queues/clone-queue.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("FAIL  global timeout (120s)"); process.exit(1); }, 120_000);
watchdog.unref();

// ---------- PostgreSQL reachability (compose instance) ----------
try {
  await query("SELECT 1");
} catch (e) {
  console.log(`SKIP  test-admin-surfaces — compose PostgreSQL unreachable (${String(e?.code || e?.message || e).slice(0, 80)}); start it with: docker compose up -d postgres`);
  process.exit(0);
}
await migrate();

// ---------- injected interfaces (parallel-task stand-ins) ----------
const audit = createMemoryAudit(); // 4.0.9 stand-in: records every event in memory
const mockQueue = {
  known: new Set(), // 4.0.3/BullMQ stand-in: only cancels jobs it actually holds
  cancelled: [],
  async cancel(jobId) {
    if (!this.known.has(jobId)) return false; // unknown job → adapter reports failure
    this.cancelled.push(jobId);
    return true;
  },
};
const mockApiKeys = {
  revoked: [], // 4.0.6 stand-in
  async revoke(keyId) { this.revoked.push(keyId); return { revoked: true, keyId }; },
};
const mockSwept = ["t-mock-sweep-1"]; // retention stand-in
const mockSweep = async () => mockSwept;

// ---------- app under test: real router, real auth, real DB ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/admin", adminRouter({ queue: mockQueue, audit, apiKeys: mockApiKeys, retentionSweep: mockSweep }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`admin test app on :${port}`);

async function api(token, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

try {
  // ---------- seed: one admin, one regular member, one running task ----------
  const stamp = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const mkUser = async (letter) => {
    const email = `admin-test-${letter}-${stamp}@test.local`;
    const password = crypto.randomBytes(12).toString("base64url"); // never logged, never stored in this file
    await auth.registerUser(email, password);
    const login = await auth.loginUser(email, password);
    return { email, token: login.token, userId: login.userId };
  };
  const member = await mkUser("member");
  const admin = await mkUser("adminroot");
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.userId]); // no admin-registration route exists by design

  const runningTask = await taskRepo.createTask({ userId: member.userId, url: "https://admin-test-target.invalid/", options: {} });
  await query("UPDATE tasks SET status = 'running', current_stage = 'exploration' WHERE id = $1", [runningTask.id]);
  mockQueue.known.add(runningTask.id); // the (mock) queue holds this running job
  check("seed: admin + member users and a RUNNING task created", !!member.token && !!admin.token && !!runningTask?.id);

  // ---------- 401: no token ----------
  const noToken = await api(null, "GET", "/api/admin/users");
  check("auth: admin API without token → 401", noToken.status === 401, `status=${noToken.status}`);

  // ---------- 403: every admin route rejects a non-admin, denials audited ----------
  const deniedRoutes = [
    ["GET", "/api/admin/users"],
    ["GET", `/api/admin/users/${admin.userId}`],
    ["GET", "/api/admin/orgs"],
    ["GET", "/api/admin/tasks"],
    ["GET", `/api/admin/tasks/${runningTask.id}`],
    ["POST", `/api/admin/tasks/${runningTask.id}/cancel`],
    ["PUT", `/api/admin/users/${member.userId}/quota`],
    ["GET", `/api/admin/users/${member.userId}/quota`],
    ["POST", "/api/admin/api-keys/some-key/revoke"],
    ["POST", "/api/admin/retention/sweep"],
  ];
  let allDenied = true;
  for (const [method, p] of deniedRoutes) {
    const r = await api(member.token, method, p, method === "POST" || method === "PUT" ? {} : undefined);
    if (r.status !== 403) { allDenied = false; console.log(`      ${method} ${p} → ${r.status} (expected 403)`); }
  }
  check("authz: non-admin gets 403 on all 10 admin routes (server-side enforcement)", allDenied);
  const denials = audit.events.filter((e) => e.action === "admin.access" && e.outcome === "denied");
  check("audit: every denial emitted an admin.access/denied event (4.0.9 schema)", denials.length >= deniedRoutes.length,
    `${denials.length} denial events for ${deniedRoutes.length} attempts`);
  check("audit: denial events carry actor + correlationId + operation",
    denials.every((e) => e.actorId === member.userId && e.correlationId && e.metadata?.operation));

  // ---------- admin flows ----------
  const users = await api(admin.token, "GET", "/api/admin/users");
  check("users: admin lists users", users.status === 200 && users.json?.total >= 2 && Array.isArray(users.json?.users), `total=${users.json?.total}`);
  check("users: no password hashes leak through the admin surface",
    users.json?.users?.length && users.json.users.every((u) => !("password_hash" in u) && !("passwordHash" in u)));
  check("users: task_count surfaced per user", users.json?.users?.some((u) => u.id === member.userId && Number(u.task_count) >= 1));

  const userDetail = await api(admin.token, "GET", `/api/admin/users/${member.userId}`);
  check("users: admin views a single user", userDetail.status === 200 && userDetail.json?.user?.email === member.email);
  const badUser = await api(admin.token, "GET", `/api/admin/users/not-a-uuid`);
  check("users: malformed id → 400 (audited as error)", badUser.status === 400);

  const orgs = await api(admin.token, "GET", "/api/admin/orgs");
  check("orgs: listing tolerant of 4.0.2 schema state (available flag or rows)",
    orgs.status === 200 && typeof orgs.json?.available === "boolean" && Array.isArray(orgs.json?.organizations),
    `available=${orgs.json?.available} count=${orgs.json?.organizations?.length}`);

  const allTasks = await api(admin.token, "GET", "/api/admin/tasks");
  check("tasks: admin lists ALL users' tasks with owner email",
    allTasks.status === 200 && allTasks.json?.tasks?.some((t) => t.id === runningTask.id && t.owner_email === member.email));

  const taskView = await api(admin.token, "GET", `/api/admin/tasks/${runningTask.id}`);
  check("tasks: read-only view of another user's task (stages + events + artifacts)",
    taskView.status === 200 && taskView.json?.task?.user_id === member.userId
      && Array.isArray(taskView.json?.stages) && Array.isArray(taskView.json?.events) && Array.isArray(taskView.json?.artifacts));

  // ---------- force cancel: queue adapter + task status propagation ----------
  const cancel = await api(admin.token, "POST", `/api/admin/tasks/${runningTask.id}/cancel`, { reason: "admin-test-cancel" });
  check("cancel: force-cancel accepted for a running task", cancel.status === 200 && cancel.json?.taskId === runningTask.id,
    `status=${cancel.status} ${cancel.json ? JSON.stringify({ queueCancelled: cancel.json.queueCancelled }) : cancel.text.slice(0, 80)}`);
  check("cancel: propagated through the queue adapter", mockQueue.cancelled.includes(runningTask.id),
    `adapter saw [${mockQueue.cancelled.join(", ")}]`);
  const after = await query("SELECT status FROM tasks WHERE id = $1", [runningTask.id]);
  check("cancel: task status propagated to 'cancelled' in PostgreSQL", after.rows[0]?.status === "cancelled", `status=${after.rows[0]?.status}`);
  const evt = await query("SELECT payload FROM task_events WHERE task_id = $1 AND event_type = 'task.cancelled_by_admin'", [runningTask.id]);
  check("cancel: task.cancelled_by_admin event written with actor", evt.rows.length >= 1 && evt.rows[0].payload?.byAdminId === admin.userId);
  const cancelAudit = audit.events.find((e) => e.metadata?.operation === "admin.tasks.cancel" && e.outcome === "success");
  check("cancel: admin.tasks.cancel audit event emitted (success outcome)", !!cancelAudit && cancelAudit.actorId === admin.userId && !!cancelAudit.correlationId && cancelAudit.action === "admin.action");
  const reCancel = await api(admin.token, "POST", `/api/admin/tasks/${runningTask.id}/cancel`);
  check("cancel: re-cancelling a terminal task → 409", reCancel.status === 409, `status=${reCancel.status}`);
  const ghost = await api(admin.token, "POST", `/api/admin/tasks/${crypto.randomUUID()}/cancel`);
  check("cancel: unknown task/job → 404", ghost.status === 404, `status=${ghost.status}`);

  // ---------- quotas ----------
  const quotaSet = await api(admin.token, "PUT", `/api/admin/users/${member.userId}/quota`, { quota: { maxTasksPerDay: 5, maxStorageMb: 256 } });
  check("quota: admin adjusts a user's quotas", quotaSet.status === 200 && quotaSet.json?.quota?.maxTasksPerDay === 5, `status=${quotaSet.status}`);
  const quotaGet = await api(admin.token, "GET", `/api/admin/users/${member.userId}/quota`);
  check("quota: quotas persist across reads", quotaGet.status === 200 && quotaGet.json?.quota?.maxTasksPerDay === 5 && quotaGet.json?.quota?.maxStorageMb === 256);
  const quotaBad = await api(admin.token, "PUT", `/api/admin/users/${member.userId}/quota`, { quota: { evil: "not-a-number" } });
  check("quota: non-numeric quota value → 400", quotaBad.status === 400, `status=${quotaBad.status}`);

  // ---------- api keys (mock 4.0.6 store) ----------
  const keyId = `key-${crypto.randomBytes(4).toString("hex")}`;
  const revoke = await api(admin.token, "POST", `/api/admin/api-keys/${keyId}/revoke`);
  check("api-keys: admin revokes a key through the injected store", revoke.status === 200 && revoke.json?.revoked === true && mockApiKeys.revoked.includes(keyId));
  const revokeAudit = audit.events.filter((e) => e.metadata?.operation === "admin.api_keys.revoke");
  check("api-keys: revoke audited", revokeAudit.length >= 1 && revokeAudit.some((e) => e.targetId === keyId && e.outcome === "success"));

  // ---------- retention sweep (mock) ----------
  const sweep = await api(admin.token, "POST", "/api/admin/retention/sweep");
  check("retention: sweep triggers the injected sweeper and reports results", sweep.status === 200 && sweep.json?.swept === mockSwept.length && sweep.json?.ids?.[0] === mockSwept[0]);
  const sweepAudit = audit.events.find((e) => e.metadata?.operation === "admin.retention.sweep" && e.outcome === "success");
  check("retention: sweep audited", !!sweepAudit && sweepAudit.action === "admin.action");

  // ---------- default queue adapter against the REAL memory clone-queue ----------
  const realQueue = createCloneQueue({ redisUrl: "" }); // memory backend, no Redis dependency
  let releaseJob;
  const gate = new Promise((r) => { releaseJob = r; });
  const entry = realQueue.enqueue({ payload: { url: "https://adapter-test.invalid/" }, run: () => gate });
  const adapter = createQueueAdapter(realQueue);
  const cancelledReal = await adapter.cancel(entry.tempId);
  check("queue-adapter: default adapter cancels a RUNNING job on the real memory queue", cancelledReal && realQueue.getEntry(entry.tempId)?.status === "cancelled",
    `entry.status=${realQueue.getEntry(entry.tempId)?.status}`);
  let sawStatusEvent = false;
  const off = realQueue.onStatus((s) => { if (s.status === "cancelled") sawStatusEvent = true; });
  const entry2 = realQueue.enqueue({ payload: { url: "https://adapter-test-2.invalid/" }, run: () => gate });
  await adapter.cancel(entry2.tempId);
  await sleep(100);
  off();
  check("queue-adapter: cancel re-emits a 'cancelled' status event on the queue channel", sawStatusEvent);
  releaseJob(); // let the gated runs settle

  // ---------- default api-keys adapter: explicit not-provisioned behavior ----------
  // (4.0.6 may or may not have migrated its table by now — both states must
  // degrade cleanly: 503 not-provisioned, or a clean not-found result)
  const svc = createAdminService({ audit: createMemoryAudit() });
  let defaultKeysDegradeCleanly = false;
  try {
    const r = await svc.revokeApiKey("probe-nonexistent-key", { actor: { id: admin.userId, email: admin.email } });
    defaultKeysDegradeCleanly = r?.revoked === false && !!r.reason;
  } catch (e) {
    defaultKeysDegradeCleanly = e.status === 503 || /not provisioned|not found/i.test(String(e.message));
  }
  check("api-keys: default adapter degrades explicitly (503 not-provisioned or clean not-found) — no schema guessing crash", defaultKeysDegradeCleanly);

  // ---------- audit coverage across every successful admin action ----------
  const successes = audit.events.filter((e) => e.outcome === "success");
  const expectedOperations = ["admin.users.list", "admin.users.get", "admin.orgs.list", "admin.tasks.list", "admin.tasks.get",
    "admin.tasks.cancel", "admin.users.quota.update", "admin.users.quota.get", "admin.api_keys.revoke", "admin.retention.sweep"];
  const seenOps = new Set(successes.map((e) => e.metadata?.operation));
  const missingOps = expectedOperations.filter((o) => !seenOps.has(o));
  check("audit: all 10 admin operation types emitted success events in this run", missingOps.length === 0,
    missingOps.length ? `missing: ${missingOps.join(", ")}` : `${seenOps.size} distinct operations`);
  check("audit: every success event carries actorId + actorEmail + correlationId + schemaVersion=1",
    successes.every((e) => e.actorId === admin.userId && e.actorEmail === admin.email && e.correlationId && e.schemaVersion === 1));
  const reads = ["admin.users.list", "admin.users.get", "admin.orgs.list", "admin.tasks.list", "admin.tasks.get", "admin.users.quota.get"];
  const familyOk = successes.every((e) =>
    (reads.includes(e.metadata?.operation) ? e.action === "admin.access" : e.action === "admin.action"));
  check("audit: action family conforms to the 4.0.9 allowlist (reads → admin.access, mutations → admin.action)", familyOk,
    [...new Set(successes.filter((e) => !familyOk).map((e) => e.metadata?.operation))].join(", ") || "all conform");

  // ---------- REAL 4.0.9 audit-service acceptance (injected via the bridge) ----------
  // The parallel task's audit-service is landed: record one event through
  // auditBridgeFromAuditService → recordAuditEventSafe and confirm it actually
  // hit the append-only audit_events table (allowlist + redaction + hash chain).
  const auditService = await import("../src/platform/audit-service.js");
  // no retentionSweep injected here → exercises the REAL default path (lazy
  // import of src/platform/tasks.js → sweepExpired over platform-data/)
  const svcReal = createAdminService({ audit: auditBridgeFromAuditService(auditService) });
  const realActor = { id: admin.userId, email: admin.email, correlationId: crypto.randomUUID() };
  await svcReal.getQuota(admin.userId, { actor: realActor });
  const chainRow = await query(
    `SELECT action, outcome, actor_id, metadata FROM audit_events
     WHERE actor_id = $1 AND metadata->>'operation' = 'admin.users.quota.get'
     ORDER BY id DESC LIMIT 1`,
    [admin.userId]
  );
  check("audit-bridge: REAL 4.0.9 audit-service accepted the event and persisted it (allowlist-conformant)",
    chainRow.rows.length === 1 && chainRow.rows[0].action === "admin.access" && chainRow.rows[0].outcome === "success"
      && chainRow.rows[0].actor_id === admin.userId,
    chainRow.rows.length ? `action=${chainRow.rows[0].action}` : "row not found in audit_events");
  const realSweep = await svcReal.triggerRetentionSweep({ actor: realActor });
  check("retention: default sweep path (src/platform/tasks.js sweepExpired) runs under the admin service", realSweep && typeof realSweep.swept === "number", `swept=${realSweep?.swept}`);
} finally {
  await sleep(50);
  server.close();
  await closePool().catch(() => {});
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : " — ALL PASS"}`);
process.exit(failed ? 1 : 0);
