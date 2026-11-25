# Wallet and marketplace beta — November 23, 2026

Shared source changes are local; no API migration/deployment or signed beta has
been released for this work. Existing installed betas retain their old wallet
restrictions until replaced by a new binary.

## Implemented

- Saved own draft/published media can open Token Wallet from Studio and the
  creation library. NFT browsing stays hidden. The handoff uses the saved source;
  albums use the cover, and edited media requires its own exported source.
- Wallet pairing, ownership proof and reviewed mint transactions are available
  to the next iOS/Android beta, with Base Sepolia/Ethereum Sepolia only. Local
  chain is desktop development only. Actual transaction chain is checked before
  requesting a signature. MetaMask pairing, QR/copy fallback and return-to-wallet
  controls are included. Ziipa never holds the signing key.
- Public Reown project `9c65a916dd054ea5033d0cc926ddab8e` was created in the Ziipa
  team. `https://ziipa.com` and iOS/Android `com.ziipa.app` plus `.preview` were
  allowlisted. No secret, wallet, paid upgrade or signing permission was created.
  The public identity is shared by web and native build configuration.
- Marketplace categories use a compact expandable grid. Seller-only pencils
  reload the owned listing's current revision before opening Sell.
- Storefront image overlays contain price, title and short description. Product
  detail uses an unobstructed large preview and three-thumbnail pages.
- Sell uses ten small upload boxes; Upload, Camera and Ziipa Library; multiple
  selection; cover selection/removal. Up to ten total images/video/audio; images
  up to 10 MiB, audio/video up to 100 MiB. Full listing previews are public only
  while the listing/store/seller are public. They are not paid downloads.
- Publish has +Connect to the existing network publishing permission flow.
  Publishing OAuth is distinct from social-feed imports, which remain disabled
  in limited betas. Connecting or publishing a store listing does not syndicate
  the product automatically. External product-post composition remains a separate
  integration from the existing creation-media publishing flow.
- Physical merchandise test checkout supports Stripe Connect and PayPal
  marketplace sandbox. Hosted onboarding/payment pages; server price/seller
  snapshots; idempotent order creation; pending/paid/refunded status; signed
  webhooks recheck provider truth. PayPal captures only on the buyer's explicit
  Confirm test purchase action. Neither redirect parameters nor client receipts
  prove payment. Mainnet, live payments, bank linking and digital delivery remain
  unavailable. Native digital service purchases retain their existing lock.

## Wallet activation still required

The live public API reported testnet-only, Pinata configured, and **no contracts**
on either supported public testnet. This is configuration evidence, not an actual
mint or an independent IPFS availability test.

`contracts/.local/deployment-84532.json` contains four unsigned deployment requests
and expected runtime hashes. The owner must review the contract source/security
and deploy using their own funded **test-only** wallet, then verify live runtime
hashes/receipts and configure `WEB3_REGISTRY_JSON` on the API. Do not request a seed
phrase/private key, use real gas, fabricate contract addresses or use known local
development keys on a public chain. There is no deployment signer in this work.
See `WEB3.md` for the existing deployment/ownership/storage requirements.

## Payment provider setup still required

Stripe and PayPal setup tabs are open for owner sign-in. No sandbox secret or
webhook was provisioned. No checkout/order/seller-account creation was sent to
either provider by the agent. New persistent provider credentials and applicable
agreements require their own concrete owner approval at setup time.

Backend settings (secret values must stay server-side):

```
MARKETPLACE_ENABLED=false
MARKETPLACE_PUBLIC_ORIGIN=https://ziipa.com
MARKETPLACE_STRIPE_SECRET=<sk_test_ or restricted rk_test_>
MARKETPLACE_STRIPE_WEBHOOK_SECRET=<sandbox webhook secret>
MARKETPLACE_PAYPAL_CLIENT_ID=<sandbox app>
MARKETPLACE_PAYPAL_SECRET=<sandbox secret>
MARKETPLACE_PAYPAL_PARTNER_ID=<sandbox platform merchant>
MARKETPLACE_PAYPAL_BN_CODE=<partner attribution>
MARKETPLACE_PAYPAL_WEBHOOK_ID=<sandbox webhook>
```

Apply migration `20261125_0019` after the deployed Live destination revision
`20261123_0018` before deploying the shared clients. The deployed `0018` migration
retains its original `20261030_0016` parent; do not insert the former local `0017`
Store draft behind an already-applied revision. Provider
webhooks should point directly to the API:

- Stripe: `/api/store/payments/webhooks/stripe`, checkout session completed,
  expired and asynchronous success events. Test events never supply payment proof.
- PayPal: `/api/store/payments/webhooks/paypal`, order approval/completion and
  capture events. Merchant association is resolved by a server-generated tracking
  ID and verified OAuth permissions, never browser query parameters.

Stripe requires test-mode Connect capability and completed test seller onboarding.
PayPal requires the marketplace/partner sandbox capabilities and seller permissions
in its developer account. A live PayPal marketplace additionally requires PayPal
approval; sandbox implementation does not assert that approval exists.

Enable only after real sandbox acceptance with test accounts/cards and verified
webhooks. Shipping countries are US/GB, USD only, one-item inventory; the seller's
listed price includes shipping. Checkout reservations prevent another buyer's
concurrent checkout. Uncertain provider responses preserve the original order;
never create a replacement purchase to work around an unconfirmed result.

Live commerce still requires fulfillment, refunds/disputes operations, taxes,
marketplace terms/privacy and native digital billing/delivery design. No paid
plan or real transaction is authorized by these code changes.

## Verification and release

Automated providers are synthetic; passing tests/JS exports do not prove physical
MetaMask handoff, a real mint, a sandbox merchant acceptance or a signed native
build. Update `privacy-beta.html` alongside new wallet/publishing/payment binaries.
Run device acceptance on iOS and Android before replacing the existing beta.
Preserve the earlier local UI work and the user's real account in side view.

## Keyboard follow-up

Shared sheets now avoid the keyboard on both iOS and Android, including sheets
without a footer. The scrollable body shrinks while header/footer stay reachable;
Storefront settings has one scroll container and a pinned Save action. Mobile web
uses visualViewport changes and scrolls only the focused input in its own sheet.
Vertical form screens without an existing KeyboardAvoidingView gain iOS automatic
keyboard insets; Android explicitly uses resize mode. Shared keyboard tests cover
no-footer behavior, viewport/offset changes, background-field isolation and cleanup.
Physical iOS/Android keyboard and MetaMask handoff acceptance remain pending a new
signed beta; exports and simulated viewport checks are not device acceptance.
