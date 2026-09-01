# Validation record — 2026-08-31

## Web3 revision (latest)

- FastAPI integration suite: **14 passed**, including actual local EVM + offline IPFS mint, transfers, creator token issuance, split tips, wallet proofs/replay, ownership, metadata consent, idempotency, hash-squatting prevention, code mismatch, confirmation thresholds and reverted receipts. Python dependency check passed.
- Smart-contract tests: **4 passed**, including reentrant receiver and failed payout cases. Contracts compiled and deployed only to the local chain.
- Mobile strict TypeScript and **6 domain tests** passed. Expo Doctor **21/21**; mobile and contract npm audits reported **0 vulnerabilities**.
- Android/iOS Hermes and web bundles exported. A reproducible postinstall fix handles OneDrive's ambiguous symbolic-link file entries. Upstream WalletConnect dependency export-map fallback warnings remain; build success is not native device validation.
- Browser checked at 390×844: Figma wizard, empty-name validation, network selection, disconnected transfer rejection, wallet/metadata/activity navigation, and actual FastAPI bad-login response. No personal wallet was used or signed by the agent.
- No public testnet deployment, WalletConnect project ID, public IPFS replication, hardware wallet, physical-device pairing, store binary/signing or store submission was completed. See [../../WEB3.md](../../WEB3.md).

Earlier records below describe prior revisions and are retained for context.

| Check | Result |
| --- | --- |
| Mobile TypeScript, including unused locals/parameters | Passed |
| Mobile domain tests | 6 passed (combined Music & Film category, page/overscroll bounds, feed combinations, time/caption boundaries, media-origin restrictions, integer-cent pricing) |
| Expo Doctor | 21/21 checks passed |
| npm audit | 0 reported vulnerabilities after compatible UUID override |
| Android native prebuild | Passed; generated native Android project and branded resources |
| Android Hermes export | Passed; approximately 4.2 MB bytecode bundle plus assets |
| iOS Hermes export | Passed; approximately 4.2 MB bytecode bundle plus assets |
| Backend API integration tests | 9 passed, including mobile token isolation/revocation, block/report/moderation, deletion and cross-device invalidation |
| Existing web frontend TypeScript and production build | Passed, including the new `/account-deletion` route |
| New account-deletion page scoped lint | Passed |
| Running API health/new routes | HTTP 200 health; mobile auth, deletion and moderation endpoints present in served schema |
| Local outside-app deletion page | HTTP 200, form present |
| Production configuration | iOS/Android identifiers resolve; missing real production variables deliberately rejected by release checks |
| iOS Xcode project generation on Windows | Not supported by Expo CLI; use macOS or EAS |
| APK/AAB/IPA compilation, signing, install, device QA | Not performed; Android SDK/emulator and Xcode are not installed/configured here |
| App Store / Play Console upload | Not performed |

Hermes bytecode is not an installable app. No native performance, permission, accessibility, visual, media-codec, end-to-end, or store-approval result is inferred from bundle exports.

## Figma flow revision — browser verification

The mobile navigation was rebuilt around the supplied screenshots. Checked the Studio category menu and expandable purple editing tray at 390×844, and profile/media layouts at 430×932. Verified opening an existing sample draft, adding a caption, saving it in memory, and opening the saved creation; floating likes and bookmarks; bookmarked content in the profile; local sample comments; and saving sample custom-feed rules with public sharing disabled.

Verified the packaged film actually advances in the immersive viewer (video ready state 4, unpaused, current time above 9 seconds), and pauses while the comment sheet is open. Fixed repeated seeking during buffering before this check. The phone-frame preview now preserves the 844px viewport height instead of compressing the app to the desktop panel height. All three final bundles (web, Android, iOS) and strict TypeScript passed after the revision.

Browser checks used sample content only, with no backend mutations. Exact Figma photo assets were not supplied separately; existing licensed collection images remain placeholders. No native device QA, real payment, NFT minting, live broadcast, direct messaging, or follower-graph integration is implied. Earlier backend/prebuild/doctor results above are from the initial mobile build and were not rerun for the UI-only revision.

Observed non-failing warnings: Node's module-type auto-detection for the test file; terminal color-environment warnings; Starlette's test-client deprecation warning about its HTTP client. The code was not weakened or test cases skipped to suppress these. iOS generation was not forced around the host restriction.

Backend integration tests used rollback-only SQL transactions and a dedicated Redis test database. No existing user account was deleted or promoted. The development API was restarted with the new routes on its original loopback port 8018. The website and production domain were not deployed or changed remotely.
