import { useEffect, useState } from "react";
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
  Hexagon,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Action, Notice } from "../components/ui";
import { Sheet } from "../components/floating";
import { StudioDock } from "../components/studio-dock";
import { color, font, styles } from "../theme";
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
export function WalletScreen({ navigation, initialItem }: Props) {
  const { session, api, data } = useZiipa();
  const [step, setStep] = useState(0);
  const [view, setView] = useState<"wizard" | "vault">("wizard");
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
    !initialItem?.demo && initialItem?.media_id ? initialItem.title : "",
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
  const [tab, setTab] = useState<"Assets" | "Metadata" | "Activity">("Assets");
  const [sheet, setSheet] = useState<
    "protocol" | "review" | "pairing" | "transfer" | "receive" | "media" | null
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || "The wallet request was not completed.");
    } finally {
      setBusy(false);
    }
  }
  async function loadAccount() {
    if (!session) return;
    const [w, m, t, p] = await Promise.all([
      api<WalletLink[]>("/api/web3/wallets"),
      api<MetadataRecord[]>("/api/web3/metadata"),
      api<Intent[]>("/api/web3/intents"),
      readPending(session.user.id),
    ]);
    setLinks(w);
    setRecords(m);
    setHistory(t);
    setPending(p);
    if (!link && w[0]) {
      setLink(w[0]);
      setChainId(w[0].chain_id);
    }
  }
  useEffect(() => {
    void request<WalletConfig>("/api/web3/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    void loadAccount().catch((e) => setError(e.message));
  }, [session?.user.id]);
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
    const wallet = await connectWallet(chainId, method, (uri) => {
      setPairUri(uri);
      if (uri) setSheet("pairing");
      else setSheet(null);
    });
    setConnected(true);
    const proof = await api<{ id: string; message: string }>(
      "/api/web3/challenge",
      { chain_id: chainId, address: wallet.address },
    );
    const signature = await signWalletProof(
      proof.message,
      wallet.address,
      chainId,
    );
    const verified = await api<WalletLink>("/api/web3/verify", {
      challenge_id: proof.id,
      signature,
    });
    setLink(verified);
    setLinks((prev) => [verified, ...prev.filter((l) => l.id !== verified.id)]);
    setNotice("Ownership verified. Signing stays in your wallet.");
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
    if (!activeLink || !linkedConnection)
      throw new Error(
        "Reconnect your verified wallet before preparing a mint.",
      );
    if (!chain?.deployed)
      throw new Error(
        "Contracts need to be deployed on this test network. Ziipa Local is available for local testing.",
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
    const updated = await api<Intent>(
      `/api/web3/intents/${value.intentId}/submit`,
      { tx_hash: value.hash },
    );
    setIntent(updated);
    setHistory((prev) => [updated, ...prev.filter((i) => i.id !== updated.id)]);
    if (updated.status === "confirmed" || updated.status === "reverted") {
      const stored = await readPending(session.user.id);
      if (stored?.intentId === value.intentId)
        await savePending(session.user.id, null);
      setPending((previous) =>
        previous?.intentId === value.intentId ? null : previous,
      );
      setNotice(
        updated.status === "confirmed"
          ? "Transaction confirmed on the test network."
          : "Transaction reverted. No asset or payment was credited.",
      );
    } else
      setNotice(
        "Transaction is awaiting network confirmation. Do not submit it again.",
      );
  }
  async function approve() {
    if (!intent || !session) return;
    if (pending)
      throw new Error(
        "Verify your previous transaction before signing another.",
      );
    const hash = await sendWalletTransaction(intent);
    const value = { intentId: intent.id, hash };
    setPending(value);
    setIntent({ ...intent, tx_hash: hash, status: "submitted" });
    // Save the hash before the API call so an interrupted request can be recovered.
    try {
      await savePending(session.user.id, value);
    } catch {
      // Still submit the hash to the API if device persistence fails.
      setNotice(`Keep this transaction hash: ${hash}`);
    }
    await verifyPending(value);
    setView("vault");
    setTab("Activity");
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
  const ownedMedia = data.drafts.filter((d) => !d.demo && d.media_id);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={s.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to Studio"
            onPress={() => navigation.navigate("Studio")}
            style={s.icon}
          >
            <ChevronLeft size={27} color="white" strokeWidth={1.4} />
          </Pressable>
          <Text style={s.title}>
            {view === "wizard" ? "Connect Wallet" : "Your Wallet"}
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
              <Wallet size={21} color="#C8B7DE" />
            ) : (
              <Plus size={23} color="white" />
            )}
          </Pressable>
        </View>
        {view === "wizard" && (
          <View accessibilityLabel={`Step ${step + 1} of 4`} style={s.progress}>
            {[0, 1, 2, 3].map((i) => (
              <View
                key={i}
                style={[
                  s.bar,
                  { backgroundColor: i <= step ? color.purple : "#BCBBC1" },
                ]}
              />
            ))}
          </View>
        )}
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={
            view === "wizard"
              ? [
                  s.wizard,
                  step === 3 && {
                    justifyContent: "flex-start",
                    paddingTop: 20,
                  },
                ]
              : s.vault
          }
        >
          {view === "wizard" ? (
            <>
              <View style={s.card}>
                <Text style={s.cardTitle}>
                  {
                    [
                      "Token Engine",
                      "Protocol",
                      "Your connection",
                      "Metadata & Mint",
                    ][step]
                  }
                </Text>
                <View style={s.cardBody}>
                  {step === 0 && (
                    <>
                      <Input
                        label="Name Token"
                        value={name}
                        onChangeText={(v) => changed(() => setName(v))}
                        maxLength={80}
                      />
                      <View style={{ flexDirection: "row", gap: 10 }}>
                        {(["mint_nft", "create_token"] as const).map((k) => (
                          <Pressable
                            key={k}
                            accessibilityRole="button"
                            accessibilityState={{ selected: kind === k }}
                            onPress={() => {
                              setKind(k);
                              setIntent(null);
                            }}
                            style={[
                              s.type,
                              {
                                borderColor: kind === k ? "#7541C9" : "#302638",
                              },
                            ]}
                          >
                            {k === "mint_nft" ? (
                              <Hexagon
                                size={14}
                                color={kind === k ? "#BA99F2" : "#908398"}
                              />
                            ) : (
                              <Coins
                                size={14}
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
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <Text style={s.label}>Select Protocol</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Select Protocol"
                        onPress={() => setSheet("protocol")}
                        style={s.select}
                      >
                        <Text style={s.inputText}>
                          {chain?.name || "Select"}
                        </Text>
                        <ChevronDown color="white" size={19} />
                      </Pressable>
                      <Text style={s.hint}>
                        {chain
                          ? `${chain.currency} · EVM · Test network`
                          : "Loading available networks…"}
                      </Text>
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
                            : "Your keys. Your creations."}
                        </Text>
                        <Text style={[s.hint, { textAlign: "center" }]}>
                          {linkedConnection
                            ? "Connected & ownership verified"
                            : "Connect an external wallet and sign a message to prove ownership. No spending approval."}
                        </Text>
                      </View>
                      {!session ? (
                        <>
                          <Action
                            title="Sign in to Ziipa"
                            onPress={() => navigation.navigate("Login")}
                          />
                          <Text style={s.hint}>
                            Your Ziipa account keeps metadata and transaction
                            history together.
                          </Text>
                        </>
                      ) : (
                        <>
                          {Platform.OS === "web" && (
                            <Action
                              secondary
                              title={
                                browserWalletAvailable()
                                  ? "Connect browser wallet"
                                  : "Browser wallet"
                              }
                              busy={busy}
                              onPress={() =>
                                void run(() => connect("injected"))
                              }
                            />
                          )}
                          <Action
                            title={
                              linkedConnection
                                ? "Reconnect wallet"
                                : "Connect with WalletConnect"
                            }
                            busy={busy}
                            onPress={() =>
                              void run(() => connect("walletconnect"))
                            }
                          />
                          {!walletConnectConfigured && (
                            <Text style={s.hint}>
                              Native pairing requires your WalletConnect project
                              ID. Browser extensions can connect directly.
                            </Text>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {step === 2 && !linkedConnection && (
                    <Action
                      secondary
                      title="Preview metadata form"
                      onPress={() => {
                        setStep(3);
                        setNotice(
                          "Form preview only. Connect a verified wallet to store metadata and mint.",
                        );
                      }}
                    />
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
                          {kind === "mint_nft" ? "ERC-721" : "ERC-20"}
                        </Text>
                      </View>
                      <Input
                        label="Description"
                        value={description}
                        onChangeText={(v) => changed(() => setDescription(v))}
                        maxLength={2000}
                        multiline
                      />
                      <Input
                        label="Collection / trait"
                        value={trait}
                        onChangeText={(v) => changed(() => setTrait(v))}
                        maxLength={200}
                      />
                      <View style={{ gap: 10 }}>
                        <Text style={s.label}>Media & storage</Text>
                        <Action
                          secondary
                          title={mediaName || "Upload image, audio or video"}
                          busy={busy}
                          onPress={() => void run(upload)}
                        />
                        {ownedMedia.length > 0 && (
                          <Action
                            secondary
                            title="Choose a Studio draft"
                            onPress={() => setSheet("media")}
                          />
                        )}
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
                      </View>
                      {kind === "mint_nft" ? (
                        <>
                          <Input
                            label="Suggested resale royalty (%)"
                            value={royalty}
                            keyboardType="decimal-pad"
                            onChangeText={setRoyalty}
                          />
                          <Text style={s.hint}>
                            0–10%. Marketplace support determines whether
                            royalties are paid.
                          </Text>
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
                            label="Fixed supply · 18 decimals"
                            value={supply}
                            onChangeText={setSupply}
                            keyboardType="number-pad"
                          />
                          <Text style={s.hint}>
                            All tokens are issued to your wallet once. No
                            additional minting or platform admin.
                          </Text>
                        </>
                      )}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 10,
                        }}
                      >
                        <Switch
                          accessibilityLabel="I approve permanent public metadata storage"
                          value={consent}
                          onValueChange={setConsent}
                          trackColor={{ true: color.purple }}
                        />
                        <Text style={[s.hint, { flex: 1 }]}>
                          I own or have rights to this media. I approve storing
                          the media and metadata publicly on IPFS. Other copies
                          and blockchain records cannot be erased.
                        </Text>
                      </View>
                      <Text style={s.hint}>
                        {config?.storage === "local_ipfs"
                          ? "Current environment: offline local IPFS. Files are pinned locally and are not publicly retrievable."
                          : "Current environment: public IPFS. Publishing may be permanent."}
                      </Text>
                      {!chain?.deployed && (
                        <Notice text="The contracts for this network are not deployed yet. Select Ziipa Local for local integration testing." />
                      )}
                    </>
                  )}
                </View>
              </View>
              {step < 3 && <View style={{ height: 20 }} />}
            </>
          ) : (
            <>
              <View style={styles.between}>
                <Text style={s.kicker}>ZIIPA STUDIO / WEB3</Text>
                <Text style={s.chip}>TESTNET</Text>
              </View>
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
                  <Text style={{ fontSize: 17, color: "#AD9CBD" }}>ETH</Text>
                </Text>
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
                <Text style={s.hint}>
                  {balance
                    ? `Read from block ${balance.block_number}. Test assets have no monetary value.`
                    : "Sync to read an actual balance. No estimated fiat value."}
                </Text>
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
                        <Icon size={20} color="white" strokeWidth={1.5} />
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
                        {shortAddress(w.address)} · {w.chain_id}
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
              <View
                style={{
                  flexDirection: "row",
                  gap: 25,
                  borderBottomWidth: 1,
                  borderBottomColor: "#30263B",
                }}
              >
                {(["Assets", "Metadata", "Activity"] as const).map((t) => (
                  <Pressable
                    key={t}
                    accessibilityRole="button"
                    accessibilityState={{ selected: tab === t }}
                    onPress={() => setTab(t)}
                    style={{
                      paddingVertical: 13,
                      borderBottomWidth: 2,
                      borderBottomColor: tab === t ? "#8242D8" : "transparent",
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
                ))}
              </View>
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
                  {balance && (
                    <Text style={s.hint}>
                      {balance.scope} Showing up to 20 collectibles.
                    </Text>
                  )}
                </>
              )}
              {tab === "Metadata" && (
                <>
                  <Text style={s.hint}>
                    Content-addressed records. Stored separately from minting; a
                    stored record does not mean an NFT exists.
                  </Text>
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
                    <Text style={s.hint}>
                      Your IPFS metadata will appear here after storage
                      succeeds.
                    </Text>
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
                    <Text style={s.hint}>
                      No transactions yet. Wallet signatures are not
                      transactions.
                    </Text>
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
              <Text style={[s.hint, { paddingBottom: 10 }]}>
                Ziipa never asks for a seed phrase or private key. No mainnet
                payments, subscriptions, exchange, or custody are enabled in
                this build.
              </Text>
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
          <View style={s.buttons}>
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
                <Text style={s.buttonText}>Back</Text>
              </Pressable>
            )}
            <Pressable
              disabled={
                busy ||
                (step === 3 &&
                  (!consent || !linkedConnection || !chain?.deployed))
              }
              accessibilityRole="button"
              accessibilityLabel={
                step === 3 ? "Store metadata & review mint" : "Next"
              }
              accessibilityState={{
                disabled:
                  busy ||
                  (step === 3 &&
                    (!consent || !linkedConnection || !chain?.deployed)),
              }}
              onPress={() => (step === 3 ? void run(prepareMint) : next())}
              style={[
                s.next,
                {
                  flex: step > 0 ? 1 : undefined,
                  width: step === 0 ? 166 : undefined,
                  opacity:
                    busy ||
                    (step === 3 &&
                      (!consent || !linkedConnection || !chain?.deployed))
                      ? 0.5
                      : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={s.buttonText}>
                  {step === 3 ? "Review mint" : "Next"}
                </Text>
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
              ? "Select Protocol"
              : sheet === "review"
                ? "Review transaction"
                : sheet === "pairing"
                  ? "Connect Wallet"
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
              {config?.chains.map((c) => (
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
                      {c.id === 31337
                        ? "Local development chain"
                        : `Test network · chain ${c.id}`}{" "}
                      ·{" "}
                      {c.deployed
                        ? "Contracts configured"
                        : "Contracts pending deployment"}
                    </Text>
                  </View>
                  {c.id === chainId && <Check size={20} color="#A6E21B" />}
                </Pressable>
              ))}
              <Text style={s.hint}>
                Mainnet is disabled. Network configuration and signed
                transactions must match.
              </Text>
              {!config && (
                <Action
                  title="Retry connection to API"
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
              <Text style={s.hint}>
                Scan with a WalletConnect wallet, or open your wallet on this
                device. Approve only the test network shown in Ziipa.
              </Text>
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
                title="Open wallet app"
                onPress={() =>
                  void Linking.openURL(pairUri).catch(() =>
                    setError(
                      "No wallet handles this link. Copy the connection URI into your wallet or scan the QR.",
                    ),
                  )
                }
              />
              <Action
                secondary
                title="Copy connection URI"
                onPress={() => void Clipboard.setStringAsync(pairUri)}
              />
              <Text style={s.hint}>
                Waiting for wallet approval. Keep the wallet open for the
                following signature request. Closing this sheet cancels pairing.
              </Text>
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
              {Object.entries(intent.summary).map(([key, value]) => (
                <View key={key} style={{ gap: 4 }}>
                  <Text style={s.micro}>
                    {key.replaceAll("_", " ").toUpperCase()}
                  </Text>
                  <Text selectable style={s.label}>
                    {key === "estimated_fee_wei"
                      ? `${units(String(value), 18, 10)} test ETH (estimate)`
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
              <Notice text="This is a test-network transaction. Your wallet displays the final gas fee and requests approval. Transactions cannot be undone. Ziipa does not receive your private keys." />
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
                      }),
                    )
                  }
                />
              ) : null}
              {intent.tx_hash &&
                config?.chains.find((c) => c.id === intent.chain_id)
                  ?.explorer && (
                  <Action
                    secondary
                    title="View in block explorer"
                    onPress={() =>
                      void Linking.openURL(
                        `${config.chains.find((c) => c.id === intent.chain_id)!.explorer}/tx/${intent.tx_hash}`,
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
                    Receive only on {chain?.name}. Use test assets; never send
                    real funds to a local development wallet.
                  </Text>
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
            ownedMedia.map((d) => (
              <Pressable
                key={d.id}
                accessibilityRole="button"
                style={s.asset}
                onPress={() => {
                  changed(() => {
                    setMediaId(d.media_id!);
                    setMediaName(d.title);
                    setImageUri("");
                  });
                  setSheet(null);
                }}
              >
                <Text style={s.label}>{d.title}</Text>
              </Pressable>
            ))}
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
const s = StyleSheet.create({
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
    color: "white",
    fontFamily: font.medium,
    fontSize: 21,
    letterSpacing: 1.5,
  },
  progress: {
    flexDirection: "row",
    gap: 20,
    paddingHorizontal: 25,
    marginTop: 22,
    marginBottom: 15,
  },
  bar: { height: 5, borderRadius: 3, flex: 1 },
  wizard: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 25,
    paddingVertical: 30,
  },
  vault: { paddingHorizontal: 23, paddingTop: 15, paddingBottom: 30, gap: 20 },
  card: {
    backgroundColor: "#0B0811",
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "#1B1426",
    overflow: "hidden",
  },
  cardTitle: {
    fontFamily: font.medium,
    fontSize: 20,
    letterSpacing: 1,
    color: "white",
    textAlign: "center",
    paddingVertical: 22,
    borderBottomWidth: 1,
    borderBottomColor: "#1A1422",
  },
  cardBody: { padding: 28, gap: 19, minHeight: 158 },
  label: {
    fontFamily: font.medium,
    color: "#F9F4FC",
    fontSize: 16,
    letterSpacing: 0.5,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: "#9C94A7",
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: "#020203",
  },
  inputText: {
    fontFamily: font.medium,
    color: "white",
    fontSize: 17,
    letterSpacing: 0.5,
  },
  select: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: "#AAA3B4",
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: "#020203",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: -9,
  },
  hint: {
    fontFamily: font.regular,
    color: "#AFA0BD",
    fontSize: 13,
    lineHeight: 19,
  },
  micro: {
    fontFamily: font.regular,
    color: "#A89CB7",
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
    color: "#BF9CEB",
    fontSize: 10,
    letterSpacing: 1,
    backgroundColor: "#2B1646",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  buttons: {
    flexDirection: "row",
    gap: 19,
    justifyContent: "center",
    paddingHorizontal: 25,
    paddingTop: 12,
    paddingBottom: 46,
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
    backgroundColor: "#291444",
    borderWidth: 1,
    borderColor: "#57317D",
    alignItems: "center",
    justifyContent: "center",
  },
  kicker: {
    color: "#AB95C2",
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 2,
  },
  balance: { color: "white", fontFamily: font.semibold, fontSize: 42 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#A6E21B" },
  quickIcon: {
    width: 45,
    height: 45,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#53405F",
    backgroundColor: "#1E142B",
    justifyContent: "center",
    alignItems: "center",
  },
  asset: {
    padding: 16,
    gap: 13,
    borderWidth: 1,
    borderColor: "#30223D",
    backgroundColor: "#181120",
    borderRadius: 17,
    flexDirection: "row",
    alignItems: "center",
  },
});
