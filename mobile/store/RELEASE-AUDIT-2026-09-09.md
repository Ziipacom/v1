# Release audit — 2026-09-09

**Status: internal Android preview verified; store signing, physical acceptance and submission blocked by missing verified owner access and device evidence.** This is an observed local audit, not proof that the owner has no remote developer accounts.

| Item                   | Actual result                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Internal APK           | Preserved unchanged: Ziipa-Native-Live-Preview-2026-09-09-arm64.apk, 71,174,207 bytes                                                                                                            |
| SHA-256                | 554b3223d985855c5b386d4655d788d2723a88beba5054c731a971329342aa75                                                                                                                                 |
| APK signature          | Reverified v2 signature; CN=Android Debug; RSA2048                                                                                                                                               |
| Certificate SHA-256    | fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c                                                                                                                                 |
| Package/runtime        | com.ziipa.app.preview, version1.0.0/code1, ARM64, minSDK24/targetSDK36; calls https://api.ziipa.com                                                                                              |
| Native compilation     | Previous full and final incremental Android builds succeeded; 26 native libraries and APK ZIP passed 16KB alignment checks. See NATIVE-LIVE.md.                                                  |
| Local signing paths    | Generated android/app/debug.keystore exists. No release/upload keystore or credentials.json found at the audited project candidate paths. No private signing values were displayed.              |
| EAS CLI                | 23.2.0 installed in npm's CLI cache; whoami returned Not logged in                                                                                                                               |
| Owner identity         | EXPO_OWNER, EXPO_EAS_PROJECT_ID, ZIIPA_APP_ID and EXPO_TOKEN absent from the audited shell. Production ID in source is provisional. No existing app registration/key ownership established.      |
| Submission credentials | No project-local credentials.json or candidate Play/Apple submission credentials verified; no corresponding credential-path environment values present. Browser store sessions were not audited. |
| Android devices        | adb devices -l returned an empty device list; no emulator installed. No installation, camera/mic activation or device acceptance occurred.                                                       |
| Local iOS tooling      | Windows host; xcodebuild, xcrun, xcode-select and idevice_id not found. No Mac/physical iPhone build/test connection verified.                                                                   |
| EAS/store mutations    | No EAS init/build/submit, credential generation/replacement, paid build, purchase, Apple/Play listing or legal declaration was performed.                                                        |

The APK is a frozen internal preview, not a release candidate rebuilt after this release audit or subsequent legal-copy corrections. Do not claim byte-for-byte parity with later source changes. Keep it for team evaluation; create and validate new properly signed artifacts from the final release commit when blockers are resolved.

Validation for this preparation: mobile strict TypeScript passed; **42 mobile tests passed**, including three release configuration regressions; scoped Prettier and Git whitespace checks passed. The actual local release preflight exited 1 as intended because verified production environment values and review evidence were not supplied. Test fixtures never set real owner approvals or contact external providers. Existing module-type and line-ending warnings were non-failing.

## Changes completed for release preparation

- Updated RELEASE.md, LISTING-DRAFT.md and DATA-DISCLOSURE.md to reflect camera/microphone recording, native live broadcasting, edited exports, social adapters and wallet/test-network source features without claiming deployed readiness.
- Added owner-input, reviewer-note and physical-QA templates. Unknown identities, privacy choices and test results remain unset.
- Production preflight now requires explicit package ownership/signing/export review; rejects preview IDs and web-only portal mode; applies to production variants even with a differently named EAS profile.
- Removed the automatic iOS encryption-exemption declaration. Only a reviewed explicit true/false answer is added to Info.plist; optional Apple-provided compliance code is passed through without invention.
- Explicit remote credentials for the production EAS profile. Internal APKs and additional secret-file types excluded from EAS upload; owner-local inputs excluded from Git.
- Regression tests cover missing review prerequisites, wrong build identity/mode, reserved nonpublic URL, production-profile bypass and omission/preservation of export declarations. These use synthetic configuration and make no provider requests or credential mutations.

## Exact outstanding inputs/actions

1. Owner login to the Ziipa Expo account, confirmed organization/project ID, Play/Apple app records and approved production identifiers.
2. Existing Android upload/Play signing fingerprints and approved key access, or verified new-app status; Apple team/distribution provisioning and App Store Connect app ID. Secure store submission credentials, without pasting secrets into chat/Git.
3. Physical Android ARM64 phone with USB debugging authorized and an iPhone plus Mac/Xcode or permitted owner EAS capacity for a signed iOS build. Test participants must consent to recording/broadcast tests; no personal funds are needed.
4. Final deployed API/provider configuration and verified email, media/render, live, social and testnet workflows. This audit does not certify cloud deployment.
5. Legal operator/contact, final policies/retention/vendor disclosures, audience/territories/content answers, digital-goods/blockchain policy decisions, encryption declaration, reviewed media rights and moderator operation.
6. Dedicated reviewer account/access instructions, signed-device screenshots and completed physical acceptance on exact release binaries.

Do not satisfy these by setting review flags to true without evidence or by renaming/re-signing the preview APK. The deployment task can continue independently; missing signing/device/owner inputs are the release blockers.
