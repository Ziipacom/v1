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
  Bookmark,
  Compass,
  Film,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react-native";
import { useDesktopLayout } from "../components/desktop-layout";
import { DesktopFeaturedGallery } from "../components/desktop-featured-gallery";
import { Action, Cover, Notice, categories } from "../components/ui";
import { inCreativeWorld, searchItems } from "../lib/domain";
import type { Category, Item, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { themedStyles, themeValue, color, font, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Main">;

/** The gallery plays one trusted source; the discovery grid stays lightweight. */
export function DesktopExplore({ route, navigation }: Props) {
  const { data, refresh, refreshing, loading, error } = useZiipa();
  const { contentWidth } = useDesktopLayout();
  const [query, setQuery] = useState(route.params?.query || "");
  const category = route.params?.category;
  const saved = route.params?.collection === "saved";
  useEffect(() => setQuery(route.params?.query || ""), [route.params?.query]);

  const published = useMemo(
    () =>
      data.items.filter(
        (item) => !item.demo && item.visibility === "published",
      ),
    [data.items],
  );
  const items = useMemo(
    () =>
      searchItems(published, query).filter(
        (item) =>
          (!category || inCreativeWorld(item, category)) &&
          (!saved || data.preferences.saved.includes(item.id)),
      ),
    [published, query, category, saved, data.preferences.saved],
  );
  const tags = useMemo(
    () =>
      [...new Set(published.flatMap((item) => item.tags))]
        .filter(Boolean)
        .slice(0, 8),
    [published],
  );
  const featured = useMemo(
    () =>
      items
        .filter(
          (item) =>
            !!item.media_url &&
            /^(video|audio)\//.test(item.content_type || ""),
        )
        .slice(0, 8),
    [items],
  );
  const columns = contentWidth >= 1400 ? 4 : contentWidth >= 980 ? 3 : 2;
  // The sidebar owns its width. onLayout below measures only this grid's space.
  const [gridWidth, setGridWidth] = useState(0);
  const cardWidth = Math.max(140, (gridWidth - (columns - 1) * 18) / columns);
  const activeTitle = category
    ? categories.find((entry) => entry.id === category)?.title || "Creations"
    : "All creations";

  function search(value: string) {
    const next = value.slice(0, 160);
    setQuery(next);
    navigation.setParams({ query: next || undefined });
  }
  function select(next?: Category) {
    navigation.setParams({ category: next });
  }
  function open(item: Item) {
    navigation.navigate("Watch", { itemId: item.id, category: item.category });
  }
  function reset() {
    setQuery("");
    navigation.setParams({
      category: undefined,
      query: undefined,
      collection: undefined,
    });
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={s.page}
      showsVerticalScrollIndicator={false}
    >
      <View style={s.content}>
        <View style={s.headingRow}>
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={styles.eyebrow}>YOUR CREATIVE WORLD</Text>
            <Text accessibilityRole="header" style={s.heading}>
              {saved ? "Saved for later" : "Explore"}
            </Text>
            <Text style={styles.body}>
              {saved
                ? "The creations you saved, all in one place."
                : "Find your next inspiration. Make something of your own."}
            </Text>
          </View>
          <Action
            title="Create a post"
            icon={Plus}
            onPress={() => navigation.navigate("Composer")}
          />
        </View>

        <View style={s.toolbar}>
          <View style={s.search}>
            <Search size={21} color={color.muted} />
            <TextInput
              accessibilityLabel="Search published creations"
              placeholder="Search videos, creators or topics"
              placeholderTextColor={color.faint}
              value={query}
              maxLength={160}
              onChangeText={search}
              style={s.searchInput}
            />
            {!!query && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear creation search"
                onPress={() => search("")}
                style={s.smallButton}
              >
                <X size={18} color={color.muted} />
              </Pressable>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: saved }}
            onPress={() =>
              navigation.setParams({ collection: saved ? undefined : "saved" })
            }
            style={[s.toolbarButton, saved && s.selected]}
          >
            <Bookmark size={18} color={saved ? color.lime : color.muted} />
            <Text style={s.buttonLabel}>Saved</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh published creations"
            disabled={refreshing}
            onPress={() => void refresh()}
            style={s.toolbarButton}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.lime} />
            ) : (
              <RefreshCw size={18} color={color.muted} />
            )}
          </Pressable>
        </View>

        <View style={s.categories} accessibilityLabel="Creative world filters">
          <Filter
            title="For you"
            selected={!category}
            onPress={() => select()}
          />
          {categories.map((entry) => (
            <Filter
              key={entry.id}
              title={entry.title}
              selected={category === entry.id}
              onPress={() => select(entry.id)}
            />
          ))}
        </View>

        {!!error && <Notice text={error} error />}
        {loading ? (
          <View style={s.loading}>
            <ActivityIndicator color={color.lime} />
            <Text style={styles.small}>Loading your creative world…</Text>
          </View>
        ) : error && !published.length ? (
          <View style={s.noResults}>
            <RefreshCw size={32} color={color.muted} />
            <Text style={styles.heading}>Your feed couldn’t load</Text>
            <Text style={[styles.body, { textAlign: "center", maxWidth: 440 }]}>
              Refresh to load published creations. Your saved work and feed
              preferences are unchanged.
            </Text>
            <Action
              title="Try again"
              icon={RefreshCw}
              busy={refreshing}
              onPress={() => void refresh()}
            />
          </View>
        ) : !published.length ? (
          <View style={{ gap: 22 }}>
            <LinearGradient
              colors={["#32165B", "#21162F", color.panel]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={s.welcome}
            >
              <View style={s.welcomeIcon}>
                <Sparkles size={34} color={color.lime} strokeWidth={1.5} />
              </View>
              <View style={{ flex: 1, gap: 12, maxWidth: 660 }}>
                <Text style={styles.eyebrow}>ROOM FOR YOUR FIRST IDEA</Text>
                <Text style={s.welcomeTitle}>
                  Every creative world starts with a first post.
                </Text>
                <Text style={styles.body}>
                  There are no published creator posts to explore yet. Upload or
                  record in Studio, shape your story, then choose when to
                  publish it.
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 8,
                  }}
                >
                  <Action
                    title="Open Creator Studio"
                    icon={Plus}
                    onPress={() => navigation.navigate("Composer")}
                  />
                  <Action
                    title="Browse live feeds"
                    icon={Radio}
                    secondary
                    onPress={() =>
                      navigation.navigate("Live", { tab: "watch" })
                    }
                  />
                </View>
              </View>
            </LinearGradient>
            <View style={s.nextSteps}>
              <Step
                title="Make your first post"
                body="Bring your video, audio or images into the editor."
                icon={Film}
                onPress={() => navigation.navigate("Composer")}
              />
              <Step
                title="Find your live community"
                body="See available broadcasts or set up your own."
                icon={Radio}
                onPress={() => navigation.navigate("Live", { tab: "watch" })}
              />
              <Step
                title="Choose your own feed"
                body="Build a feed around the topics and creators you care about."
                icon={SlidersHorizontal}
                onPress={() => navigation.navigate("Feeds")}
              />
            </View>
          </View>
        ) : (
          <>
            {!!featured.length && (
              <DesktopFeaturedGallery items={featured} open={open} />
            )}
            <View style={s.sectionHeading}>
              <Text accessibilityRole="header" style={s.sectionTitle}>
                {saved
                  ? "Your saved collection"
                  : query.trim()
                    ? `Results for “${query.trim()}”`
                    : activeTitle}
              </Text>
              <Text accessibilityLiveRegion="polite" style={styles.small}>
                {items.length} {items.length === 1 ? "creation" : "creations"}
              </Text>
            </View>
            {items.length ? (
              <View
                onLayout={(event) =>
                  setGridWidth(event.nativeEvent.layout.width)
                }
                style={s.grid}
              >
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Watch ${item.title} by ${item.creator}`}
                    onPress={() => open(item)}
                    style={({ pressed }) => [
                      s.card,
                      { width: cardWidth, opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <View style={s.cover}>
                      <Cover item={item} style={StyleSheet.absoluteFill} />
                      <LinearGradient
                        colors={["transparent", "#100A22C9"]}
                        style={StyleSheet.absoluteFill}
                      />
                      <View style={s.cardCategory}>
                        <Text style={s.cardCategoryText}>
                          {categories.find(
                            (entry) => entry.id === item.category,
                          )?.title || item.category}
                        </Text>
                      </View>
                      <View style={s.play}>
                        <Play
                          size={24}
                          color="white"
                          fill="#FFFFFF44"
                          strokeWidth={1.5}
                        />
                      </View>
                      {data.preferences.saved.includes(item.id) && (
                        <View style={s.savedBadge}>
                          <Bookmark
                            size={16}
                            color={color.lime}
                            fill={color.lime}
                          />
                        </View>
                      )}
                    </View>
                    <View style={s.cardCopy}>
                      <Text numberOfLines={2} style={s.cardTitle}>
                        {item.title}
                      </Text>
                      <Text numberOfLines={1} style={styles.small}>
                        {item.creator}
                      </Text>
                      {!!item.tags.length && (
                        <Text numberOfLines={1} style={s.cardTags}>
                          {item.tags
                            .slice(0, 3)
                            .map((tag) => `#${tag}`)
                            .join("  ")}
                        </Text>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={s.noResults}>
                {saved ? (
                  <Bookmark size={34} color={color.muted} />
                ) : (
                  <Search size={34} color={color.muted} />
                )}
                <Text style={styles.heading}>
                  {saved
                    ? "No saved creations match"
                    : "No creations match yet"}
                </Text>
                <Text
                  style={[styles.body, { textAlign: "center", maxWidth: 440 }]}
                >
                  {saved
                    ? "Save a creation while watching, or clear these filters to explore what has been published."
                    : "Try another creative world or search, or publish the idea you would like to see here."}
                </Text>
                <Action
                  title="Explore all creations"
                  secondary
                  onPress={reset}
                />
              </View>
            )}
            <View style={s.discoveryFooter}>
              <View style={{ flex: 1, gap: 9 }}>
                <View
                  style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
                >
                  <Compass size={19} color={color.lime} />
                  <Text style={s.sectionTitle}>Keep exploring</Text>
                </View>
                {tags.length ? (
                  <View style={s.categories}>
                    {tags.map((tag) => (
                      <Filter
                        key={tag}
                        title={`#${tag}`}
                        selected={query === tag}
                        onPress={() => search(tag)}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.small}>
                    Explore a creative world or build a custom feed.
                  </Text>
                )}
              </View>
              <Action
                title="Build your feed"
                icon={SlidersHorizontal}
                secondary
                onPress={() => navigation.navigate("Feeds")}
              />
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Filter({
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
      style={({ pressed }) => [
        s.filter,
        selected && s.selected,
        { opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Text style={[s.filterText, selected && { color: color.onAccent }]}>
        {title}
      </Text>
    </Pressable>
  );
}

function Step({
  title,
  body,
  icon: Icon,
  onPress,
}: {
  title: string;
  body: string;
  icon: typeof Film;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.step, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Icon size={24} color={color.lime} strokeWidth={1.6} />
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={[styles.small, { flex: 1 }]}>{body}</Text>
      <ArrowRight size={18} color={color.muted} />
    </Pressable>
  );
}

const s = themedStyles(() => StyleSheet.create({
  page: { padding: 24, paddingBottom: 40, flexGrow: 1 },
  content: { width: "100%", maxWidth: 1440, alignSelf: "center", gap: 20 },
  headingRow: {
    flexDirection: "row",
    gap: 24,
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: {
    color: color.text,
    fontFamily: font.bold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.5,
  },
  toolbar: { flexDirection: "row", gap: 12, alignItems: "center" },
  search: {
    flex: 1,
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.panel,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 12,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: color.text,
    fontFamily: font.regular,
    fontSize: 16,
    height: 50,
  },
  smallButton: { padding: 8 },
  toolbarButton: {
    minHeight: 52,
    minWidth: 52,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 14,
    backgroundColor: color.panel,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  buttonLabel: { color: color.text, fontFamily: font.medium, fontSize: 14 },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  filter: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 24,
    paddingHorizontal: 17,
    paddingVertical: 11,
    backgroundColor: color.panel,
  },
  filterText: { color: color.muted, fontFamily: font.medium, fontSize: 14 },
  selected: { backgroundColor: color.purple, borderColor: "#8156C3" },
  loading: { paddingVertical: 64, gap: 16, alignItems: "center" },
  welcome: {
    borderRadius: 26,
    borderWidth: 1,
    borderColor: themeValue("#563677", color.border),
    padding: 36,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 24,
  },
  welcomeIcon: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: "#A6E21B14",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#A6E21B44",
  },
  welcomeTitle: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 29,
    lineHeight: 35,
    letterSpacing: -0.6,
  },
  nextSteps: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  step: {
    flex: 1,
    minWidth: 195,
    borderRadius: 20,
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.border,
    padding: 22,
    gap: 14,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
  },
  sectionTitle: { color: color.text, fontFamily: font.semibold, fontSize: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 18 },
  card: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.panel,
  },
  cover: {
    width: "100%",
    aspectRatio: 16 / 9,
    overflow: "hidden",
    backgroundColor: color.raised,
  },
  cardCategory: {
    position: "absolute",
    top: 13,
    left: 13,
    backgroundColor: "#120D1FCC",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  cardCategoryText: { fontFamily: font.medium, fontSize: 11, color: themeValue("#E6DBF3", color.text) },
  play: {
    position: "absolute",
    bottom: 16,
    left: 16,
    width: 42,
    height: 42,
    borderRadius: 24,
    backgroundColor: "#FFFFFF24",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#FFFFFF66",
  },
  savedBadge: { position: "absolute", right: 14, bottom: 19 },
  cardCopy: { padding: 13, gap: 5 },
  cardTitle: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
  cardTags: { color: color.faint, fontFamily: font.regular, fontSize: 12 },
  noResults: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: color.border,
    padding: 42,
    minHeight: 320,
    gap: 16,
  },
  discoveryFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 28,
    padding: 24,
    borderRadius: 22,
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.border,
  },
}));
