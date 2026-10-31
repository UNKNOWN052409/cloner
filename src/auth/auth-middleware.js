// Auth middleware: derives user identity from server-side session token.
// Never trusts a userId from the request body (spec §6).
import { validateSession } from "./auth-service.js";

export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query?.token;
  if (!token) return res.status(401).json({ error: "authentication required" });
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
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  validateSession(token).then((session) => {
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
