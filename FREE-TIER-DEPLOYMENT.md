# Ziipa free-only deployment

Decision recorded 9 September 2026: preserve the existing free services and do
not provision the $25/month Render worker, upgrade a plan, add a payment method,
or enable a pay-as-you-go fallback. Oracle Always Free is the selected worker
target because Cloud Run requires a billing account and can charge for usage,
registry storage and transfers. The approved Always Free Oracle host is now
provisioned and has passed native ARM rendering acceptance.

## Services to preserve

| Component | Existing service / selected target | Action |
| --- | --- | --- |
| Website and shared Studio | Cloudflare `ziipa-frontend` | Preserve its account, domains and proxy secrets; no paid Containers. |
| FastAPI | Render `ziipa-api`, Free | Free plan freshly confirmed; keep the API-only `render.yaml`, no paid compute or disks. |
| Accounts and durable render queue | Existing Neon database | Reuse, do not migrate accounts or create another database. |
| Sessions, rate limits and queue hints | Existing Upstash database | Reuse; do not upgrade or add billing. |
| Private media | Existing R2 `ziipa-media` | Preserve credentials/privacy; use ledger limits and review actual bucket usage. |
| NFT media/metadata | Existing Pinata | Preserve current free account; video playback remains on R2. |
| Livestreams | Livepeer Sandbox | Confirmed Free with no payment method on 9 September; leave unchanged. |
| Demonstration blockchain | Base Sepolia | Testnet only; deployed contracts and wallet acceptance remain unverified. |
| Rendering | Oracle Always Free A1 | `ziipa-render-free` running; native ARM tests and hosted storage checks passed. API activation and user-flow acceptance are separate checks. |
| Email / monitoring | Existing Resend / Sentry | Preserve current services and limits; do not enable paid overages. |

The current Neon browser session reports the Ziipa project not found; Upstash
reports its Ziipa database inaccessible to that session. Those findings do not
prove data loss or an outage; direct hosted connection checks passed from Oracle.
No accounts or databases were migrated or replaced.
Their owner dashboards must be accessible before claiming their plans and usage
have been freshly verified. Do not substitute another project's infrastructure.

## Oracle configuration

Use [deploy/oracle-free/README.md](deploy/oracle-free/README.md) for the worker
package and exact validation/start commands. Select only an **Always Free
eligible** Ubuntu A1 VM in the account's home region. Allocate 1 OCPU, 4 GB RAM
for the OS, image build and bounded worker, and the default 46.6 GB boot volume,
provided the tenancy has room within its existing free allocation. Existing
account allocations count too. No paid shape, extra disk, NAT gateway, load
balancer, marketplace image or automatic paid fallback is part of this setup.

The official Always Free allowance currently lists 1,500 OCPU-hours and 9,000
GB-hours per month (equivalent to 2 OCPUs / 12 GB total), plus 200 GB combined
boot/block storage. Capacity is not guaranteed and idle instances can be
reclaimed. Never generate fake load or keep-alive traffic to avoid reclamation.
See [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

The worker exposes no public HTTP port and needs no domain. Allow SSH only from
the administrator's approved address, keep the host patched and store worker
secrets in the root-owned file specified by the runbook. Only Neon, Upstash and
private R2 credentials belong there. Social OAuth, Livepeer, email, wallet and
publishing encryption keys stay on the API. Do not put credentials in cloud-init,
container images, Git, command lines or screenshots.

The Windows Docker host could not execute ARM64 images, so no privileged
emulator was installed. Instead the published backend was built and tested
directly on the A1 host. The private systemd worker is running with a fresh
Redis heartbeat; there is no paid worker fallback.

The new API code and migrations are deployed. Its media limits are
`MEDIA_OWNER_MAX_BYTES=1073741824` and
`MEDIA_PROJECT_MAX_BYTES=6442450944`, matching the Oracle worker. Process health
uses `/api/livez`; a successful deploy is not proof of all real user flows.

## Free-usage safeguards

- One serial worker: 1 CPU / 1 GiB container allocation, bounded temporary media,
  300-second graceful shutdown and bounded restart attempts. Database leases
  preserve queued work if the VM is interrupted.
- `RENDER_POLL_SECONDS=60` and `RENDER_RECONCILE_SECONDS=3600`: approximately
  86,400 Redis commands and 720 database reconciliation scans per 30 idle days,
  before application traffic, startup, monitoring and retries. New work can wait
  roughly one polling interval; a lost hint can wait until hourly reconciliation.
- `MEDIA_OWNER_MAX_BYTES=1073741824` and
  `MEDIA_PROJECT_MAX_BYTES=6442450944` must match on API and worker. The 6 GiB
  project ledger limit leaves headroom below R2's 10 GB Standard storage
  allowance; active upload reservations and rendered outputs count too.
- Storage limits do **not** cap R2 billing: orphaned or externally written
  objects, other buckets in the account, requests and historical usage require
  provider-side review. Never delete user media simply to meet an allowance.
  See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- Use `/api/livez` for the host's process check. `/api/health` still checks Neon
  and Redis and should be used for intentional diagnostics, not a frequent
  keep-awake monitor. Do not ping a sleeping free API to defeat its plan limits.
- The Livepeer dashboard confirmed Sandbox allowances of 1,000 transcoding
  minutes, 60 storage minutes and 5,000 delivery minutes per month, up to 30
  concurrent viewers. Do not select Growth or add payment details. These are
  provider allowances, not an unrestricted streaming promise.

Free allowances are account-wide/provider-specific and can change. No single
application flag guarantees a zero invoice across every provider. Stop admitting
new uploads, exports or broadcasts when a verified free allowance is exhausted;
preserve existing accounts and media and require an explicit budget decision
before any upgrade. Do not add credentials to paid services as an automatic fix.

## Safe activation order and current blockers

1. Owner signs into the Ziipa Oracle Free Tier account; the tab is open in Chrome.
   If no account exists, owner registration/identity verification is required.
   Keep the account free; do not accept a paid upgrade for capacity.
2. Review the VM's Always Free eligibility and total account allocation, then
   provision and build the reviewed source natively. Run the package's offline
   checks and real media tests before adding cloud credentials.
3. Deploy the reviewed API code/migrations with `RENDER_ENABLED=false`, the shared
   media limits and the `/api/livez` health path. Do not switch the existing
   service's health path before code providing that endpoint is deployed.
4. Securely configure the worker, verify hosted database schema, TLS, Redis and
   private R2 access, then start one worker. Do not perform production migrations
   implicitly on every worker restart.
5. Enable rendering on the API only after a worker with the matching database,
   bucket and limits is healthy. Update the API deployment setting intentionally;
   `RENDER_ENABLED` is operator-owned (`sync: false`) so later Blueprint syncs
   preserve it. Enter false for a new deployment until acceptance succeeds;
   the application defaults to false if the setting is omitted.
6. Use a designated test account and owned short clip to verify private upload,
   edited export, quota rejection, stale-draft protection and cleanup. No social
   posting or public broadcasting is part of provisioning the render worker.

## Local verification

The final backend run passed **317 tests, with 2 skipped**, excluding the
separate blockchain suite (`test_web3.py`). The final Linux amd64 image built
successfully. Offline upload/quota/render checks in that image passed **28 tests,
with 1 skipped** under the 1 CPU / 1 GiB / read-only / 256 MiB temporary-storage
restrictions. The generated maximum-input render finished in **22.23 seconds**,
using 229,589,943 scratch bytes and 636,133,376 bytes peak container memory.
The native Oracle ARM test subsequently passed 10 tests (1 skipped). Its
maximum-input render took 40.03 seconds, with 229,619,733 scratch bytes and
514,473,984 bytes peak container memory. Read-only hosted schema/TLS checks and
a disposable private R2 write/read/delete probe also passed. Browser/mobile
presigned uploads and authenticated edited export remain separate acceptance
checks. No real media was publicly posted.

The shared Studio/API release `a56d076` was pushed and deployed to Cloudflare
and Render. CI-only follow-up `6470114` passed all four jobs: backend 323 passed
(2 skipped), production image rendering 10 passed, plus frontend/mobile/contracts
checks. Temporary repository-only deploy keys were removed immediately after
each push; no broad OAuth access was added. Local previews were left unchanged.

Live website and Studio checks verified https://ziipa.com, its portal sign-in,
and `/studio/` assets. These deployment checks do not complete production email,
social-provider approvals, native device testing, wallet acceptance or store
submission. Keep the demo controlled and verify provider usage in owner accounts
before expanding access.
