# Reviewed editor caption proposals

The shared editor reads saved, owned video/audio through explicit opt-in speech
recognition. `GET /api/editor/captions/config` reports actual runtime readiness
and the current processing recipient. `POST /api/editor/items/{id}/captions`
requires a unique request UUID, the expected source media UUID, current provider,
and literal consent. Media metadata must declare unexpired rights and AI use.
The endpoint returns a temporary job; clients poll its owner-scoped result.

Recognition does not mutate a creation. Review/edit/apply is a separate client
step; saving then persists the mapped caption track and private source cues.
Cuts, sequence order and speed are applied using the original cue timestamps.
Raw source cues are omitted from all public item serialization by default.

Jobs use existing Redis with a 15-minute TTL, one global processing lease, one
local executor, three requests per user per ten minutes and a global daily cap.
They are temporary API background work, not durable calendar jobs. A restart,
deadline, source/rights change or provider/storage failure stops the proposal;
the UI requires an explicit retry. Existing saved captions remain unchanged.
The maximum source is 100 MiB / 90 seconds and 100 real timed cues. No plain
text-only response is assigned guessed timings. No schema migration is required.

## Private runtime

Set `CAPTION_ENABLED=true`, `CAPTION_INFERENCE_PROVIDER=private` and configure
the existing `TRANSCRIPTION_*` pinned local Whisper/FFmpeg runtime. The API must
have sufficient memory for this engine; do not enable neural processing on the
256 MiB compact Oracle reminder worker. No model is downloaded at request time.

## Optional Workers Free runtime

After verifying the existing Cloudflare account remains **Workers Free**, set
`ZIIPA_CAPTION_AI_FREE_ENABLED=true` on `ziipa-frontend`. Its `ZIIPA_MUSIC_AI`
binding is reused, as is the already protected matching `ZIIPA_PROXY_SECRET`.
On the API use `CAPTION_ENABLED=true` and
`CAPTION_INFERENCE_PROVIDER=cloudflare`. FFmpeg/ffprobe are present in the API
image. Keep the private Whisper model disabled on the small API instance.

The fixed private bridge is `https://ziipa.com/internal/caption-inference`;
its signed `/status` request proves configuration without running inference.
Render sends canonical mono16kHz16-bit PCM WAV bytes, at most 2,880,044 bytes.
HMAC-SHA256 signs `ziipa-caption-v1\n{unixSeconds}\n{sha256(rawBytes)}` using
the existing secret, with `X-Ziipa-Caption-Timestamp` and
`X-Ziipa-Caption-Signature` headers and a 30-second clock window. There are no
client keys, arbitrary URLs, model controls or browser-facing inference access.

The Worker invokes only `@cf/openai/whisper-large-v3-turbo`, without an AI logging
gateway, prompts, storage or paid fallback. It returns bounded real model cue
timestamps; the API validates them again. Captions and music share a maximum
20 hosted requests per UTC day. Cloudflare's account-wide Free allowance is
separate and hard-limited; exhaustion returns unavailable. Do not upgrade billing
to bypass the quota. Recheck the plan before activation or any billing change.

Deploy the matching API and shared web/native client before activation. Verify
one synthetic speech request separately from readiness; do not use private user
audio for acceptance or send notifications/posts/mints as deployment tests.

Primary references:

- https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/data-usage/
