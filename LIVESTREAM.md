# Ziipa public livestream adapter

`backend/live_api.py` is an owner-scoped Livepeer control plane. Private camera recording and public broadcasting are separate actions. Creating a provider stream, enabling its ingest, or seeing a camera preview never establishes that a broadcast is live. Ziipa only reports `live: true` after a successful authenticated Livepeer status read confirms `isActive: true`, unsuspended ingest and a public playback policy. A public feed entry additionally requires an approved HTTPS HLS playback URL.

## Configuration and registration

Register the router in `backend/app.py` after the existing model/router imports:

```python
from live_api import router as live_router
app.include_router(live_router)
```

Set **only on the backend server**:

```dotenv
LIVEPEER_API_KEY=<Livepeer Studio server API key>
LIVE_MAX_STREAMS_PER_OWNER=3
LIVE_DAILY_CREATE_LIMIT=10
```

Never place the key in `EXPO_PUBLIC_*`, `VITE_*`, browser settings, the mobile binary, Git, request logs, or a public environment example containing an actual credential. The module uses `SecretStr`; configuration responses only expose a boolean. Without a key, provider mutations return an explicit configuration error rather than fake successful broadcasts.

The model uses the existing SQLAlchemy `Base`, `users` table, authentication and Redis-backed request guard. Local startup's existing `Base.metadata.create_all` creates `live_streams` after registration. Production needs an additive schema migration for the `LiveStream` model (including the owner/request UUID unique constraint and owner index) before rollout; it must not replace existing account/media tables. No extra Python package is required. Validate CORS origins for the actual web/mobile deployments. Camera/WebRTC browser access requires HTTPS or a browser-trusted localhost origin; plain LAN HTTP is not sufficient.

The account deletion endpoint must be async and `await delete_live_account(user.id, session)` after verifying the password and locking the account, before deleting media/account rows. Privacy updates moving away from a public profile must `await end_live_for_privacy(user.id, session)` before changing the setting. Both helpers preserve the caller's transaction and fail closed with 503 if provider shutdown is unresolved. They suspend/terminate ingest; they do not delete previously recorded assets from the provider. Public start is disallowed for private/members-only profiles. Discovery respects discoverability, muted terms, and mutual blocks for signed-in viewers; a public CDN URL remains public if a viewer already copied it.

## API contract

All owner routes use Ziipa's existing session cookie or mobile bearer token. POST operations and provider status refreshes use the existing origin/rate guard. Responses are private and uncached. The owner ID comes from authentication, never request JSON.

| Method / route | Behavior |
| --- | --- |
| GET `/api/live/config` | Public capability/configuration status. Reports browser/native WHIP and optional external-encoder support. |
| POST `/api/live/streams` | Body `{request_id: UUID, title, description?, record?: false}`. Creates a real Livepeer stream, suspends input, saves a prepared owner record. |
| GET `/api/live/streams` | Lists at most 50 broadcasts belonging to this owner; no upstream fan-out. |
| GET `/api/live/streams/{id}` | Owner-only provider status refresh, including safe playback when verified live. |
| POST `/api/live/streams/{id}/start` | Body `{confirm_public: true}`. Enables ingest and returns `awaiting_media`, not `live`. |
| POST `/api/live/streams/{id}/ingest` | Owner-only, after start. Returns temporary-use `whip_url`, `rtmp_server`, `stream_key`; these must stay in component memory and never appear in public posts or persistent storage. |
| POST `/api/live/streams/{id}/end` | Immediately unlists; suspends provider input, terminates the active session, then verifies it stopped. A failed or ambiguous stop remains `ending`. |
| GET `/api/live/public` | Up to 20 broadcasts with safe playback and status verified within the last 20 seconds. Never returns credentials, provider IDs, recording choice or request IDs. |
| GET `/api/live/public/{id}` | Refreshes a published stream's provider status; returns public playback only while verified live. |

Owner response fields: `id`, `request_id`, `title`, `description`, `provider`, `status`, `live`, `record`, `playback_url`, `created_at`, `checked_at`, `ended_at`, `detail`. Public responses omit `request_id`, `record`, and `ended_at`.

Keep the creation UUID stable across retries. Ziipa reserves it in the database **before** provisioning, so an ambiguous timeout cannot silently create a second billable stream on a retry. Different settings with the same UUID return 409. An unresolved creation remains `creating` or `provisioning_unknown`; an administrator must reconcile it in Livepeer using `creatorId.value == Ziipa broadcast ID` before another provisioning attempt. If the provider ID was saved, End can still suspend/terminate it. If the provider ID is unknown, no safe automated cleanup is claimed.

## Broadcasting and ending

The browser transport uses Livepeer's documented WHIP endpoint `https://playback.livepeer.studio/webrtc/{streamKey}`. `mobile/src/components/live-transmitter.web.tsx` implements explicit camera/microphone permission, a separate public Go live action, send-only audio/video transceivers, H264 preference, bounded ICE/SDP negotiation, and provider edge discovery following the official SDK. Discovered SDP destinations must be approved HTTPS `livepeer.studio`, `livepeercdn.studio` or `lp-playback.studio` hosts; any other regional edge fails closed until verified and allowlisted. A read-only HEAD against the official endpoint using an intentionally invalid test key returned a 307 to `nyc-prod-catalyst-0.lp-playback.studio:443` on September 9, 2026. No Ziipa bearer, cookie, or provider server API key accompanies these media requests. Browser cleanup closes the peer connection, stops every camera/microphone track and requests the backend End operation on stop/navigation; if the network is lost, local media stops immediately and server stop stays unconfirmed. End-to-end broadcasting still requires real provider configuration and a deliberate camera/device acceptance test; mock tests do not establish it.

`mobile/src/screens/live.tsx` provides shared Watch live / Your broadcast screens for native and web. Browser viewers use native HLS when available and `hls.js` otherwise; native viewers use Expo Video. Playback source validation does not attach Ziipa credentials. Native encoder credentials are hidden by default and can be explicitly revealed/copied; clipboard copying is an intentional external handoff and users are told to clear it afterward.

`mobile/src/components/live-transmitter.tsx` now implements native phone-camera broadcasting with `react-native-webrtc` 124.0.8 and Expo config plugin 15.0.2. A private preview requires camera and microphone permission; a separate Go live action enables server ingest and negotiates send-only WHIP. Controls include camera flip, microphone mute, Stop, and an external OBS/RTMP encoder option. Native redirect discovery validates every hop before sending the owner ingest URL, and negotiation is bounded by 25 seconds and a 256 KB SDP limit. Stop, cancellation, OS track loss, screen exit and backgrounding release capture tracks and native streams, close the peer, abort network work, and request server End for an attempted broadcast. The status label only becomes LIVE after provider verification.

The native camera recorder remains a separate private clip tool. Expo Go and older Ziipa binaries without the native module show an upgrade notice rather than pretending they can transmit. See [mobile/store/NATIVE-LIVE.md](mobile/store/NATIVE-LIVE.md) for native build evidence and the physical-device acceptance checklist. TypeScript/unit tests or a successful compile do not establish end-to-end camera broadcasting. iOS compilation and installation still require a Mac/Xcode and appropriate signing.

End first patches `suspended: true`, then calls `DELETE /stream/{id}/terminate`. Termination alone permits immediate reconnect, so it is insufficient. The UI must not label a broadcast ended until status becomes `ended`; `ending` means stop the encoder and retry. Previously recorded/publicly downloaded media is not deleted by this operation.

## Security, operating limits and remaining production work

- Provider HTTP requests use a fixed HTTPS API host, a closed path grammar, no redirects, no environment proxy credentials, bounded response size and a 12-second total request deadline. Only safe GETs retry once; mutations do not auto-retry. Upstream error bodies, URLs and credentials never enter client errors.
- Provider playback is restricted to HTTPS HLS on the approved Livepeer CDN hosts. No arbitrary provider playback URL is fetched on the server. Query-bearing/signed URLs and non-HLS sources are intentionally rejected until separately reviewed.
- Stream keys are not persisted in Ziipa's database. Ingest credentials are only obtained for the authenticated owner after explicit public-start confirmation. A key still exists at the provider; suspend it if exposed.
- Limits bound per-owner creation, not total video runtime or spend. Livepeer usage may incur charges; this code does not assume a free or unlimited provider plan. Configure provider budgets/alerts and a platform-wide admission policy before a public launch.
- Public list freshness currently relies on an owner/viewer status poll every 10 seconds. Stale entries disappear after 20 seconds. Production should add verified provider webhooks or an authenticated background reconciliation worker; never mark live based on an unauthenticated webhook payload.
- Recording defaults off. When explicitly enabled, provider recording storage/retention and any charges apply; recorded assets are not automatically imported into Ziipa's media library by this adapter.
- No moderation, scheduled maximum-duration shutdown, deletion/retention workflow for provider recordings, capacity autoscaling, WebRTC end-to-end device verification or production database migration is claimed by these backend tests.

## Validation

From `backend`, run `.venv\Scripts\python.exe -m pytest test_live.py -q`. Tests use SQLite and mocked Redis/Livepeer transports, exercise real owner authentication, and never access a real camera or create a provider broadcast. Coverage includes owner isolation, explicit configuration/consent, stream-key redaction, idempotent creation, unsafe playback URLs, malformed provider status, retries, quota enforcement, stale live status, and partial/failed end operations.

## Primary implementation references

- [Livepeer stream SDK operations and termination semantics](https://github.com/livepeer/livepeer-js/blob/main/docs/sdks/stream/README.md)
- [Livepeer stream update API (`suspended`)](https://docs.livepeer.org/v1/api-reference/stream/update)
- [Livepeer monitoring guide (`isActive`)](https://github.com/livepeer/livepeer-studio-docs/blob/main/docs/04-guides/live/07-monitor-stream-health.mdx)
- [Livepeer OBS/RTMP configuration](https://github.com/livepeer/livepeer-studio-docs/blob/main/docs/04-guides/live/08-configure-broadcast-software.mdx)
- [Livepeer UI kit ingest endpoint construction](https://github.com/livepeer/ui-kit/blob/main/packages/core/src/media/external.ts)
- [Livepeer UI kit browser WHIP implementation](https://github.com/livepeer/ui-kit/blob/main/packages/core-web/src/webrtc/whip.ts)

Reviewed September 2026. Official documentation is moving between versions; repository source is linked where documentation redirects no longer resolve.
