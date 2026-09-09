import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
  Unlink,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react-native";
import { Action, Cover, Empty, Field, Notice } from "../components/ui";
import { Sheet } from "../components/floating";
import { useZiipa } from "../provider";
import { socialProvider } from "../lib/social";
import {
  emptyNetworkHub,
  networkInfo,
  profileLink,
  safeNetworkUrl,
  type ConnectResult,
  type NetworkAccount,
  type NetworkHub,
  type NetworkTab,
} from "../lib/network-hub";
import { prepareMediaShare } from "../lib/share-creation";
import { creationCaption, type PreparedMedia } from "../lib/share-types";
import type { Item, RootStack, SocialProvider } from "../lib/types";
import { color, font, styles } from "../theme";

const tabs: { id: NetworkTab; label: string; icon: LucideIcon }[] = [
  { id: "accounts", label: "Accounts", icon: Network },
  { id: "feed", label: "Feed", icon: Video },
  { id: "people", label: "People", icon: Users },
  { id: "outbox", label: "Publish", icon: Send },
];
function NetworkIcon({
  provider,
  small = false,
}: {
  provider: SocialProvider;
  small?: boolean;
}) {
  const info = socialProvider(provider);
  return (
    <View
      style={[
        n.networkIcon,
        {
          backgroundColor: info.color,
          width: small ? 31 : 46,
          height: small ? 31 : 46,
        },
      ]}
    >
      <Text style={[n.initial, small && { fontSize: 12 }]}>{info.short}</Text>
    </View>
  );
}
function SmallAction({
  title,
  icon: Icon,
  onPress,
  disabled,
}: {
  title: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={[n.smallAction, disabled && { opacity: 0.4 }]}
    >
      <Icon size={16} color={color.text} />
      <Text style={n.smallActionText}>{title}</Text>
    </Pressable>
  );
}

export function ConnectionsScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Connections">) {
  const {
    guest,
    session,
    data,
    api,
    refresh,
    previewNetworks,
    savePreviewNetworks,
  } = useZiipa();
  const [hub, setHub] = useState<NetworkHub>(() =>
    guest ? previewNetworks : emptyNetworkHub(),
  );
  const [tab, setTab] = useState<NetworkTab>(route.params?.tab || "accounts");
  const [filter, setFilter] = useState<SocialProvider | "all">("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<SocialProvider | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [sharingItem, setSharingItem] = useState<Item | null>(null);
  const [prepared, setPrepared] = useState<PreparedMedia | null>(null);
  const preparedRef = useRef<PreparedMedia | null>(null);
  const mounted = useRef(true);
  const [requirements, setRequirements] = useState<string[]>([]);
  useEffect(() => {
    if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.tab]);
  useEffect(() => {
    if (guest) setHub(previewNetworks);
  }, [guest, previewNetworks]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      preparedRef.current?.dispose();
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (guest) return;
      let current = true;
      setLoading(true);
      void api<NetworkHub>("/api/social/hub")
        .then((value) => {
          if (current) {
            setHub(value);
            setError("");
          }
        })
        .catch((cause) => {
          if (current) setError((cause as Error).message);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
      return () => {
        current = false;
      };
    }, [api, guest]),
  );
  const account = selected
    ? hub.providers.find((value) => value.provider === selected)
    : null;
  const linked = hub.providers.filter(
    (value) => value.status !== "disconnected",
  );
  const ownMedia = data.drafts.filter((item) => item.visibility !== "hidden");
  async function run(id: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  function editAccount(value: NetworkAccount) {
    setError("");
    setNotice("");
    setRequirements([]);
    setConfirmDisconnect(false);
    setSelected(value.provider);
    setLinkValue(value.profile_url || value.handle);
  }
  async function openPlatform(
    provider: SocialProvider,
    value = networkInfo[provider].home,
  ) {
    const safe = safeNetworkUrl(provider, value);
    if (!safe) throw new Error("This platform link is invalid.");
    await Linking.openURL(safe);
  }
  async function saveLink() {
    if (!selected) return;
    const normalized = profileLink(selected, linkValue);
    if (guest) {
      const next: NetworkHub = {
        ...hub,
        providers: hub.providers.map((value) =>
          value.provider === selected
            ? {
                ...value,
                ...normalized,
                status: "linked",
                auth_type: "public_profile",
                can_sync: false,
                sync_status: "never",
                last_synced_at: null,
              }
            : value,
        ),
      };
      savePreviewNetworks(next);
      setHub(next);
      setNotice(
        "Public profile saved for this preview session. Sign in to store it and sync supported content.",
      );
    } else {
      await api<NetworkAccount>(`/api/social/${selected}/link`, normalized);
      setHub(await api<NetworkHub>("/api/social/hub"));
      await refresh();
      setNotice(
        "Public profile saved. This is a shortcut, not ownership verification or permission to publish.",
      );
    }
    setSelected(null);
  }
  async function connect() {
    if (!selected) return;
    if (guest) {
      setSelected(null);
      navigation.navigate("Login");
      return;
    }
    const result = await api<ConnectResult>(
      `/api/social/${selected}/connect`,
      {},
    );
    setRequirements(result.requirements || []);
    setNotice(result.detail);
    if (result.auth_url) {
      const url = new URL(result.auth_url);
      if (!(
        selected === "twitch" &&
        url.origin === "https://id.twitch.tv" &&
        url.pathname === "/oauth2/authorize"
      ))
        throw new Error(
          "Authorization for this provider is not enabled in this build.",
        );
      await Linking.openURL(result.auth_url);
    }
  }
  async function sync(provider?: SocialProvider) {
    if (guest) {
      setSelected(null);
      navigation.navigate("Login");
      return;
    }
    const candidates = hub.providers.filter(
      (value) =>
        value.can_sync &&
        value.status !== "disconnected" &&
        (!provider || provider === value.provider),
    );
    if (!candidates.length) {
      setNotice(
        "Link a Bluesky public profile to sync public posts and following. Other networks need their supported account integration.",
      );
      return;
    }
    let updated = hub;
    for (const value of candidates)
      updated = await api<NetworkHub>(`/api/social/${value.provider}/sync`, {});
    setHub(updated);
    const failed = updated.providers.find(
      (value) =>
        candidates.some((entry) => entry.provider === value.provider) &&
        value.sync_status === "error",
    );
    if (failed)
      setError(
        failed.sync_error ||
          "A network could not be synced. Previous results are preserved.",
      );
    else
      setNotice(
        "Supported public content refreshed. This does not import private feeds or follow anyone.",
      );
  }
  async function disconnect() {
    if (!selected) return;
    if (guest) {
      const original = emptyNetworkHub().providers.find(
        (value) => value.provider === selected,
      )!;
      const next = {
        ...hub,
        providers: hub.providers.map((value) =>
          value.provider === selected ? original : value,
        ),
        media: hub.media.filter((value) => value.provider !== selected),
        people: hub.people.filter((value) => value.provider !== selected),
      };
      savePreviewNetworks(next);
      setHub(next);
    } else {
      await api(`/api/social/${selected}/disconnect`, {});
      setHub(await api<NetworkHub>("/api/social/hub"));
      await refresh();
    }
    setSelected(null);
    setNotice(
      "Network link and synced cache removed from Ziipa. External posts and relationships are unchanged.",
    );
  }
  async function copy(text: string) {
    const copied = await Clipboard.setStringAsync(text);
    if (!copied)
      throw new Error(
        "Clipboard access is unavailable. Select and copy the text manually, or use localhost / HTTPS.",
      );
    setNotice("Copied. Nothing has been sent or posted.");
  }
  async function invite() {
    const inviteUrl = hub.invite_url.startsWith("https://")
      ? hub.invite_url
      : "https://ziipa.com";
    const message = `Create and explore with me on Ziipa. ${inviteUrl}`;
    if (Platform.OS === "web") {
      if (navigator.share) {
        try {
          await navigator.share({ title: "Join me on Ziipa", text: message });
        } catch (cause) {
          if ((cause as Error).name !== "AbortError") throw cause;
          else return;
        }
      } else {
        await copy(message);
        return;
      }
    } else await Share.share({ title: "Join me on Ziipa", message });
    setNotice(
      "Invitation opened in your share sheet. Ziipa does not send invitations automatically.",
    );
  }
  function closeShare() {
    preparedRef.current?.dispose();
    preparedRef.current = null;
    setPrepared(null);
    setSharingItem(null);
  }
  async function prepare() {
    if (!sharingItem || !session) {
      setSharingItem(null);
      navigation.navigate("Login");
      return;
    }
    const result = await prepareMediaShare(sharingItem, session.access_token);
    if (!mounted.current) {
      result.dispose();
      return;
    }
    preparedRef.current?.dispose();
    preparedRef.current = result;
    setPrepared(result);
  }
  async function sharePrepared() {
    if (!prepared) return;
    const result = await prepared.share();
    setNotice(
      result === "downloaded"
        ? "Original downloaded. Open a destination and finish posting there; no automatic post was made."
        : result === "cancelled"
          ? "Sharing cancelled. Nothing was marked as published."
          : "Media handed to your device’s share sheet. Finish posting in the destination app; delivery is not confirmed by Ziipa.",
    );
  }
  const query = search.trim().toLowerCase();
  const media = hub.media.filter(
    (item) =>
      (filter === "all" || item.provider === filter) &&
      `${item.title} ${item.text} ${item.author}`.toLowerCase().includes(query),
  );
  const people = hub.people.filter(
    (person) =>
      (filter === "all" || person.provider === filter) &&
      `${person.name} ${person.handle}`.toLowerCase().includes(query),
  );

  return (
    <View style={styles.screen}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.page,
          { padding: 18, paddingBottom: 38, gap: 18 },
        ]}
      >
        <Action
          title="Authorize accounts & publish directly"
          icon={Send}
          onPress={() => navigation.navigate("Publishing")}
        />
        <View style={n.hero}>
          <View style={styles.between}>
            <Text style={styles.eyebrow}>ZIIPA • NETWORKS</Text>
            <Globe2 color="#BA96F0" size={24} />
          </View>
          <Text style={[styles.title, { fontSize: 34 }]}>
            Your world,{"\n"}connected.
          </Text>
          <Text style={styles.small}>
            Create here. Keep your channels, people and publishing in one place.
          </Text>
          <View
            style={[styles.row, { gap: 8, justifyContent: "space-between" }]}
          >
            {hub.providers.map((value) => (
              <Pressable
                key={value.provider}
                accessibilityRole="button"
                accessibilityLabel={`Manage ${value.name}`}
                onPress={() => editAccount(value)}
              >
                <NetworkIcon provider={value.provider} small />
              </Pressable>
            ))}
          </View>
          <View style={n.statRow}>
            {[
              [linked.length, "profiles"],
              [hub.media.length, "synced posts"],
              [hub.people.length, "following"],
            ].map(([count, label]) => (
              <View key={label} style={n.stat}>
                <Text style={n.statValue}>{count}</Text>
                <Text style={n.statLabel}>{label}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={n.tabs} accessibilityRole="tablist">
          {tabs.map(({ id, label, icon: Icon }) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              onPress={() => {
                setTab(id);
                setError("");
                setNotice("");
              }}
              style={[n.tab, tab === id && n.selectedTab]}
            >
              <Icon size={19} color={tab === id ? "white" : color.muted} />
              <Text style={[n.tabText, tab === id && { color: "white" }]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        {guest && (
          <View style={n.previewNote}>
            <Text style={[styles.small, { flex: 1 }]}>
              Preview mode · no accounts are authorized.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("Login")}
            >
              <Text style={n.textLink}>Sign in</Text>
            </Pressable>
          </View>
        )}
        {loading && (
          <ActivityIndicator
            color={color.lime}
            accessibilityLabel="Loading network accounts"
          />
        )}
        {!selected && !sharingItem && !!error && <Notice text={error} error />}
        {!selected && !sharingItem && !!notice && <Notice text={notice} />}
        {tab === "accounts" && (
          <>
            <View style={styles.between}>
              <Text style={[styles.heading, { fontSize: 21 }]}>
                Your channels
              </Text>
              <SmallAction
                title="Sync all"
                icon={RefreshCw}
                disabled={!!busy}
                onPress={() => void run("sync-all", () => sync())}
              />
            </View>
            <Text style={styles.small}>
              Save a profile shortcut or authorize an account. Only supported,
              permitted content can sync.
            </Text>
            {hub.providers.map((value) => (
              <View
                key={value.provider}
                style={[
                  n.account,
                  value.status !== "disconnected" && { borderColor: "#64418A" },
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Manage ${value.name} account`}
                  onPress={() => editAccount(value)}
                  style={styles.row}
                >
                  <NetworkIcon provider={value.provider} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={n.accountName}>{value.name}</Text>
                    <Text style={styles.small} numberOfLines={1}>
                      {value.handle || networkInfo[value.provider].scope}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={color.muted} />
                </Pressable>
                <View style={styles.between}>
                  <View style={n.badge}>
                    <View
                      style={[
                        n.dot,
                        {
                          backgroundColor:
                            value.status === "connected"
                              ? color.lime
                              : value.status === "linked"
                                ? "#BB92F5"
                                : color.faint,
                        },
                      ]}
                    />
                    <Text style={n.badgeText}>
                      {value.status === "connected"
                        ? "Authorized account"
                        : value.status === "linked"
                          ? "Public profile linked"
                          : "Not linked"}
                    </Text>
                  </View>
                  <Text style={n.subtle}>
                    {value.can_publish ? "API posting ready" : "App handoff"}
                  </Text>
                </View>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}
                >
                  <SmallAction
                    title={
                      value.status === "disconnected"
                        ? `Link ${value.name}`
                        : `Manage ${value.name}`
                    }
                    icon={Link2}
                    onPress={() => editAccount(value)}
                  />
                  <SmallAction
                    title={`Open ${value.name}`}
                    icon={ArrowUpRight}
                    onPress={() =>
                      void run("open", () =>
                        openPlatform(
                          value.provider,
                          value.profile_url || undefined,
                        ),
                      )
                    }
                  />
                  {value.can_sync && (
                    <SmallAction
                      title={`Sync ${value.name}`}
                      icon={RefreshCw}
                      disabled={!!busy}
                      onPress={() =>
                        void run(`sync-${value.provider}`, () =>
                          sync(value.provider),
                        )
                      }
                    />
                  )}
                </View>
                {!!value.last_synced_at && (
                  <Text style={n.subtle}>
                    Last sync {new Date(value.last_synced_at).toLocaleString()}
                  </Text>
                )}
                {!!value.sync_error && (
                  <Text style={styles.error}>{value.sync_error}</Text>
                )}
              </View>
            ))}
            <View style={n.privacyNote}>
              <ShieldCheck size={20} color={color.lime} />
              <Text style={[styles.small, { flex: 1 }]}>
                No social passwords, contact uploads or automatic invites. A
                profile link never gives Ziipa permission to post.
              </Text>
            </View>
          </>
        )}
        {(tab === "feed" || tab === "people") && (
          <>
            <View style={styles.between}>
              <Text style={[styles.heading, { fontSize: 21 }]}>
                {tab === "feed" ? "Across your networks" : "People you follow"}
              </Text>
              <SmallAction
                title="Sync now"
                icon={RefreshCw}
                disabled={!!busy}
                onPress={() => void run("sync-all", () => sync())}
              />
            </View>
            <Field
              label={tab === "feed" ? "Search synced posts" : "Find people"}
              placeholder={
                tab === "feed" ? "Search your network media" : "Name or handle"
              }
              value={search}
              onChangeText={setSearch}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              <SmallAction
                title="All networks"
                icon={Globe2}
                onPress={() => setFilter("all")}
              />
              {linked.map((value) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === value.provider }}
                  key={value.provider}
                  onPress={() => setFilter(value.provider)}
                  style={[
                    n.smallAction,
                    filter === value.provider && n.selectedTab,
                  ]}
                >
                  <NetworkIcon provider={value.provider} small />
                  <Text style={n.smallActionText}>{value.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {tab === "feed" ? (
              media.length ? (
                media.map((item) => (
                  <Pressable
                    key={`${item.provider}-${item.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${item.title || "post"} on ${networkInfo[item.provider].name}`}
                    onPress={() =>
                      void run("open", () =>
                        openPlatform(item.provider, item.url),
                      )
                    }
                    style={n.account}
                  >
                    <View style={styles.row}>
                      <NetworkIcon provider={item.provider} small />
                      <View style={{ flex: 1 }}>
                        <Text style={n.accountName}>{item.author}</Text>
                        <Text style={n.subtle}>@{item.handle}</Text>
                      </View>
                      <ExternalLink size={17} color={color.muted} />
                    </View>
                    {!!item.thumbnail_url && (
                      <Image
                        source={{ uri: item.thumbnail_url }}
                        style={{ height: 190, width: "100%", borderRadius: 18 }}
                        contentFit="cover"
                        accessibilityLabel={
                          item.title || "Network media preview"
                        }
                      />
                    )}
                    <Text style={styles.body} numberOfLines={5}>
                      {item.text || item.title}
                    </Text>
                    <Text style={n.subtle}>
                      {networkInfo[item.provider].name} · {item.kind} · Opens
                      original
                    </Text>
                  </Pressable>
                ))
              ) : (
                <Empty
                  title="Bring your feeds together"
                  body="Link a Bluesky public profile, then sync to see recent posts here. Other networks remain shortcuts until their integration is enabled. Nothing is scraped from private feeds."
                />
              )
            ) : people.length ? (
              people.map((person) => (
                <View key={`${person.provider}-${person.id}`} style={n.account}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${person.name}'s profile`}
                    onPress={() =>
                      void run("open", () =>
                        openPlatform(person.provider, person.profile_url),
                      )
                    }
                    style={styles.row}
                  >
                    {person.avatar_url ? (
                      <Image
                        source={{ uri: person.avatar_url }}
                        style={n.avatar}
                        accessibilityLabel={person.name}
                      />
                    ) : (
                      <View style={[n.avatar, n.placeholderAvatar]}>
                        <Users size={23} color={color.muted} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={n.accountName}>
                        {person.name || person.handle}
                      </Text>
                      <Text style={styles.small} numberOfLines={1}>
                        @{person.handle}
                      </Text>
                    </View>
                    <ArrowUpRight size={19} color={color.muted} />
                  </Pressable>
                  <Text style={n.subtle}>
                    Following on {networkInfo[person.provider].name} · not a
                    Ziipa friendship
                  </Text>
                </View>
              ))
            ) : (
              <Empty
                title="Your people, in view"
                body="Supported public following appears after sync. Platforms do not expose one universal friend list. Importing following does not follow people in Ziipa or invite them."
              />
            )}
            {tab === "people" && (
              <View style={[n.account, { backgroundColor: "#27153D" }]}>
                <Text style={[styles.heading, { fontSize: 22 }]}>
                  Bring your people to Ziipa
                </Text>
                <Text style={styles.small}>
                  Share an invitation yourself. Ziipa never messages your
                  contacts automatically.
                </Text>
                <Action
                  title="Share invite"
                  icon={Share2}
                  disabled={!!busy}
                  onPress={() => void run("invite", invite)}
                />
                <SmallAction
                  title="Copy invite link"
                  icon={Copy}
                  onPress={() =>
                    void run("copy", () =>
                      copy(
                        hub.invite_url.startsWith("https://")
                          ? hub.invite_url
                          : "https://ziipa.com",
                      ),
                    )
                  }
                />
              </View>
            )}
          </>
        )}
        {tab === "outbox" && (
          <>
            <View style={styles.between}>
              <Text style={[styles.heading, { fontSize: 21 }]}>
                Create once. Share onward.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create new media"
                onPress={() => navigation.navigate("Composer")}
                style={n.roundButton}
              >
                <Plus size={23} color="white" />
              </Pressable>
            </View>
            <Action
              title="Open direct publishing & receipts"
              icon={Send}
              onPress={() => navigation.navigate("Publishing")}
            />
            <Notice text="Direct publishing uses separately authorized destination accounts. The options below share your original media manually, so you can finish posting in the destination app." />
            {ownMedia.length ? (
              ownMedia.map((item) => (
                <View key={item.id} style={n.account}>
                  <View style={styles.row}>
                    <Cover
                      item={item}
                      style={{ width: 65, height: 76, borderRadius: 13 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={n.accountName} numberOfLines={2}>
                        {item.title}
                      </Text>
                      <Text style={styles.small}>
                        {item.demo
                          ? "Sample draft"
                          : item.visibility === "published"
                            ? "Published in Ziipa"
                            : "Private Ziipa draft"}
                      </Text>
                      <Text style={n.subtle}>
                        {item.distribution_targets?.length || 0} external
                        destinations selected
                      </Text>
                    </View>
                  </View>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    <SmallAction
                      title={`Edit ${item.title}`}
                      icon={Video}
                      onPress={() => navigation.navigate("Composer", { item })}
                    />
                    <SmallAction
                      title={`Share ${item.title}`}
                      icon={Share2}
                      onPress={() => {
                        setSharingItem(item);
                        setError("");
                        setNotice("");
                      }}
                    />
                  </View>
                  {!!item.distribution?.length &&
                    item.distribution.map((job) => (
                      <Text key={job.id} style={styles.small}>
                        {networkInfo[job.provider].name} ·{" "}
                        {job.status.replaceAll("_", " ")}
                      </Text>
                    ))}
                </View>
              ))
            ) : (
              <Empty
                title="Your publishing desk"
                body="Record or upload a creation. Save it to Ziipa, select destinations and return here to share the original and track delivery."
              />
            )}
            <Text style={[styles.heading, { fontSize: 21 }]}>
              Delivery activity
            </Text>
            {data.distributions.length ? (
              data.distributions.map((job) => (
                <View key={job.id} style={n.account}>
                  <View style={styles.row}>
                    <NetworkIcon provider={job.provider} small />
                    <Text style={n.accountName}>
                      {networkInfo[job.provider].name}
                    </Text>
                  </View>
                  <Text style={n.textLink}>
                    {job.status.replaceAll("_", " ")}
                  </Text>
                  <Text style={styles.small}>{job.detail}</Text>
                  {job.external_url && (
                    <SmallAction
                      title="View published post"
                      icon={ArrowUpRight}
                      onPress={() =>
                        void run("open", () =>
                          openPlatform(job.provider, job.external_url),
                        )
                      }
                    />
                  )}
                </View>
              ))
            ) : (
              <Text style={styles.small}>
                No external deliveries yet. Opening an app or share sheet is
                never counted as a published post.
              </Text>
            )}
          </>
        )}
        {!!busy && (
          <Text accessibilityLiveRegion="polite" style={styles.small}>
            Working…{" "}
            {busy.startsWith("sync")
              ? "Refreshing supported networks."
              : "Please wait."}
          </Text>
        )}
      </ScrollView>
      {!!account && selected && (
        <Sheet
          title={account.name}
          onClose={() => {
            if (!busy) setSelected(null);
          }}
        >
          <View style={styles.row}>
            <NetworkIcon provider={selected} />
            <View style={{ flex: 1 }}>
              <Text style={n.accountName}>{networkInfo[selected].scope}</Text>
              <Text style={styles.small}>
                {account.status === "connected"
                  ? "Provider authorization active"
                  : "Public profile shortcut"}
              </Text>
            </View>
          </View>
          <Text style={styles.body}>
            {account.connection_notice || networkInfo[selected].sync}
          </Text>
          <Field
            label="Profile URL or handle"
            value={linkValue}
            onChangeText={setLinkValue}
            placeholder={networkInfo[selected].placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={350}
            editable={!busy}
          />
          <Action
            title="Save public profile"
            icon={Link2}
            disabled={!linkValue.trim() || !!busy}
            onPress={() => void run("link", saveLink)}
          />
          <Action
            title={
              guest
                ? "Sign in to authorize account"
                : "Connect account with provider"
            }
            icon={ShieldCheck}
            secondary
            disabled={!!busy}
            onPress={() => void run("connect", connect)}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <SmallAction
              title="Open platform"
              icon={ArrowUpRight}
              disabled={!!busy}
              onPress={() =>
                void run("open", () =>
                  openPlatform(selected, account.profile_url || undefined),
                )
              }
            />
            {account.can_sync && (
              <SmallAction
                title="Sync public content"
                icon={RefreshCw}
                disabled={!!busy}
                onPress={() => void run("sync", () => sync(selected))}
              />
            )}
          </View>
          {!!notice && <Notice text={notice} />}
          {!!error && <Notice text={error} error />}
          {requirements.length > 0 && (
            <View style={n.account}>
              <Text style={styles.label}>Integration setup required</Text>
              {requirements.map((text, index) => (
                <Text key={text} style={styles.small}>
                  {index + 1}. {text}
                </Text>
              ))}
            </View>
          )}
          {account.status !== "disconnected" &&
            (confirmDisconnect ? (
              <>
                <Notice text="Remove this link and cached network content from Ziipa? This does not delete external posts, unfollow people or close your social account." />
                <Action
                  title="Remove from Ziipa"
                  icon={Unlink}
                  danger
                  disabled={!!busy}
                  onPress={() => void run("disconnect", disconnect)}
                />
                <SmallAction
                  title="Keep account"
                  icon={Check}
                  onPress={() => setConfirmDisconnect(false)}
                />
              </>
            ) : (
              <SmallAction
                title="Remove network link"
                icon={Unlink}
                disabled={!!busy}
                onPress={() => setConfirmDisconnect(true)}
              />
            ))}
        </Sheet>
      )}
      {!!sharingItem && (
        <Sheet
          title="Share to your networks"
          onClose={() => {
            if (!busy) closeShare();
          }}
        >
          <Text style={styles.heading}>{sharingItem.title}</Text>
          <Text style={styles.small}>
            Export your original clip, photo or audio and finish posting in
            another app. Ziipa’s overlay, trim and music settings are not burned
            into this original file.
          </Text>
          {sharingItem.demo ? (
            <Notice text="Sample artwork is for preview only. Record or upload your own media and sign in to save it before exporting." />
          ) : (
            <Action
              title={
                prepared
                  ? Platform.OS === "web"
                    ? "Share / download original"
                    : "Open media share sheet"
                  : "Prepare original media"
              }
              icon={prepared ? Share2 : Download}
              busy={busy === "prepare" || busy === "share"}
              disabled={!!busy}
              onPress={() =>
                void run(
                  prepared ? "share" : "prepare",
                  prepared ? sharePrepared : prepare,
                )
              }
            />
          )}
          <Text selectable style={styles.small}>
            {creationCaption(sharingItem)}
          </Text>
          <Action
            title="Copy caption"
            icon={Copy}
            secondary
            disabled={!!busy}
            onPress={() =>
              void run("copy", () => copy(creationCaption(sharingItem)))
            }
          />
          <Text style={styles.label}>Continue in a destination</Text>
          <View style={{ gap: 8 }}>
            {hub.providers
              .filter(
                (value) =>
                  !sharingItem.distribution_targets?.length ||
                  sharingItem.distribution_targets.includes(value.provider),
              )
              .map((value) => (
                <SmallAction
                  key={value.provider}
                  title={`Open ${value.name}`}
                  icon={ArrowUpRight}
                  disabled={!!busy}
                  onPress={() =>
                    void run("open", () =>
                      openPlatform(
                        value.provider,
                        value.profile_url || undefined,
                      ),
                    )
                  }
                />
              ))}
          </View>
          {!!notice && <Notice text={notice} />}
          {!!error && <Notice text={error} error />}
          <Text style={n.subtle}>
            Sharing hands control to you. Ziipa cannot verify a manual post and
            will not mark it delivered.
          </Text>
        </Sheet>
      )}
    </View>
  );
}

const n = StyleSheet.create({
  hero: {
    padding: 21,
    borderRadius: 26,
    backgroundColor: "#251438",
    borderWidth: 1,
    borderColor: "#573375",
    gap: 16,
  },
  networkIcon: {
    borderRadius: 25,
    borderWidth: 1,
    borderColor: "#FFFFFF30",
    justifyContent: "center",
    alignItems: "center",
  },
  initial: { color: "white", fontFamily: font.bold, fontSize: 17 },
  statRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderColor: "#56356B",
    paddingTop: 16,
  },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { color: "white", fontFamily: font.semibold, fontSize: 24 },
  statLabel: { fontFamily: font.regular, color: "#BFAACE", fontSize: 12 },
  tabs: {
    borderRadius: 26,
    padding: 6,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: "#0D0915",
    flexDirection: "row",
    gap: 4,
  },
  tab: {
    flex: 1,
    gap: 5,
    paddingVertical: 12,
    borderRadius: 21,
    alignItems: "center",
  },
  selectedTab: { backgroundColor: color.purple, borderColor: "#966CD3" },
  tabText: { color: color.muted, fontFamily: font.medium, fontSize: 12 },
  previewNote: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    paddingHorizontal: 4,
  },
  textLink: { color: "#CAABFA", fontFamily: font.semibold, fontSize: 13 },
  account: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 22,
    padding: 17,
    gap: 13,
    backgroundColor: "#1B1526",
  },
  accountName: { color: color.text, fontFamily: font.semibold, fontSize: 18 },
  badge: { flexDirection: "row", gap: 7, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { color: color.muted, fontFamily: font.medium, fontSize: 11 },
  subtle: {
    color: color.faint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  smallAction: {
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: "#241B31",
    borderRadius: 19,
    minHeight: 40,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  smallActionText: { color: color.text, fontFamily: font.medium, fontSize: 12 },
  privacyNote: { flexDirection: "row", gap: 12, padding: 10 },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  placeholderAvatar: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.raised,
  },
  roundButton: {
    height: 43,
    width: 43,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.purple,
  },
});
