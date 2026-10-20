import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Check,
  Gift,
  Heart,
  Bookmark,
  MessageCircle,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { Action, Notice } from "./ui";
import { color, font, styles, themedStyles, themeValue } from "../theme";
import { useZiipa } from "../provider";
import { ApiError } from "../lib/api";
import {
  authorizationHeaders,
  portalMode,
  validateOrigin,
} from "../lib/config";
import { shortAddress } from "../lib/wallet-types";
import type { Intent, WalletLink } from "../lib/wallet-types";
import {
  rewardDraftFromProgram,
  rewardPoints,
  rewardRules,
  type RewardDraft,
  type RewardProgram,
  type RewardsWallet,
  type RewardBatch,
  type RewardClaim,
  type RewardsConfig,
} from "../lib/rewards-types";

export function RewardRuleFields({
  value,
  onChange,
  disabled = false,
}: {
  value: RewardDraft;
  onChange: (value: RewardDraft) => void;
  disabled?: boolean;
}) {
  const change = (key: keyof RewardDraft, next: string) =>
    onChange({ ...value, [key]: next });
  return (
    <View style={{ gap: 14 }}>
      <RewardField
        label="Reward program name"
        value={value.name}
        onChangeText={(next) => change("name", next)}
        maxLength={100}
        editable={!disabled}
      />
      <View style={s.ruleRow}>
        {(
          [
            ["like_points", "Like", Heart],
            ["save_points", "Save", Bookmark],
            ["comment_points", "Qualified comment", MessageCircle],
          ] as const
        ).map(([key, title, Icon]) => (
          <View key={key} style={s.rule}>
            <Icon size={19} color={color.lime} />
            <Text style={s.micro}>{title}</Text>
            <TextInput
              accessibilityLabel={`${title} points`}
              style={[s.input, { textAlign: "center", width: "100%" }]}
              value={value[key]}
              onChangeText={(next) => change(key, next)}
              keyboardType="number-pad"
              maxLength={2}
              editable={!disabled}
            />
          </View>
        ))}
      </View>
      <RewardField
        label="Total point budget"
        value={value.point_budget}
        onChangeText={(next) => change("point_budget", next)}
        keyboardType="number-pad"
        maxLength={6}
        editable={!disabled}
      />
      <RewardField
        label="Daily points per member"
        value={value.per_user_daily_cap}
        onChangeText={(next) => change("per_user_daily_cap", next)}
        keyboardType="number-pad"
        maxLength={3}
        editable={!disabled}
      />
      <Text style={s.hint}>
        Whole points only. Use 0 to exclude an interaction. Rewards apply to
        eligible public Ziipa media; self-interactions, repeat toggles, samples
        and unavailable media do not earn points. Removing an interaction
        reverses its award.
      </Text>
    </View>
  );
}

async function patchProgram<T>(
  id: string,
  token: string,
  body: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `${validateOrigin()}/api/rewards/programs/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          ...authorizationHeaders(token),
          "Content-Type": "application/json",
        },
        credentials: portalMode ? "same-origin" : "omit",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify(body),
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        typeof result?.detail === "string"
          ? result.detail
          : "The reward program was not updated.",
        response.status,
      );
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}

export function MediaRewards({
  tokenHistory,
  initialDraft,
  confirmedToken,
  activeWallet,
  connected,
  onConnect,
  onNewToken,
  onReviewIntent,
}: {
  tokenHistory: Intent[];
  initialDraft: RewardDraft;
  confirmedToken: Intent | null;
  activeWallet: WalletLink | null;
  connected: boolean;
  onConnect: () => void;
  onNewToken: () => void;
  onReviewIntent: (intent: Intent) => void;
}) {
  const { session, api, forgetSession } = useZiipa();
  const [wallet, setWallet] = useState<RewardsWallet | null>(null);
  const [config, setConfig] = useState<RewardsConfig | null>(null);
  const [programs, setPrograms] = useState<RewardProgram[]>([]);
  const [draft, setDraft] = useState<RewardDraft>(() => ({
    ...initialDraft,
    enabled: false,
  }));
  const [tokenId, setTokenId] = useState(confirmedToken?.id || "");
  const [editing, setEditing] = useState<RewardProgram | null>(null);
  const [showForm, setShowForm] = useState(
    !!confirmedToken && initialDraft.enabled,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [claims, setClaims] = useState<RewardClaim[]>([]);
  const [batches, setBatches] = useState<RewardBatch[]>([]);
  const [fundProgram, setFundProgram] = useState<RewardProgram | null>(null);
  const [fundAmount, setFundAmount] = useState("");
  const [conversion, setConversion] = useState("");
  const [pool, setPool] = useState<{
    program_id: string;
    available_token_amount: string;
    reserved_token_amount: string;
  } | null>(null);
  const owner = useRef<string | null>(null);
  const generation = useRef(0);
  const creationId = useRef(Crypto.randomUUID());
  owner.current = session?.access_token || null;
  const confirmed = tokenHistory.filter(
    (intent) =>
      intent.kind === "create_token" &&
      intent.status === "confirmed" &&
      !!intent.result.token_address,
  );
  const tokens =
    confirmedToken?.kind === "create_token" &&
    confirmedToken.status === "confirmed" &&
    confirmedToken.result.token_address &&
    !confirmed.some((intent) => intent.id === confirmedToken.id)
      ? [confirmedToken, ...confirmed]
      : confirmed;

  async function load() {
    const token = owner.current;
    const current = ++generation.current;
    if (!token) return;
    setLoading(true);
    const [summary, own, allocations] = await Promise.all([
      api<RewardsWallet>("/api/rewards/wallet"),
      api<RewardProgram[]>("/api/rewards/programs"),
      api<RewardClaim[]>("/api/rewards/claims"),
    ]);
    if (owner.current !== token || generation.current !== current) return;
    const [settlements, rules] = await Promise.all([
      api<RewardBatch[]>("/api/rewards/batches"),
      api<RewardsConfig>("/api/rewards/config"),
    ]);
    if (owner.current !== token || generation.current !== current) return;
    setWallet(summary);
    setPrograms(own);
    setClaims(allocations);
    setBatches(settlements);
    setConfig(rules);
    setLoading(false);
  }
  async function run(task: () => Promise<void>) {
    const token = owner.current;
    if (busy || !token) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      if (owner.current === token) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The rewards request was not completed.",
        );
        if (failure instanceof ApiError && failure.status === 401)
          await forgetSession();
      }
    } finally {
      if (owner.current === token) {
        setBusy(false);
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    generation.current++;
    setWallet(null);
    setConfig(null);
    setPrograms([]);
    setEditing(null);
    setError("");
    setNotice("");
    setBusy(false);
    setLoading(false);
    setClaims([]);
    setBatches([]);
    setFundProgram(null);
    setFundAmount("");
    setConversion("");
    setPool(null);
    setDraft({ ...initialDraft, enabled: false });
    setTokenId(confirmedToken?.id || "");
    setShowForm(!!confirmedToken && initialDraft.enabled);
    creationId.current = Crypto.randomUUID();
    if (session) void run(load);
  }, [session?.access_token]);
  useEffect(
    () => () => {
      generation.current++;
      owner.current = null;
    },
    [],
  );
  useEffect(() => {
    if (confirmedToken?.status === "confirmed" && initialDraft.enabled) {
      setDraft({ ...initialDraft, enabled: false });
      setTokenId(confirmedToken.id);
      setEditing(null);
      setShowForm(true);
      creationId.current = Crypto.randomUUID();
    }
  }, [confirmedToken?.id]);

  function begin(program?: RewardProgram) {
    setEditing(program || null);
    setError("");
    setNotice("");
    setDraft(
      program
        ? rewardDraftFromProgram(program)
        : {
            ...initialDraft,
            enabled: false,
            name: initialDraft.name || "Media circle",
          },
    );
    setTokenId(program?.token?.intent_id || confirmedToken?.id || "");
    creationId.current = Crypto.randomUUID();
    setShowForm(true);
  }
  async function save() {
    const token = owner.current;
    if (!token) return;
    const rules = rewardRules(draft);
    if (!editing && tokenId && !tokens.some((intent) => intent.id === tokenId))
      throw new Error(
        "Choose an owned creator token with a confirmed blockchain receipt.",
      );
    if (editing && rules.point_budget < editing.points_issued)
      throw new Error("The budget cannot be lower than points already issued.");
    if (editing) {
      await patchProgram<RewardProgram>(editing.id, token, {
        revision: editing.revision,
        ...rules,
        enabled: draft.enabled,
      });
    } else {
      await api<RewardProgram>("/api/rewards/programs", {
        request_id: creationId.current,
        token_intent_id: tokenId || null,
        ...rules,
        enabled: false,
      });
    }
    if (owner.current !== token) return;
    setShowForm(false);
    setEditing(null);
    setNotice(
      editing
        ? "Program updated. Its recorded awards remain in the history."
        : "Reward program saved paused. Review its rules before you enable it.",
    );
    await load();
  }
  async function toggle(program: RewardProgram) {
    const token = owner.current;
    if (!token) return;
    await patchProgram(program.id, token, {
      revision: program.revision,
      enabled: !program.enabled,
    });
    if (owner.current !== token) return;
    setNotice(
      program.enabled
        ? "Reward program paused. Existing balances are preserved."
        : "Program enabled for eligible interactions on your public Ziipa media.",
    );
    await load();
  }
  function checkedWallet(chainId: number, address?: string) {
    if (!activeWallet || !connected)
      throw new Error(
        "Reconnect your verified wallet before preparing a token transaction.",
      );
    if (activeWallet.chain_id !== chainId)
      throw new Error(`Connect a verified wallet on chain ${chainId}.`);
    if (address && activeWallet.address.toLowerCase() !== address.toLowerCase())
      throw new Error("Reconnect the wallet that owns this reward allocation.");
    return activeWallet;
  }
  async function prepareFunding() {
    if (!fundProgram?.token) return;
    const token = owner.current;
    const verified = checkedWallet(
      fundProgram.token.chain_id,
      fundProgram.token.wallet_address,
    );
    if (
      !/^\d+(\.\d{1,18})?$/.test(fundAmount.trim()) ||
      !/[1-9]/.test(fundAmount)
    )
      throw new Error(
        "Enter a positive token amount with no more than 18 decimals.",
      );
    const prepared = await api<Intent>(
      `/api/rewards/programs/${fundProgram.id}/fund`,
      {
        request_id: Crypto.randomUUID(),
        wallet_id: verified.id,
        amount: fundAmount.trim(),
      },
    );
    if (owner.current !== token) return;
    setNotice(
      prepared.kind === "reward_approve"
        ? "Review the exact token allowance in your wallet. After it confirms, prepare funding again to review the separate deposit."
        : "Deposit prepared for your review. No tokens move until you approve the transaction in your wallet.",
    );
    onReviewIntent(prepared);
  }
  async function readPool() {
    if (!fundProgram?.token) return;
    const token = owner.current;
    const verified = checkedWallet(
      fundProgram.token.chain_id,
      fundProgram.token.wallet_address,
    );
    const result = await api<{
      available_token_amount: string;
      reserved_token_amount: string;
    }>(
      `/api/rewards/programs/${fundProgram.id}/pool?wallet_id=${encodeURIComponent(verified.id)}`,
    );
    if (owner.current !== token) return;
    setPool({ program_id: fundProgram.id, ...result });
  }
  async function prepareWithdrawal() {
    if (!fundProgram?.token) return;
    const token = owner.current;
    const verified = checkedWallet(
      fundProgram.token.chain_id,
      fundProgram.token.wallet_address,
    );
    if (
      !/^\d+(\.\d{1,18})?$/.test(fundAmount.trim()) ||
      !/[1-9]/.test(fundAmount)
    )
      throw new Error(
        "Enter a positive token amount with no more than 18 decimals.",
      );
    const prepared = await api<Intent>(
      `/api/rewards/programs/${fundProgram.id}/withdraw`,
      {
        request_id: Crypto.randomUUID(),
        wallet_id: verified.id,
        amount: fundAmount.trim(),
      },
    );
    if (owner.current !== token) return;
    setNotice(
      "Unused pool withdrawal prepared for your review. Only unreserved tokens can return to your creator wallet; published allocation reservations remain protected.",
    );
    onReviewIntent(prepared);
  }
  async function prepareBatch() {
    if (!fundProgram?.token) return;
    const token = owner.current;
    const verified = checkedWallet(
      fundProgram.token.chain_id,
      fundProgram.token.wallet_address,
    );
    if (
      !/^\d+(\.\d{1,18})?$/.test(conversion.trim()) ||
      !/[1-9]/.test(conversion)
    )
      throw new Error(
        "Enter a positive token amount per point, with up to 18 decimals.",
      );
    const prepared = await api<RewardBatch>(
      `/api/rewards/programs/${fundProgram.id}/batches`,
      {
        request_id: Crypto.randomUUID(),
        wallet_id: verified.id,
        token_amount_per_point: conversion.trim(),
      },
    );
    if (owner.current !== token) return;
    setBatches((previous) => [
      prepared,
      ...previous.filter((item) => item.id !== prepared.id),
    ]);
    setNotice(
      "Allocation draft prepared. Review its recipients, total and irreversible publication before signing.",
    );
  }
  async function preparePublish(batch: RewardBatch) {
    const token = owner.current;
    const program = programs.find((item) => item.id === batch.program_id);
    if (!program?.token)
      throw new Error(
        "Refresh your creator program and its verified token before publishing this allocation.",
      );
    const verified = checkedWallet(
      batch.chain_id,
      program.token.wallet_address,
    );
    const prepared = await api<Intent>(
      `/api/rewards/batches/${batch.id}/publish`,
      { request_id: Crypto.randomUUID(), wallet_id: verified.id },
    );
    if (owner.current !== token) return;
    setBatches((previous) =>
      previous.map((item) =>
        item.id === batch.id ? { ...item, status: "awaiting_publish" } : item,
      ),
    );
    onReviewIntent(prepared);
  }
  async function prepareClaim(claim: RewardClaim) {
    const token = owner.current;
    const verified = checkedWallet(claim.chain_id, claim.recipient);
    const prepared = await api<Intent>(
      `/api/rewards/claims/${claim.id}/prepare`,
      { request_id: Crypto.randomUUID(), wallet_id: verified.id },
    );
    if (owner.current !== token) return;
    onReviewIntent(prepared);
  }

  return (
    <View style={{ gap: 18 }}>
      <View
        style={[s.card, { backgroundColor: themeValue("#21112F", color.accentSoft), borderColor: themeValue("#5D337E", color.border) }]}
      >
        <View style={styles.between}>
          <Text style={s.kicker}>MEDIA REWARDS</Text>
          <Gift size={24} color={color.lime} />
        </View>
        <Text style={s.balance}>
          {wallet ? rewardPoints(wallet.balance) : "—"}
          <Text style={{ fontSize: 17, color: themeValue("#CDB7E5", color.muted) }}> pts</Text>
        </Text>
        <Text style={s.label}>Your attention has a place in Ziipa.</Text>
        <Text style={s.hint}>
          Earn points for eligible likes, saves and meaningful comments on
          Ziipa. Points are an account record, not cash or cryptocurrency, and
          have no promised exchange value.
        </Text>
        {wallet && (
          <View style={s.ruleRow}>
            <Metric title="Earned" value={wallet.earned_total} />
            <Metric title="Reversed" value={wallet.reversed_total} />
          </View>
        )}
        {!session ? (
          <Action title="Sign in to view rewards" onPress={onConnect} />
        ) : (
          <Action
            secondary
            icon={RefreshCw}
            title="Refresh rewards"
            busy={busy || loading}
            onPress={() => void run(load)}
          />
        )}
      </View>
      {error ? <Notice text={error} error /> : null}
      {notice ? <Notice text={notice} /> : null}
      {loading && !wallet ? <ActivityIndicator color={color.lime} /> : null}
      {config && (
        <View style={s.card}>
          <Text style={s.label}>How you earn</Text>
          {!config.enabled && (
            <Notice text="Rewards are currently disabled by this Ziipa environment. Existing records remain available; new interactions will not earn points." />
          )}
          <View style={s.ruleRow}>
            <Metric title="Like" value={config.platform_rates.like} />
            <Metric title="Save" value={config.platform_rates.save} />
            <Metric title="Comment" value={config.platform_rates.comment} />
          </View>
          <Text style={s.hint}>
            Platform daily cap: {config.per_user_daily_cap} points per member.
            Creator programs have their own finite budgets and daily limits.
          </Text>
          {config.earning_rules.map((rule) => (
            <Text style={s.hint} key={rule}>
              {rule}
            </Text>
          ))}
        </View>
      )}
      <View style={s.card}>
        <View style={styles.row}>
          <ShieldCheck color={color.lime} size={21} />
          <Text style={s.label}>Wallet connection</Text>
        </View>
        <Text style={s.hint}>
          {activeWallet
            ? `Ownership verified for ${shortAddress(activeWallet.address)} · chain ${activeWallet.chain_id}. ${connected ? "Wallet connected for reviewed transactions." : "Reconnect to approve any transaction."}`
            : "Points stay in your Ziipa account. Connect and prove ownership of an external wallet before any on-chain redemption."}
        </Text>
        <Text style={s.hint}>
          {wallet?.redemption.reason ||
            "No automatic conversion or spending. Any funded test-network reward requires a separate reviewed wallet transaction."}
        </Text>
        <Action
          secondary
          title={activeWallet ? "Manage wallet connection" : "Connect a wallet"}
          onPress={onConnect}
        />
      </View>
      {!!claims.length && (
        <View style={s.card}>
          <Text style={s.label}>Funded test-network rewards</Text>
          <Text style={s.hint}>
            These are published creator allocations, separate from your point
            balance. Claims go only to the verified recipient wallet and require
            its signature and test-network gas.
          </Text>
          {claims.map((claim) => (
            <View key={claim.id} style={s.program}>
              <View style={styles.between}>
                <Text style={[s.label, { flex: 1 }]}>{claim.program_name}</Text>
                <Text style={s.status}>
                  {claim.status === "claimed"
                    ? "Claim confirmed"
                    : claim.status === "awaiting_publish"
                      ? "Awaiting publication"
                      : "Ready to claim"}
                </Text>
              </View>
              <Text style={s.points}>
                {claim.amount_tokens} {claim.symbol}
              </Text>
              <Text style={s.hint}>
                {rewardPoints(claim.points)} allocated points · chain{" "}
                {claim.chain_id}
              </Text>
              <Text selectable style={s.micro}>
                Recipient {claim.recipient}
              </Text>
              {claim.status === "ready" && (
                <Action
                  title="Review reward claim"
                  busy={busy}
                  onPress={() => void run(() => prepareClaim(claim))}
                />
              )}
            </View>
          ))}
        </View>
      )}
      {!!wallet?.by_program.length && (
        <View style={s.card}>
          <Text style={s.label}>Balances by reward program</Text>
          {wallet.by_program.map((program) => (
            <View key={program.program_key} style={s.receipt}>
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={s.label}>{program.name}</Text>
                <Text style={s.micro}>
                  {program.token
                    ? `${program.token.symbol} · chain ${program.token.chain_id} · token-linked points`
                    : "Ziipa points · no token conversion"}
                </Text>
              </View>
              <Text style={s.points}>{rewardPoints(program.balance)} pts</Text>
            </View>
          ))}
        </View>
      )}
      <View style={s.card}>
        <View style={styles.between}>
          <Text style={s.label}>Creator reward programs</Text>
          <Sparkles size={19} color={themeValue("#C2A0F0", color.purple)} />
        </View>
        <Text style={s.hint}>
          Reward people who interact with your public media. Set a finite point
          budget and a member daily cap. Token-linked programs require your
          completed creator-token transaction.
        </Text>
        {session && !showForm && (
          <Action
            title="Create a reward program"
            disabled={busy}
            onPress={() => begin()}
          />
        )}
        <Action
          secondary
          title="Create a token with Media Rewards"
          onPress={onNewToken}
        />
        {programs.map((program) => (
          <View key={program.id} style={s.program}>
            <View style={styles.between}>
              <Text style={[s.label, { flex: 1 }]}>{program.name}</Text>
              <Text
                style={[
                  s.status,
                  { color: program.enabled ? color.lime : color.muted },
                ]}
              >
                {program.enabled ? "Enabled" : "Paused"}
              </Text>
            </View>
            <Text style={s.hint}>
              {program.token
                ? `${program.token.symbol} · ${shortAddress(program.token.address)} · chain ${program.token.chain_id}`
                : "Ziipa points only"}
            </Text>
            <Text style={s.hint}>
              Like {program.rates.like} · Save {program.rates.save} · Comment{" "}
              {program.rates.comment} pts
            </Text>
            <Text style={s.hint}>
              {rewardPoints(program.budget_remaining)} /{" "}
              {rewardPoints(program.point_budget)} points remaining ·{" "}
              {program.per_user_daily_cap} per member per day
            </Text>
            <Action
              secondary
              title="Review / edit rules"
              disabled={busy}
              onPress={() => begin(program)}
            />
            <Action
              secondary
              icon={program.enabled ? Pause : Play}
              title={
                program.enabled ? "Pause rewards" : "Enable reviewed program"
              }
              busy={busy}
              disabled={!program.enabled && program.budget_remaining <= 0}
              onPress={() => void run(() => toggle(program))}
            />
            {program.token && (
              <Action
                secondary
                title="Fund / allocate test tokens"
                disabled={busy}
                onPress={() => {
                  setFundProgram(program);
                  setFundAmount("");
                  setConversion("");
                  setPool(null);
                  setNotice("");
                  setError("");
                }}
              />
            )}
          </View>
        ))}
        {session && !programs.length && !loading && (
          <Text style={s.hint}>
            No reward programs yet. Creating points does not mint additional
            tokens or grant Ziipa permission to spend your wallet balance.
          </Text>
        )}
      </View>
      {showForm && session && (
        <View style={s.card}>
          <Text style={s.label}>
            {editing ? "Review program rules" : "Prepare a reward program"}
          </Text>
          {!editing && (
            <>
              <Text style={s.micro}>TOKEN CONNECTION</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                <TokenChoice
                  title="Ziipa points only"
                  selected={!tokenId}
                  onPress={() => setTokenId("")}
                />
                {tokens.map((intent) => (
                  <TokenChoice
                    key={intent.id}
                    title={`${String(intent.summary.symbol || "Creator token")} · ${shortAddress(intent.result.token_address!)}`}
                    selected={tokenId === intent.id}
                    onPress={() => setTokenId(intent.id)}
                  />
                ))}
              </ScrollView>
              {tokenId && (
                <Text style={s.hint}>
                  This connects the confirmed creator token to your point
                  program. Funding and reviewed test-network claims are separate
                  transactions; no tokens leave your wallet when this program is
                  saved.
                </Text>
              )}
            </>
          )}
          <RewardRuleFields value={draft} onChange={setDraft} disabled={busy} />
          {editing ? (
            <View style={styles.row}>
              <Switch
                accessibilityLabel="Enable reward program"
                value={draft.enabled}
                disabled={busy}
                onValueChange={(enabled) => setDraft({ ...draft, enabled })}
                trackColor={{ true: color.purple }}
              />
              <Text style={[s.hint, { flex: 1 }]}>
                Enable for future eligible interactions after saving these
                reviewed rules.
              </Text>
            </View>
          ) : (
            <Notice text="A new program starts paused. You can explicitly enable it after reviewing its saved rules." />
          )}
          <Action
            title={editing ? "Save reviewed rules" : "Save paused program"}
            busy={busy}
            onPress={() => void run(save)}
          />
          <Action
            secondary
            title="Cancel"
            disabled={busy}
            onPress={() => {
              setShowForm(false);
              setEditing(null);
            }}
          />
        </View>
      )}
      {fundProgram?.token && (
        <View style={s.card}>
          <Text style={s.label}>{fundProgram.name} · test-token pool</Text>
          <Text style={s.hint}>
            Creator token {fundProgram.token.symbol} · chain{" "}
            {fundProgram.token.chain_id}. The contract holds deposited tokens
            for published allocations; your wallet controls every approval,
            deposit and publication.
          </Text>
          {pool?.program_id === fundProgram.id && (
            <View style={s.program}>
              <Text style={s.hint}>
                Available {pool.available_token_amount}{" "}
                {fundProgram.token.symbol}
              </Text>
              <Text style={s.hint}>
                Reserved {pool.reserved_token_amount} {fundProgram.token.symbol}
              </Text>
              <Text style={s.micro}>
                Read from the test-network reward contract.
              </Text>
            </View>
          )}
          <Action
            secondary
            title="Read token pool balance"
            busy={busy}
            onPress={() => void run(readPool)}
          />
          <RewardField
            label={`Funding / withdrawal amount (${fundProgram.token.symbol})`}
            value={fundAmount}
            onChangeText={setFundAmount}
            keyboardType="decimal-pad"
            editable={!busy}
          />
          <Action
            secondary
            title="Review funding transaction"
            busy={busy}
            onPress={() => void run(prepareFunding)}
          />
          <Text style={s.hint}>
            If token allowance is insufficient, review the exact approval first.
            After it confirms, review funding again to prepare the deposit.
          </Text>
          <Action
            secondary
            title="Review withdrawal of unused pool tokens"
            busy={busy}
            onPress={() => void run(prepareWithdrawal)}
          />
          <Text style={s.hint}>
            You can recover only unused, unreserved tokens to your verified
            creator wallet. Tokens reserved for sealed or published allocations
            cannot be withdrawn. Your wallet must approve the test-network
            transaction.
          </Text>
          <RewardField
            label={`${fundProgram.token.symbol} per eligible point`}
            value={conversion}
            onChangeText={setConversion}
            keyboardType="decimal-pad"
            editable={!busy}
          />
          <Action
            secondary
            title="Prepare allocation draft"
            busy={busy}
            onPress={() => void run(prepareBatch)}
          />
          <Text style={s.hint}>
            A draft uses eligible, unallocated program points and currently
            verified recipient wallets. Preparing a draft does not publish,
            spend or promise a fiat value.
          </Text>
          <Action
            secondary
            title="Close funding form"
            disabled={busy}
            onPress={() => setFundProgram(null)}
          />
        </View>
      )}
      {!!batches.length && (
        <View style={s.card}>
          <Text style={s.label}>Reward allocations</Text>
          {batches.map((batch) => (
            <View style={s.program} key={batch.id}>
              <Text style={s.label}>
                {programs.find((program) => program.id === batch.program_id)
                  ?.name ||
                  batch.program_name ||
                  "Creator rewards"}
              </Text>
              <Text style={s.hint}>
                {batch.status.replaceAll("_", " ")} · {batch.participant_count}{" "}
                recipients · chain {batch.chain_id}
              </Text>
              <Text style={s.points}>
                {batch.total_token_amount} {batch.symbol} total
              </Text>
              {batch.allocations.map((allocation) => (
                <View style={s.receipt} key={allocation.recipient}>
                  <View style={{ flex: 1, gap: 5 }}>
                    <Text selectable style={s.micro}>
                      {allocation.recipient}
                    </Text>
                    <Text style={s.micro}>{allocation.points} points</Text>
                  </View>
                  <Text style={s.hint}>
                    {allocation.amount_tokens} {batch.symbol}
                  </Text>
                </View>
              ))}
              {batch.status === "draft" && (
                <>
                  <Notice text="Preparing a publication seals these recipients, point reservations and token amounts because its unsigned transaction could be broadcast later. It cannot be cancelled or edited after preparation. Review every allocation before continuing." />
                  <Action
                    title="Review irreversible publication"
                    busy={busy}
                    onPress={() => void run(() => preparePublish(batch))}
                  />
                </>
              )}
              {batch.status === "awaiting_publish" && (
                <Text style={s.hint}>
                  Allocation sealed; publication awaits a confirmed wallet
                  transaction. Use Wallet Activity to review or verify the
                  prepared transaction.
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      <View style={s.card}>
        <Text style={s.label}>Reward activity</Text>
        {wallet?.history.map((entry) => (
          <View key={entry.id} style={s.receipt}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.label}>
                {entry.interaction_kind.replaceAll("_", " ")}
              </Text>
              <Text style={s.micro}>
                {entry.program_name} · {entry.kind}
              </Text>
              <Text style={s.micro}>
                {new Date(entry.created_at).toLocaleString()}
              </Text>
            </View>
            <Text
              style={[
                s.points,
                { color: entry.points >= 0 ? color.lime : themeValue("#FFB9CA", color.danger) },
              ]}
            >
              {entry.points > 0 ? "+" : ""}
              {rewardPoints(entry.points)} pts
            </Text>
          </View>
        ))}
        {!wallet?.history.length && (
          <Text style={s.hint}>
            Your server-recorded awards and reversals will appear here.
            Refreshing this screen does not earn points.
          </Text>
        )}
      </View>
      <Text style={s.hint}>
        Ziipa Assistant may help inspect rewards and prepare a plan. Connecting,
        funding or redeeming tokens always requires your review and your wallet
        signature. No background agent can spend your funds.
      </Text>
    </View>
  );
}
function Metric({ title, value }: { title: string; value: number }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={s.points}>{rewardPoints(value)} pts</Text>
      <Text style={s.micro}>{title}</Text>
    </View>
  );
}
function TokenChoice({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.pill, { borderColor: selected ? color.purple : color.border }]}
    >
      {selected && <Check size={14} color={color.lime} />}
      <Text style={s.micro}>{title}</Text>
    </Pressable>
  );
}
function RewardField({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.faint}
        style={s.input}
        {...props}
      />
    </View>
  );
}
const s = themedStyles(() => ({
  card: {
    borderRadius: 23,
    padding: 20,
    gap: 14,
    backgroundColor: themeValue("#0B0811", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#30223D", color.border),
  },
  label: { color: color.text, fontFamily: font.medium, fontSize: 16 },
  hint: {
    color: color.muted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  micro: {
    color: color.muted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  kicker: {
    color: themeValue("#C3A3EA", color.purple),
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 2,
  },
  balance: { color: color.text, fontFamily: font.semibold, fontSize: 48 },
  points: { color: color.lime, fontFamily: font.semibold, fontSize: 16 },
  ruleRow: { flexDirection: "row", gap: 10 },
  rule: {
    flex: 1,
    gap: 8,
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: themeValue("#181120", color.raised),
    borderRadius: 14,
    padding: 9,
  },
  input: {
    backgroundColor: themeValue("#020203", color.input),
    borderWidth: 1,
    borderColor: themeValue("#8B7A9E", color.border),
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 46,
    color: color.text,
    fontFamily: font.medium,
    fontSize: 16,
  },
  receipt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: themeValue("#30223D", color.border),
  },
  program: {
    gap: 10,
    backgroundColor: themeValue("#181120", color.raised),
    borderRadius: 17,
    padding: 16,
    borderWidth: 1,
    borderColor: themeValue("#30223D", color.border),
  },
  status: { fontFamily: font.medium, fontSize: 12 },
  pill: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 10,
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
  },
}));
