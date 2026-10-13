# Ziipa media rewards

This local build adds an interaction rewards wallet to the shared Android/iOS and
web Studio. It adapts the idea of a rewards wallet to media participation. It does
not integrate Snaplii accounts, licensed payments, gift cards or their private API.
No new paid service is required.

## Earned points

Actual saved likes, saves and qualified comments on another creator's published
uploaded media earn noncash Ziipa points. Defaults are 1 for a like, 2 for a save
and 3 for a qualifying comment. Comments need at least 20 trimmed characters and
10 letters or numbers. Samples, drafts, private posts, self-interactions, views
and unverified external interactions do not qualify.

The server records the interaction and award in one transaction. A permanent
account/post/action marker prevents repeating an interaction to earn again.
Removing likes/saves, hiding media, blocking access or removing qualifying
comments reverses points. Re-adding an interaction does not replenish its award.
Daily and lifetime limits count gross awards, so reversals cannot refill budgets.
Defaults cap each member at 100 points/day across programs, the platform at
50,000 points/day and the baseline program at 1,000,000 lifetime points.

Points have no cash value, exchange rate or automatic token conversion. They
remain separate from verified blockchain balances. Basic deduplication and caps
do not prove one human per account; meaningful fraud review is still necessary
before any cash or mainnet program.

## Creator token programs

The four-step Token Engine can carry a media-rewards configuration through real
token creation and confirmation. A program links only to an owned, confirmed
token-creation receipt and verified creator wallet. New programs start paused.
The creator reviews its name, eligible action rates, daily cap and finite point
budget before enabling it. Old interactions are not retroactively awarded.

Programs can also track points without a token. Only a confirmed token program
can prepare the separate funded distribution flow:

1. The creator reviews an exact ERC20 allowance, then a separate pool deposit.
   Wallet signatures stay in the external wallet; Ziipa holds no signing key.
2. Ziipa prepares an allocation snapshot from still-eligible, unallocated program
   points and recipient wallets verified on that same test network. The creator
   explicitly chooses a token amount per point for that distribution. This is a
   creator's test-token allocation, not a platform-guaranteed point exchange rate.
3. The creator reviews recipients, token amounts and the total, then signs the
   Merkle-root publication. It requires an actually funded pool. Publication is
   irreversible and reserves those tokens for the listed recipients.
4. Each recipient reviews and signs a proof-bound claim. The backend matches the
   exact transaction, canonical receipt, confirmations and contract event before
   marking it confirmed. One recipient cannot claim twice from a batch.

Unused, unreserved tokens can be withdrawn by the creator's wallet after review.
Reserved allocations cannot be withdrawn or cancelled. Preparing a publication
seals the application snapshot because that transaction could be signed or
broadcast later. Point reversals never undo an already published blockchain
allocation. Keep proof backups for long-lived distributions.

## Assistant and privacy

The optional Assistant permission `rewards.read` allows it to inspect only the
member's recorded noncash point totals. It does not receive wallet keys or
addresses and cannot fund, publish, mint, withdraw or claim automatically. Money
movement always uses the wallet's separate transaction review.

Account export includes rewards and distribution history. Account deletion
removes private ledger and transaction history and unsealed drafts. Sealed or
published proof snapshots retain only the public chain data needed to honor
irreversible allocations; account references and private creator names are
removed. Blockchain/IPFS records cannot be erased by deleting a Ziipa account.

## Runtime and deployment

Apply additive migration `20261012_0005`, deploy API and shared Studio together,
and compile the contracts with the pinned OpenZeppelin dependency. The rewards
module is a separate registry entry whose deployed code hash is verified before
every transaction. Mainnet is disabled by the existing chain allowlist.

For an existing local chain, `node scripts/deploy-rewards-local.mjs` in `contracts`
adds only the rewards module and preserves existing tokens/NFTs. The normal local
deployment script creates a fresh complete deployment; do not use it to update
an established local registry. No public deployment is implied by changing code
or saving provider settings.

The contract and receipt tests are implementation checks, not an independent
security audit. Base Sepolia deployment, funded public pools, store acceptance
and production fraud controls remain separate release work.

The floating Studio menu also now collapses with Close, or web hover over Close,
and reopens with Menu or the header menu button. The media feed and bottom dock
stay mounted during collapse.
