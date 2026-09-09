# Ziipa provider review packet

Prepared 2026-09-09 from [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md), [Meta adapter notes](backend/META_PUBLISHING.md) and the current adapters. **Draft, not an approval or completed submission.** No account, policy URL, demo recording or successful external post is invented.

## Current setup and owner blockers

| Provider       | Current deployment-task status                                                                             | Needed next                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TikTok         | Organization 7683540912521217032; Ziipa Studio registered under owner pbgc2017. Production form not saved. | Approved icon, active reviewed terms/privacy URLs, scope explanations, sandbox demonstration and implementation review below.                                        |
| Meta           | Owner phone verification required.                                                                         | Owner completes verification; confirm app/business access, product setup, supported Graph version, Page/professional Instagram roles and required permission review. |
| Google/YouTube | Owner pbgc2017 sign-in required.                                                                           | Owner project access, enabled YouTube Data API, OAuth web client/consent screen, controlled test users, verification and applicable YouTube audit.                   |
| Twitch         | Server secret saved in Render by the deployment task.                                                      | Confirm exact callback/scopes and broadcaster consent; test channel/follows/live controls. A saved secret is not a connected broadcaster or working relay.           |

Usernames above identify setup access, not Ziipa's legal seller identity. Do not use an unrelated developer account to complete verification.

## Exact registration values

These are the callback targets derived from the implemented same-origin portal flow, **not a claim that all live routes have passed testing**. Set PUBLISHING_API_ORIGIN and the exact approved origin to https://ziipa.com; keep OAuth start/callback on that browser cookie origin even if its API proxy forwards to api.ziipa.com. Native users authorize through the same signed-in portal, then refresh their mobile connections.

| Provider                         | Exact HTTPS redirect URI                                  | Requested scopes                                                                                    |
| -------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Facebook                         | https://ziipa.com/api/publishing/oauth/facebook/callback  | pages_show_list, pages_read_engagement, pages_manage_posts                                          |
| Instagram through Facebook Login | https://ziipa.com/api/publishing/oauth/instagram/callback | pages_show_list, pages_read_engagement, instagram_basic, instagram_content_publish                  |
| TikTok                           | https://ziipa.com/api/publishing/oauth/tiktok/callback    | user.info.basic, video.publish                                                                      |
| YouTube                          | https://ziipa.com/api/publishing/oauth/youtube/callback   | https://www.googleapis.com/auth/youtube.upload and https://www.googleapis.com/auth/youtube.readonly |
| Twitch                           | https://ziipa.com/api/publishing/oauth/twitch/callback    | channel:manage:broadcast, channel:read:stream_key, user:read:follows                                |
| Bluesky                          | https://ziipa.com/api/publishing/oauth/bluesky/callback   | atproto repo:app.bsky.feed.post?action=create blob:video/mp4                                        |

Do not request TikTok video.upload/video.list or Instagram Login's instagram_business_* scopes for the current flow. Do not register an OAuth callback as a provider deletion webhook: no verified Meta signed-request deletion/deauthorization callback was found in this audit. Supply actual reviewed deletion instructions or implement/test any callback required by the selected Meta configuration; do not invent a route.

## Draft explanations for provider forms

Use only after demonstrating the same behavior against the deployed release. Change any sentence that does not match the final build; no broader permissions are requested to promise universal synchronization.

**App overview:** Ziipa Studio is a creator workspace where a user records or uploads their own media, edits a creation, and explicitly chooses where to publish it. Users connect accounts individually, choose an authorized destination and approve the media before delivery. Ziipa displays processing/completion status and allows disconnection. It does not copy arbitrary content from other platforms, import private home feeds/messages, upload address books or send automatic invitations.

**Meta scope explanations:**

- **pages_show_list:** List eligible Pages managed by the person authorizing Ziipa, so that person explicitly selects the destination. Ziipa does not choose the first Page automatically.
- **pages_read_engagement:** Read the authorized Page information required by the Page/professional-account integration and reconcile selected Page content status. No general audience analytics or private-feed import is claimed.
- **pages_manage_posts:** Publish only the approved Ziipa-owned video as a Reel to the explicitly selected managed Facebook Page and show verified publication status. Personal Facebook timelines are unsupported.
- **instagram_basic:** Identify the professional Instagram account linked to the selected managed Page and show the correct destination.
- **instagram_content_publish:** Create a Reel container for the approved video, check processing, then finalize the consented publication and display its receipt. Consumer/personal Instagram accounts are unsupported.

The integration uses **Facebook Login**, encrypted server-side user/Page tokens and a controlled signed-media origin. Disconnect revokes Meta access where possible and removes local credentials; it can invalidate both Facebook and Instagram grants. Already published external posts remain. Meta's own [Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) documents the Page-linked container/status/publish sequence. General Meta review pages were unavailable to the research tool; confirm the live console's exact Advanced Access/business verification/reviewer requirements after owner verification rather than treating this packet as the final checklist.

**TikTok product/scope explanation:** Ziipa uses web Login Kit/OAuth to connect the creator's TikTok identity. user.info.basic identifies the connected account; video.publish enables the user's explicit Direct Post of an owned creation with chosen visibility, interaction settings and disclosures. Ziipa retrieves current creator options and displays a receipt/status; it does not request public-video listing or a private timeline. The current server enforces SELF_ONLY until audit approval is independently confirmed. [TikTok scope definitions](https://developers.tiktok.com/docs/en/tiktok-api-scopes)

**TikTok findings to resolve before an audit claim:** The initial September 9 review found FILE_UPLOAD of server-owned media and user-declared duration. TikTok requires PULL_FROM_URL for server-stored content using an owner-verified domain/prefix; validate the actual clip against current creator limits. Record the corrective implementation/tests and domain verification before treating these findings as resolved. Also verify creator identity/options, no default visibility, interactions off initially, commercial/music disclosures, editable content preview and express upload consent. Do not present a team-only uploader as a public creator product. [Current sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)

For first review, TikTok requires a sandbox demonstration of all requested products/scopes, with the actual matching web domain. Supply a complete public product website with visible active terms/privacy links, not only a login/placeholder page. At most five demo videos of 50 MB each are accepted. The current integration should be reviewed as **web**; do not claim published Android/iOS store listings or submit preview package details as production mobile identities. [TikTok review requirements](https://developers.tiktok.com/docs/en/app-review-guidelines)

**YouTube scope explanations:** youtube.upload uploads the creator-approved original or ready rendered video to the explicitly selected authorized channel, with title/description, selected visibility and made-for-kids answer. youtube.readonly identifies that channel and reads upload processing/visibility so Ziipa can show an accurate result. Broader account/video-deletion scopes are not requested. Offline consent supports server token refresh for these authorized operations; disconnection attempts revocation and removes local credentials.

Google OAuth verification and the YouTube API compliance audit are distinct. Keep Ziipa private-only until the relevant project approval is verified; qualifying unverified projects have private upload restrictions. [YouTube upload rules](https://developers.google.com/youtube/v3/docs/videos/insert) Google review needs accurate branding/domain/policy information, scope justification and a demonstration of consent and each scope's use; its instructions request an unlisted YouTube demo showing app name and OAuth client ID in the consent URL. Never show tokens, authorization codes or secrets. [Google sensitive-scope review](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

## Concrete sandbox demonstration sequence

Record actual UI with controlled, consenting test accounts and rights-owned 10–15 second portrait MP4 media below Ziipa's 25 MB publishing cap. Avoid copyrighted music, bystanders, private messages and secrets. Use separate short provider recordings; narrate or caption actions in English. Do not simulate a successful provider receipt.

1. **0:00 — Identity/product:** Show the real Ziipa domain and Studio, product information and working policy links. State this is a controlled test. Sign into a prepared Ziipa reviewer account; supply its credentials separately in the provider's secure reviewer fields.
2. **0:30 — Connect:** Open Networks → the provider → Connect. Show the real authorization page, requested permissions, account identity and consent. Return through the registered callback to the same Ziipa session. Show an explicit Page/channel/professional-account selection where applicable.
3. **1:15 — Create:** Upload or record authorized media, save edits and publish the owned creation to Ziipa. Choose a ready rendered export or explicitly acknowledge original media. Preview the exact intended source; do not claim overlays are in an original file.
4. **2:00 — Provider choices:** For TikTok, show latest creator nickname/options, deliberately select allowed visibility and complete music/commercial/AI/interaction choices. For YouTube, select private visibility and answer made-for-kids. For Meta, show the selected public Page/professional destination; use authorized app-role test assets and do not describe them as private posts.
5. **2:45 — Deliberate delivery:** Confirm the displayed destination and content, publish once, show processing, then use Check delivery until the provider confirms a result. Instagram's check can finalize the already approved container. Show the matching provider-side post/video in the controlled account when available. For TikTok sandbox, show its actual allowed result, not an invented public URL.
6. **3:45 — Control/revocation:** Disconnect, show the connection is no longer usable without authorization, explain external copies remain, and show privacy/export/deletion instructions. Demonstrate canceled authorization or an unsupported destination briefly; no silent invite/friend import should appear.

Twitch needs a separate consented live demonstration: authorize broadcaster, show channel/followed channels, approve title/category updates, explicitly attach the destination, then start/end a controlled stream and verify the receiving channel. Do not expose the stream key or claim file-upload publishing. Do not start a broadcast merely to produce this document.

## Required owner inputs and evidence

- **Legal operator/support:** UNSET. Confirm business identity, authorized representative, monitored contact and verification steps; do not substitute an account username.
- **Final public website, terms, privacy and deletion instructions URLs:** UNSET for review acceptance. Publish/review actual pages, check signed-out access, and use their exact URLs in consoles. The callbacks above are not policy-page substitutes.
- **Policy content:** Specify collected account/content/social-token data, purposes/processors, retention/deletion/revocation, external copies, appeals and relevant platform-data requirements. Use [the data worksheet](mobile/store/DATA-DISCLOSURE.md); do not claim a review or retention period not established by the operator.
- **Brand icon:** Candidate [app-icon.png](mobile/assets/brand/app-icon.png), observed 1254×1254 PNG. Owner must approve the artwork and validate/resize to the current provider form's accepted dimensions; no icon was uploaded here.
- **Reviewer/test assets:** UNSET. Controlled Ziipa login, Google test users/channel, TikTok sandbox users, eligible Meta app roles/Page/professional account, and Twitch broadcaster. Credentials go in secure review fields only.
- **Media/source ownership:** Confirm rights and production media origin. Verify TikTok URL ownership for corrected PULL_FROM_URL and Instagram's allowlisted signed source lifetime; R2 URL configuration alone is not a TikTok domain verification.
- **Release evidence:** Exact deployed commit/config, real OAuth/refresh/revoke checks, per-scope recordings, actual receipts and privacy/deletion tests. Missing provider access or unsuccessful tests remain blockers.

Keep public-approval flags false until actual provider approval is recorded. Saving a console form, adding a secret or passing mocked tests never grants platform permission.
