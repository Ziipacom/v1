import { Buffer } from "buffer";
import { Platform } from "react-native";
import { injectedWallet } from "./wallet-injected";
import type { EVMProvider, Intent } from "./wallet-types";
import type UniversalProvider from "@walletconnect/universal-provider";

export const walletConnectConfigured =
  !!process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
const networks: Record<
  number,
  { name: string; rpc: string; explorer?: string }
> = {
  84532: {
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  11155111: {
    name: "Ethereum Sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
  31337: { name: "Ziipa Local", rpc: "http://127.0.0.1:8545" },
};
let universal: UniversalProvider | null = null;
let connection: {
  provider: EVMProvider;
  address: string;
  chainId: number;
  kind: "injected" | "walletconnect";
} | null = null;
const listeners = new Set<() => void>();
const clear = () => {
  connection = null;
  listeners.forEach((fn) => fn());
};
export function observeWallet(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function currentWallet() {
  return connection;
}
export function browserWalletAvailable() {
  return !!injectedWallet();
}

// Pairing keys live only in memory. The external wallet holds all signing keys;
// restart requires reconnecting rather than backing up relay secrets to plain storage.
function ephemeralStorage() {
  const values = new Map<string, unknown>();
  return {
    async getKeys() {
      return [...values.keys()];
    },
    async getEntries<T = unknown>() {
      return [...values.entries()] as [string, T][];
    },
    async getItem<T = unknown>(key: string) {
      return values.get(key) as T | undefined;
    },
    async setItem<T = unknown>(key: string, value: T) {
      values.set(key, value);
    },
    async removeItem(key: string) {
      values.delete(key);
    },
  };
}
async function walletConnect() {
  if (!walletConnectConfigured)
    throw new Error(
      "WalletConnect needs your Reown project ID in the mobile build. A browser wallet can connect without it.",
    );
  if (!universal) {
    const { default: Provider } =
      await import("@walletconnect/universal-provider");
    universal = await Provider.init({
      projectId: process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID,
      logger: "silent",
      telemetryEnabled: false,
      storage: ephemeralStorage(),
      metadata: {
        name: "Ziipa Studio",
        description: "Ziipa creator wallet · test networks only",
        url: process.env.EXPO_PUBLIC_WALLET_ORIGIN || "http://localhost:8082",
        icons: [],
        redirect: { native: __DEV__ ? "ziipa-preview://" : "ziipa://" },
      },
    });
    universal.on("accountsChanged", clear);
    universal.on("chainChanged", clear);
    universal.on("session_delete", clear);
  }
  return universal;
}
export async function disconnectWallet() {
  clear();
  if (universal?.session) await universal.disconnect();
}
export async function cancelPairing() {
  universal?.abortPairingAttempt();
}
export async function connectWallet(
  chainId: number,
  kind: "injected" | "walletconnect",
  onUri: (uri: string) => void,
) {
  if (!networks[chainId] || (!__DEV__ && chainId === 31337))
    throw new Error("Unsupported test network");
  if (chainId === 31337 && Platform.OS !== "web")
    throw new Error(
      "Ziipa Local is for the desktop browser. Select a deployed public test network on a physical phone.",
    );
  clear();
  let provider: EVMProvider;
  let accounts: string[];
  if (kind === "injected") {
    const injected = injectedWallet();
    if (!injected)
      throw new Error(
        "No browser wallet found. Use a wallet-enabled browser or WalletConnect. Never enter a recovery phrase into Ziipa.",
      );
    provider = injected;
    accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + chainId.toString(16) }],
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      const net = networks[chainId];
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x" + chainId.toString(16),
            chainName: net.name,
            nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [net.rpc],
            ...(net.explorer ? { blockExplorerUrls: [net.explorer] } : {}),
          },
        ],
      });
    }
    if (Number(await provider.request({ method: "eth_chainId" })) !== chainId)
      throw new Error("Switch your wallet to the selected test network.");
    provider.removeListener?.("accountsChanged", clear);
    provider.on?.("accountsChanged", clear);
    provider.removeListener?.("chainChanged", clear);
    provider.on?.("chainChanged", clear);
    provider.removeListener?.("disconnect", clear);
    provider.on?.("disconnect", clear);
  } else {
    const wc = await walletConnect();
    if (wc.session) await wc.disconnect();
    wc.on("display_uri", onUri);
    try {
      const session = await wc.connect({
        namespaces: {
          eip155: {
            chains: [`eip155:${chainId}`],
            methods: ["personal_sign", "eth_sendTransaction"],
            events: ["accountsChanged", "chainChanged"],
            rpcMap: { [chainId]: networks[chainId].rpc },
          },
        },
      });
      accounts = (session?.namespaces.eip155?.accounts || [])
        .filter((a) => a.startsWith(`eip155:${chainId}:`))
        .map((a) => a.split(":")[2]);
      provider = { request: (args) => wc.request(args, `eip155:${chainId}`) };
    } finally {
      wc.removeListener("display_uri", onUri);
      onUri("");
    }
  }
  if (!accounts[0] || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0]))
    throw new Error("The wallet did not approve an account on this network.");
  connection = { provider, address: accounts[0], chainId, kind };
  return { address: accounts[0], chainId };
}
async function checkedConnection(address: string, chainId: number) {
  const c = connection;
  if (
    !c ||
    c.chainId !== chainId ||
    c.address.toLowerCase() !== address.toLowerCase()
  )
    throw new Error("Reconnect the wallet used for this request.");
  if (c.kind === "injected") {
    const accounts = (await c.provider.request({
      method: "eth_accounts",
    })) as string[];
    const chain = Number(await c.provider.request({ method: "eth_chainId" }));
    if (
      chain !== chainId ||
      accounts[0]?.toLowerCase() !== address.toLowerCase()
    ) {
      clear();
      throw new Error(
        "Wallet account or network changed. Reconnect before continuing.",
      );
    }
  } else if (
    !universal?.session?.namespaces.eip155?.accounts.some(
      (a) => a.toLowerCase() === `eip155:${chainId}:${address}`.toLowerCase(),
    )
  ) {
    clear();
    throw new Error("Wallet session changed. Reconnect before continuing.");
  }
  return c.provider;
}
export async function signWalletProof(
  message: string,
  address: string,
  chainId: number,
) {
  const p = await checkedConnection(address, chainId);
  return (await p.request({
    method: "personal_sign",
    params: ["0x" + Buffer.from(message, "utf8").toString("hex"), address],
  })) as string;
}
export async function sendWalletTransaction(intent: Intent) {
  if (intent.status !== "prepared" || intent.tx_hash)
    throw new Error(
      "This transaction has already been submitted. Refresh its status instead.",
    );
  const p = await checkedConnection(intent.transaction.from, intent.chain_id);
  const hash = await p.request({
    method: "eth_sendTransaction",
    params: [intent.transaction],
  });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error(
      "Wallet did not return a transaction hash. Check wallet activity before retrying.",
    );
  return hash;
}
