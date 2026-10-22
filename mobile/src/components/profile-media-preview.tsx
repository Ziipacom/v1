import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useEvent } from "expo";
import { VideoView, useVideoPlayer, type VideoSource } from "expo-video";
import { useIsFocused } from "@react-navigation/native";
import { ImageIcon, Music2, Play, RefreshCw } from "lucide-react-native";
import { Cover } from "./ui";
import { useDevicePreferences } from "./device-preferences";
import { useZiipa } from "../provider";
import { coverSource, localImages, playbackSource } from "../lib/assets";
import { portalMode } from "../lib/config";
import {
  profileMediaKind,
  profilePreviewHasEdits,
  profilePreviewPolicy,
  profilePreviewRange,
} from "../lib/profile-preview";
import type { Item } from "../lib/types";
import { font } from "../theme";

/** One shared lifecycle policy, not a background listener for every profile card. */
export function useProfilePreviewActivity(blocked: boolean) {
  const focused = useIsFocused();
  const { preferences, ready, reducedMotion } = useDevicePreferences();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [saveData, setSaveData] = useState(false);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    if (Platform.OS !== "web") return () => listener.remove();
    const connection = (
      navigator as Navigator & {
        connection?: {
          saveData?: boolean;
          addEventListener?: (name: string, fn: () => void) => void;
          removeEventListener?: (name: string, fn: () => void) => void;
        };
      }
    ).connection;
    const visible = () =>
      setForeground(
        document.visibilityState !== "hidden" && document.hasFocus(),
      );
    const hidden = () => setForeground(false);
    const data = () => setSaveData(connection?.saveData === true);
    visible();
    data();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    window.addEventListener("blur", hidden);
    connection?.addEventListener?.("change", data);
    return () => {
      listener.remove();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
      window.removeEventListener("blur", hidden);
      connection?.removeEventListener?.("change", data);
    };
  }, []);
  return {
    ...profilePreviewPolicy({
      focused,
      foreground,
      ready,
      autoplay: preferences.autoplay,
      reducedMotion,
      saveData,
      blocked,
    }),
    visible: focused && foreground && !blocked,
  };
}

/** Cards stream native/cookie media; they never request a whole private video blob. */
export function ProfileMediaPreview({
  item,
  visible,
  videoActive,
  autoplay,
}: {
  item: Item;
  visible: boolean;
  videoActive: boolean;
  autoplay: boolean;
}) {
  const { session } = useZiipa();
  const identity = useMemo(
    () => ({}),
    [item.id, item.media_url, item.cover, session?.access_token],
  );
  const [failure, setFailure] = useState<object | null>(null);
  const [attempt, setAttempt] = useState(0);
  const kind = profileMediaKind(item);
  const failed = failure === identity;
  const transport = Platform.OS !== "web" || portalMode || !!item.demo;
  const source = useMemo(
    () =>
      transport
        ? playbackSource(item.media_url, session?.access_token, !!item.demo)
        : null,
    [transport, item.media_url, session?.access_token, item.demo],
  );
  // Expo Image can pause native animations, but its web renderer uses <img>.
  // Without an animation flag from the server, GIF/WebP/PNG may be animated.
  const animationPaused =
    Platform.OS === "web" &&
    !autoplay &&
    /^(image\/(gif|webp|png))$/i.test(item.content_type || "");
  const image =
    visible && transport && kind === "image" && !failed && !animationPaused;
  const video =
    videoActive && transport && kind === "video" && !!source && !failed;
  const fallback = localImages[item.cover]
    ? item
    : { ...item, cover: "/brand/ziipa-background.png" };
  const Icon = kind === "audio" ? Music2 : kind === "image" ? ImageIcon : Play;
  const text = failed
    ? "Preview unavailable"
    : kind === "audio"
      ? "Audio · Open to listen"
      : kind === "none"
        ? "No media attached"
        : !transport
          ? "Open creation to view media"
          : animationPaused
            ? "Image preview paused · Open to view"
            : kind === "image"
              ? "Image"
              : "Video · Open to play";
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Cover item={fallback} style={{ flex: 1 }} />
      {image && (
        <Image
          source={coverSource(item.cover, session?.access_token)}
          contentFit="cover"
          autoplay={autoplay}
          cachePolicy="none"
          accessibilityLabel={`${item.title} image preview`}
          onError={() => setFailure(identity)}
          style={StyleSheet.absoluteFill}
        />
      )}
      {video && (
        <ProfileVideo
          key={`${item.id}:${attempt}`}
          source={source!}
          item={item}
          autoplay={autoplay}
          onError={() => setFailure(identity)}
        />
      )}
      {((!image && !video) || failed) && (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { alignItems: "center", justifyContent: "center", gap: 6 },
          ]}
        >
          <Icon color="white" size={25} strokeWidth={1.5} />
          <Text
            style={{
              color: "white",
              fontFamily: font.medium,
              fontSize: 11,
              textAlign: "center",
              paddingHorizontal: 14,
            }}
          >
            {text}
          </Text>
        </View>
      )}
      {video && (
        <Text
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 10,
            top: 9,
            color: "white",
            fontFamily: font.medium,
            fontSize: 10,
            backgroundColor: "#0009",
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: 5,
          }}
        >
          {profilePreviewHasEdits(item)
            ? "Preview · Open full edit"
            : "Video preview · Muted"}
        </Text>
      )}
      {failed && visible && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry preview for ${item.title}`}
          onPress={(event) => {
            event.stopPropagation();
            setFailure(null);
            setAttempt((value) => value + 1);
          }}
          style={{
            position: "absolute",
            right: 8,
            top: 6,
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            backgroundColor: "#0009",
          }}
        >
          <RefreshCw color="white" size={20} />
        </Pressable>
      )}
    </View>
  );
}

function ProfileVideo({
  source,
  item,
  autoplay,
  onError,
}: {
  source: VideoSource;
  item: Item;
  autoplay: boolean;
  onError: () => void;
}) {
  const latest = useRef(onError);
  latest.current = onError;
  const player = useVideoPlayer(source, (p) => {
    p.muted = true;
    p.volume = 0;
    // Loop the retained range ourselves: native full-file looping could briefly
    // restart at discarded source time zero before a JS time update arrives.
    p.loop = false;
    p.staysActiveInBackground = false;
    p.showNowPlayingNotification = false;
    p.audioMixingMode = "mixWithOthers";
    p.timeUpdateEventInterval = 0.2;
    p.bufferOptions = {
      preferredForwardBufferDuration: 2,
      minBufferForPlayback: 0.5,
      maxBufferBytes: 4 * 1024 * 1024,
    };
  });
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const positioned = useRef<unknown>(null);
  useEffect(() => {
    if (status === "error") {
      player.pause();
      latest.current();
      return;
    }
    if (status !== "readyToPlay") return;
    try {
      const range = profilePreviewRange(item, player.duration);
      player.muted = true;
      player.volume = 0;
      player.playbackRate = range.speed;
      if (positioned.current !== player) {
        player.currentTime = range.start;
        positioned.current = player;
      }
      if (autoplay) player.play();
      else player.pause();
    } catch {
      player.pause();
      latest.current();
    }
  }, [player, status, autoplay, item]);
  useEffect(() => {
    if (positioned.current !== player || status !== "readyToPlay") return;
    try {
      const range = profilePreviewRange(item, player.duration);
      if (currentTime >= range.end || currentTime < range.start)
        player.currentTime = range.start;
    } catch {
      player.pause();
      latest.current();
    }
  }, [player, status, currentTime, item]);
  useEffect(() => {
    const ended = player.addListener("playToEnd", () => {
      try {
        const range = profilePreviewRange(item, player.duration);
        player.currentTime = range.start;
        if (autoplay) player.play();
      } catch {
        player.pause();
        latest.current();
      }
    });
    return () => ended.remove();
  }, [player, item, autoplay]);
  // useVideoPlayer owns release on unmount/source changes; pause before release.
  useEffect(
    () => () => {
      try {
        player.pause();
      } catch {
        /* Already released by Expo. */
      }
    },
    [player],
  );
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, { width: "100%", height: "100%" }]}
        contentFit="cover"
        nativeControls={false}
        playsInline
        allowsPictureInPicture={false}
        surfaceType="textureView"
      />
    </View>
  );
}
