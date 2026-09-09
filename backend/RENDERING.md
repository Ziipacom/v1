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
The opt-in Render deployment, current minimum plan, migration ordering and
operational checks are documented in [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md).

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

Run `python -m pytest test_rendering.py -q`. Tests use an isolated SQLite database
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
