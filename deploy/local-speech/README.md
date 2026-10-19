# Optional local transcription

`backend/media_transcription.py` provides synchronous, local CPU transcription
for explicitly requested creator workflows. It does not install software,
download a model during a request, call a paid provider, publish media, or change
a saved creation. Keep it disabled on small production API instances until a
separately resourced speech worker is designed and measured.

## Runtime pinned on 2026-10-19

Use the upstream [whisper.cpp b5454 CPU Windows x64 asset](https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip)
from the release corresponding to v1.9.5. The v1.9.5 tag itself has no binary
assets. Its official GitHub release API reports:

- Size: 8,928,640 bytes.
- SHA-256: `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb`.

Use the [upstream GGML tiny English model](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin),
checking the hash even though the URL uses `main`:

- Size: 77,704,715 bytes.
- SHA-256, verified against Hugging Face LFS metadata:
  `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`.

Place verified files in ignored `.local/speech-runtime/`, never in Git or a
frontend bundle. No Python speech dependency is required. The existing FFmpeg
and ffprobe runtime is reused. Tiny English only supports English; installing
a multilingual tiny/base model is an explicit operator choice and requires its
own verified download and acceptance. Larger model files above 200 MiB are
refused. Accuracy is not guaranteed: reviewers must correct words and timing.

The optional `scripts/setup-transcription.ps1` helper repeats this verified
Windows installation in `.local` without global tools or settings changes.
It preserves mismatched existing files, checks archive paths before extraction,
and is safe to rerun against the same verified installation. The optional
[container build](../transcription/README.md) does not activate a cloud service.

## Configuration

Set these in the local API/workflow-worker process environment (or its private
local `.env`). All processes must use the same absolute private work directory
for the cross-process CPU slot to coordinate them.

```text
TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_EXECUTABLE=<absolute path>/whisper-b5454/Release/whisper-cli.exe
TRANSCRIPTION_MODEL=<absolute path>/ggml-tiny.en.bin
TRANSCRIPTION_FFMPEG=<absolute path>/ffmpeg.exe
TRANSCRIPTION_FFPROBE=<absolute path>/ffprobe.exe
TRANSCRIPTION_WORK_DIR=<absolute private writable path>/transcription-work
TRANSCRIPTION_TIMEOUT_SECONDS=75
```

Default is disabled. Execution is CPU-only, two threads, one job per work
directory. No arbitrary user path/URL enters the decoder. The owner/item IDs
resolve database-owned originals through Ziipa's existing private storage
reader. A known rights basis, explicit AI permission, and unexpired rights are
required both before reading and before returning a result. The source
descriptor is rechecked before returning; changing it invalidates the result.
Caller must separately establish explicit transcription consent and its usual
authentication, rate limits, workflow cancellation and proposal persistence.

Inputs are limited to 100 MiB and 90 seconds of supported audio/video. FFmpeg
uses a fixed container allowlist, file-only protocols and bounded 16 kHz mono
PCM extraction. Logs, transcript JSON, caption count/text and process execution
are bounded. The overall processing deadline defaults to 75 seconds (maximum
90); a killed child has up to five additional seconds to exit. Storage reads
retain the existing bounded download/read timeouts. Operating-system CPU/RAM
isolation is a deployment responsibility, not a guarantee made by this module.
The subprocess receives no API, database or publishing credentials.

Temporary source, decoded audio, logs and transcript are deleted on ordinary
success/failure. An abrupt host/process crash may leave the private temporary
directory behind; clean abandoned `speech-*` directories only after verifying
no job is active. Do not unlink `speech.lock` while processes are running.
Transcript persistence/retention belongs to the caller's review record.

## Interface and checks

`transcribe_media(session, owner_id, item_id)` returns `status` (`ready`,
`unavailable`, `no_speech`), `text`, `segments`, `engine`, `detail`. Each segment
has numeric seconds `start`/`end` and plain text, compatible with the existing
caption schema (100 segments, 250 characters per segment). The total transcript
is capped at 16,000 characters. It does not commit or mutate the creation.
Ownership/rights errors raise HTTP 404/403. Missing runtime, busy worker,
unsupported media, timeout and malformed output return unavailable with empty
text/cues and an explicit manual-transcript fallback. Digital silence and
missing audio never produce fabricated captions. Other recognition errors and
hallucinations remain possible and require user review.

Run offline safety tests from `backend`:

```text
.venv/Scripts/python.exe -m pytest test_media_transcription.py -q
```

The opt-in real acceptance test sets `ZIIPA_TEST_TRANSCRIPTION_REAL=1` and uses
only the preinstalled pinned runtime/model plus locally synthesized
`.local/speech-runtime/acceptance.wav`. It never downloads files or reads a
user recording. On this Windows machine, configure a fresh workspace
`--basetemp` if the system pytest temp directory has an incompatible ACL.

The actual FFmpeg → whisper.cpp → normalized subtitle path passed against a
6.3-second synthetic English phrase on 2026-10-19. A brand name was recognized
imperfectly, reinforcing that captions must remain reviewable proposals.

Upstream format/CLI references:
[CLI documentation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/README.md),
[JSON output implementation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/cli.cpp).
