# Creator audio and narration

The editor's Audio step contains owned audio uploads and three AI Creation tabs:
AI composer, AI Voice Narration, and Offline fallback. Composer creates an
instrumental score. Narration turns the chosen script into speech. Offline
fallback creates procedural instrumental music; it is not AI voice synthesis.

## Preset narration

The preset adapter uses only `@cf/deepgram/aura-1` hosted by Cloudflare Workers
AI. It does not call Deepgram's separate paid API. Only the explicitly approved
script and selected preset are sent; no microphone recording, private media URL,
library, account profile, or voice embedding is sent to this model.

Scripts are limited to 300 characters and returned speech to 30 seconds.
The private API normalizes bounded PCM to a mono 22,050 Hz, 16-bit WAV for the
existing editor audio pipeline. Users must preview and explicitly attach the
result; synthesis does not publish, save a creation, mint, or schedule anything.
The adapter does not certify ownership or exclusive rights in generated audio.

The API requires account authentication, the normal write guard, explicit
processing consent, a fixed voice allowlist, and fail-closed Redis limits.
The internal bridge accepts only fresh purpose-specific signed requests and
cannot select another model, provider, endpoint, or paid fallback. Invalid,
oversized, unavailable, or exhausted responses fail without automatic retries.

## Free-plan activation and acceptance

Production activation is separate from source implementation and APK packaging.
`NARRATION_ENABLED` defaults off in the API. The bridge's
`ZIIPA_NARRATION_AI_FREE_ENABLED` and `ZIIPA_NARRATION_AI_VERIFIED` flags default
off. They use the existing Workers AI binding and private proxy secret; no
new unauthenticated inference access or client credential is granted.

Before enabling, verify the actual account remains on Workers Free, review the
model terms, and run a public, non-sensitive test sentence through the fixed
model. Inspect the real WAV, duration, intelligibility, voice mapping, quota
failure, and returned editor attachment. Do not accept new legal terms on the
user's behalf. A configuration/status response or a mocked test alone does not
establish live synthesis acceptance.

Cloudflare's allowance is shared with the app's other AI features. Do not upgrade
the plan, add payment information, enable paid overages, or switch provider when
the allowance is exhausted. Local application caps are additional restrictions,
not a guarantee of remaining account-wide allowance.

## Recording and own-voice cloning

Local recording requires an explicit own-voice consent selection and Record
press before asking for microphone permission. Recordings remain local until
the user explicitly attaches and saves them. Capture must stop on background,
navigation, cancellation, or unmount; discarded temporary audio must be deleted.
Recording one's narration is distinct from cloning a voice.

Own-voice cloning is unavailable on the current production runtime. Do not
upload a reference, retain an embedding, imitate an arbitrary person, or present
a preset voice as a clone. A future cloning adapter must use an owner-approved
reference and separate processing consent, private access controls, bounded
temporary jobs, explicit deletion, and no reference/embedding retention by
default. Generated speech must be identified as synthetic.

OpenVoice V2 with MeloTTS is a possible free, MIT-licensed implementation. It
still needs an isolated, pinned runtime; model and dependency license checks;
native ARM compatibility; measured memory, latency and output quality; and a
working host. Official CPU support does not establish that Ziipa's four-GiB
Oracle allocation can run the complete environment. Do not install these
dependencies into the production API or run inference on the Micro scheduler.
The current Oracle renderer recovery failure does not constitute a cloning
runtime, and restoring video rendering alone will not enable cloning.

Primary references reviewed 2026-10-22:

- [Cloudflare Aura-1 model and supported audio parameters](https://developers.cloudflare.com/workers-ai/models/aura-1/)
- [Deepgram's Aura-1 voice and accent catalog](https://developers.deepgram.com/docs/tts-models)
- [Workers AI Free allocation and hard limits](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI data processing](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [OpenVoice code and license](https://github.com/myshell-ai/OpenVoice)
- [MeloTTS code and license](https://github.com/myshell-ai/MeloTTS)

Live model, physical Android recording/playback, own-voice cloning, and production
video rendering each require their own recorded acceptance. Do not infer any of
them from a successful source test, web export, or signed APK build.
