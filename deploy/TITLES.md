# Creation title suggestions

The shared web/iOS/Android Creator Studio requires a nonblank title for both draft
and published saves. Uploading or taking a picture never copies its filename into
the title. Old camera filenames and UUID titles are cleared only in the editor,
so a descriptive replacement is required on the next save. Stored posts remain
unchanged until the author explicitly saves. Other existing titles are preserved.

An AI autofill switch next to the title controls preview sharing for this editor
session. Once enabled, selecting visual media automatically sends one fresh JPEG
(maximum512px on each side, maximum144KiB) from the primary photo or a source video
frame. At the beginning of a video it samples up to1second in to avoid the usual
black opening frame. No original file, audio, filename, account history, library
context, existing title or existing description goes to inference.

The response supplies a title and a factual1–2sentence description. Both go
directly into empty editing fields as values, not placeholders. There are no
Suggest or Use buttons. Fields already written by the creator are preserved,
including edits/clears while inference is pending. Replacing media can refresh
unmodified AI text. The same source runs at most once per editor session. Turning
autofill off, leaving the editor, switching accounts or starting a save discards
late results. The switch resets for another account or editor session.
Review/edit the form before saving. Autofill never saves or publishes a creation.
Audio-only media use manual title/description entry.

## Activation

Both switches default OFF. Deploy the API, Worker routes and shared clients first.
Confirm the Cloudflare account remains on Workers Free. Review the existing
privacy notice before activation; publish the visual-preview processing addendum
under the site's established approval process if needed.

The fixed model is `@cf/meta/llama-3.2-11b-vision-instruct`. Its current Cloudflare
documentation requires explicit acceptance of the Meta Llama3.2 license and use
policy. Obtain the operator's approval before sending the documented one-time
`prompt: "agree"` request. This code never accepts model terms automatically.

After the license is accepted and a synthetic image is verified through the
binding, set Worker `ZIIPA_TITLE_AI_FREE_ENABLED=true` and API
`TITLE_AI_ENABLED=true`. Reuse the existing private `ZIIPA_PROXY_SECRET` and
`ZIIPA_MUSIC_AI` binding; never place credentials in an EXPO_PUBLIC variable.
Check `/api/editor/title/config` while signed in. It must report available and
metadata_version2. The API verifies that the Worker also supports version2; old
title-only responses do not enable combined autofill. Enable AI autofill and
select a photo/video, verify both form values, then save a private draft and
reopen it. No production content should be published by tests.

The API authenticates users and CSRF-protects cookie mutations. Redis limits
suggestions to4 per user per10minutes and20 per UTC day across the whole app,
with one35second distributed lease. A Redis outage fails closed. Workers Free
enforces the shared provider allowance; there is no paid plan or alternate model
fallback. Other AI features share the Workers Free daily allowance.

The private bridge accepts a purpose-bound HMAC from the API, rejects browser
origins, arbitrary URLs/prompts, oversized inputs, and JPEG dimensions over512px.
It returns bounded plain title/description fields in JSON. No preview is stored in Redis or the database.
Provider processing follows Cloudflare's terms; do not promise on-device inference.

Turn either switch off to disable suggestions. A manual title always works.

References:
- https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/
