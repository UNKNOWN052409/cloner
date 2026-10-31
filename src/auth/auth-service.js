// Auth service (spec §6): registration, login, session tokens, password hashing.
// Uses bcryptjs (pure JS, no native compilation risk on Windows).
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { query, withTransaction } from "../database/client.js";

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function registerUser(email, password) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("valid email required");
  if (!password || password.length < 8) throw new Error("password must be at least 8 characters");
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role, created_at",
    [email.toLowerCase().trim(), hash]
  ).catch((e) => {
    if (e.code === "23505") throw new Error("email already registered");
    throw e;
  });
  return result.rows[0];
}

export async function loginUser(email, password) {
  const result = await query("SELECT id, email, password_hash, role, status FROM users WHERE email = $1", [email?.toLowerCase().trim()]);
  const user = result.rows[0];
  if (!user) throw new Error("invalid credentials");
  if (user.status !== "active") throw new Error("account disabled");
  const valid = await bcrypt.compare(password || "", user.password_hash);
  if (!valid) throw new Error("invalid credentials");
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [user.id, tokenHash, expires]);
  return { token, userId: user.id, email: user.email, role: user.role, expiresAt: expires.toISOString() };
}

export async function validateSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await query(
    `SELECT s.id as session_id, s.expires_at, u.id as user_id, u.email, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, email: row.email, role: row.role, sessionId: row.session_id };
}

export async function revokeSession(token) {
  const tokenHash = hashToken(token);
  await query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [tokenHash]);
}

export async function revokeAllSessions(userId) {
  await query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}
