# Private video rendering

The API saves immutable rendering jobs; `python render_worker.py` processes them
separately, one at a time. FFmpeg creates a new owned MP4 containing the saved
trim, timed captions, positioned text overlays and owned/licensed soundtrack.
Original video and audio objects remain unchanged. This is an actual media
transcode, not just metadata attached to a download.

Configure the API and worker with `RENDER_ENABLED=true`, matching database,
Redis and media storage settings. The Docker image includes FFmpeg, ffprobe and
DejaVu Sans. Override `RENDER_FFMPEG`, `RENDER_FFPROBE`, and `RENDER_FONT` with
absolute paths for local Windows operation. Font coverage depends on the selected
Unicode font; install an appropriate licensed font for additional writing systems.
`RENDER_WORK_DIR` holds private temporary processing folders, removed after each
attempt. Do not serve this directory as static content.

Run database migrations before the API or worker. The production worker should
be a dedicated low-privilege service/container with a bounded CPU and memory
allocation, no general outbound internet, and access only to the required private
storage, database and Redis. R2 storage is required when API and worker run on
different hosts; local filesystem mode requires the same mounted media directory.
This worker is not implicitly deployed by enabling the API. Free hosting capacity
may not support a separate media worker; readiness remains false while it is off.
The current free-only Oracle worker package and acceptance gates are documented
in [deploy/oracle-free](../deploy/oracle-free/README.md). The optional paid Render
alternative and migration ordering remain in [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md),
but that paid worker must not be provisioned under the current instruction.

Local runtime used for verification: FFmpeg 9.0.1 Windows essentials, linked from
[FFmpeg's download page](https://ffmpeg.org/download.html) to its Windows build
distributor. Downloaded ZIP SHA-256:
`fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`, matching
[the distributor's checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip.sha256).
The runtime lives under ignored `.local/ffmpeg-runtime`; it is not a repository
dependency or mobile bundle.

API flow:

1. Save the creation and uploaded audio to Ziipa.
2. `GET /api/render/config` reports capability, limits and worker heartbeat.
3. `POST /api/render/jobs` with `item_id` and `soundtrack_rights_confirmed` queues
   the saved version. The confirmation is mandatory when an audio track is used
   and recorded in the private snapshot. There is no commercial music license
   library or automatic rights verification.
4. Poll `GET /api/render/jobs/{id}`. Status is queued, processing, ready, failed,
   stale or cancelled. Repeated requests for the same saved version reuse its job.
   Explicit `retry_failed:true` can retry failed/cancelled/stale attempts.
5. `POST /api/render/jobs/{id}/export` returns an owner-checked download descriptor.
   `POST /api/render/jobs/{id}/cancel` stops a pending output from becoming ready.

Caps are 100 MB per original input, 90 seconds per output, 25 MB per MP4, two
active jobs per account and a small global queue. Output dimensions preserve
aspect ratio inside a 1280-pixel long edge / 720-pixel short edge. Source dimensions
above 4096 pixels are rejected. Each render has a hard subprocess timeout and
fixed thread count. FFmpeg/ffprobe use an explicit CPU detection cap of two, simple
and complex filters use one thread, and glibc allocator arenas are capped at two.
A Docker CPU quota alone does not hide the host's CPU count: unbounded internal
thread pools and allocator arenas can exhaust virtual address space even when
resident memory is modest. The separate Linux child address-space cap remains
1 GiB. See the [FFmpeg options](https://ffmpeg.org/ffmpeg.html#Generic-options)
and [glibc arena controls](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html).
Linux child processes additionally receive
file-size and open-file limits. Timed captions use the source timeline and are
shifted by the trim start. `soundtrack.start` is an offset into the audio source;
its volume is mixed with the original audio and limited to prevent clipping.

Storage admission applies to uploads **and rendered outputs**. Configure the same
values on the API and every worker:

| Variable | Application default | Strict-free profile |
| --- | --- | --- |
| `MEDIA_OWNER_MAX_BYTES` | `1073741824` (1 GiB) | `1073741824` |
| `MEDIA_PROJECT_MAX_BYTES` | `0` (disabled) | `6442450944` (6 GiB) |

The database ledger counts every committed `CreatorMedia` object, including
source video, audio, private drafts and previous exports, plus unexpired direct
upload reservations. Project usage includes every account. PostgreSQL uses a
shared transaction advisory lock followed by the account lock; SQLite uses an
actual transaction write lock because it ignores `FOR UPDATE`. Admission holds
these locks through upload, reservation conversion or output commit. Contention
may return a retryable HTTP 409 for API uploads. Render finalization waits through
brief contention with a PostgreSQL timeout of 30 seconds per lock acquisition;
a blocked database cannot hold the worker indefinitely. Completed reservations are counted once, and
completion rechecks limits if configuration changed since the upload began.
Worker heartbeat identity includes these limits, so mismatched API/worker settings
do not report a matching worker as ready.

An export's verified byte size is checked after rendering and before it is written
to permanent storage. Insufficient capacity fails the job with a storage-limit
message; temporary files are removed and any uncommitted reserved output is
deleted. If provider cleanup fails, the failed job retains its output key for
account-deletion cleanup. Rendering can still consume processing time before this
final admission check. Lowering limits does not delete existing media or invalidate
existing accounts; it prevents new admissions until there is sufficient capacity.

Direct R2 PUT signatures bind `ContentLength` to the reserved byte count. The
API does not return a `Content-Length` header for JavaScript to set: browsers
forbid that header and supply it from known-size `Blob`/`File` bodies, as specified
by the [Fetch standard](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch).
The installed Expo native binary uploader uses an Android file request body with
known length and iOS `URLSession` file upload; no multipart upload or client header
change is needed. Actual Android/iOS uploads to R2 still require device acceptance
testing; local signature tests do not prove a deployed provider accepts requests.

Completion pins its header read to the HEAD response's ETag, conditionally copies
that exact source, then verifies the destination's size, media type and returned
identity before adding it to the ledger. R2 documents support for the needed
`If-Match` and `CopySourceIfMatch` operations in its
[S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/).
Overwrite races, uncertain copy responses and failed output checks do not produce
a catalogued asset. Uncommitted targets are removed where possible; an uncertain
cleanup keeps the reservation available for retry. Pending cleanup removes both
the staging key and any failed target. Expired reservation IDs remain cleanup
anchors until explicit completion cleanup or account deletion; they do not reserve
quota forever. No real R2 write or device upload was performed for these tests.

This is an application ledger limit, **not a provider billing guarantee**. It does
not measure externally created objects, failed/orphan writes, expired reservation
objects, bucket versions, temporary rendering files, request counts or bandwidth.
In particular, replaying a still-valid upload after completion or allowing an
unfinished reservation to expire can leave staging bytes outside the active
ledger. Configure a short storage lifecycle for the `pending-uploads/` prefix and monitor
actual bucket usage; do not put that lifecycle on committed creator objects.
The 6 GiB ledger ceiling leaves headroom but cannot ensure an external free
allowance is never exceeded. No service plan is upgraded by these quota checks.

User text is stored in separate UTF-8 files and passed to `drawtext` with
`expansion=none`. It never enters shell commands, filter expressions or filenames.
FFmpeg is started without a shell, with a minimal environment and fixed demuxers;
only the `file` protocol is allowed. Originals are materialized using owned IDs,
not user URLs. Source/output hashes are stored after successful processing.

Durable claims expire after ten minutes; an interrupted claim can recover once
and then requires an explicit retry. The worker checks a Redis wake revision every
30 seconds and scans the durable queue every 30 minutes when idle. Lost wake
signals or expired claims may wait until that reconciliation scan; submitted jobs
remain in PostgreSQL. These intervals are configurable, and their idle provider
usage is documented in the deployment runbook. The worker rechecks its claim, account,
source ownership and saved input fingerprint under database locks before storing
the artifact. Editing a creation invalidates old render exports even if rendering
already completed. On deletion call `delete_render_jobs(owner_id, session)` while
holding the account lock, before collecting regular media IDs. Completed artifacts
are ordinary private `CreatorMedia`; existing account cleanup removes them too.

Provider publishing uses
`resolve_rendered_media(session, owner_id, item, render_id)` and should include
the returned media ID plus `input_fingerprint(session, item)` in its delivery
fingerprint. It must revalidate immediately before media delivery. R2 signed URLs
are generated from that owned output key; no caller-supplied URLs are accepted.
Original-versus-rendered selection must be explicit in the UI.

Run `python -m pytest test_rendering.py test_media_quota.py test_storage_uploads.py -q`.
Tests use an isolated SQLite database
and generated videos/audio, never real accounts or external posts. The real FFmpeg
test checks output duration, changed overlay pixels, caption timing, both audio
frequencies, output ownership and an unchanged original. Run the same test in the
deployment container before enabling a production worker; Windows verification
does not prove every Linux codec/font combination or all input formats.

The deployable Linux image is also tested with `ZIIPA_RENDER_RESOURCE_TEST=1`.
This opt-in test creates a 90-second 1280×720 moving video, mixes two audio tracks,
and renders an overlay plus 45 timed Unicode captions. It runs the actual queue,
worker, private artifact and stale-version validation code with generated data.
Run the image with `--network none --cpus 1 --memory 1g --memory-swap 1g` and
bind-mount `test_rendering.py` read-only (tests are excluded from production images):

```sh
docker run --rm --network none --cpus 1 --memory 1g --memory-swap 1g \
  -e ZIIPA_RENDER_RESOURCE_TEST=1 \
  --mount "type=bind,source=$PWD/backend/test_rendering.py,target=/app/test_rendering.py,readonly" \
  ziipa-api:release-readiness python -m pytest test_rendering.py -q -s -p no:cacheprovider
```

Use **at least 1 vCPU and 1 GiB RAM for one serial render worker** as the tested
deployment baseline, separate from the API. The representative 90-second test
completed in about 24–26 seconds with approximately 350 MiB whole-container peak
memory on the local Linux Docker host. This is not a throughput guarantee or a
claim that every 4K/variable-rate/complex-font input fits: codecs, input resolution,
caption count, storage latency, host contention and CPU class change resource use.
Keep the existing timeout/memory/input limits and monitor failures and queue wait
time before increasing concurrency. A 256 MiB API free instance is not the tested
worker deployment. The default test run skips this longer resource check.
