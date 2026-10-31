// WebSocket upgrade authentication + task-scope authorization (spec §6/§9).
//
// Upgrade path: an OPTIONAL token — `?token=` query param or cookie
// `cloner_session` — is validated against the PostgreSQL sessions table via
// auth-service.validateSession. A DB failure resolves to "unauthenticated"
// (the upgrade never crashes). Unauthenticated upgrades are allowed only from
// loopback — the local dashboard (platform-ui) connects with no token and
// keeps working through the server's "legacy" room; remote ones are refused
// with 401 during the handshake.
//
// Task scoping: ownership is resolved per (task, user) through
// task-repository.getTask(taskId, userId) — a non-null row means the user owns
// the task. v2 exploration jobs (exploration-runner registry) are per-process
// and single-tenant, so the registry answers directly and those tasks are
// treated as public to authenticated users.
import * as exploration from "./exploration-runner.js";
import * as taskRepo from "../database/task-repository.js";
import { validateSession } from "../auth/auth-service.js";

// DB task ids are UUIDs (migrations/001-initial.sql); legacy task ids ("t…")
// and v2 job ids ("exp-…") live outside that namespace — querying them would
// make PostgreSQL throw on the uuid cast, so they are short-circuited here.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TTL_MS = 30_000;  // how long a (task, user) ownership verdict is trusted
const ACCESS_CACHE_MAX = 500;  // task entries kept before the oldest is dropped

const accessCache = new Map(); // taskId -> { at, users: Map<userId, boolean> }

// ---- upgrade authentication ------------------------------------------------

export function extractToken(req) {
  // 1. explicit ?token= query param  2. cookie `cloner_session`
  try {
    const qp = new URL(req.url || "/", "http://ws-auth.local").searchParams.get("token");
    if (qp) return qp;
  } catch { /* malformed url → fall through to the cookie */ }
  const header = req?.headers?.cookie;
  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== "cloner_session") continue;
      const value = part.slice(eq + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return null;
}

// Resolves { userId, role, email } for a valid session token, else null.
// NEVER throws: a PostgreSQL outage is treated as "unauthenticated".
export async function authenticateUpgrade(req) {
  const token = extractToken(req);
  if (!token) return null;
  try {
    const session = await validateSession(token);
    if (!session) return null;
    return { userId: session.userId, email: session.email, role: session.role };
  } catch {
    return null; // DB unavailable → unauthenticated, never crash the upgrade
  }
}

// True for 127.0.0.0/8, ::1 and IPv4-mapped IPv6 loopback forms.
export function isLoopback(address) {
  if (!address) return false;
  let a = String(address).toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  return a === "::1" || a.startsWith("127.");
}

// ---- task-scope authorization ----------------------------------------------

// True when the exploration-runner registry knows this id (jobId or tempId
// alias). The registry is per-process and single-tenant → its tasks are public
// to authenticated users.
export function isExplorationTask(taskId) {
  if (!taskId || typeof taskId !== "string") return false;
  try { return !!exploration.getExplorationJob(taskId); } catch { return false; }
}

// Memoized ownership verdict for one (task, user) pair via the task repository.
async function userCanAccess(taskId, userId) {
  if (!taskId || !userId) return false;
  const now = Date.now();
  let entry = accessCache.get(taskId);
  if (!entry || now - entry.at > ACCESS_TTL_MS) {
    entry = { at: now, users: new Map() };
    if (accessCache.size >= ACCESS_CACHE_MAX) { // bound: drop the oldest task entry
      const oldest = accessCache.keys().next().value;
      if (oldest !== undefined) accessCache.delete(oldest);
    }
    accessCache.set(taskId, entry);
  }
  if (entry.users.has(userId)) return entry.users.get(userId);
  let ok = false;
  let cacheable = true;
  try {
    if (isExplorationTask(taskId)) ok = true; // single-tenant registry → public
    else if (UUID_RE.test(taskId)) ok = !!(await taskRepo.getTask(taskId, userId));
    // anything else is outside the DB id namespace → not a DB-owned task
  } catch {
    ok = false;        // DB unavailable → fail closed for this user …
    cacheable = false; // …and re-check once the DB is back
  }
  if (cacheable) entry.users.set(userId, ok);
  return ok;
}

// Per-identity access check (used for client "join" subscriptions).
export async function canAccessTask(taskId, identity) {
  if (!identity?.userId) return false;
  return userCanAccess(taskId, identity.userId);
}

// Set of userIds (from the given candidates) authorized for a task. For
// registry tasks every authenticated user is authorized; otherwise each
// candidate is checked against the task repository.
export async function authorizedUserIds(taskId, userIds) {
  const out = new Set();
  if (!taskId || !Array.isArray(userIds) || !userIds.length) return out;
  if (isExplorationTask(taskId)) {
    for (const id of userIds) out.add(id);
    return out;
  }
  const verdicts = await Promise.all(userIds.map((u) => userCanAccess(taskId, u)));
  userIds.forEach((u, i) => { if (verdicts[i]) out.add(u); });
  return out;
}

// Catchup replay scoping: unchanged (full ring buffer) for the legacy
// dashboard; for authenticated sockets buffered events tagged with a job id
// are kept only when that identity may access the job. Untagged (global)
// events always pass.
export async function scopedCatchup(catchup, identity) {
  if (!catchup || !identity) return catchup;
  const events = Array.isArray(catchup.events) ? catchup.events : [];
  const keep = [];
  for (const evt of events) {
    if (!evt?.job || (await canAccessTask(evt.job, identity))) keep.push(evt);
  }
  return { ...catchup, events: keep };
}
