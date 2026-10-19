# Ziipa mobile release checklist

Updated 2026-09-09. Source and an internal Android binary exist. No production signing, physical-device acceptance, App Store Connect upload or Google Play submission is claimed. See [the current audit](RELEASE-AUDIT-2026-09-09.md) and [native build evidence](NATIVE-LIVE.md).

## Current artifacts and release boundaries

The preserved ARM64 Android preview is [Ziipa Native Live Preview](../artifacts/Ziipa-Native-Live-Preview-2026-09-09-arm64.apk). It compiles Expo57, React Native 0.86.3 and native WebRTC; package com.ziipa.app.preview, version 1.0.0/code1, Android 7+ / target36. Its Android Debug certificate is suitable for internal installation only. **Do not upload it to Play or reuse its debug key for production.** It calls https://api.ziipa.com; compiling does not deploy API routes or configure media, live or social providers.

Android SDK/build tools/NDK and JDK21 are installed locally. No Android device was attached during the audit; no emulator is installed. This Windows host has no Xcode/iOS build tools. Native iOS compilation needs a suitable Mac or an owner-controlled EAS build. Expo57 requires iOS16.4+ and Xcode26.4+. [Expo compatibility](https://docs.expo.dev/versions/v57.0.0/)

## Owner identity and signing

- [ ] Complete [OWNER-INPUTS.template.json](OWNER-INPUTS.template.json) outside version control. Do not put passwords, keystore contents, tokens, service-account keys or reviewer credentials in this file or chat.
- [ ] Sign into the Ziipa-controlled Expo account and confirm the organization, EAS project and membership. The local EAS CLI audit returned **Not logged in**.
- [ ] Confirm the production Android application ID and iOS bundle ID in the appropriate owner consoles. com.ziipa.app is provisional; .preview identifies internal builds. If identifiers already exist, use their existing owner and version history.
- [ ] Inspect existing Android upload and Play App Signing certificate SHA-256 fingerprints in Play Console. An existing app needs its matching upload key through EAS credentials; do not generate a replacement blindly. For a verified new app, create and securely back up an upload key through the owner's credential workflow.
- [ ] Verify Apple membership, team, bundle record, distribution certificate and provisioning profile; record the App Store Connect numeric app ID. Do not revoke existing certificates or change team ownership to bypass a blocker.
- [ ] Configure submission access in owner-controlled EAS/CI with minimum necessary permissions. Never put signing secrets in EXPO_PUBLIC variables.
- [ ] Set ZIIPA_APP_ID_CONFIRMED=true and ZIIPA_SIGNING_REVIEWED=true only after those checks. Flags are acknowledgments, not proof of a matching signer. The production EAS profile explicitly uses remote owner-account credentials. [Expo signing](https://docs.expo.dev/app-signing/app-credentials/), [Android signing](https://developer.android.com/studio/publish/app-signing)

## Product, backend and policy acceptance

- [ ] Deploy the exact release commit to the HTTPS API. Verify accounts, email verification/recovery, persistent database/media, render worker, live adapter and selected social providers. Verification/recovery exist in source; email delivery/enforcement require production configuration and tests.
- [ ] Verify routes used by the store binary with two controlled accounts: ownership, upload/render completion, discovery, moderation, privacy and deletion. Do not advertise unconfigured or unapproved adapters.
- [ ] Configure backups/restore, quotas, rate limits, retention, monitoring and staff incident response. A free-tier integration does not establish production capacity.
- [ ] Publish owner-reviewed HTTPS privacy, terms, community, support and account-deletion pages. Include operator identity, contact, processors, retention/backup deletion and appeals. Verify access without a developer login.
- [ ] Staff UGC moderation and appeals; validate reporting/blocking and baseline filtering/prepublication safety, including livestreams. Personal filters alone do not establish an operational safety program.
- [ ] Complete age, content, audience and territory questionnaires from actual content. The 18+ registration self-declaration is not comprehensive age assurance. Do not invent a rating or seller identity.
- [ ] Complete [DATA-DISCLOSURE.md](DATA-DISCLOSURE.md), Apple App Privacy and Google Data safety from the final binary and deployed processors, including camera/microphone, live transmission, social tokens and blockchain/IPFS data.
- [ ] Review digital goods, NFTs, tokens, tipping and external payment links against current store rules and territories. Test-network/non-custodial operation does not establish policy exemption. Complete [WEB3.md](../../WEB3.md), wallet/device tests and policy review before ZIIPA_WEB3_REVIEWED=true.
- [ ] Complete Apple export-compliance review including third-party cryptography/WebRTC. Set ZIIPA_ENCRYPTION_REVIEWED=true and the reviewed ZIIPA_USES_NON_EXEMPT_ENCRYPTION=true or false. No exemption is assumed; unreviewed declarations are omitted from Info.plist. If Apple supplies a compliance code, set ZIIPA_APPLE_ENCRYPTION_COMPLIANCE_CODE to that exact value. [Apple export declaration](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)
- [ ] Disable demo/concept flags and portal mode. Submit working features only, with no hidden reviewer behavior or promise of universal social synchronization.
- [ ] Approve launcher artwork and [listing copy](LISTING-DRAFT.md), capture signed-device screenshots and complete [reviewer notes](REVIEWER-NOTES.template.md). Store reviewer credentials in secure console fields, not Git.
- [ ] Complete [DEVICE-QA.md](DEVICE-QA.md) on physical Android/iPhone builds and repeat critical checks on the exact store artifacts. Only then set ZIIPA_RELEASE_REVIEWED=true.

Apple expects working review access and complete functionality. Check UGC, recording, privacy and payment rules for the submitted feature set. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

Google requires a Financial features declaration; tokenized assets may require further disclosures. Do not answer “none” simply because the app is non-custodial or uses a testnet. [Financial features](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en), [blockchain policy](https://support.google.com/googleplay/android-developer/answer/13607354?hl=en)

## Build and submit after the checks are satisfied

The user authorized release preparation/submission. Missing owner accounts, keys, device results and truthful declarations remain practical blockers; this checklist does not request repeated authorization. No paid cloud build or purchase was started. Do not incur an unapproved charge if a workflow presents one.

From mobile, use the verified EAS CLI version. Login is interactive; never pass passwords in commands. Link only the confirmed Ziipa project and record EXPO_OWNER and EXPO_EAS_PROJECT_ID:

    npx.cmd eas-cli@23.2.0 login
    npx.cmd eas-cli@23.2.0 whoami
    npx.cmd eas-cli@23.2.0 init
    npx.cmd eas-cli@23.2.0 credentials --platform android
    npx.cmd eas-cli@23.2.0 credentials --platform ios

Configure .env.example release values in the owner EAS production environment. Public URLs/project IDs are not secrets; signing credentials are. eas.json supplies the production API, native mode and disabled demo/concept flags. Local preflight reads the shell environment; load the same reviewed values without printing secrets.

    npm.cmd ci
    npm.cmd run typecheck
    npm.cmd test
    npm.cmd run release:check
    npx.cmd eas-cli@23.2.0 build --platform android --profile production
    npx.cmd eas-cli@23.2.0 build --platform ios --profile production

Production checks run in the EAS pre-install hook. APP_VARIANT=production activates them under differently named profiles too. They reject missing metadata/acknowledgments but cannot verify accounts, signing ownership, live URLs or human QA. Inspect final AAB/IPA package identity, version, release signing, permissions/privacy manifests and SHA-256 before submission. **Do not use local assembleRelease with the generated debug signing configuration for a store artifact.**

Configure the confirmed App Store Connect ascAppId in submit.production.ios; leave the current empty object until that ID is known. Configure Play submission access securely. Select the **exact reviewed build ID**, not --latest, to avoid an unrelated/preview artifact:

    npx.cmd eas-cli@23.2.0 submit --platform android --profile production --id REVIEWED_ANDROID_BUILD_ID
    npx.cmd eas-cli@23.2.0 submit --platform ios --profile production --id REVIEWED_IOS_BUILD_ID

Replace those build-ID placeholders with actual reviewed EAS build IDs. Android targets the internal track with draft status. iOS uploads to App Store Connect; TestFlight, review and public release are separate actions. Google may require the first upload through Console before API submission. [EAS Submit](https://docs.expo.dev/deploy/submit-to-app-stores/)

Personal Play accounts created after November 13, 2023 currently require at least 12 continuously opted-in closed testers for 14 days before applying for production access. Verify the owner account's actual requirements; internal testing does not substitute. [Google testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)

Stop a release on signer/identifier mismatch, failed preflight, incomplete API, unverified privacy/safety claims, missing device acceptance or failed reviewer access. Preserve the verified internal APK while resolving these conditions.

## Optional push acceptance — 2026-10-19

The website and mobile app share notification preferences, consent, device registration and receipt screens. Browser Web Push uses the existing HTTPS Studio, its push-only service worker and the backend workflow worker. It needs no additional paid push service. An account holder must save selected categories, then explicitly enable a supported browser/device and grant its permission. A LAN HTTP preview is not a Web Push test. Server readiness, registration and provider acceptance are separate from observed device display and an actual tap. No test alert is sent automatically.

Native delivery uses the [free Expo Push Service](https://docs.expo.dev/push-notifications/faq/#cost-of-the-push-notification-service), with its project rate limit and best-effort delivery. This does not remove signing or provider setup requirements. Keep `PUSH_EXPO_ENABLED=false` until the owner setup is verified; this mobile build configuration never enables the backend. Existing preview APKs predate the notifications module and must be rebuilt.

- [ ] Verify the Ziipa owner, `EXPO_EAS_PROJECT_ID`, and package/bundle IDs before selecting any provider project. Preview Android uses `com.ziipa.app.preview`; production uses the confirmed `ZIIPA_APP_ID`. Each tested package must have a matching Firebase Android app.
- [ ] Supply `GOOGLE_SERVICES_JSON` as an owner-controlled local path or an EAS file environment variable pointing to that Android app's **Firebase client** JSON. Actual files are excluded from Git/EAS archives; EAS supplies its file variable separately. The strict Android/local all-platform release check rejects a missing, oversized, mismatched or service-account file without printing its contents. iOS-only EAS checks do not require this Android file. [Firebase client configuration and FCM V1](https://docs.expo.dev/push-notifications/fcm-credentials/), [EAS file variables](https://docs.expo.dev/eas/environment-variables/#variable-types)
- [ ] Separately configure the existing project's FCM V1 **service-account sending credential** in the owner EAS credentials console. It is not `google-services.json`, must never enter app config/`EXPO_PUBLIC_*`, and must not be committed. Confirm any API/application restrictions match the tested package and signing certificate. No credential is generated or uploaded by the release checker.
- [ ] For iOS, confirm an existing paid Apple Developer membership, the intended team/bundle, APNs key, Push Notifications capability and matching signed profile. Do not buy a membership or revoke/create a shared key without owner review. [Native setup and Apple requirement](https://docs.expo.dev/push-notifications/push-notifications-setup/#get-credentials-for-development-builds)
- [ ] Build a new signed development/release binary. Android can be built with the installed local SDK without buying cloud build capacity; use existing free EAS allowances only if available. iOS compilation needs a suitable Mac/Xcode or an available EAS build allowance. Neither a web export nor Expo Go proves native delivery. [Expo57 notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [ ] On the actual reviewed device/build, explicitly enroll with a test account, observe one generic reminder, review its receipt/tap, then verify opt-out, logout/session expiry, re-login and revoked-device behavior. Do not claim device delivery from a successful Expo ticket/APNs-FCM receipt. Record results without copying tokens/endpoints into logs, screenshots or chat.

Do not assume the provisional identifiers or an old debug-signed APK establish owner account access, APNs/FCM configuration or store readiness. No production enrollment, notification send, device permission prompt, cloud credential creation or paid build was performed by this source update.

## Dependency audit follow-up — 2026-10-19

The notification milestone's read-only `npm audit --json` reports 24 findings (20 high, three moderate, one critical). Neither `expo-notifications@57.0.23`, `expo-constants@57.0.22` nor the added `badgin` package is named in that report. A pre-install lock comparison was unavailable, so this is not a claim that the historical advisory count is unchanged.

The critical [shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) affects the existing React Native → React DevTools dependency (`shell-quote@1.10.0`; patched in 1.11.0). React Native loads that DevTools entry under `__DEV__`; no reachable production quote-to-shell call was found in this review. Other high findings primarily concern Expo/Metro tooling, glob parsing, development-server compression and [node-forge signing verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv), which had no patched version in the advisory at audit time. Keep development servers private.

The runtime React Navigation → query-string → [decode-uri-component denial-of-service advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) also needs a controlled update (decoder fixed in 0.5.0). Ziipa currently does not enable arbitrary URL linking; notification taps use a fixed screen and validated receipt ID. Before a public release, review supported transitive patches, regenerate the lock deliberately, rerun device/export tests and record the remaining exceptions. Do not use `npm audit fix --force`: its suggested Expo/RN downgrades would break this SDK57 app. No dependency fixes were applied in this audit.
