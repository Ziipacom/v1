# Ziipa monetization: setup and readiness

## Store build preparation · 2026-11-10

The `store-with-ads` EAS build profile links the issued AdMob app IDs. The
native app checks the signed-in user's serving permission before requesting
ads. Set `ADMOB_ANDROID_SERVING` and `ADMOB_IOS_SERVING` independently in the
production API after each platform clears store review, publisher verification
and device QA. Both default to false. The client drops expired permissions and
requires the existing 18+ account attestation and Google consent before serving
non-personalized ads. Required AdMob privacy choices are available in Settings.

Google Play saved the draft **Contains ads** declaration and the developer
website `https://ziipa.com`. Both Discover ad units now accept video only.
Marketplace units accept images and video. The public `/app-ads.txt` returned
HTTP 404 before deployment. The verified publisher entry is present in the
built website bundle.

Complete the Play store checklist and public release, then link the listing in
AdMob. Use the same steps for the App Store. Set the public privacy notice URL
in AdMob's Privacy & messaging before publishing the regional consent messages.
Review the provider's data disclosure and update the store privacy forms before
submitting the ads-enabled builds.

## Native ad test · 2026-11-10

The optional `android-ad-test` profile builds Ziipa Ads QA alongside the normal
Ziipa app. It requests Google's demo units for a muted sponsored card after six
Discover posts and a square sponsored tile after eight Marketplace listings.
Each screen shows up to one ad when Google returns inventory. The mobile SDK is
linked only for explicitly enabled native QA builds. The web portal excludes it.

The signed-in AdMob dashboard shows two active ad units per platform. Both apps
show **Requires review** and **Limited ad serving** and ask for a store listing.
Both preparation mediation groups are paused. The confirmed Google publisher
entry is in `frontend/public/app-ads.txt` for the next website deployment.
The public store listings need to link to the developer website before Google
can verify that file. Live ads also require verified privacy choices, age
treatment and a remote serving control.

The signed-in Unity dashboard still offers Rewarded, Interstitial and Banner
for each Ziipa app. Meta still requires a valid store listing to complete its
application.

## Verified setup · 2026-11-03

These are issued console IDs, not evidence of live ad serving. No advertising
SDK, tracking code, payout setup or paid campaign was activated in this setup.

### AdMob

Account: `pbgc2017@gmail.com`, publisher `pub-4702540477449660`.
The existing iOS app/units were reused; the Android app and its units were created.
Neither app has a verified public store listing linked in AdMob yet.

| Platform | App ID | Discover Native | Marketplace Native |
| --- | --- | --- | --- |
| iOS | `ca-app-pub-4702540477449660~2970571742` | `ca-app-pub-4702540477449660/6289327663` | `ca-app-pub-4702540477449660/2284176037` |
| Android | `ca-app-pub-4702540477449660~7843954044` | `ca-app-pub-4702540477449660/2400055673` | `ca-app-pub-4702540477449660/7703132055` |

Both ad formats are **Native advanced**, with partner bidding on another
mediation platform unchecked. Native views can contain provider-supplied video
or images; a video-only fill is not guaranteed. The Marketplace square is a
presentation constraint for the registered native media view, not a separate
"square ad" format or permission to crop required disclosures.

Paused preparation groups associate each platform's two units. Android group
ID: `8488436468`; iOS group ID: `9913320947`. AdMob's default network remains the only mapped source;
Unity was not connected or activated. The Android Native bidding-source picker
returned no Unity entry, and Unity's current placement wizard offered only
Rewarded, Interstitial and Banner. No incompatible full-screen placement was
substituted for the requested inline inventory.

### Unity

Both apps were registered in the existing Ziipa project
`944c5b46-b22d-4fd5-afc2-d568cd78d014`, organization `5774153220595`:

| Platform | Unity app ID | Game ID |
| --- | --- | --- |
| iOS | `b22d93a1-628b-4503-925e-c590f9d5c41e` | `800422649` |
| Android | `eb8e8693-acde-4821-81c6-0d3b8dfd6607` | `800422705` |

Both are designated general audience, not primarily child-directed, matching
the current adult beta. Under-age treatment for a future 13+ launch still needs
separate verification. Store IDs are not set. No placements were issued: the
requested Native format is absent from this account's current console wizard.
The current Google adapter guides document Native bidding support, so the
account/console availability mismatch must be resolved before mapping IDs.
No waterfall inventory, analytics sharing with Unity, Developer Data collection
opt-in, SDK initialization or ad requests were enabled.

### Firebase / Google Analytics

With the owner's specific terms approval, Google Analytics was enabled and
linked to Firebase project `ziipa-4a893` under `gloryvee@gmail.com`:

- Analytics account: **Ziipa**, ID `414558806`.
- Property: **ziipa-4a893**, ID `562180495`.
- Existing **Ziipa Android Preview** app stream: `16264146573`.
- Analytics location: United States; optional Google data-sharing settings off.
- Firebase plan: **Spark, $0/month**.

The console explicitly requests adding the Analytics SDK. Project linkage does
not establish that any device events are arriving. iOS and web stream setup,
event instrumentation, privacy choices and DebugView acceptance remain separate.
This approval did not authorize sharing this property with Unity or a new AdMob
account-link data flow. Production and preview package identities must stay
distinct when adding native streams and SDK configuration.

### Remaining activation work

Resolve Unity Native availability; configure approved bidding partnerships and
issued mappings; verify public store ownership and app review; obtain provider
`app-ads.txt` entries; implement native SDK views, consent/age controls and a
remote kill switch; exercise only test ads on real devices. Web advertising
still requires a separate supported adapter. Keep live serving off until these
checks pass. All existing hosting and project plans remain free.

Owner request, 2026-10-28: use Meta, AdMob and Unity to serve clearly identified video ads among Discover creations and product-style ad cards among Marketplace listings. AdMob and Unity accounts will be supplied later. This document records the next phase; no ad SDK, live placement, tracking request, publisher agreement or payout setup is activated by the Store/Promote implementation.

## Observed Meta account

The owner-supplied [Ziipa Monetization Manager](https://business.facebook.com/pub/landing?business_id=1948272116139133) asks for at least one valid App Store or Google Play Store URL, plus the app name. On 2026-10-28, Apple's App Information page confirmed app ID 6827668999, bundle ID `com.ziipa.app`, and its View on App Store link: https://apps.apple.com/us/app/ziipa/id6827668999. Distribution remains version 1.0, Prepare for Submission.

The verified Apple URL and Ziipa name were entered into Meta. The owner explicitly approved accepting the displayed Audience Network Terms, Policy and Meta Platform Policy and continuing. The Next attempt did not complete: Meta reported “Unable to find or retrieve app details. Please try again later,” cleared the app name, and left Application incomplete, AD placements pending and Integration pending. No successful terms-acceptance receipt, review submission, placement or ad serving was verified. The current unreleased Apple listing is a likely explanation for the lookup failure; Meta did not state its exact cause.

### Live readiness recheck · 2026-10-29

The owner requested continuing Meta setup now. The existing business session
opens correctly as **Monetization Manager – Ziipa**, business ID
`1948272116139133`. Its Application is incomplete; AD placements and Integration
remain pending. The form explicitly requires at least one valid app-store link.
The app name `Ziipa` is prepared in the open form, with Next disabled while a
valid store URL is missing. That input has not been submitted or saved as a
completed Meta application.

Both candidate public URLs were checked in the browser today:

- Apple `https://apps.apple.com/us/app/ziipa/id6827668999` displays "The page
  you're looking for can't be found."
- Google Play `https://play.google.com/store/apps/details?id=com.ziipa.app`
  displays "the requested URL was not found on this server."

The TestFlight beta and Play Console draft are therefore not a verified store
listing Meta can retrieve. A working Ziipa listing is the immediate prerequisite;
no unrelated app URL, preview package, invented publisher ID or TestFlight link
has been substituted. No new agreements, payout account, SDK, permission grant,
placement, review submission or live ad requests were activated in this recheck.

The proposed inventory remains four separately identified **Native** placements:
`Ziipa iOS Discover Native`, `Ziipa Android Discover Native`,
`Ziipa iOS Marketplace Native`, and `Ziipa Android Marketplace Native`.
These are preparation names, not issued placement IDs. Discover's initial test
interval is six organic items and Marketplace's is eight; these remain draft
defaults until SDK test-ad and product acceptance. Web needs its own supported
ad-serving adapter; mobile Audience Network mediation does not configure web ads.

The official iOS/Android integration guides were rechecked: Meta demand uses
bidding, with AdMob as the proposed mediation platform. After app eligibility,
complete owner-led payout onboarding, create the actual placements, obtain
issued IDs, configure the bidding source in AdMob, publish the provider-issued
`app-ads.txt` entries, and verify test ads on registered devices before live
activation. Meta's business ID and the separate social-import developer app
credentials are not ad-placement IDs. Existing hosting remains on free plans.

## Google Play account history and current draft

On 2026-10-29, the owner confirmed the prepared policy/export declarations and
Play App Signing Terms. Ziipa's free English-US App draft was created successfully
in developer account `5793486319300616308`, app ID `4972491206873157231`, with
package `com.ziipa.app`. The earlier account-wide restriction banner was not
present in that session. The listing name, short description and full description
were saved as a draft; the console confirmed the save. No release, signing-key
selection, review submission or public publication was performed.

The icon, feature graphic, screenshots and remaining app-content declarations
still need completion. A reviewed, properly signed production AAB is required;
the existing `com.ziipa.app.preview` APK must not be uploaded for this package.
`https://play.google.com/store/apps/details?id=com.ziipa.app` is the prospective
package URL, not a verified available store listing. Meta still needs a listing
its app lookup can retrieve. The account observations below are historical.

The requested Play Console account, developer ID `5793486319300616308`, is restricted. Its issue details state that the profile and all apps were removed September 19, 2024 because account verification was not completed before the deadline. The console says changes will not be published. An existing appeal has a reply sent to the owner; no new appeal was submitted.

The account-owner recovery flow is open at Choose an account type. It requires confirming organization/personal account type, linking a payments profile, and supplying account/public/private contact information. No account type was selected, payments profile linked, identity information transmitted, or existing unrelated app modified. Ziipa was not created or uploaded to this blocked account, and no public Google Play URL was claimed. Account verification/reinstatement and a reviewed signed Android release are prerequisites to obtaining a working public listing.

## Proposed implementation

- Use one native mediation integration, with AdMob as the proposed mediation layer and Meta/Unity as bidding sources, rather than initializing three competing placement systems.
- Build a shared placement contract with separate native and web adapters. These native SDK preparations do not provide a web ad-serving implementation; keep web serving off until a supported web provider and its approval are selected.
- Discover: a dedicated sponsored feed entry after a configurable number of organic entries. Start testing with six, avoid consecutive ads, and keep ad interactions outside creator likes, saves, publishing and reward points.
- Marketplace: a labeled native ad card after a configurable number of organic products. Start testing with eight. Keep its advertiser identity, SDK media view, action control and ad disclosure distinct from seller products and checkout.
- Render SDK-provided assets inside registered native ad views. Preserve provider-required AdChoices/disclosures and click handling; do not repackage ads as user uploads or invent ad creatives.
- Keep one visible video active. Pause ordinary media as a sponsored video becomes active, and dispose offscreen ad resources. No fill, offline, consent denied, disabled network or unavailable provider must leave an empty card or block ordinary browsing.
- Use test ads and registered test devices for development. Never exercise revenue-generating impressions/clicks as acceptance tests. Verify each bidding source with the provider inspector before enabling live units.
- Add explicit provider enable switches, placement frequency, consent/age eligibility, initialization state, error/fill telemetry and a remote kill switch. Do not initialize or request ads until required privacy choices have been handled. Review ATT/UMP, regional consent and the planned 13+ launch separately from the current adult beta.

These intervals are initial test defaults, not approved production ad load. Final spacing, maximum session load and privacy/product disclosures remain to review.

## Current official format guidance checked

- [Meta through AdMob on iOS](https://developers.google.com/admob/ios/mediation/meta): Meta Audience Network is bidding-only and includes native ad support.
- [Unity through AdMob on iOS](https://developers.google.com/admob/ios/mediation/unity): the current adapter documentation includes native formats and bidding; do not rely on old assumptions that Unity only serves full-screen ads. Verify the corresponding Android adapter and wrapper versions before implementation.
- [AdMob native ads](https://developers.google.com/admob/ios/native): loading and presentation use provider ad objects and assets, with test ad IDs during development.

Before live serving: confirm Ziipa app-store listing URLs and ownership; accept the specific publisher agreements only with owner confirmation; provision test/live app and ad-unit IDs per platform; configure bidding and privacy controls; review SDK data declarations and app-ads.txt; complete real-device test-ad acceptance and provider approvals; then release matching native/web behavior without changing unrelated projects or hosting plans.
