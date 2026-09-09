# Physical-device acceptance worksheet

All results below are **NOT RUN** as of 2026-09-09. ADB listed no connected devices. No physical capture, public stream, wallet signature, app installation or iOS test was performed. Compile/unit/browser checks are separate evidence.

Record tester/date, device model/OS, application ID/version/build, APK/AAB/IPA hash, backend commit/origin and approved test accounts before starting. Keep account passwords, ingest URLs, wallet keys and recordings of bystanders out of evidence. Obtain participant consent and use test networks with no personal funds.

| Test                                 | Expected result                                                                                              | Android | iPhone  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------- | ------- |
| Cold launch/upgrade/process restore  | Correct icon/splash; no debug server required; existing drafts protected                                     | NOT RUN | NOT RUN |
| Register/verify/recover/login        | Real email delivery; bad/expired tokens rejected; verified access matches policy                             | NOT RUN | NOT RUN |
| Logout/switch account/session expiry | Previous identity's media and credentials inaccessible; active capture stops                                 | NOT RUN | NOT RUN |
| Camera/mic allow/deny/cancel         | Explicit permission only on action; denial is recoverable; no leaked tracks                                  | NOT RUN | NOT RUN |
| Private recording/review/retake      | Playable audiovisual clip; correct front/rear orientation; limits enforced                                   | NOT RUN | NOT RUN |
| Capture interruption                 | Back, lock, background, phone interruption and late permission grant stop camera/mic                         | NOT RUN | NOT RUN |
| File picker/upload                   | Cancel safe; supported image/video/audio; size rejection; retry without duplication                          | NOT RUN | NOT RUN |
| Draft privacy with two accounts      | Other account cannot read original, soundtrack or rendered private export                                    | NOT RUN | NOT RUN |
| Editor/render/export                 | Visible edits match exported media; worker failure and retry are honest                                      | NOT RUN | NOT RUN |
| Native share handoff                 | User chooses target; cancellation is not reported as posted; temporary files cleaned                         | NOT RUN | NOT RUN |
| Network authorization/revoke         | Approved scopes; state validation; correct owner; disconnect invalidates access                              | NOT RUN | NOT RUN |
| External delivery                    | Actual supported-provider post receipt; duplicates prevented; unsupported states clear                       | NOT RUN | NOT RUN |
| Sync/friends/invite                  | Only permitted data visible; no silent invites or arbitrary contact collection                               | NOT RUN | NOT RUN |
| Live private preview                 | Camera/mic active locally only; Go live remains separate and explicit                                        | NOT RUN | NOT RUN |
| Live two-device publish/watch        | Provider verifies LIVE; receiver has audio/video; mute/flip work                                             | NOT RUN | NOT RUN |
| Live failure/background/End          | Tracks stop; server End verified or uncertainty shown; no orphan public stream                               | NOT RUN | NOT RUN |
| Playback/feed lifecycle              | Swipe correctly selects media; pause on navigation/background; unsupported codec handled                     | NOT RUN | NOT RUN |
| Reports/block/moderation/privacy     | Safety actions work; blocked/private content stays excluded; moderator response verified                     | NOT RUN | NOT RUN |
| Export/delete/retry                  | Password confirmation; data export scoped; deletion removes sessions; required live shutdown failure handled | NOT RUN | NOT RUN |
| Outside-app deletion/policies        | Public URLs load; deletion works independently of app; retention exceptions accurate                         | NOT RUN | NOT RUN |
| Wallet pairing/signatures            | Reject/cancel safe; origin/account/chain verified; no private-key capture                                    | NOT RUN | NOT RUN |
| Testnet mint/transfer/tip recovery   | Correct test chain; pending hash recovery; insufficient gas/revert handled                                   | NOT RUN | NOT RUN |
| Accessibility                        | TalkBack/VoiceOver, text scaling, targets, keyboard/safe area and contrast                                   | NOT RUN | NOT RUN |
| Performance/network/battery          | Measured startup/frame time/memory; slow/offline/reconnect/thermal behavior acceptable                       | NOT RUN | NOT RUN |

## Connecting test devices

For Android, connect an owner-approved ARM64 phone by USB, enable Developer options/USB debugging and accept the device's computer authorization prompt. Inspect adb devices -l before installation; target the exact serial when more than one device is attached. Confirm the frozen preview APK's hash in NATIVE-LIVE.md before installing it. Do not uninstall a differently signed prior preview without protecting its local drafts.

For iPhone, use an owner-controlled Mac with Expo57-compatible Xcode and signing or a permitted EAS-signed build distributed through the appropriate Apple testing workflow. An Android APK or JavaScript export cannot be installed as an iOS app. Test on physical iPhones; a simulator cannot establish all camera/audio/wallet behavior.

Attach observed evidence and defects per row. Repeat critical flows on the final store-signed artifact and mark acceptance only after they pass. Do not substitute a browser screenshot or synthetic mock test for a physical result.
