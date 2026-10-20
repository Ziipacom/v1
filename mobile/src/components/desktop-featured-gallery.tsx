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
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react-native";
import { ReelMedia } from "./reel-media";
import { useDevicePreferences } from "./device-preferences";
import { Action, categories } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { featuredGalleryPlayback } from "../lib/featured-gallery-playback";
import type { Item } from "../lib/types";
import { color, font, styles, themedStyles } from "../theme";

/** Only the selected, published source mounts a player. Never preload a reel wall. */
export function DesktopFeaturedGallery({
  items,
  open,
}: {
  items: Item[];
  open: (item: Item) => void;
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
  const { requestedPaused, playbackPaused, rotationAllowed } =
    featuredGalleryPlayback({
      count: items.length,
      hasCurrent: !!current,
      ready,
      autoplay: preferences.autoplay,
      reducedMotion,
      focused,
      foreground,
      hovered,
      focusWithin,
      mediaPaused: userPaused,
      explicitPlayback: !!current && explicitPlaybackId === current.id,
      rotationEnabled,
    });
  const signature = items.map((item) => item.id).join(",");

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
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      element.removeEventListener("mouseenter", enter);
      element.removeEventListener("mouseleave", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    if (rotationAllowed) {
      const timer = setTimeout(
        () => setSelectedId(items[(selectedIndex + 1) % items.length].id),
        7500,
      );
      return () => clearTimeout(timer);
    }
  }, [rotationAllowed, selectedIndex, signature, items]);

  useEffect(() => {
    if (reducedMotion || !focused || !foreground) {
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
  }, [current?.id, reducedMotion, focused, foreground, opacity]);

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
      <View style={[g.feature, { height: compact ? 280 : 320 }]}>
        <Animated.View style={[g.media, { opacity }]}>
          <ReelMedia
            key={current.id}
            item={current}
            active={focused && foreground}
            paused={playbackPaused}
            muted={preferences.startMuted}
          />
          <View pointerEvents="none" style={g.featureBadge}>
            <Text style={g.badgeText}>
              FEATURED ·{" "}
              {preferences.startMuted ? "MUTED PREVIEW" : "MEDIA PREVIEW"}
            </Text>
          </View>
        </Animated.View>
        <View style={[g.copy, { width: compact ? 270 : 330 }]}>
          <Text style={styles.eyebrow}>
            {categories.find((entry) => entry.id === current.category)?.title ||
              "Creation"}
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
              title="Watch creation"
              icon={Play}
              onPress={() => open(current)}
            />
            <Text style={g.hint}>
              {requestedPaused
                ? "Preview paused. Press Play when you’re ready."
                : rotationAllowed
                  ? `${preferences.startMuted ? "Muted media" : "Media preview"} · next creation every 7.5 seconds.`
                  : "Preview enabled · automatic gallery motion paused."}
            </Text>
          </View>
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
          <GalleryButton
            label={requestedPaused ? "Play featured preview" : "Pause featured preview"}
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
          {items.length > 1 && (
            <GalleryButton
              label={
                reducedMotion || !preferences.autoplay
                  ? "Automatic gallery rotation disabled by your preference"
                  : rotationEnabled
                    ? "Pause featured gallery rotation"
                    : "Resume featured gallery rotation"
              }
              disabled={!ready || reducedMotion || !preferences.autoplay}
              onPress={() => setRotationEnabled(!rotationEnabled)}
            >
              <Text style={g.controlText}>
                {reducedMotion || !preferences.autoplay
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
          {items.map((item, index) => (
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
