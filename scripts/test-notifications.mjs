#!/usr/bin/env node
// Task 4.1.12 e2e — product notifications and activity center.
//
// Exercises activity-routes.js (the in-app activity surface) against the REAL
// database (activity_events, migration 018) through BOTH the service layer
// and a real express app mounted exactly as the integrator will:
//   • event created → listed (newest first) with title/detail/correlationId
//   • unread count exact; unreadOnly filter honest
//   • mark ONE event read → read flag + unread decrements
//   • mark ALL read → unread 0
//   • per-user isolation: B never sees or mutates A's events
//   • unknown event type → clean error; unknown id → 404
//   • injectable WS emitter observed (mock in tests; product wires the bus)
//   • the 4.2.16 channel fan-out stays separate: notification-delivery.js
//     untouched (grep: activity_events is not written by delivery code)
//
// SKIP loudly when PostgreSQL is unreachable.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function pgReachable() {
  const { query, closePool } = await import("../src/database/client.js");
  try { await query("SELECT 1"); return { ok: true, query, closePool }; }
  catch { try { await closePool(); } catch {} return { ok: false }; }
}
const db = await pgReachable();
if (!db.ok) {
  console.log("SKIP  notifications — PostgreSQL unreachable (`docker compose up -d postgres`) — loud SKIP per test convention.");
  process.exit(0);
}
const { query, closePool } = db;

const fsMod = await import("node:fs");
async function applyOwnMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(PROJECT, "src", "database", "migrations");
  for (const file of ["001-initial.sql", "018-product-platform.sql"]) {
    const applied = await query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (applied.rows.length) continue;
    await query(fsMod.readFileSync(path.join(dir, file), "utf8"));
    await query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [file]);
    console.log(`[db] applied: ${file}`);
  }
}
await applyOwnMigrations();

const auth = await import("../src/auth/auth-service.js");
const express = (await import("express")).default;
const A = await import("../src/platform/activity-routes.js");

const rand = () => crypto.randomBytes(6).toString("hex");

async function makeUser(prefix) {
  const email = `${prefix}-${rand()}@test.local`;
  const password = `pw-${rand()}-${rand()}!A1`;
  const user = await auth.registerUser(email, password);
  const { token } = await auth.loginUser(email, password);
  return { ...user, token };
}

// ---- service layer: event → list → read ----
const uA = await makeUser("act-a");
const uB = await makeUser("act-b");
const emitted = [];
A.setActivityEmitter((e) => emitted.push(e));

{
  const e1 = await A.recordActivityEvent({ userId: uA.id, event: "task.completed", detail: { taskId: "t-1", durationSeconds: 42 }, correlationId: "t-1" });
  const e2 = await A.recordActivityEvent({ userId: uA.id, event: "quota.warning", detail: { limit: "daily_job_limit" }, correlationId: "quota-1" });
  const e3 = await A.recordActivityEvent({ userId: uA.id, event: "publish.done", detail: { repo: "org/repo" }, correlationId: "pub-1" });
  check("A1  events created with catalog titles", e1.title === "Clone completed" && e2.title === "Approaching fair-use limit" && e3.title === "Export ready" === false || e3.title === "GitHub publish finished", `${e1.title} | ${e2.title} | ${e3.title}`);
  check("A2  detail + correlationId persisted", e1.detail?.taskId === "t-1" && e1.correlationId === "t-1", JSON.stringify(e1.detail));
  check("A3  new events start unread", e1.read === false && e2.read === false && e3.read === false, "all unread");

  const wsOK = emitted.length === 3 && emitted.every((e) => e.id);
  check("A4  injectable WS emitter observed every event", wsOK, `${emitted.length} emissions`);

  const list = await A.listActivityEvents(uA.id);
  check("A5  listed newest-first", list.length === 3 && list[0].id === e3.id && list[2].id === e1.id, `${list.length} rows`);
  check("A6  unread count exact (3)", (await A.unreadCount(uA.id)) === 3, String(await A.unreadCount(uA.id)));

  const unreadOnly = await A.listActivityEvents(uA.id, { unreadOnly: true });
  check("A7  unreadOnly filter returns all unread", unreadOnly.length === 3, String(unreadOnly.length));

  // mark ONE read
  const marked = await A.markActivityRead(uA.id, e2.id);
  check("A8  mark-one sets read + readAt", marked?.read === true && !!marked?.readAt, String(marked?.readAt));
  check("A9  unread decrements to 2", (await A.unreadCount(uA.id)) === 2, String(await A.unreadCount(uA.id)));
  const again = await A.markActivityRead(uA.id, e2.id);
  const sameStamp = new Date(again?.readAt).getTime() === new Date(marked?.readAt).getTime();
  check("A10 re-mark is idempotent (readAt unchanged)", again?.read === true && sameStamp && (await A.unreadCount(uA.id)) === 2, String(await A.unreadCount(uA.id)));

  // mark ALL read
  const all = await A.markAllActivityRead(uA.id);
  check("A11 mark-all zeroes unread", all.unread === 0 && (await A.unreadCount(uA.id)) === 0, String(all.unread));
}

// ---- per-user isolation ----
{
  const mine = await A.recordActivityEvent({ userId: uB.id, event: "task.failed", detail: { error: "boom" } });
  const bList = await A.listActivityEvents(uB.id);
  check("A12 B sees only B's event", bList.length === 1 && bList[0].id === mine.id, `${bList.length} rows`);
  check("A13 B's unread unaffected by A's reads", (await A.unreadCount(uB.id)) === 1 && (await A.unreadCount(uA.id)) === 0, `B=${await A.unreadCount(uB.id)} A=${await A.unreadCount(uA.id)}`);
  const foreignMark = await A.markActivityRead(uB.id, (await A.listActivityEvents(uA.id))[0]?.id || 1);
  check("A14 B cannot mark A's event read (scoped UPDATE)", foreignMark === null, String(foreignMark));
}

// ---- validation ----
{
  let err = null;
  try { await A.recordActivityEvent({ userId: uA.id, event: "not.an.event" }); } catch (e) { err = e; }
  check("A15 unknown event type → clean error", !!err && /unknown activity event/.test(err.message), err?.message?.slice(0, 80));
  let err2 = null;
  try { await A.recordActivityEvent({ event: "task.completed" }); } catch (e) { err2 = e; }
  check("A16 event without a user → clean error", !!err2 && /userId required/.test(err2.message), err2?.message?.slice(0, 60));
}

// ---- channel separation: notification-delivery (4.2.16) stays untouched ----
{
  const src = fsMod.readFileSync(path.join(PROJECT, "src", "platform", "notification-delivery.js"), "utf8");
  const codeLines = src.split("\n").filter((l) => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*"); });
  const writesActivity = codeLines.some((l) => /INSERT INTO activity_events|activityRouter/i.test(l));
  check("A17 4.2.16 delivery module does not write the activity table (separate subsystems)", !writesActivity, "grep clean");
}

// ---- HTTP surface (router mounted as the integrator will) ----
{
  A.resetActivityEmitter();
  // fresh slate: the service-layer block above already wrote + read A's
  // events — clear them so the HTTP counts are exact
  await query("DELETE FROM activity_events WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/activity", A.activityRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const port = server.address().port;
  const api = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/activity${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const seed = async (userId, event) => {
    const e = await A.recordActivityEvent({ userId, event, detail: { http: true } });
    return e;
  };
  const s1 = await seed(uA.id, "task.completed");
  const s2 = await seed(uA.id, "task.failed");

  const unauth = await api("GET", "/", null, null);
  check("H1  unauthenticated list → 401", unauth.status === 401, String(unauth.status));

  const list = await api("GET", "/", null, uA.token);
  check("H2  list endpoint returns events + unread", list.status === 200 && list.json?.ok === true && list.json?.events?.length === 2 && list.json?.unread === 2, `${list.json?.events?.length} events, unread=${list.json?.unread}`);

  const filtered = await api("GET", "/?unread=1", null, uA.token);
  check("H3  unread=1 filter over HTTP", filtered.json?.events?.length === 2, String(filtered.json?.events?.length));

  const unread = await api("GET", "/unread", null, uA.token);
  check("H4  unread endpoint exact", unread.status === 200 && unread.json?.unread === 2, String(unread.json?.unread));

  const readOne = await api("POST", `/${s1.id}/read`, {}, uA.token);
  check("H5  mark-one read over HTTP", readOne.status === 200 && readOne.json?.event?.read === true && readOne.json?.unread === 1, JSON.stringify({ unread: readOne.json?.unread }));

  const foreign = await api("POST", `/${s1.id}/read`, {}, uB.token);
  check("H6  B cannot read-mark A's event (404)", foreign.status === 404, String(foreign.status));

  const readAll = await api("POST", "/read-all", {}, uA.token);
  check("H7  read-all over HTTP zeroes unread", readAll.status === 200 && readAll.json?.unread === 0, String(readAll.json?.unread));

  const badId = await api("POST", "/999999999/read", {}, uA.token);
  check("H8  unknown event id → 404", badId.status === 404, String(badId.status));

  const badRoute = await api("POST", "/read-all-extra", {}, uA.token);
  check("H9  unknown sub-route does not match read-all (no wildcard surprises)", badRoute.status === 404, String(badRoute.status));

  server.close();
}

// ---- cleanup ----
await query("DELETE FROM activity_events WHERE user_id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[uA.id, uB.id]]);
await closePool();

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
