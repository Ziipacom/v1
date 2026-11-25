import { useDesktopLayout } from "../components/desktop-layout";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Coins,
  Copy,
  Gift,
  FileText,
  Hexagon,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  Wallet,
} from "lucide-react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Action, Notice } from "../components/ui";
import { Sheet } from "../components/floating";
import { HelpLabel } from "../components/help-label";
import { InfoTip } from "../components/info-tip";
import { Disclosure } from "../components/disclosure";
import { WorkflowProgress } from "../components/workflow-progress";
import { StudioDock } from "../components/studio-dock";
import { themedStyles, themeValue, color, font, styles } from "../theme";
import { useZiipa } from "../provider";
import { request, uploadMedia } from "../lib/api";
import type { Item, RootStack } from "../lib/types";
import type {
  Balances,
  Chain,
  Intent,
  MetadataRecord,
  TxKind,
  WalletConfig,
  WalletLink,
} from "../lib/wallet-types";
import { units, shortAddress } from "../lib/wallet-types";
import {
  browserWalletAvailable,
  cancelPairing,
  connectWallet,
  currentWallet,
  disconnectWallet,
  observeWallet,
  sendWalletTransaction,
  signWalletProof,
  walletConnectConfigured,
} from "../lib/wallet-connector";
import { readPending, savePending, type Pending } from "../lib/wallet-pending";
import { sourceMintItem } from "../lib/editor-source";
import { assertWalletNetwork, mintSetupIssue } from "../lib/wallet-readiness";
import { metaMaskPairingLink } from "../lib/wallet-links";
import { MediaRewards, RewardRuleFields } from "../components/media-rewards";
import {
  emptyRewardDraft,
  rewardRules,
  type RewardDraft,
} from "../lib/rewards-types";

type Props = {
  navigation: NativeStackNavigationProp<RootStack>;
  initialItem?: Item;
};
type Transfer = {
  kind: TxKind;
  token_address?: string;
  token_id?: string;
  symbol?: string;
};
const networkHelp = "This wallet uses test assets with no monetary value.";

export function WalletScreen(props: Props) {
  return <FullWalletScreen {...props} />;
}

/** Provider diagnostics are not product copy, and can include internal payloads. */
export function walletErrorMessage(error: unknown) {
  const value = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
  } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  const localMessages = [
    "Connect and verify a wallet first.",
    "Sign in before uploading your media.",
    "Reconnect your verified wallet before preparing a mint.",
    "Name your token and choose your saved media before minting.",
    "Approve permanent public metadata storage to continue.",
    "Royalties must be between 0 and 10%.",
    "Verify your previous transaction before signing another.",
    "Reconnect this wallet before sending.",
    "Curator split must be between 0 and 50%.",
    "Wallet app pairing is unavailable.",
    "No browser wallet found. Choose Wallet app or open a browser with a wallet.",
    "Refresh the network before connecting your wallet.",
  ];
  if (localMessages.includes(message)) return message;
  if (value?.status === 401)
    return "Sign in again to continue with your wallet.";
  if (value?.code === 4001 || /user rejected|user denied/i.test(message))
    return "Wallet approval was declined. Check Activity before trying again.";
  if (/insufficient funds/i.test(message))
    return "Add test funds to cover the amount and network fee.";
  if (
    /network.*match|wrong network|select base sepolia|switch your wallet/i.test(
      message,
    )
  )
    return "Select the same network in Ziipa and your wallet.";
  if (
    /minting is unavailable|public media storage|minting setup/i.test(message)
  )
    return "Minting is unavailable. Check your network and try again.";
  return "Check your wallet connection and Activity before trying again.";
}

export function walletMintAvailability(
  config: WalletConfig | null,
  chainId: number,
  kind: "mint_nft" | "create_token",
) {
  const issue = mintSetupIssue(config, chainId, kind);
  return {
    ready: !issue,
    label: !config
      ? "Checking minting…"
      : issue
        ? "Minting unavailable"
        : "Minting available",
    detail: issue || networkHelp,
  };
}

function FullWalletScreen({ navigation, initialItem }: Props) {
  const { desktop } = useDesktopLayout();
  const { session, api, data } = useZiipa();
  initialItem =
    sourceMintItem(initialItem, session?.user.id, false) || undefined;
  const [step, setStep] = useState(0);
  const [view, setView] = useState<"wizard" | "vault">(
    initialItem ? "wizard" : "vault",
  );
  const [connectorChoice, setConnectorChoice] = useState<
    "walletconnect" | "injected"
  >("walletconnect");
  const [extraDetails, setExtraDetails] = useState(false);
  const [useIpfs, setUseIpfs] = useState(false);
  const [config, setConfig] = useState<WalletConfig | null>(null);
  const [chainId, setChainId] = useState(84532);
  const [name, setName] = useState(initialItem?.title || "");
  const [kind, setKind] = useState<"mint_nft" | "create_token">("mint_nft");
  const [description, setDescription] = useState(
    initialItem?.description || "",
  );
  const [imageUri, setImageUri] = useState("");
  const [mediaId, setMediaId] = useState(
    !initialItem?.demo ? initialItem?.media_id || "" : "",
  );
  const [mediaName, setMediaName] = useState(
    !initialItem?.demo && initialItem?.media_id
      ? `${initialItem.title}${initialItem.photo_ids?.length ? " · Cover photo" : ""}`
      : "",
  );
  const [trait, setTrait] = useState("");
  const [royalty, setRoyalty] = useState("5");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("1000000");
  const [consent, setConsent] = useState(false);
  const [links, setLinks] = useState<WalletLink[]>([]);
  const [link, setLink] = useState<WalletLink | null>(null);
  const [syncedBalance, setBalance] = useState<Balances | null>(null);
  const [records, setRecords] = useState<MetadataRecord[]>([]);
  const [history, setHistory] = useState<Intent[]>([]);
  const [tab, setTab] = useState<
    "Assets" | "Rewards" | "Metadata" | "Activity"
  >("Assets");
  const [rewardDraft, setRewardDraft] = useState<RewardDraft>(emptyRewardDraft);
  const [rewardToken, setRewardToken] = useState<Intent | null>(null);
  const owner = useRef<string | null>(null);
  owner.current = session?.access_token || null;
  const walletOwner = useRef<number | null>(session?.user.id || null);
  const [sheet, setSheet] = useState<
    | "protocol"
    | "review"
    | "pairing"
    | "ownership"
    | "transfer"
    | "receive"
    | "media"
    | null
  >(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pairUri, setPairUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(!!currentWallet());
  const [transfer, setTransfer] = useState<Transfer>({
    kind: "send_native",
    symbol: "ETH",
  });
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [curator, setCurator] = useState("");
  const [split, setSplit] = useState("0");
  const chain = config?.chains.find((c) => c.id === chainId);
  const intentChain = config?.chains.find((c) => c.id === intent?.chain_id);
  const localMediaStorage = chainId === 31337 && config?.storage === "local_ipfs";
  const mintAvailability = walletMintAvailability(config, chainId, kind);
  const activeLink = link?.chain_id === chainId ? link : null;
  const balance =
    syncedBalance?.chain_id === chainId &&
    syncedBalance.address.toLowerCase() === activeLink?.address.toLowerCase()
      ? syncedBalance
      : null;
  const linkedConnection =
    !!activeLink &&
    connected &&
    currentWallet()?.address.toLowerCase() ===
      activeLink.address.toLowerCase() &&
    currentWallet()?.chainId === chainId;
  const mintDisabled =
    !name.trim() ||
    (!mediaId && !imageUri.trim()) ||
    !consent ||
    !linkedConnection ||
    !mintAvailability.ready;
  const [metadataId, setMetadataId] = useState("");
  const [metadataRequest, setMetadataRequest] = useState(() =>
    Crypto.randomUUID(),
  );

  function changed(fn: () => void) {
    fn();
    setMetadataId("");
    setMetadataRequest(Crypto.randomUUID());
    setIntent(null);
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    const token = owner.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (owner.current === token) setError(walletErrorMessage(e));
    } finally {
      if (owner.current === token) setBusy(false);
    }
  }
  async function loadAccount() {
    if (!session) return;
    const token = session.access_token;
    const [w, m, t] = await Promise.all([
      api<WalletLink[]>("/api/web3/wallets"),
      api<MetadataRecord[]>("/api/web3/metadata"),
      api<Intent[]>("/api/web3/intents"),
    ]);
    if (owner.current !== token) return;
    const [p, settlement] = await Promise.all([
      readPending(session.user.id),
      api<Intent[]>("/api/rewards/settlement/intents"),
    ]);
    if (owner.current !== token) return;
    setLinks(w);
    setRecords(m);
    setHistory(
      [...t, ...settlement].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    );
    setPending(p);
    if ((!link || !w.some((wallet) => wallet.id === link.id)) && w[0]) {
      setLink(w[0]);
      setChainId(w[0].chain_id);
    }
  }
  useEffect(() => {
    void request<WalletConfig>("/api/web3/config")
      .then(setConfig)
      .catch((e) => setError(walletErrorMessage(e)));
  }, []);
  useEffect(() => {
    if (walletOwner.current !== (session?.user.id || null)) {
      setName("");
      setDescription("");
      setMediaId("");
      setMediaName("");
      setImageUri("");
      setTrait("");
      setSymbol("");
      setSupply("1000000");
      setMetadataId("");
      setMetadataRequest(Crypto.randomUUID());
    }
    walletOwner.current = session?.user.id || null;
    setLinks([]);
    setLink(null);
    setBalance(null);
    setRecords([]);
    setHistory([]);
    setPending(null);
    setIntent(null);
    setRewardToken(null);
    setSheet(null);
    setBusy(false);
    setError("");
    setNotice("");
    setRewardDraft(emptyRewardDraft());
    setConsent(false);
    setRecipient("");
    setAmount("");
    setPairUri("");
    setConnected(false);
    const token = owner.current;
    void loadAccount().catch((e) => {
      if (owner.current === token) setError(walletErrorMessage(e));
    });
  }, [session?.access_token]);
  useEffect(() => observeWallet(() => setConnected(false)), []);
  function chooseChain(c: Chain) {
    setChainId(c.id);
    setLink(links.find((w) => w.chain_id === c.id) || null);
    setBalance(null);
    setIntent(null);
    setSheet(null);
  }
  async function connect(method: "injected" | "walletconnect") {
    if (!session) {
      navigation.navigate("Login");
      return;
    }
    const token = session.access_token;
    assertWalletNetwork(chainId, __DEV__, Platform.OS);
    if (!config || config.testnet_only !== true)
      throw new Error("Refresh the network before connecting your wallet.");
    const wallet = await connectWallet(chainId, method, (uri) => {
      if (owner.current !== token) return;
      setPairUri(uri);
      if (uri) setSheet("pairing");
      else setSheet(null);
    });
    if (owner.current !== token) return;
    setConnected(true);
    const proof = await api<{ id: string; message: string }>(
      "/api/web3/challenge",
      { chain_id: chainId, address: wallet.address },
    );
    if (owner.current !== token) return;
    setSheet("ownership");
    const signature = await signWalletProof(
      proof.message,
      wallet.address,
      chainId,
    );
    if (owner.current !== token) return;
    const verified = await api<WalletLink>("/api/web3/verify", {
      challenge_id: proof.id,
      signature,
    });
    if (owner.current !== token) return;
    setLink(verified);
    setLinks((prev) => [verified, ...prev.filter((l) => l.id !== verified.id)]);
    setSheet(null);
    setNotice("Wallet linked.");
  }
  async function sync(wallet = activeLink) {
    if (!wallet) throw new Error("Connect and verify a wallet first.");
    setBalance(null);
    setBalance(await api<Balances>(`/api/web3/wallets/${wallet.id}/balances`));
    await loadAccount();
  }
  async function upload() {
    if (!session) throw new Error("Sign in before uploading your media.");
    const picked = await DocumentPicker.getDocumentAsync({
      type: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "video/mp4",
        "video/webm",
        "audio/mpeg",
        "audio/wav",
      ],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled) return;
    const file = picked.assets[0];
    const result = await uploadMedia(
      {
        uri: file.uri,
        name: file.name,
        size: file.size || 0,
        mimeType: file.mimeType || "application/octet-stream",
      },
      session.access_token,
      () => {},
    );
    changed(() => {
      setMediaId(result.id);
      setMediaName(file.name);
      setImageUri("");
    });
    setNotice(
      "File uploaded privately. It is not stored on IPFS until you approve below.",
    );
  }
  async function prepareMint() {
    if (kind === "create_token" && rewardDraft.enabled)
      rewardRules({
        ...rewardDraft,
        name: rewardDraft.name || `${name.trim()} rewards`,
      });
    if (!activeLink || !linkedConnection)
      throw new Error(
        "Reconnect your verified wallet before preparing a mint.",
      );
    assertWalletNetwork(chainId, __DEV__, Platform.OS);
    if (!mintAvailability.ready) throw new Error(mintAvailability.detail);
    if (!name.trim() || (!mediaId && !imageUri.trim()))
      throw new Error(
        "Name your token and choose your saved media before minting.",
      );
    if (!consent)
      throw new Error("Approve permanent public metadata storage to continue.");
    const bps = Math.round(Number(royalty) * 100);
    if (kind === "mint_nft" && (!Number.isFinite(bps) || bps < 0 || bps > 1000))
      throw new Error("Royalties must be between 0 and 10%.");
    let id = metadataId;
    if (!id) {
      const record = await api<MetadataRecord>("/api/web3/metadata", {
        request_id: metadataRequest,
        name,
        description,
        ...(mediaId ? { media_id: mediaId } : { image_uri: imageUri.trim() }),
        attributes: trait ? { Collection: trait } : {},
        public_storage_consent: true,
      });
      setMetadataId(record.id);
      setRecords((prev) => [record, ...prev.filter((r) => r.id !== record.id)]);
      id = record.id;
    }
    const prepared = await api<Intent>("/api/web3/intents", {
      request_id: Crypto.randomUUID(),
      wallet_id: activeLink.id,
      kind,
      metadata_id: id,
      royalty_bps: bps,
      symbol: kind === "create_token" ? symbol : "",
      supply: kind === "create_token" ? supply : "1000000",
    });
    setIntent(prepared);
    setSheet("review");
  }
  async function verifyPending(value = pending) {
    if (!value || !session) return;
    const token = session.access_token;
    const updated = await api<Intent>(
      value.settlement
        ? `/api/rewards/settlement/intents/${value.intentId}/submit`
        : `/api/web3/intents/${value.intentId}/submit`,
      { tx_hash: value.hash },
    );
    setIntent(updated);
    setHistory((prev) => [updated, ...prev.filter((i) => i.id !== updated.id)]);
    if (
      updated.kind === "create_token" &&
      updated.status === "confirmed" &&
      (
        value.rewardProgramDraft ||
        (pending?.intentId === value.intentId
          ? pending.rewardProgramDraft
          : null) ||
        rewardDraft
      ).enabled
    ) {
      const savedDraft =
        value.rewardProgramDraft ||
        (pending?.intentId === value.intentId
          ? pending.rewardProgramDraft
          : null);
      if (savedDraft) setRewardDraft(savedDraft);
      setRewardToken(updated);
      setTab("Rewards");
    }
    if (updated.status === "confirmed" || updated.status === "reverted") {
      const stored = await readPending(session.user.id);
      if (owner.current !== token) return;
      if (stored?.intentId === value.intentId)
        await savePending(session.user.id, null);
      if (owner.current !== token) return;
      setPending((previous) =>
        previous?.intentId === value.intentId ? null : previous,
      );
      setNotice(
        updated.status === "confirmed"
          ? "Transaction confirmed."
          : "The network rejected the transaction.",
      );
    } else
      setNotice(
        "Transaction is awaiting network confirmation. Do not submit it again.",
      );
  }
  async function approve() {
    if (!intent || !session) return;
    const token = session.access_token;
    if (pending)
      throw new Error(
        "Verify your previous transaction before signing another.",
      );
    const hash = await sendWalletTransaction(intent);
    const value: Pending = {
      intentId: intent.id,
      hash,
      ...(intent.kind.startsWith("reward_") ? { settlement: true } : {}),
      ...(intent.kind === "create_token" && rewardDraft.enabled
        ? {
            rewardProgramDraft: {
              ...rewardDraft,
              name: rewardDraft.name || `${name.trim()} rewards`,
            },
          }
        : {}),
    };
    // Save the hash before the API call so an interrupted request can be recovered.
    try {
      await savePending(session.user.id, value);
    } catch {
      // Still submit the hash to the API if device persistence fails.
      if (owner.current === token)
        setNotice(`Keep this transaction hash: ${hash}`);
    }
    if (owner.current !== token) return;
    setPending(value);
    setIntent({ ...intent, tx_hash: hash, status: "submitted" });
    await verifyPending(value);
    setView("vault");
    setTab(
      intent.kind === "create_token" && rewardDraft.enabled
        ? "Rewards"
        : "Activity",
    );
  }
  async function prepareTransfer() {
    if (!activeLink || !linkedConnection)
      throw new Error("Reconnect this wallet before sending.");
    const bps = Math.round(Number(split) * 100);
    if (!Number.isFinite(bps) || bps < 0 || bps > 5000)
      throw new Error("Curator split must be between 0 and 50%.");
    const prepared = await api<Intent>("/api/web3/intents", {
      request_id: Crypto.randomUUID(),
      wallet_id: activeLink.id,
      ...transfer,
      recipient: recipient.trim(),
      amount: transfer.kind === "send_nft" ? "0" : amount,
      curator: curator.trim(),
      curator_bps: transfer.kind === "tip" ? bps : 0,
    });
    setIntent(prepared);
    setSheet("review");
  }
  function openTransfer(value: Transfer) {
    setTransfer(value);
    setRecipient("");
    setAmount("");
    setCurator("");
    setSplit("0");
    setError("");
    setSheet("transfer");
  }
  function copy(value: string) {
    void run(async () => {
      await Clipboard.setStringAsync(value);
      setNotice("Copied.");
    });
  }
  function next() {
    setError("");
    if (step === 0 && !name.trim()) {
      setError("Name your token to continue.");
      return;
    }
    if (step === 2 && !linkedConnection) {
      setError("Connect and verify your wallet first.");
      return;
    }
    setStep(Math.min(step + 1, 3));
  }
  const ownedMedia = data.drafts.filter((item) =>
    sourceMintItem(item, session?.user.id, false),
  );
  const connectionNeeded = step === 2 && !linkedConnection;
  const primaryDisabled =
    busy ||
    (step === 0 && !name.trim()) ||
    (step === 1 && !chain) ||
    (connectionNeeded &&
      !!session &&
      (!config ||
        (connectorChoice === "walletconnect"
          ? !walletConnectConfigured
          : !browserWalletAvailable()))) ||
    (step === 3 && mintDisabled);
  const primaryLabel = connectionNeeded
    ? session
      ? "Connect & verify"
      : "Sign in to connect"
    : step === 3
      ? "Review mint"
      : "Continue";

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            s.header,
            desktop && {
              height: 72,
              width: "100%",
              maxWidth: 1120,
              alignSelf: "center",
              paddingHorizontal: 28,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() =>
              navigation.canGoBack()
                ? navigation.goBack()
                : navigation.navigate("Studio")
            }
            style={s.icon}
          >
            <ChevronLeft size={27} color={color.text} strokeWidth={1.4} />
          </Pressable>
          <Text style={s.title}>
            {view === "wizard" ? "Token Wallet" : "Your Wallet"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              view === "wizard" ? "Open wallet assets" : "Create a token"
            }
            onPress={() => {
              setView(view === "wizard" ? "vault" : "wizard");
              setError("");
            }}
            style={s.icon}
          >
            {view === "wizard" ? (
              <Wallet size={21} color={color.muted} />
            ) : (
              <Plus size={23} color={color.text} />
            )}
          </Pressable>
        </View>
        {view === "wizard" && (
          <View
            accessibilityLabel={`Step ${step + 1} of 4`}
            style={[
              s.progress,
              desktop && {
                width: "100%",
                maxWidth: 680,
                alignSelf: "center",
                marginTop: 0,
                marginBottom: 16,
              },
            ]}
          >
            <WorkflowProgress
              steps={[
                { title: "Create", icon: Hexagon },
                { title: "Network", icon: Link2 },
                { title: "Wallet", icon: Wallet },
                { title: "Review", icon: ShieldCheck },
              ]}
              activeStep={step}
            />
          </View>
        )}
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={
            view === "wizard"
              ? [
                  s.wizard,
                  desktop && {
                    width: "100%",
                    maxWidth: 720,
                    alignSelf: "center",
                    justifyContent: "flex-start",
                    paddingTop: 10,
                  },
                  step === 3 && {
                    justifyContent: "flex-start",
                    paddingTop: 20,
                  },
                ]
              : [
                  s.vault,
                  desktop && {
                    width: "100%",
                    maxWidth: 1120,
                    alignSelf: "center",
                    paddingHorizontal: 28,
                  },
                ]
          }
        >
          {view === "wizard" ? (
            <>
              {!!mediaName && step < 3 && (
                <Text style={[s.hint, { marginBottom: 14 }]} numberOfLines={1}>
                  {mediaName}
                </Text>
              )}
              <View style={s.card}>
                <Text style={s.cardTitle}>
                  {
                    [
                      "Your creation",
                      "Network",
                      "Connect wallet",
                      "Review & mint",
                    ][step]
                  }
                </Text>
                <View style={s.cardBody}>
                  {step === 0 && (
                    <>
                      <Input
                        label="Creation name"
                        value={name}
                        onChangeText={(v) => changed(() => setName(v))}
                        maxLength={80}
                      />
                      <View style={{ flexDirection: "row", gap: 10 }}>
                        {(["mint_nft", "create_token"] as const).map((k) => (
                          <Pressable
                            key={k}
                            accessibilityRole="button"
                            accessibilityState={{
                              selected: kind === k,
                              disabled: busy,
                            }}
                            disabled={busy}
                            onPress={() => {
                              setKind(k);
                              setIntent(null);
                            }}
                            style={[
                              s.choiceTile,
                              {
                                borderColor: kind === k ? "#7541C9" : "#302638",
                              },
                            ]}
                          >
                            {k === "mint_nft" ? (
                              <Hexagon
                                size={24}
                                color={kind === k ? "#BA99F2" : "#908398"}
                              />
                            ) : (
                              <Coins
                                size={24}
                                color={kind === k ? "#BA99F2" : "#908398"}
                              />
                            )}
                            <Text
                              style={[
                                s.micro,
                                { color: kind === k ? "#DDCAFC" : "#908398" },
                              ]}
                            >
                              {k === "mint_nft"
                                ? "Collectible"
                                : "Creator token"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      {kind === "create_token" && (
                        <View style={{ gap: 10 }}>
                          <View style={styles.row}>
                            <Gift size={20} color={color.lime} />
                            <View style={{ flex: 1 }}>
                              <HelpLabel
                                label="Media Rewards"
                                style={s.label}
                                help="Reward your community with a creator token. Points and token rewards are managed separately. You will review and enable any reward program after minting."
                              />
                            </View>
                            <Switch
                              accessibilityLabel="Include Media Rewards with creator token"
                              value={rewardDraft.enabled}
                              onValueChange={(enabled) =>
                                setRewardDraft({ ...rewardDraft, enabled })
                              }
                              trackColor={{ true: color.purple }}
                            />
                          </View>
                        </View>
                      )}
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <HelpLabel
                        label="Select network"
                        style={s.label}
                        help={networkHelp}
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Select network"
                        onPress={() => setSheet("protocol")}
                        style={s.select}
                      >
                        <Text style={s.inputText}>
                          {chain?.name || "Select"}
                        </Text>
                        <ChevronDown color={color.text} size={19} />
                      </Pressable>
                      {!mintAvailability.ready && (
                        <HelpLabel
                          label={mintAvailability.label}
                          style={s.micro}
                          help={mintAvailability.detail}
                        />
                      )}
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <View style={{ alignItems: "center", gap: 10 }}>
                        <View style={s.walletEmblem}>
                          <Wallet size={29} color="#D9BAFF" strokeWidth={1.5} />
                        </View>
                        <Text style={s.label}>
                          {activeLink
                            ? shortAddress(activeLink.address)
                            : "Wallet ownership"}
                        </Text>
                        <HelpLabel
                          label={
                            linkedConnection
                              ? "Ownership verified"
                              : "Connect & verify ownership"
                          }
                          style={s.hint}
                          help="This signature verifies ownership only. Keep your recovery phrase and private keys to yourself."
                        />
                      </View>
                      {session && !linkedConnection && (
                        <>
                          <View style={{ flexDirection: "row", gap: 10 }}>
                            {(
                              [
                                "walletconnect",
                                ...(Platform.OS === "web" ? ["injected"] : []),
                              ] as const
                            ).map((method) => {
                              const selected = connectorChoice === method;
                              const available =
                                method === "walletconnect"
                                  ? walletConnectConfigured
                                  : browserWalletAvailable();
                              return (
                                <Pressable
                                  key={method}
                                  accessibilityRole="radio"
                                  accessibilityLabel={
                                    method === "walletconnect"
                                      ? "Wallet app"
                                      : "Browser wallet"
                                  }
                                  accessibilityState={{
                                    checked: selected,
                                    disabled: busy || !available,
                                  }}
                                  disabled={busy || !available}
                                  onPress={() =>
                                    setConnectorChoice(
                                      method as "walletconnect" | "injected",
                                    )
                                  }
                                  style={[
                                    s.choiceTile,
                                    {
                                      borderColor: selected
                                        ? color.lime
                                        : color.border,
                                      opacity: available ? 1 : 0.5,
                                    },
                                  ]}
                                >
                                  {method === "walletconnect" ? (
                                    <Wallet size={24} color={color.text} />
                                  ) : (
                                    <Link2 size={24} color={color.text} />
                                  )}
                                  <Text style={s.micro}>
                                    {method === "walletconnect"
                                      ? "Wallet app"
                                      : "Browser"}
                                  </Text>
                                  {!available && (
                                    <Text style={s.micro}>Unavailable</Text>
                                  )}
                                </Pressable>
                              );
                            })}
                          </View>
                        </>
                      )}
                    </>
                  )}
                  {step === 2 && linkedConnection && (
                    <Action
                      secondary
                      title="Open my wallet"
                      onPress={() => {
                        setView("vault");
                        void run(() => sync());
                      }}
                    />
                  )}
                  {step === 3 && (
                    <>
                      <View style={styles.between}>
                        <Text style={s.label}>{name}</Text>
                        <Text style={s.chip}>
                          {kind === "mint_nft" ? "Collectible" : "Creator token"}
                        </Text>
                      </View>
                      <Input
                        label="Description"
                        value={description}
                        onChangeText={(v) => changed(() => setDescription(v))}
                        maxLength={2000}
                        multiline
                      />
                      <Disclosure
                        title="Collection"
                        detail="Optional trait"
                        icon={FileText}
                        expanded={extraDetails}
                        onToggle={() => setExtraDetails(!extraDetails)}
                      >
                        <Input
                          label="Collection / trait"
                          value={trait}
                          onChangeText={(v) => changed(() => setTrait(v))}
                          maxLength={200}
                        />
                      </Disclosure>
                      <View style={{ gap: 10 }}>
                        <HelpLabel
                          label="Media"
                          style={s.label}
                          help="Upload a file or choose a saved creation. Your media stays private until you approve public IPFS storage below."
                        />
                        <View
                          style={{
                            flexDirection: "row",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <View style={{ flex: 1, minWidth: 110 }}>
                            <Action
                              secondary
                              title="Upload"
                              icon={Upload}
                              busy={busy}
                              onPress={() => void run(upload)}
                            />
                          </View>
                          {ownedMedia.length > 0 && (
                            <View style={{ flex: 1, minWidth: 110 }}>
                              <Action
                                secondary
                                title="Library"
                                icon={Hexagon}
                                disabled={busy}
                                onPress={() => setSheet("media")}
                              />
                            </View>
                          )}
                        </View>
                        {!!mediaName && (
                          <Text style={s.micro} numberOfLines={2}>
                            {mediaName}
                          </Text>
                        )}
                        <Disclosure
                          title="IPFS link"
                          icon={Link2}
                          expanded={useIpfs}
                          onToggle={() => setUseIpfs(!useIpfs)}
                        >
                          <Input
                            label={
                              mediaId
                                ? "Or use an IPFS media URI"
                                : "IPFS media URI"
                            }
                            placeholder="ipfs://bafy…"
                            value={imageUri}
                            autoCapitalize="none"
                            onChangeText={(v) =>
                              changed(() => {
                                setImageUri(v);
                                setMediaId("");
                                setMediaName("");
                              })
                            }
                          />
                        </Disclosure>
                      </View>
                      {kind === "mint_nft" ? (
                        <>
                          <Input
                            label="Suggested resale royalty (%)"
                            value={royalty}
                            keyboardType="decimal-pad"
                            onChangeText={setRoyalty}
                          />
                          <HelpLabel
                            label="0–10% royalty"
                            style={s.micro}
                            help="This is a suggested resale royalty. Marketplace support determines whether royalties are paid."
                          />
                        </>
                      ) : (
                        <>
                          <Input
                            label="Token symbol"
                            value={symbol}
                            onChangeText={(v) =>
                              setSymbol(
                                v.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                              )
                            }
                            maxLength={10}
                          />
                          <Input
                            label="Token supply"
                            value={supply}
                            onChangeText={setSupply}
                            keyboardType="number-pad"
                          />
                          <HelpLabel
                            label="Fixed supply"
                            style={s.micro}
                            help="All tokens are issued to your wallet once. No additional minting or platform admin."
                          />
                        </>
                      )}
                      {kind === "create_token" && rewardDraft.enabled && (
                        <View style={{ gap: 15, paddingTop: 8 }}>
                          <View style={styles.row}>
                            <Gift size={20} color={color.lime} />
                            <Text style={s.label}>Media Rewards rules</Text>
                          </View>
                          <RewardRuleFields
                            value={{
                              ...rewardDraft,
                              name:
                                rewardDraft.name || `${name.trim()} rewards`,
                            }}
                            onChange={setRewardDraft}
                            disabled={busy}
                          />
                          <HelpLabel
                            label="Rewards start paused"
                            style={s.micro}
                            help="After your token transaction is confirmed, save a paused reward program. Enable points, fund rewards and approve claims separately; no extra tokens are minted."
                          />
                        </View>
                      )}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 10,
                        }}
                      >
                        <Switch
                          accessibilityLabel={
                            localMediaStorage
                              ? "I approve local media storage"
                              : "I approve permanent public metadata storage"
                          }
                          value={consent}
                          onValueChange={setConsent}
                          trackColor={{ true: color.purple }}
                        />
                        <Text style={[s.hint, { flex: 1 }]}>
                          {localMediaStorage
                            ? "I have rights to this media and approve local storage."
                            : "I have rights to this media and approve permanent public storage."}
                        </Text>
                        <InfoTip
                          title={localMediaStorage ? "local storage" : "public storage"}
                          content={
                            localMediaStorage
                              ? "Your media stays in local storage."
                              : "Your media and its details are published to IPFS. Copies and blockchain records may remain permanently."
                          }
                        />
                      </View>
                      {!mintAvailability.ready && (
                        <HelpLabel
                          label={mintAvailability.label}
                          style={s.micro}
                          help={mintAvailability.detail}
                        />
                      )}
                    </>
                  )}
                </View>
              </View>
              {step < 3 && <View style={{ height: 20 }} />}
            </>
          ) : (
            <>
              <Text style={s.kicker}>YOUR WALLET</Text>
              <View style={[s.card, { padding: 23, gap: 18 }]}>
                <View style={styles.between}>
                  <Text style={s.label}>
                    {activeLink
                      ? shortAddress(activeLink.address)
                      : "Connect your wallet"}
                  </Text>
                  <ShieldCheck
                    size={20}
                    color={activeLink ? "#A6E21B" : "#756A80"}
                  />
                </View>
                <Text style={s.balance}>
                  {balance ? units(balance.native_wei) : "—"}{" "}
                  <Text
                    style={{
                      fontSize: 17,
                      color: themeValue("#AD9CBD", color.muted),
                    }}
                  >
                    ETH
                  </Text>
                </Text>
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setSheet("protocol")}
                    style={[styles.row, { gap: 7 }]}
                  >
                    <View style={s.dot} />
                    <Text style={s.hint}>
                      {chain?.name || "Select a network"}
                    </Text>
                    <ChevronDown size={15} color="#AE9ABB" />
                  </Pressable>
                  <InfoTip title="network" content={networkHelp} />
                </View>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                  }}
                >
                  {[
                    {
                      label: "Receive",
                      Icon: ArrowDownLeft,
                      action: () => setSheet("receive"),
                    },
                    {
                      label: "Send",
                      Icon: ArrowUpRight,
                      action: () =>
                        openTransfer({ kind: "send_native", symbol: "ETH" }),
                    },
                    {
                      label: "Tip",
                      Icon: Coins,
                      action: () =>
                        openTransfer({ kind: "tip", symbol: "ETH" }),
                    },
                    {
                      label: "Sync",
                      Icon: RefreshCw,
                      action: () => void run(() => sync()),
                    },
                  ].map(({ label, Icon, action }) => (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      disabled={busy}
                      onPress={action}
                      style={{ alignItems: "center", gap: 7, minWidth: 52 }}
                    >
                      <View style={s.quickIcon}>
                        <Icon size={20} color={color.text} strokeWidth={1.5} />
                      </View>
                      <Text style={s.micro}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              {!session ? (
                <Action
                  title="Sign in to connect your wallet"
                  onPress={() => navigation.navigate("Login")}
                />
              ) : (
                <Action
                  secondary
                  title={
                    linkedConnection
                      ? "Manage wallet connection"
                      : "Connect / reconnect wallet"
                  }
                  icon={Link2}
                  onPress={() => {
                    setStep(2);
                    setView("wizard");
                  }}
                />
              )}
              {links.length > 0 && (
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {links.map((w) => (
                    <Pressable
                      accessibilityRole="button"
                      key={w.id}
                      onPress={() => {
                        setLink(w);
                        setChainId(w.chain_id);
                        setBalance(null);
                      }}
                      style={[
                        s.type,
                        {
                          borderColor:
                            w.id === activeLink?.id
                              ? color.purple
                              : color.border,
                        },
                      ]}
                    >
                      <Text style={s.micro}>
                        {shortAddress(w.address)} ·{" "}
                        {config?.chains.find((network) => network.id === w.chain_id)
                          ?.name ?? w.chain_id}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              {pending && (
                <View style={{ gap: 12 }}>
                  <Notice
                    text={`A transaction needs verification: ${shortAddress(pending.hash)}. Do not sign again.`}
                  />
                  <Action
                    title="Verify pending transaction"
                    busy={busy}
                    onPress={() => void run(() => verifyPending())}
                  />
                </View>
              )}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flexGrow: 0 }}
                contentContainerStyle={{
                  gap: 22,
                  borderBottomWidth: 1,
                  borderBottomColor: "#30263B",
                }}
              >
                {(["Assets", "Rewards", "Metadata", "Activity"] as const).map(
                  (t) => (
                    <Pressable
                      key={t}
                      accessibilityRole="button"
                      accessibilityState={{ selected: tab === t }}
                      onPress={() => setTab(t)}
                      style={{
                        paddingVertical: 13,
                        borderBottomWidth: 2,
                        borderBottomColor:
                          tab === t ? "#8242D8" : "transparent",
                      }}
                    >
                      <Text
                        style={[
                          s.label,
                          { color: tab === t ? "white" : "#978AA6" },
                        ]}
                      >
                        {t}
                      </Text>
                    </Pressable>
                  ),
                )}
              </ScrollView>
              {tab === "Rewards" && (
                <MediaRewards
                  tokenHistory={history}
                  initialDraft={{
                    ...rewardDraft,
                    name:
                      rewardDraft.name ||
                      (name.trim() ? `${name.trim()} rewards` : ""),
                  }}
                  confirmedToken={rewardToken}
                  activeWallet={activeLink}
                  connected={linkedConnection}
                  onConnect={() => {
                    setView("wizard");
                    setStep(2);
                  }}
                  onNewToken={() => {
                    setKind("create_token");
                    setRewardDraft((value) => ({ ...value, enabled: true }));
                    setStep(0);
                    setView("wizard");
                  }}
                  onReviewIntent={(value) => {
                    setIntent(value);
                    setHistory((previous) => [
                      value,
                      ...previous.filter((item) => item.id !== value.id),
                    ]);
                    setSheet("review");
                  }}
                />
              )}
              {tab === "Assets" && (
                <>
                  <View style={styles.between}>
                    <Text style={s.label}>Collectibles & tokens</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Mint a new asset"
                      onPress={() => {
                        setStep(0);
                        setView("wizard");
                      }}
                    >
                      <Plus size={22} color="#C3A1F4" />
                    </Pressable>
                  </View>
                  {balance?.collectibles.map((n) => (
                    <View style={s.asset} key={n.token_id}>
                      <Hexagon color="#BE99FB" size={31} />
                      <View style={{ flex: 1, gap: 5 }}>
                        <Text style={s.label}>Ziipa #{n.token_id}</Text>
                        <Text style={s.hint} numberOfLines={1}>
                          {n.uri}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Transfer collectible ${n.token_id}`}
                        onPress={() =>
                          openTransfer({
                            kind: "send_nft",
                            token_id: n.token_id,
                          })
                        }
                        style={s.icon}
                      >
                        <ArrowUpRight color="white" size={22} />
                      </Pressable>
                    </View>
                  ))}
                  {balance?.tokens.map((t) => (
                    <View key={t.address} style={s.asset}>
                      <Coins size={28} color="#A6E21B" />
                      <View style={{ flex: 1, gap: 5 }}>
                        <Text style={s.label}>{t.symbol}</Text>
                        <Text style={s.hint}>{units(t.balance)} tokens</Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Send ${t.symbol}`}
                        onPress={() =>
                          openTransfer({
                            kind: "send_token",
                            token_address: t.address,
                            symbol: t.symbol,
                          })
                        }
                        style={s.icon}
                      >
                        <ArrowUpRight color="white" size={22} />
                      </Pressable>
                    </View>
                  ))}
                  {(!balance ||
                    (!balance.collectibles.length &&
                      !balance.tokens.length)) && (
                    <Text style={[s.hint, { paddingVertical: 18 }]}>
                      {balance
                        ? "No Ziipa assets found in this wallet. Mint your first collectible or creator token."
                        : "Your assets appear here after you connect and sync a wallet."}
                    </Text>
                  )}
                  {balance && balance.collectibles.length >= 20 && (
                    <Text style={s.hint}>
                      Showing up to 20 collectibles.
                    </Text>
                  )}
                </>
              )}
              {tab === "Metadata" && (
                <>
                  <HelpLabel
                    label="Public media records"
                    style={s.label}
                    help="Your records are saved separately from your collectibles."
                  />
                  {records.map((m) => (
                    <View
                      style={[s.asset, { alignItems: "flex-start" }]}
                      key={m.id}
                    >
                      <View style={{ flex: 1, gap: 8 }}>
                        <Text style={s.label}>{m.document.name}</Text>
                        <Text selectable style={s.hint}>
                          {m.uri}
                        </Text>
                        <Text selectable style={s.micro}>
                          SHA-256 {m.sha256}
                        </Text>
                        <Text style={s.hint}>
                          {m.document.description || "No description"}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Copy metadata for ${m.document.name}`}
                        onPress={() =>
                          copy(JSON.stringify(m.document, null, 2))
                        }
                        style={s.icon}
                      >
                        <Copy color="#BE99FB" size={18} />
                      </Pressable>
                    </View>
                  ))}
                  {!records.length && (
                    <Text style={s.hint}>No records yet.</Text>
                  )}
                </>
              )}
              {tab === "Activity" && (
                <>
                  <Action
                    secondary
                    title="Refresh transaction history"
                    busy={busy}
                    onPress={() => void run(loadAccount)}
                  />
                  {history.map((t) => (
                    <Pressable
                      key={t.id}
                      accessibilityRole="button"
                      accessibilityLabel={`View ${t.kind} ${t.status}`}
                      style={s.asset}
                      onPress={() => {
                        setIntent(t);
                        setSheet("review");
                      }}
                    >
                      <View style={{ flex: 1, gap: 6 }}>
                        <Text style={s.label}>
                          {t.kind.replaceAll("_", " ")}
                        </Text>
                        <Text style={s.hint}>
                          {t.tx_hash
                            ? shortAddress(t.tx_hash)
                            : "Prepared · no transaction sent"}
                        </Text>
                      </View>
                      <Text
                        style={[
                          s.micro,
                          {
                            color:
                              t.status === "confirmed" ? "#A6E21B" : "#BDA2E4",
                          },
                        ]}
                      >
                        {t.status}
                      </Text>
                    </Pressable>
                  ))}
                  {!history.length && (
                    <Text style={s.hint}>No transactions yet.</Text>
                  )}
                </>
              )}
              {activeLink && (
                <Action
                  secondary
                  title="Unlink wallet from Ziipa"
                  busy={busy}
                  onPress={() =>
                    void run(async () => {
                      await api(
                        `/api/web3/wallets/${activeLink.id}/unlink`,
                        {},
                      );
                      await disconnectWallet();
                      setLink(null);
                      setBalance(null);
                      setConnected(false);
                      setLinks((prev) =>
                        prev.filter((l) => l.id !== activeLink.id),
                      );
                      setNotice(
                        "Wallet unlinked. On-chain assets remain in your external wallet.",
                      );
                    })
                  }
                />
              )}
            </>
          )}
        </ScrollView>
        {(error || notice) && (
          <View
            style={{
              paddingHorizontal: 24,
              paddingVertical: 8,
              maxHeight: 125,
            }}
          >
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text
                accessibilityRole="alert"
                style={[s.hint, { color: error ? "#FFB9CA" : "#CBB6E9" }]}
              >
                {error || notice}
              </Text>
            </ScrollView>
          </View>
        )}
        {view === "wizard" && (
          <View
            style={[
              s.buttons,
              desktop && {
                width: "100%",
                maxWidth: 720,
                alignSelf: "center",
                // The desktop assistant floats 18px up and is 56px tall.
                // Leave a 12px gap above it without duplicating the phone dock.
                paddingBottom: 18 + 56 + 12,
              },
            ]}
          >
            {step > 0 && (
              <Pressable
                disabled={busy}
                accessibilityRole="button"
                onPress={() => {
                  setStep(step - 1);
                  setError("");
                }}
                style={s.back}
              >
                <Text style={[s.buttonText, { color: color.text }]}>Back</Text>
              </Pressable>
            )}
            <Pressable
              disabled={primaryDisabled}
              accessibilityRole="button"
              accessibilityLabel={
                step === 3 ? "Store metadata & review mint" : primaryLabel
              }
              accessibilityState={{
                disabled: primaryDisabled,
              }}
              onPress={() => {
                if (primaryDisabled) return;
                if (connectionNeeded) {
                  if (!session) navigation.navigate("Login");
                  else void run(() => connect(connectorChoice));
                } else if (step === 3) void run(prepareMint);
                else next();
              }}
              style={[
                s.next,
                {
                  flex: 2,
                  opacity: primaryDisabled ? 0.5 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={s.buttonText}>{primaryLabel}</Text>
              )}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
      <StudioDock />
      {!!sheet && (
        <Sheet
          onClose={() => {
            if (sheet === "pairing") void cancelPairing();
            setSheet(null);
          }}
          title={
            sheet === "protocol"
              ? "Select network"
              : sheet === "review"
                ? "Review transaction"
                : sheet === "pairing"
                  ? "Connect Wallet"
                  : sheet === "ownership"
                    ? "Verify wallet ownership"
                    : sheet === "transfer"
                      ? transfer.kind === "tip"
                        ? "Tip a creator"
                        : "Send asset"
                      : sheet === "media"
                        ? "Your Studio media"
                        : "Receive"
          }
        >
          {sheet === "protocol" && (
            <>
              {config?.chains
                .filter(
                  (c) =>
                    [84532, 11155111].includes(c.id) ||
                    (__DEV__ && Platform.OS === "web" && c.id === 31337),
                )
                .map((c) => (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={c.name}
                    onPress={() => chooseChain(c)}
                    style={s.asset}
                  >
                    <View style={{ flex: 1, gap: 7 }}>
                      <Text style={s.label}>{c.name}</Text>
                      <Text style={s.hint}>
                        {c.currency} ·{" "}
                        {walletMintAvailability(config, c.id, kind).label}
                      </Text>
                    </View>
                    {c.id === chainId && <Check size={20} color="#A6E21B" />}
                  </Pressable>
                ))}
              {!config && (
                <Action
                  title="Refresh wallet availability"
                  onPress={() =>
                    void run(async () =>
                      setConfig(
                        await request<WalletConfig>("/api/web3/config"),
                      ),
                    )
                  }
                />
              )}
            </>
          )}
          {sheet === "pairing" && (
            <>
              <Text style={s.hint}>Open your wallet or scan the code.</Text>
              {pairUri && (
                <View
                  style={{
                    alignSelf: "center",
                    padding: 15,
                    backgroundColor: "white",
                    borderRadius: 16,
                  }}
                >
                  <QRCode value={pairUri} size={210} />
                </View>
              )}
              <Action
                title="Open MetaMask"
                disabled={!pairUri}
                onPress={() =>
                  void Linking.openURL(metaMaskPairingLink(pairUri)).catch(() =>
                    setError(
                      "Install MetaMask or scan the code with another wallet.",
                    ),
                  )
                }
              />
              <Action
                title="Open wallet app"
                onPress={() =>
                  void Linking.openURL(pairUri).catch(() =>
                    setError(
                      "Open a compatible wallet or scan the code.",
                    ),
                  )
                }
              />
              <Action
                secondary
                title="Copy connection link"
                onPress={() => void Clipboard.setStringAsync(pairUri)}
              />
              <Text style={s.hint}>
                Approve the connection in your wallet.
              </Text>
            </>
          )}
          {sheet === "ownership" && (
            <>
              <Text style={s.hint}>
                Sign the ownership message in your wallet to link your address.
              </Text>
              <Action
                title="Open MetaMask"
                onPress={() =>
                  void Linking.openURL("metamask://").catch(() =>
                    setError(
                      "Open your connected wallet to approve the ownership message.",
                    ),
                  )
                }
              />
              {!!error && <Notice error text={error} />}
            </>
          )}
          {sheet === "review" && intent && (
            <>
              <View style={styles.between}>
                <Text style={s.chip}>
                  {intent.kind.replaceAll("_", " ").toUpperCase()}
                </Text>
                <Text style={s.hint}>{intent.status}</Text>
              </View>
              {intentChain && <Text style={s.hint}>{intentChain.name}</Text>}
              {Object.entries(intent.summary).map(([key, value]) => (
                <View key={key} style={{ gap: 4 }}>
                  <Text style={s.micro}>
                    {key === "estimated_fee_wei"
                      ? "Estimated network fee"
                      : key.replaceAll("_", " ").toUpperCase()}
                  </Text>
                  <Text selectable style={s.label}>
                    {key === "estimated_fee_wei"
                      ? `${units(String(value), 18, 10)} ETH`
                      : String(value)}
                  </Text>
                </View>
              ))}
              <Text style={s.micro}>TRANSACTION DESTINATION / CONTRACT</Text>
              <Text selectable style={s.hint}>
                {intent.transaction.to}
              </Text>
              {intent.tx_hash && (
                <>
                  <Text style={s.micro}>TRANSACTION HASH</Text>
                  <Text selectable style={s.hint}>
                    {intent.tx_hash}
                  </Text>
                </>
              )}
              {intent.result.token_id && (
                <Text style={s.label}>
                  Collectible #{intent.result.token_id}
                </Text>
              )}
              {intent.result.token_address && (
                <Text selectable style={s.hint}>
                  Creator token: {intent.result.token_address}
                </Text>
              )}
              <HelpLabel
                label="Transactions are final"
                style={s.micro}
                help={`${networkHelp} Review the final network fee in your wallet before approving.`}
              />
              {busy && (
                <Action
                  secondary
                  title="Open MetaMask to approve"
                  onPress={() =>
                    void Linking.openURL("metamask://").catch(() =>
                      setError(
                        "Open your connected wallet to review the pending request.",
                      ),
                    )
                  }
                />
              )}
              {intent.status === "prepared" ? (
                <Action
                  title="Approve in wallet"
                  busy={busy}
                  disabled={!!pending}
                  onPress={() => void run(approve)}
                />
              ) : intent.tx_hash ? (
                <Action
                  secondary
                  title="Verify on-chain status"
                  busy={busy}
                  onPress={() =>
                    void run(() =>
                      verifyPending({
                        intentId: intent.id,
                        hash: intent.tx_hash!,
                        ...(intent.kind.startsWith("reward_")
                          ? { settlement: true }
                          : {}),
                      }),
                    )
                  }
                />
              ) : null}
              {intent.tx_hash && intentChain?.explorer && (
                <Action
                  secondary
                  title="View in block explorer"
                  onPress={() =>
                    void Linking.openURL(
                      `${intentChain.explorer}/tx/${intent.tx_hash}`,
                    )
                  }
                />
              )}
            </>
          )}
          {sheet === "transfer" && (
            <>
              <Text style={s.hint}>
                {chain?.name} ·{" "}
                {transfer.kind === "send_nft"
                  ? `Ziipa collectible #${transfer.token_id}`
                  : transfer.symbol}{" "}
                · wallet approval required
              </Text>
              <Input
                label="Recipient wallet address"
                value={recipient}
                onChangeText={setRecipient}
                autoCapitalize="none"
                placeholder="0x…"
                maxLength={42}
              />
              {transfer.kind !== "send_nft" && (
                <Input
                  label={`Amount (${transfer.symbol})`}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                />
              )}
              {transfer.kind === "tip" && (
                <>
                  <Input
                    label="Optional curator split (%)"
                    value={split}
                    onChangeText={setSplit}
                    keyboardType="decimal-pad"
                  />
                  {Number(split) > 0 && (
                    <Input
                      label="Curator wallet address"
                      value={curator}
                      onChangeText={setCurator}
                      maxLength={42}
                      autoCapitalize="none"
                    />
                  )}
                  <Text style={s.hint}>
                    The contract pays the creator and optional curator in one
                    transaction. Ziipa keeps no platform fee.
                  </Text>
                </>
              )}
              <Action
                title="Review transaction"
                busy={busy}
                onPress={() => void run(prepareTransfer)}
              />
            </>
          )}
          {sheet === "receive" && (
            <>
              {activeLink ? (
                <>
                  <Text style={s.hint}>
                    Use {chain?.name || "the selected network"} to send to this
                    address.
                  </Text>
                  <InfoTip title="receiving assets" content={networkHelp} />
                  <View
                    style={{
                      alignSelf: "center",
                      padding: 15,
                      backgroundColor: "white",
                      borderRadius: 16,
                    }}
                  >
                    <QRCode
                      value={`ethereum:${activeLink.address}@${chainId}`}
                      size={210}
                    />
                  </View>
                  <Text selectable style={s.label}>
                    {activeLink.address}
                  </Text>
                  <Action
                    title="Copy wallet address"
                    onPress={() => copy(activeLink.address)}
                  />
                </>
              ) : (
                <Action
                  title="Connect your wallet"
                  onPress={() => {
                    setSheet(null);
                    setView("wizard");
                    setStep(2);
                  }}
                />
              )}
            </>
          )}
          {sheet === "media" &&
            ownedMedia.map((d) => {
              const label = `${d.title}${d.photo_ids?.length ? " · Cover photo" : ""}`;
              return (
                <Pressable
                  key={d.id}
                  accessibilityRole="button"
                  style={s.asset}
                  onPress={() => {
                    changed(() => {
                      setMediaId(d.media_id!);
                      setMediaName(label);
                      setImageUri("");
                    });
                    setSheet(null);
                  }}
                >
                  <HelpLabel label={label} style={s.label} />
                </Pressable>
              );
            })}
          {sheet && error && <Notice text={error} error />}
          {sheet && notice && <Text style={s.hint}>{notice}</Text>}
        </Sheet>
      )}
    </SafeAreaView>
  );
}

function Input({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#6D627A"
        style={[
          s.input,
          s.inputText,
          props.multiline && {
            minHeight: 78,
            textAlignVertical: "top",
            paddingTop: 12,
          },
        ]}
        {...props}
      />
    </View>
  );
}
const s = themedStyles(() =>
  StyleSheet.create({
    header: {
      height: 80,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 17,
    },
    icon: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      color: color.text,
      fontFamily: font.medium,
      fontSize: 21,
      letterSpacing: 1.5,
    },
    progress: {
      paddingHorizontal: 25,
      marginTop: 8,
      marginBottom: 15,
    },
    bar: { height: 5, borderRadius: 3, flex: 1 },
    wizard: {
      flexGrow: 1,
      justifyContent: "flex-start",
      paddingHorizontal: 25,
      paddingVertical: 16,
    },
    vault: {
      paddingHorizontal: 23,
      paddingTop: 15,
      paddingBottom: 30,
      gap: 20,
    },
    card: {
      backgroundColor: themeValue("#0B0811", color.panel),
      borderRadius: 26,
      borderWidth: 1,
      borderColor: themeValue("#1B1426", color.border),
      overflow: "hidden",
    },
    cardTitle: {
      fontFamily: font.medium,
      fontSize: 20,
      letterSpacing: 1,
      color: color.text,
      textAlign: "center",
      paddingVertical: 17,
      borderBottomWidth: 1,
      borderBottomColor: color.border,
    },
    cardBody: { padding: 20, gap: 15, minHeight: 158 },
    choiceTile: {
      flex: 1,
      minHeight: 86,
      padding: 12,
      borderWidth: 1,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: color.panel,
    },
    label: {
      fontFamily: font.medium,
      color: themeValue("#F9F4FC", color.text),
      fontSize: 16,
      letterSpacing: 0.5,
    },
    input: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: themeValue("#9C94A7", color.border),
      borderRadius: 10,
      paddingHorizontal: 12,
      backgroundColor: themeValue("#020203", color.panel),
    },
    inputText: {
      fontFamily: font.medium,
      color: color.text,
      fontSize: 17,
      letterSpacing: 0.5,
    },
    select: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: "#AAA3B4",
      borderRadius: 10,
      paddingHorizontal: 12,
      backgroundColor: themeValue("#020203", color.panel),
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: -9,
    },
    hint: {
      fontFamily: font.regular,
      color: themeValue("#AFA0BD", color.muted),
      fontSize: 13,
      lineHeight: 19,
    },
    micro: {
      fontFamily: font.regular,
      color: themeValue("#A89CB7", color.muted),
      fontSize: 11,
      lineHeight: 16,
    },
    type: {
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    chip: {
      fontFamily: font.medium,
      color: themeValue("#BF9CEB", color.muted),
      fontSize: 10,
      letterSpacing: 1,
      backgroundColor: themeValue("#2B1646", color.accentSoft),
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
    },
    buttons: {
      flexDirection: "row",
      flexShrink: 0,
      gap: 19,
      justifyContent: "center",
      paddingHorizontal: 25,
      paddingTop: 12,
      // StudioDock already reserves its own height and safe-area inset.
      paddingBottom: 12,
    },
    next: {
      backgroundColor: color.purple,
      minHeight: 54,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
    },
    back: {
      flex: 1,
      borderWidth: 1,
      borderColor: "#C2B9CE",
      minHeight: 54,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
    },
    buttonText: {
      fontFamily: font.medium,
      color: "white",
      fontSize: 15,
      letterSpacing: 1,
    },
    walletEmblem: {
      width: 65,
      height: 65,
      borderRadius: 33,
      backgroundColor: themeValue("#291444", color.accentSoft),
      borderWidth: 1,
      borderColor: themeValue("#57317D", color.border),
      alignItems: "center",
      justifyContent: "center",
    },
    kicker: {
      color: themeValue("#AB95C2", color.muted),
      fontFamily: font.medium,
      fontSize: 10,
      letterSpacing: 2,
    },
    balance: { color: color.text, fontFamily: font.semibold, fontSize: 42 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#A6E21B" },
    quickIcon: {
      width: 45,
      height: 45,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: themeValue("#53405F", color.border),
      backgroundColor: themeValue("#1E142B", color.panel),
      justifyContent: "center",
      alignItems: "center",
    },
    asset: {
      padding: 16,
      gap: 13,
      borderWidth: 1,
      borderColor: themeValue("#30223D", color.border),
      backgroundColor: themeValue("#181120", color.panel),
      borderRadius: 17,
      flexDirection: "row",
      alignItems: "center",
    },
  }),
);
