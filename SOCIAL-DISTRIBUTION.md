# Ziipa social distribution

The mobile Creator Studio now stores one Ziipa source creation with its trim,
caption, overlay, soundtrack, metadata, and selected distribution targets. The
Connected networks screen shows account state, Ziipa media, and the latest
delivery result for every target.

## Local behavior

- Creator media accepts common image, video, and audio formats up to 100 MB per
  file and 1 GB per local account. The API validates file signatures before it
  stores bytes.
- Publishing first creates the Ziipa item. The API then creates idempotent
  distribution records for Bluesky, Facebook, Instagram, TikTok, Twitch, and
  YouTube.
- When a provider is not connected, its record is `connection_required`.
  Unsupported combinations, such as a non-live Twitch upload, are recorded as
  `unsupported_media`. No UI presents either state as a completed post.
- Sample mode uses clearly labeled in-memory connections and distribution plans.
  It never transmits media to an external provider.

## Required provider setup

Set public client identifiers through the matching `SOCIAL_*_CLIENT_ID`
environment values only after Ziipa has registered and received the required
provider review. Client secrets, access tokens, refresh tokens, signing keys,
and Twitch stream keys must stay in a production secret manager and encrypted
server-side storage; they must never use `EXPO_PUBLIC_*` variables.

Direct delivery remains disabled until each provider adapter has an OAuth
callback, encrypted token lifecycle, scopes, revocation, media conformance,
status reconciliation, retry policy, webhook verification, and production HTTPS
media URL. The local loopback media URLs cannot be fetched by external networks.

Provider-specific constraints must remain visible to creators. TikTok requires
approved posting scopes and may route an upload to the creator's TikTok inbox.
Instagram publishing requires an eligible professional account. Facebook
publishing uses authorized Pages. Twitch is modeled as a live destination because
its current public workflow centers on RTMP ingest and channel VODs. Bluesky must
use AT Protocol OAuth rather than collecting account passwords.

## Delivery worker acceptance criteria

1. Publish an immutable source version so retries use identical media and edit
   settings.
2. Render overlays, captions, and licensed soundtrack audio into provider-ready
   derivatives without changing the source.
3. Submit idempotently and persist the provider job identifier before retrying.
4. Verify webhooks and poll only within provider rate limits.
5. Show queued, action-required, processing, published, and failed states in the
   Ziipa delivery center, including a safe external post URL when available.
6. Revoke tokens and stop queued work immediately when a user disconnects an
   account.
