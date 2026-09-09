# Ziipa social connections and distribution

## Network hub: implemented behavior

The mobile **Connected networks** hub uses the authenticated FastAPI API. Each
Ziipa account can save one profile link for Bluesky, Facebook, Instagram, TikTok,
Twitch and YouTube. Links persist in the account database and can be opened on
the provider. A link is labeled **Public profile linked**, not connected through
OAuth: it does not verify ownership, authorize private data access, or grant
permission to publish. Other users cannot read or change your saved links.

For Bluesky, **Sync** really calls the official public AppView. Each manual sync
retrieves the linked public profile, up to 30 recent author-feed posts, and up to
50 followed profiles. Author feeds can include reposts. The People view means
**following**, not verified friends, address-book contacts or reciprocal follows.
This is a bounded snapshot, not an import of every historical post, an authorized
personalized home timeline, or background synchronization. Profile handles are
resolved to a DID on the first successful sync; subsequent syncs use that DID.

Facebook, Instagram, TikTok, Twitch and YouTube profile links can be saved and
opened now. Their public-link hub does not import authenticated feeds or graphs.
Public profile linking does not collect passwords or tokens.
The separate **Publishing accounts** flow now implements OAuth and consented
video delivery for YouTube, TikTok, Facebook Pages, linked professional Instagram
accounts and Bluesky. Twitch has authorized channel/live controls and a bounded
followed-channel list; it is not a generic video-upload destination. The flow
can use an original file or a verified ready FFmpeg export and keeps tokens encrypted on the
server. See [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md) for the real adapter,
operator configuration, approval, media and native-login limits; public client
IDs alone never enable direct delivery.

**Share/export** returns only an original media file that the signed-in Ziipa
user owns. The frontend can hand this file to the system sharing interface or
offer a download for manual posting. It does not claim that the destination
accepted or published the file. Overlays, trim instructions and soundtracks are
editing metadata until the separate FFmpeg worker creates a ready export; the
original sharing endpoint is not advertised as a rendered edit. Invitations open the user's
sharing interface with the public Ziipa landing URL, never send unsolicited
messages or expose a Ziipa session token.

### API contract

All routes below require a Ziipa web session or mobile bearer session; writes
also enforce origin checks and request limits.

- `GET /api/social/hub`: provider capabilities, saved links, the last imported
  public media and people, an invite URL, and privacy/capability notices.
- `POST /api/social/{provider}/link`: `{handle?, profile_url?}`; validates the
  selected platform and canonicalizes its profile URL. It never requests the
  supplied URL. Editing an identity discards the previous identity's snapshot.
- `POST /api/social/{provider}/connect`: a truthful `setup_required` result with
  `auth_url: null` and operator setup requirements; it does not fake connection.
- `POST /api/social/{provider}/sync`: refreshes the public Bluesky snapshot and
  returns the hub. Other providers return an actionable integration-required
  response, not fabricated feeds. Failed public syncs retain the last successful
  snapshot with an explicit error and last-success timestamp.
- `POST /api/social/{provider}/disconnect`: deletes that profile and imported
  snapshot, and stops pending distribution state for the provider. Published
  history is retained. Repeating disconnect is safe.
- `POST /api/social/media/{media_id}/export`: owner-only `{url, content_type,
  size}`. Local URLs are relative authenticated media paths; R2 URLs are short
  lived HTTPS signed download URLs. Never forward a Ziipa bearer token to an
  external signed URL. Even another user's published media cannot be exported
  through this owner-only handoff endpoint.

Connections and snapshots reuse the existing `creator_connections.data` JSON
column, with a version and revision marker. No schema migration or new backend
dependency is needed. Account data export includes the sanitized hub; account
deletion removes its links and snapshots. Disconnecting a profile does not
delete content already published on the external network.

### Public sync safeguards

- Fixed `https://public.api.bsky.app` request origin and three allowlisted XRPC
  methods; no DID-document fetch, arbitrary URL fetch, or redirect following.
- HTTPS profile URL allowlists; credentials, custom ports, tracking parameters,
  unknown profile paths and malformed handles are rejected.
- No Ziipa session or provider secrets sent to the public API. Response byte
  limits, a 20-second deadline for the entire sync (in addition to individual
  request idle timeouts), item limits and allowlisted thumbnail origins bound
  imports. The API releases its database connection during outbound requests.
- A Redis-backed per-user/per-provider cooldown permits one sync per minute,
  in addition to normal API rate limiting. Redis failures fail closed.
- Import results are saved only if the profile revision still matches after
  network I/O. Concurrent disconnect/relink cannot restore the old identity.
- Provider errors do not leak upstream response bodies or internal details.

`SOCIAL_PUBLIC_SYNC_ENABLED=true` enables the read-only import. Set it to false
to disable outbound sync. `SOCIAL_INVITE_URL=https://ziipa.com` defines the
public invitation destination; do not use localhost or a token-bearing URL.

Tests run against the dedicated Redis test DB and rollback-only PostgreSQL
transactions: `backend/.venv/Scripts/python.exe -m pytest test_api.py
test_social.py -q` from `backend`. All provider responses in tests are mocked;
tests never post, follow, invite, or contact a real social account.

Official source contracts:

- [Bluesky author-feed lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json)
- [Bluesky following-list lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/graph/getFollows.json)
- [Bluesky public-profile lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/getProfile.json)
- [AT Protocol permission requests](https://atproto.com/guides/permission-requests)
- [Twitch OAuth authorization and token validation](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)

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
- Sample mode uses clearly labeled temporary local profile links and distribution
  plans. It never claims an authenticated provider connection or transmits media
  to an external provider.

## Required provider setup

Set public client identifiers through the matching `SOCIAL_*_CLIENT_ID`
environment values only after Ziipa has registered and received the required
provider review. Client secrets, access tokens, refresh tokens, signing keys,
and Twitch stream keys must stay in a production secret manager and encrypted
server-side storage; they must never use `EXPO_PUBLIC_*` variables.

Direct delivery through the separate `/api/publishing` API requires the
operator configuration and provider approvals documented in
[SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md). The older creator distribution
plans remain intent records, not proof of an external post. Actual upload
receipts live in `publishing_jobs`; unsupported adapters never claim success.
Instagram needs an approved public HTTPS URL for an owned video in R2. Local
loopback URLs cannot be fetched by external networks.

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
