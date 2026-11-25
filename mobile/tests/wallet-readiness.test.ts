import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWalletNetwork,
  mintSetupIssue,
} from "../src/lib/wallet-readiness.ts";
import type { WalletConfig } from "../src/lib/wallet-types.ts";

test("testnet wallet works on both beta platforms, never mainnet or phone loopback", () => {
  for (const platform of ["ios", "android", "web"]) {
    for (const chain of [84532, 11155111])
      assert.doesNotThrow(() => assertWalletNetwork(chain, false, platform));
    for (const chain of [1, 8453, 137, 31337])
      assert.throws(() => assertWalletNetwork(chain, false, platform));
  }
  assert.throws(() => assertWalletNetwork(31337, true, "ios"));
  assert.doesNotThrow(() => assertWalletNetwork(31337, true, "web"));
});

test("mint readiness reflects actual per-kind contracts and all supported public storage modes", () => {
  const config = {
    testnet_only: true,
    storage: "pinata_ipfs",
    inventory_scope: "test",
    chains: [
      {
        id: 84532,
        name: "Base Sepolia",
        currency: "ETH",
        explorer: "https://sepolia.basescan.org",
        confirmations: 2,
        contracts: { collectibles: "0x" + "1".repeat(40) },
        deployed: false,
      },
    ],
  } as WalletConfig;
  assert.equal(mintSetupIssue(config, 84532, "mint_nft"), "");
  assert.match(
    mintSetupIssue(config, 84532, "create_token"),
    /Minting is unavailable on this network/,
  );
  assert.match(
    mintSetupIssue(config, 11155111, "mint_nft"),
    /Minting is unavailable on this network/,
  );
  assert.match(
    mintSetupIssue({ ...config, storage: "local_ipfs" }, 84532, "mint_nft"),
    /public media storage/,
  );
  assert.match(
    mintSetupIssue({ ...config, testnet_only: false }, 84532, "mint_nft"),
    /Minting is unavailable/,
  );
  assert.match(mintSetupIssue(null, 84532, "mint_nft"), /Checking/);
});
