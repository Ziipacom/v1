# Oracle Always Free private render worker

This optional package adds **one serial renderer only**. The website, API,
Neon accounts/queue, Upstash sessions, private R2 media, Pinata and blockchain
settings remain where they are. It does not provision cloud resources, upgrade
an account, run paid fallback services or change DNS. Do not deploy the paid
`render-worker.yaml` when using this option. No worker HTTP endpoint is needed.

## Free-account boundary

Use an Ubuntu **ARM64** VM on an **Always Free eligible VM.Standard.A1.Flex**
shape, only if the intended home region has capacity and the account's total
usage fits its free allocation. A **1 OCPU / 4 GiB host** leaves room for Ubuntu
and an image build; the running worker is restricted to **1 CPU / 1 GiB**, with
no swap allowance. Use the existing/free boot-volume allocation; review the
combined size of all boot/block volumes and existing instances before creation.
Do not select trial-only shapes, an Oracle Container Instance, paid images,
additional paid disks, NAT gateways or load balancers. Do not upgrade to a paid
account as a capacity workaround. Stop if the console does not confirm free
eligibility. This package cannot establish or guarantee account billing status.

Oracle can reclaim idle Always Free instances, and capacity is not guaranteed.
Do not add synthetic load or keep-alives to defeat idle reclamation. Rendering
becomes unavailable while the worker is down; accounts, originals and queued
receipts remain in the existing services. Current limits and eligibility are in
[Oracle's Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Keep inbound access limited to SSH from your administrator IP/key. Use a normal
public-subnet Internet Gateway route for outbound access instead of a paid NAT
gateway; publish no container ports. Restrict SSH in the OCI security rules and
host firewall before enabling it. The worker needs outbound TLS to the existing
Neon endpoint (usually 5432), Upstash TLS endpoint (usually 6379) and R2 (443),
plus DNS/time. Installation/builds also need the Ubuntu/Docker/package registries.
No API domain or inbound 8000/8080/443 rule belongs on this VM. Docker bridge
networking permits outbound traffic; it is **not** an outbound domain firewall.

## Install reviewed source and private settings

1. Install Docker Engine and its **Compose plugin 2.30+** using the
   [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
   Use Ubuntu's existing `python3`. Keep SSH keys private and do not add arbitrary
   users to the Docker group (Docker access is root-equivalent).
2. Put the reviewed Ziipa checkout at `/opt/ziipa`, root-owned and not writable
   by untrusted users. Use the **same reviewed release** as the existing API.
   Copy source through SSH or an authorized read-only repository checkout; never
   embed GitHub credentials in a clone URL or this package.
3. Create `/etc/ziipa` with root ownership and mode 0700. Copy
   `worker.env.example` to `/etc/ziipa/render-worker.env` **only if it does not
   already exist**, root:root mode 0600. Fill the eight keys through a secure editor
   with the existing API's exact DATABASE_URL, REDIS_URL, private R2 settings
   and matching media quota limits. The strict-free defaults are 1 GiB per owner
   and 6 GiB for the project; the preflight rejects disabled or larger limits.
   The file lives outside Git. Do not copy the whole API `.env` or add social,
   email, wallet, Livepeer, JWT or publishing-encryption credentials.

Use literal, unquoted `KEY=value` lines. URL-encode passwords inside URLs;
Compose's `format: raw` preserves literal `$` and `#`. Do not `source` the file,
enable shell tracing, print `docker inspect` container environments or run
`docker compose config` without `--quiet` on a live configuration. Docker/root
administrators can read container environment secrets. The offline preflight
rejects extra keys, insecure URLs, open file permissions and the wrong image
architecture without logging the supplied values.

## Build, validate and start

On the **native ARM VM**, from the reviewed checkout:

```bash
cd /opt/ziipa
sudo docker build --platform linux/arm64 --tag ziipa-render:oracle-arm64 backend
sudo python3 deploy/oracle-free/preflight.py
sudo docker compose -f deploy/oracle-free/compose.json config --quiet
```

The existing multi-stage Dockerfile uses ARM64-capable base images for its Node
bridge and Python/FFmpeg dependencies. The native build below must succeed before
acceptance. Build locally; no paid registry, build service or
cross-platform emulation is needed. Keep enough boot-disk space for the image
and build cache (at least 8 GiB before the first build is prudent). Review the
local image ID with `docker image inspect --format '{{.Id}}' ziipa-render:oracle-arm64`;
record it with the source commit. No unattended image pulls/builds occur at boot.

Before enabling the worker, run the generated-media effects test with **no
network or real credentials**, using the same security/resource settings:

```bash
sudo docker run --rm --platform linux/arm64 --network none --cpus 1 \
  --memory 1g --memory-swap 1g --pids-limit 128 --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777 \
  --mount type=bind,source=/opt/ziipa/backend/test_rendering.py,target=/app/test_rendering.py,readonly \
  ziipa-render:oracle-arm64 python -m pytest test_rendering.py -q -p no:cacheprovider
```

Also run the maximum-size scratch acceptance test. It writes **100 MiB video +
100 MiB soundtrack** into the memory filesystem, then produces a 90-second 720p
export with 45 captions, overlay and mixed sound:

```bash
sudo docker run --rm --platform linux/arm64 --network none --cpus 1 \
  --memory 1g --memory-swap 1g --pids-limit 128 --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777 \
  -e ZIIPA_ORACLE_RESOURCE_TEST=1 \
  --mount type=bind,source=/opt/ziipa/backend/test_oracle_resource.py,target=/app/test_oracle_resource.py,readonly \
  ziipa-render:oracle-arm64 python -m pytest test_oracle_resource.py -q -s -p no:cacheprovider
```

Native ARM performance must pass before enabling user rendering; an amd64 or
emulated ARM pass alone is not an Oracle throughput guarantee. The `/tmp` cap
includes both 100 MiB inputs and the 25 MiB export;
temporary contents count against 1 GiB RAM and disappear when the container
stops. The image root is read-only, with no host storage/Docker socket mounted.

Deploy API migrations **once through the existing API release process** before
worker startup. This package deliberately does not auto-migrate at every restart.
The worker's `--require-hosted` startup checks the current schema, TLS
PostgreSQL/Redis and private R2 `HeadBucket` permission before claiming jobs.
Its database/bucket coordination settings must match the API exactly. The API
must have this release's rendering code and matching quota values. On a new
installation, manually set `RENDER_ENABLED=false`. This operator-owned setting
uses `sync: false` in the Blueprint so later syncs preserve the activation state;
the application also defaults to false when omitted. Keep it false until native
acceptance tests pass and the worker is running; then enable rendering in the
existing API configuration and redeploy. The process-only `/api/livez` remains
separate from the intentional `/api/health` dependency diagnostic.

```bash
sudo install -m 0644 deploy/oracle-free/ziipa-render-worker.service /etc/systemd/system/ziipa-render-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now ziipa-render-worker
sudo systemctl status ziipa-render-worker --no-pager
```

Systemd controls one Compose project. Do not run a second worker via `compose up`
or `--scale`. It allows three starts per 15 minutes, then stops after repeated
startup faults instead of creating an endless provider-retry loop. Diagnose the
fault, then use `systemctl reset-failed ziipa-render-worker` before restarting.
Shutdown allows 300 seconds for an active render. A hard kill/OOM retains a
recoverable database lease; do not erase jobs to recover. Check the API render
readiness and complete one short owned-media export before inviting testers.

## Idle quotas, updates and recovery

The 60-second poll creates about **86,400 Redis commands per 30 days** when idle,
plus API traffic and work. Heartbeats live 180 seconds. Hourly reconciliation
uses about **720 PostgreSQL scans per 30 days** and can wake Neon. New requests
normally start within a minute plus queue/startup time; a lost notification may
take an hour to recover. Job claims expire after ten minutes; retries remain
bounded. This is a quota tradeoff, not a promise that every existing free service
can serve unlimited users or store unlimited rendered files.

Monitor Oracle eligibility/storage/egress and existing Neon, Upstash and R2
usage. R2 originals and rendered copies consume shared storage; free allowances
are not application spending caps. Keep the demo closed and stop rendering
before approaching limits. Leave paid upgrades and provider overages disabled
where the account supports that; there is no automatic paid fallback here.

For updates or credential rotation, stop `ziipa-render-worker`, deploy compatible
API migrations first, securely replace the eight-key environment if needed,
rebuild/test the reviewed local image, and start the service again. Keep the
previous image/commit for rollback, but do not roll back database schema blindly.
Never run `docker system prune` indiscriminately on a shared host. Apply Ubuntu
security updates and monitor restart/failure/queue age. Private originals and
outputs stay in R2; local VM disks are not their backup.

## Verification recorded locally

On September 9, 2026, the package/worker coordination tests passed (43 tests)
and Docker Compose accepted the manifest without resolving a private env file.
The maximum-input test above passed in a network-isolated **amd64** Linux
container with the exact 1 CPU / 1 GiB / 256 MiB tmpfs limits. Repeating it on
the final image alongside upload/quota/render checks passed 28 tests (1 skipped):
22.23 seconds render time, 229,589,943 scratch bytes, and 636,133,376 bytes
whole-container peak memory. These are measured local results, not an ARM speed
estimate. The final image manifest is
`sha256:4dadce7d3cb67ca7bd3330ce661c75c0eb375aa7103f0b95af9f23040322a7cc`.

## Native Oracle acceptance, September 9, 2026

The approved `ziipa-render-free` host was created in the tenancy's Ashburn home
region using Always Free A1, 1 OCPU / 4 GB RAM and the default 46.6 GB boot
volume. The account allocation was checked before creation. No paid worker,
extra volume, NAT gateway, load balancer or registry was provisioned.

The published backend from `a56d076` built natively on Ubuntu 24.04 ARM64 with
Docker 29.8.0 and Compose 5.5.1. Image manifest:
`sha256:1f3ccec3603a56246cb64a7442b4b6ffb1402f41a6bad943d05639ec81f53bd0`.
The subsequent `6470114` commit changed CI only, leaving this backend identical.

Offline effects and maximum-input tests passed **10 tests, 1 skipped** under the
exact 1 CPU / 1 GiB / read-only / 256 MiB tmpfs limits. The 90-second export with
two 100 MiB inputs, 45 captions, overlay and soundtrack took **40.03 seconds**,
used **229,619,733 scratch bytes** and peaked at **514,473,984 container bytes**.
These are one-host test measurements, not a throughput guarantee.

Live one-shot checks verified PostgreSQL TLS and schema `20260909_0003`, verified
Redis TLS, and R2 HTTPS access. An 89-byte generated, private deployment-check
object was written, read back and deleted; absence was verified. No user media,
accounts, jobs, emails or social posts were used for that probe.

The eight-key environment passed the root-only preflight. The systemd worker
started and a fresh scoped Redis heartbeat was observed. Only the approved
administrator address can reach SSH through both OCI and the host firewall;
password/root SSH is disabled. No container port is published. Administrative
addresses and key locations are kept outside Git.

An authenticated browser/mobile upload-to-export flow and provider/store review
remain separate acceptance steps. Native tests and a worker heartbeat alone do
not establish release equivalence or readiness for an unrestricted public launch.
