import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react-native";
import { Cover } from "./ui";
import { ReelMedia } from "./reel-media";
import { isPlayableMedia } from "../lib/domain";
import { galleryIndex, galleryRotationAllowed } from "../lib/gallery";
import type { Item } from "../lib/types";
import { color, font } from "../theme";

/** The adjacent cards are covers; only the active trusted media player mounts. */
export function GallerySlider({
  items,
  label,
  onOpen,
}: {
  items: Item[];
  label: string;
  onOpen: (item: Item) => void;
}) {
  const focused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();
  const [width, setWidth] = useState(windowWidth);
  const [index, setIndex] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [visible, setVisible] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [controlFocused, setControlFocused] = useState(false);
  // Until accessibility settings resolve, do not start motion or video.
  const [reducedMotion, setReducedMotion] = useState(true);
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [mediaPaused, setMediaPaused] = useState(false);
  const [explicitPlaybackId, setExplicitPlaybackId] = useState<string | null>(
    null,
  );
  const [unmutedItemId, setUnmutedItemId] = useState<string | null>(null);
  const container = useRef<View>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const translation = useRef(new Animated.Value(0)).current;
  const current = galleryIndex(index, items.length);
  const item = items[current];
  const explicitPlayback = !!item && explicitPlaybackId === item.id;
  const muted = !item || unmutedItemId !== item.id;
  const playable = !!item && isPlayableMedia(item);
  const activeId = useRef(item?.id);
  const currentIndex = useRef(current);

  useEffect(() => {
    const retained = items.findIndex((entry) => entry.id === activeId.current);
    const next =
      retained >= 0
        ? retained
        : galleryIndex(currentIndex.current, items.length);
    setIndex(next);
    activeId.current = items[next]?.id;
    currentIndex.current = next;
  }, [items]);
  useEffect(() => {
    activeId.current = item?.id;
    currentIndex.current = current;
    setMediaPaused(false);
    setExplicitPlaybackId(null);
    // Never carry audible playback into the next creator's post.
    setUnmutedItemId(null);
  }, [item?.id, current]);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReducedMotion(value);
      })
      .catch(() => undefined);
    const motion = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    const app = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    if (Platform.OS !== "web")
      return () => {
        mounted = false;
        motion.remove();
        app.remove();
      };
    const sync = () =>
      setForeground(
        document.visibilityState !== "hidden" && document.hasFocus(),
      );
    const blur = () => setForeground(false);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => setReducedMotion(preference.matches);
    reduce();
    sync();
    preference.addEventListener("change", reduce);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", blur);
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
      preference.removeEventListener("change", reduce);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof IntersectionObserver === "undefined")
      return;
    const node = container.current as unknown as Element | null;
    if (!(node instanceof Element)) return;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.5),
      { threshold: [0, 0.5] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () => () => {
      fade.stopAnimation();
      translation.stopAnimation();
    },
    [fade, translation],
  );

  const show = useCallback(
    (next: number, direction = 1) => {
      if (!items.length) return;
      fade.stopAnimation();
      translation.stopAnimation();
      setIndex(galleryIndex(next, items.length));
      fade.setValue(reducedMotion ? 1 : 0.5);
      translation.setValue(reducedMotion ? 0 : direction * 24);
      if (!reducedMotion)
        Animated.parallel([
          Animated.timing(fade, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(translation, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ]).start();
    },
    [items.length, reducedMotion, fade, translation],
  );
  const advance = useCallback(
    (direction: number, manual = false) => {
      if (manual) setRotationEnabled(false);
      show(current + direction, direction);
    },
    [current, show],
  );
  const rotating = galleryRotationAllowed({
    count: items.length,
    enabled: rotationEnabled,
    focused,
    foreground,
    visible,
    hovering,
    controlFocused,
    reducedMotion,
  });
  useEffect(() => {
    if (!rotating) return;
    const timer = setTimeout(() => advance(1), 7000);
    return () => clearTimeout(timer);
  }, [rotating, advance]);
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 18 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => setRotationEnabled(false),
        onPanResponderRelease: (_, gesture) => {
          if (Math.abs(gesture.dx) > 35) advance(gesture.dx < 0 ? 1 : -1, true);
        },
      }),
    [advance],
  );
  const interaction = {
    onFocus: () => setControlFocused(true),
    onBlur: () => setControlFocused(false),
  };
  const mediaActive = playable && focused && foreground && visible;
  if (!item) return null;

  return (
    <View
      ref={container}
      style={{ flex: 1 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Pressable
        accessible={false}
        onHoverIn={() => setHovering(true)}
        onHoverOut={() => setHovering(false)}
        style={{ flex: 1 }}
      >
        <Animated.View
          {...swipe.panHandlers}
          style={{
            flex: 1,
            opacity: fade,
            transform: [{ translateX: translation }],
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {items.length > 1 &&
            [-1, 1].map((offset) => (
              <View
                key={offset}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                style={{
                  position: "absolute",
                  width: width * 0.64,
                  height: "81%",
                  left: offset < 0 ? -width * 0.07 : width * 0.43,
                  borderRadius: 25,
                  overflow: "hidden",
                  opacity: 0.55,
                  transform: [{ scale: 0.95 }],
                }}
              >
                <Cover
                  item={items[galleryIndex(current + offset, items.length)]}
                  style={{ flex: 1 }}
                />
              </View>
            ))}
          <Pressable
            {...interaction}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title} by ${item.creator}`}
            onPress={() => onOpen(item)}
            style={{
              width: "69%",
              height: "100%",
              minHeight: 245,
              borderRadius: 26,
              overflow: "hidden",
              borderWidth: 1,
              borderColor: "#765898",
              boxShadow: "0 18px 28px #0005",
            }}
          >
            <ReelMedia
              key={item.id}
              item={item}
              active={mediaActive}
              paused={mediaPaused || (reducedMotion && !explicitPlayback)}
              muted={muted}
            />
            <LinearGradient
              pointerEvents="none"
              colors={
                item.category === "music" || item.category === "video"
                  ? ["#5300AF33", "#30005F00", "#160A29ED"]
                  : ["#0001", "#0000", "#110D1CED"]
              }
              style={{ flex: 1, padding: 21, justifyContent: "space-between" }}
            >
              <Text
                style={{
                  color: "#F1E9FF",
                  fontFamily: font.medium,
                  fontSize: 11,
                  letterSpacing: 2,
                }}
              >
                {label.toUpperCase()}
              </Text>
              <View style={{ gap: 12 }}>
                <Text
                  numberOfLines={3}
                  style={{
                    fontFamily: font.semibold,
                    fontSize: 32,
                    lineHeight: 34,
                    color: "white",
                  }}
                >
                  {item.title}
                </Text>
                <Text
                  style={{
                    color: "#D9CDEB",
                    fontSize: 12,
                    fontFamily: font.regular,
                  }}
                >
                  {item.creator}
                </Text>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <View
                    style={{
                      borderRadius: 20,
                      padding: 10,
                      backgroundColor: "#FFF",
                    }}
                  >
                    <Play size={14} fill={color.purple} color={color.purple} />
                  </View>
                  <Text
                    style={{
                      color: "white",
                      fontSize: 12,
                      fontFamily: font.medium,
                    }}
                  >
                    {playable
                      ? item.content_type?.startsWith("audio/")
                        ? "Listen in the feed"
                        : "Open full video"
                      : "Explore collection"}
                  </Text>
                </View>
              </View>
            </LinearGradient>
          </Pressable>
        </Animated.View>
        {items.length > 1 &&
          [-1, 1].map((direction) => (
            <Pressable
              key={direction}
              {...interaction}
              accessibilityRole="button"
              accessibilityLabel={
                direction < 0
                  ? "Previous gallery creation"
                  : "Next gallery creation"
              }
              onPress={() => advance(direction, true)}
              style={{
                position: "absolute",
                top: "45%",
                ...(direction < 0 ? { left: 2 } : { right: 2 }),
                minWidth: 44,
                minHeight: 48,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 24,
                backgroundColor: "#120D1F66",
              }}
            >
              {direction < 0 ? (
                <ChevronLeft color="white" size={28} />
              ) : (
                <ChevronRight color="white" size={28} />
              )}
            </Pressable>
          ))}
      </Pressable>
      <View
        style={{
          flexDirection: "row",
          gap: 12,
          paddingHorizontal: 30,
          paddingTop: 23,
          height: 44,
        }}
      >
        {items.map((entry, position) => (
          <Pressable
            key={entry.id}
            {...interaction}
            accessibilityRole="button"
            accessibilityLabel={`Show gallery creation ${position + 1}: ${entry.title}`}
            accessibilityState={{ selected: position === current }}
            onPress={() => {
              setRotationEnabled(false);
              show(position, position >= current ? 1 : -1);
            }}
            style={{ flex: 1, minHeight: 22, justifyContent: "center" }}
          >
            <View
              style={{
                height: 4,
                borderRadius: 3,
                backgroundColor:
                  position === current ? color.purple : "#ACA7AE",
              }}
            />
          </Pressable>
        ))}
      </View>
      <View
        style={{
          position: "absolute",
          top: 52,
          right: "18%",
          borderRadius: 22,
          backgroundColor: "#120D1FB8",
          minHeight: 40,
          paddingHorizontal: 5,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        {items.length > 1 && (
          <Pressable
            {...interaction}
            accessibilityRole="button"
            accessibilityLabel={
              rotationEnabled && !reducedMotion
                ? "Pause gallery rotation"
                : "Start gallery rotation"
            }
            accessibilityState={{ disabled: reducedMotion }}
            disabled={reducedMotion}
            onPress={() => setRotationEnabled(!rotationEnabled)}
            style={{
              minWidth: 44,
              minHeight: 40,
              flexDirection: "row",
              gap: 6,
              alignItems: "center",
              opacity: reducedMotion ? 0.6 : 1,
            }}
          >
            {rotationEnabled && !reducedMotion ? (
              <Pause color={color.muted} size={15} />
            ) : (
              <Play color={color.muted} size={15} />
            )}
          </Pressable>
        )}
        {playable && (
          <>
            <Pressable
              {...interaction}
              accessibilityRole="button"
              accessibilityLabel={
                mediaPaused || (reducedMotion && !explicitPlayback)
                  ? "Play gallery media"
                  : "Pause gallery media"
              }
              onPress={() => {
                setExplicitPlaybackId(item.id);
                setMediaPaused(
                  !(mediaPaused || (reducedMotion && !explicitPlayback)),
                );
                setRotationEnabled(false);
              }}
              style={{
                minWidth: 40,
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {mediaPaused || (reducedMotion && !explicitPlayback) ? (
                <Play color={color.text} size={18} />
              ) : (
                <Pause color={color.text} size={18} />
              )}
            </Pressable>
            <Pressable
              {...interaction}
              accessibilityRole="button"
              accessibilityLabel={
                muted ? "Unmute gallery media" : "Mute gallery media"
              }
              onPress={() => {
                setUnmutedItemId(muted ? item.id : null);
                setRotationEnabled(false);
              }}
              style={{
                minWidth: 40,
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {muted ? (
                <VolumeX color={color.text} size={18} />
              ) : (
                <Volume2 color={color.text} size={18} />
              )}
            </Pressable>
          </>
        )}
        <Text
          style={{ color: color.faint, fontSize: 10, fontFamily: font.regular }}
        >
          {current + 1} / {items.length}
        </Text>
      </View>
    </View>
  );
}
