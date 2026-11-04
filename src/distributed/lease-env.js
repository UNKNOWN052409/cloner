// Environment configuration for distributed job leases (task 4.2.8).
// Kept in its own module so the lease logic imports no env at load time —
// every value is resolved per-construction (tests can pin env freely).

export function envLeaseBackend() {
  return process.env.CLONER_LEASE_BACKEND || "postgres";
}

export function envLeaseTtlMs() {
  const v = Number(process.env.CLONER_LEASE_TTL_MS || 30_000);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

export function envLeaseRegion() {
  return process.env.CLONER_LEASE_REGION || "default";
}

export function defaultLeaseWorkerId() {
  return process.env.CLONER_LEASE_WORKER_ID
    || process.env.CLONER_WORKER_ID
    || `lease-worker-${process.pid}`;
}
