# Ziipa social authorization, video publishing and Twitch live controls

The separate FastAPI `/api/publishing` API implements user-authorized delivery
to YouTube, TikTok, managed Facebook Pages, linked professional Instagram
accounts and Bluesky, plus authorized Twitch channel and live controls.
Tests use mocked provider responses; no real account was connected
and no real post was published during implementation. Developer credentials,
registered callbacks and provider approvals still have to be supplied by the
operator. Configuration flags do not grant approval from a platform.

## Implemented capabilities and boundaries

| Destination | Implemented backend | Remaining requirements or limits |
| --- | --- | --- |
| YouTube | Web OAuth with PKCE, verified channel discovery, explicit channel selection, server-side refresh/revoke, original-video upload, processing/visibility reconciliation | OAuth web client and enabled YouTube Data API; private only until operator confirms project approval; 25 MB per upload in this adapter |
| TikTok | Web OAuth with PKCE, exact-source review, measured duration, current creator choices, private `PULL_FROM_URL` delivery and status checks | Operator-verified Ziipa media domain required; approved scopes and creator account; `SELF_ONLY` until operator confirms app audit |
| Facebook | Facebook Login, granted permission checks, eligible managed Pages, explicit selection, encrypted Page tokens, original binary Reel upload and publication checks | Meta app review/permissions, supported Graph version, explicit public-post approval; personal-profile posting is not supported |
| Instagram | Facebook Login for linked professional accounts, explicit destination selection, approved signed R2 media URL, Reel container preparation and one-time final publication | Professional account linked to a managed Page, Meta approvals, allowlisted HTTPS storage origin and sufficiently long source URL expiry; ordinary personal accounts are not supported |
| Bluesky | Official AT Protocol SDK OAuth with PKCE/DPoP, verified DID, encrypted SDK sessions, video blob upload, deterministic post creation and playback status | Public MP4 posts, 25 MB application limit; stable private P-256 client JWK, HTTPS client metadata and installed Node bridge; only reviewed hosted PDS/auth origins by default |
| Twitch | Verified broadcaster OAuth, explicit target, channel title/category updates, live status, followed channels and protected RTMPS encoder key; Livepeer relay integration in the live API | Twitch application credentials and scoped broadcaster consent; arbitrary video-file publishing is unsupported; configuring a destination does not start a broadcast |

The media source must be a published Ziipa creation owned by the authenticated
user, with an owned validated video file. The user may explicitly select the
**original** or a ready owned `render_id` from the FFmpeg export worker. Original
uploads require acknowledgment that editing effects are absent. Rendered uploads
validate the current saved editing fingerprint and use the rendered MP4 bytes;
stale renders or source replacements fail before delivery. Common MP4/MOV originals work
across these adapters; YouTube also accepts the supported WebM source type.
Meta accepts MP4/MOV in this implementation. The common 25 MB application limit
is deliberately lower than provider limits for the small demo API.

There is no general import of a user's private home feed, friends, messages or
address book. Publishing authorization grants only the scopes documented here.
Invitations and unsupported-network sharing remain user-initiated system share
or download actions, not automated messages or fabricated delivery receipts.

## Deployment configuration

Install `backend/requirements.lock` and apply `alembic upgrade head` before
serving this API. `publishing_grants` contains encrypted credentials and safe
destination records. `publishing_jobs` contains receipts and private provider
checkpoint IDs. Migration `20260909_0002_live_publishing.py` creates these tables.
The existing `pycryptodome` dependency supplies AES-GCM encryption.

Set these API-server environment variables, never `EXPO_PUBLIC_*` or `VITE_*`:

```dotenv
PUBLISHING_ENCRYPTION_KEY=<base64 of a securely generated random 32-byte key>
PUBLISHING_API_ORIGIN=https://ziipa.com
PUBLISHING_APPROVED_ORIGINS=https://ziipa.com
PUBLISHING_PORTAL_URL=https://ziipa.com/portal
PUBLISHING_ALLOW_INSECURE_LOCALHOST=false

PUBLISHING_YOUTUBE_CLIENT_ID=
PUBLISHING_YOUTUBE_CLIENT_SECRET=
PUBLISHING_YOUTUBE_PUBLIC_APPROVED=false

PUBLISHING_TIKTOK_CLIENT_KEY=
PUBLISHING_TIKTOK_CLIENT_SECRET=
PUBLISHING_TIKTOK_PUBLIC_APPROVED=false

PUBLISHING_META_CLIENT_ID=
PUBLISHING_META_CLIENT_SECRET=
PUBLISHING_META_GRAPH_VERSION=
PUBLISHING_META_MEDIA_ORIGINS=
PUBLISHING_META_PUBLIC_APPROVED=false

PUBLISHING_TWITCH_CLIENT_ID=
PUBLISHING_TWITCH_CLIENT_SECRET=
PUBLISHING_BLUESKY_ENABLED=false
PUBLISHING_BLUESKY_PRIVATE_JWK=<stable private P-256 JWK JSON>
PUBLISHING_BLUESKY_NODE_BINARY=node
PUBLISHING_BLUESKY_EXTRA_ORIGINS=
```

Keep the encryption key stable in the deployment secret manager and back it up
securely. Changing or losing it makes existing grants unreadable; there is no
automatic destructive replacement or key migration. Existing session Redis and
Postgres must be available; coordination errors fail closed.

**The whole OAuth browser chain must use one public cookie origin.** When the
portal uses a same-origin `/api` proxy on `https://ziipa.com`, use that origin
above even if the proxy forwards to FastAPI at `https://api.ziipa.com`. The
host-only OAuth binding cookie and Ziipa session cookie must reach both the
authorize and callback endpoints. A start on the website followed by a callback
directly on a different API origin will fail closed. Do not broaden the cookie
domain to work around this. Include the configured portal origin in the exact
approved origin list. Forward cookies and `Set-Cookie` through the API proxy;
do not cache these endpoints. Configure proxy access/error logs to redact
authorization query strings, cookies, credentials and signed media URLs.

Register exact redirect URIs with each provider:

```text
https://ziipa.com/api/publishing/oauth/youtube/callback
https://ziipa.com/api/publishing/oauth/tiktok/callback
https://ziipa.com/api/publishing/oauth/facebook/callback
https://ziipa.com/api/publishing/oauth/instagram/callback
https://ziipa.com/api/publishing/oauth/twitch/callback
https://ziipa.com/api/publishing/oauth/bluesky/callback
```

YouTube requests `youtube.upload` and `youtube.readonly`, offline access and
consent. Set up test users/consent-screen access as needed. Google restricts
uploads from applicable unverified projects to private viewing; Ziipa additionally
enforces private-only by default. See [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
and [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert).

TikTok requests `user.info.basic,video.publish`. Its review endpoint returns the
exact owned source hash, ffprobe-measured duration and fresh creator settings.
The publish boundary probes those bytes again and rechecks current privacy,
interaction and duration limits. No user-declared duration is trusted. The
posting UI previews the chosen original or baked export, permits caption edits,
leaves privacy unset and interactions off, and requires music/disclosure consent.
Branded content additionally requires its policy confirmation and non-private
visibility. These confirmations do not grant a music license. See [TikTok Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post),
[OAuth token management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
and [publish status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status).

Server-stored assets now use `PULL_FROM_URL`, never `FILE_UPLOAD`. Verify Ziipa's
media domain in TikTok's **Manage URL properties**, then explicitly set
`PUBLISHING_TIKTOK_VERIFIED_MEDIA_ORIGINS` to the exact HTTPS
`PUBLISHING_API_ORIGIN`, such as `https://ziipa.com`. The default is empty: account
authorization/review can work, but delivery remains unavailable. Do not assume
ownership of Cloudflare's S3 hostname. The handoff URL instead lives under
`/api/publishing/tiktok/media/` on the verified Ziipa domain and returns the owned
bytes directly, with no redirect to R2. Domain verification and app public-post
approval are separate external steps; this change enables neither automatically.
See [TikTok's sharing requirements](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
and [media URL verification](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide).

Each private pull URL has a purpose-separated HMAC signature and a two-hour
Redis record tied to the account, selected grant, job, original/rendered source,
and byte digest. TikTok receives it only after explicit publish consent and a
durable pre-init checkpoint. It never appears in app receipts. GET/HEAD support
single byte ranges and `no-store`; the server checks current ownership, privacy,
grant, render freshness and digest. Deletion, disconnection, expiry or Redis loss
invalidates access; an already completed external copy cannot be recalled.
The direct route makes private R2 assets usable on an operator-verifiable domain
without making the bucket public. It is capped at 25 MB per handoff and needs API
bandwidth/capacity; it is not a high-volume CDN. Uvicorn logs and Sentry event
processing redact these URLs; private-route exception locals are omitted too.
Configure any upstream proxy/analytics logs to redact this route as well.

The ffprobe subprocess uses fixed local filenames, a file-only protocol allowlist,
15-second timeout, restricted memory/file/thread limits and temporary folders.
TikTok sources must have supported codecs, 23–60 fps, 360–4096 pixels on both
sides, and at most ten minutes, further limited by the creator's current cap.
The existing 25 MB publication cap still applies. No transcode runs in the API;
the separate worker creates edited exports.

Meta uses **Facebook Login**, not the separate Instagram Login scope family.
Configure a currently supported explicit Graph API version. Facebook requests
`pages_show_list,pages_read_engagement,pages_manage_posts`; Instagram requests
`pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish`.
User and Page tokens are encrypted together and never returned with destination
lists. Instagram requires `MEDIA_STORAGE_BACKEND=r2` and an exact HTTPS storage
origin in `PUBLISHING_META_MEDIA_ORIGINS`, with enough signed-download lifetime
for Meta to fetch the file. Do not include arbitrary user-supplied media origins.
See [Meta adapter setup and contracts](backend/META_PUBLISHING.md).

Twitch requests `channel:manage:broadcast`, `channel:read:stream_key` and
`user:read:follows`. Its confidential web OAuth flow verifies client ID, scopes
and broadcaster identity before reading or mutating channel state. The stream
key is only revealed to the owner after explicit consent, with no-store headers;
the Livepeer relay instead consumes it server-side. Changing the selected Twitch
account, reauthorizing or disconnecting detaches existing Ziipa relay destinations
first. Removing an OAuth grant alone does not invalidate a previously copied
encoder key. See [Twitch OAuth](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
and [Twitch API reference](https://dev.twitch.tv/docs/api/reference/).

Bluesky uses the pinned official `@atproto/oauth-client-node` SDK and
`@atproto/api` through a private, bounded stdio bridge. Install Node 22 or newer
and run `npm ci --ignore-scripts --omit=dev` in `backend/atproto_bridge`; the
Docker build does this without exposing a bridge listener. Provide one stable
private P-256 JWK with `kty,crv,kid,x,y,d` in the backend secret manager. The public
`/api/publishing/oauth/bluesky/client-metadata.json` and `jwks.json` endpoints
must be reachable on the configured HTTPS website origin; neither exposes `d`.
The narrow scope is `atproto repo:app.bsky.feed.post?action=create blob:video/mp4`.
No social password or app password is accepted. SDK state and refresh sessions,
including private DPoP keys, are encrypted with owner/provider binding.
The bridge child inherits only required OS, PATH, temporary-directory and locale
variables, never the API's database, R2, Livepeer or unrelated provider secrets.
Its private key and operation-specific session travel through stdin, not process
arguments. The child has a 256 MB JavaScript heap cap and 45-second deadline;
stdout is read incrementally with a 2 MB cap. Cancellation/overflow kills and
reaps the process. Size the API instance for both Python and this bounded child;
the heap cap is not a promise that a 256 MB total host can run both runtimes.

The bridge verifies handle/DID reciprocity, issuer and resource audiences through
the SDK. Network requests are restricted to Bluesky's approved public services
and managed `*.host.bsky.network` PDS hosts; all resolved IPs must be public and
TLS connections pin the validated DNS result. Redirects, private IPs, arbitrary
user URLs and credential-bearing public resolver requests are rejected. Additional
operator-reviewed exact HTTPS PDS/auth origins may be configured explicitly.
The current adapter accepts PLC DIDs; unsupported identities fail clearly. It
does not import a private timeline. SDK-generated request state, PKCE, private-key
client assertions and DPoP replace custom OAuth cryptography. A per-grant Redis
lease and encrypted-cipher comparison protect refresh/reauthorization races.
See the [official Node OAuth SDK](https://github.com/bluesky-social/atproto/tree/main/packages/oauth/oauth-client-node),
[AT Protocol permissions](https://atproto.com/specs/permission) and
[video blobs and embeds](https://atproto.com/guides/images-and-video).

## Client flow and response contract

All account/data routes require a Ziipa session. POST mutations enforce the
shared origin/rate guard. The two external browser redirect routes instead
validate a consumed single-use state, binding cookie and original authenticated
Ziipa session; they do not depend on an unavailable native Bearer header.

1. `GET /api/publishing/config` returns `{providers, notice}`. Each provider row
   includes `provider`, `name`, `oauth_implemented`, `publish_implemented`,
   `configured`, `can_start`, `publish_ready`, `requirements`, `delivery_requirements`, `detail`,
   `allowed_privacy`, `max_media_bytes`, `live_implemented`, `live_ready`, `native_oauth_supported:false` and an
   approved `connect_via_portal` URL or null. Missing configuration is explicit;
   a configured adapter is not proof of account authorization or app review.
   Instagram OAuth can start before media storage is ready; its
   `delivery_requirements` identifies missing private R2/source-origin setup
   and keeps `publish_ready` false without unnecessarily blocking account login.
2. `POST /api/publishing/oauth/{provider}/start` from the cookie-authenticated
   web portal returns `{status:'authorization_required', auth_url}`. Open that
   URL in the same browser. OAuth succeeds only if the initiating Ziipa session
   remains the same through the callback. Logging out or switching accounts
   invalidates the flow. Native Bearer clients receive
   `{status:'browser_sign_in_required',auth_url:null,connect_via_portal,detail}`;
   open the portal, sign into the same Ziipa account, authorize there, then
   refresh the mobile account list. No native polling ticket is exposed.
   Bluesky additionally requires JSON `{handle:"creator.bsky.social"}` at start;
   the browser still signs in and grants consent at the discovered approved issuer.
3. `GET /api/publishing/connections` returns `{connections,jobs}`. A connection
   exposes `provider,status,targets,selected_target_id,can_publish`, never a
   credential. `POST /api/publishing/connections/{provider}/target` with
   `{target_id}` selects one of the actual authorized destinations. Ziipa never
   picks the first returned Page/channel automatically.
4. For TikTok, `POST /api/publishing/connections/tiktok/creator-options` returns
   current creator privacy/interaction/duration choices. Show the choices and
   disclosures before requesting publication.
5. `POST /api/publishing/publish` accepts the following structure. The user must
   deliberately approve the displayed destination and source. Required expected
   target/media IDs reject stale cross-tab consent; use `render_id` for a ready
   export, otherwise acknowledge the original-file limitation.

```json
{
  "item_id": "<owned published Ziipa item UUID>",
  "expected_media_id": "<current creation original media UUID>",
  "expected_target_id": "<selected authorized provider target ID>",
  "render_id": null,
  "provider": "youtube",
  "idempotency_key": "<new UUID retained for this approved attempt>",
  "privacy": "private",
  "made_for_kids": false,
  "consent": true,
  "original_media_acknowledged": true,
  "retry_failed": false,
  "title": "Creator-approved title",
  "description": "Creator-approved description"
}
```

`made_for_kids` is an explicit required YouTube answer; the common request
schema currently also requires the boolean for other providers but does not
transmit it to them. For Facebook/Instagram, top-level `privacy` must be `public`
and the UI must disclose the public selected Page/professional destination.
Bluesky also requires explicit `public` visibility and at most 300 characters of
combined post text. Set `render_id` to the ready export ID to send edited bytes;
the expected original media ID still binds consent to the creation's current source.
TikTok additionally requires `tiktok` with `privacy_level`, `disable_comment`,
`disable_duet`, `disable_stitch`, `brand_content_toggle`, `brand_organic_toggle`,
`is_aigc`, `music_usage_confirmed`, `content_disclosure_enabled`,
`branded_content_policy_confirmed`, and `source_sha256` from the fresh review.
Call `POST /api/publishing/tiktok/review` with `item_id`, `expected_media_id`,
`expected_target_id` and optional `render_id` before approval. Its result binds the
actual `media_id`, source digest, measured duration and creator settings.
`duration_seconds` is compatibility-only and does not control validation. Nested privacy
choice controls delivery; the top-level privacy field is not a substitute.

6. `GET /api/publishing/jobs` lists the current owner's receipts.
   `POST /api/publishing/jobs/{id}/refresh` checks delivery. **For Instagram,
   this action also finalizes the already consented container once it reports
   FINISHED.** Use a label such as “Check delivery”; do not describe the endpoint
   as read-only. The final publication step is checkpointed before its request
   and never repeated after an unknown outcome.
7. `POST /api/publishing/connections/{provider}/disconnect` tries provider
   revocation and removes local credentials regardless of a provider timeout.
   If `provider_revoked` is false, the user should also remove Ziipa in provider
   settings. Meta permission revocation can affect both Facebook and Instagram
   grants; the sibling is marked `reconnect_required`. Existing posts remain on
   the provider. Account deletion uses the same revocation/removal helper;
   deleting Ziipa is not a request to delete remote posts.

Twitch uses live controls instead of `/publish`:

- `GET /api/publishing/connections/twitch/channel` returns the selected verified
  channel's title, category, language and current live status.
- `POST /api/publishing/connections/twitch/channel-settings` requires
  `{expected_target_id,title,game_id?,language?,consent:true}` and verifies the
  accepted settings. It does not start a stream.
- `POST /api/publishing/connections/twitch/follows` retrieves at most 50 followed
  channels. These are not reciprocal friends or a private messages import.
- `POST /api/publishing/connections/twitch/ingest` with `{consent:true}` is an
  explicit owner-only secret reveal for an external encoder. Its no-store
  response contains the RTMPS server and key. Never persist it in browser storage,
  analytics or logs. Ziipa's Livepeer integration calls the internal verified
  key helper and does not expose the key to the broadcasting client.

Receipts contain `id,item_id,provider,status,detail,privacy,external_id,
external_url,created_at,updated_at`. Private stage IDs and source URLs are not
returned. `processing` means the provider accepted preparation/upload;
`delivered` means a verified provider completion receipt, which may still be
private on YouTube or TikTok. A TikTok `external_id` is its opaque publish ID,
not an invented public video URL. `rejected` means a confirmed provider failure.
`failed` means preparation failed before attempting delivery and can be retried
only by explicit `retry_failed:true` using the same approval/idempotency key.
`uncertain` means the write outcome was not confirmed; inspect the provider and
refresh its receipt. Ziipa never automatically starts another upload for it.

## Safety, persistence and operational limits

- Tokens use AES-GCM with owner/provider authenticated context. Refresh tokens,
  Page tokens, signed source/upload URLs and client secrets never appear in
  API receipts or profile links. Provider HTTP responses are bounded and errors
  use sanitized messages. Keep HTTP debug/trace logging disabled; deployment
  proxies and observability tooling must honor the same redaction policy.
- Redis OAuth state is cryptographically random, single-use and expires after
  ten minutes. PKCE is used for Google/TikTok/Bluesky. Every browser step verifies the
  exact originating Ziipa session as well as the separate HttpOnly binding.
- Refresh leases plus saved-cipher comparison protect rotating tokens from
  concurrent reauthorization/disconnect. Delivery rechecks the grant before
  each checkpointed write. Owner-bound queries prevent cross-account targets,
  media, jobs, exports or account-deletion access.
- Provider requests use fixed allowlisted HTTPS hosts/paths, strict identifiers,
  response size limits and no redirects. Pagination does not follow arbitrary
  token-bearing URLs. TikTok receives only its fixed init/status requests and
  the job-bound signed Ziipa pull URL; no caller-controlled URL is fetched.
- Jobs and provider checkpoints are committed before non-idempotent requests.
  Persisted source fingerprints and idempotency keys prevent duplicate uploads
  after repeated clicks. An interrupted `sending` receipt becomes visibly
  uncertain after the lease window. Unknown results never trigger blind reposts.
- A global 180-second Redis lease serializes the 25 MB handoffs for the small
  demo instance. Provider delivery has a 60-second overall deadline; status
  checks and authorization are separately bounded. This is not a durable
  background queue or resumable uploader. YouTube currently uses one bounded
  multipart upload. Larger videos, interrupted binary continuation, reliable
  scheduled publishing and automatic webhook reconciliation require additional
  implementation before a broad public rollout. Edited exports require the
  separately configured FFmpeg worker; rendering is not performed in the API
  request. Bluesky post record keys are stable per job, and an unknown create
  outcome is reconciled by reading that record, never creating a second post.

## Verification

Run from `backend`, with local test Postgres and the dedicated Redis DB15:

```powershell
.\.venv\Scripts\python.exe -m pytest test_social_publishing.py test_social_remaining_adapters.py test_tiktok_publishing_adapter.py test_meta_publishing_adapter.py -q
# In backend/atproto_bridge; all fetches are mocked, including actual SDK OAuth:
node --test --test-isolation=none test/bridge.test.mjs
```

The coordinator tests use rollback-only transactions and mock every provider
HTTP request. They cover session switching, wrong-origin callbacks, single-use
state, credential isolation, ownership, explicit destination selection, consent,
idempotency, safe preparation retry, unknown delivery, refresh, revocation,
durable Meta/TikTok steps and verified processing completion. Adapter tests
cover fixed-host transport, unsafe URLs, oversized responses, provider errors,
scope/target mismatch, privacy choices and no blind repeat writes. They do not
prove that an operator's live app has received provider review or that a real
production account can publish; those require controlled operator verification.
