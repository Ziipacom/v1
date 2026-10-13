import type { WalletLink } from "./wallet-types";

export type RewardToken = {
  intent_id: string;
  chain_id: number;
  address: string;
  symbol: string;
  name: string;
  wallet_id: string;
  wallet_address: string;
};
export type RewardProgram = {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  point_budget: number;
  points_issued: number;
  budget_remaining: number;
  per_user_daily_cap: number;
  rates: { like: number; save: number; comment: number };
  token: RewardToken | null;
  created_at: string;
  updated_at: string;
};
export type RewardsWallet = {
  unit: "Ziipa points";
  cash_value: null;
  balance: number;
  earned_total: number;
  reversed_total: number;
  by_program: {
    program_id: string | null;
    program_key: string;
    name: string;
    balance: number;
    earned_total: number;
    reversed_total: number;
    token: RewardToken | null;
  }[];
  history: {
    id: string;
    kind: string;
    points: number;
    interaction_kind: string;
    item_id: string | null;
    program_id: string | null;
    program_name: string;
    created_at: string;
  }[];
  wallets: WalletLink[];
  redemption: { available: boolean; reason: string };
};
export type RewardsConfig = {
  enabled: boolean;
  unit: string;
  cash_value: null;
  testnet_only: boolean;
  platform_rates: { like: number; save: number; comment: number };
  per_user_daily_cap: number;
  earning_rules: string[];
};
export type RewardBatch = {
  id: string;
  program_id: string;
  status: string;
  chain_id: number;
  token_address: string;
  symbol: string;
  program_name: string;
  total_token_amount: string;
  participant_count: number;
  allocations: { recipient: string; points: number; amount_tokens: string }[];
};
export type RewardClaim = {
  id: string;
  batch_id: string;
  program_name: string;
  chain_id: number;
  token_address: string;
  symbol: string;
  points: number;
  amount_tokens: string;
  recipient: string;
  status: "ready" | "claimed" | "awaiting_publish";
};
export type RewardDraft = {
  enabled: boolean;
  name: string;
  point_budget: string;
  per_user_daily_cap: string;
  like_points: string;
  save_points: string;
  comment_points: string;
};
export const emptyRewardDraft = (): RewardDraft => ({
  enabled: false,
  name: "",
  point_budget: "5000",
  per_user_daily_cap: "25",
  like_points: "1",
  save_points: "2",
  comment_points: "3",
});

function integer(value: string, label: string, min: number, max: number) {
  if (!/^(0|[1-9]\d*)$/.test(value.trim()))
    throw new Error(`${label} must be a whole number.`);
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return parsed;
}
export function rewardRules(draft: RewardDraft) {
  const name = draft.name.trim();
  if (!name || name.length > 100)
    throw new Error("Name your reward program using 1–100 characters.");
  const point_budget = integer(draft.point_budget, "Point budget", 1, 100000);
  const per_user_daily_cap = integer(
    draft.per_user_daily_cap,
    "Daily points per member",
    1,
    100,
  );
  const rates = {
    like_points: integer(draft.like_points, "Like points", 0, 20),
    save_points: integer(draft.save_points, "Save points", 0, 20),
    comment_points: integer(draft.comment_points, "Comment points", 0, 20),
  };
  if (!Object.values(rates).some((rate) => rate > 0))
    throw new Error("Choose at least one interaction that earns points.");
  return { name, point_budget, per_user_daily_cap, ...rates };
}
export function rewardDraftFromProgram(program: RewardProgram): RewardDraft {
  return {
    enabled: program.enabled,
    name: program.name,
    point_budget: String(program.point_budget),
    per_user_daily_cap: String(program.per_user_daily_cap),
    like_points: String(program.rates.like),
    save_points: String(program.rates.save),
    comment_points: String(program.rates.comment),
  };
}
export function rewardPoints(value: number) {
  return Number.isSafeInteger(value) ? value.toLocaleString("en-US") : "—";
}
