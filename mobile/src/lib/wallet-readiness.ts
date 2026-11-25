import type { Intent, WalletConfig } from "./wallet-types";

// Public Reown application identity, not a signing key or secret. The same
// default keeps portal exports and native beta builds on Ziipa's project.
export const publicWalletConnectProjectId = "9c65a916dd054ea5033d0cc926ddab8e";

/** Shared by beta and web: there is deliberately no mainnet switch. */
export function assertWalletNetwork(
  chainId: number,
  development: boolean,
  platform: string,
) {
  if (chainId === 84532 || chainId === 11155111) return;
  if (chainId === 31337 && development && platform === "web") return;
  throw new Error("Select Base Sepolia or Ethereum Sepolia.");
}

export function mintSetupIssue(
  config: WalletConfig | null,
  chainId: number,
  kind: "mint_nft" | "create_token",
) {
  if (!config) return "Checking minting availability…";
  if (config.testnet_only !== true) return "Minting is unavailable.";
  const chain = config.chains.find((row) => row.id === chainId);
  const contract = kind === "mint_nft" ? "collectibles" : "factory";
  const address = chain?.contracts?.[contract] || "";
  if (
    !chain ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    /^0x0{40}$/i.test(address)
  )
    return "Minting is unavailable on this network. Try another network.";
  if (
    chainId !== 31337 &&
    config.storage !== "public_ipfs" &&
    config.storage !== "pinata_ipfs"
  )
    return "Minting is unavailable without public media storage.";
  return "";
}

/** Check the actual transaction network before an external wallet can sign it. */
export function assertWalletIntent(
  intent: Intent,
  development: boolean,
  platform: string,
) {
  assertWalletNetwork(intent.chain_id, development, platform);
  if (Number(intent.transaction.chainId) !== intent.chain_id)
    throw new Error(
      "The transaction network does not match your wallet’s selected network.",
    );
}
