# Kubernetes PROFILE — control plane + regional workers + HPA (task 4.2.5)

Plain, dependency-free manifests (`kubectl apply`, no Helm/Kustomize required).
Everything deploys into the `cloner` namespace.

## Files

| File | Contains |
|---|---|
| `00-namespace.yaml` | `Namespace cloner` + Pod-Security labels |
| `10-configmap.yaml` | `cloner-config` — every NON-SECRET env var (mirrors the schema in `src/config-schema.js`) |
| `20-secrets.yaml.example` | **Template** for the `cloner-secrets` Secret. `.yaml.example` on purpose — `kubectl apply -f k8s/` ignores it. Copy, fill, apply. |
| `25-storage.yaml` | PVCs `cloner-artifacts` (20Gi) + `cloner-platform-data` (5Gi), ReadWriteMany |
| `30-control-plane.yaml` | `Deployment cloner-api` (2 replicas, `/healthz` + `/readyz` probes) · `Service cloner-api` (4180) · one-shot `Job cloner-migrator` |
| `40-workers.yaml` | Regional worker pools `cloner-worker-us-east-1`, `cloner-worker-eu-west-1` |
| `50-hpa.yaml` | `autoscaling/v2` HPAs for the api and both regional pools |
| `scripts/test-k8s-manifests.mjs` (repo root `scripts/`) | Structure/contract tests — run `node scripts/test-k8s-manifests.mjs` |

## Deploy

```sh
# 0. build + push the image (the manifests reference cloner-platform:latest;
#    change the tag/pull policy for a registry build)
docker build --target runtime -t cloner-platform:latest .

# 1. namespace + config + storage
kubectl apply -f k8s/00-namespace.yaml -f k8s/10-configmap.yaml -f k8s/25-storage.yaml

# 2. secrets — NEVER commit the filled file
cp k8s/20-secrets.yaml.example cloner-secrets.local.yaml
#    fill PGPASSWORD + REDIS_URL (leave optional AI keys empty to disable)
kubectl apply -f cloner-secrets.local.yaml

# 3. control plane; run the one-shot migrator to completion BEFORE relying on traffic
kubectl apply -f k8s/30-control-plane.yaml
kubectl wait --for=condition=complete --timeout=300s job/cloner-migrator -n cloner

# 4. workers + autoscaling
kubectl apply -f k8s/40-workers.yaml -f k8s/50-hpa.yaml

# expose the api your way (LoadBalancer / Ingress / port-forward):
kubectl -n cloner port-forward svc/cloner-api 4180:4180
```

Ordering note: api pods that start before steps 2–3 finish stay `NotReady` —
`/readyz` (`src/platform/health-routes.js`) checks db reachability, queue
backend and migration currency — and the Service only routes to ready pods.

## Prerequisites the manifests assume (and say so inline)

- **Image**: built from this repo's `Dockerfile` (`target: runtime`), non-root
  uid 1000, port 4180.
- **PostgreSQL + Redis**: the platform ships no datastore manifests. Point
  `PGHOST` (`10-configmap.yaml`) at an in-cluster postgres Service or a
  managed endpoint; put `PGPASSWORD` and `REDIS_URL` (`rediss://` for TLS) in
  `cloner-secrets`.
- **ReadWriteMany storage** for both PVCs (EFS / Filestore / Azure Files /
  CephFS / NFS). RWO-only clusters: pin api + workers to one node pool and set
  api `replicas: 1` — see `25-storage.yaml`.
- **metrics-server** for the HPAs (CPU/memory utilization metrics come from
  the Metrics API). Probe with `kubectl top pods`.
- **Region nodes (optional)**: label nodes with `cloner.io/worker-region=us-east-1`
  / `=eu-west-1` to actually pin the pools; the affinity is soft, so unlabeled
  clusters still schedule.

## What "regional workers" means here (honest scope)

Both pools consume the same BullMQ queue (`clone-jobs`, fixed in
`src/queues/clone-queue.js`). Region separation gives you per-region
scheduling/affinity, per-region autoscaling, per-region heartbeat identity
(`CLONER_WORKER_ID` = pod name) and the option to shard backends per region by
splitting config/Secret per deployment. Region-aware *job routing* (queue per
region) is a product-code feature and is **not** part of 4.2.5.

## Two scalers, two layers — pick one per layer

- **k8s HPA** (`50-hpa.yaml`) owns **pod count** per regional pool.
- **In-product autoscaler** (`CLONER_AUTOSCALE_*`, `src/workers/scaling-policy.js`,
  sibling feature) owns **worker slots within a process pool** (default policy:
  min 1 → max 8 slots).

Don't let both react to the same signal at the same layer: under the k8s HPA,
either leave the in-product policy at defaults (it manages slots inside the
running pods) or pin it with `CLONER_AUTOSCALE_MIN_WORKERS`/`MAX_WORKERS` —
and size `MAX_CONCURRENT` + HPA headroom so pods don't OOM at the memory limit.

## Testing

```sh
node scripts/test-k8s-manifests.mjs
```

Sections:
1. `[unit]` YAML-subset parser self-tests (always runs).
2. `[structure]` every manifest: parse, kind coverage, selectors↔labels,
   resource requests+limits, security context, probe paths cross-checked
   against `src/platform/health-routes.js`, secret-ref discipline (no secret
   values inlined anywhere; template carries placeholders only).
3. `[env-schema]` assembles the ConfigMap + Secret keys and runs the REAL
   `validateEnv()` from `src/config-schema.js` for `api`, `worker` and
   `migrator` in production mode — the manifest env surface must boot.
4. `[pyyaml]` independent-parser agreement (runs when python + PyYAML exist).
5. `[kubectl]`/`[live-cluster]` kubectl + API-server dry-run validation —
   **skips loudly** unless kubectl exists and a cluster is reachable.
