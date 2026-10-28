# Ziipa monetization: queued after Store and Promote acceptance

Owner request, 2026-10-28: use Meta, AdMob and Unity to serve clearly identified video ads among Discover creations and product-style ad cards among Marketplace listings. AdMob and Unity accounts will be supplied later. This document records the next phase; no ad SDK, live placement, tracking request, publisher agreement or payout setup is activated by the Store/Promote implementation.

## Observed Meta account

The owner-supplied [Ziipa Monetization Manager](https://business.facebook.com/pub/landing?business_id=1948272116139133) was inspected read-only on 2026-10-28. It shows Application incomplete, AD placements pending and Integration pending. The form asks for at least one valid App Store or Google Play Store URL, plus the app name. Its Next action also accepts Meta's publisher/platform terms. No form was submitted and no terms were accepted. TestFlight installation alone does not supply the app-store listing requested by that form; a valid Ziipa listing must be confirmed before submission.

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
