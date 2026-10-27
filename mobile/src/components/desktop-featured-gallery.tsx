import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Pressable,
  Text,
  View,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react-native";
import { ReelMedia } from "./reel-media";
import { useDevicePreferences } from "./device-preferences";
import { Action, Cover, categories } from "./ui";
import { ProfileMediaPreview } from "./profile-media-preview";
import { GalleryStillPreview } from "./gallery-still-preview";
import { useDesktopLayout } from "./desktop-layout";
import { featuredGalleryPlayback } from "../lib/featured-gallery-playback";
import { isPlayableMedia } from "../lib/domain";
import { galleryNeighbors } from "../lib/gallery";
import type { Item } from "../lib/types";
import { color, font, styles, themedStyles } from "../theme";

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

/** Only the front creation plays; two neighboring cards remain still. */
export function DesktopFeaturedGallery({
  items,
  open,
  startMuted,
}: {
  items: Item[];
  open: (item: Item) => void;
  startMuted?: boolean;
}) {
  const focused = useIsFocused();
  const {
    preferences,
    ready,
    reducedMotion: deviceReducedMotion,
  } = useDevicePreferences();
  const { contentWidth } = useDesktopLayout();
  const [selectedId, setSelectedId] = useState(items[0]?.id);
  const [userPaused, setUserPaused] = useState(false);
  const [rotationEnabled, setRotationEnabled] = useState(true);
  const [explicitPlaybackId, setExplicitPlaybackId] = useState<string | null>(
    null,
  );
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [saveData, setSaveData] = useState(false);
  const [visible, setVisible] = useState(false);
  // Do not start motion until the OS preference has been read successfully.
  const [systemReducedMotion, setReducedMotion] = useState(true);
  const reducedMotion = systemReducedMotion || deviceReducedMotion;
  const region = useRef<View>(null);
  const opacity = useRef(new Animated.Value(1)).current;
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const current = items[selectedIndex];
  const neighbors = galleryNeighbors(items, selectedIndex);
  const stillsEnabled = ready && focused && foreground && visible && !saveData;
  const stillSignature = JSON.stringify([
    stillKey(current),
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
  const rotationWindow = useRef<{
    scene: object;
    startedAt: number;
    settledAt: number | null;
  } | null>(null);
  const muted = startMuted ?? preferences.startMuted;
  const playable = !!current && isPlayableMedia(current);
  const { requestedPaused, playbackPaused, rotationAllowed } =
    featuredGalleryPlayback({
      count: items.length,
      hasCurrent: !!current,
      ready,
      autoplay: preferences.autoplay && !saveData,
      reducedMotion,
      focused: focused && visible,
      foreground,
      hovered,
      focusWithin,
      mediaPaused: userPaused,
      explicitPlayback: !!current && explicitPlaybackId === current.id,
      rotationEnabled,
    });
  const signature = items.map((item) => item.id).join(",");

  useEffect(() => {
    const element = region.current as unknown as HTMLElement | null;
    if (!element?.getBoundingClientRect) return;
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        ([entry]) =>
          setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.5),
        { threshold: [0, 0.5] },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }
    // ScrollView uses its own scroll container. Capture descendant scroll events
    // for browsers without IntersectionObserver rather than loading offscreen.
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const height =
        Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      const width =
        Math.min(bounds.right, window.innerWidth) - Math.max(0, bounds.left);
      const area =
        Math.min(bounds.height, window.innerHeight) *
        Math.min(bounds.width, window.innerWidth);
      setVisible(
        area > 0 && (Math.max(0, height) * Math.max(0, width)) / area >= 0.5,
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    setUserPaused(false);
    setExplicitPlaybackId(null);
  }, [current?.id, ready, preferences.autoplay]);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReducedMotion(value);
      })
      .catch(() => {});
    const motion = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    const state = AppState.addEventListener("change", (value) =>
      setForeground(value === "active"),
    );
    return () => {
      alive = false;
      motion.remove();
      state.remove();
    };
  }, []);

  useEffect(() => {
    const element = region.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    const focus = () => setFocusWithin(true);
    const blur = (event: FocusEvent) =>
      setFocusWithin(
        !!event.relatedTarget && element.contains(event.relatedTarget as Node),
      );
    const visibility = () =>
      setForeground(document.visibilityState === "visible");
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
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    data();
    connection?.addEventListener?.("change", data);
    return () => {
      element.removeEventListener("mouseenter", enter);
      element.removeEventListener("mouseleave", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      document.removeEventListener("visibilitychange", visibility);
      connection?.removeEventListener?.("change", data);
    };
  }, []);

  useEffect(() => {
    if (!rotationAllowed) {
      rotationWindow.current = null;
      return;
    }
    const now = Date.now();
    if (rotationWindow.current?.scene !== scene)
      rotationWindow.current = { scene, startedAt: now, settledAt: null };
    const window = rotationWindow.current;
    if (stillPending) window.settledAt = null;
    else window.settledAt ??= now;
    // Keep a bounded loading hold, then give the resolved neighboring cards a
    // full viewing interval. A cold capture must not cause immediate rotation.
    const deadline = stillPending
      ? window.startedAt + 22000
      : window.settledAt! + 7500;
    const timer = setTimeout(
      () => setSelectedId(items[(selectedIndex + 1) % items.length].id),
      Math.max(0, deadline - now),
    );
    return () => clearTimeout(timer);
  }, [rotationAllowed, selectedIndex, signature, items, scene, stillPending]);

  useEffect(() => {
    if (reducedMotion || !focused || !foreground || !visible) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.35);
    const transition = Animated.timing(opacity, {
      toValue: 1,
      duration: 320,
      useNativeDriver: false,
    });
    transition.start();
    return () => transition.stop();
  }, [current?.id, reducedMotion, focused, foreground, visible, opacity]);

  if (!current) return null;
  function step(direction: number) {
    setSelectedId(
      items[(selectedIndex + direction + items.length) % items.length].id,
    );
  }
  const compact = contentWidth < 1100;
  return (
    <View
      ref={region}
      style={g.gallery}
      accessibilityLabel="Featured published media gallery"
    >
      <View style={{ height: compact ? 294 : 340, justifyContent: "center" }}>
        {([-1, 1] as const).map((direction) => {
          const neighbor = direction < 0 ? neighbors.left : neighbors.right;
          const side = direction < 0 ? "left" : "right";
          const sideStyle = {
            position: "absolute" as const,
            width: "68%" as const,
            height: "85%" as const,
            ...(direction < 0 ? { left: 0 } : { right: 0 }),
            borderRadius: 12,
            overflow: "hidden" as const,
            borderWidth: 1,
            borderColor: "#82659F",
            zIndex: 1,
            opacity: neighbor ? 0.85 : 0.55,
            transform: [
              { perspective: 1100 },
              { rotateY: direction < 0 ? "12deg" : "-12deg" },
              { scale: 0.97 },
            ],
          };
          return neighbor ? (
            <Pressable
              key={side}
              testID={`desktop-gallery-neighbor-${side}`}
              accessibilityRole="button"
              accessibilityLabel={`Show ${neighbor.title} in gallery`}
              accessibilityHint="Select this creation. Only the front card plays media."
              onPress={() => {
                setRotationEnabled(false);
                step(direction);
              }}
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
            </Pressable>
          ) : (
            <View
              key={side}
              testID={`desktop-gallery-neighbor-${side}-empty`}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              aria-hidden
              style={sideStyle}
            >
              <LinearGradient
                colors={
                  direction < 0
                    ? ["#6532AE", "#2F305B", "#31523B"]
                    : ["#31523B", "#3B3467", "#6532AE"]
                }
                style={{ flex: 1 }}
              />
            </View>
          );
        })}
        <View
          testID="desktop-gallery-front-creation"
          style={[
            g.feature,
            {
              height: compact ? 280 : 320,
              width: "86%",
              alignSelf: "center",
              zIndex: 2,
              borderRadius: 12,
              overflow: "hidden",
              borderWidth: 1,
              borderColor: color.border,
              backgroundColor: color.panel,
            },
          ]}
        >
          {/* Animate copy only; the live video keeps an ordinary opaque surface. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${current.title} in Gallery feed`}
            onPress={() => open(current)}
            style={g.media}
          >
            <View pointerEvents="none" style={{ flex: 1 }}>
              {current.content_type?.startsWith("image/") ? (
                <ProfileMediaPreview
                  key={current.id}
                  item={current}
                  visible={focused && foreground && visible}
                  videoActive={false}
                  autoplay={!playbackPaused}
                />
              ) : playable ? (
                <ReelMedia
                  key={current.id}
                  item={current}
                  active={
                    focused &&
                    foreground &&
                    visible &&
                    (!saveData || explicitPlaybackId === current.id)
                  }
                  paused={playbackPaused}
                  muted={muted}
                />
              ) : (
                <Cover item={current} style={{ flex: 1 }} />
              )}
              <View pointerEvents="none" style={g.featureBadge}>
                <Text style={g.badgeText}>
                  FEATURED ·{" "}
                  {playable
                    ? muted
                      ? "MUTED PREVIEW"
                      : "MEDIA PREVIEW"
                    : "CREATION PREVIEW"}
                </Text>
              </View>
            </View>
          </Pressable>
          <Animated.View
            testID="desktop-gallery-animated-copy"
            style={[g.copy, { width: compact ? 240 : 300, opacity }]}
          >
            <Text style={styles.eyebrow}>
              {categories.find((entry) => entry.id === current.category)
                ?.title || "Creation"}
            </Text>
            <Text accessibilityRole="header" numberOfLines={2} style={g.title}>
              {current.title}
            </Text>
            <Text numberOfLines={1} style={g.creator}>
              {current.creator}
            </Text>
            {!!current.description && (
              <Text numberOfLines={compact ? 1 : 2} style={styles.small}>
                {current.description}
              </Text>
            )}
            <View style={{ marginTop: "auto", gap: 6 }}>
              <Action
                title={playable ? "Watch creation" : "Open creation"}
                icon={Play}
                onPress={() => open(current)}
              />
              <Text style={g.hint}>
                {requestedPaused
                  ? "Preview paused. Press Play when you’re ready."
                  : rotationAllowed
                    ? stillPending
                      ? "Preparing neighboring stills · rotation waits briefly."
                      : `${playable ? (muted ? "Muted media" : "Media preview") : "Creation preview"} · next creation every 7.5 seconds.`
                    : "Preview enabled · automatic gallery motion paused."}
              </Text>
            </View>
          </Animated.View>
        </View>
      </View>
      <View style={g.controls}>
        <View style={g.buttons}>
          <GalleryButton
            label="Previous featured creation"
            disabled={items.length < 2}
            onPress={() => step(-1)}
          >
            <ChevronLeft size={18} color={color.text} />
          </GalleryButton>
          {playable && (
            <GalleryButton
              label={
                requestedPaused
                  ? "Play featured preview"
                  : "Pause featured preview"
              }
              disabled={!ready}
              onPress={() => {
                setExplicitPlaybackId(current.id);
                setUserPaused(!requestedPaused);
              }}
            >
              {requestedPaused ? (
                <Play size={15} color={color.text} />
              ) : (
                <Pause size={15} color={color.text} />
              )}
              <Text style={g.controlText}>
                {requestedPaused ? "Play" : "Pause"}
              </Text>
            </GalleryButton>
          )}
          {items.length > 1 && (
            <GalleryButton
              label={
                reducedMotion || saveData || !preferences.autoplay
                  ? "Automatic gallery rotation disabled by your preference"
                  : rotationEnabled
                    ? "Pause featured gallery rotation"
                    : "Resume featured gallery rotation"
              }
              disabled={
                !ready || reducedMotion || saveData || !preferences.autoplay
              }
              onPress={() => setRotationEnabled(!rotationEnabled)}
            >
              <Text style={g.controlText}>
                {reducedMotion || saveData || !preferences.autoplay
                  ? "Rotation off"
                  : rotationEnabled
                    ? "Pause rotation"
                    : "Resume rotation"}
              </Text>
            </GalleryButton>
          )}
          <GalleryButton
            label="Next featured creation"
            disabled={items.length < 2}
            onPress={() => step(1)}
          >
            <ChevronRight size={18} color={color.text} />
          </GalleryButton>
        </View>
        <View style={g.buttons}>
          {items.length <= 8 &&
            items.map((item, index) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Show featured creation ${index + 1}: ${item.title}`}
                accessibilityState={{ selected: selectedIndex === index }}
                onPress={() => setSelectedId(item.id)}
                hitSlop={8}
                style={[g.dot, selectedIndex === index && g.activeDot]}
              />
            ))}
          <Text style={g.controlText}>
            {selectedIndex + 1} / {items.length}
          </Text>
        </View>
      </View>
    </View>
  );
}

function GalleryButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        g.control,
        { opacity: disabled ? 0.45 : pressed ? 0.7 : 1 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const g = themedStyles(() => ({
  gallery: {
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.panel,
  },
  feature: { flexDirection: "row", minWidth: 0 },
  media: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    backgroundColor: "#08060F",
  },
  featureBadge: {
    position: "absolute",
    top: 16,
    left: 16,
    backgroundColor: "#100A22CC",
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  badgeText: {
    fontFamily: font.medium,
    color: "white",
    fontSize: 10,
    letterSpacing: 0.7,
  },
  copy: { padding: 20, gap: 8 },
  title: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 22,
    lineHeight: 27,
  },
  creator: { color: color.text, fontFamily: font.medium, fontSize: 13 },
  hint: {
    color: color.faint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  controls: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderColor: color.border,
  },
  buttons: { flexDirection: "row", alignItems: "center", gap: 9 },
  control: {
    minHeight: 32,
    minWidth: 32,
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 7,
    backgroundColor: color.raised,
  },
  controlText: { color: color.muted, fontFamily: font.medium, fontSize: 12 },
  dot: { width: 6, height: 6, borderRadius: 4, backgroundColor: color.faint },
  activeDot: { width: 20, backgroundColor: color.lime },
}));
