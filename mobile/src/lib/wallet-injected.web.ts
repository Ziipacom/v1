import type { EVMProvider } from "./wallet-types";
export function injectedWallet(): EVMProvider | undefined {
  return (globalThis as unknown as { ethereum?: EVMProvider }).ethereum;
}
