import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ArrowLeft,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Heart,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Scissors,
  Share2,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react-native";
import { CategoryDock, FloatButton, Sheet } from "../components/floating";
import { Action, Field, Notice } from "../components/ui";
import { ReelMedia } from "../components/reel-media";
import { inCreativeWorld, pageAtOffset } from "../lib/domain";
import { useZiipa } from "../provider";
import type { Category, Comment, Item, RootStack } from "../lib/types";
import { font, styles } from "../theme";

export function WatchScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Watch">) {
  const { data, guest, session, api, toggle } = useZiipa();
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<Category>(
    route.params?.category || "music",
  );
  const items = useMemo(() => {
    const all = data.items.filter((i) => inCreativeWorld(i, category));
    const draft = data.drafts.find((i) => i.id === route.params?.itemId);
    return draft && !all.some((i) => i.id === draft.id) ? [draft, ...all] : all;
  }, [data.items, data.drafts, category, route.params?.itemId]);
  const start = Math.max(
    0,
    items.findIndex((i) => i.id === route.params?.itemId),
  );
  const [index, setIndex] = useState(start);
  const [height, setHeight] = useState(0);
  const list = useRef<FlatList<Item>>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [panel, setPanel] = useState<"comments" | "more" | null>(null);
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [sampleComments, setSampleComments] = useState<
    Record<string, Comment[]>
  >({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const item = items[index];
  useEffect(() => {
    setIndex(start);
    setPaused(false);
    if (height)
      list.current?.scrollToOffset({ offset: start * height, animated: false });
  }, [height, category, route.params?.itemId, start]);
  useEffect(() => {
    if (panel !== "comments" || !item) return;
    setError("");
    setBody("");
    if (guest) {
      setComments(sampleComments[item.id] || []);
      return;
    }
    let live = true;
    api<Comment[]>(`/api/creator/items/${item.id}/comments`)
      .then((result) => {
        if (live) setComments(result);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [panel, item?.id, guest, api, sampleComments]);
  async function react(key: "liked" | "saved") {
    if (!item || busy) return;
    setBusy(true);
    try {
      await toggle(key, item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function comment() {
    if (!body.trim() || !item || busy) return;
    setBusy(true);
    setError("");
    try {
      if (guest) {
        const entry: Comment = {
          id: `sample-${Date.now()}`,
          creator: "You · preview",
          creator_id: 0,
          body: body.trim(),
        };
        setSampleComments((old) => ({
          ...old,
          [item.id]: [entry, ...(old[item.id] || [])],
        }));
      } else {
        const entry = await api<Comment>(
          `/api/creator/items/${item.id}/comments`,
          { body: body.trim() },
        );
        setComments((old) => [entry, ...old]);
      }
      setBody("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function page(direction: number) {
    if (!height) return;
    const next = Math.max(0, Math.min(items.length - 1, index + direction));
    list.current?.scrollToOffset({ offset: next * height, animated: true });
  }
  return (
    <View
      style={styles.screen}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      {height > 0 && (
        <FlatList
          ref={list}
          data={items}
          keyExtractor={(i) => i.id}
          pagingEnabled
          snapToInterval={height}
          snapToAlignment="start"
          disableIntervalMomentum
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({
            length: height,
            offset: i * height,
            index: i,
          })}
          initialNumToRender={2}
          windowSize={3}
          maxToRenderPerBatch={2}
          scrollEventThrottle={50}
          onScroll={(e) => {
            const next = pageAtOffset(
              e.nativeEvent.contentOffset.y,
              height,
              items.length,
            );
            if (next !== index) {
              setIndex(next);
              setPaused(false);
              setError("");
            }
          }}
          renderItem={({ item: post, index: i }) => (
          <View style={{ height, overflow: "hidden" }} accessibilityElementsHidden={i !== index} importantForAccessibility={i === index ? "auto" : "no-hide-descendants"} aria-hidden={i !== index}>
              <ReelMedia
                item={post}
                active={i === index}
                paused={paused || !!panel}
                muted={muted}
              />
              <LinearGradient
                pointerEvents="none"
                colors={["#100A2488", "#0000", "#0000", "#10091AED"]}
                locations={[0, 0.25, 0.45, 1]}
                style={{ position: "absolute", inset: 0 }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  post.media_url
                    ? paused
                    ? "Play media"
                    : "Pause media"
                    : "View collection details"
                }
                onPress={() =>
                  post.media_url ? setPaused(!paused) : setPanel("more")
                }
                style={{
                  position: "absolute",
                  top: 92,
                  bottom: 240 + insets.bottom,
                  left: 0,
                  right: 72,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {post.media_url && paused && (
                  <Play
                    size={56}
                    color="white"
                    fill="#FFFFFF55"
                    strokeWidth={1}
                  />
                )}
              </Pressable>
              <View
                pointerEvents="box-none"
                style={{
                  position: "absolute",
                  left: 22,
                  right: 82,
                  bottom: 117 + insets.bottom,
                  gap: 9,
                }}
              >
                <Text
                  style={{
                    color: "#D0C2E3",
                    fontSize: 10,
                    letterSpacing: 1.3,
                    fontFamily: font.medium,
                  }}
                >
                  {post.demo
                    ? post.media_url
                      ? "SAMPLE FILM"
                      : post.label.toUpperCase()
                    : "CREATOR POST"}
                </Text>
                <Text
                  style={{
                    color: "white",
                    fontFamily: font.semibold,
                    fontSize: 17,
                  }}
                >
                  @{post.creator.toLowerCase().replace(/\s+/g, ".")}
                </Text>
                <Text
                  numberOfLines={2}
                  style={{
                    color: "white",
                    fontFamily: font.medium,
                    fontSize: 23,
                    lineHeight: 27,
                  }}
                >
                  {post.title}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: "#E7DCF5",
                    fontFamily: font.regular,
                    fontSize: 12,
                  }}
                >
                  {post.tags.map((t) => `#${t}`).join("  ")}
                </Text>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
                >
                  <Music2 size={13} color="#DDD" />
                  <Text
                    style={{
                      color: "#DBD1E6",
                      fontFamily: font.regular,
                      fontSize: 11,
                    }}
                  >
                    {post.media_url
                      ? "Original film audio · tap sound to unmute"
                      : "Photo collection · no audio"}
                  </Text>
                </View>
              </View>
            </View>
          )}
        />
      )}
      <View
        style={{
          position: "absolute",
          top: insets.top + 12,
          left: 10,
          right: 12,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <FloatButton
          label="Back to discovery"
          icon={ArrowLeft}
          plain
          onPress={() => navigation.goBack()}
        />
        <View style={{ alignItems: "center", gap: 4 }}>
          <Text
            style={{ color: "white", fontFamily: font.semibold, fontSize: 16 }}
          >
            For you
          </Text>
          <View style={{ width: 25, height: 2, backgroundColor: "white" }} />
        </View>
        <FloatButton
          label="Open Studio"
          icon={Menu}
          plain
          onPress={() => navigation.navigate("Studio", { category })}
        />
      </View>
      {!!item && (
        <View
          style={{
            position: "absolute",
            right: 12,
            bottom: 133 + insets.bottom,
            alignItems: "center",
            gap: 14,
          }}
        >
          <FloatButton
            label="Your creator profile"
            icon={UserRound}
            onPress={() => navigation.navigate("Profile")}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              data.preferences.liked.includes(item.id)
                ? "Unlike creation"
                : "Like creation"
            }
            accessibilityState={{
              selected: data.preferences.liked.includes(item.id),
              disabled: busy,
            }}
            disabled={busy}
            onPress={() => void react("liked")}
            style={w.rail}
          >
            <Heart
              size={30}
              strokeWidth={1.6}
              fill={
                data.preferences.liked.includes(item.id)
                  ? "#FF5A87"
                  : "#FFFFFF16"
              }
              color={
                data.preferences.liked.includes(item.id) ? "#FF5A87" : "white"
              }
            />
            <Text style={w.label}>
              {data.preferences.liked.includes(item.id) ? "Liked" : "Like"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comments"
            onPress={() => setPanel("comments")}
            style={w.rail}
          >
            <MessageCircle size={29} color="white" strokeWidth={1.6} />
            <Text style={w.label}>Chat</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              data.preferences.saved.includes(item.id)
                ? "Unsave creation"
                : "Save creation"
            }
            accessibilityState={{
              selected: data.preferences.saved.includes(item.id),
              disabled: busy,
            }}
            disabled={busy}
            onPress={() => void react("saved")}
            style={w.rail}
          >
            <Bookmark
              size={27}
              color="white"
              fill={data.preferences.saved.includes(item.id) ? "white" : "none"}
              strokeWidth={1.6}
            />
            <Text style={w.label}>
              {data.preferences.saved.includes(item.id) ? "Saved" : "Save"}
            </Text>
          </Pressable>
          <FloatButton
            label="More actions"
            icon={MoreHorizontal}
            plain
            onPress={() => setPanel("more")}
          />
          <FloatButton
            label="Create a remix"
            icon={Plus}
            active
            onPress={() => navigation.navigate("Composer", { remix: item })}
          />
        </View>
      )}
      <View
        style={{
          position: "absolute",
          right: 12,
          top: insets.top + 70,
          gap: 4,
        }}
      >
        {item?.media_url && (
          <>
            <FloatButton
              label={muted ? "Unmute video" : "Mute video"}
              icon={muted ? VolumeX : Volume2}
              plain
              onPress={() => setMuted(!muted)}
            />
            <FloatButton
              label={paused ? "Play video" : "Pause video"}
              icon={paused ? Play : Pause}
              plain
              onPress={() => setPaused(!paused)}
            />
          </>
        )}
        {index > 0 && (
          <FloatButton
            label="Previous video"
            icon={ChevronUp}
            plain
            onPress={() => page(-1)}
          />
        )}
        {index < items.length - 1 && (
          <FloatButton
            label="Next video"
            icon={ChevronDown}
            plain
            onPress={() => page(1)}
          />
        )}
      </View>
      {!items.length && (
        <View
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
            padding: 30,
          }}
        >
          <Text style={styles.heading}>No creations yet</Text>
          <Text style={styles.body}>Choose another creative world below.</Text>
        </View>
      )}
      {!!error && !panel && (
        <View
          style={{
            position: "absolute",
            top: insets.top + 65,
            left: 20,
            right: 67,
          }}
        >
          <Notice text={error} error />
        </View>
      )}
      <CategoryDock
        selected={category}
        onSelect={(id) => {
          navigation.setParams({ itemId: undefined, category: id });
          setCategory(id);
          setIndex(0);
        }}
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
      {panel && item && (
        <Sheet
          title={panel === "comments" ? "The conversation" : "Make it your own"}
          onClose={() => setPanel(null)}
        >
          {panel === "comments" ? (
            <>
              {guest && (
                <Text style={styles.small}>
                  Sample comments stay in this preview. Nothing is posted
                  publicly.
                </Text>
              )}
              {comments.length ? (
                comments.map((c) => (
                  <View key={c.id} style={{ gap: 5, paddingVertical: 8 }}>
                    <Text style={{ color: "white", fontFamily: font.semibold }}>
                      {c.creator}
                    </Text>
                    <Text style={styles.body}>{c.body}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.body}>Start the conversation.</Text>
              )}
              <Field
                label="Add a comment"
                value={body}
                onChangeText={setBody}
                maxLength={1000}
                multiline
                placeholder="Share a little good energy…"
              />
              <Action
                title={guest ? "Add sample comment" : "Post comment"}
                onPress={() => void comment()}
                disabled={!body.trim()}
                busy={busy}
              />
            </>
          ) : (
            <>
              <Text style={styles.body}>{item.description}</Text>
              <Action
                title="Remix this idea"
                icon={Scissors}
                onPress={() => {
                  setPanel(null);
                  navigation.navigate("Composer", { remix: item });
                }}
              />
              <Action
                title="Share title"
                icon={Share2}
                secondary
                onPress={() => {
                  void Share.share({
                    message: `${item.title} — ${item.creator} on Ziipa. https://ziipa.com`,
                  }).catch((e) => setError(e.message));
                }}
              />
              <Action
                title="Details, reporting & safety"
                secondary
                onPress={() => {
                  setPanel(null);
                  navigation.navigate("Post", { item });
                }}
              />
              <Action
                title="Your feed rules"
                secondary
                onPress={() => {
                  setPanel(null);
                  navigation.navigate("Feeds");
                }}
              />
              {session?.user.id === item.creator_id && (
                <Action
                  title="Edit this creation"
                  secondary
                  onPress={() => {
                    setPanel(null);
                    navigation.navigate("Composer", { item });
                  }}
                />
              )}
            </>
          )}
          {!!error && <Notice text={error} error />}
        </Sheet>
      )}
    </View>
  );
}
const w = {
  rail: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    minWidth: 44,
    minHeight: 49,
    gap: 3,
  },
  label: { color: "white", fontFamily: font.medium, fontSize: 10 },
};
