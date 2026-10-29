# Store implementation and commercial activation

The Store implementation shares `mobile/src/screens/store.tsx` across web, iOS and Android. It has Marketplace, Sell and Services tabs. This work is a reviewable implementation, not an activated payment service. Prices remain proposals. No merchant account, paid hosting plan, payment agreement or live subscription product was created.

## Implemented

- Account-owned mini storefronts with a name, description and explicit public switch.
- Digital media and physical merchandise listings, private drafts, publish, mark sold and archive.
- Uploaded JPG/PNG/WebP product photos, editable display captions and price/title overlays. This composes a product display from the real photo; it does not generate a fictional photo or claim a vision model inspected the product.
- Opt-in text-only Create for Me fills editable title, description, storefront name and display caption, then opens Review. Price, condition, delivery, ownership and licensing facts remain seller-controlled. The existing bounded signed Cloudflare/private text gateway is reused, with its shared free request caps. Unavailable AI leaves the draft unchanged and the manual flow available.
- Network-wide browsing of published listings from active, discoverable sellers. Search, category, type, price range, sort, pagination and creator-store filtering are server-side.
- Product photo access follows publication, storefront enablement and seller privacy. Draft photos remain owner-only. Storage URLs and paid media files are never exposed by a listing.
- Stored revisions prevent silent cross-device overwrites. A stable creation request ID prevents duplicate listings after a lost acknowledgement.
- Listing reports, scoped moderator hide/restore endpoints and audit receipts. Restoring a listing returns it to draft for seller review. Store data participates in account export/deletion.
- Services catalog and cost-driver inventory in `backend/commerce-catalog.json`. Account storage usage is shown alongside proposed packages.
- Native StoreKit/Play purchase and restore adapters through `react-native-purchases`; web checkout adapter through `@revenuecat/purchases-js`. SDKs are installed, but no account, credentials or products have been provisioned.
- Server-only RevenueCat verification, random account-bound purchase identities, configured product allowlist, sandbox/refund/expiry checks and webhook authentication. Webhooks re-fetch provider truth instead of trusting embedded entitlement claims. Stale snapshots fail closed; owner storage upgrades still respect the global project cap. Existing media is not deleted on expiry.
- Limited iPhone beta purchase protection remains in both transport and native purchase code.

## Draft packages for owner review

All proposed prices are USD/month; platform-localized prices and final terms must come from the relevant store. Storage is measured in GiB, not decimal GB. The highest account storage allowance applies; these first packages do not stack.

| Package | Draft price | Storage | Scope |
| --- | ---: | ---: | --- |
| Free | $0 | Existing 1 GiB account cap | Current available tools and free provider limits |
| Creator | $7.99 | 10 GiB | Proposed larger listing and AI allowances, subject to measurements and implementation |
| Studio | $19.99 | 50 GiB | Proposed expanded creation and automation allowances, subject to provider readiness |
| Storage 10 | $1.99 | 10 GiB | Storage-only proposal |
| Storage 50 | $4.99 | 50 GiB | Storage-only proposal |

The inventory covers storage, AI listing copy, music, captions, narration, own-voice cloning, video exports, agent/workflow execution, imports/publishing, live/recording minutes, product artwork, commerce operations, IPFS/minting, notifications and messaging. Unavailable capabilities must not be advertised as unlocked by payment. Only storage has an implemented paid admission hook in this change; other expanded paid quotas remain to implement and measure before those benefits can be sold.

## Cost constraints checked 2026-10-28

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard storage is $0.015/GB-month beyond the shared free allocation; requests are separately metered. Ten GiB is about $0.16/month of raw storage, and fifty GiB about $0.81, before request rounding, copies, processing, database, support, tax and payment fees. These are illustrative storage-only calculations, not total product costs or authorization to incur them.
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): Workers Free includes a shared daily allocation. Higher throughput requires a paid plan or supported credits. A subscription does not automatically increase the project allowance. This implementation retains the current free gateway and does not add a paid fallback.
- [RevenueCat pricing](https://www.revenuecat.com/pricing/): free to start up to $2,500 monthly tracked revenue, then a percentage fee. RevenueCat is a proposed integration, not a permanent zero-cost service. It has not been activated or accepted on the owner's behalf.
- [Apple purchase rules](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase) and [Google Play Payments](https://support.google.com/googleplay/android-developer/answer/9858738) distinguish digital features/content from physical merchandise. The implementation uses platform billing for digital service upgrades; it does not send native users to an unapproved web payment shortcut.
- [Apple Small Business Program](https://developer.apple.com/app-store/small-business-program/) eligibility and [Google service fees](https://support.google.com/googleplay/android-developer/answer/112622) require separate review. No fee eligibility is assumed for Niche Labs LLC.

The current production project media cap is only 6 GiB shared. Selling a 10/50 GiB account allowance before approving real project capacity would be misleading. Both billing and storage upgrade activation are off by default. No cap or hosting plan was increased.

## Compact creator workflow (1.0.15)

Marketplace uses two square-photo columns on phones and three on desktop, with
price and title below each photo. The Discover side-menu Store action opens
Marketplace directly. Sell has Create, Review and Publish steps; storefront
settings and saved products open in separate panels. Native camera capture and
file uploads use explicit user actions. Publishing never follows AI generation
automatically, and storefront visibility is confirmed by the server before the
Publish action becomes available. Checkout and payouts remain disabled.

Promote has Campaigns, Calendar, Networks and Published icon shortcuts above
Plan, Networks and Activity tabs. Only one section expands at a time, and
expanded sections avoid nested decorative cards. Processing/provider readiness
continues to reflect actual server receipts.

## Before accepting payments

1. Review final package prices and deliverable benefits; set measured per-feature allowances and spending limits. Do not sell Creator/Studio promises whose expanded services are not implemented.
2. Review the merchant of record, seller fees, payout provider, taxes, disputes, refunds, digital license/delivery and merchandise shipping/returns. Digital creator sales require their own compliant product/payment design; the Services subscription adapter does not implement arbitrary creator-item checkout.
3. Review commercial privacy/marketplace terms and SDK privacy declarations. The existing limited beta notice has not been changed to authorize new commercial processing.
4. Configure approved Apple/Google subscription products, merchant agreements, tax/banking details and sandbox testers. Create or connect RevenueCat only after its terms, fee threshold and data processing are approved. Use the restore policy that retains purchases with the original Ziipa account; do not silently transfer subscriptions between unrelated accounts.
5. Configure web billing with an approved provider and verified webhook. No card details should pass through Ziipa's API.
6. Set backend `BILLING_REVENUECAT_SECRET`, `BILLING_WEBHOOK_AUTHORIZATION`, three platform public keys and `BILLING_PRODUCT_PLANS` (JSON mapping exact provider product IDs to reviewed catalog IDs). Use direct API webhook URL `/api/services/webhooks/revenuecat`. Leave `BILLING_ENABLED=false` and `BILLING_STORAGE_UPGRADES_ENABLED=false` until acceptance is complete. Keep `BILLING_ALLOW_SANDBOX=false` in production; use a separate staging environment for sandbox grants.
7. Run purchases, cancellation/expiry/refund, restore, offline retry, identity switch, provider outage and cross-device entitlement tests with real sandbox providers. Current automated verification uses deterministic provider fixtures; it is not live payment acceptance.
8. Build and test new native binaries containing the purchase SDK. JS exports and type checks do not prove native signing/compilation or device purchase acceptance. Keep the existing iPhone limited beta purchase lock until a reviewed commercial build is intended.
9. Apply additive migration `20261028_0014`, deploy the shared source, and ship matching native builds as one reviewed release. Nothing in this document authorizes a new deploy key or changes the existing release.

## Promote presentation

Promote now has one four-icon shortcut row: Campaigns, Calendar, Networks and Published. The release plan, media selector, private brief, publishing readiness, email/ads setup and campaign progress are individual +/− accordion panels. Only one main panel is expanded. Individual network and ad setup details also expand on demand. Brief/source/checklist state remains in the parent while a panel is collapsed; all existing authorization, save and navigation handlers remain intact.

## Compact Store presentation

Marketplace, Sell and Services use plain text tabs with a selected underline. Sell opens as six collapsed steps: Storefront, Create for Me, Product details, Photos & display, Delivery & publish, and Your products. Services opens as Account & usage, Creator plans, Storage add-ons, Feature limits, and Purchases & restore. Only one section is open in each tab. Product/storefront fields live in the parent and survive collapsing or switching sections; refreshing product receipts does not overwrite an unsaved storefront edit. These shared components apply to web, iOS and Android.

The exported portal was checked at 390 × 844: the collapsed Services overview fits in one phone screen, product text survives switching accordion panels, and proposed plans remain reachable. Shared iOS/Android JS exports and TypeScript validation passed. These exports are not signed native binaries or real-device payment acceptance.
