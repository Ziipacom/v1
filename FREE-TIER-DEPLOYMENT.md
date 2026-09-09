# Ziipa free-only deployment

Decision recorded 9 September 2026: preserve the existing free services and do
not provision the $25/month Render worker, upgrade a plan, add a payment method,
or enable a pay-as-you-go fallback. Oracle Always Free is the selected worker
target because Cloud Run requires a billing account and can charge for usage,
registry storage and transfers. This is a deployment target, not a claim that
Oracle has already been provisioned.

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
| Rendering | Oracle Always Free A1 | Pending owner sign-in, free capacity, native ARM64 build and acceptance. |
| Email / monitoring | Existing Resend / Sentry | Preserve current services and limits; do not enable paid overages. |

The current Neon browser session reports the Ziipa project not found; Upstash
reports its Ziipa database inaccessible to that session. Those findings do not
prove data loss or an outage. No accounts, databases or credentials were changed.
Their owner dashboards must be accessible before claiming their plans and usage
have been freshly verified. Do not substitute another project's infrastructure.

## Oracle configuration

Use [deploy/oracle-free/README.md](deploy/oracle-free/README.md) for the worker
package and exact validation/start commands. Select only an **Always Free
eligible** Ubuntu A1 VM in the account's home region. Allocate 1 OCPU, 4 GB RAM
for the OS, image build and bounded worker, and one standard 50 GB boot volume,
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

The current Windows Docker host cannot execute ARM64 images (`exec format
error`). A native build and the real FFmpeg resource test on the A1 VM remain
required. An amd64 Docker test is not ARM validation. The local Ziipa worker
remains the development fallback; it is not proof of public renderer readiness.

Saved `MEDIA_OWNER_MAX_BYTES=1073741824` and
`MEDIA_PROJECT_MAX_BYTES=6442450944` to the existing Render API with **Save only**
and verified both saved rows. No credentials were replaced and no deploy was
triggered. These limits require the new code before they become effective.

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
   the default Blueprint keeps rendering off until this acceptance step.
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
These measurements do not establish Oracle ARM performance or real R2/mobile
compatibility; those acceptance checks remain pending. No real media was posted.

The source changes remain local until pushed/deployed. Prior GitHub CLI
access was read-only for `Ziipacom/v1`; this turn's check still reports no push
permission. Do not bypass the rejected broader OAuth grant. There is no claim
that the new worker, quota safeguards, liveness route or shared Studio release
is currently live. Existing local previews remain unchanged.
