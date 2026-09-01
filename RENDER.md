# Render deployment

The root `render.yaml` is a single Blueprint for the Ziipa monorepo. It creates:

- `ziipa-v1-web`: the website and `/portal`, with a same-origin API proxy.
- `ziipa-v1-api`: FastAPI with an HTTP readiness check and persistent uploads.
- `ziipa-v1-mobile`: a hosted Expo web preview with the same API proxy.
- `ziipa-v1-db`: private PostgreSQL 17.
- `ziipa-v1-cache`: private persistent Render Key Value for sessions and limits.
- `ziipa-v1-ipfs`: a private Kubo node with persistent pins.

The Blueprint deliberately uses paid persistent plans. Render shows the exact
monthly estimate before creation; review it before applying the Blueprint. No
Render resources are created merely by committing this file.

## First deployment

1. In Render, choose **New → Blueprint** and connect `Ziipacom/v1`.
2. Select the repository-root `render.yaml` and review every planned resource.
3. Supply `MODERATOR_EMAILS` when prompted, or leave it empty if no moderation
   account is ready. Use a comma-separated list of verified account emails.
4. Apply the Blueprint and wait for `ziipa-v1-api` to become healthy before
   reviewing the website or mobile preview.
5. Confirm these endpoints:
   - `https://ziipa-v1-api.onrender.com/api/health`
   - `https://ziipa-v1-web.onrender.com/`
   - `https://ziipa-v1-web.onrender.com/portal`
   - `https://ziipa-v1-mobile.onrender.com/`

Render subdomains are derived from service names. If Render assigns a different
subdomain, update `FRONTEND_ORIGIN`, `MOBILE_WEB_ORIGIN`, and
`WEB3_PUBLIC_ORIGIN` on the API service to the exact HTTPS origins. The two web
servers talk to the API over Render's private network; browsers still see a
same-origin `/api` route, so portal session cookies remain secure.

For `ziipa.com`, add the domain to `ziipa-v1-web`, complete Render's DNS setup,
then retain both `https://ziipa.com` and `https://www.ziipa.com` in
`FRONTEND_ORIGIN`. Give the native app a stable public API domain before store
builds; do not make an app-store binary depend on a temporary service URL.

## Data and recovery

PostgreSQL, Key Value, uploaded creator media, and IPFS pins use persistent
storage. Backups are still an operator responsibility. A disk prevents loss on
ordinary deploys but is not a substitute for tested database backups, media
replication, retention rules, or disaster recovery.

The first deployment runs `backend/render_migrate.py`, which creates the current
schema idempotently. Add reviewed, versioned migrations before the first
incompatible schema change. Keep application and database backups coordinated
when media records change.

`IPFS_PUBLIC=false` is intentional. The private Kubo API lets the backend create
and retain real CIDs, but public-testnet minting stays disabled until operators
verify peer reachability, independent CID resolution, replication, moderation,
retention, and backups. Never expose the Kubo administrative API publicly.

## Contracts and Web3

Render hosts the API that reads chain state and prepares unsigned transactions;
it does not deploy contracts and must never receive a seed phrase or private
key. Before enabling testnet minting:

1. Audit the Solidity contracts and rerun `npm test` in `contracts/`.
2. Generate the unsigned Base Sepolia plan with
   `node scripts/prepare-deployment.mjs 84532`.
3. Review and sign deployments with an owner-controlled wallet outside Render.
4. Verify source and runtime bytecode on the explorer.
5. Add the verified address/code-hash registry as a Render secret file, set
   `WEB3_REGISTRY` to its absolute path, and redeploy the API.
6. Set `IPFS_PUBLIC=true` only after the storage checks above pass.

Base Sepolia and Ethereum Sepolia are the only hosted chains allowed by the
application. Mainnet remains disabled. Production RPC endpoints can be added as
Render secrets with `WEB3_BASE_RPC` and `WEB3_SEPOLIA_RPC`.

## Mobile releases

Render deploys the browser preview, not signed iOS or Android binaries. Native
builds use EAS and require the owner-controlled Expo, Apple, Google, legal,
support, WalletConnect, and signing configuration listed in
`mobile/store/RELEASE.md`. Point `EXPO_PUBLIC_API_URL` at the stable HTTPS API
origin for EAS builds. Keep demos and concepts disabled for production builds.

Do not enable unfinished social-provider publishing, mainnet transactions, or
store submission by changing flags alone. Provider review, contract review,
physical-device QA, moderation operations, privacy disclosures, and app-store
review remain release gates.
