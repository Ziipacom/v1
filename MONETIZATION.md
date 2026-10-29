# Ziipa monetization: setup and readiness

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
