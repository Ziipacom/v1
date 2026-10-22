import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
} from "react-native";
import { Image } from "expo-image";
import { Asset } from "expo-asset";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView, type VideoSource } from "expo-video";
import { ImageIcon, Music2, Video } from "lucide-react-native";
import { LinearGradient } from "expo-linear-gradient";
import { background, coverSource, playbackSource } from "../lib/assets";
import { portalMode } from "../lib/config";
import { profilePreviewRange } from "../lib/profile-preview";
import type { Item } from "../lib/types";
import { useZiipa } from "../provider";
import { font } from "../theme";

/** A neighboring creation is a still: no audio player and no call to play(). */
export function GalleryStillPreview({
  item,
  enabled,
}: {
  item: Item;
  enabled: boolean;
}) {
  const { session } = useZiipa();
  const identity = useMemo(
    () => ({}),
    [item.id, item.media_url, item.cover, session?.access_token],
  );
  const [failure, setFailure] = useState<object | null>(null);
  const transport = Platform.OS !== "web" || portalMode || !!item.demo;
  const cover = useMemo(
    () => coverSource(item.cover, session?.access_token),
    [item.cover, session?.access_token],
  );
  const poster =
    item.cover !== "/brand/ziipa-background.png" && cover !== background;
  const source = useMemo(
    () =>
      transport
        ? playbackSource(item.media_url, session?.access_token, !!item.demo)
        : null,
    [transport, item.media_url, session?.access_token, item.demo],
  );
  const video =
    item.content_type?.startsWith("video/") ||
    item.media_url === "/media/sintel-trailer.mp4";
  const failed = failure === identity;
  const showPoster = enabled && transport && poster && !failed;
  const showVideo =
    enabled && transport && video && !!source && !poster && !failed;
  const Icon = item.content_type?.startsWith("audio/")
    ? Music2
    : video
      ? Video
      : ImageIcon;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={["#48228E", "#34264E", "#183A31"]}
        style={StyleSheet.absoluteFill}
      />
      {showPoster && (
        <StillImage
          key={item.id}
          source={cover}
          onError={() => setFailure(identity)}
        />
      )}
      {showVideo && (
        <StillVideo
          key={item.id}
          source={source!}
          item={item}
          onError={() => setFailure(identity)}
        />
      )}
      {!showPoster && !showVideo && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              padding: 12,
            },
          ]}
        >
          <Icon color="#EEE6FC" size={27} />
          <Text
            style={{
              color: "white",
              fontFamily: font.medium,
              fontSize: 11,
              textAlign: "center",
            }}
          >
            {failed
              ? "Still preview unavailable"
              : !enabled
                ? "Preview paused"
                : !transport
                  ? "Open to view"
                  : item.content_type?.startsWith("audio/")
                    ? "Audio creation"
                    : "No still preview"}
          </Text>
        </View>
      )}
    </View>
  );
}

/** On web, capture one image frame instead of allowing a GIF/APNG to animate. */
function StillImage({
  source,
  onError,
}: {
  source: ImageSourcePropType;
  onError: () => void;
}) {
  const [frame, setFrame] = useState<{
    source: ImageSourcePropType;
    uri: string;
  } | null>(null);
  const latest = useRef(onError);
  latest.current = onError;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let live = true;
    let uri: string | undefined;
    try {
      uri =
        typeof source === "number"
          ? Asset.fromModule(source).uri
          : Array.isArray(source)
            ? source[0]?.uri
            : source.uri;
    } catch {
      latest.current();
      return;
    }
    if (!uri) {
      latest.current();
      return;
    }
    const image = document.createElement("img");
    // Same-origin cookies still authorize the API hop. A signed cross-origin R2
    // redirect needs anonymous CORS so its pixels remain readable by the canvas.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!live) return;
      try {
        if (!image.naturalWidth || !image.naturalHeight)
          throw new Error("No image dimensions");
        const scale = Math.min(
          1,
          360 / Math.max(image.naturalWidth, image.naturalHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setFrame({ source, uri: canvas.toDataURL("image/png") });
      } catch {
        latest.current();
      } finally {
        image.removeAttribute("src");
      }
    };
    image.onerror = () => {
      if (live) latest.current();
    };
    image.src = uri;
    return () => {
      live = false;
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    };
  }, [source]);
  const display =
    Platform.OS === "web"
      ? frame?.source === source
        ? { uri: frame.uri }
        : null
      : source;
  return display ? (
    <Image
      source={display}
      autoplay={false}
      contentFit="cover"
      cachePolicy="none"
      style={StyleSheet.absoluteFill}
      onError={onError}
    />
  ) : null;
}

function StillVideo({
  source,
  item,
  onError,
}: {
  source: VideoSource;
  item: Item;
  onError: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const latest = useRef(onError);
  latest.current = onError;
  const player = useVideoPlayer(source, (p) => {
    p.pause();
    p.muted = true;
    p.volume = 0;
    p.loop = false;
    p.staysActiveInBackground = false;
    p.showNowPlayingNotification = false;
    p.audioMixingMode = "mixWithOthers";
    const start = item.timeline?.clips[0]?.start ?? item.trim_start ?? 0;
    if (Number.isFinite(start) && start >= 0) p.currentTime = start;
    // Android has a byte cap; iOS honors the forward duration. Web buffering is
    // browser managed. These decoders never call play or enable native controls.
    p.bufferOptions = {
      preferredForwardBufferDuration: 0.5,
      minBufferForPlayback: 0.1,
      maxBufferBytes: 1024 * 1024,
      prioritizeTimeOverSizeThreshold: false,
    };
  });
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  useEffect(() => {
    player.pause();
    if (status === "error") {
      latest.current();
      return;
    }
    if (status !== "readyToPlay") return;
    try {
      const range = profilePreviewRange(item, player.duration);
      // Seek slightly inside the retained range so web also renders a first frame.
      player.currentTime =
        range.start + Math.min(0.05, (range.end - range.start) / 2);
    } catch {
      latest.current();
    }
  }, [player, status, item]);
  useEffect(() => {
    const guard = player.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying) player.pause();
    });
    return () => {
      guard.remove();
      try {
        player.pause();
      } catch {
        /* Expo may already have released it. */
      }
    };
  }, [player]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        playsInline
        allowsPictureInPicture={false}
        surfaceType="textureView"
        onFirstFrameRender={() => setRendered(true)}
      />
      {!rendered && (
        <Text
          style={{
            position: "absolute",
            bottom: 22,
            left: 5,
            right: 5,
            color: "white",
            fontFamily: font.regular,
            fontSize: 10,
            textAlign: "center",
          }}
        >
          Loading still…
        </Text>
      )}
    </View>
  );
}
