# Ziipa portal parity update — 9 September 2026

The website portal now builds and runs the same `mobile/` Studio application through React Native Web. `/portal` keeps the existing website account flow and embeds `/studio/index.html` on the same origin. This removes the separate portal editor as the normal entry point; future shared screen changes appear in the next website build.

This is **shared application parity, not a claim of release equivalence**. The follow-up implementation and current provider activation status are tracked in `RELEASE-READINESS.md`. No real social post, camera capture, livestream or blockchain transaction was performed during these checks. Previously installed APKs need the new native build.

## Available in the shared Studio

| Capability | Portal and mobile source | Limits / remaining acceptance checks |
|---|---|---|
| Discover | Swipe-up media, floating Studio actions, categories, custom feeds, profile and safety controls | Published server media / explicitly labeled demo catalog; not an imported universal social feed |
| Creator editor | Uploads, actual camera recording, shared drafts, captions, overlays, soundtrack and explicit destinations; a separate FFmpeg worker renders saved edits into private MP4 exports | Render worker availability and bounded media formats/size apply. Exporting an original explicitly excludes editor effects |
| Shared drafts | Same owner-scoped database, partial updates preserve omitted fields; explicit clears are respected | Simultaneously editing the same individual field still uses the last submitted value |
| Networks | Account/profile links, public Bluesky reads, people links, manual media sharing, user-controlled invitations | Other platforms' private feeds/friends are not universally importable; permissions and adapters are still required |
| Direct publishing | OAuth/upload adapters for Bluesky, YouTube, TikTok, Facebook Pages and professional Instagram; selected original or rendered source, explicit channel/media/audience consent and receipts | Provider configuration, permissions, review and storage requirements still apply. No real provider account delivery test yet. Each destination is approved separately |
| Livestreaming | Browser and native camera/mic WHIP, private preview then explicit Go live, verified HLS playback, owned lifecycle and optional authorized Twitch relay | Livepeer credentials required. Native Android compiles; physical Android/iOS broadcasting and real Twitch relay are still acceptance gates. Twitch supports live publishing rather than an arbitrary video-upload API |
| Wallet | Shared wallet screens, testnet linking, owned metadata/mint/transfer/tip workflows | Existing deployment registry, RPC, IPFS/Pinata, funds and wallet signing requirements still apply. Mainnet and production financial infrastructure are not enabled |
| Account | Website cookie login with Studio sessions, privacy/export/deletion, same shared API | Production email/storage/monitoring configuration remains an operator responsibility |

## Compatibility and security fixes

- Portal uses the website's HttpOnly cookie, not bearer tokens copied into iframe URLs or local storage. Native sessions keep their bearer transport.
- A non-secret expected-user header rejects stale portal actions after an account switch. It never authenticates a caller by itself.
- API media URLs are rebased only from exact trusted API origins and exact owned-media paths. Credentials do not follow arbitrary content URLs.
- Standalone browser previews now fetch private audio/video through a bounded authenticated object URL adapter. It aborts and revokes media on account/source/focus changes. This fallback loads the file before playback; a progressive media transport would improve startup.
- Wallet browser signature challenges use the trusted browser origin; native clients use the configured canonical app origin.
- OAuth grants are encrypted on the API, tied to the initiating Ziipa session, and never returned in account export. Callback tickets/codes are redacted from API access logs.
- Broadcast and publishing rows have a versioned additive database migration. Account deletion shuts down live streams before removing account data and revokes provider grants.

## Build and run

Use a full repository checkout containing both `frontend/` and `mobile/`.

1. Install backend dependencies and run `python render_migrate.py` from `backend` before starting the API.
2. Install mobile dependencies with `npm ci` from `mobile` when its lockfile changes.
3. Run `npm ci` and `npm run build` from `frontend`. Its prebuild exports the shared Expo web application under `/studio`, then builds the website. `npm run dev` also exports Studio before starting. Restart or run `npm run build:studio` after changing shared mobile source; the portal bundle is a static export, not Metro hot reload.
4. Local website server: `http://127.0.0.1:5178/portal`. Local mobile preview: `http://192.168.1.101:8082/preview.html` on this workstation. Use localhost/HTTPS for camera access; an ordinary HTTP LAN address is not a secure camera context.

For Cloudflare, set the server runtime `ZIIPA_BACKEND_ORIGIN=https://api.ziipa.com`. The old `VITE_API_ORIGIN` browser build setting is no longer used. The website proxies `/api` so Studio and website share the host-only cookie. Previous users may need to sign in again; no account or draft migration is required.

Set the same randomly generated **secret of at least 32 characters**, `ZIIPA_PROXY_SECRET`, in the website Worker and API secret managers. The API then trusts only the authenticated edge visitor address for rate limits. Without it, visitors sharing an edge connection can share the fallback IP limit. Never prefix this secret with `VITE_` or `EXPO_PUBLIC_`. Cloudflare provides server variables through Node compatibility `process.env`: https://developers.cloudflare.com/workers/configuration/environment-variables/

Publishing OAuth must begin and return on the same canonical website cookie origin. Set `PUBLISHING_API_ORIGIN=https://ziipa.com`, `PUBLISHING_APPROVED_ORIGINS=https://ziipa.com` and `PUBLISHING_PORTAL_URL=https://ziipa.com/portal`. Register each exact callback from `SOCIAL-PUBLISHING.md`. Native users authorize through the web portal and then refresh their shared publishing accounts. Do not use `api.ziipa.com` for that cookie callback or forward credentials to arbitrary origins.

Read `SOCIAL-PUBLISHING.md`, `backend/META_PUBLISHING.md`, `LIVESTREAM.md`, `backend/RENDERING.md` and `backend/.env.example` for required settings. Keep public-approval switches false until the provider has actually approved the app. See `RELEASE-READINESS.md` for follow-up secret configuration status; secrets are never committed or bundled into the apps.

## Verification and remaining release gate

The local production website/Studio build, frontend and mobile TypeScript checks, draft/session/privacy tests, isolated provider lifecycle tests and media credential-isolation tests pass. HTTP checks confirmed `/portal`, `/studio/index.html`, its JavaScript assets, `/api/health`, the mobile preview and the empty public-live directory respond successfully.

Current follow-up results: **220 non-chain backend tests, 39 mobile tests, 10 portal/proxy tests and 5 official OAuth SDK bridge tests passed**. The default backend run skipped one opt-in resource test; the production Linux image separately passed all 9 renderer tests including that full-size case. Cloudflare's deployment dry-run succeeded without publishing. Local HTTP smoke checks covered shared drafts and the actual private render/export flow, then deleted disposable accounts/media/jobs/sessions. See `RELEASE-READINESS.md` for the exact evidence and current provider activation blockers.

Provider tests mock external HTTP, so they do not prove provider approval or a successful real-world post. Camera/microphone and wallet prompts were not activated. A new Android internal APK has been built. Native device testing, public browser broadcast testing, real account delivery, deployment secrets, a signed iOS/release Android build and store review remain required before calling the versions equivalent for release.

The existing repository-wide frontend lint command still reports older UI/a11y/type-rule issues outside this update. Newly added portal/proxy files pass targeted lint. Existing on-chain integration tests require the separate local EVM and are not part of this update's full non-chain test run.
