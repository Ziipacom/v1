# Live, private recordings and notifications

This release uses the same Studio source for native mobile and the web portal.
It does not turn a calendar reminder into permission to broadcast or post.

## Public livestreaming

The existing Livepeer control plane creates owner-scoped streams. Starting
requires an explicit public-broadcast confirmation, a fresh provider read and
the account's current privacy consent. Browser WHIP and native streaming send
to the provider; HLS viewers only see streams that the provider verifies active.
Twitch relay requires a connected account and its separate permissions.
Successful stream creation is not proof that a camera broadcast reached viewers.

Keep `LIVEPEER_API_KEY` only on the API/worker host. Never enable CORS for that
server key or embed it in Expo, website assets, logs or screenshots. Configure
the owner project's free allowance and usage alerts before a real broadcast.
Do not create a paid subscription to finish this setup.

## Recording to private clips

Required settings:

```
LIVE_RECORDINGS_ENABLED=true
LIVE_WEBHOOK_ID=<Livepeer webhook UUID>
LIVE_WEBHOOK_SECRET=<dedicated signing secret, at least 32 characters>
```

Register the public HTTPS endpoint `/api/live/webhooks/livepeer` in the same
Livepeer project, subscribing to `asset.ready`, `stream.started`, `stream.idle`.
Deploy the matching API code and secret before enabling the webhook. Never use
a local/LAN callback address for production or disable signature verification.
Livepeer signs the raw request body with HMAC-SHA256. This receiver also checks
the webhook identity, millisecond timestamp, replay identity and event binding.

For each owned stream, opt into **provider recording** and separately opt into
**private Ziipa imports and excerpts** before the recording event. A signed
callback is a hint: authenticated asset/session reads must prove that the
recording belongs to the locally owned stream. URLs from callback bodies are
never fetched. Imports use an exact CDN allowlist, bounded public DNS with a
pinned TLS connection, no redirects and size/time/content checks.

The existing workflow worker imports at most 100 MiB / 30 minutes / 4096 px
source video. It creates an original private draft and one to three sequential
15–90 second excerpts, rendered through the existing bounded FFmpeg queue.
These are deterministic excerpts, **not AI-selected highlights**. Failed,
cancelled, partial and stale outcomes stay visible in Recordings. Cancelling
invalidates pending automation; already created private drafts remain editable.
No recording is automatically published. Review a source or clip in Studio,
then use the normal reviewed campaign flow to distribute it.

Readiness uses a recording-specific, database/storage-scoped heartbeat renewed
only after a successful enabled recording scan. A healthy general workflow
process alone cannot make the importer report ready. Idle renewal is Redis-only.

For local review, the explicitly approved existing server key is kept in an
ACL-protected, Windows-user-encrypted local AppData file outside OneDrive and Git,
separate from the shared backend dotenv settings. The temporary plaintext staging
file is removed after encrypted-storage verification.
The launcher passes it only to API/recording-workflow processes, clears its
temporary environment afterward, and rejects shared dotenv fallback. It does
not give the key to the renderer, assistant, model, website or mobile bundle.

Private Ziipa imports do not change the original Livepeer playback policy or
retention. Provider copies require their own deletion/retention controls; a
provider deletion request does not promise immediate physical erasure.
Oversized or unsupported recordings fail closed; there is no arbitrary URL
import fallback. Manually trim and upload them through normal media controls.

## Optional device notifications

Configure the API and workflow worker with the same values:

```
PUSH_ENABLED=true
PUSH_ENCRYPTION_KEY=<dedicated random 32 bytes, base64url>
PUSH_VAPID_PRIVATE_KEY=<P256 PKCS8 DER, base64url>
PUSH_VAPID_PUBLIC_KEY=<matching uncompressed P256 point, base64url>
PUSH_VAPID_SUBJECT=https://ziipa.com
PUSH_EXPO_ENABLED=false
```

Only the public VAPID key is returned to clients. Subscription endpoints and
Expo tokens are encrypted with owner/device/purpose binding and never returned
in account exports, receipts or diagnostic errors. Preserve the encryption and
VAPID keys across restarts; changing them requires controlled re-registration.
The provider allowlist defaults to exact FCM, Mozilla and Apple push origins.

Users first choose categories in Settings → Notifications, then explicitly
enable each device and accept its OS/browser permission. There are no startup
permission prompts. Categories are calendar reminders, private recording/clip
completion and campaign completion. Payloads use fixed generic lockscreen copy,
not media titles, financial details or arbitrary agent messages.

Web Push requires HTTPS (localhost is accepted for local review). The exported
push-only worker is `/studio/ziipa-push-sw.js`, scope `/studio/`, for the portal,
and `/ziipa-push-sw.js` on the standalone web preview. It does not cache media
or run background posts. LAN HTTP is suitable for app review, not Web Push.

Native push additionally requires an owned EAS project, a new native binary,
APNs/FCM credentials and `PUSH_EXPO_ENABLED=true`. Set the optional
`PUSH_EXPO_ACCESS_TOKEN` if enhanced Expo push security is enabled. Existing
APKs cannot gain a native module from a JavaScript refresh. Expo Go is not the
native push acceptance environment.

The outbox commits with the originating event. It deduplicates per event/device,
limits active queues, expires old work and rechecks session/category/device
consent before handoff. Logout and password reset revoke matching devices;
account deletion removes registrations and receipts. Provider 404/410 or
DeviceNotRegistered removes the encrypted registration. A committed handoff
cannot be recalled after revocation. An interrupted or ambiguous send is marked
uncertain rather than blindly resent. Expo tickets are polled for receipts;
provider acceptance is never labelled device display. Only an authenticated
receipt review can mark an alert opened. Terminal history is retained for
90 days in bounded cleanup batches; active work is not pruned.

## Acceptance before external use

1. Apply migrations through `20261019_0011`, deploy the API and shared Studio,
   restart the API/workflow/renderer together, and confirm scoped worker health.
2. Verify the Livepeer key, signed HTTPS webhook and free allowance in the Ziipa
   owner project. Use a designated test account and synthetic media for the
   first explicitly approved public stream; verify real HLS and recording.
3. Confirm private imports, clip receipts and review-before-publication on both
   clients. Test disconnect, duplicate callbacks, cancellation and quota failure.
4. Opt in a real browser and new native test binary; verify arrival, receipt
   status, permission denial, logout, category revocation and account removal.

Automated provider transports use mocks; the clip acceptance test generates and
renders real video. Passing those tests is not proof of a public broadcast or
device delivery. No such external event is implied by a successful local build.
