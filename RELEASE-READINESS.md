# Ziipa integration follow-up — 9 September 2026

This update implements the remaining native live transport, Bluesky/Twitch
adapters, and real editor exports. **Implementation is not provider approval or
release acceptance.** Nothing was posted to a real social account, no camera or
microphone was activated by automated checks, and no public code deployment was
triggered by this update.

## Implemented

- Native Android/iOS source now uses `react-native-webrtc` for a private camera
  and microphone preview followed by explicit WHIP broadcasting. Mute, camera
  flip, permission failures, cancellation, background/interruption cleanup and
  bounded SDP/redirect validation are included. Expo Go and old binaries display
  a missing-native-module notice. Browser WHIP and external encoders remain
  available. This does not create background camera access.
- Bluesky uses the pinned official AT Protocol Node OAuth SDK through a private
  bounded stdio bridge: handle resolution, PKCE, PAR, DPoP, encrypted sessions,
  rotated token persistence and real MP4 post receipts. Only supported approved
  PDS endpoints are eligible; this is not unrestricted federation to arbitrary
  hosts. Public OAuth client metadata/JWKS must be available on Ziipa before
  real authorization can work.
- Twitch supports OAuth, selected-channel settings/status, followed-channel
  reads, explicit secure encoder credentials and a Livepeer relay destination
  attached before Go live. Twitch does not expose a general finished-video
  upload API. Channel selection, authorization and public-profile state are
  checked again across token-refresh boundaries. Disconnect removes the Ziipa
  relay before revoking permission and preserves other configured relays.
- The separate FFmpeg worker creates private MP4 outputs containing saved trim,
  timed captions, text overlays/themes and owned/licensed audio mixing. Jobs are
  durable, idempotent, owner scoped and bounded. Editing invalidates older
  exports. The same export screen and source selector are in mobile and portal.
- Publishing approvals are bound to the displayed channel and original media
  ID. Rendered selection additionally binds the saved edit and output receipt.
  Uncertain delivery never silently triggers a duplicate post.

## Provider configuration performed

- Reconnected to the existing Ziipa Render service
  `srv-dac7agm1a4lc739fngo0` and Cloudflare account
  `34d554b4fd573ed429dfd00aa512e181`; unrelated project credentials were not used.
- Created a dedicated **Ziipa Studio** Livepeer project
  `9aa239c7-60ed-4304-9f11-8ba22b517cd6` and a server-only API key with browser
  CORS access disabled. Saved `LIVEPEER_API_KEY` to the Ziipa Render service using
  **Save only**. Saving this setting did not deploy new API code or broadcast.
- Generated a new private P-256 Bluesky client JWK, publishing encryption key
  and matching edge-proxy secret in an ignored local activation bundle. No keys
  were committed, embedded in mobile/web builds, or included in this report.
  After the user's explicit approval to store these keys in the two providers,
  imported all 15 prepared settings into Render's `ziipa-api` using **Save only**.
  Verified the encryption key, private JWK and proxy secret appear as masked saved
  rows; the existing database, Redis, R2, email and Livepeer settings were preserved.
  Saved the matching `ZIIPA_PROXY_SECRET` as an encrypted runtime secret in
  Cloudflare's `ziipa-frontend`, together with plain runtime variable
  `ZIIPA_BACKEND_ORIGIN=https://api.ziipa.com`, using **More options → Save**.
  Verified both Worker rows, including **Value encrypted** for the secret. Neither
  operation deployed the updated application code. Preserve this bundle;
  regenerating encryption keys after authorizations exist makes grants unreadable.
- After the owner enabled Twitch 2FA, signed into the developer console as
  **Ziipacom** and created **Ziipa Studio**, client ID
  `o8gyceb9a8o2qma3ftxqqut7mw3c9b`, with callback
  `https://ziipa.com/api/publishing/oauth/twitch/callback`, category
  **Broadcaster Suite**, and **Confidential** client type. Saved
  `PUBLISHING_TWITCH_CLIENT_ID` to Render's `ziipa-api` using **Save only** and
  verified its masked saved row. The console's **New Secret** control initially
  timed out, but the later release pass found the generated secret in the owner
  console and saved `PUBLISHING_TWITCH_CLIENT_SECRET` in Render using **Save only**.
  Its saved masked row was verified. No credential value is in this report or
  repository. No public code deployment, user OAuth authorization or broadcast
  was performed. Read-only checks on 9 September confirmed
  the API health route works, but `/api/live/config` and `/api/publishing/config`
  return 404; the website's corresponding API routes and `/studio/index.html`
  also return 404. The new integrations and shared Studio still need deployment.
- Created TikTok organization **Ziipa**, ID `7683540912521217032`, and its
  **Ziipa Studio** app, ID `7683514902476228616`, under the existing Ziipa owner
  account. Saved its client key and client secret in Render and verified masked
  rows. Prepared web-platform, Social Networking, Login Kit, Direct Post and
  canonical callback fields in the console. TikTok rejects saving the full form
  until the required icon, actual policy URLs, scope explanation and real sandbox
  demo video are supplied; these integration edits are **not confirmed saved or
  approved**. No review was submitted. `PUBLISHING_TIKTOK_PUBLIC_APPROVED` remains
  false, and the production credentials do not confer sandbox/public approval.
  Added TikTok's exact ownership TXT record to the existing Cloudflare zone;
  TikTok confirmed **Domain ziipa.com — Verified**. Saved
  `PUBLISHING_TIKTOK_VERIFIED_MEDIA_ORIGINS=https://ziipa.com` in Render and
  verified its masked row. Existing web/mail DNS records were not modified.
  The existing 1254×1254 icon was rejected by TikTok's exact 1024×1024 requirement;
  no replacement branding was submitted. The completed draft scope explanations
  and sandbox recording sequence are in `PROVIDER-REVIEW.md`.
- Meta developer enrollment now reaches phone verification. The owner must
  complete that step; no Meta app or credentials have been created. Google Cloud
  was signed into an unrelated project, which was left unchanged. Opened sign-in
  for Ziipa's existing owner account instead; YouTube project/client creation
  awaits that sign-in and any required verification. All provider public-approval
  switches remain false.

## Deployment and acceptance gates

1. **Secret storage completed:** the prepared activation settings are saved in
   Render, and the matching proxy secret/API origin are saved in Cloudflare.
   Deploy the API before the updated website so the new routes and CORS behavior
   are available. Saved configuration alone does not activate the new features.
2. Configure OAuth client IDs/secrets in each provider's Ziipa developer app and
   the Ziipa API. Exact callbacks/scopes are in `SOCIAL-PUBLISHING.md` and
   `backend/META_PUBLISHING.md`. Complete provider review honestly before enabling
   public-approval switches. Domain ownership does not grant platform approval.
3. Deploy the reviewed full repository. The API Docker image contains Node and
   FFmpeg and runs the additive migrations at startup. The website build needs
   both `frontend/` and `mobile/` to export the shared Studio. New native routes
   cannot work against an older deployed API.
4. Run a dedicated render worker with the same database, Redis and R2 settings.
   No paid worker or hosting upgrade has been purchased. Local Windows worker
   is running, but that is not a durable public worker. Enable `RENDER_ENABLED`
   on API and worker only when this service is available. The tested worker
   baseline is 1 vCPU / 1 GiB for one serial worker, separate from the API; see
   `backend/RENDERING.md` for resource limits and capacity caveats. Do not use
   unrelated projects' infrastructure to avoid this hosting requirement.
5. Perform user-controlled Android and iOS physical-device live tests, public
   HLS playback tests, a Twitch relay test and each real provider's authorized
   post/status/disconnect flow. Use designated test accounts and explicit consent.
6. Build and sign iOS with Xcode/macOS and production Android with the release
   keystore, complete privacy/data-safety disclosures, and submit for store
   review. The local APK is ARM64, debug-signed and for internal evaluation only.

## Release preparation completed in the follow-up

- Fetched `Ziipacom/v1` main and confirmed it matches local base `9625cef` before
  preparing the release commit. The installed GitHub CLI identity has read-only
  repository access. Ziipacom browser sign-in is available, but auto-review
  rejected the CLI's requested broad OAuth grant (private repository control,
  workflow updates, organization reads and gists). The authorization was stopped,
  not bypassed. Push/deploy remains blocked pending appropriately authorized
  write access. No force push or remote changes were made.
- The existing API-only free `render.yaml` does not silently provision a paid
  worker. Separate `render-worker.yaml` is ready for an explicitly approved single
  `1c-2g` worker: 1 CPU, 2 GB, $25/month compute at the reviewed Render pricing.
  It reuses the API's database, Redis and private R2 settings without receiving
  social, email, wallet or Livepeer secrets. No paid worker was purchased.
- Added transaction-scoped migration locking, hosted startup/schema checks,
  graceful worker shutdown and database/media-scoped coordination keys. Idle
  polling uses approximately 172,800 Redis commands per 30 days and reconciles
  the durable database queue every 30 minutes, instead of continuously waking
  Neon. This is not a guarantee the whole app fits free allowances. Restart API
  and worker together when adopting the scoped keys. Details are in
  `backend/RENDER_DEPLOYMENT.md`.
- Cloudflare's generated deployment config now preserves dashboard plaintext
  variables with `keep_vars:true`; encrypted secrets remain separate. The
  production website/shared Studio build and Wrangler dry-run passed. Explicitly
  disabled persisted Worker logs/traces because invocation URLs can contain OAuth
  codes and signed media capabilities. API health/Sentry monitoring is separate;
  Sentry/Uvicorn redact signed media capabilities. Re-enable request telemetry
  only with a verified redaction policy.
- Corrected TikTok's stored-media transfer to `PULL_FROM_URL`, using expiring
  signed, job/source-bound links on the verified Ziipa origin. The API probes
  actual video duration, rechecks ownership, grants, exact media/render digests
  and creator options. Shared Studio previews the outgoing file and requires
  explicit audience, interactions and music/commercial choices. These code/test
  fixes are not external review acceptance or proof of a real TikTok delivery.
- Mobile production checks now reject unverified owner/project/app identity,
  signing/privacy/export-review inputs and accidental portal mode. The Apple
  encryption exemption is no longer assumed. Store disclosures, listing drafts,
  reviewer notes and physical-device checklists now match implemented features.
  EAS reports **Not logged in**, ADB has no devices, and this Windows host has no
  iOS build/device tooling. No signing identity or store submission was invented.
  See `mobile/store/RELEASE-AUDIT-2026-09-09.md`.
- Added `scripts/check-production-readiness.py`: 15 bounded read-only public
  checks, no credentials, account creation or posts. At 15:45 UTC, 3 passed and
  12 failed: website, portal and direct API health work; shared Studio, same-origin
  API, new integration routes and Bluesky metadata/JWKS still return 404. Rerun
  after the API and frontend deploy. An HTTP 200 landing page is not release
  acceptance.
- At 15:57 UTC, public Web3 configuration reports Pinata storage but no deployed
  Base Sepolia or Ethereum Sepolia contracts. Six real local-EVM integration
  tests passed on a disposable loopback chain, including minting, creator tokens,
  transfers/tips and receipt/replay checks. Its registry and chain were isolated
  from the app; the chain was stopped afterward. Public testnet deployment and
  wallet acceptance still require the designated owner wallet and testnet gas.

## Validation

The latest non-EVM backend run passed **270 tests**, with one opt-in full-size renderer
test skipped. The separate EVM integration module passed all **6 tests** on the
isolated chain described above. **45 mobile tests**, **10 portal/proxy tests**, and **5
official OAuth SDK bridge tests** passed. Mobile/frontend TypeScript checks,
the full production website/shared Studio build, and Cloudflare's deployment
dry-run passed. The dry-run did not deploy code.

The rebuilt Linux API image passed **68 container checks** with networking
disabled, 1 CPU, 1 GiB RAM and no swap. The full 90-second 720p motion clip with
45 captions, an overlay and two audio tracks rendered in 25.45 seconds; the
combined test container peaked at approximately 512 MiB. This is a measured
case, not a universal throughput guarantee. The final image is
`sha256:b52c355d28eb7d4310e5ccf4ce111dc17886b4d5865a783234d860857641527c`.
The release's container migration code also passed two simultaneous migrations against
disposable PostgreSQL 17 while preserving a sentinel row. Its ordinary startup
command migrated and served HTTP 200 health with PostgreSQL/Redis connected in
production mode. The actual worker claimed a database job, produced an owned
MP4, preserved the original and removed its heartbeat on shutdown. Hosted mode
correctly rejected local-only test storage. Temporary test resources were removed;
these checks did not touch the production database.

The final Android ARM64 internal preview APK is
`mobile/artifacts/Ziipa-Native-Live-Preview-2026-09-09-arm64.apk` (71,174,207 bytes).
Its SHA-256 is
`554b3223d985855c5b386d4655d788d2723a88beba5054c731a971329342aa75`.
Signature, SDK 24/36 configuration, ZIP alignment and all 26 native libraries'
16 KiB alignment were verified. It uses `https://api.ziipa.com`, so new features
still need the updated API deployment and provider activation. It is debug-signed,
not a store submission; no physical installation or iOS build was performed.

The final local HTTP render smoke passed after the API/worker restart: website cookie registration,
video/audio uploads, soundtrack-rights rejection, durable queue deduplication,
worker render, authenticated MP4 download with the expected duration/audio,
unchanged original, rejected anonymous download, native edit causing stale-export
rejection, account export and complete disposable account/media/job cleanup.

Automated provider tests mock external HTTP and DNS. They prove code behavior,
not third-party approval or successful posting to a real account. Native builds
prove compilation/packaging, not physical-device camera or streaming behavior.
