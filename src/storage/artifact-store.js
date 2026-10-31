// Artifact store (spec §15): writes the versioned exploration artifact tree —
// artifacts/{job_id}/ with manifest.json, pages/, states/, graph/, assets/,
// reports/. No credentials, cookies or authorization headers are stored.
import fs from "node:fs";
import path from "node:path";

export function createArtifactStore(rootDir, jobId) {
  const dir = path.join(rootDir, jobId);
  const dirs = {
    root: dir,
    pages: path.join(dir, "pages"),
    states: path.join(dir, "states"),
    assets: path.join(dir, "assets"),
    graph: path.join(dir, "graph"),
    reports: path.join(dir, "reports"),
    logs: path.join(dir, "logs"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  return {
    dirs,
    writeJson(rel, data) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return path.relative(dir, file).replace(/\\/g, "/");
    },
    writeBinary(rel, buffer) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buffer);
      return path.relative(dir, file).replace(/\\/g, "/");
    },
    writeText(rel, text) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return path.relative(dir, file).replace(/\\/g, "/");
    },
    writeManifest(manifest) {
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
      return "manifest.json";
    },
  };
}

// redact anything credential-shaped before it lands in artifacts (spec §11/§15)

// JWT-shaped values (header.payload.signature), wherever they appear
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
// credential-ish URL query params: ?token=… / &access_key=… / ?sessionId=… …
const URL_SECRET_RE = /([?&][A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[-_]?key|apikey|auth|credential|signature|session|key)[A-Za-z0-9_.-]*)=[^&\s"']+/gi;

// scrub credential-shaped substrings out of a single string (URLs, messages)
export function redactText(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(JWT_RE, "[REDACTED]").replace(URL_SECRET_RE, "$1=[REDACTED]");
}

export function redact(obj) {
  const RE = /(cookie|authorization|token|password|secret|api[-_]?key)/i;
  if (Array.isArray(obj)) return obj.map((x) => redact(x));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (RE.test(k)) out[k] = "[REDACTED]";
      else if (typeof v === "string" && /^(Bearer|Basic)\s/i.test(v)) out[k] = "[REDACTED]";
      else out[k] = redact(v);
    }
    return out;
  }
  if (typeof obj === "string") return redactText(obj);
  return obj;
}
