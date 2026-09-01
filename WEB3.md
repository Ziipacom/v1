# Ziipa Studio Web3 implementation

Implemented locally on 2026-08-31. This is a **tested development/testnet implementation, not a production launch or an audited financial system**. No live wallet, public-network contract, app store, or external pinning account was used during development.

## What works

| Area | App | Backend / chain |
| --- | --- | --- |
| Figma wallet | Token Engine → Protocol → Connection → Metadata & Mint; original dark/purple UI and Studio dock | Explicit network configuration and deployment status |
| Wallet connection | Injected EVM browser wallet; WalletConnect QR/URI pairing on native and web | Five-minute, single-use, account/domain/chain-bound signed ownership challenge; persistent verified links; unlink |
| Storage | Upload owned image/audio/video, select private Studio media, or supply an existing `ipfs://` URI; explicit publication consent | Media ownership checks, real Kubo content-addressed pins, deterministic JSON metadata, SHA-256 hash, idempotent metadata requests and account quotas |
| NFT mint | Royalty setting, full review, external wallet signing | OpenZeppelin ERC-721 enumerable collectibles + ERC-2981 royalty information; immutable URI; self-minting; reentrancy protection |
| Creator tokens | Name, symbol, fixed supply, metadata | ERC-20 factory; 18 decimals; supply issued once to creator; no subsequent minting/admin privileges |
| Digital economy | Receive QR, native/creator-token/NFT transfers, creator tips with optional curator split | Unsigned simulated transaction requests; atomic native-currency payouts; zero platform tip fee; exact receipt/transaction matching |
| Wallet sync | Real test ETH balance, collectible/token inventory, metadata library, transaction history | Chain-ID and deployed-code-hash checks; current ownership reads; bounded inventory; confirmations and reorg-block checks |
| Recovery | Save broadcast hash before API verification; refresh pending status without signing again | Persist prepared/submitted/pending/confirmed/reverted states; prevent double-credit and hash reuse |
| Studio integration | Save privately, then “Mint this media” carries owned media into Wallet | Publication and minting remain separate actions; sample artwork is never silently minted |

The asset list covers **the configured Ziipa collection and creator tokens issued by this account and tracked in Ziipa**. It is not an all-chain wallet indexer. Up to 20 collectibles and 50 issued token contracts are read per sync; the API accepts an NFT offset. Imported third-party tokens, Solana, Hedera, smart-contract wallets/ERC-1271, exchange/swaps, subscriptions, royalties enforcement by marketplaces, sales/auction escrow, fiat on/off-ramps, and public marketplace indexing are not implemented.

EVM and IPFS provide decentralized asset and storage primitives. Ziipa account authentication, creator content indexing, metadata history and transaction coordination still use **FastAPI, PostgreSQL and Redis**. AT Protocol federation is not implemented. Do not describe the whole app as fully decentralized yet.

## Local setup

From `ziipa/`, start PostgreSQL/Redis normally, then the offline IPFS profile:

```powershell
docker compose up -d postgres redis
docker compose --profile web3 up -d ipfs
```

Kubo API: `http://127.0.0.1:56001`; local gateway: `http://127.0.0.1:58080/ipfs/<CID>`. Both bind to loopback. **The container runs offline**, so test files are pinned locally without publishing user media to peers. Storage survives container restarts in `ziipa_ipfs_data`. This is not public availability, redundancy, or a production retention policy. Never expose Kubo's administrative API to the internet.

In `ziipa/contracts/`:

```powershell
npm.cmd ci
npm.cmd run compile
npm.cmd run node
```

Keep the local node running. In another terminal in that folder:

```powershell
npm.cmd run deploy:local
npm.cmd test
```

The node only binds `127.0.0.1:8545`, uses chain 31337 and disposable, publicly known development accounts. **Never send real funds to these accounts or reuse their keys.** Deployments are written to `backend/.local/web3-deployments.json`; restart/deploy again after resetting the chain. The local deployment script refuses other chains. Do not reset a chain while preserving a production transaction index.

In `ziipa/backend/`:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:WEB3_ENABLE_LOCAL='true'
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8018
```

Run `npm.cmd run preview` in `ziipa/mobile/` and open `http://localhost:8082/preview.html`. Open Studio → Wallet. Sign into a local Ziipa account to use storage and transaction APIs. Browser sessions stay in memory and reset on reload; sample changes remain local. The API permits the explicit `MOBILE_WEB_ORIGIN` and `FRONTEND_ORIGIN`, not wildcard origins.

For actual browser-wallet signing, use the app's root URL in a wallet-enabled browser. The in-app browser may not expose an injected wallet. Alternatively configure WalletConnect. Physical phones cannot reach a desktop loopback RPC; use the configured public staging/testnet environment for native testing.

## Connecting native wallets and a public testnet

1. Create an owner-controlled Reown project, configure the actual application domain, and set `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` and `EXPO_PUBLIC_WALLET_ORIGIN`. Use a development client for the added native modules. The project ID is public; seed phrases/private keys/pinning credentials must never appear in `EXPO_PUBLIC_*`.
2. Set matching `WEB3_PUBLIC_ORIGIN` and `MOBILE_WEB_ORIGIN` for the deployed app; configure protected HTTPS API infrastructure and appropriate RPC providers. Base Sepolia (84532) and Ethereum Sepolia (11155111) are allowlisted. Mainnet has no enabling switch.
3. Review/audit the contracts. `node scripts/prepare-deployment.mjs 84532` in `contracts/` creates an unsigned, reviewable deployment plan; it does not broadcast. An owner must deploy using their own wallet and test gas. Verify all deployed code, publish verified contract source, and create the registry below from actual deployment receipts/code. No keys belong on the Ziipa API.
4. Host Kubo securely with public peer connectivity and a reviewed moderation/retention policy or provide a protected Kubo-compatible pinning service. Arrange replication/backup and verify every minted CID resolves independently. Set `IPFS_PUBLIC=true` only when this is true. Public-testnet minting fails closed while storage is configured as offline/local.
5. Set `WEB3_REGISTRY` to a reviewed registry path and keep `WEB3_ENABLE_LOCAL=false` on hosted servers. A registry entry is not a deployment: the backend verifies live bytecode hashes before contract operations.

Registry shape (fill from actual deployments; do not paste placeholder values):

```json
{
  "84532": {
    "collectibles": { "address": "<deployed ERC-721>", "code_hash": "<keccak256 of runtime bytecode>" },
    "factory": { "address": "<deployed ERC-20 factory>", "code_hash": "<keccak256 of runtime bytecode>" },
    "tips": { "address": "<deployed tipping contract>", "code_hash": "<keccak256 of runtime bytecode>" }
  }
}
```

WalletConnect pairing keys live in memory and reconnect after process restart. Native Ziipa login tokens remain in SecureStore. Wallet changes invalidate the app's signing connection; every transaction checks the active address/network. The wallet displays final fees and obtains user approval. The API encodes and simulates transactions but never signs or sends them.

## Tests and limits

```powershell
# With local node, deployments, Kubo, PostgreSQL and Redis running:
cd backend
.\.venv\Scripts\python.exe -m pytest -q test_api.py test_web3.py
cd ../contracts
npm.cmd test
cd ../mobile
npm.cmd run typecheck
npm.cmd test
npm.cmd run doctor
npm.cmd run export
```

The API tests use rollback-only PostgreSQL transactions and dedicated Redis database 15, generated wallets, and a generated 1-pixel fixture. Real transactions execute only on chain 31337. These checks do not validate hardware-wallet behavior, WalletConnect relay access, real iOS/Android handoff, network-specific RPC reliability, store billing compliance, or resistance to all contract attacks.

Known production work: migrations (local startup uses create_all), worker-based receipt rechecks/replacement transaction handling, durable replicated storage, pin cleanup/retention and abuse controls, monitoring/rate and quota sizing, broader asset discovery, public deployment/source verification, contract audit, recovery/device QA, and account recovery. A dropped/replaced transaction may require checking the wallet and operator intervention; never blindly re-sign. Failed or slow RPC/IPFS calls display errors and do not fabricate success.

Metadata publication requires explicit consent. Deleting a Ziipa account removes server wallet links, metadata index and history, but cannot erase blockchain history, external wallet assets or IPFS copies. Local pins are retained; do not market account deletion as erasing them.

The mobile package has a narrow postinstall patch for Metro's OneDrive `Dirent` misclassification on Windows. It uses `lstat` only for ambiguous directory entries, preserving actual symlinks. Review/remove the patch when upgrading Metro after an upstream fix. It does not change app behavior.

## Release gates

The existing store checklist still applies. `ZIIPA_WEB3_REVIEWED=true` is an additional owner acknowledgment only after contract/security review, real-wallet device testing, public storage verification, data disclosures and current store-policy/billing review. Setting a flag does not make a release compliant. No APK/AAB/IPA was signed or uploaded as part of this implementation.

Review [Apple's current App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and [Google Play's blockchain-based content requirements](https://support.google.com/googleplay/android-developer/answer/13607354?hl=en) before enabling any real-value transactions or tokenized goods. No production subscriptions, digital-goods billing bypass or gambling mechanics are implemented.

Technical references used: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [Reown Universal Provider](https://docs.reown.com/advanced/providers/universal), [ERC-4361 message format](https://eips.ethereum.org/EIPS/eip-4361), [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/erc721), [Kubo RPC](https://docs.ipfs.tech/reference/kubo/rpc/), [Base connection details](https://docs.base.org/get-started/connect-to-base), and [Hardhat](https://hardhat.org/docs/getting-started).
