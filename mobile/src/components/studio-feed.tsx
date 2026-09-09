import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react-native";
import { ReelMedia } from "./reel-media";
import { pageAtOffset, isPlayableMedia } from "../lib/domain";
import type { Item } from "../lib/types";
import { color, font } from "../theme";

/** The menu is a sibling overlay: this list owns gestures on the exposed media. */
export function StudioFeed({
  items,
  editing,
  onOpen,
}: {
  items: Item[];
  editing: boolean;
  onOpen: (item: Item) => void;
}) {
  const [height, setHeight] = useState(0);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const list = useRef<FlatList<Item>>(null);
  const currentIndex = useRef(0);
  const activeItemId = useRef(items[0]?.id);
  const current = items[index];
  const playable = !!current && isPlayableMedia(current);
  useEffect(() => {
    const retained = items.findIndex(
      (item) => item.id === activeItemId.current,
    );
    const next =
      retained >= 0
        ? retained
        : Math.min(currentIndex.current, Math.max(0, items.length - 1));
    if (activeItemId.current !== items[next]?.id) setPaused(false);
    activeItemId.current = items[next]?.id;
    currentIndex.current = next;
    setIndex(next);
    if (height)
      list.current?.scrollToOffset({
        offset: next * height,
        animated: false,
      });
  }, [height, items]);
  function page(direction: number) {
    const next = Math.max(0, Math.min(items.length - 1, index + direction));
    list.current?.scrollToOffset({ offset: next * height, animated: true });
  }
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      {height > 0 && items.length > 0 && (
        <FlatList
          ref={list}
          accessibilityLabel="Discover media feed"
          data={items}
          extraData={{ index, paused, muted, editing }}
          keyExtractor={(item) => item.id}
          pagingEnabled
          snapToInterval={height}
          snapToAlignment="start"
          disableIntervalMomentum
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          scrollEnabled={!editing}
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
            if (next !== currentIndex.current) {
              currentIndex.current = next;
              activeItemId.current = items[next]?.id;
              setIndex(next);
              setPaused(false);
            }
          }}
          renderItem={({ item, index: i }) => (
            <View
              style={{ height, overflow: "hidden" }}
              accessibilityElementsHidden={i !== index}
              importantForAccessibility={
                i === index ? "auto" : "no-hide-descendants"
              }
              aria-hidden={i !== index}
            >
              <ReelMedia
                item={item}
                active={i === index && isPlayableMedia(item)}
                paused={paused || editing}
                muted={muted}
              />
              <LinearGradient
                pointerEvents="none"
                colors={["#120D1F20", "#120D1F18", "#120D1FB8"]}
                locations={[0, 0.48, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
              <LinearGradient
                pointerEvents="none"
                colors={[
                  "#120D1F65",
                  "transparent",
                  "transparent",
                  "#120D1FF5",
                ]}
                locations={[0, 0.2, 0.57, 1]}
                style={StyleSheet.absoluteFill}
              />
            </View>
          )}
        />
      )}
      <View pointerEvents="box-none" style={s.top}>
        <Text style={s.heading}>Discover</Text>
        <View style={s.underline} />
        <Text style={s.hint}>
          {editing ? "Paused while editing" : "Your next inspiration"}
        </Text>
        {playable && !editing && (
          <View style={s.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                paused ? "Play discover media" : "Pause discover media"
              }
              onPress={() => setPaused(!paused)}
              style={s.control}
            >
              {paused ? (
                <Play size={18} color="white" />
              ) : (
                <Pause size={18} color="white" />
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                muted ? "Unmute discover media" : "Mute discover media"
              }
              onPress={() => setMuted(!muted)}
              style={s.control}
            >
              {muted ? (
                <VolumeX size={18} color="white" />
              ) : (
                <Volume2 size={18} color="white" />
              )}
            </Pressable>
          </View>
        )}
      </View>
      {!editing && current && (
        <View pointerEvents="box-none" style={s.bottom}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${current.title}`}
            onPress={() => onOpen(current)}
            style={s.details}
          >
            <Text style={s.eyebrow}>
              {current.demo ? current.label : "CREATOR POST"}
            </Text>
            <Text numberOfLines={1} style={s.creator}>
              {current.creator}
            </Text>
            <Text numberOfLines={2} style={s.title}>
              {current.title}
            </Text>
            {current.id === "demo-sintel" && (
              <Text style={s.credit}>
                Sintel · © Blender Foundation · CC BY 3.0
              </Text>
            )}
          </Pressable>
          <View style={s.footer}>
            <View pointerEvents="none" style={{ flex: 1, gap: 5 }}>
              <View style={s.swipe}>
                <ArrowUp size={14} color={color.lime} />
                <Text style={s.hint}>
                  {index < items.length - 1
                    ? "Swipe up to discover"
                    : "You're all caught up"}
                </Text>
              </View>
              <Text accessibilityLiveRegion="polite" style={s.count}>
                {index + 1} / {items.length}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous discover media"
              accessibilityState={{ disabled: index === 0 }}
              disabled={index === 0}
              onPress={() => page(-1)}
              style={[s.control, index === 0 && s.disabled]}
            >
              <ChevronUp size={20} color="white" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next discover media"
              accessibilityState={{ disabled: index === items.length - 1 }}
              disabled={index === items.length - 1}
              onPress={() => page(1)}
              style={[s.control, index === items.length - 1 && s.disabled]}
            >
              <ChevronDown size={20} color="white" />
            </Pressable>
          </View>
        </View>
      )}
      {!items.length && (
        <View pointerEvents="none" style={s.empty}>
          <Text style={s.creator}>Your discovery starts here</Text>
          <Text style={s.hint}>
            Published creations will appear in this feed.
          </Text>
        </View>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  top: {
    position: "absolute",
    top: 22,
    left: 22,
    width: "42%",
    alignItems: "flex-start",
    gap: 5,
  },
  heading: {
    color: "white",
    fontFamily: font.semibold,
    fontSize: 23,
    textShadowColor: "#0009",
    textShadowRadius: 8,
  },
  underline: {
    width: 27,
    height: 3,
    backgroundColor: color.lime,
    borderRadius: 2,
    marginBottom: 2,
  },
  hint: { color: "#DFD5EC", fontFamily: font.regular, fontSize: 12 },
  controls: { flexDirection: "row", gap: 8, marginTop: 13 },
  control: {
    width: 42,
    height: 42,
    borderRadius: 23,
    backgroundColor: "#10091D85",
    borderWidth: 1,
    borderColor: "#FFFFFF45",
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.3 },
  bottom: { position: "absolute", bottom: 15, left: 22, right: 22, gap: 14 },
  details: {
    paddingVertical: 5,
    gap: 4,
    maxWidth: "85%",
    alignSelf: "flex-start",
  },
  eyebrow: {
    color: "#CFC1E4",
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  creator: { color: "white", fontFamily: font.semibold, fontSize: 14 },
  title: {
    color: "white",
    fontFamily: font.semibold,
    fontSize: 23,
    lineHeight: 26,
  },
  credit: {
    color: "#CFC1E4",
    fontFamily: font.regular,
    fontSize: 10,
    marginTop: 2,
  },
  footer: { flexDirection: "row", alignItems: "center", gap: 9 },
  swipe: { flexDirection: "row", alignItems: "center", gap: 5 },
  count: {
    color: "#B8A9C9",
    fontFamily: font.regular,
    fontSize: 10,
    paddingLeft: 19,
  },
  empty: { position: "absolute", left: 22, right: 22, bottom: 45, gap: 8 },
});
