# Ziipa creator app: implementation and production path

Updated 2026-08-31. The public marketing site remains intact; `/portal` now contains the responsive creator web app. This is a working local product slice, not a production-ready decentralized social network.

## Design reference

The supplied Ziipa Figma frame (`27:36`) and screenshot guide the near-black violet background, original logo, bright purple selection state, circular content categories, large media cards, and mobile bottom navigation. Desktop adds a persistent navigation rail, search, studio tools, and secondary creator panel. The sign-in flow and original public website remain available.

## Working now

| Area | Implemented behavior | Scope |
| --- | --- | --- |
| Discovery | Search title, creator, tags and description; filter video, music/film, games, live, NFTs and stores; move through featured cards | Demo catalogue plus locally published posts, newest local posts first; no popularity or fabricated audience numbers |
| Media | Upload common image/video/audio formats, record camera photos/video, native playback and byte-range responses | 100 MB per file and 1 GB per local account; authenticated delivery; content-type signature checks, not malware scanning |
| Studio | Create and edit drafts, publish locally, move published posts back into drafts | Private drafts are owner-only; published posts and attached media are available to signed-in members of this installation |
| Editing | Five-step flow with playback trim, manual captions, styled text overlays and creator-owned soundtrack settings | Non-destructive settings; no transcoded/exported video, automatic caption generation, licensed commercial music catalogue, or timed multi-caption editor yet |
| Distribution | Select Bluesky, Facebook, Instagram, TikTok, Twitch and YouTube; persist network connection and per-item delivery state; view Ziipa media and jobs in one center | No external post is claimed without provider OAuth and a reviewed delivery adapter; local sample connections never transmit data |
| Remix | Create a new draft linked to a source post | Local attribution pointer; no source copying, on-chain attribution tree, rights determination, or royalty distribution |
| Social | Comments, personal likes and bookmarks | PostgreSQL persistence; no federation or aggregate like counters |
| Custom feeds | Visual AND filters by category, tag, creator text and declared city; live result preview; save and share rules with local members | Rules run over the local discovery catalogue; no geolocation radius, relevance model, reputation score, audio-track matching, feed subscriptions or external feed generator |
| Safety | Personal muted words, creator-name blocks, demo visibility preference | Server filters discovery; not platform-wide moderation or an access-control boundary; no moderation of comments or media content |
| Commerce concepts | Store listing drafts, integer-cent USD display prices, locally published image/video listings | No inventory reservation, shopping cart, orders, checkout, seller onboarding or payouts |
| NFT/live concepts | Category discovery and planning drafts | Publish is blocked for NFT/live drafts because minting and broadcasting are not connected |

The application does not claim that any demo creator is an active user. Images, collection names, and channel concepts are illustrative. The Sintel trailer is the playable sample; stock-photo cards do not masquerade as live video.

## Local data and boundaries

- `creator.py` adds SQLAlchemy models for media, creator items, preferences, feed definitions, and comments. Existing accounts and waitlist data are preserved.
- Media bytes are in ignored `backend/uploads/`; database rows hold opaque UUID identifiers, owners, MIME types and sizes. Do not delete that directory while keeping its database metadata.
- User uploads are served through authenticated FastAPI endpoints, not the frontend public directory. Another member cannot retrieve a draft's private file or modify it. Publishing a post makes its media available to other authenticated members.
- Database row locking prevents concurrent uploads from bypassing account quotas. Locks are nonblocking to avoid stalling the async upload handler.
- All API responses use private/no-store cache headers. Redis still supplies session storage and atomic request limits.
- PostgreSQL JSON stores validated creator settings and rules. An ORM startup `create_all` adds these tables locally; adopt reviewed Alembic migrations before deploying.
- Local published discovery is currently capped at 200 recent records and comments at 100 per item. Replace these bounds with cursor pagination before scaling.
- Replacing an upload keeps the previous file and consumes quota. A reviewed retention/deletion workflow and orphan cleanup job are still needed.
- Test uploads use a temporary directory. Integration tests roll back their database changes and use Redis database 15, leaving real user state in database 0.

## What the reference research confirms

[Skylight's current site](https://skylight.social/) describes AT Protocol identity and social graph portability and existing Bluesky login. Its public homepage does **not** establish every performance or missing-feature claim in the supplied comparison. Treat those claims as product hypotheses until evaluated against the current app and user research.

[AT Protocol OAuth](https://atproto.com/specs/oauth) is a specific OAuth profile, including identity/PDS discovery, PKCE, DPoP and PAR. Use a maintained compatible SDK and validate callback metadata, state and session binding. Do not send Bluesky passwords to Ziipa or replace this with ordinary email login. Ziipa's current local session is not an AT Protocol identity.

[Streamplace](https://stream.place/docs/guides/start-streaming/quick-start/) provides AT Protocol based broadcasting with account authorization, ingest configuration and stream announcements. It is a sensible candidate for the live-video workstream, pending an integration proof of concept. Its [signing documentation](https://docs.stream.place/docs/video-metadata/signing/) describes stream keys and signed segments. Keys must remain secret; never show production ingest keys in public frontend data.

[Livepeer's current documentation](https://docs.livepeer.org/network) describes decentralized video compute and transcoding. Its current landing documentation is operator-focused and directs app builders to further developer resources. Validate a supported application API before committing to a provider. Streamr and Livepeer should not be assumed interchangeable video-transcoding services without separate evaluation.

[Adaptive streaming](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/Setting_up_adaptive_streaming_media_sources) requires segmented media and representations at multiple bitrates. No infrastructure vendor can guarantee zero buffering across all networks/devices. Decentralized object storage is not by itself a latency-optimized HLS/DASH delivery path.

[AT Protocol moderation](https://atproto.com/guides/moderation) provides labels and labeler subscriptions. Personal word filtering is only a local precursor; it is not equivalent to ingesting and enforcing verified labels.

[Stripe Connect](https://docs.stripe.com/connect) is an option for marketplace payment flows. Compare fees, supported countries, business requirements, refund/dispute ownership and account responsibilities before selecting it. The local app intentionally does not collect payment details or move money.

## Production delivery sequence

### 1. Harden the local product into a private beta

Add migrations, email verification/recovery, session rotation, security tests, object storage, quotas/retention, malware/media validation, job queues, observability, deployment secrets, production reverse proxy, backups and restore tests. Add cursor pagination, a media processing state machine and a content-review queue. Define supported devices and browser codec fallbacks. Build an actual automated browser test suite for auth, upload, publish, playback, navigation and responsive layouts.

Acceptance: two users cannot read each other's drafts; retries do not duplicate jobs; worker failures are recoverable; backup restoration preserves account-to-file ownership; moderation and removal work before enabling public uploads.

### 2. Portable identity and content distribution

Add an AT Protocol OAuth client with secure token handling and explicit linking to the existing Ziipa user. Read follows/social graph from the relevant service; build a local app view/index, subscribe to changes, and define lexicons/record mapping. Publish interoperable video records only when their schema and media constraints are supported. Custom game, commerce and NFT records will need their own semantics; not every third-party app will render them automatically.

Acceptance: users can authorize/revoke Ziipa at their PDS, cross-app playback works for supported records, deletion/update events reconcile correctly, identity migration is tested, and failed federation writes are visible and retryable.

### 3. Reliable video and live broadcasting

Queue ingest/transcoding separately from API requests. Produce multiple HLS/DASH renditions, thumbnails, captions and audio variants; use a measured delivery/CDN strategy. Introduce ABR player support and lifecycle management that pauses offscreen media and limits prefetch. Evaluate Livepeer against managed and self-hosted encoders with the same fixture set. Evaluate Streamplace for signed RTMPS/WHIP ingest and WebRTC/HLS playback; add broadcast permissions, game metadata, chat, takedowns and moderation.

Acceptance: measure startup latency, rebuffer ratio, encoding time, failure rate and cost by device/network; verify reconnect and rendition switching. Set evidence-based service targets rather than promising zero stutter. Store private media in revocable storage; do not automatically publish it to immutable/decentralized storage.

### 4. Creative suite

Add a timeline with multiple clips and captions; implement real Duet/Stitch composition; provide explicit attribution and remix permission controls. Evaluate client-side ONNX/WebGPU/WASM models for background removal, transcription and noise suppression, with feature detection and a server fallback. Add worker isolation, cancellation, resource limits and accessibility. Music libraries require actual rights agreements and track/territory/usage metadata; do not ship an unlicensed sound catalogue.

Acceptance: exported media matches preview; jobs cancel and recover; users can correct captions; remix permission and attribution survive publishing; battery/memory use is measured on target devices.

### 5. Marketplace and creator revenue

Implement seller onboarding, product variants/inventory, tagged product shelves, orders and returns. Choose payment rails and wallet/chain support explicitly. Use idempotent payment APIs, signature-verified webhooks, a double-entry ledger and reconciliation. Define creator subscriptions, tips and curator sharing with transparent rules. Smart-contract royalty or attribution trees need a separate specification, audits and consent/revocation handling; do not equate a local `remix_of` pointer with audited settlement.

Acceptance: sandbox transactions reconcile; refunds/disputes work; repeated webhooks cannot duplicate credits; users approve wallet transactions themselves; no private wallet keys are held by Ziipa unless an explicitly reviewed custody model is chosen.

### 6. Feed marketplace and layered safety

Expand local rule definitions into versioned feed generators, allow subscriptions, and make ranking understandable. Add audio identity, author reputation and opt-in location filters using documented signals. Measure feed quality and protect against creator/curator fraud before sharing revenue. Implement verified labeler subscriptions, baseline safety, report queues, appeals and human operations. Precise location must be optional and have clear retention controls.

Acceptance: communities can audit rule versions, swap feeds without losing follows, understand why an item appears, and choose labelers without bypassing platform safety. Revenue and recommendation incentives are reviewed together.

## Decisions still required before production integrations

Deployment domain and environments; AT Protocol app identity; media/streaming provider and region; payout countries/provider; supported wallet chains; music/model licensing; moderation ownership; retention/removal policy; feed ranking and curator revenue rules. No external accounts, paid services, financial transactions, wallets or domain changes were created during this local implementation.
