# Live streaming and recordings — November 23, 2026

The signed-in production API currently reports Livepeer broadcasting configured,
recording imports disabled, the recording webhook configured, and the recording
worker unavailable. These were read from `/api/live/config` and
`/api/live/recordings/config`; no broadcast, recording or provider write was made.
The 100 MiB / 30 minute recording-import cap is Ziipa's own bound, independent
of a provider's hosted storage allowance.

## Provider decision

Livepeer's November 16 announcement says Studio is winding down:
https://livepeer.org/blog/frameworks-livepeer-studio-transition

FrameWorks currently advertises a free hosted tier with 3 streams, 200 viewers,
10 GB storage, 10,000 delivered minutes/month and 30-day retention. Streams,
viewers and storage have hard limits; delivery above the allowance depends on
spare cluster capacity. This supports a bounded beta, not guaranteed production
capacity. Keep the account on Free with no paid fallback or funding:
https://frameworks.network/pricing

## Remaining activation work

1. Verify a Ziipa-owned FrameWorks Free account and its current terms. No account,
   terms acceptance, API key or new provider access has been created by this work.
2. Implement a separate reviewed provider adapter. FrameWorks uses GraphQL and
   resolved ingest/playback endpoints; changing a Livepeer API URL is insufficient.
   Existing ingest/playback allowlists deliberately accept only Livepeer today.
3. Recreate provider streams and recording configuration. Bind every artifact
   to its owned Ziipa stream. Preserve private-recording and clip consent.
4. Add FrameWorks webhook verification with its documented Standard Webhooks
   headers, timestamp checks and event-ID deduplication. Existing Livepeer
   `asset.ready` handling cannot be treated as a FrameWorks receiver.
5. Restore the existing free workflow/render worker, verify its heartbeat,
   storage access and bounded media-processing capacity, then explicitly enable
   recording imports after checks pass. Do not run persistent FFmpeg processing
   on the Render Free API service or silently provision paid compute.
6. Test one explicitly approved short broadcast end to end: ingest, current live
   playback, stop, recording event, private import, clip render and source editing.
   Check actual account usage and that no paid plan or automatic publication is
   enabled. UI readiness alone does not establish this acceptance.

Migration guide:
https://logbook.frameworks.network/migrate/livepeer-studio/

## UI prepared locally

Recordings is now a compact Live & recordings catalogue, with Live now, Events,
Recordings and Clips. Live cards use fresh verified public streams and validated
playback endpoints, with no automatic preview playback. Events use actual saved
stream occurrences. Recordings and clips use owned sources and preserve existing
consent, revision, preview, retry and cancellation controls. Details and service
readiness are behind explicit controls. This UI does not itself activate a
provider, start a stream, enable a worker or change public visibility.

## Multi-destination beta

The web and native control room use the same destination picker. Ziipa is the
built-in feed. Twitch uses the existing authorized channel. YouTube and Facebook
Pages use their live APIs after explicit Go Live confirmation. Instagram and
TikTok accept provider-issued session credentials from eligible creators, and
may still require an explicit start or stop in the provider's own producer.
Bluesky uses a copyable live watch link.

Deploy migration `20261123_0018` before the new API. Confirm the relay account
is on its free plan with sufficient remaining transcode and delivery allowance,
then enable `LIVE_YOUTUBE_ENABLED`, `LIVE_FACEBOOK_ENABLED`,
`LIVE_INSTAGRAM_ENABLED` or `LIVE_TIKTOK_ENABLED` as accepted in a short test. These
flags default off. `LIVE_MAX_EXTERNAL_DESTINATIONS` defaults to two. It can be
set as high as five after account capacity checks. Ziipa never upgrades a plan
or provisions alternate paid infrastructure. Relays still count against the
provider's usage. The current code uses the existing Studio relay adapter.
FrameWorks's replacement adapter remains independent of these changes.

- YouTube creators reconnect with the additional live scope and select the exact
  channel. The account must have live streaming enabled. A new public event can
  appear as upcoming once the creator confirms Go Live. Test auto-start,
  playback from a second device and auto-stop/explicit completion. This is a
  separate provider broadcast, with provider-specific archive settings.
- Facebook creators authorize the Page and select it before broadcast. Test the
  Page's approved app permissions, actual live video and completion. Paused or
  terminated relay traffic alone cannot prove the external event ended.
- Instagram and TikTok use only the allowlisted TLS ingest formats. Keys are
  shared with the relay for the chosen broadcast and are never stored in Ziipa's
  database or returned in receipts. Remove a target or End broadcast to clear it
  from the relay. Check the provider producer for public playback and final stop.
- Before the wider beta, test picture and sound on each provider with a real
  eligible account, recording off in Ziipa, and no new paid fallback or overage.
  Confirm usage after teardown. Also test reconnect, permission revocation and
  lost provider receipts. A status badge reflects provider evidence. It does not
  verify audiovisual quality.

[Studio Sandbox pricing](https://livepeer.studio/pricing) ·
[FrameWorks Free pricing](https://frameworks.network/pricing) ·
[YouTube broadcast lifecycle](https://developers.google.com/youtube/data/live/life-of-a-broadcast) ·
[Facebook Page Live Videos](https://developers.facebook.com/docs/graph-api/reference/page/live_videos/) ·
[TikTok encoder setup](https://inapp.tiktokv.com/falcon/webcast_mt/page/obs_intro/index.html)
