# Editor music providers (free-plan rollout)

The shared native/web music workspace keeps three distinct paths: owned audio,
an optional SoundCloud connection/player, and original instrumental composition.
SoundCloud playback is not a source for editor mixing, copying, sampling or AI.
New SoundCloud application credentials require Artist Pro; do not purchase it
under Ziipa's free-only constraint. Use an existing eligible registered app, or
leave the connection unavailable and retain official external discovery.

## AI composition

AI chooses a bounded score (notes, timing and one of eight reviewed synth voices).
The client validates that score and creates at most 30 seconds of PCM WAV. This is
model-composed instrumental music, not a vocal/sample-generating audio model.
The separate local procedural composer is explicitly labeled and never silently
substitutes for an unavailable AI model. No artist-imitation or exclusive-rights
claim is made. Only the user's consented description/settings reach inference;
no uploaded media, SoundCloud audio, library, email or account history is sent.

`MUSIC_INFERENCE_PROVIDER=private` uses the existing protected local/private LLM.
`MUSIC_INFERENCE_PROVIDER=cloudflare` uses the fixed
`https://ziipa.com/internal/music-inference` bridge, authenticated with a
purpose-specific HMAC of the existing Render/Cloudflare `ZIIPA_PROXY_SECRET`.
There is no client-visible API key or arbitrary inference URL/model/tool input.
Redis enforces one active composition, four attempts per user per ten minutes,
and at most twenty Cloudflare attempts per UTC day; Redis failure blocks use.

The Cloudflare Worker has `ZIIPA_MUSIC_AI` bound to Workers AI and invokes only
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, with 650 output tokens and no tools,
logging gateway or paid fallback. After independently confirming Workers **Free**,
an operator may set `ZIIPA_MUSIC_AI_FREE_ENABLED=true`. Its default is off. Never
activate this flag on a paid plan. Cloudflare's Free daily AI allowance is a hard
provider limit; other applications on the account share that allowance. Quota
exhaustion returns an unavailable message, not a paid upgrade. Recheck the plan
before each activation or billing change.

First deploy the API and matching worker/schema, then the shared web/native
clients. Because the private bridge ships with the website, activate hosted AI
only after both API and website are live. Verify one real score-to-WAV request;
the no-inference status endpoint proves binding configuration, not model output.
No social post, broadcast, notification test or mainnet transaction is part of
this deployment. Rebuild native APKs for changes to the shared editor.

## References

- https://developers.soundcloud.com/docs/api/guide
- https://developers.soundcloud.com/docs/api/terms-of-use
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/features/json-mode/
- https://developers.cloudflare.com/workers-ai/platform/data-usage/
