# Ziipa for iOS and Android

A separate React Native app in `ziipa/mobile`, built from the supplied Figma reference and creator portal. It uses Expo SDK 57, React Native 0.86, TypeScript, native navigation and players, and the shared FastAPI/PostgreSQL/Redis backend. It is not a WebView wrapper.

**Status:** implemented native application source and build configuration; not yet signed, device-tested, or ready for public store submission. See [store/RELEASE.md](store/RELEASE.md) for the remaining release gates. Neither app store nor a cloud build has received this project.

## Run locally

For a browser evaluation of the real mobile screens, run `npm.cmd run preview` and open **http://localhost:8082/preview.html**. The browser starts in sample discovery with an 844px phone viewport and fit/actual-size controls. This is React Native Web, not a device emulator. Browser sign-in now connects to FastAPI with an in-memory bearer session; signed-in uploads and changes use the backend. Sample-mode edits remain local. Production app configuration includes only iOS and Android.

The Figma flow now uses the stacked discovery carousel, an immersive vertically paged media viewer, floating reactions and category controls, a right-aligned Studio menu, the purple expandable editing tray, and profile media cards. The original logo is retained; collection photography remains licensed sample artwork rather than the exact photographs in the supplied Figma images.

- Tap the discovery menu to open Studio. Choose a category or **Edit** to expand the tray, then select a thumbnail to edit it.
- The shared editor offers media selection, playback trims, manual captions and creation details. In sample mode, drafts are kept in memory only; native signed-in mode uses authenticated uploads and server drafts/publication.
- Tap a discovery card to open the immersive viewer. Swipe vertically (or use the arrows), pause, unmute, like, bookmark, comment, or start an attributed remix.
- Sample likes, bookmarks, feed rules, comments, and drafts are interactive but never published. All reset on restart; sample comments also reset when leaving the media viewer.
- The profile lock button opens creator/account navigation. Studio → Wallet now contains the Figma token/protocol wizard, wallet connections, IPFS metadata, NFT and creator-token minting, transfers, tipping, balance sync and transaction history. See [../WEB3.md](../WEB3.md) for the actual testnet scope and setup. Promotion, inbox and live broadcasting remain concepts.

Start PostgreSQL, Redis, and FastAPI using the parent README. The backend must include `mobile_api.py` and be restarted after this update. It remains on port 8018. The website continues on port 5178.

```powershell
cd ziipa/mobile
npm.cmd ci
npm.cmd run go
```

Use a development build for WalletConnect's native modules, device handoff, permission behavior, launch assets and native verification. Expo Go may not include these modules. No Expo account is required for local source work; EAS cloud builds require one.

- Android emulator API default: `http://10.0.2.2:8018`, which reaches the Windows host loopback API.
- iOS simulator on a Mac: `http://127.0.0.1:8018` when the backend is running on that Mac, otherwise your reachable staging API.
- Physical device: copy `.env.example` to `.env.local`, set `EXPO_PUBLIC_API_URL` to a reachable server, and restart Metro. The existing loopback-only backend is deliberately **not exposed to your LAN automatically**. Prefer a protected HTTPS staging server. For a trusted private LAN, explicitly bind Uvicorn to your computer’s LAN IP and permit only the required private-network traffic in Windows Firewall. Do not expose the development server to the public internet.
- Keep secrets out of `EXPO_PUBLIC_*`; these values are embedded in the app.
- Preview APKs produced in release mode also require HTTPS. Development-client JavaScript permits local HTTP. Production configuration disables Android cleartext traffic and uses iOS transport security.

Native development commands:

```powershell
npm.cmd run android
# On macOS with Xcode and CocoaPods:
npm.cmd run ios
```

Android native builds require Android Studio/SDK. iOS compilation and signing require macOS/Xcode or EAS’s macOS builders. Expo’s CLI does not generate the iOS project on Windows; EAS generates it from `app.config.ts`. Generated `android/` and `ios/` folders are disposable build output and ignored by Git/EAS; change native settings through config/plugins, not generated files.

## Implemented

- Original in-app logo, Barlow typography, near-black violet surfaces, purple circular controls, layered discovery cards and floating category/Studio docks.
- Welcome, sign-in/registration, sample discovery, category/search browsing, post details, native video/audio, manual caption and playback trims.
- Five-step Creator Studio for media, trim/captions, text overlays, creator-owned soundtrack settings, metadata, and multi-network destinations.
- System document picker plus camera photo/video capture; common image/video/audio formats, raw binary upload progress, 100 MB file/1 GB local account limits; drafts, publication, editing and remix attribution.
- Connected-network and delivery center for Bluesky, Facebook, Instagram, TikTok, Twitch, and YouTube. Ziipa persists truthful connection-required/provider-setup states; external OAuth and delivery stay disabled until reviewed provider credentials and adapters are configured. See `../SOCIAL-DISTRIBUTION.md`.
- Likes, bookmarks, comments, custom feed rules and local community feed sharing, creator profile, studio and saved collections.
- Keychain/encrypted-storage sessions; bearer tokens never placed in URLs or ordinary storage. Seven-day expiry, logout revocation and server authorization on private media.
- Reporting, stable-account-ID blocking, muted words, moderator-only report queue and removal, password-confirmed account deletion. Deletion invalidates all devices and removes account-dependent content; failed filesystem cleanup is persisted for retry.
- iOS/Android EAS profiles, separate preview application ID, production configuration checks, draft listing/data-disclosure material and a local web deletion page at `/account-deletion`.

The demo is labeled and available in development/preview only. It uses licensed local images and the attributed Sintel sample. Wallet implements EVM testnet NFT/creator-token minting, transfers, and native-currency split tips, with public deployments and native pairing still requiring owner configuration. Broadcasting, AT Protocol federation, external OAuth/direct posting, rendered media exports, automated AI editing, real-value payments, subscriptions and checkout are not shipped. [WEB3.md](../WEB3.md) and [SOCIAL-DISTRIBUTION.md](../SOCIAL-DISTRIBUTION.md) record production work and the centralized components that remain.

## Validation

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run doctor
npm.cmd run export
npm.cmd audit
cd ../backend
.\.venv\Scripts\python.exe -m pytest -q
```

`expo export` emits Android/iOS Hermes bundles in `dist/`, plus web assets when using preview configuration. These are **not** APK/AAB/IPA files and cannot be uploaded as store binaries. The prebuild command validates and generates native source; it does not compile an installable app. See the release guide for signed EAS builds.

The UUID override resolves the inherited `uuid <11.1.1` advisory in Xcode project tooling; the consumer uses the compatible `uuid.v4()` API. Keep it until the upstream tooling dependency is updated, and recheck with Expo Doctor after upgrades.

## Backend operations

Set `MODERATOR_EMAILS` in the backend environment to a comma-separated list of existing, trusted account emails. Ordinary accounts cannot open or act on reports. No account was automatically promoted. Operators must review reports and enforce policy; the app does not automatically notify a staffed team. Before public UGC, add a baseline prepublication content-review/filtering process and the rest of the production controls in the parent `CREATOR-PRODUCTION.md`.

Set `ENABLE_DEMO_CATALOG=false` in production. Run `backend/cleanup_media.py` regularly through your deployment’s job system to retry failed account-deletion file cleanup. No scheduled job was installed here. Deletion also removes relevant local abuse reports; review legal retention/anti-abuse requirements before deployment. Existing web accounts can sign in on mobile; apply the final age/terms acceptance process to existing members before launch.

Backend startup adds new tables for policy acceptance, reports, and deletion jobs without replacing existing data. Introduce reviewed database migrations before production; do not use development startup DDL as a production migration system.

## Project layout

`src/screens/` contains native product screens. `src/provider.tsx` owns session and shared state. `src/lib/api.ts` handles authenticated requests/uploads. `src/lib/domain.ts` contains tested feed and editing rules. `app.config.ts` and `eas.json` define native build settings. `store/` holds release and listing drafts.

Brand/media provenance, including the separate generated launcher-icon treatment, is recorded in `assets/brand/SOURCES.md` and `assets/media/SOURCES.md`. The in-app logo is the unmodified source asset.
