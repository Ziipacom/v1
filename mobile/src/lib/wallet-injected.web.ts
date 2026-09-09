import type { EVMProvider } from "./wallet-types";
export function injectedWallet(): EVMProvider | undefined {
  const own = (globalThis as unknown as { ethereum?: EVMProvider }).ethereum;
  if (own) return own;
  // Wallet extensions may inject only into the top-level page. The Studio
  // portal is same-origin; never inspect or message an external parent frame.
  try {
    if (window.parent !== window && window.parent.location.origin === window.location.origin)
      return (window.parent as unknown as { ethereum?: EVMProvider }).ethereum;
  } catch { /* Cross-origin embeds cannot use the parent's wallet. */ }
  return undefined;
}
