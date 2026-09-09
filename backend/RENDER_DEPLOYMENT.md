# Deploying the API and private render worker

The repository has two separate Render Blueprints. `render.yaml` continues to
manage only the existing `ziipa-api` web service. `render-worker.yaml` is an
explicit, separately approved **paid** deployment for `ziipa-render-worker`.
Neither file creates another database, Redis instance, R2 bucket or persistent
disk. Originals, accounts and render receipts stay in the API's existing Neon,
Upstash and private R2 services.

As checked on September 9, 2026, Render's lowest worker plan meeting the tested
1 CPU / 1 GiB baseline is **`1c-2g`: 1 CPU, 2 GB, $25/month**. Render does not offer
a 1 CPU / 1 GB worker plan or a free background worker. The $7 `0.5c-512mb` plan
is below this application's tested rendering baseline. A paid workspace upgrade
is not needed just to run this fixed worker; compute is billed separately, and
usage charges can still apply. See [Render pricing](https://render.com/pricing)
and [compute plans](https://render.com/docs/compute-plans). These manifests have
not themselves purchased or provisioned a worker.

## Configuration and release order

1. Confirm the existing API service is named exactly `ziipa-api` in the intended
   Render workspace, connected to `Ziipacom/v1` on the reviewed branch. Keep the
   service's existing domain and external database. The worker references that
   service's environment settings instead of generating replacements.
2. Review the API settings before deploying code. Use `ENVIRONMENT=production`,
   TLS Neon (`DATABASE_URL` includes `sslmode=require` or stronger), TLS Upstash
   (`REDIS_URL` begins `rediss://`), and private R2 storage. The same exact URLs,
   bucket and R2 credentials must reach both services. The worker checks bucket
   access with a read-only `HeadBucket` request at startup.
3. Add missing API secrets through Render's environment editor. New `sync:false`
   keys are **not** prompted or inserted into an already-managed service during
   Blueprint updates. Leave provider approval flags false unless the provider
   has actually approved the application. Missing optional publishing/Livepeer
   configuration must remain unavailable, not presented as connected. Provider
   setup details are in `SOCIAL-PUBLISHING.md` and `LIVESTREAM.md` at repo root.
4. Deploy the reviewed API release. The Docker command runs
   `python render_migrate.py` before Uvicorn binds Render's `$PORT`. Hosted/demo
   startup does not silently create unversioned tables. Migrations must succeed
   before the API deploy is accepted. Its health path remains `/api/health`.
5. Once the worker cost is approved, import `render-worker.yaml` as a separate
   Blueprint in the same workspace. Review the plan and confirm a single
   instance. Do not add the worker to the default API Blueprint merely to enable
   a feature. The worker uses root directory `backend`, Dockerfile `./Dockerfile`,
   context `.`, predeploy `python render_migrate.py`, and command
   `python render_worker.py --require-hosted`.
6. Confirm CI passed for the deployed commit. Both manifests use
   `autoDeployTrigger: checksPass`. Check worker startup, then use a test account
   to upload a short owned clip, save effects, queue an export and download the
   resulting private MP4. A successful `/api/health` alone does not prove that
   rendering, social publishing or livestreaming is configured.

Render supports references to existing services outside a Blueprint in the same
workspace. These references refresh on Blueprint sync, so **resync/redeploy the
worker after rotating shared credentials**. `SENTRY_DSN` must exist on the API
(an empty value is permitted if monitoring is intentionally disabled), because
the worker references that key too. See the [Blueprint specification](https://render.com/docs/blueprint-spec)
and [monorepo root-directory rules](https://render.com/docs/monorepo-support).

The worker receives only database, Redis, R2 and monitoring settings. It does not
receive OAuth tokens, publishing encryption keys, email credentials, blockchain
signers or Livepeer credentials. No inbound public HTTP route or worker domain is
needed. R2 objects are private; access continues through the API's ownership
checks and expiring URLs. Restrict cloud credentials and outbound access to the
services required for this worker wherever the hosting plan supports it.

## Queue durability, idle usage and shutdown

PostgreSQL is the authoritative queue. After committing a queued job, the API
best-effort changes one Redis revision key. An idle worker checks the revision
and refreshes its heartbeat every 30 seconds; ordinary new work starts within
roughly one polling interval, plus database/storage startup time and existing
jobs. It drains queued work serially. It does not run FFmpeg inside the web API.

Without activity, the default loop uses approximately 172,800 Redis commands per
30 days, before API sessions, rate limits, health checks, render requests and
other features. Every 30 minutes it also scans the durable queue to recover lost
wake signals or expired claims: about 1,440 scans per 30 days. These periodic
queries can wake Neon and consume compute. This reduces idle usage but is not a
claim that the complete application fits every provider's free allowance.

`RENDER_POLL_SECONDS` accepts 15–60 seconds. `RENDER_RECONCILE_SECONDS` accepts
600–3600 seconds. The defaults are 30 and 1800. Longer reconciliation conserves
database activity at the cost of slower recovery after a lost signal. A crashed
claim expires after ten minutes; without a new enqueue signal its next recovery
scan can take up to another reconciliation interval. The persisted job and
original media remain available. Do not clear the database queue to restart a
worker.

Heartbeat/wake keys include a hash of the database and media location. A worker
on another database or bucket cannot enable this API's render UI. Restart both
the API and worker when adopting this release's scoped heartbeat keys. After a
rolling deploy, an old worker's shutdown cannot erase a replacement heartbeat.
Render can briefly overlap old and new instances during deployment; database
claim tokens allow only one current owner of a job, and an expired/replaced
attempt cannot commit its output artifact.

SIGTERM stops further claims and lets the active render finish. The manifest
allows a 300-second shutdown window. A hard kill or prolonged storage outage can
still interrupt an attempt; its durable lease then recovers under the same
bounded retry rules. Worker startup rejects an out-of-date migration revision,
non-PostgreSQL hosted database, plaintext database/Redis connections, local-only
media storage or incomplete R2 configuration.

API startup and worker predeploy can overlap safely: PostgreSQL's transaction
advisory lock surrounds Alembic on the same connection. A 60-second lock timeout
fails a contending deploy instead of proceeding unlocked. Migration failures
roll back that transaction and leave the service unstarted. The migration script
does not drop account or media data during code rollback.

## Verification and operations

Run `python -m pytest test_render_deployment.py test_rendering.py test_startup.py -q`.
These tests use isolated databases and mocked cloud coordination; the FFmpeg
effects test uses generated media. Both Blueprints were also validated against
[Render's published JSON schema](https://render.com/schema/render.yaml.json).
A disposable, network-isolated PostgreSQL 17 test ran two simultaneous migration
processes against a fresh database, reached revision `20260909_0003`, and
preserved a preexisting sentinel row. The temporary database was removed after
the check. See `RENDERING.md` for the separate Linux 1 CPU / 1 GiB effects and
resource test.

Watch worker restarts, render failures, job age, queue saturation, account limits,
Neon compute, Upstash commands, R2 usage and provider error rates. The API's free
instance remains a controlled-demo choice and can sleep; adding a paid render
worker does not make the API or the other providers production capacity. Review
those plans independently before admitting unrestricted users. Do not increase
worker concurrency without repeatable resource tests and revised usage limits.
