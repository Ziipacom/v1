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
import { fetch as nativeFetch } from "expo/fetch";
import {
  useVideoPlayer,
  type VideoSource,
  type VideoThumbnail,
} from "expo-video";
import { ImageIcon, Music2, Video } from "lucide-react-native";
import { LinearGradient } from "expo-linear-gradient";
import { background, coverSource, playbackSource } from "../lib/assets";
import { apiOrigin, canonicalApiOrigin, portalMode } from "../lib/config";
import { prepareNativeThumbnailSource } from "../lib/native-thumbnail-source";
import { profilePreviewRange } from "../lib/profile-preview";
import {
  galleryFrameHasPicture,
  galleryStillSize,
  galleryStillTimes,
  galleryStillTimeoutMs,
} from "../lib/gallery-preview";
import type { Item } from "../lib/types";
import {
  galleryStillCacheKey,
  webGalleryStillCache,
} from "../lib/gallery-still-cache";
import { useZiipa } from "../provider";
import { font } from "../theme";

type StillSource = NonNullable<ImageProps["source"]>;
type ThumbnailFailure = {
  phase:
    | "source"
    | "metadata"
    | "range"
    | "seek"
    | "frame"
    | "canvas"
    | "image"
    | "native";
  code:
    | "timeout"
    | "network"
    | "aborted"
    | "decode"
    | "unsupported"
    | "security"
    | "invalid"
    | "unavailable";
};

/** Neighboring video is decoded offscreen into an image, never a painted player. */
export function GalleryStillPreview({
  item,
  enabled,
  onStatus,
  statusOwner,
}: {
  item: Item;
  enabled: boolean;
  onStatus?: (status: "loading" | "ready" | "unavailable") => void;
  statusOwner?: object;
}) {
  const { session, stillCacheLease } = useZiipa();
  const cacheKey = galleryStillCacheKey(item);
  // Bootstrap refreshes allocate new timeline objects. The key describes every
  // input used by this raw retained-frame capture; object allocation does not.
  const identity = useMemo(
    () => ({}),
    [cacheKey, session?.access_token, stillCacheLease],
  );
  const [failure, setFailure] = useState<{
    identity: object;
    detail: ThumbnailFailure;
  } | null>(null);
  const [posterFailure, setPosterFailure] = useState<object | null>(null);
  const [posterReady, setPosterReady] = useState<object | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState<{
    identity: object;
    source: StillSource | null;
    dark: boolean;
    ownedThumbnail?: VideoThumbnail;
  } | null>(null);
  const [displayedFrame, setDisplayedFrame] = useState<{
    job: object;
    source: StillSource;
  } | null>(null);
  // Keep the native display receipt ahead of React's state commit so a timeout
  // at that boundary cannot reject pixels Image has already displayed.
  const displayReceipt = useRef(displayedFrame);
  const job = useMemo(() => ({}), [identity, enabled, attempt]);
  const currentJob = useRef({ identity, enabled, job });
  currentJob.current = { identity, enabled, job };
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
    setPosterFailure(null);
    setPosterReady(null);
    setDisplayedFrame(null);
    displayReceipt.current = null;
    setAttempt(0);
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
  // Only a provider-issued, still-active session lease can read these small
  // in-memory PNGs. Native SharedRefs remain component-owned and are not cached.
  const cachedUri =
    Platform.OS === "web" && enabled && transport && video && stillCacheLease
      ? webGalleryStillCache.get(stillCacheLease, cacheKey)
      : null;
  const frameSource = useMemo(
    () => currentFrame?.source || (cachedUri ? { uri: cachedUri } : null),
    [currentFrame, cachedUri],
  );
  const posterFailed = posterFailure === identity;
  const failed =
    (failure?.identity === identity && !cachedUri) || (posterFailed && !video);
  const failureDetail =
    failure?.identity === identity
      ? failure.detail
      : { phase: "image", code: "unavailable" };
  const retryPending = failed && video && !!source && attempt === 0;
  useEffect(() => {
    if (!enabled || !transport || !retryPending) return;
    // One fresh decoder retries a transient load. Never retry hidden cards or
    // loop indefinitely, and never accept a callback from the retired attempt.
    const timer = setTimeout(() => {
      if (currentJob.current.job !== job || !currentJob.current.enabled) return;
      setAttempt(1);
      setFailure(null);
    }, 750);
    return () => clearTimeout(timer);
  }, [enabled, transport, retryPending, job]);
  const showPoster =
    enabled && transport && poster && !posterFailed && !failed && !frameSource;
  const showVideo =
    enabled &&
    transport &&
    video &&
    !!source &&
    (!poster || posterFailed) &&
    !failed &&
    !currentFrame &&
    !frameSource;
  const frameDisplayed =
    !!frameSource &&
    (Platform.OS === "web" ||
      (displayedFrame?.job === job && displayedFrame.source === frameSource));
  useEffect(() => {
    if (
      Platform.OS === "web" ||
      !enabled ||
      !frameSource ||
      failed ||
      frameDisplayed
    )
      return;
    // Native decode completion precedes Expo Image's queued drawable update.
    // An Image that never displays must fail/retry instead of holding forever.
    const timer = setTimeout(() => {
      if (currentJob.current.job !== job || !currentJob.current.enabled) return;
      if (
        displayReceipt.current?.job === job &&
        displayReceipt.current.source === frameSource
      )
        return;
      setFailure({ identity, detail: { phase: "image", code: "timeout" } });
      setFrame(null);
    }, galleryStillTimeoutMs);
    return () => clearTimeout(timer);
  }, [identity, enabled, job, frameSource, failed, frameDisplayed]);
  const status = !enabled
    ? "unavailable"
    : frameDisplayed || (showPoster && posterReady === identity)
      ? "ready"
      : frameSource || showVideo || showPoster || retryPending
        ? "loading"
        : "unavailable";
  const statusListener = useRef(onStatus);
  statusListener.current = onStatus;
  useEffect(() => {
    if (currentJob.current.job === job) statusListener.current?.(status);
  }, [identity, enabled, job, status, statusOwner]);
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
          onReady={() => {
            if (currentJob.current.job === job && currentJob.current.enabled)
              setPosterReady(identity);
          }}
          onError={() => {
            if (
              currentJob.current.identity === identity &&
              currentJob.current.enabled
            )
              setPosterFailure(identity);
          }}
        />
      )}
      {showVideo && (
        <VideoThumbnailJob
          key={attempt}
          source={source!}
          item={item}
          identity={job}
          onReady={(source, dark = false, ownedThumbnail) => {
            if (
              currentJob.current.identity !== identity ||
              currentJob.current.job !== job ||
              !currentJob.current.enabled
            ) {
              if (ownedThumbnail) releaseThumbnail(ownedThumbnail);
              return;
            }
            if (Platform.OS === "web" && stillCacheLease) {
              if (!webGalleryStillCache.isActive(stillCacheLease)) return;
              if (
                source &&
                typeof source === "object" &&
                "uri" in source &&
                typeof source.uri === "string"
              )
                webGalleryStillCache.put(stillCacheLease, cacheKey, source.uri);
            }
            setFrame({ identity, source, dark, ownedThumbnail });
          }}
          onError={(detail = { phase: "native", code: "unavailable" }) => {
            if (
              currentJob.current.identity === identity &&
              currentJob.current.job === job &&
              currentJob.current.enabled
            )
              setFailure({ identity, detail });
          }}
        />
      )}
      {enabled && frameSource && !failed && (
        <Image
          source={frameSource}
          autoplay={false}
          contentFit="cover"
          cachePolicy="none"
          accessibilityLabel={`${item.title} representative still`}
          style={StyleSheet.absoluteFill}
          onDisplay={() => {
            if (currentJob.current.job === job && currentJob.current.enabled) {
              const receipt = { job, source: frameSource };
              displayReceipt.current = receipt;
              setDisplayedFrame(receipt);
            }
          }}
          onError={() => {
            if (
              currentJob.current.identity === identity &&
              currentJob.current.job === job
            ) {
              if (Platform.OS === "web" && stillCacheLease)
                webGalleryStillCache.delete(stillCacheLease, cacheKey);
              setFailure({
                identity,
                detail: { phase: "image", code: "unavailable" },
              });
              setFrame(null);
            }
          }}
        />
      )}
      {!showPoster && !showVideo && !(enabled && frameSource && !failed) && (
        <View
          // Enumerated phase/code only: never expose URLs, signed query strings,
          // credentials or browser error messages through the diagnostics.
          testID={
            failed
              ? `gallery-still-failure-${failureDetail.phase}-${failureDetail.code}`
              : undefined
          }
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
            {retryPending && enabled
              ? "Retrying still…"
              : failed
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
  onReady,
}: {
  source: ImageSourcePropType;
  onError: () => void;
  onReady: () => void;
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
    let live = true,
      settled = false;
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
    const stop = () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    };
    const fail = () => {
      if (!current() || settled) return;
      settled = true;
      clearTimeout(deadline);
      stop();
      latest.current();
    };
    const deadline = setTimeout(fail, galleryStillTimeoutMs);
    // Same-origin cookies still authorize the API hop. A signed cross-origin R2
    // redirect needs anonymous CORS so its pixels remain readable by the canvas.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!current() || settled) return;
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
        settled = true;
        clearTimeout(deadline);
      } catch {
        fail();
      } finally {
        stop();
      }
    };
    image.onerror = fail;
    image.src = uri;
    return () => {
      live = false;
      clearTimeout(deadline);
      stop();
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
      onLoad={onReady}
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
  onError: (detail?: ThumbnailFailure) => void;
};

function VideoThumbnailJob(props: ThumbnailProps) {
  return Platform.OS === "web" ? (
    <WebThumbnailJob {...props} />
  ) : (Platform.OS === "android" || Platform.OS === "ios") &&
    typeof props.source === "object" &&
    props.source !== null &&
    "uri" in props.source &&
    /^https?:\/\//i.test(props.source.uri || "") ? (
    <PreparedNativeThumbnailJob {...props} />
  ) : (
    <NativeThumbnailJob {...props} />
  );
}

/** Native image generators should open the resolved storage source directly. */
function PreparedNativeThumbnailJob(props: ThumbnailProps) {
  const latest = useRef(props);
  latest.current = props;
  const [prepared, setPrepared] = useState<{
    identity: object;
    source: VideoSource;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted && latest.current.identity === props.identity;
    void prepareNativeThumbnailSource(
      props.source,
      controller.signal,
      nativeFetch,
      [apiOrigin, canonicalApiOrigin],
    ).then(
      (source) => {
        if (current()) setPrepared({ identity: props.identity, source });
      },
      () => {
        if (current())
          latest.current.onError({ phase: "source", code: "unavailable" });
      },
    );
    return () => controller.abort();
  }, [props.source, props.identity]);
  return prepared?.identity === props.identity ? (
    <NativeThumbnailJob {...props} source={prepared.source} />
  ) : (
    <LoadingStill />
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
      position = 0,
      prepared = false,
      samplePending = false;
    let phase: ThumbnailFailure["phase"] = "metadata";
    let times: number[] = [];
    const current = () => live && latest.current.identity === props.identity;
    const decoder = document.createElement("video");
    const canvas = document.createElement("canvas");
    const stop = () => {
      decoder.onloadedmetadata = null;
      decoder.onloadeddata = null;
      decoder.oncanplay = null;
      decoder.onseeked = null;
      decoder.onerror = null;
      decoder.pause();
      decoder.preload = "none";
      decoder.removeAttribute("src");
      decoder.load();
    };
    const fail = (detail: ThumbnailFailure) => {
      if (!current() || settled) return;
      settled = true;
      clearTimeout(deadline);
      stop();
      latest.current.onError(detail);
    };
    const deadline = setTimeout(
      () => fail({ phase, code: "timeout" }),
      galleryStillTimeoutMs,
    );
    decoder.muted = true;
    decoder.volume = 0;
    decoder.playsInline = true;
    // A still needs decoded pixels, not only duration/container metadata. The
    // job never plays and is stopped after its bounded frame/deadline work.
    decoder.preload = "auto";
    decoder.crossOrigin = "anonymous";
    const prepare = () => {
      if (!current() || settled || prepared) return;
      try {
        times = galleryStillTimes(props.item, decoder.duration);
        if (!times.length) throw new Error("No retained frame");
        // Request retained pixels even when metadata has not exposed geometry.
        // Waiting for dimensions before seeking can strand a metadata-only load.
        prepared = true;
        phase = "seek";
        decoder.currentTime = times[0];
      } catch {
        fail({ phase: prepared ? "seek" : "range", code: "invalid" });
      }
    };
    const capture = () => {
      if (!current() || settled || !samplePending || decoder.seeking) return;
      if (decoder.readyState < 2 || !decoder.videoWidth || !decoder.videoHeight)
        return;
      try {
        phase = "canvas";
        const scale = Math.min(
          1,
          galleryStillSize / Math.max(decoder.videoWidth, decoder.videoHeight),
        );
        canvas.width = Math.max(1, Math.round(decoder.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(decoder.videoHeight * scale));
        samplePending = false;
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
          phase = "seek";
          decoder.currentTime = times[position];
        } else {
          settled = true;
          clearTimeout(deadline);
          stop();
          latest.current.onReady(null, true);
        }
      } catch (error) {
        fail({
          phase,
          code:
            error instanceof Error && error.name === "SecurityError"
              ? "security"
              : "unavailable",
        });
      }
    };
    decoder.onloadedmetadata = prepare;
    decoder.onseeked = () => {
      if (!prepared) return;
      phase = "frame";
      samplePending = true;
      capture();
    };
    decoder.onloadeddata = decoder.oncanplay = () => {
      prepare();
      capture();
    };
    decoder.onerror = () => {
      const code = decoder.error?.code;
      fail({
        phase,
        code:
          code === 1
            ? "aborted"
            : code === 2
              ? "network"
              : code === 3
                ? "decode"
                : code === 4
                  ? "unsupported"
                  : "unavailable",
      });
    };
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
      decoder.load();
    } catch {
      fail({ phase: "source", code: "unavailable" });
    }
    return () => {
      live = false;
      clearTimeout(deadline);
      stop();
    };
  }, [props.source, props.identity]);
  return <LoadingStill />;
}
