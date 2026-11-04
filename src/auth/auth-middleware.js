// Auth middleware: derives user identity from a server-side session token.
// Never trusts a userId from the request body (spec §6).
//
// HEADER-ONLY (hunt G5.3 fix): session tokens are accepted from the
// Authorization header ONLY. The old `?token=` query fallback leaked bearer
// tokens into access logs, proxy logs and the Referer header — a full
// session-hijack primitive from a single logged request. WebSocket upgrades
// keep their ?token=/cookie path in platform/ws-auth.js (browsers cannot set
// WS headers); every HTTP route is header-only from here.
import crypto from "node:crypto";
import { validateSession } from "./auth-service.js";

export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "authentication required (Authorization: Bearer <token>)" });
  const token = header.slice(7);
  validateSession(token).then((session) => {
    if (!session) return res.status(401).json({ error: "invalid or expired session" });
    req.userId = session.userId;
    req.userEmail = session.email;
    req.userRole = session.role;
    next();
  }).catch(() => res.status(500).json({ error: "auth check failed" }));
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return next();
  validateSession(header.slice(7)).then((session) => {
    if (session) { req.userId = session.userId; req.userEmail = session.email; }
    next();
  }).catch(() => next());
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.userRole !== role && req.userRole !== "admin") return res.status(403).json({ error: "insufficient permissions" });
    next();
  };
}

// Stable non-reversible fingerprint for audit/logging: shows WHICH token was
// used without ever storing a usable credential. UUID-shaped on purpose —
// audit_events.session_id is a UUID column, and the old code stored the RAW
// token there (64-hex → the write silently failed; G5.3 stores a real,
// deterministic UUIDv4-shaped fingerprint derived from sha256(token)).
export function tokenFingerprint(token) {
  if (!token) return null;
  const h = crypto.createHash("sha256").update(String(token)).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),                 // version 4 nibble
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), // variant bits
    h.slice(20, 32),
  ].join("-");
}
