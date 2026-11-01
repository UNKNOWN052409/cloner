# Backup, Recovery & Data Integrity (Phase 4.0.11)

Verifiable disaster-recovery procedures for the cloner platform's PostgreSQL
database, artifact storage and platform metadata. **A backup is not proof of
recoverability** — the drill at the bottom restores for real and verifies the
data, not just the archive.

## Scope

| Component | Backup mechanism | Tool |
|---|---|---|
| PostgreSQL (users, tasks, task_stages, artifacts, task_events, sessions) | Plain-SQL `pg_dump` (`--clean --if-exists --no-owner --no-privileges`) | `scripts/backup-database.mjs` |
| Artifact storage (`platform-data/<task>/out/**`, exploration trees) | gzip tar + per-file SHA-256 sidecar manifest | `scripts/backup-artifacts.mjs` |
| Redis / BullMQ queues | **Not backed up** — jobs are transient; restored in-flight tasks are reconciled to `failed-recoverable` (see below) | — |
| Configuration (`cloner.config.json`, `.env`) | Not archived (secrets); kept outside the backup archive by design | — |

## Credentials & secrets

- **Never hardcoded.** All connection settings come from the environment
  (`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, defaults matching
  `docker-compose.yml` topology and `src/database/client.js`).
- The dump runs **inside** the postgres container over the local trust socket,
  so no password ever appears on a command line or in process listings.
- Backup archives contain **no** `private/` session files (cookies, storage
  state). Those are credentials with their own purge lifecycle
  (`src/platform/tasks.js` — `purgeCredentials`) and are excluded from every
  artifact backup. Encryption keys / `.env` are not backed up; store them in a
  separate secret manager with its own recovery process.

## Backup

```bash
# database → backups/database/<UTC-timestamp>-<db>.sql + .sha256
node scripts/backup-database.mjs
node scripts/backup-database.mjs --out-dir /var/backups/cloner

# artifacts → backups/artifacts/<UTC-timestamp>-artifacts.tar.gz + .manifest.json
node scripts/backup-artifacts.mjs
node scripts/backup-artifacts.mjs --src /path/to/platform-data --out /var/backups/cloner/art.tar.gz
```

Each database backup gets a sidecar `.sha256`; each artifact backup a sidecar
`.manifest.json` with the SHA-256 of every archived file (written **outside**
the archive so it survives archive corruption).

## Restore

```bash
# refuses to run against a non-empty database unless --force is given
node scripts/restore-database.mjs backups/database/2026-11-01T…-cloner.sql
node scripts/restore-database.mjs backups/database/…-cloner.sql --force

# artifacts (verifies every file against the sidecar manifest)
node scripts/backup-artifacts.mjs --restore backups/artifacts/…-artifacts.tar.gz platform-data/
```

### Pre-check

The database restore **refuses** (exit 1) when the target has application
tables, unless `--force`. The dump was written with `--clean --if-exists`, so
`--force` drops and recreates the application tables only — other databases on
the cluster are untouched.

### Job-state reconciliation after restore

Tasks stuck in `queued | running | verifying` cannot survive a restore (their
worker processes are gone). `restore-database.mjs` flips each one to
`status='error'` with `error='failed-recoverable: restored from backup while
task was …'` and writes a `reconciled` row to `task_events`, so operators can
find and retry them instead of the pipeline stalling forever. Tasks already in
`done | error | exported` are left exactly as backed up.

## Recovery procedures

- **Database loss**: restore the newest `.sql` into an empty database (or
  `--force` into the existing one), re-run `npm run platform`; the migrator in
  `src/database/client.js` is idempotent (`_migrations` table ships in the
  dump).
- **Artifact loss**: restore the newest artifact tar into `platform-data/`;
  every file is checksum-verified against the manifest during restore. Rows in
  the `artifacts` table referencing keys absent from the manifest indicate an
  incomplete pair (database newer than artifact backup) — treat as partial
  recovery.
- **Worker/Redis loss**: nothing to restore. Recreate the containers
  (`docker compose up -d redis`); BullMQ jobs are transient state. In-flight
  clone tasks on the database side are reconciled as above.

## Recovery objectives (documented targets)

- **RPO (acceptable data loss)**: one backup interval. With no scheduler in
  the repo yet, run both backup scripts from cron/Task Scheduler; hourly is
  sufficient for dev, ≤15 min for production (matches `RETENTION_DAYS`
  task-sweep cadence).
- **RTO (restoration time)**: minutes — a single-script restore plus platform
  restart; measured by the drill below.

## Scheduled restoration drills

Backup creation is not proof of recoverability. Run the drill periodically
(cron: `0 4 * * 0 node scripts/test-backup-recovery.mjs`); it creates a
throwaway database on the same cluster, backs it up, **deletes the data**,
restores, and verifies row-for-row identity plus the reconciliation step:

```bash
docker compose up -d postgres        # drill needs the engine
node scripts/test-backup-recovery.mjs
```

Prints `PASS/FAIL` lines and a final `RESULT:`; exits nonzero on any failure,
`SKIP` with a note when docker/postgres is unreachable. The drill never
touches the live `cloner` database.
