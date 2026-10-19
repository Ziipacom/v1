# Ziipa live, private clips and notifications — 19 October 2026

Mobile and web portal now share Recordings and Notifications screens. Opt-in
signed Livepeer callbacks feed an owned private recording importer and bounded
FFmpeg excerpt queue. Clips remain private drafts until reviewed for distribution.
Optional session-bound device notifications cover reminders, recording completion
and completed campaigns, with encrypted registrations and durable delivery
receipts. No arbitrary agent messaging, automatic public broadcast or automatic
clip publication is enabled.

Chrome's normal `/portal` flow now opens the authenticated shared Studio as a
full-page same-origin application, avoiding the embedded frame loading failure.
The website cookie still supplies authentication; no bearer token is exposed.
The optional `?layout=frame` view retains recovery controls.

Apply migrations through `20261019_0011`, rebuild the shared Studio and restart
API/workflow/renderer from the same release. Hosted recording/push flags remain
off until provider and real-device acceptance. The local review has browser-push
keys and workers available; no device is automatically enrolled. Livepeer owner
sign-in and an existing CORS-disabled server key are verified. With explicit owner
approval, that key is now encrypted for the Windows owner in protected local
AppData settings outside OneDrive/Git, and is passed only to the API and recording
workflow. A real authenticated read returned HTTP 200;
no streams or webhooks were created. The signed public webhook still requires
the new API deployment: its public route currently returns HTTP 404.
Native push needs a new signed binary with EAS/APNs/FCM configuration. No paid
service, public broadcast, real-device push or public deployment was performed.
See [live/recordings/push operation](backend/LIVE-RECORDINGS-PUSH.md).

## Platform versions and creator calendar

The shared mobile/portal Studio prepares actual original, portrait, square and
landscape video versions, selects an approved version per destination and retains
exact file digests and separate delivery receipts. Only the selected Ziipa version
becomes a Ziipa post; other versions remain private campaign derivatives. The
source draft is not replaced. All selected versions require review.

The private Calendar adds IANA timezone schedules, bounded daily/weekly repeats,
daylight-saving gap/fold handling, durable in-app reminders, private `.ics` export
and linked-stream preflight. Campaign dates remain controlled by their own
approval. Calendar events never create provider resources, start camera capture or
enable a public broadcast. Optional push reminders and signed recording-to-clips
automation now have separate consent and provider settings, described above.

Apply migrations through `20261019_0011`, rebuild the shared Studio and run the
renderer and workflow process from the same release. Local review enables
`CREATION_CAMPAIGN_ENABLED`, `OS_CALENDAR_ENABLED` and `OS_WORKFLOW_ENABLED`.
New hosted flags remain false until deployment acceptance. No paid scheduler or
new service was added. See [CREATION-WORKFLOWS.md](CREATION-WORKFLOWS.md) and
[RELEASE-READINESS.md](RELEASE-READINESS.md) for operation and measured acceptance.

## Earlier Agent and private inference — 13 October 2026

The shared portal/mobile Media OS now has an **Agent** tab for durable, opt-in
autonomous private tasks. A real local API → worker → authenticated inference
gateway → Ollama/Qwen3 1.7B acceptance task created a project and its linked goal
with three unchecked steps, then completed. Stored records and step receipts were
verified; retrying the same queue request returned the same task. No public post,
wallet transaction, invitation or arbitrary code was executed.

Autonomy is deliberately permission-scoped. Each account starts disabled with no
grants. Effective tools must be granted in both Assistant and Agent, and are
rechecked before every step. Durable receipts, idempotent requests, leases,
interruption recovery, pause/cancel and finite daily/runtime/model-call budgets
limit work. Public publishing, wallet signing/spending, deletion, shell access and
permission changes remain user-controlled. Small-model planning can still be
wrong; blocked tasks retain completed private changes for review.

The API, agent, workflow and rendering workers, private Ollama service and
authenticated gateway are running locally. The website/shared Studio production
build passes. Native ARM64 Compose/systemd packages, protected-secret preflight,
normal/small model profiles and synthetic model acceptance are documented in
[AGENT-DEPLOYMENT.md](AGENT-DEPLOYMENT.md). The separate inference image contains
no database, media-storage, email, publishing or wallet credentials. Its root
Docker build context is explicitly allowlisted; the full API uses `backend/`.

Final backend acceptance passes **555 tests**, with two explicit opt-in resource
checks skipped. **54 mobile tests**, TypeScript, **13 contract tests** and **10
website tests** pass. Unprivileged, read-only Linux images also passed offline
gateway authentication/process-health checks and API/worker/migration imports.

**This new release has not been publicly deployed.** Oracle owner sign-in and
working SSH, native free-host memory/capacity/model acceptance, GitHub write
access and the earlier approved Neon credential rotation remain operational
gates. The small free profile is for a controlled demo/closed beta, not an
unrestricted public launch. No paid model fallback or paid worker was added.

On this Windows review machine, PostgreSQL uses port **54329** because a Windows
reserved range blocks 55439. The existing Docker volume/data was retained.
Set `ZIIPA_POSTGRES_PORT=54329` for Compose and use that port in the local
`DATABASE_URL`; the repository's historical default remains 55439.

## Earlier Media Rewards and Personal Media OS — 12 October 2026

The shared portal/mobile Studio now includes private media organization, projects,
editable memory, goals, reviewed Assistant tools, durable workflows, rights and
a creator ledger. See [MEDIA-OS.md](MEDIA-OS.md) for privacy and the free runtime
setup. This new release is locally built and tested; it has not been publicly
deployed or included in a new store binary.

## Local Media Rewards and collapsible menu acceptance

The shared mobile and portal Wallet now includes a Media Rewards step in creator
token creation, paused reward programs, bounded interaction-point budgets, private
history and separate creator-funded testnet distributions. Points accrue only from
eligible persisted likes, saves and qualified comments; they have no cash value or
automatic token conversion. Funding, publishing immutable allocations, claiming
tokens and withdrawing unused funds each require explicit wallet review. See
[MEDIA-REWARDS.md](MEDIA-REWARDS.md) for the rules and implementation boundaries.

An actual local HTTP/EVM fixture earned **12 noncash points** from qualified media
interactions: six Ziipa baseline points and six creator-program points. It approved
and deposited **1 ZMR**, published an immutable allocation, verified the recipient's
**0.6 ZMR** claim, and withdrew the unused **0.4 ZMR**. These were local test tokens,
not a payment or a public-chain deployment. The Studio menu now hides on a Close
click or web hover; the right-side Menu button reopens it while the feed stays
mounted.

Final local verification passed **462 backend tests** with two opt-in resource
checks skipped, **54 mobile tests** and TypeScript, **13 contract tests**, and
**10 website tests**. The final shared Studio export and website build passed.
No commit, push, public deployment, new APK, mainnet transaction or paid service
was created in this update. Public testnet deployment and independent contract
and fraud review remain required before release. Earlier deployment notes below
describe prior work and do not establish acceptance of this new local build.

## Earlier website and deployment notes

The free-only stack uses Cloudflare Workers, the existing Render Free API, Neon,
Upstash, private R2, Pinata and Base Sepolia. Oracle Always Free hosts the last
recorded renderer release; its separate Media OS workflow package is newly
prepared here. Today's cloud state and this new release still need deployment
acceptance; local tests do not establish hosted readiness.
See [FREE-TIER-DEPLOYMENT.md](FREE-TIER-DEPLOYMENT.md) for the active plan and
remaining account/acceptance gates. The provider setup is also documented in
[HYBRID-DEPLOYMENT.md](HYBRID-DEPLOYMENT.md) for the provider setup, secret map,
custom domains, testnet deployment, monitoring, and launch gates. Do not import
the separate paid Render worker Blueprint under the current free-only instruction.

A new Ziipa website and member portal, in a standalone folder. The visual direction draws on the existing site's Web3 / beta waitlist positioning; all new marketing copy is a proposed direction, not a claim that wallet or metaverse features exist.

## Open locally

- Website: http://localhost:5178/
- Member portal: http://localhost:5178/portal
- API documentation: http://127.0.0.1:8018/docs
- Service health: http://127.0.0.1:8018/api/health

Use `localhost:5178` for the frontend (rather than the numeric IP) so it matches the configured allowed origin. Create your own account in the portal; no default credentials are seeded. Use test credentials only.

## Stack

- React + TypeScript, Vinext / Vite, shadcn UI primitives, Lucide icons.
- FastAPI with validated requests and SQLAlchemy / psycopg.
- PostgreSQL 17 for accounts, waitlist records, creator posts, comments, feeds and preferences.
- Redis 7 for expiring server-side sessions and atomic rate limits.
- Argon2 password hashes; opaque session tokens in HttpOnly, SameSite cookies.
- Docker Compose with project-specific volumes and loopback-only ports.

## Restart

Docker Desktop must be running. From this folder:

```powershell
docker compose up -d
```

In one terminal:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8018 --reload
```

In a second terminal:

```powershell
cd frontend
npm.cmd run dev
```

Or run `./start-local.ps1` to start both servers in hidden processes with logs under `.local/`; use `./stop-local.ps1` to stop only those script-started processes. Do not use the script while the same servers are already running.

## Fresh installation

Requires Node 22.13+ (Node 24 LTS recommended), Python 3.12+, and Docker Desktop.

```powershell
cd frontend
npm.cmd ci
cd ../backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
Copy-Item .env.example .env
cd ..
docker compose up -d
```

The installed Python environment uses the bundled Codex Python runtime on this machine. Recreate `.venv` using your own Python installation when moving this folder to another machine.

## Verification

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
cd ../frontend
npm.cmd run build
npx.cmd tsc --noEmit
npm.cmd audit
```

Integration tests require running PostgreSQL and Redis. Tests roll back database writes and reserve Redis database 15 for test rate limits and sessions; the application uses database 0. Do not point tests at a production service.

## Data and local services

PostgreSQL: `127.0.0.1:55439`, database/user `ziipa`, development password `ziipa_local`. Redis: `127.0.0.1:56389`. These credentials are deliberately local-only. Docker volumes preserve data across restarts. `docker compose stop` stops services without deleting data. No other project's services are altered.

The frontend forwards `/api` to FastAPI on port 8018 during development. No email is sent; waitlist signup saves a local database record. Account creation does not automatically join the beta waitlist. Browser storage is not used for credentials or authoritative data.

## Before public deployment

Creation Campaigns now connect saved Studio videos to private preparation,
reviewed transcripts/captions, scheduled approval and separate distribution
receipts through the shared mobile/portal UI. See
[CREATION-WORKFLOWS.md](CREATION-WORKFLOWS.md) for setup, provider boundaries and
the remaining Media OS implementation sequence. New hosted flags remain off by
default; local acceptance does not establish a cloud deployment or store release.

The provider adapters, signed uploads, versioned database baseline, email verification, password recovery, privacy controls, account export/deletion, session revocation, request logging, optional Sentry monitoring, and testnet wallet flows are implemented. External provider accounts, secrets, DNS records, production policy review, store signing identities, social-network app approvals, and funded Base Sepolia deployment still require operator-controlled setup. Follow the launch gates in `HYBRID-DEPLOYMENT.md`; do not treat a free-tier demo as an unrestricted production launch.

## Native iOS and Android app

The separate `mobile/` project now contains a React Native / Expo app based on the portal and Figma design. It connects to the same API with encrypted native bearer sessions and includes discovery, native playback, uploads, studio, feeds, comments, saved items, reporting/blocking, and account deletion. See [mobile/README.md](mobile/README.md) for local development and [mobile/store/RELEASE.md](mobile/store/RELEASE.md) for the remaining signed-build and store requirements. It has not been uploaded to either store.

Restart the backend after this update. New API tables are added without replacing existing accounts. `MODERATOR_EMAILS` explicitly allowlists safety operators; no existing user was promoted. `/account-deletion` provides the local outside-app deletion flow and must be deployed with the production API before it is listed in the stores.

## Creator web app

The portal now opens a responsive creator workspace based on the supplied Ziipa Figma design. It includes media discovery, a studio, local uploads/publication, manual caption and trim previews, comments, bookmarks, custom feed rules with local sharing, and personal content filters. Demo content is explicitly labeled; only the sample film and uploaded audio/video are playable. Store listings are local concepts with no checkout; live streams and NFT collections remain drafts until providers are integrated.

Local media is stored in `backend/uploads/` (ignored by Git). Hosted creator media uses a private R2 bucket through short-lived signed upload and authorized download URLs, while PostgreSQL keeps ownership metadata. The API limits uploads to 100 MB each and 1 GB per account; the desktop portal keeps its more conservative 50 MB picker limit. Publishing makes media visible only when the creator's profile and post privacy allow it.

See [CREATOR-PRODUCTION.md](CREATOR-PRODUCTION.md) for the exact implementation boundaries, verified integration references, and production delivery sequence. The automated backend suite covers auth, private draft/media access, local publication, shared feed rules, filter persistence, upload rejection and range requests. Browser visual and end-to-end tests have not been run in this iteration.

## Design assets

The landing page includes an animated app hero, feature and capability sections, an interactive discovery/editor/feed walkthrough, an FAQ, and the database-backed waitlist. Both animated previews have manual scene and pause controls; autoplay pauses offscreen and in background tabs, and starts disabled for reduced-motion preferences. Demo reactions, captions, and filters only change the illustrative walkthrough, not portal data.

iOS and Android buttons appear in desktop navigation, mobile navigation, the signup section, and footer. They open a clear coming-soon dialog with web-app and waitlist links because no verified app-store URLs have been supplied. Connect the real listings in `frontend/components/landing/landing-page.tsx` when available. The landing redesign was checked with TypeScript, a production build, and local HTTP route checks; browser interaction and visual QA have not been performed.

The website now uses the original Ziipa logo and gradient background extracted from the live site, along with locally hosted Barlow fonts. Asset provenance is recorded in `frontend/public/brand/SOURCES.md`. Social metadata also uses the original logo. The earlier generated `og.png` is retained on disk but is no longer referenced by the UI or metadata.
