// Shared wire contracts for distributed execution (task 4.2.1).
//
// Every region node and every coordinator imports THIS module, so the data
// crossing a region boundary has exactly one definition: an execution request,
// an execution result, an artifact envelope/manifest, and the region↔region
// auth token. Nothing here performs I/O — validation, normalization, and real
// crypto (HMAC-SHA256 tokens, SHA-256 digests) only.
//
// Wire compatibility rule (used by the handshake in region-registry.js):
//   same major  → compatible (minor differences are additive, allowed);
//   other major → incompatible, the handshake fails closed.
//
// Error model: validation helpers return { ok, error, value, code }; auth
// failures throw RegionAuthError (code ∈ AUTH_CODES) with status 401 so both
// the region node and the client can map them to HTTP uniformly.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Version + capabilities vocabulary
// ---------------------------------------------------------------------------

export const CONTRACT_VERSION = "4.2.1";

// Capabilities a region (or a worker in a region) can advertise. The list is
// the shared vocabulary; unknown strings are still accepted (forward
// compatibility) but must match the token pattern below.
export const KNOWN_CAPABILITIES = [
  "clone:url",        // headless exploration + reconstruction of a public URL
  "clone:auth",       // can run authenticated (cookie/credential) clones
  "clone:video",      // video-mode clones (transcription capable)
  "vision:polish",    // model-backed visual polish rounds
  "export:zip",       // ZIP export finalization
  "artifact:store",   // accepts artifact uploads (POST /v1/artifacts)
];

// Region/worker identifiers: lowercase alphanumeric + dashes.
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Capability tokens: letters/digits plus ":", "_", "-" (e.g. clone:auth).
export const CAP_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/i;
// Artifact names are basenames only (no traversal, no absolute paths).
export const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Job ids travel in URLs — restricted charset, generous length.
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const AUTH_CODES = ["missing", "malformed", "bad_signature", "expired", "bad_audience", "bad_issuer", "no_secret"];

export class RegionAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegionAuthError";
    this.code = code;
    this.status = 401;
  }
}

export class RegionContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegionContractError";
    this.code = code;
    this.status = 400;
  }
}

// --- version compatibility -------------------------------------------------

export function parseVersion(v) {
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new RegionContractError("bad_version", `contract version must be "major.minor.patch", got ${JSON.stringify(v)}`);
  }
  const [major, minor, patch] = v.split(".").map((n) => Number(n));
  return { major, minor, patch };
}

// Same major = wire compatible. Minor/patch differences are additive and
// allowed in both directions; the result flags minorMismatch for callers that
// want to log it. Anything malformed throws (fail closed).
export function checkCompatibility(remoteVersion, localVersion = CONTRACT_VERSION) {
  const a = parseVersion(remoteVersion);
  const b = parseVersion(localVersion);
  const compatible = a.major === b.major;
  return { compatible, minorMismatch: compatible && a.minor !== b.minor, remote: a, local: b };
}

export function assertCompatible(remoteVersion, localVersion = CONTRACT_VERSION) {
  const { compatible } = checkCompatibility(remoteVersion, localVersion);
  if (!compatible) {
    throw new RegionContractError(
      "incompatible_version",
      `peer contract ${remoteVersion} is incompatible with ${localVersion} (major must match)`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation helper style: never throw from the validator itself — return a
// result so callers decide whether invalid wire data is 400 or a protocol
// violation. normalize* returns the value with defaults filled in.
// ---------------------------------------------------------------------------

function fail(error, code = "invalid") { return { ok: false, error, code, value: undefined }; }
function pass(value) { return { ok: true, error: null, code: null, value }; }

function isPlainObject(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
function isHttpUrl(v) {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Execution contract
// ---------------------------------------------------------------------------

// Terminal + in-flight statuses: the same vocabulary the local queue adapter
// (src/queues/clone-queue.js entries) and exploration-runner already use, so a
// region result can be merged into existing registries without translation.
export const EXECUTION_STATUSES = [
  "queued", "exploring", "reconstructing", "verifying",
  "completed", "completed_with_limitations", "error", "cancelled",
];

export function normalizeExecutionRequest(input) {
  if (!isPlainObject(input)) return fail("execution request must be an object", "bad_body");
  const jobId = input.jobId;
  const taskId = input.taskId;
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return fail("jobId required (alphanumeric . _ -)", "bad_job_id");
  if (typeof taskId !== "string" || !JOB_ID_PATTERN.test(taskId)) return fail("taskId required (alphanumeric . _ -)", "bad_task_id");
  if (!isHttpUrl(input.url)) return fail("url required (http(s))", "bad_url");
  if (typeof input.regionId !== "string" || !ID_PATTERN.test(input.regionId)) return fail("regionId required", "bad_region_id");
  if (typeof input.issuedBy !== "string" || input.issuedBy.length < 1 || input.issuedBy.length > 128) {
    return fail("issuedBy required (coordinator identity)", "bad_issued_by");
  }
  const caps = normalizeCapabilities(input.requiredCapabilities);
  if (!caps.ok) return caps;
  const options = isPlainObject(input.options) ? input.options : {};
  const deadlineMs = input.deadlineMs === undefined || input.deadlineMs === null
    ? null
    : (Number.isInteger(input.deadlineMs) && input.deadlineMs > 0 ? input.deadlineMs : null);
  if (input.deadlineMs !== undefined && input.deadlineMs !== null && deadlineMs === null) {
    return fail("deadlineMs must be a positive integer", "bad_deadline");
  }
  return pass({
    contractVersion: typeof input.contractVersion === "string" ? input.contractVersion : CONTRACT_VERSION,
    jobId, taskId,
    url: input.url,
    regionId: input.regionId,
    issuedBy: input.issuedBy,
    requiredCapabilities: caps.value,
    options,
    deadlineMs,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
  });
}

export function validateExecutionRequest(input) {
  const r = normalizeExecutionRequest(input);
  if (!r.ok) throw new RegionContractError(r.code, r.error);
  return r.value;
}

export function validateExecutionResult(input) {
  if (!isPlainObject(input)) throw new RegionContractError("bad_body", "execution result must be an object");
  if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) throw new RegionContractError("bad_job_id", "result.jobId required");
  if (typeof input.taskId !== "string" || !JOB_ID_PATTERN.test(input.taskId)) throw new RegionContractError("bad_task_id", "result.taskId required");
  if (typeof input.regionId !== "string" || !ID_PATTERN.test(input.regionId)) throw new RegionContractError("bad_region_id", "result.regionId required");
  if (typeof input.workerId !== "string" || input.workerId.length < 1 || input.workerId.length > 128) {
    throw new RegionContractError("bad_worker_id", "result.workerId required");
  }
  if (!EXECUTION_STATUSES.includes(input.status)) {
    throw new RegionContractError("bad_status", `result.status must be one of ${EXECUTION_STATUSES.join(" | ")}`);
  }
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  for (const a of artifacts) validateArtifactEnvelope(a);
  const durationMs = input.durationMs === undefined ? null : input.durationMs;
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0)) {
    throw new RegionContractError("bad_duration", "result.durationMs must be a non-negative number");
  }
  if (input.status === "error" && typeof input.error !== "string") {
    throw new RegionContractError("bad_error", "result.error required when status=error");
  }
  return {
    contractVersion: typeof input.contractVersion === "string" ? input.contractVersion : CONTRACT_VERSION,
    jobId: input.jobId, taskId: input.taskId, regionId: input.regionId, workerId: input.workerId,
    status: input.status,
    artifacts,
    durationMs,
    error: input.error || null,
    meta: isPlainObject(input.meta) ? input.meta : {},
  };
}

// ---------------------------------------------------------------------------
// Artifact contract
// ---------------------------------------------------------------------------

export function digestArtifact(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function normalizeCapabilities(raw) {
  if (raw === undefined || raw === null) return pass([]);
  if (!Array.isArray(raw)) return fail("capabilities must be an array of strings", "bad_capabilities");
  const seen = new Set();
  for (const c of raw) {
    if (typeof c !== "string" || !CAP_PATTERN.test(c)) return fail(`invalid capability ${JSON.stringify(c)}`, "bad_capability");
    seen.add(c);
  }
  return pass([...seen]);
}

export function validateArtifactEnvelope(input) {
  if (!isPlainObject(input)) throw new RegionContractError("bad_body", "artifact envelope must be an object");
  if (typeof input.regionId !== "string" || !ID_PATTERN.test(input.regionId)) throw new RegionContractError("bad_region_id", "envelope.regionId required");
  if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) throw new RegionContractError("bad_job_id", "envelope.jobId required");
  if (typeof input.name !== "string" || !ARTIFACT_NAME_PATTERN.test(input.name)) throw new RegionContractError("bad_artifact_name", "envelope.name must be a safe basename");
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new RegionContractError("bad_digest", "envelope.sha256 must be a 64-char hex digest");
  if (!Number.isInteger(input.bytes) || input.bytes < 0) throw new RegionContractError("bad_size", "envelope.bytes must be a non-negative integer");
  if (input.contentType !== undefined && input.contentType !== null && typeof input.contentType !== "string") {
    throw new RegionContractError("bad_content_type", "envelope.contentType must be a string");
  }
  return {
    contractVersion: typeof input.contractVersion === "string" ? input.contractVersion : CONTRACT_VERSION,
    regionId: input.regionId, jobId: input.jobId, name: input.name,
    sha256: input.sha256, bytes: input.bytes,
    contentType: input.contentType || "application/octet-stream",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
  };
}

// Buffer ↔ envelope verification: digest AND byte-length must both match
// (length catches the truncated-body class a digest alone would miss).
export function verifyArtifactEnvelope(envelope, buf) {
  const env = validateArtifactEnvelope(envelope);
  if (!Buffer.isBuffer(buf)) throw new RegionContractError("bad_body", "artifact payload must be a Buffer");
  if (buf.length !== env.bytes) {
    throw new RegionContractError("artifact_size_mismatch", `artifact ${env.name}: ${buf.length} bytes, envelope says ${env.bytes}`);
  }
  const d = digestArtifact(buf);
  if (d !== env.sha256) {
    throw new RegionContractError("artifact_digest_mismatch", `artifact ${env.name}: digest ${d.slice(0, 12)}… != envelope ${env.sha256.slice(0, 12)}…`);
  }
  return env;
}

// A region's per-job manifest: every envelope the region holds for the job.
export const MANIFEST_NAME = "_manifest.json";

export function makeArtifactManifest({ regionId, jobId, artifacts }) {
  if (typeof regionId !== "string" || !ID_PATTERN.test(regionId)) throw new RegionContractError("bad_region_id", "manifest.regionId required");
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw new RegionContractError("bad_job_id", "manifest.jobId required");
  return {
    contractVersion: CONTRACT_VERSION,
    regionId,
    jobId,
    artifacts: (artifacts || []).map((a) => validateArtifactEnvelope(a)),
    createdAt: new Date().toISOString(),
  };
}

export function validateArtifactManifest(input) {
  if (!isPlainObject(input)) throw new RegionContractError("bad_body", "artifact manifest must be an object");
  assertCompatible(input.contractVersion || CONTRACT_VERSION);
  if (typeof input.regionId !== "string" || !ID_PATTERN.test(input.regionId)) throw new RegionContractError("bad_region_id", "manifest.regionId required");
  if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) throw new RegionContractError("bad_job_id", "manifest.jobId required");
  if (!Array.isArray(input.artifacts)) throw new RegionContractError("bad_artifacts", "manifest.artifacts must be an array");
  return {
    contractVersion: input.contractVersion || CONTRACT_VERSION,
    regionId: input.regionId, jobId: input.jobId,
    artifacts: input.artifacts.map((a) => validateArtifactEnvelope(a)),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Auth contract: region↔region HMAC-SHA256 bearer tokens (HS256 JWT shape)
// ---------------------------------------------------------------------------
// Secret source: CLONER_REGION_SECRET (or CLONER_DISTRIBUTED_SECRET), env only
// — never a default, never a literal. Absent → clean actionable error.

export const SECRET_ENV_VARS = ["CLONER_REGION_SECRET", "CLONER_DISTRIBUTED_SECRET"];

export function resolveRegionSecret() {
  for (const name of SECRET_ENV_VARS) {
    const v = process.env[name];
    if (typeof v === "string" && v.length >= 16) return v;
  }
  throw new RegionAuthError(
    "no_secret",
    `region auth secret not configured — set ${SECRET_ENV_VARS[0]} (>=16 chars) in .env (see .env.example); ` +
    "cross-region calls are refused without it",
  );
}

export function requireRegionSecret() { return resolveRegionSecret(); }

// --- base64url -------------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

function hmac(signingInput, secret) {
  return createHmac("sha256", secret).update(signingInput).digest();
}

// Mint a compact HS256 token. claims:
//   { iss (caller region), aud (target region id or array), sub (worker/coordinator id),
//     capabilities?: string[], ttlMs?: number }
export function mintRegionToken(claims, secret = resolveRegionSecret()) {
  if (!isPlainObject(claims)) throw new RegionAuthError("malformed", "token claims must be an object");
  if (typeof claims.iss !== "string" || !ID_PATTERN.test(claims.iss)) throw new RegionAuthError("malformed", "claims.iss must be a region id");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.length || !aud.every((a) => typeof a === "string" && ID_PATTERN.test(a))) {
    throw new RegionAuthError("malformed", "claims.aud must be a region id (or a non-empty array of them)");
  }
  const now = Math.floor(Date.now() / 1000);
  const ttlMs = Number.isInteger(claims.ttlMs) && claims.ttlMs > 0 ? claims.ttlMs : 60_000;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: claims.iss,
    aud: Array.isArray(claims.aud) ? aud : aud[0],
    sub: typeof claims.sub === "string" && claims.sub ? claims.sub.slice(0, 128) : "coordinator",
    capabilities: Array.isArray(claims.capabilities) ? claims.capabilities : [],
    iat: now,
    exp: now + Math.max(1, Math.floor(ttlMs / 1000)),
    jti: randomUUID(),
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = hmac(signingInput, secret);
  return `${signingInput}.${b64u(sig)}`;
}

// Verify + decode. options: { audience (required region id), expectIssuer?,
// leewayMs? (default 5000) }. Every failure throws RegionAuthError with a
// specific code so the HTTP layer can emit { error, code }.
export function verifyRegionToken(token, secret = resolveRegionSecret(), options = {}) {
  if (typeof token !== "string" || token.length === 0) throw new RegionAuthError("missing", "region token required (Authorization: Bearer)");
  const parts = token.split(".");
  if (parts.length !== 3) throw new RegionAuthError("malformed", "region token must have 3 dot-separated segments");
  const [h64, p64, s64] = parts;
  const signingInput = `${h64}.${p64}`;
  const expected = hmac(signingInput, secret);
  let got;
  try { got = unb64u(s64); } catch { throw new RegionAuthError("malformed", "token signature is not valid base64url"); }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new RegionAuthError("bad_signature", "region token signature check failed");
  }
  let header, payload;
  try {
    header = JSON.parse(unb64u(h64).toString("utf8"));
    payload = JSON.parse(unb64u(p64).toString("utf8"));
  } catch { throw new RegionAuthError("malformed", "token header/payload is not valid JSON"); }
  if (!isPlainObject(header) || header.alg !== "HS256" || header.typ !== "JWT") {
    throw new RegionAuthError("malformed", "token header must be {alg:'HS256', typ:'JWT'}");
  }
  if (!isPlainObject(payload) || typeof payload.exp !== "number") throw new RegionAuthError("malformed", "token payload missing exp");
  const now = Math.floor(Date.now() / 1000);
  const leeway = Math.max(0, Math.floor((options.leewayMs ?? 5000) / 1000));
  if (payload.exp + leeway < now) throw new RegionAuthError("expired", `region token expired at ${new Date(payload.exp * 1000).toISOString()}`);
  if (typeof payload.nbf === "number" && payload.nbf - leeway > now) throw new RegionAuthError("malformed", "region token not yet valid");
  if (options.audience) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(options.audience)) throw new RegionAuthError("bad_audience", `region token audience does not include ${options.audience}`);
  }
  if (options.expectIssuer && payload.iss !== options.expectIssuer) {
    throw new RegionAuthError("bad_issuer", `region token issuer ${JSON.stringify(payload.iss)} != expected ${JSON.stringify(options.expectIssuer)}`);
  }
  return payload;
}

// Authorization header → token (shared by node + client-side callers).
export function bearerFromHeader(headerValue) {
  if (typeof headerValue !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : null;
}
