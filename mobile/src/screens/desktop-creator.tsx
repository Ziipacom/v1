import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  CalendarDays,
  ChevronRight,
  Clapperboard,
  Clock3,
  FileVideo,
  FolderOpen,
  LayoutGrid,
  Link2,
  List,
  Network,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { Cover, Notice, allCategories } from "../components/ui";
import { useDesktopLayout } from "../components/desktop-layout";
import { useZiipa } from "../provider";
import { themedStyles, themeValue, color, font } from "../theme";
import type { Category, RootStack } from "../lib/types";
import {
  creatorConnectionLabel,
  creatorLibrary,
  filterCreatorLibrary,
  type CreatorLibraryEntry,
  type CreatorLibraryStatus,
} from "../lib/desktop-creator";

type Props = NativeStackScreenProps<RootStack, "CreatorStudio">;
type ButtonProps = {
  title: string;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  lime?: boolean;
  disabled?: boolean;
};
const statuses: { id: CreatorLibraryStatus; title: string }[] = [
  { id: "all", title: "All creations" },
  { id: "draft", title: "Drafts" },
  { id: "published", title: "Published" },
  { id: "saved", title: "Saved" },
  { id: "hidden", title: "Hidden" },
];

function Button({
  title,
  onPress,
  icon: Icon,
  primary,
  lime,
  disabled,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary && s.primaryButton,
        lime && s.limeButton,
        { opacity: disabled ? 0.5 : pressed ? 0.75 : 1 },
      ]}
    >
      {Icon && (
        <Icon
          size={17}
          color={lime ? color.onLime : primary ? color.onAccent : color.text}
          strokeWidth={1.7}
        />
      )}
      <Text style={[s.buttonText, primary && { color: color.onAccent }, lime && { color: color.onLime }]}>{title}</Text>
    </Pressable>
  );
}

function SectionLink({
  title,
  onPress,
}: Pick<ButtonProps, "title" | "onPress">) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.sectionLink, { opacity: pressed ? 0.65 : 1 }]}
    >
      <Text style={s.linkText}>{title}</Text>
      <ArrowUpRight size={16} color="#C2A5F1" />
    </Pressable>
  );
}

function Status({
  entry,
  guest,
}: {
  entry: CreatorLibraryEntry;
  guest: boolean;
}) {
  const published = entry.item.visibility === "published";
  const hidden = entry.item.visibility === "hidden";
  const label = guest
    ? "Sample"
    : hidden
      ? "Hidden"
      : published
        ? "Published"
        : "Private draft";
  return (
    <View
      style={[s.status, published && !guest && s.published, hidden && s.hidden]}
    >
      <View
        style={[
          s.statusDot,
          {
            backgroundColor: hidden
              ? "#F3B6C7"
              : published && !guest
                ? color.lime
                : "#C4A1F5",
          },
        ]}
      />
      <Text style={[s.statusText, published && !guest && { color: themeValue("#D2EEA5", color.muted) }]}>
        {label}
      </Text>
    </View>
  );
}

function createdLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value)))
    return "Saved in your workspace";
  return `Created ${new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function categoryTitle(category: Category) {
  return allCategories.find((entry) => entry.id === category)?.title || "Media";
}

export function CreatorStudioScreen({ route, navigation }: Props) {
  const { data, session, guest, refreshing, error, refresh } = useZiipa();
  const { contentWidth } = useDesktopLayout();
  const tab = route.params?.tab || "overview";
  const [query, setQuery] = useState(route.params?.query || "");
  const [category, setCategory] = useState<Category | "all">(
    route.params?.category || "all",
  );
  const [status, setStatus] = useState<CreatorLibraryStatus>("all");
  const [mode, setMode] = useState<"grid" | "list">("grid");
  useEffect(() => setQuery(route.params?.query || ""), [route.params?.query]);
  useEffect(
    () => setCategory(route.params?.category || "all"),
    [route.params?.category],
  );
  const entries = useMemo(
    () => creatorLibrary(data, session?.user.id ?? null, guest),
    [data, session?.user.id, guest],
  );
  const own = entries.filter((entry) => entry.owned);
  const drafts = own.filter((entry) => entry.item.visibility === "draft");
  const published = own.filter(
    (entry) => entry.item.visibility === "published",
  );
  const connected = data.connections.filter(
    (entry) => entry.status === "connected",
  );
  const queued = data.distributions.filter(
    (entry) => entry.status === "queued",
  );
  const needsAttention = data.distributions.filter((entry) =>
    [
      "failed",
      "connection_required",
      "provider_setup_required",
      "unsupported_media",
    ].includes(entry.status),
  );
  const filtered = useMemo(
    () => filterCreatorLibrary(entries, query, category, status),
    [entries, query, category, status],
  );
  const wide = contentWidth >= 1080;
  const columns = contentWidth >= 1240 ? 3 : contentWidth >= 780 ? 2 : 1;
  const pagePadding = contentWidth >= 1100 ? 36 : 24;
  const firstName = session?.user.name.trim().split(/\s+/)[0];
  const create = () => navigation.navigate("Composer");
  function library(nextStatus: CreatorLibraryStatus = "all") {
    setStatus(nextStatus);
    navigation.navigate("CreatorStudio", { tab: "library" });
  }
  function search(value: string) {
    const next = value.slice(0, 160);
    setQuery(next);
    navigation.setParams({ query: next || undefined });
  }
  function chooseCategory(value: Category | "all") {
    setCategory(value);
    navigation.setParams({ category: value === "all" ? undefined : value });
  }
  function clearFilters() {
    setStatus("all");
    setQuery("");
    setCategory("all");
    navigation.setParams({ query: undefined, category: undefined });
  }
  function open(entry: CreatorLibraryEntry) {
    if (entry.item.visibility === "hidden")
      navigation.navigate("Post", { item: entry.item });
    else if (entry.owned && entry.item.visibility === "draft")
      navigation.navigate("Composer", { item: entry.item });
    else
      navigation.navigate("Watch", {
        itemId: entry.item.id,
        category: entry.item.category,
      });
  }
  function renderMedia(entry: CreatorLibraryEntry, list = false) {
    const { item } = entry;
    const editable = entry.owned && item.visibility !== "hidden";
    return (
      <View key={item.id} style={[s.mediaCard, list && s.mediaList]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.visibility === "hidden" ? "Review" : entry.owned && item.visibility === "draft" ? "Open draft" : "Watch"} ${item.title}`}
          onPress={() => open(entry)}
          style={[s.mediaImage, list && s.listImage]}
        >
          <Cover item={item} style={{ flex: 1 }} />
          {!list && (
            <View style={s.imageStatus}>
              <Status entry={entry} guest={guest} />
            </View>
          )}
          <View
            style={[
              s.mediaPlay,
              list && { width: 27, height: 27, borderRadius: 14 },
            ]}
          >
            {item.visibility === "hidden" ? (
              <ShieldCheck size={list ? 13 : 17} color="white" />
            ) : item.visibility === "draft" ? (
              <Pencil size={list ? 13 : 17} color="white" />
            ) : (
              <Play size={list ? 13 : 17} color="white" fill="white" />
            )}
          </View>
        </Pressable>
        <View style={[s.mediaDetails, list && { flex: 1, paddingVertical: 8 }]}>
          <View
            style={[
              s.row,
              { justifyContent: "space-between", alignItems: "flex-start" },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => open(entry)}
              style={{ flex: 1, minWidth: 0 }}
            >
              <Text numberOfLines={1} style={s.mediaTitle}>
                {item.title}
              </Text>
            </Pressable>
            {entry.saved && (
              <Bookmark
                accessibilityLabel="Saved"
                size={15}
                color="#BE9BEF"
                fill="#BE9BEF30"
              />
            )}
          </View>
          <Text numberOfLines={1} style={s.mediaMeta}>
            {categoryTitle(item.category)} ·{" "}
            {entry.owned ? createdLabel(item.created_at) : `By ${item.creator}`}
          </Text>
          <View
            style={[
              s.row,
              { justifyContent: "space-between", flexWrap: "wrap", gap: 9 },
            ]}
          >
            {list ? (
              <Status entry={entry} guest={guest} />
            ) : (
              <Text style={s.ownership}>
                {guest
                  ? "Sample workspace"
                  : entry.owned
                    ? "Your creation"
                    : "Saved from Discover"}
              </Text>
            )}
            <View style={[s.row, { gap: 12 }]}>
              {editable && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${item.title}`}
                  onPress={() => navigation.navigate("Composer", { item })}
                  style={s.inlineAction}
                >
                  <Pencil size={13} color="#C6B1E7" />
                  <Text style={s.inlineText}>Edit</Text>
                </Pressable>
              )}
              {editable && !guest && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    item.category === "nft"
                      ? `Mint ${item.title} in Wallet`
                      : item.category === "live"
                        ? `Prepare broadcast for ${item.title}`
                        : `Review publishing for ${item.title}`
                  }
                  onPress={() => {
                    if (item.category === "nft")
                      navigation.navigate("Utility", { kind: "wallet", item });
                    else if (item.category === "live")
                      navigation.navigate("Live", { tab: "broadcast" });
                    else navigation.navigate("Publishing", { itemId: item.id });
                  }}
                  style={s.inlineAction}
                >
                  {item.category === "nft" ? (
                    <Sparkles size={13} color="#C6B1E7" />
                  ) : item.category === "live" ? (
                    <Radio size={13} color="#C6B1E7" />
                  ) : (
                    <Send size={13} color="#C6B1E7" />
                  )}
                  <Text style={s.inlineText}>
                    {item.category === "nft"
                      ? "Mint in Wallet"
                      : item.category === "live"
                        ? "Prepare broadcast"
                        : "Review publishing"}
                  </Text>
                </Pressable>
              )}
              {!editable && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Details for ${item.title}`}
                  onPress={() => navigation.navigate("Post", { item })}
                  style={s.inlineAction}
                >
                  <Text style={s.inlineText}>Details</Text>
                  <ChevronRight size={13} color="#C6B1E7" />
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </View>
    );
  }
  return (
    <ScrollView
      style={s.screen}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[s.page, { paddingHorizontal: pagePadding }]}
    >
      <View
        style={[
          s.row,
          { justifyContent: "space-between", flexWrap: "wrap", gap: 16 },
        ]}
      >
        <View style={{ gap: 5 }}>
          <Text style={s.eyebrow}>
            {tab === "library" ? "YOUR MEDIA, TOGETHER" : "YOUR CREATOR STUDIO"}
          </Text>
          <Text style={s.pageTitle}>
            {tab === "library"
              ? "Your library"
              : guest
                ? "Explore your creative workspace"
                : firstName
                  ? `Welcome back, ${firstName}.`
                  : "Welcome to your Studio."}
          </Text>
          <Text style={s.description}>
            {tab === "library"
              ? "Creations, drafts and saved inspiration. Ready for your next idea."
              : "A home for your ideas, your media and everything you make next."}
          </Text>
        </View>
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh your Studio library"
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
            disabled={refreshing}
            onPress={() => void refresh()}
            style={s.refresh}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.lime} />
            ) : (
              <RefreshCw size={17} color={color.muted} />
            )}
          </Pressable>
          <Button title="New creation" icon={Plus} primary onPress={create} />
        </View>
      </View>
      <View style={s.tabs} accessibilityRole="tablist">
        {(
          [
            ["overview", "Overview"],
            ["library", "Library"],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            onPress={() => navigation.navigate("CreatorStudio", { tab: value })}
            style={[s.tab, tab === value && s.activeTab]}
          >
            <Text style={[s.tabText, tab === value && { color: color.text }]}>
              {label}
            </Text>
            {value === "library" && (
              <View style={s.tabCount}>
                <Text style={s.tabCountText}>{entries.length}</Text>
              </View>
            )}
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Text style={s.snapshotLabel}>
          {guest ? "Sample workspace" : "Your Studio snapshot"}
        </Text>
      </View>
      {guest && (
        <Notice text="This is a sample workspace. Sign in to create your own library, connect accounts and save to Ziipa." />
      )}
      {!!error && <Notice error text={error} />}
      {tab === "overview" ? (
        <>
          <View
            style={{
              padding: 22,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: color.border,
              backgroundColor: themeValue("#1A1525", color.panel),
              gap: 16,
            }}
          >
            <View
              style={[
                s.row,
                { justifyContent: "space-between", flexWrap: "wrap", gap: 16 },
              ]}
            >
              <View style={{ gap: 5 }}>
                <Text style={[s.sectionTitle, { fontSize: 21 }]}>
                  Create and edit
                </Text>
                <Text style={s.description}>
                  Upload or record media, trim clips, add captions, text
                  overlays and music.
                </Text>
              </View>
              <View style={[s.row, { flexWrap: "wrap", gap: 10 }]}>
                <Button
                  title="Open editor"
                  icon={Pencil}
                  primary
                  onPress={create}
                />
                <Button title="Upload media" icon={Upload} onPress={create} />
                <Button
                  title="Live studio"
                  icon={Radio}
                  onPress={() =>
                    navigation.navigate("Live", { tab: "broadcast" })
                  }
                />
              </View>
            </View>
            <Text style={s.heroFootnote}>
              Open any creation in your library and choose Edit to continue.
              Your source stays unchanged; save privately before rendering or
              publishing.
            </Text>
          </View>
          <View style={s.stats}>
            {[
              {
                title: guest ? "Sample drafts" : "Private drafts",
                value: drafts.length,
                icon: Pencil,
                hint: "Ideas in progress",
                action: () => library("draft"),
              },
              {
                title: "Published on Ziipa",
                value: published.length,
                icon: Clapperboard,
                hint: "From your library",
                action: () => library("published"),
              },
              {
                title: "Authorized accounts",
                value: connected.length,
                icon: Link2,
                hint: "Check each network’s capabilities",
                action: () =>
                  navigation.navigate("Connections", { tab: "accounts" }),
              },
              {
                title: "Queued distributions",
                value: queued.length,
                icon: Send,
                hint: "Review your publishing outbox",
                action: () =>
                  navigation.navigate("Connections", { tab: "outbox" }),
              },
            ].map(({ title, value, icon: Icon, hint, action }) => (
              <Pressable
                key={title}
                accessibilityRole="button"
                accessibilityLabel={`${value} ${title}. ${hint}`}
                onPress={action}
                style={({ pressed }) => [
                  s.stat,
                  {
                    flexBasis: contentWidth >= 1000 ? "22%" : "44%",
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={s.statTitle}>{title}</Text>
                  <Icon size={18} color="#B999E8" strokeWidth={1.5} />
                </View>
                <Text style={s.statValue}>{value}</Text>
                <Text style={s.statHint}>{hint}</Text>
              </Pressable>
            ))}
          </View>
          <View
            style={{
              flexDirection: wide ? "row" : "column",
              gap: 24,
              alignItems: "stretch",
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 20 }}>
              <View
                style={[
                  s.row,
                  { justifyContent: "space-between", flexWrap: "wrap" },
                ]}
              >
                <View style={{ gap: 5 }}>
                  <Text style={s.sectionTitle}>Keep the ideas moving</Text>
                  <Text style={s.description}>
                    Your latest drafts, ready when you are.
                  </Text>
                </View>
                <SectionLink title="View library" onPress={() => library()} />
              </View>
              {drafts.length ? (
                <View style={s.mediaGrid}>
                  {drafts.slice(0, wide ? 2 : 3).map((entry) => (
                    <View
                      key={entry.item.id}
                      style={{
                        width:
                          wide || columns === 2
                            ? "48.5%"
                            : columns === 3
                              ? "32%"
                              : "100%",
                      }}
                    >
                      {renderMedia(entry)}
                    </View>
                  ))}
                </View>
              ) : (
                <View style={s.emptyDrafts}>
                  <View style={s.emptyArt}>
                    <FileVideo size={34} color="#C0A0EC" strokeWidth={1.25} />
                    <View style={s.emptyPlus}>
                      <Plus size={13} color="#1D2A0E" />
                    </View>
                  </View>
                  <Text style={s.emptyTitle}>
                    Make room for your first idea.
                  </Text>
                  <Text style={s.emptyText}>
                    Upload a clip, an image or a sound. Your creation starts as
                    a private draft, with space to make it yours.
                  </Text>
                  <Button
                    title="Create your first draft"
                    icon={Plus}
                    primary
                    onPress={create}
                  />
                  <View style={[s.row, { gap: 5 }]}>
                    <ShieldCheck size={12} color="#A693BB" />
                    <Text style={s.privacyHint}>
                      Private until you choose to publish
                    </Text>
                  </View>
                </View>
              )}
              <View style={s.planCard}>
                <View style={s.planIcon}>
                  <CalendarDays size={24} color="#D0B5F5" />
                </View>
                <View style={{ flex: 1, minWidth: 170, gap: 6 }}>
                  <Text style={s.sectionTitle}>Good ideas deserve a plan.</Text>
                  <Text style={s.description}>
                    Bring releases, campaigns and live reminders into your
                    calendar.
                  </Text>
                </View>
                <Button
                  title="Open calendar"
                  icon={ArrowUpRight}
                  onPress={() => navigation.navigate("Calendar")}
                />
              </View>
            </View>
            <View style={{ width: wide ? 310 : "100%", gap: 22 }}>
              <View style={s.networkPanel}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={s.sectionTitle}>Your networks</Text>
                  <Network size={19} color="#B595DB" />
                </View>
                <Text style={s.description}>
                  Your accounts, connected on your terms.
                </Text>
                {data.connections.length ? (
                  data.connections.map((connection) => (
                    <Pressable
                      key={connection.provider}
                      accessibilityRole="button"
                      accessibilityLabel={`${connection.name}. ${creatorConnectionLabel(connection)}. Manage account`}
                      onPress={() =>
                        navigation.navigate("Connections", { tab: "accounts" })
                      }
                      style={({ pressed }) => [
                        s.networkRow,
                        { opacity: pressed ? 0.65 : 1 },
                      ]}
                    >
                      <View
                        style={[
                          s.networkMark,
                          connection.status === "connected" && {
                            borderColor: themeValue("#637A3B", color.border),
                            backgroundColor: themeValue("#26301C", color.panel),
                          },
                        ]}
                      >
                        <Text style={s.networkLetter}>
                          {connection.name.charAt(0)}
                        </Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                        <Text numberOfLines={1} style={s.networkName}>
                          {connection.name}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={[
                            s.networkState,
                            connection.status === "connected" && {
                              color: themeValue("#C4D8A2", color.muted),
                            },
                          ]}
                        >
                          {creatorConnectionLabel(connection)}
                        </Text>
                      </View>
                      <ChevronRight size={15} color="#8E7B9F" />
                    </Pressable>
                  ))
                ) : (
                  <View style={{ paddingVertical: 14, gap: 8 }}>
                    <Link2 size={25} color="#9D80C3" />
                    <Text style={s.emptyText}>
                      Connect an account to review its supported publishing and
                      sync options.
                    </Text>
                  </View>
                )}
                <SectionLink
                  title="Manage networks"
                  onPress={() =>
                    navigation.navigate("Connections", { tab: "accounts" })
                  }
                />
                <Text style={s.panelFootnote}>
                  Account authorization is separate from media, provider and
                  delivery checks.
                </Text>
              </View>
              <LinearGradient
                colors={["#2D2044", "#1D1728"]}
                style={s.assistantCard}
              >
                <View style={s.row}>
                  <Sparkles size={21} color={color.lime} />
                  <Text style={s.sectionTitle}>A little creative backup.</Text>
                </View>
                <Text style={s.description}>
                  Plan an idea or organize your workspace with Ziipa Assistant.
                  Review actions before they run.
                </Text>
                <SectionLink
                  title="Open Assistant"
                  onPress={() =>
                    navigation.navigate("MediaOS", { tab: "Assistant" })
                  }
                />
              </LinearGradient>
            </View>
          </View>
          {!!needsAttention.length && (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("Connections", { tab: "outbox" })
              }
              style={s.attention}
            >
              <Clock3 size={20} color="#E6C79B" />
              <View style={{ flex: 1 }}>
                <Text style={s.attentionTitle}>
                  {needsAttention.length} distribution
                  {needsAttention.length === 1 ? " needs" : "s need"} a closer
                  look
                </Text>
                <Text style={s.description}>
                  Review connection, media or delivery requirements in your
                  outbox. Nothing is retried from this overview.
                </Text>
              </View>
              <ChevronRight size={18} color="#E6C79B" />
            </Pressable>
          )}
          <View style={{ gap: 16 }}>
            <View
              style={[
                s.row,
                { justifyContent: "space-between", flexWrap: "wrap" },
              ]}
            >
              <Text style={s.sectionTitle}>
                A workspace for the whole process
              </Text>
              <SectionLink
                title="Promotion tools"
                onPress={() =>
                  navigation.navigate("Utility", { kind: "promote" })
                }
              />
            </View>
            <View style={s.toolGrid}>
              {[
                {
                  title: "Plan a campaign",
                  body: "Bring creation and distribution into one reviewed workflow.",
                  icon: CalendarDays,
                  action: () => navigation.navigate("Campaigns"),
                },
                {
                  title: "Live & recordings",
                  body: "Prepare a broadcast, or return to your private recordings.",
                  icon: Radio,
                  action: () =>
                    navigation.navigate("Live", { tab: "broadcast" }),
                },
                {
                  title: "Recordings & clips",
                  body: "Review imported recordings and their clip-processing status.",
                  icon: Clapperboard,
                  action: () => navigation.navigate("Recordings"),
                },
                {
                  title: "Wallet & ownership",
                  body: "Manage wallet connections, collectibles and rewards.",
                  icon: ShieldCheck,
                  action: () =>
                    navigation.navigate("Utility", { kind: "wallet" }),
                },
              ].map(({ title, body, icon: Icon, action }) => (
                <Pressable
                  key={title}
                  accessibilityRole="button"
                  onPress={action}
                  style={({ pressed }) => [
                    s.tool,
                    {
                      flexBasis: contentWidth >= 1100 ? "22%" : "44%",
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <View style={[s.row, { justifyContent: "space-between" }]}>
                    <Icon size={23} color="#B999E8" strokeWidth={1.4} />
                    <ArrowUpRight size={17} color="#7F6D93" />
                  </View>
                  <Text style={s.toolTitle}>{title}</Text>
                  <Text style={s.toolBody}>{body}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </>
      ) : (
        <>
          <View style={s.libraryToolbar}>
            <View style={s.search}>
              <Search size={18} color="#A58EBB" />
              <TextInput
                accessibilityLabel="Search your media library"
                placeholder="Search titles, tags or creators…"
                placeholderTextColor="#8F7D9F"
                value={query}
                maxLength={160}
                onChangeText={search}
                style={s.searchInput}
              />
              {!!query && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear library search"
                  onPress={() => search("")}
                  style={{ padding: 5 }}
                >
                  <X size={15} color={color.muted} />
                </Pressable>
              )}
            </View>
            <View style={[s.row, { gap: 12 }]}>
              <View style={s.row}>
                <Clock3 size={14} color="#9482A7" />
                <Text style={s.sortLabel}>Newest first</Text>
              </View>
              <View style={s.viewModes}>
                {(
                  [
                    { id: "grid", Icon: LayoutGrid, label: "Grid view" },
                    { id: "list", Icon: List, label: "List view" },
                  ] as const
                ).map(({ id, Icon, label }) => (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: mode === id }}
                    onPress={() => setMode(id)}
                    style={[s.modeButton, mode === id && s.activeMode]}
                  >
                    <Icon
                      size={17}
                      color={mode === id ? color.text : "#93809F"}
                    />
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
          <View style={s.filters} accessibilityRole="tablist">
            {statuses.map((value) => (
              <Pressable
                key={value.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: status === value.id }}
                onPress={() => setStatus(value.id)}
                style={[s.filter, status === value.id && s.activeFilter]}
              >
                <Text
                  style={[
                    s.filterText,
                    status === value.id && { color: themeValue("#D6BCF6", color.text) },
                  ]}
                >
                  {value.title}
                </Text>
                <Text style={s.filterCount}>
                  {value.id === "all"
                    ? entries.length
                    : value.id === "saved"
                      ? entries.filter((e) => e.saved).length
                      : entries.filter((e) => e.item.visibility === value.id)
                          .length}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {[{ id: "all" as const, title: "All types" }, ...allCategories].map(
              ({ id, title }) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: category === id }}
                  onPress={() => chooseCategory(id)}
                  style={[
                    s.categoryFilter,
                    category === id && s.activeCategory,
                  ]}
                >
                  <Text
                    style={[
                      s.categoryText,
                      category === id && { color: themeValue("#D9C9EE", color.text) },
                    ]}
                  >
                    {title}
                  </Text>
                </Pressable>
              ),
            )}
            <View style={{ flex: 1 }} />
            <Text accessibilityLiveRegion="polite" style={s.results}>
              {filtered.length}{" "}
              {filtered.length === 1 ? "creation" : "creations"}
            </Text>
          </View>
          {filtered.length ? (
            mode === "grid" ? (
              <View style={s.mediaGrid}>
                {filtered.map((entry) => (
                  <View
                    key={entry.item.id}
                    style={{
                      width:
                        columns === 3
                          ? "32%"
                          : columns === 2
                            ? "48.8%"
                            : "100%",
                    }}
                  >
                    {renderMedia(entry)}
                  </View>
                ))}
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                {filtered.map((entry) => renderMedia(entry, true))}
              </View>
            )
          ) : (
            <View style={s.libraryEmpty}>
              <View style={s.emptyArt}>
                {entries.length ? (
                  <Search size={35} color="#B494DD" strokeWidth={1.25} />
                ) : (
                  <FolderOpen size={37} color="#B494DD" strokeWidth={1.25} />
                )}
              </View>
              <Text style={s.emptyTitle}>
                {entries.length
                  ? "No creations match just yet."
                  : "Your library starts with an idea."}
              </Text>
              <Text style={s.emptyText}>
                {entries.length
                  ? "Try a different title, type or status. Your original creations and saved inspiration stay right here."
                  : "Upload your own media, save a private draft or bookmark inspiration from Discover. This space grows with you."}
              </Text>
              <View
                style={[s.row, { flexWrap: "wrap", justifyContent: "center" }]}
              >
                <Button
                  title={
                    entries.length ? "Clear filters" : "Create your first draft"
                  }
                  icon={entries.length ? X : Plus}
                  primary
                  onPress={entries.length ? clearFilters : create}
                />
                <Button
                  title="Explore Discover"
                  icon={ArrowRight}
                  onPress={() => navigation.navigate("Main")}
                />
              </View>
            </View>
          )}
          <View
            style={[
              s.libraryFooter,
              { justifyContent: "space-between", flexWrap: "wrap" },
            ]}
          >
            <View
              style={[
                s.row,
                { flex: 1, minWidth: 220, alignItems: "flex-start" },
              ]}
            >
              <ShieldCheck size={15} color="#A08AB8" />
              <Text style={[s.panelFootnote, { flex: 1 }]}>
                Private drafts stay yours. Saved public creations keep their
                original creator. Publishing always opens a separate review.
              </Text>
            </View>
            <SectionLink
              title="Projects & original uploads"
              onPress={() => navigation.navigate("MediaOS", { tab: "Library" })}
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = themedStyles(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  page: {
    width: "100%",
    maxWidth: 1500,
    alignSelf: "center",
    paddingTop: 30,
    paddingBottom: 45,
    gap: 24,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  eyebrow: {
    color: themeValue("#B09AC7", color.muted),
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 1.8,
  },
  pageTitle: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 31,
    lineHeight: 38,
    letterSpacing: -0.8,
  },
  description: {
    color: themeValue("#AB9AB9", color.muted),
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
  },
  refresh: {
    height: 41,
    width: 41,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: "center",
    justifyContent: "center",
  },
  button: {
    minHeight: 41,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 11,
    backgroundColor: themeValue("#291E38", color.accentSoft),
    borderWidth: 1,
    borderColor: themeValue("#51405F", color.border),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryButton: { backgroundColor: color.purple, borderColor: "#7D47BD" },
  limeButton: { backgroundColor: color.lime, borderColor: "#BDEA68" },
  buttonText: { color: color.text, fontFamily: font.semibold, fontSize: 13 },
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 25,
    borderBottomWidth: 1,
    borderBottomColor: "#31263E",
    minHeight: 45,
  },
  tab: {
    minHeight: 45,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    paddingBottom: 12,
    paddingTop: 7,
  },
  activeTab: { borderBottomColor: "#A477DF" },
  tabText: { color: themeValue("#9786A9", color.muted), fontFamily: font.medium, fontSize: 14 },
  tabCount: {
    minWidth: 21,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: themeValue("#2D213C", color.accentSoft),
    alignItems: "center",
  },
  tabCountText: { fontFamily: font.medium, fontSize: 10, color: themeValue("#BEA4DC", color.muted) },
  snapshotLabel: { fontFamily: font.regular, color: themeValue("#887697", color.muted), fontSize: 11 },
  hero: {
    padding: 32,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: themeValue("#593A78", color.border),
    gap: 25,
    overflow: "hidden",
  },
  heroBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#B9E76B0E",
    borderColor: "#BCE58C25",
    borderWidth: 1,
    borderRadius: 30,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  heroBadgeText: {
    fontFamily: font.medium,
    color: "#C5DAAB",
    fontSize: 9,
    letterSpacing: 1.3,
  },
  heroTitle: {
    fontFamily: font.semibold,
    color: themeValue("#F8F3FF", color.text),
    letterSpacing: -1.6,
  },
  heroDescription: {
    fontFamily: font.regular,
    color: themeValue("#C2B1D3", color.muted),
    fontSize: 15,
    lineHeight: 23,
    maxWidth: 460,
  },
  heroFootnote: {
    color: themeValue("#9D88B6", color.muted),
    fontFamily: font.regular,
    fontSize: 10,
    lineHeight: 16,
    maxWidth: 430,
  },
  heroArt: {
    width: 320,
    minHeight: 284,
    position: "relative",
    alignSelf: "center",
  },
  artGlow: {
    position: "absolute",
    top: 30,
    left: 15,
    width: 275,
    height: 220,
    borderRadius: 130,
    backgroundColor: "#824BB728",
    transform: [{ rotate: "-15deg" }],
  },
  artLogo: { position: "absolute", right: 0, top: 0, opacity: 0.9 },
  artCard: {
    position: "absolute",
    width: 174,
    height: 170,
    padding: 16,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#8C65AF66",
    backgroundColor: themeValue("#2B1A42", color.accentSoft),
    boxShadow: "0 16px 30px #07020B40",
    gap: 9,
  },
  artIcon: {
    width: 60,
    height: 65,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  artCardTitle: { fontFamily: font.medium, fontSize: 12, color: themeValue("#E9DCF8", color.text) },
  artLine: {
    width: "75%",
    height: 4,
    backgroundColor: "#C6AFDE26",
    borderRadius: 3,
  },
  artFooter: {
    position: "absolute",
    left: 37,
    bottom: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  artFooterText: { color: themeValue("#BCA8D3", color.muted), fontFamily: font.regular, fontSize: 11 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  stat: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 155,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: themeValue("#372943", color.border),
    backgroundColor: themeValue("#1B1426", color.panel),
    padding: 19,
    gap: 9,
  },
  statTitle: {
    color: themeValue("#BBADC9", color.muted),
    fontFamily: font.medium,
    fontSize: 12,
    flex: 1,
  },
  statValue: {
    color: themeValue("#F4EDFC", color.text),
    fontFamily: font.semibold,
    fontSize: 32,
    lineHeight: 36,
  },
  statHint: {
    fontFamily: font.regular,
    fontSize: 10,
    color: themeValue("#8E7B9F", color.muted),
    lineHeight: 15,
  },
  sectionTitle: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 18,
    letterSpacing: -0.2,
  },
  sectionLink: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    minHeight: 35,
    gap: 5,
  },
  linkText: { fontFamily: font.medium, color: themeValue("#C2A5F1", color.muted), fontSize: 12 },
  mediaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    alignItems: "flex-start",
  },
  mediaCard: {
    borderRadius: 16,
    borderColor: themeValue("#3A2A49", color.border),
    borderWidth: 1,
    backgroundColor: themeValue("#1C1427", color.panel),
    overflow: "hidden",
  },
  mediaImage: { height: 162, width: "100%", backgroundColor: themeValue("#2B203A", color.accentSoft) },
  imageStatus: { position: "absolute", top: 11, left: 11 },
  mediaPlay: {
    position: "absolute",
    bottom: 11,
    right: 11,
    width: 35,
    height: 35,
    borderRadius: 19,
    backgroundColor: "#130D22C4",
    borderWidth: 1,
    borderColor: "#FFFFFF30",
    alignItems: "center",
    justifyContent: "center",
  },
  mediaDetails: { padding: 15, gap: 10, minWidth: 0 },
  mediaTitle: { fontFamily: font.semibold, fontSize: 15, color: themeValue("#F2EAFB", color.text) },
  mediaMeta: {
    fontFamily: font.regular,
    color: themeValue("#A18BAC", color.muted),
    fontSize: 11,
    lineHeight: 17,
  },
  ownership: { fontFamily: font.regular, fontSize: 10, color: themeValue("#877397", color.muted) },
  inlineAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 30,
  },
  inlineText: { fontFamily: font.medium, fontSize: 11, color: themeValue("#C6B1E7", color.muted) },
  status: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#2A1944ED",
    borderWidth: 1,
    borderColor: "#8C65BD55",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  published: { backgroundColor: "#26371DEB", borderColor: "#92AC4B55" },
  hidden: { backgroundColor: "#482437ED", borderColor: "#B46F8155" },
  statusDot: { width: 4, height: 4, borderRadius: 2 },
  statusText: { fontFamily: font.medium, fontSize: 9, color: "#D3C0EB" },
  mediaList: { flexDirection: "row", alignItems: "center", padding: 9, gap: 7 },
  listImage: { width: 132, height: 92, borderRadius: 10 },
  emptyDrafts: {
    minHeight: 307,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: themeValue("#59406D", color.border),
    backgroundColor: "#21152E5C",
    padding: 28,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  emptyArt: {
    width: 73,
    height: 73,
    borderRadius: 23,
    backgroundColor: themeValue("#34204B", color.accentSoft),
    borderWidth: 1,
    borderColor: "#7B4AA14D",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  emptyPlus: {
    position: "absolute",
    right: -4,
    bottom: 3,
    height: 23,
    width: 23,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: themeValue("#20152C", color.border),
    backgroundColor: color.lime,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyTitle: {
    fontFamily: font.semibold,
    fontSize: 21,
    color: themeValue("#EBE0F7", color.text),
    textAlign: "center",
    letterSpacing: -0.3,
  },
  emptyText: {
    fontFamily: font.regular,
    color: themeValue("#A992BC", color.muted),
    fontSize: 13,
    lineHeight: 21,
    maxWidth: 410,
    textAlign: "center",
  },
  privacyHint: { fontFamily: font.regular, fontSize: 10, color: themeValue("#A693BB", color.muted) },
  planCard: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 16,
    padding: 21,
    borderRadius: 17,
    backgroundColor: themeValue("#1E162A", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#3E2C50", color.border),
  },
  planIcon: {
    width: 47,
    height: 47,
    backgroundColor: themeValue("#38224F", color.accentSoft),
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  networkPanel: {
    backgroundColor: themeValue("#1B1425", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#3A2A48", color.border),
    borderRadius: 18,
    padding: 20,
    gap: 12,
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    minHeight: 62,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#35273F",
  },
  networkMark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: themeValue("#2B2038", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#4A355B", color.border),
    alignItems: "center",
    justifyContent: "center",
  },
  networkLetter: { color: themeValue("#CEB6EC", color.muted), fontSize: 16, fontFamily: font.semibold },
  networkName: { fontFamily: font.medium, fontSize: 12, color: themeValue("#E1D5ED", color.text) },
  networkState: {
    fontFamily: font.regular,
    fontSize: 10,
    lineHeight: 14,
    color: themeValue("#9B84AC", color.muted),
  },
  panelFootnote: {
    fontFamily: font.regular,
    fontSize: 10,
    color: themeValue("#927D9F", color.muted),
    lineHeight: 16,
  },
  assistantCard: {
    borderWidth: 1,
    borderColor: themeValue("#63467D", color.border),
    borderRadius: 18,
    padding: 20,
    gap: 14,
  },
  attention: {
    flexDirection: "row",
    alignItems: "center",
    gap: 15,
    borderRadius: 15,
    padding: 19,
    borderWidth: 1,
    borderColor: "#7D613947",
    backgroundColor: "#32251961",
  },
  attentionTitle: {
    color: themeValue("#E6D3B3", color.muted),
    fontFamily: font.medium,
    fontSize: 14,
    marginBottom: 4,
  },
  toolGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  tool: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 180,
    gap: 13,
    padding: 21,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: themeValue("#392A48", color.border),
    backgroundColor: themeValue("#1C1427", color.panel),
  },
  toolTitle: { fontFamily: font.semibold, color: themeValue("#DAD0E6", color.text), fontSize: 15 },
  toolBody: {
    fontFamily: font.regular,
    color: themeValue("#9680A8", color.muted),
    fontSize: 12,
    lineHeight: 19,
  },
  libraryToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  search: {
    flex: 1,
    minWidth: 230,
    maxWidth: 600,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    gap: 11,
    borderRadius: 12,
    backgroundColor: themeValue("#20172C", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#433050", color.border),
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 44,
    fontFamily: font.regular,
    fontSize: 13,
    color: color.text,
  },
  sortLabel: { fontFamily: font.regular, color: themeValue("#9482A7", color.muted), fontSize: 11 },
  viewModes: {
    flexDirection: "row",
    borderRadius: 9,
    padding: 3,
    backgroundColor: themeValue("#21172C", color.panel),
    borderWidth: 1,
    borderColor: themeValue("#3C2B4A", color.border),
  },
  modeButton: {
    width: 34,
    height: 32,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  activeMode: { backgroundColor: themeValue("#4A2B68", color.accentSoft) },
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#32253E",
    paddingBottom: 14,
  },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 35,
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "transparent",
  },
  activeFilter: { backgroundColor: themeValue("#342046", color.accentSoft), borderColor: themeValue("#684285", color.border) },
  filterText: { fontFamily: font.medium, color: themeValue("#9C88AE", color.muted), fontSize: 12 },
  filterCount: { fontFamily: font.regular, color: themeValue("#9D85B2", color.muted), fontSize: 10 },
  categoryFilter: {
    minHeight: 30,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: themeValue("#35263E", color.border),
    backgroundColor: themeValue("#19121F", color.panel),
  },
  activeCategory: { backgroundColor: themeValue("#3C2B4E", color.accentSoft), borderColor: themeValue("#685178", color.border) },
  categoryText: { fontFamily: font.regular, color: themeValue("#927D9F", color.muted), fontSize: 10 },
  results: {
    color: themeValue("#8B789B", color.muted),
    fontFamily: font.regular,
    fontSize: 11,
    paddingVertical: 7,
  },
  libraryEmpty: {
    minHeight: 390,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    padding: 35,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: themeValue("#382947", color.border),
    backgroundColor: "#1B132569",
  },
  libraryFooter: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 10,
  },
}));
