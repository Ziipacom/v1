# Ziipa hybrid deployment

This repository is prepared for the demo and closed-beta stack:

| Layer | Provider | Ziipa configuration |
| --- | --- | --- |
| Website and portal | Cloudflare Workers | `frontend`, custom domains `ziipa.com` and `www.ziipa.com` |
| API | Render | free Docker web service from `render.yaml`, custom domain `api.ziipa.com` |
| PostgreSQL | Neon | pooled TLS connection in `DATABASE_URL` |
| Sessions and limits | Upstash Redis | TLS Redis connection in `REDIS_URL` |
| Private creator media | Cloudflare R2 | signed PUT and signed GET adapters |
| NFT media and metadata | Pinata | server-only JWT in `PINATA_JWT` |
| Demo contracts | Base Sepolia | chain `84532`, client-signed transactions |

No provider secret belongs in Git, the frontend build, the Expo app, a screenshot, or a support ticket.

## 1. Neon

Create a project and copy its **pooled** connection string. The hostname should contain `-pooler` and the URL should retain `sslmode=require&channel_binding=require`. Store the complete value as the Render environment variable `DATABASE_URL`.

## 2. Upstash

Create a Redis database in the same broad region as the Render service. Copy the TLS Redis URL shown in the console (the `rediss://default:...` value, not the REST token) into the Render environment variable `REDIS_URL`. Ziipa uses Redis transactions, sets, expirations, and Lua rate-limit operations.

## 3. Cloudflare R2

Create the private bucket `ziipa-media`. Do not enable public development URLs. Apply [infrastructure/r2-cors.json](infrastructure/r2-cors.json):

```sh
cd frontend
npx wrangler r2 bucket cors set ziipa-media --file ../infrastructure/r2-cors.json
```

Create an R2 S3 API token with **Object Read & Write** permission scoped only to `ziipa-media`. Record its access key, secret key, and the endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` as Render environment variables. R2 upload links expire after 15 minutes; authorized playback links expire after five minutes.

## 4. Pinata

Create a Pinata JWT with pinning permissions and store it as the Render environment variable `PINATA_JWT`. Creator media remains in R2 for ordinary playback. Ziipa sends a creator-approved asset and its canonical metadata to Pinata only when the user starts the NFT metadata flow.

## 5. Account email and monitoring

Verify `accounts@ziipa.com` (or a sending domain) with Resend and store the API key as `RESEND_API_KEY`. Create a Sentry FastAPI project and store its DSN as `SENTRY_DSN`. Sentry is configured without default personally identifying request data. The API also emits request ID, route, status, and duration logs and exposes dependency readiness at `/api/health`.

## 6. Render API service

Apply `render.yaml` from `Ziipacom/v1` on `main`. It creates only the free `ziipa-api` Docker web service. The container runs database migrations before starting FastAPI and uses `GET /api/health` for its health check. Render's free instance sleeps after 15 minutes without inbound traffic, so the first request can take about one minute.

Set these plain environment values:

```text
ENVIRONMENT=demo
FRONTEND_ORIGIN=https://ziipa.com,https://www.ziipa.com
MOBILE_WEB_ORIGIN=https://app.ziipa.com
API_PUBLIC_ORIGIN=https://api.ziipa.com
PUBLIC_APP_URL=https://ziipa.com
SECURE_COOKIES=true
REQUIRE_EMAIL_VERIFICATION=true
ENABLE_DEMO_CATALOG=false
MEDIA_STORAGE_BACKEND=r2
R2_BUCKET_NAME=ziipa-media
WEB3_ENABLE_LOCAL=false
WEB3_BASE_RPC=https://sepolia.base.org
WEB3_PUBLIC_ORIGIN=https://app.ziipa.com
IPFS_PUBLIC=false
```

Set these secret environment values when Render prompts for them:

```text
DATABASE_URL=<Neon pooled TLS URL>
REDIS_URL=<Upstash TLS Redis URL>
R2_ENDPOINT_URL=<Cloudflare R2 S3 endpoint>
R2_ACCESS_KEY_ID=<bucket-scoped access key>
R2_SECRET_ACCESS_KEY=<bucket-scoped secret key>
PINATA_JWT=<pinning-only Pinata JWT>
RESEND_API_KEY=<sending-only Resend key>
SENTRY_DSN=<FastAPI project DSN>
WEB3_REGISTRY_JSON=<reviewed Base Sepolia deployment registry>
```

Attach `api.ziipa.com` to the Render service, then add the exact CNAME target Render displays at the DNS provider. Wait for Render TLS validation before switching clients to the domain.

## 7. Cloudflare website and portal

In Cloudflare Workers Builds, connect `Ziipacom/v1`, choose `frontend` as the root directory, use `npm ci && npm run build` as the build command, and use `npx wrangler deploy --config dist/server/wrangler.json` as the deploy command. Add the non-secret build variable:

```text
VITE_API_ORIGIN=https://api.ziipa.com
```

Attach `ziipa.com` and `www.ziipa.com` after the generated `workers.dev` preview passes login, upload, portal, deletion, and password-reset tests.

## 8. Base Sepolia

The workflow `.github/workflows/deploy-base-sepolia.yml` is manual and testnet-only. Create the protected GitHub environment `base-sepolia`, add `BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY` and optionally `BASE_SEPOLIA_RPC`, fund that isolated wallet with faucet ETH, and manually run the workflow. Download the generated registry artifact, review its addresses on BaseScan, and store the JSON as the Render environment variable `WEB3_REGISTRY_JSON`.

The API never stores user wallet keys and never signs user mints, tokens, transfers, or tips. It builds validated unsigned intents; the connected user wallet displays and signs each transaction.

## 9. Mobile builds

`mobile/eas.json` sets `EXPO_PUBLIC_API_URL=https://api.ziipa.com` for preview and store profiles. Session tokens use iOS Keychain or Android encrypted storage. Before submission, fill the verified legal URLs and EAS project identity described in `mobile/store/RELEASE.md`, create signed builds, and test registration, verification, recovery, upload, privacy export, account deletion, wallet signing, and offline/expired-session behavior on physical iOS and Android devices.

## Launch gates

- Keep registration invite-only or rate-limited during the free demo.
- Set R2 lifecycle rules for abandoned upload objects and monitor the 1 GB per-account application quota.
- Configure Render, Neon, Upstash, R2, Pinata, Resend, and Sentry usage alerts.
- Upgrade before removing beta limits. Base Sepolia assets have no monetary value.
- Complete platform OAuth app review before enabling direct publishing to TikTok, Instagram, Facebook, Twitch, YouTube, or Bluesky.
