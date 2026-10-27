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

Facebook, Instagram, TikTok, Twitch and YouTube profile shortcuts can be saved
without granting account access. Discover also supports the explicit public-read
imports below when their server configuration and provider approvals are ready.
Creating a developer account, saving a shortcut or passing mocked tests does not
make an integration live. These new adapters have not completed live provider
acceptance: Meta developer/permission review, TikTok Login Kit/Display products
and scopes, and YouTube project/API-key setup must be verified before activation.
No new provider product, approval flag or paid plan is enabled by this code.

### Importing public posts into Discover

| Provider | Required read consent and eligible source | Imported metadata lifetime |
| --- | --- | --- |
| Bluesky | Link a public profile, then Sync; ownership remains unverified | Existing bounded public-author snapshot behavior |
| YouTube | Link a public channel, then Sync when the server adapter is enabled; ownership remains unverified | At most 24 hours |
| Facebook | Separate read-only Facebook Login consent, then explicitly select a published managed Page | At most 24 hours |
| Instagram | Separate read-only Facebook Login consent, then explicitly select a professional account linked to a published managed Page | At most 24 hours |
| TikTok | Separate Login Kit/Display API consent for basic identity and public videos, then explicitly select the authorized account | At most 6 hours |

In **Connected networks**, choose **Set up read-only public imports**. A setup
message lists missing requirements; it is not a connected state. When ready,
**Continue read-only authorization** opens Ziipa's one-time consent handoff.
After provider consent, return, choose **Refresh import status**, select the
authorized public import target, and choose **Sync public content**. Target
selection clears the previous snapshot and never starts a sync. Read consent
and import-target selection grant no publishing permission.

Android uses **Continue in Ziipa portal**. Sign in to the same Ziipa account in
that browser, explicitly connect there, then return to Android and refresh its
import status. No bearer token or password is passed in the portal URL. Nothing
automatically requests consent, imports posts or publishes on a user's behalf.

Discover mixes the visible Ziipa catalog with this account's permitted imported
snapshots. Ziipa media opens its existing Gallery feed post. An imported card
keeps its provider/author attribution and opens the validated original post on
that network; it does not become an owned Ziipa upload with Ziipa engagement.
Imports fetch bounded metadata and optional allowlisted public thumbnails, not
audio/video files. They do not import private home feeds, messages, friends,
private/unlisted YouTube videos, or all historical content. A missing/expired
thumbnail has a text fallback rather than a fabricated media preview.

Meta, TikTok and YouTube posts and API-derived account labels are cached only in
Redis under the owner/provider/link revision. Expiry or a missing cache returns
no imported posts; there is no database snapshot fallback. Web and Android stop
displaying expired snapshots with local deadline timers, without background API
polling. Explicit Sync refreshes eligible metadata. Disconnect/relink, target
changes, withdrawn permissions or disabled adapters invalidate the former
snapshot. Disconnect removes Ziipa's local read connection/cache; it does not
delete external posts, revoke an entire provider application, or disconnect a
separate publishing grant. Consent IDs and encrypted read credentials remain
server-side until local disconnection/account deletion; API metadata does not.

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
- `POST /api/social/{provider}/connect`: returns `setup_required`,
  `authorization_required` with a one-time Ziipa read-consent URL, or
  `browser_sign_in_required` with the fixed `/portal` handoff. These responses
  never declare OAuth completed. Unsupported adapters return setup requirements.
- `POST /api/social/{provider}/import-target`: Meta/TikTok owner-only
  `{target_id, revision}` selects one server-verified consent target. It rotates
  the link revision and clears old imported metadata, without syncing.
- `POST /api/social/{provider}/sync`: explicitly refreshes a supported public
  snapshot and returns the hub. Missing setup/consent produces an actionable
  error. Expired/withdrawn/invalid metadata cannot reappear after failure;
  unchanged eligible snapshots may remain only within their validity deadline.
- `POST /api/social/{provider}/disconnect`: deletes that profile and imported
  snapshot, and stops pending distribution state for the provider. Published
  history is retained. Repeating disconnect is safe.
- `POST /api/social/media/{media_id}/export`: owner-only `{url, content_type,
  size}`. Local URLs are relative authenticated media paths; R2 URLs are short
  lived HTTPS signed download URLs. Never forward a Ziipa bearer token to an
  external signed URL. Even another user's published media cannot be exported
  through this owner-only handoff endpoint.

Connections reuse `creator_connections.data` with a version/revision marker.
Bluesky retains its existing snapshot storage; new Meta/TikTok/YouTube API
metadata uses expiring Redis records. Encrypted read credentials are purpose-
and owner-bound separately from publishing credentials. No new schema migration
or backend dependency is required for read imports. Account export includes the
sanitized hub; deletion removes the local connections and current cached data.

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
- [YouTube public video resources](https://developers.google.com/youtube/data/reference/rest/v3/videos)
- [TikTok Display API and permissions](https://developers.tiktok.com/docs/en/display-api-overview)
- [TikTok video metadata and expiring cover images](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object)

### Operator configuration for read imports

All new flags default off. Set these only on the API server, after the relevant
provider product/permission review; a flag is an operator assertion, not an
approval issued by the platform. Keep credentials out of `EXPO_PUBLIC_*`, client
bundles, clipboard output and account export.

```dotenv
SOCIAL_FACEBOOK_IMPORTS_ENABLED=false
SOCIAL_FACEBOOK_IMPORTS_APPROVED=false
SOCIAL_INSTAGRAM_IMPORTS_ENABLED=false
SOCIAL_INSTAGRAM_IMPORTS_APPROVED=false
SOCIAL_TIKTOK_IMPORTS_ENABLED=false
SOCIAL_TIKTOK_IMPORTS_APPROVED=false
SOCIAL_YOUTUBE_IMPORTS_ENABLED=false
SOCIAL_YOUTUBE_API_KEY=
SOCIAL_YOUTUBE_DAILY_BUDGET=3000
```

YouTube requires the enabled Data API and a server-held key restricted to that
API. Each bounded channel import reserves three units from Ziipa's shared UTC
daily budget; the setting is capped at 4500. Provider/project quotas can also
stop an import. Do not add billing or request paid capacity to bypass a limit.

Meta/TikTok reuse the stable server `PUBLISHING_ENCRYPTION_KEY` and application
credentials (`PUBLISHING_META_CLIENT_ID`, `PUBLISHING_META_CLIENT_SECRET`,
`PUBLISHING_META_GRAPH_VERSION`; or `PUBLISHING_TIKTOK_CLIENT_KEY` and
`PUBLISHING_TIKTOK_CLIENT_SECRET`). Read credentials use a separate encryption
purpose and consent flow; existing publishing permission does not satisfy read
consent. Facebook requests `pages_show_list,pages_read_engagement`; Instagram
adds `instagram_basic`; TikTok requests `user.info.basic,video.list`.

Use a fixed, approved cookie-bearing browser origin for the complete consent
chain. For the website's same-origin API proxy this is
`PUBLISHING_API_ORIGIN=https://ziipa.com`, also included in
`PUBLISHING_APPROVED_ORIGINS`; `PUBLIC_APP_URL=https://ziipa.com` supplies the
native `/portal` handoff. The browser start, authorize and callback must keep
the same sign-in/binding cookies. Do not widen cookie domains to work around an
origin mismatch. Register these separate read callbacks with the provider:

```text
https://ziipa.com/api/social/oauth/facebook/callback
https://ziipa.com/api/social/oauth/instagram/callback
https://ziipa.com/api/social/oauth/tiktok/callback
```

Keep these routes uncached and redact OAuth query strings/cookies from proxy
logs. These are separate from `/api/publishing/oauth/...` callbacks and never
request publishing scopes. Provider activation still needs a real consent,
target, public-only import, expiry and withdrawal test before being called live.

The public `/network-imports` page documents this feature's data path and links
to Google privacy, YouTube terms and provider access controls. It is not a full
Ziipa privacy policy or terms of use. Before public provider activation, the
owner must finalize and publish the complete privacy/terms documents, confirm
the actual operator/contact/retention details, and implement any provider-required
policy agreement flow. Existing in-app policy drafts and an informational feature
notice do not satisfy that remaining activation review. No terms are accepted
on a user's behalf by this implementation.

### Shared frontend verification

Discovery, Networks and consent/expiry UI live in `mobile/src` and are shared
by Expo web and Android. From `mobile`, `npm.cmd run typecheck` and
`npm.cmd test` include the `discovery-feed`, `discovery-state`, `network-imports`,
`connections-imports-ui` and existing `network` tests. From `frontend`,
`npm.cmd test` checks the website/proxy and anonymous gallery; it does not
replace the shared mobile UI suite. API coverage includes `test_social.py`
and `test_social_read_imports.py`, with isolated storage and mocked provider
responses. Passing these checks verifies implemented behavior, not live provider
approval or physical-phone consent handoff.

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
