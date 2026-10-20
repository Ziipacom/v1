# Optional isolated SoundCloud connection

SoundCloud is **disabled by default**. This integration stores encrypted OAuth authorization and a minimal linked profile; it does not store SoundCloud audio or a permanent copy of its catalog. Ziipa's owned-upload library and local music creation do not depend on SoundCloud.

## Eligibility and permitted use

The [official API guide](https://developers.soundcloud.com/docs/api/guide) currently requires Artist Pro for new application credentials. Existing eligible registered app credentials may be usable. This release neither purchases a subscription nor assumes free credentials exist. The operator must check SoundCloud's approval for Ziipa's specific isolated creator-library use before enabling public discovery or the official owner-track widget.

The [API terms](https://developers.soundcloud.com/docs/api/terms-of-use) restrict file-save functionality, persistent audio caching, combining content with visual media without the relevant rights, AI uses, and aggregation of competing on-demand catalogs. A track's `downloadable` field does not make an app download/import permissible under these terms. Consequently this implementation has **no import, download, attach-to-video, remix, offline, stream-proxy, or AI-input endpoint**. Listening is not a reuse license. Public search returns metadata only; restricted, private, and third-party playback opens the official SoundCloud page. The optional embedded player is limited to this connected creator's public, fully playable, universally embeddable tracks, uses the official widget, and never auto-plays.

Reference: [API rate limits](https://developers.soundcloud.com/docs/api/rate-limits), [current OpenAPI](https://developers.soundcloud.com/docs/api/explorer/api.json). No provider request or approval was performed during implementation; tests mock every provider response.

## Operator configuration

Leave all flags false until an eligible app and its terms approval are confirmed:

```dotenv
SOUNDCLOUD_ENABLED=false
SOUNDCLOUD_CLIENT_ID=
SOUNDCLOUD_CLIENT_SECRET=
SOUNDCLOUD_PUBLIC_SEARCH_ENABLED=false
SOUNDCLOUD_OWNER_WIDGET_ENABLED=false
```

This integration reuses the stable `PUBLISHING_ENCRYPTION_KEY` and approved fixed `PUBLISHING_API_ORIGIN` / `PUBLISHING_APPROVED_ORIGINS`. Register the exact callback `${PUBLISHING_API_ORIGIN}/api/music/soundcloud/oauth/callback` in the SoundCloud application. The API origin must be the browser's public same-origin proxy (normally `https://ziipa.com`) so the initiating Ziipa session and short-lived OAuth binding cookie reach authorization and callback routes. Do not configure the separate API host for a portal whose cookies belong to `ziipa.com`. Configure `PUBLISHING_PORTAL_URL=https://ziipa.com/portal`, with that origin approved. The shared UI intentionally accepts only its supported fixed portal path, not arbitrary redirects.

Authorization uses OAuth authorization code + PKCE S256, one-use Redis state/tickets, browser session and binding cookies, fixed provider hosts, and owner/provider-bound AES-GCM token encryption. Tokens never go to the app, URLs, account export, or connection receipts. Refresh is serialized per owner. A lost single-use refresh response requires reconnection instead of blindly replaying the refresh token. Native clients must sign in to the same Ziipa account in the portal and return to refresh; native OAuth token handoff is not implemented.

`PUBLISHING_ENCRYPTION_KEY` must remain stable while connections exist. Restore the original key before revoking damaged ciphertext or revoke the app directly in SoundCloud settings. Do not copy keys into source, logs, or support messages.

## Shared client flow

All routes are authenticated and return private/no-store metadata.

- `GET /api/music/soundcloud/config`: setup requirements, connection revision, and separate metadata/search/widget capabilities; `can_import` is always false.
- `POST /api/music/soundcloud/oauth/start` with literal `{ "consent": true }`: short-lived approved-origin authorization URL, or fixed portal handoff for native sessions. Browser authorization and callback remain in the initiating session.
- `GET /api/music/soundcloud/tracks?scope=mine&q=...`: at most 20 owned metadata results; query filters this first bounded page. Public discovery (`scope=public`) additionally requires the separate operator flag and a nonempty query. `has_more` is informational; arbitrary provider pagination URLs are never followed.
- `POST /api/music/soundcloud/tracks/{encodedURN}/playback` with explicit consent: fresh metadata validation, then a non-autoplay official owner widget or official external permalink. Canonical IDs are URNs such as `soundcloud:tracks:123`, URL-encoded as one path component. Never feed these tracks to the editor or inference service.
- `DELETE /api/music/soundcloud/connection?revision=N`: revision-checked local authorization/profile erasure and bounded best-effort provider revocation. This exact self-revocation remains available during maintenance. If revocation cannot be verified, the response tells the user to revoke Ziipa in SoundCloud settings. Normal authentication and CSRF/origin protections remain in force.

Account export includes only the minimal connection receipt and `stored_audio: false`. Account deletion also removes the encrypted authorization/profile and attempts bounded provider revocation. Pending OAuth callbacks cannot recreate a deleted/disconnected connection. Catalog requests have bounded response sizes, timeouts, fixed URLs, and app/per-owner minute limits. No background playback, discovery crawler, or provider retry loop exists.

## Rollout and verification

Migration head becomes `20261020_0013`, adding only `soundcloud_connections` (owner FK with cascade). Deploy the matching API and Oracle scheduler release together: existing worker schema guards intentionally reject a different head. Do not migrate production and leave an old worker marked ready. SoundCloud flags can remain false throughout the coordinated rollout.

Run `python -m pytest test_soundcloud.py -q` against the isolated local integration fixtures. Tests never access hosted account databases or real provider endpoints. Real acceptance still requires eligible app credentials, registered exact callback, operator terms review, owner browser consent, and testing link/search/playback/revocation. A passing mock test does not establish production SoundCloud approval or connectivity.
