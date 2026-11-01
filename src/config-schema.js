// Environment configuration schema + startup validation (task 4.0.10).
//
// The platform previously read env vars with per-file fallbacks
// (src/database/client.js, src/queues/clone-queue.js, src/platform/tasks.js).
// That is fine in development, but production needs the REQUIRED set checked
// at boot with actionable errors — before the server starts listening — and
// with the guarantee that no secret value is ever echoed back.
//
// Usage:
//   import { assertEnv } from "./config-schema.js";
//   assertEnv("api");              // throws with an actionable message
//
// CLI (used by the production container commands):
//   node src/config-schema.js api       → validate env for the API process
//   node src/config-schema.js worker    → validate env for the worker process
//   node src/config-schema.js migrator  → validate env, run forward-only
//                                         migrations, exit non-zero on failure
//
// Rules encoded here:
//   • dev mode (NODE_ENV unset) keeps the existing development fallbacks
//     documented in .env.example — nothing breaks for local workflows.
//   • production mode (NODE_ENV=production) requires the database credentials
//     and, for the worker, REDIS_URL, to be explicitly provided.
//   • variables flagged secret are NEVER printed — not their values, not in
//     error messages, not in redact() output.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

export const ROLES = ["api", "worker", "migrator", "all"];

/**
 * One entry per recognized environment variable.
 *  role        – which process uses it ("all" = every process)
 *  secret      – true when the value must never be echoed (passwords, keys,
 *                URLs that may embed credentials)
 *  type        – "string" | "int" | "url"
 *  requiredIn  – modes where the variable MUST be set ("production" or "always")
 *  requiredFor – roles that require it regardless of mode
 *  validate    – extra per-value check; return an error string or null
 *  description / fix – what it is and how to set it correctly
 */
const SCHEMA = {
  NODE_ENV: {
    role: "all",
    type: "string",
    requiredIn: [],
    description: "Runtime mode: development (default), production or test.",
    fix: 'Set NODE_ENV=production for deployments; leave unset for local development.',
    validate: (v) =>
      ["development", "production", "test", ""].includes(v)
        ? null
        : `must be "development", "production" or "test" (got ${describe(v)})`,
  },

  PORT: {
    role: "api",
    type: "int",
    min: 1,
    max: 65535,
    default: "4180",
    requiredIn: [],
    description: "Port the platform API/UI listens on (bin/platform.js).",
    fix: "Set PORT=4180 (or another free port) in .env.",
  },

  PGHOST: {
    role: "all",
    type: "string",
    requiredIn: "production",
    default: "127.0.0.1",
    description: "PostgreSQL host (src/database/client.js).",
    fix: "Set PGHOST to the PostgreSQL host, e.g. postgres in docker-compose.prod.yml.",
  },
  PGPORT: {
    role: "all",
    type: "int",
    min: 1,
    max: 65535,
    default: "5433",
    requiredIn: [],
    description: "PostgreSQL port.",
    fix: "Set PGPORT=5433 (compose dev mapping) or 5432 inside the prod network.",
  },
  PGDATABASE: {
    role: "all",
    type: "string",
    requiredIn: "production",
    default: "cloner",
    description: "PostgreSQL database name.",
    fix: "Set PGDATABASE=cloner.",
  },
  PGUSER: {
    role: "all",
    type: "string",
    requiredIn: "production",
    default: "cloner",
    description: "PostgreSQL user.",
    fix: "Set PGUSER=cloner (or your dedicated application user).",
  },
  PGPASSWORD: {
    role: "all",
    type: "string",
    secret: true,
    requiredIn: "production",
    description: "PostgreSQL password. Secret: never logged, never echoed.",
    fix: "Set PGPASSWORD via your secret manager / .env (never commit it). " +
         "Must match POSTGRES_PASSWORD of the postgres service in docker-compose.prod.yml.",
  },

  REDIS_URL: {
    role: "all",
    type: "url",
    secret: true, // redis URLs may embed a password: redis://:pass@host/db
    requiredFor: ["worker"],
    description:
      "Redis connection URL. Required for the clone worker; for the API it " +
      "switches the clone queue from in-process mode to BullMQ " +
      "(src/queues/clone-queue.js).",
    fix: "Set REDIS_URL=redis://redis:6379 inside the compose network " +
         "(redis://127.0.0.1:6379 for a local redis).",
    validate: (v) =>
      /^rediss?:\/\//.test(v)
        ? null
        : 'must be a redis:// or rediss:// URL (got a value with a different scheme)',
  },

  MAX_CONCURRENT: {
    role: "worker",
    type: "int",
    min: 1,
    max: 32,
    default: "2",
    requiredIn: [],
    description: "Worker concurrency cap (src/workers/clone-worker.js).",
    fix: "Set MAX_CONCURRENT=2 (default) or higher for beefier hosts.",
  },

  RETENTION_DAYS: {
    role: "api",
    type: "int",
    min: 1,
    max: 365,
    default: "15",
    requiredIn: [],
    description: "Task retention sweep age in days (src/platform/tasks.js).",
    fix: "Set RETENTION_DAYS=15 (default).",
  },

  PURGE_CREDS_ON_DONE: {
    role: "api",
    type: "string",
    requiredIn: [],
    description: '"1" deletes stored credentials as soon as a task ends (src/platform/tasks.js).',
    fix: 'Set PURGE_CREDS_ON_DONE=1 for production (recommended).',
  },

  ANTHROPIC_API_KEY: {
    role: "api", type: "string", secret: true, requiredIn: [],
    description: "Vision provider key for edit-chat / vision polish (optional).",
    fix: "Optional: set only if you use AI-assisted editing. Inject via secrets, never commit.",
  },
  OPENAI_API_KEY: {
    role: "api", type: "string", secret: true, requiredIn: [],
    description: "Vision provider key (optional).",
    fix: "Optional: set only if you use AI-assisted editing. Inject via secrets, never commit.",
  },
  CUSTOM_API_KEY: {
    role: "api", type: "string", secret: true, requiredIn: [],
    description: "Key for a custom OpenAI-compatible provider (optional).",
    fix: "Optional. Pair with CUSTOM_BASE_URL. Inject via secrets, never commit.",
  },
};

/** Keys whose values must never appear in any log or error output. */
export const SECRET_KEYS = Object.keys(SCHEMA).filter((k) => SCHEMA[k].secret);

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Replace any known-secret value longer than 3 chars inside `text` with ***.
 * Used by the CLI paths so unexpected errors cannot leak secrets.
 * @param {string} text
 * @param {Record<string, string>} [env] defaults to process.env
 */
export function redact(text, env = process.env) {
  let out = String(text ?? "");
  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 3) {
      out = out.split(value).join("***");
    }
  }
  return out;
}

function describe(v) {
  if (v === undefined || v === "") return "not set";
  return "a non-empty value"; // never describe by content
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the environment for one process role.
 * @param {{ role: string, env?: Record<string,string>, mode?: string }} opts
 * @returns {{ ok: boolean, errors: string[], warnings: string[], mode: string }}
 */
export function validateEnv({ role, env = process.env, mode } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`config-schema: unknown role "${role}" (expected one of ${ROLES.join(", ")})`);
  }
  const effMode = mode || env.NODE_ENV || "development";
  const errors = [];
  const warnings = [];

  for (const [key, spec] of Object.entries(SCHEMA)) {
    const usesRole = spec.role === "all" || spec.role === role;
    if (!usesRole) continue;

    const raw = env[key];
    const present = raw !== undefined && raw !== "";
    const requiredAlways = spec.requiredIn === "always";
    const requiredInMode = spec.requiredIn === "production" && effMode === "production";
    const requiredForRole = (spec.requiredFor || []).includes(role);

    if (!present) {
      if (requiredAlways || requiredInMode || requiredForRole) {
        const why = requiredForRole
          ? `required for the "${role}" process in every mode`
          : requiredInMode
            ? `required when NODE_ENV=production (currently ${effMode})`
            : "required";
        errors.push(
          `${key} is missing — ${why}. ${spec.description} Fix: ${spec.fix}`
        );
      } else if (spec.default) {
        // dev fallback exists — the process would still run; say so once
        warnings.push(`${key} not set — falling back to ${key}=${spec.default} (development default; set it explicitly in production)`);
      }
      continue;
    }

    if (spec.type === "int") {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        errors.push(`${key} must be an integer (got an invalid value — contents not shown). Fix: ${spec.fix}`);
      } else if (spec.min !== undefined && n < spec.min) {
        errors.push(`${key} must be >= ${spec.min} (got ${n}). Fix: ${spec.fix}`);
      } else if (spec.max !== undefined && n > spec.max) {
        errors.push(`${key} must be <= ${spec.max} (got ${n}). Fix: ${spec.fix}`);
      }
    }

    if (typeof spec.validate === "function") {
      const err = spec.validate(String(raw));
      if (err) errors.push(`${key} ${err}. Fix: ${spec.fix}`);
    }
  }

  // production hygiene warnings (non-fatal)
  if (effMode === "production" && role === "api") {
    if (env.PURGE_CREDS_ON_DONE !== "1") {
      warnings.push("PURGE_CREDS_ON_DONE!=1 — stored task credentials are kept until export; set PURGE_CREDS_ON_DONE=1 in production");
    }
    if (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
      warnings.push("vision provider keys detected — ensure they are injected via a secret mechanism, never baked into the image");
    }
  }

  return { ok: errors.length === 0, errors, warnings, mode: effMode };
}

/**
 * Validate and throw an aggregated, actionable error. The error message names
 * every offending variable and the fix — but never any secret value.
 * @param {string} role
 * @param {{ env?: Record<string,string>, mode?: string }} [opts]
 */
export function assertEnv(role, opts = {}) {
  const { ok, errors, warnings, mode } = validateEnv({ role, ...opts });
  for (const w of warnings) console.warn(`[config] warning: ${w}`);
  if (ok) return { role, mode };
  const body = [
    `[config] environment validation failed for the "${role}" process (NODE_ENV=${mode}).`,
    ...errors.map((e) => `  - ${e}`),
    "",
    "  Secrets were intentionally NOT echoed. Provide the variables above",
    "  through your environment (.env locally, secret manager in production).",
    "  Reference: .env.example — “Deployment (docker-compose.prod.yml)” section.",
  ].join("\n");
  throw new ConfigError(redact(body, opts.env || process.env));
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Migration runner: auto-run on start with a forward-only guard
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(path.dirname(__filename), "database", "migrations");

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexical: zero-padded numeric prefixes keep apply order
}

/**
 * Pure guard: everything recorded as applied must still exist on disk.
 * A recorded id with no file means the migration history was altered
 * (file deleted/renamed) — running forward-only migrations on top of that is
 * unsafe, so callers must refuse. Also flags non-sortable prefixes.
 * @param {{ applied: string[], files: string[] }} state
 * @throws {ConfigError}
 */
export function assertMigrationsForwardOnly({ applied, files }) {
  const missing = applied.filter((id) => !files.includes(id));
  if (missing.length) {
    throw new ConfigError(
      "[migrations] forward-only violation: the database records migration(s) " +
        missing.join(", ") +
        " as applied, but the file(s) are missing from src/database/migrations. " +
        "Refusing to migrate. Restore the file(s) from version control, or restore " +
        "the database from a backup — never delete migration files from a live history."
    );
  }
  const unpadded = files.filter((f) => !/^\d{3}-/.test(f));
  if (unpadded.length) {
    throw new ConfigError(
      "[migrations] non-conforming migration filename(s): " +
        unpadded.join(", ") +
        ' — names must start with a 3-digit sequence (e.g. "002-add-x.sql") ' +
        "so lexical order equals apply order."
    );
  }
}

/**
 * Run migrations with explicit version tracking and failure reporting.
 * 1. read applied ids from _migrations,
 * 2. run the forward-only guard,
 * 3. apply pending files via src/database/client.js migrate(),
 * 4. verify the recorded set now matches the on-disk set (post-condition).
 * @param {{ env?: Record<string,string> }} [opts]
 * @returns {{ appliedBefore: string[], appliedNow: string[], files: string[] }}
 */
export async function migrateForwardOnly(opts = {}) {
  const env = opts.env || process.env;
  const { query, migrate, closePool, getPool } = await import("./database/client.js");

  let appliedBefore = [];
  const hasTable = await query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migrations') AS ok`
  );
  if (hasTable.rows[0].ok) {
    const rows = await query("SELECT id FROM _migrations ORDER BY id");
    appliedBefore = rows.rows.map((r) => r.id);
  }
  const files = listMigrationFiles();
  assertMigrationsForwardOnly({ applied: appliedBefore, files });

  try {
    await migrate(); // existing runner: skips applied, records new ids
  } catch (e) {
    // failure reporting: say WHICH step failed and keep secrets out
    throw new ConfigError(
      redact(`[migrations] FAILED while applying (database ${env.PGDATABASE || "cloner"} on ${env.PGHOST || "127.0.0.1"}:${env.PGPORT || 5433}): ${e.message}`, env)
    );
  }

  const after = await query("SELECT id FROM _migrations ORDER BY id");
  const appliedNow = after.rows.map((r) => r.id);
  const stillMissing = appliedNow.filter((id) => !files.includes(id));
  if (stillMissing.length) {
    throw new ConfigError(
      `[migrations] post-condition failed: _migrations records ${stillMissing.join(", ")} which is not a file on disk`
    );
  }

  await closePool();
  return {
    appliedBefore,
    appliedNow,
    appliedThisRun: appliedNow.filter((id) => !appliedBefore.includes(id)),
    files,
  };
}

/**
 * Boot path for the "migrator" one-shot process (docker-compose.prod.yml):
 * validate env → run guarded migrations → close the pool → exit 0/1.
 */
export async function runMigrator(env = process.env) {
  assertEnv("migrator", { env });
  const result = await migrateForwardOnly({ env });
  if (result.appliedThisRun.length === 0) {
    console.log(`[migrations] up to date (${result.files.length} file(s), nothing to apply)`);
  } else {
    for (const id of result.appliedThisRun) console.log(`[migrations] applied: ${id}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI entry: node src/config-schema.js <api|worker|migrator>
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const role = process.argv[2];
  if (!ROLES.includes(role)) {
    console.error(`usage: node src/config-schema.js <${ROLES.join("|")}>`);
    process.exit(2);
  }
  const job =
    role === "migrator"
      ? runMigrator()
      : Promise.resolve().then(() => assertEnv(role)); // defer: assertEnv throws synchronously
  job
    .then((r) => {
      if (r && r.role) console.log(`[config] ${r.role} environment OK (NODE_ENV=${r.mode})`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(redact(e.message));
      process.exit(1);
    });
}
