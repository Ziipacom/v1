import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
} from "react-native";
import { Image, type ImageProps } from "expo-image";
import { Asset } from "expo-asset";
import {
  useVideoPlayer,
  type VideoSource,
  type VideoThumbnail,
} from "expo-video";
import { ImageIcon, Music2, Video } from "lucide-react-native";
import { LinearGradient } from "expo-linear-gradient";
import { background, coverSource, playbackSource } from "../lib/assets";
import { portalMode } from "../lib/config";
import { profilePreviewRange } from "../lib/profile-preview";
import {
  galleryFrameHasPicture,
  galleryStillSize,
  galleryStillTimes,
  galleryStillTimeoutMs,
} from "../lib/gallery-preview";
import type { Item } from "../lib/types";
import { useZiipa } from "../provider";
import { font } from "../theme";

type StillSource = NonNullable<ImageProps["source"]>;

/** Neighboring video is decoded offscreen into an image, never a painted player. */
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
    [
      item.id,
      item.media_url,
      item.cover,
      item.trim_start,
      item.trim_end,
      item.timeline,
      session?.access_token,
    ],
  );
  const [failure, setFailure] = useState<object | null>(null);
  const [frame, setFrame] = useState<{
    identity: object;
    source: StillSource | null;
    dark: boolean;
    ownedThumbnail?: VideoThumbnail;
  } | null>(null);
  const currentJob = useRef({ identity, enabled });
  currentJob.current = { identity, enabled };
  const currentFrame = frame?.identity === identity ? frame : null;
  // Passive cleanup runs after the old Image has left the committed tree. The
  // decoder must not release a selected SharedRef while that Image still uses it.
  useEffect(
    () => () => {
      if (frame?.ownedThumbnail) releaseThumbnail(frame.ownedThumbnail);
    },
    [frame],
  );
  useEffect(() => {
    setFrame(null);
    setFailure(null);
  }, [identity, enabled]);
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
    enabled &&
    transport &&
    video &&
    !!source &&
    !poster &&
    !failed &&
    !currentFrame;
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
          onError={() => {
            if (
              currentJob.current.identity === identity &&
              currentJob.current.enabled
            )
              setFailure(identity);
          }}
        />
      )}
      {showVideo && (
        <VideoThumbnailJob
          source={source!}
          item={item}
          identity={identity}
          onReady={(source, dark = false, ownedThumbnail) => {
            if (
              currentJob.current.identity !== identity ||
              !currentJob.current.enabled
            ) {
              if (ownedThumbnail) releaseThumbnail(ownedThumbnail);
              return;
            }
            setFrame({ identity, source, dark, ownedThumbnail });
          }}
          onError={() => {
            if (
              currentJob.current.identity === identity &&
              currentJob.current.enabled
            )
              setFailure(identity);
          }}
        />
      )}
      {enabled && currentFrame?.source && !failed && (
        <Image
          source={currentFrame.source}
          autoplay={false}
          contentFit="cover"
          cachePolicy="none"
          accessibilityLabel={`${item.title} representative still`}
          style={StyleSheet.absoluteFill}
          onError={() => {
            if (currentJob.current.identity === identity) {
              setFailure(identity);
              setFrame(null);
            }
          }}
        />
      )}
      {!showPoster &&
        !showVideo &&
        !(enabled && currentFrame?.source && !failed) && (
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
                : currentFrame?.dark
                  ? "Dark video · Open to watch"
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
  const activeSource = useRef(source);
  activeSource.current = source;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let live = true;
    const current = () => live && activeSource.current === source;
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
      if (!current()) return;
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
      if (current()) latest.current();
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

type ThumbnailProps = {
  source: VideoSource;
  item: Item;
  identity: object;
  onReady: (
    source: StillSource | null,
    dark?: boolean,
    ownedThumbnail?: VideoThumbnail,
  ) => void;
  onError: () => void;
};

function VideoThumbnailJob(props: ThumbnailProps) {
  return Platform.OS === "web" ? (
    <WebThumbnailJob {...props} />
  ) : (
    <NativeThumbnailJob {...props} />
  );
}

function LoadingStill() {
  return (
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
  );
}

function releaseThumbnail(frame: VideoThumbnail) {
  try {
    frame.release();
  } catch {
    /* A stale, undisplayed image may already be released. */
  }
}

/** Native exposes no image pixels. Its valid interior timestamp is best effort. */
function NativeThumbnailJob(props: ThumbnailProps) {
  const latest = useRef(props);
  latest.current = props;
  const player = useVideoPlayer(props.source, (p) => {
    p.muted = true;
    p.volume = 0;
    p.pause();
    p.loop = false;
    p.staysActiveInBackground = false;
    p.showNowPlayingNotification = false;
    p.audioMixingMode = "mixWithOthers";
    p.bufferOptions = {
      preferredForwardBufferDuration: 0.5,
      minBufferForPlayback: 0.1,
      maxBufferBytes: 1024 * 1024,
      prioritizeTimeOverSizeThreshold: false,
    };
  });
  useEffect(() => {
    let live = true,
      started = false,
      settled = false;
    const current = () => live && latest.current.identity === props.identity;
    const fail = () => {
      if (!current() || settled) return;
      settled = true;
      clearTimeout(deadline);
      player.pause();
      latest.current.onError();
    };
    const deadline = setTimeout(fail, galleryStillTimeoutMs);
    const generate = async () => {
      if (!current() || started || settled) return;
      started = true;
      try {
        const range = profilePreviewRange(props.item, player.duration);
        const times = galleryStillTimes(props.item, player.duration);
        for (const time of times) {
          if (!current() || settled) return;
          // Sequential, one small bitmap at a time. The API cannot cancel an
          // in-flight native call; the guard prevents later work or stale images.
          const frames = await player.generateThumbnailsAsync([time], {
            maxWidth: galleryStillSize,
            maxHeight: galleryStillSize,
          });
          const selected = frames.find(
            (frame) =>
              frame.width > 0 &&
              frame.height > 0 &&
              (frame.actualTime == null ||
                (Number.isFinite(frame.actualTime) &&
                  frame.actualTime >= range.start &&
                  frame.actualTime < range.end)),
          );
          if (!current() || settled) {
            frames.forEach(releaseThumbnail);
            return;
          }
          frames
            .filter((frame) => frame !== selected)
            .forEach(releaseThumbnail);
          if (!selected) continue;
          settled = true;
          clearTimeout(deadline);
          player.pause();
          latest.current.onReady(selected, false, selected);
          return;
        }
        fail();
      } catch {
        fail();
      }
    };
    const status = player.addListener("statusChange", (event) => {
      if (event.status === "readyToPlay") void generate();
      else if (event.status === "error") fail();
    });
    const playing = player.addListener("playingChange", (event) => {
      if (event.isPlaying) player.pause();
    });
    if (player.status === "readyToPlay") void generate();
    else if (player.status === "error") fail();
    return () => {
      live = false;
      clearTimeout(deadline);
      status.remove();
      playing.remove();
      try {
        player.pause();
      } catch {
        /* Hook-owned player may already be released. */
      }
    };
  }, [player, props.identity]);
  return <LoadingStill />;
}

/** A detached decoder avoids browser video compositing inside the 3D cards. */
function WebThumbnailJob(props: ThumbnailProps) {
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let live = true,
      settled = false,
      position = 0;
    let times: number[] = [];
    const current = () => live && latest.current.identity === props.identity;
    const decoder = document.createElement("video");
    const canvas = document.createElement("canvas");
    const stop = () => {
      decoder.onloadedmetadata = null;
      decoder.onseeked = null;
      decoder.onerror = null;
      decoder.pause();
      decoder.removeAttribute("src");
      decoder.load();
    };
    const fail = () => {
      if (!current() || settled) return;
      settled = true;
      clearTimeout(deadline);
      stop();
      latest.current.onError();
    };
    const deadline = setTimeout(fail, galleryStillTimeoutMs);
    decoder.muted = true;
    decoder.volume = 0;
    decoder.playsInline = true;
    decoder.preload = "metadata";
    decoder.crossOrigin = "anonymous";
    decoder.onloadedmetadata = () => {
      if (!current() || settled) return;
      try {
        times = galleryStillTimes(props.item, decoder.duration);
        if (!times.length || !decoder.videoWidth || !decoder.videoHeight)
          throw new Error("No frame geometry");
        const scale = Math.min(
          1,
          galleryStillSize / Math.max(decoder.videoWidth, decoder.videoHeight),
        );
        canvas.width = Math.max(1, Math.round(decoder.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(decoder.videoHeight * scale));
        decoder.currentTime = times[0];
      } catch {
        fail();
      }
    };
    decoder.onseeked = () => {
      if (!current() || settled) return;
      try {
        if (decoder.readyState < 2) throw new Error("No decoded frame");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("No canvas");
        context.drawImage(decoder, 0, 0, canvas.width, canvas.height);
        if (
          galleryFrameHasPicture(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
          )
        ) {
          const source = { uri: canvas.toDataURL("image/png") };
          settled = true;
          clearTimeout(deadline);
          stop();
          latest.current.onReady(source);
        } else if (++position < times.length) {
          decoder.currentTime = times[position];
        } else {
          settled = true;
          clearTimeout(deadline);
          stop();
          latest.current.onReady(null, true);
        }
      } catch {
        fail();
      }
    };
    decoder.onerror = fail;
    try {
      const source = props.source;
      const uri =
        typeof source === "number"
          ? Asset.fromModule(source).uri
          : typeof source === "string"
            ? source
            : source?.uri;
      if (!uri) throw new Error("No trusted source");
      decoder.src = uri;
    } catch {
      fail();
    }
    return () => {
      live = false;
      clearTimeout(deadline);
      stop();
    };
  }, [props.source, props.identity]);
  return <LoadingStill />;
}
