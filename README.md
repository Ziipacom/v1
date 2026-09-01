# Ziipa local website and portal

The complete monorepo is now configured for Render through `render.yaml`. See
[RENDER.md](RENDER.md) for the Blueprint resources, first-deploy steps, costs,
custom-domain setup, persistent storage, contract handoff, and mobile release
boundaries.

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

This is a local foundation, not a production launch. No changes were made to the live ziipa.com website or domain.

- Choose production hosting for the Python API, PostgreSQL, Redis, and frontend; the current development API proxy is not a production reverse proxy.
- Replace local credentials, configure production origins and HTTPS, and enable `SECURE_COOKIES=true`.
- Add reviewed schema migrations (local startup currently creates initial tables), backups, monitoring, retention/deletion policies, and operational secrets management.
- Add email verification, password reset, and appropriate account abuse protections. Review privacy/terms and branding before publishing.
- Replace localhost metadata URLs with the verified deployment origin.
- Web3 wallets, transactions, NFT minting, federated feeds, broadcasting, automatic AI editing, and beta invitation emails are not implemented. Portal account details are currently read-only.

## Native iOS and Android app

The separate `mobile/` project now contains a React Native / Expo app based on the portal and Figma design. It connects to the same API with encrypted native bearer sessions and includes discovery, native playback, uploads, studio, feeds, comments, saved items, reporting/blocking, and account deletion. See [mobile/README.md](mobile/README.md) for local development and [mobile/store/RELEASE.md](mobile/store/RELEASE.md) for the remaining signed-build and store requirements. It has not been uploaded to either store.

Restart the backend after this update. New API tables are added without replacing existing accounts. `MODERATOR_EMAILS` explicitly allowlists safety operators; no existing user was promoted. `/account-deletion` provides the local outside-app deletion flow and must be deployed with the production API before it is listed in the stores.

## Creator web app

The portal now opens a responsive creator workspace based on the supplied Ziipa Figma design. It includes media discovery, a studio, local uploads/publication, manual caption and trim previews, comments, bookmarks, custom feed rules with local sharing, and personal content filters. Demo content is explicitly labeled; only the sample film and uploaded audio/video are playable. Store listings are local concepts with no checkout; live streams and NFT collections remain drafts until providers are integrated.

Media is stored in `backend/uploads/` (ignored by Git), with owner metadata in PostgreSQL. Keep files and database backups together. The API limits uploads to 100 MB each and 1 GB per local account; the existing desktop portal keeps its more conservative 50 MB picker limit. Media is protected by the API; publishing makes it visible to other signed-in local users.

See [CREATOR-PRODUCTION.md](CREATOR-PRODUCTION.md) for the exact implementation boundaries, verified integration references, and production delivery sequence. The automated backend suite covers auth, private draft/media access, local publication, shared feed rules, filter persistence, upload rejection and range requests. Browser visual and end-to-end tests have not been run in this iteration.

## Design assets

The landing page includes an animated app hero, feature and capability sections, an interactive discovery/editor/feed walkthrough, an FAQ, and the database-backed waitlist. Both animated previews have manual scene and pause controls; autoplay pauses offscreen and in background tabs, and starts disabled for reduced-motion preferences. Demo reactions, captions, and filters only change the illustrative walkthrough, not portal data.

iOS and Android buttons appear in desktop navigation, mobile navigation, the signup section, and footer. They open a clear coming-soon dialog with web-app and waitlist links because no verified app-store URLs have been supplied. Connect the real listings in `frontend/components/landing/landing-page.tsx` when available. The landing redesign was checked with TypeScript, a production build, and local HTTP route checks; browser interaction and visual QA have not been performed.

The website now uses the original Ziipa logo and gradient background extracted from the live site, along with locally hosted Barlow fonts. Asset provenance is recorded in `frontend/public/brand/SOURCES.md`. Social metadata also uses the original logo. The earlier generated `og.png` is retained on disk but is no longer referenced by the UI or metadata.
