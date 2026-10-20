# Editor music providers (free-plan rollout)

The shared native/web music workspace supports owned audio uploads and original
Ziipa-created instrumental composition. SoundCloud connection, discovery, player,
imports and OAuth are not part of this release. No SoundCloud credentials or
subscription are required. Users remain responsible for uploaded-audio rights.
Minting or sharing is a separate explicit choice after saving and reviewing a
creation; creating or attaching music does not automatically publish or mint it.

## AI composition

AI chooses a bounded score (notes, timing and one of eight reviewed synth voices).
The client validates that score and creates at most 30 seconds of PCM WAV. This is
model-composed instrumental music, not a vocal/sample-generating audio model.
The separate local procedural composer is explicitly labeled and never silently
substitutes for an unavailable AI model. No artist-imitation or exclusive-rights
claim is made. Only the user's consented description/settings reach inference;
no uploaded media, library, email or account history is sent.

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

Deploy the API and shared web/native clients. Schema head stays
`20261020_0012`; no music-provider table is added, and the existing `45db0ed`
compact calendar/push worker can remain unchanged. Do not use the prepared but
unexecuted SoundCloud schema0013 worker rollout for this release. Because the
private bridge ships with the website, activate hosted AI only after both API
and website are live. Verify one real score-to-WAV request;
the no-inference status endpoint proves binding configuration, not model output.
No social post, broadcast, notification test or mainnet transaction is part of
this deployment. Rebuild native APKs for changes to the shared editor.

## References

- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/features/json-mode/
- https://developers.cloudflare.com/workers-ai/platform/data-usage/
