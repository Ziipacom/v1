export type Chain = {
  id: number;
  name: string;
  currency: string;
  explorer: string;
  confirmations: number;
  deployed: boolean;
  contracts: Record<string, string>;
};
export type WalletConfig = {
  testnet_only: boolean;
  storage: "local_ipfs" | "public_ipfs";
  chains: Chain[];
  inventory_scope: string;
};
export type WalletLink = {
  id: string;
  chain_id: number;
  address: string;
  verified_at: string;
};
export type MetadataRecord = {
  id: string;
  uri: string;
  sha256: string;
  public: boolean;
  document: {
    name: string;
    description: string;
    image?: string;
    animation_url?: string;
    attributes: { trait_type: string; value: string }[];
  };
};
export type TxKind =
  | "mint_nft"
  | "create_token"
  | "send_native"
  | "send_nft"
  | "send_token"
  | "tip";
export type Intent = {
  id: string;
  kind: TxKind;
  chain_id: number;
  transaction: {
    from: string;
    to: string;
    data: string;
    value: string;
    chainId: string;
    gas: string;
  };
  summary: Record<string, string | number>;
  status: "prepared" | "submitted" | "pending" | "confirmed" | "reverted";
  tx_hash: string | null;
  result: {
    confirmations?: number;
    token_id?: string;
    token_address?: string;
    contract?: string;
  };
  created_at: string;
};
export type Balances = {
  address: string;
  chain_id: number;
  block_number: number;
  native_wei: string;
  scope: string;
  nft_total: number;
  collectibles: { token_id: string; contract: string; uri: string }[];
  tokens: {
    address: string;
    symbol: string;
    decimals: number;
    balance: string;
  }[];
};
export type EVMProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

export function units(value: string, decimals = 18, precision = 6) {
  const digits = value.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals
    ? digits.slice(-decimals).slice(0, precision).replace(/0+$/, "")
    : "";
  return whole + (fraction ? "." + fraction : "");
}
export function shortAddress(value: string) {
  return value.length > 16 ? value.slice(0, 6) + "…" + value.slice(-4) : value;
}
