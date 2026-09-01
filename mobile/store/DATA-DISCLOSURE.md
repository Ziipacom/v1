# Data disclosure worksheet — owner review required

This describes the current implementation, not a completed App Store privacy label or Google Play Data safety submission. Verify the deployed backend, vendors, logging, backup policy and signed binary before answering store questionnaires.

| Data | Why collected | Storage / access | User control |
| --- | --- | --- | --- |
| Name and email | Account identity and attribution | Ziipa database; name appears with published content | Account deletion |
| Password | Authentication | Argon2 hash only on server; password sent over HTTPS in production | Account deletion; recovery workflow still needed |
| Session token | Keep the device signed in | iOS Keychain / Android encrypted storage; hash-keyed Redis server session, 7 days | Sign out revokes current mobile session; deletion invalidates all devices |
| Uploads, captions, descriptions, tags, declared city | Create and discover media | Ziipa file storage and database; drafts private, published posts accessible to signed-in members | Retract to draft; delete account. Individual media retention/cleanup needs operational review |
| Likes, bookmarks, feed rules, safety settings | Personalization and feed curation | Database associated with account; shared feed rules visible to other members | Change preferences; account deletion |
| Comments | Conversation | Database, accessible with the post | Report/moderation; account deletion |
| Reports and policy acceptance | Safety operations and consent record | Database; reports restricted to configured moderators | Account deletion currently removes relevant reports; finalize legal retention policy |
| IP / request metadata | Request processing and rate limiting | Redis rate keys are hashed from IP+path with 60-second limits; web/server logs depend on deployment | Disclose final logging/retention practices |

WalletConnect Universal Provider is integrated. Pairing starts only when requested; its relay and wallet services may receive network/device/application metadata. Review the configured Reown project and vendor disclosures. Wallet addresses, chain IDs, verification times, metadata documents/hashes/URIs, unsigned requests, transaction hashes and confirmation status are stored with the Ziipa account. Browser login tokens and WalletConnect pairing secrets stay in memory; native login tokens remain in SecureStore. Pending transaction IDs/hashes are recoverable in SecureStore (native) or sessionStorage (web). No seed phrases or wallet private keys are collected. Public blockchain records and replicated IPFS data cannot be erased by account deletion. Local offline IPFS pins are retained for development and require a retention/garbage-collection policy before hosting.

No ad, location, contacts, purchase, or social-login SDK is integrated. Do not answer “no data collected”: this app has account and content data. The camera permission is optional, prompted only for Take a photo; microphone and broad Android photo-library/storage permissions are excluded. Uploads can contain user-supplied metadata; review metadata stripping before production.

The document picker may copy selected files to the app cache. Uploaded originals remain on the server until an implemented removal workflow deletes them. Video playback does not opt into disk caching; private images use no persistent image cache. Review OS backups and cleanup behavior on actual devices.

Transport is HTTPS-only in release-mode app networking. Development clients can use HTTP to a local server. Current API/database/media at-rest encryption depends on the host and is not provisioned by the mobile client. No claim of end-to-end encryption is made.

Complete platform forms using the store's exact current definitions of collection, sharing, account linkage, diagnostics, and retention. Include every production processor once selected. List required-reason native API use from the final privacy manifest and dependency manifests; do not copy guessed reason codes into the app config.
