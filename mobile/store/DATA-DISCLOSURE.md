# Data disclosure worksheet — owner review required

Updated 2026-10-20. This describes source behavior to investigate, not completed privacy labels, Data safety answers or a legal policy. Confirm the signed binary, deployed settings, vendors/subprocessors, audience, logs and retention before answering consoles.

Owner identity update, prepared locally on 2026-10-27: legal operator Niche Labs LLC;
public support/privacy contact ziipaziipa@gmail.com. The owner intends worldwide
13+ access, but deployed native/shared Studio registration still asks for an
explicit adult confirmation. No minor's declaration may be recorded through
that adult field. Age-policy/registration alignment and jurisdiction/guardian
requirements remain unresolved; see [the unpublished contract proposal](POLICY-ALIGNMENT-CANDIDATE.md).
No full privacy/terms policy, store disclosure or review acknowledgment is
approved by this metadata update.

Editor music additions: AI composition sends only the explicitly consented
musical description/settings to the configured private model or Cloudflare
Workers AI. It does not send uploaded audio/video, the media
library or account history. Bounded note scores are synthesized to WAV on the
device and remain local until the user attaches/saves the draft. Music in this
release is uploaded by the user or created in Ziipa. SoundCloud connection,
discovery, OAuth and embedded playback are not included. Minting and sharing
require separate user actions; composition alone does not mint or publish.
Recheck all deployed providers, permissions and policies
before answering store disclosures; these notes do not constitute legal review.

Auto captions are separately consented: the private engine processes original
speech within Ziipa's configured local runtime, while the optional Cloudflare
provider receives only decoded bounded audio, never a public/signed media URL.
The current provider is shown before each request; refreshing it clears consent.
Temporary owner-scoped proposals expire after 15 minutes and can disappear on an
API restart. Nothing changes until the user applies the proposal and saves.
Raw source cues are private owner-editing data and excluded from public feeds;
only the accepted mapped caption track accompanies a published edit.

Appearance and playback choices are device-local, persisted in AsyncStorage.
Notification categories and privacy controls use the account API; OS push
permission/device registration remain separate user actions. Promotion briefs
are private Media OS projects. Email sends and paid-ad delivery are not enabled
by linking a social profile; no advertising or email marketing adapter is active.

| Data                                                                                                                 | Purpose and possible recipient                                        | Storage/control to verify                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, email, account/profile identifiers                                                                             | Accounts, attribution and verification/recovery email                 | Database and email processor; name may accompany published content. Deletion/privacy controls exist. Verify deployed email delivery and enforcement.                                                                                                                   |
| Password and verification/recovery tokens                                                                            | Authentication and recovery                                           | Password reaches the HTTPS API and is stored as an Argon2 hash; recovery/verification use limited-lifetime tokens. Never log passwords or token URLs.                                                                                                                  |
| Session credentials                                                                                                  | Signed-in app/API access                                              | Native token uses Expo SecureStore; server sessions use Redis. Web memory/cookie behavior differs by portal mode. Test logout/deletion, backups and identity changes.                                                                                                  |
| Selected/recorded photos, videos, audio; captions, overlays, soundtrack, tags, descriptions and declared city        | Creation, discovery, editing/export and playback                      | Private recording preview does not broadcast. Upload/publish sends content to configured Ziipa storage/API; render workers access selected media. Drafts are owner-scoped. Verify originals, derivatives, caches and deletion retries. City is user-declared, not GPS. |
| Live camera/audio and stream records                                                                                 | User-initiated public broadcasts through Livepeer                     | Explicit Go live transmits through WHIP; private preview alone stays local. Ingest credentials are owner-only. Check provider recording/logging/retention and audience; do not claim end-to-end encryption or zero retention.                                          |
| Social connection identity, grants/tokens, synchronized records and delivery receipts                                | Connect networks, retrieve permitted records and deliver chosen media | Server-stored credentials require configured protection; external platforms process authorized requests/media. Inspect scopes, encryption, revocation and retention. Disconnecting does not automatically delete published external copies.                            |
| Likes/favorites, comments, feed rules, preferences and interaction records                                           | Social activity and personalization                                   | Account-associated database records; visibility follows resource/privacy settings. Verify export completeness, moderation and lawful retention.                                                                                                                        |
| Reports, blocks, muted words, policy acceptance and age confirmation                                                 | Safety, abuse response and consent                                    | Safety/consent records with restricted moderation access. Operator must decide retention, appeals and deletion handling. Self-declared age is not identity verification.                                                                                               |
| Wallet addresses, chain IDs, ownership signatures, metadata URIs/hashes, transaction hashes/status and asset records | Non-custodial wallet linking and test-network actions                 | Ziipa plus external wallet/RPC/network, WalletConnect relay and configured IPFS service. Wallets hold private keys; Ziipa does not request seed phrases. Public chain/IPFS copies cannot be recalled by account deletion.                                              |
| IP/request/device/application metadata                                                                               | Delivery, authentication, rate limits, provider access and operations | API/CDN/media/RPC/relay services may receive network metadata. Hashing rate keys does not prove absence of IP in other logs. Inventory actual diagnostics/identifiers, vendor use and retention.                                                                       |

## Permissions and user control

Camera and microphone are optional, requested by recording/live actions. Explain both, show capture/broadcast state and verify cleanup on denial, cancellation, navigation, interruption and backgrounding. The native app now includes WebRTC and microphone capture; the previous “photo-only camera, no microphone” claim was incorrect.

Configuration blocks broad Android storage/media-reading, contacts, precise/coarse location, advertising-ID and overlay permissions. Document selection uses OS pickers. No ad/analytics/purchase SDK was identified in the audited package dependencies; that does not establish a final “no tracking” or “no sharing” declaration. Inspect transitive SDKs, merged permissions, privacy manifests, network traffic and vendor policies.

Do not upload contacts or send automatic invitations. Network APIs expose approved scopes, not every friend's/private feed. An OS share sheet requires user selection and does not prove a completed external post. Review newly enabled providers separately.

WalletConnect begins on user action; wallet/relay services may receive application/network metadata. Native tokens and pending transaction recovery use SecureStore; browser transaction recovery may use sessionStorage. Inspect actual SDK pairing persistence before promising memory-only storage. Never collect seed phrases, private keys or recovery words.

## Retention, privacy and deletion

Document picker, camera and export flows can create temporary files. Originals may contain EXIF or other user metadata; metadata stripping has not been certified. Test private-media caches, OS backups, shared files and cleanup on devices.

Settings implement privacy, data export and password-confirmed deletion. Deletion coordinates live shutdown; when a provider cannot confirm required shutdown, the API may reject deletion rather than leave an orphan broadcast. Test retries and disclose operational delays. Storage cleanup has retry handling; verify deployed workers, backup retention and deletion monitoring.

Deletion does not erase independently held wallet assets, immutable chain records, replicated IPFS data, downloads or copies already posted elsewhere. Warn users before public publishing/pinning. Document external-platform deletion/revocation and processor rights-request workflows.

Production networking requires HTTPS; development previews may use local HTTP. At-rest encryption, backups, retention and administrator access depend on hosting configuration. No blanket encryption-at-rest or end-to-end-encryption claim is established by the client.

## Complete the platform forms

- Map actual collection to platform categories: photos/videos, audio, user content, identity/contact information, identifiers, interactions and wallet/transaction data where applicable. Evaluate account linkage and tracking under exact platform definitions.
- Include every enabled processor: hosting/database/Redis/media/email, Livepeer, render infrastructure, selected networks, WalletConnect/Reown, IPFS, RPC and monitoring. A proposed hybrid stack is not proof of deployed vendors or their retention.
- Determine optional/required collection from actual flows. Optional camera permission does not make required registration data optional.
- Inspect required-reason APIs and privacy manifests in the final iOS archive. Do not copy guessed reason codes.
- Complete financial/blockchain declarations and export-compliance review separately; privacy labels do not certify payment or UGC compliance.

Use [Apple App Privacy](https://developer.apple.com/app-store/app-privacy-details/) and [Google Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469). No console declaration or agreement was submitted during preparation.
