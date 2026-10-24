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
import { Cover, categories } from "./ui";
import { ReelMedia } from "./reel-media";
import { ProfileMediaPreview } from "./profile-media-preview";
import { GalleryStillPreview } from "./gallery-still-preview";
import { useDevicePreferences } from "./device-preferences";
import { isPlayableMedia } from "../lib/domain";
import {
  galleryIndex,
  galleryNeighbors,
  galleryRotationAllowed,
} from "../lib/gallery";
import type { Item } from "../lib/types";
import { color, font, useTheme } from "../theme";

type StillStatus = "loading" | "ready" | "unavailable";

function stillKey(item: Item | null | undefined) {
  return (
    item && [
      item.id,
      item.media_url,
      item.cover,
      item.trim_start,
      item.trim_end,
      item.timeline,
    ]
  );
}

/** Three slots show real neighboring stills; only the front creation can play. */
export function GallerySlider({
  items,
  label,
  startMuted,
  onOpen,
}: {
  items: Item[];
  label: string;
  startMuted?: boolean;
  onOpen: (item: Item) => void;
}) {
  useTheme();
  const {
    preferences,
    ready,
    reducedMotion: deviceReducedMotion,
  } = useDevicePreferences();
  const focused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();
  const [width, setWidth] = useState(windowWidth);
  const [index, setIndex] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [visible, setVisible] = useState(true);
  const [saveData, setSaveData] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [controlFocused, setControlFocused] = useState(false);
  // Until accessibility settings resolve, do not start motion or video.
  const [systemReducedMotion, setReducedMotion] = useState(true);
  const reducedMotion = systemReducedMotion || deviceReducedMotion;
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [mediaPaused, setMediaPaused] = useState(false);
  const [explicitPlaybackId, setExplicitPlaybackId] = useState<string | null>(
    null,
  );
  const [audioOverride, setAudioOverride] = useState<{
    id: string;
    muted: boolean;
  } | null>(null);
  const container = useRef<View>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const translation = useRef(new Animated.Value(0)).current;
  const current = galleryIndex(index, items.length);
  const item = items[current];
  const neighbors = galleryNeighbors(items, current);
  const stillsEnabled = ready && focused && foreground && visible && !saveData;
  const stillSignature = JSON.stringify([
    stillKey(item),
    stillKey(neighbors.left),
    stillKey(neighbors.right),
  ]);
  const stillScene = useRef({
    signature: stillSignature,
    enabled: stillsEnabled,
  });
  if (stillScene.current.signature !== stillSignature)
    stillScene.current = { signature: stillSignature, enabled: stillsEnabled };
  const scene = stillScene.current;
  scene.enabled = stillsEnabled;
  const [stillStatuses, setStillStatuses] = useState<{
    scene: object;
    left?: StillStatus;
    right?: StillStatus;
  }>({ scene });
  const stillPending =
    stillsEnabled &&
    (["left", "right"] as const).some(
      (side) =>
        neighbors[side] &&
        (stillStatuses.scene !== scene ||
          !stillStatuses[side] ||
          stillStatuses[side] === "loading"),
    );
  const rotationWindow = useRef<{ scene: object; startedAt: number } | null>(
    null,
  );
  const explicitPlayback = !!item && explicitPlaybackId === item.id;
  const muted =
    !item ||
    !ready ||
    (audioOverride?.id === item.id
      ? audioOverride.muted
      : (startMuted ?? preferences.startMuted));
  const playbackPaused =
    mediaPaused ||
    ((reducedMotion || saveData || !ready || !preferences.autoplay) &&
      !explicitPlayback);
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
    setMediaPaused(!ready || !preferences.autoplay);
    setExplicitPlaybackId(null);
    // Never carry audible playback into the next creator's post.
    setAudioOverride(null);
  }, [item?.id, current, ready, preferences.autoplay, preferences.startMuted]);
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
    const connection = (
      navigator as Navigator & {
        connection?: {
          saveData?: boolean;
          addEventListener?: (name: string, fn: () => void) => void;
          removeEventListener?: (name: string, fn: () => void) => void;
        };
      }
    ).connection;
    const data = () => setSaveData(connection?.saveData === true);
    const reduce = () => setReducedMotion(preference.matches);
    reduce();
    data();
    sync();
    preference.addEventListener("change", reduce);
    connection?.addEventListener?.("change", data);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", blur);
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
      preference.removeEventListener("change", reduce);
      connection?.removeEventListener?.("change", data);
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
    enabled: ready && preferences.autoplay && !saveData && rotationEnabled,
    focused,
    foreground,
    visible,
    hovering,
    controlFocused,
    reducedMotion,
  });
  const rotationBlocked =
    reducedMotion || saveData || !ready || !preferences.autoplay;
  useEffect(() => {
    if (!rotating) {
      rotationWindow.current = null;
      return;
    }
    if (rotationWindow.current?.scene !== scene)
      rotationWindow.current = { scene, startedAt: Date.now() };
    // Do not rotate a cold neighbor away before its bounded capture/retry ends.
    // The anchored ceiling cannot be extended by repeated loading callbacks.
    const elapsed = Date.now() - rotationWindow.current.startedAt;
    const timer = setTimeout(
      () => advance(1),
      Math.max(0, (stillPending ? 22000 : 7000) - elapsed),
    );
    return () => clearTimeout(timer);
  }, [rotating, advance, scene, stillPending]);
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
  const mediaActive =
    playable &&
    focused &&
    foreground &&
    visible &&
    (!saveData || explicitPlayback);
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
        {/* Keep the live video out of a fading/transformed compositing layer. */}
        <View
          {...swipe.panHandlers}
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {([-1, 1] as const).map((offset) => {
            const neighbor = offset < 0 ? neighbors.left : neighbors.right;
            const side = offset < 0 ? "left" : "right";
            const sideStyle = {
              position: "absolute" as const,
              width: width * 0.65,
              height: "85%" as const,
              left: offset < 0 ? -width * 0.025 : width * 0.375,
              borderRadius: 25,
              overflow: "hidden" as const,
              borderWidth: 1,
              borderColor: "#82659F",
              opacity: neighbor ? 0.82 : 0.58,
              zIndex: 1,
              transform: [
                { perspective: 900 },
                { rotateY: offset < 0 ? "17deg" : "-17deg" },
                { scale: 0.94 },
              ],
            };
            return neighbor ? (
              <Pressable
                key={side}
                {...interaction}
                testID={`gallery-neighbor-${side}`}
                accessibilityRole="button"
                accessibilityLabel={`Show ${neighbor.title} in gallery`}
                accessibilityHint="Select this creation. Only the front card plays media."
                onPress={() => advance(offset, true)}
                style={sideStyle}
              >
                <GalleryStillPreview
                  item={neighbor}
                  enabled={stillsEnabled}
                  statusOwner={scene}
                  onStatus={(status) => {
                    if (stillScene.current !== scene || !scene.enabled) return;
                    setStillStatuses((previous) => {
                      if (previous.scene === scene && previous[side] === status)
                        return previous;
                      return {
                        ...(previous.scene === scene ? previous : { scene }),
                        [side]: status,
                      };
                    });
                  }}
                />
                <LinearGradient
                  pointerEvents="none"
                  colors={["transparent", "#160A29B8"]}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: 14,
                    paddingTop: 40,
                  }}
                >
                  <Text
                    numberOfLines={2}
                    style={{
                      color: "white",
                      fontFamily: font.medium,
                      fontSize: 14,
                    }}
                  >
                    {neighbor.title}
                  </Text>
                </LinearGradient>
              </Pressable>
            ) : (
              <View
                key={side}
                testID={`gallery-neighbor-${side}-empty`}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                style={sideStyle}
              >
                <LinearGradient
                  colors={
                    offset < 0
                      ? ["#6532AE", "#2F305B", "#31523B"]
                      : ["#31523B", "#3B3467", "#6532AE"]
                  }
                  style={{ flex: 1 }}
                />
              </View>
            );
          })}
          <Pressable
            {...interaction}
            accessibilityRole="button"
            testID="gallery-front-creation"
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
              // Media can be transparent or still loading. The whole front
              // silhouette must occlude neighboring cards, including its copy.
              backgroundColor: "#120D1F",
              boxShadow: "0 18px 28px #0005",
              zIndex: 2,
            }}
          >
            {item.content_type?.startsWith("image/") ? (
              <ProfileMediaPreview
                key={item.id}
                item={item}
                visible={focused && foreground && visible}
                videoActive={false}
                autoplay={!playbackPaused}
              />
            ) : playable ? (
              <ReelMedia
                key={item.id}
                item={item}
                active={mediaActive}
                paused={playbackPaused}
                muted={muted}
              />
            ) : (
              <Cover item={item} style={{ flex: 1 }} />
            )}
            <Animated.View
              testID="gallery-animated-copy"
              style={{
                flex: 1,
                opacity: fade,
                transform: [{ translateX: translation }],
              }}
            >
              <LinearGradient
                pointerEvents="none"
                colors={
                  item.category === "music" || item.category === "video"
                    ? ["#5300AF33", "#30005F00", "#160A29ED"]
                    : ["#0001", "#0000", "#110D1CED"]
                }
                style={{
                  flex: 1,
                  padding: 21,
                  justifyContent: "space-between",
                }}
              >
                <Text
                  style={{
                    color: "#F1E9FF",
                    fontFamily: font.medium,
                    fontSize: 11,
                    letterSpacing: 2,
                  }}
                >
                  {(
                    categories.find((entry) => entry.id === item.category)
                      ?.title || label
                  ).toUpperCase()}
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
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        borderRadius: 20,
                        padding: 10,
                        backgroundColor: "#FFF",
                      }}
                    >
                      <Play
                        size={14}
                        fill={color.purple}
                        color={color.purple}
                      />
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
            </Animated.View>
          </Pressable>
        </View>
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
              rotationBlocked
                ? "Automatic gallery rotation disabled by your preference"
                : rotationEnabled
                  ? "Pause gallery rotation"
                  : "Start gallery rotation"
            }
            accessibilityState={{ disabled: rotationBlocked }}
            disabled={rotationBlocked}
            onPress={() => setRotationEnabled(!rotationEnabled)}
            style={{
              minWidth: 44,
              minHeight: 40,
              flexDirection: "row",
              gap: 6,
              alignItems: "center",
              opacity: rotationBlocked ? 0.6 : 1,
            }}
          >
            {rotationEnabled && !rotationBlocked ? (
              <Pause color={color.onMedia} size={15} />
            ) : (
              <Play color={color.onMedia} size={15} />
            )}
          </Pressable>
        )}
        {playable && (
          <>
            <Pressable
              {...interaction}
              accessibilityRole="button"
              accessibilityLabel={
                playbackPaused ? "Play gallery media" : "Pause gallery media"
              }
              onPress={() => {
                setExplicitPlaybackId(item.id);
                setMediaPaused(!playbackPaused);
                setRotationEnabled(false);
              }}
              style={{
                minWidth: 40,
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {playbackPaused ? (
                <Play color={color.onMedia} size={18} />
              ) : (
                <Pause color={color.onMedia} size={18} />
              )}
            </Pressable>
            <Pressable
              {...interaction}
              accessibilityRole="button"
              accessibilityLabel={
                muted ? "Unmute gallery media" : "Mute gallery media"
              }
              onPress={() => {
                setAudioOverride({ id: item.id, muted: !muted });
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
                <VolumeX color={color.onMedia} size={18} />
              ) : (
                <Volume2 color={color.onMedia} size={18} />
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
