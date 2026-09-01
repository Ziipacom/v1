# Ziipa hybrid deployment

This repository is prepared for the demo and closed-beta stack:

| Layer | Provider | Ziipa configuration |
| --- | --- | --- |
| Website and portal | Cloudflare Workers | `frontend`, custom domains `ziipa.com` and `www.ziipa.com` |
| API | Koyeb | `backend/Dockerfile`, custom domain `api.ziipa.com` |
| PostgreSQL | Neon | pooled TLS connection in `DATABASE_URL` |
| Sessions and limits | Upstash Redis | TLS Redis connection in `REDIS_URL` |
| Private creator media | Cloudflare R2 | signed PUT and signed GET adapters |
| NFT media and metadata | Pinata | server-only JWT in `PINATA_JWT` |
| Demo contracts | Base Sepolia | chain `84532`, client-signed transactions |

No provider secret belongs in Git, the frontend build, the Expo app, a screenshot, or a support ticket.

## 1. Neon

Create a project and copy its **pooled** connection string. The hostname should contain `-pooler` and the URL should retain `sslmode=require&channel_binding=require`. Store the complete value as the Koyeb secret `neon-database-url`.

## 2. Upstash

Create a Redis database in the same broad region as the Koyeb service. Copy the TLS Redis URL shown in the console (the `rediss://default:...` value, not the REST token) into the Koyeb secret `upstash-redis-url`. Ziipa uses Redis transactions, sets, expirations, and Lua rate-limit operations.

## 3. Cloudflare R2

Create the private bucket `ziipa-media`. Do not enable public development URLs. Apply [infrastructure/r2-cors.json](infrastructure/r2-cors.json):

```sh
cd frontend
npx wrangler r2 bucket cors set ziipa-media --file ../infrastructure/r2-cors.json
```

Create an R2 S3 API token with **Object Read & Write** permission scoped only to `ziipa-media`. Record its access key, secret key, and the endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` as Koyeb secrets. R2 upload links expire after 15 minutes; authorized playback links expire after five minutes.

## 4. Pinata

Create a Pinata JWT with pinning permissions and store it as the Koyeb secret `pinata-jwt`. Creator media remains in R2 for ordinary playback. Ziipa sends a creator-approved asset and its canonical metadata to Pinata only when the user starts the NFT metadata flow.

## 5. Account email and monitoring

Verify `accounts@ziipa.com` (or a sending domain) with Resend and store the API key as `resend-api-key`. Create a Sentry FastAPI project and store its DSN as `sentry-dsn`. Sentry is configured without default personally identifying request data. The API also emits request ID, route, status, and duration logs and exposes dependency readiness at `/api/health`.

## 6. Koyeb API service

Connect `Ziipacom/v1`, select `main`, choose the Dockerfile builder, set the work directory to `backend`, and expose HTTP port `8000` at `/`. Configure an HTTP health check for `GET /api/health`. Use one free instance for the demo.

Set these plain environment values:

```text
PORT=8000
ENVIRONMENT=demo
RELEASE={{ KOYEB_GIT_SHA }}
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

Reference Koyeb secrets for:

```text
DATABASE_URL={{ secret.neon-database-url }}
REDIS_URL={{ secret.upstash-redis-url }}
R2_ENDPOINT_URL={{ secret.r2-endpoint-url }}
R2_ACCESS_KEY_ID={{ secret.r2-access-key-id }}
R2_SECRET_ACCESS_KEY={{ secret.r2-secret-access-key }}
PINATA_JWT={{ secret.pinata-jwt }}
RESEND_API_KEY={{ secret.resend-api-key }}
SENTRY_DSN={{ secret.sentry-dsn }}
WEB3_REGISTRY_JSON={{ secret.base-sepolia-registry }}
```

Attach `api.ziipa.com` to the Koyeb App, then add the exact CNAME target Koyeb displays at the DNS provider. Wait for Koyeb TLS validation before switching clients to the domain.

## 7. Cloudflare website and portal

In Cloudflare Workers Builds, connect `Ziipacom/v1`, choose `frontend` as the root directory, use `npm ci && npm run build` as the build command, and use `npx wrangler deploy --config dist/server/wrangler.json` as the deploy command. Add the non-secret build variable:

```text
VITE_API_ORIGIN=https://api.ziipa.com
```

Attach `ziipa.com` and `www.ziipa.com` after the generated `workers.dev` preview passes login, upload, portal, deletion, and password-reset tests.

## 8. Base Sepolia

The workflow `.github/workflows/deploy-base-sepolia.yml` is manual and testnet-only. Create the protected GitHub environment `base-sepolia`, add `BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY` and optionally `BASE_SEPOLIA_RPC`, fund that isolated wallet with faucet ETH, and manually run the workflow. Download the generated registry artifact, review its addresses on BaseScan, and store the JSON as Koyeb secret `base-sepolia-registry`.

The API never stores user wallet keys and never signs user mints, tokens, transfers, or tips. It builds validated unsigned intents; the connected user wallet displays and signs each transaction.

## 9. Mobile builds

`mobile/eas.json` sets `EXPO_PUBLIC_API_URL=https://api.ziipa.com` for preview and store profiles. Session tokens use iOS Keychain or Android encrypted storage. Before submission, fill the verified legal URLs and EAS project identity described in `mobile/store/RELEASE.md`, create signed builds, and test registration, verification, recovery, upload, privacy export, account deletion, wallet signing, and offline/expired-session behavior on physical iOS and Android devices.

## Launch gates

- Keep registration invite-only or rate-limited during the free demo.
- Set R2 lifecycle rules for abandoned upload objects and monitor the 1 GB per-account application quota.
- Configure Koyeb, Neon, Upstash, R2, Pinata, Resend, and Sentry usage alerts.
- Upgrade before removing beta limits. Base Sepolia assets have no monetary value.
- Complete platform OAuth app review before enabling direct publishing to TikTok, Instagram, Facebook, Twitch, YouTube, or Bluesky.
