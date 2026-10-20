import { useEffect, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { Image, type ImageSource } from "expo-image";
import { VideoView, useVideoPlayer, type VideoSource } from "expo-video";
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioSource,
} from "expo-audio";
import { useEvent } from "expo";
import { useIsFocused } from "@react-navigation/native";
import { Cover } from "./ui";
import { useZiipa } from "../provider";
import { usePlaybackSource } from "../lib/media-playback";
import { coverSource } from "../lib/assets";
import type { Item, TimelineClip, VisualEffect } from "../lib/types";

export type EditorFrame = { time: number; source: ImageSource };
type Props = {
  item: Item;
  localUri?: string;
  paused: boolean;
  muted: boolean;
  clips: TimelineClip[];
  seek: { time: number; nonce: number };
  onTime: (time: number) => void;
  onDuration: (duration: number) => void;
  onFrames: (frames: EditorFrame[]) => void;
  generateFrames?: boolean;
  onDimensions?: (width: number, height: number) => void;
};

/** Only trusted, authenticated sources enter the editor, as in the feed player. */
export function EditorPreview(props: Props) {
  const { session } = useZiipa();
  const focused = useIsFocused();
  const { source, loading, error } = usePlaybackSource(
    props.item.media_url,
    session?.access_token,
    !!props.item.demo,
    focused,
    props.localUri,
  );
  const image = props.item.content_type?.startsWith("image/");
  const audio = props.item.content_type?.startsWith("audio/");
  const pictureTime = useRef(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const visible = useForeground();
  useEffect(() => {
    pictureTime.current = props.seek.time;
  }, [props.seek.nonce]);
  useEffect(() => {
    if (!image || props.paused || !visible) return;
    const clock = setInterval(() => {
      pictureTime.current = (pictureTime.current + 0.1) % 6;
      callbacks.current.onTime(pictureTime.current);
    }, 100);
    return () => clearInterval(clock);
  }, [image, props.paused, visible]);
  useEffect(() => {
    if (image) props.onDuration(6);
  }, [image, props.item.media_url, props.localUri]);
  useEffect(() => {
    if (audio) props.onDimensions?.(1, 1);
  }, [audio, props.item.media_url, props.localUri]);
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        Platform.OS === "web"
          ? ({
              filter: effectFilter(props.item.visual_effect || "none"),
            } as never)
          : null,
      ]}
    >
      <Cover item={props.item} style={{ flex: 1 }} />
      {audio && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }]} />
      )}
      {image && (
        <Image
          source={
            props.localUri
              ? { uri: props.localUri }
              : coverSource(props.item.cover, session?.access_token)
          }
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          onLoad={(event) =>
            props.onDimensions?.(event.source.width, event.source.height)
          }
        />
      )}
      {!image &&
        source &&
        (props.item.content_type?.startsWith("audio/") ? (
          <EditorAudio
            key={props.localUri || props.item.media_url}
            {...props}
            source={source}
          />
        ) : (
          <EditorVideo
            key={props.localUri || props.item.media_url}
            {...props}
            source={source}
          />
        ))}
      {(loading || !!error) && (
        <Text style={p.message}>{error || "Loading your media…"}</Text>
      )}
    </View>
  );
}

function locate(clips: TimelineClip[], time: number) {
  let offset = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const length = (clip.end - clip.start) / (clip.speed || 1);
    if (time < offset + length || index === clips.length - 1)
      return {
        index,
        source:
          clip.start +
          Math.max(0, Math.min(length, time - offset)) * (clip.speed || 1),
      };
    offset += length;
  }
  return { index: 0, source: Math.max(0, time) };
}
function outputTime(clips: TimelineClip[], index: number, source: number) {
  return (
    clips
      .slice(0, index)
      .reduce(
        (total, clip) => total + (clip.end - clip.start) / (clip.speed || 1),
        0,
      ) +
    (clips[index]
      ? Math.max(0, source - clips[index].start) / (clips[index].speed || 1)
      : source)
  );
}
function useForeground() {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => sub.remove();
  }, []);
  return focused && foreground;
}
function EditorVideo(props: Props & { source: VideoSource }) {
  const visible = useForeground();
  const callbacks = useRef(props);
  callbacks.current = props;
  const index = useRef(0);
  const player = useVideoPlayer(props.source, (p) => {
    p.muted = true;
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
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
  const ready = status === "readyToPlay";
  const [loadedDuration, setLoadedDuration] = useState(0);
  const appliedSeek = useRef("");
  const clipsKey = JSON.stringify(props.clips);
  useEffect(() => {
    player.muted = props.muted;
  }, [player, props.muted]);
  useEffect(() => {
    if (ready && visible && !props.paused) player.play();
    else player.pause();
  }, [player, ready, visible, props.paused]);
  useEffect(() => {
    if (!ready || !Number.isFinite(player.duration) || !player.duration) return;
    callbacks.current.onDuration(player.duration);
    setLoadedDuration(player.duration);
    const size =
      player.videoTrack?.size || player.availableVideoTracks[0]?.size;
    if (size?.width && size.height)
      callbacks.current.onDimensions?.(size.width, size.height);
  }, [player, ready]);
  useEffect(() => {
    const identity = `${props.seek.nonce}:${clipsKey}`;
    if (!ready || appliedSeek.current === identity) return;
    appliedSeek.current = identity;
    const target = locate(props.clips, props.seek.time);
    index.current = target.index;
    player.playbackRate = props.clips[target.index]?.speed || 1;
    player.currentTime = target.source;
  }, [player, ready, props.seek.nonce, props.seek.time, clipsKey]);
  useEffect(() => {
    if (!ready || !visible) return;
    const clips = callbacks.current.clips;
    const clip = clips[index.current];
    if (clip && !callbacks.current.paused && currentTime >= clip.end - 0.04) {
      index.current = index.current + 1 < clips.length ? index.current + 1 : 0;
      player.playbackRate = clips[index.current].speed || 1;
      player.currentTime = clips[index.current].start;
      player.play();
      callbacks.current.onTime(
        outputTime(clips, index.current, clips[index.current].start),
      );
    } else if (
      clip &&
      currentTime >= clip.start - 0.1 &&
      currentTime <= clip.end + 0.1
    ) {
      callbacks.current.onTime(outputTime(clips, index.current, currentTime));
    } else if (!clips.length) callbacks.current.onTime(currentTime);
  }, [player, ready, currentTime, visible]);
  useEffect(() => {
    if (!loadedDuration) return;
    let live = true;
    const times = Array.from({ length: 8 }, (_, i) =>
      Math.min(player.duration - 0.05, (player.duration * i) / 8),
    );
    if (Platform.OS !== "web") {
      if (props.generateFrames === false) return;
      void player
        .generateThumbnailsAsync(times, { maxWidth: 150, maxHeight: 100 })
        .then((frames) => {
          if (live)
            callbacks.current.onFrames(
              frames.map((source, i) => ({ time: times[i], source })),
            );
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }
    // Expo does not expose web thumbnails. This isolated, muted decoder reads
    // the already validated same-origin/local source, never an arbitrary URL.
    const uri =
      typeof props.source === "object" && props.source
        ? props.source.uri
        : null;
    if (!uri) return;
    const decoder = document.createElement("video");
    decoder.preload = "metadata";
    decoder.muted = true;
    decoder.playsInline = true;
    const canvas = document.createElement("canvas");
    canvas.width = 150;
    canvas.height = 86;
    const frames: EditorFrame[] = [];
    let frame = 0;
    decoder.onloadedmetadata = () => {
      if (!live) return;
      callbacks.current.onDimensions?.(decoder.videoWidth, decoder.videoHeight);
      if (props.generateFrames === false) {
        decoder.removeAttribute("src");
        decoder.load();
        return;
      }
      decoder.currentTime = Math.max(0.01, times[0]);
    };
    decoder.onseeked = () => {
      if (!live) return;
      try {
        canvas.getContext("2d")?.drawImage(decoder, 0, 0, 150, 86);
        frames.push({
          time: times[frame],
          source: { uri: canvas.toDataURL("image/jpeg", 0.65) },
        });
      } catch {
        return;
      }
      frame++;
      if (frame < times.length) decoder.currentTime = times[frame];
      else callbacks.current.onFrames(frames);
    };
    decoder.src = uri;
    return () => {
      live = false;
      decoder.pause();
      decoder.removeAttribute("src");
      decoder.load();
    };
  }, [player, loadedDuration, props.source, props.generateFrames]);
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }]}
    >
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, { width: "100%", height: "100%" }]}
        contentFit="contain"
        nativeControls={false}
        playsInline
        allowsPictureInPicture={false}
        surfaceType="textureView"
      />
      {status === "error" && (
        <Text style={p.message}>
          This format cannot be previewed on this device. Your original file is
          unchanged.
        </Text>
      )}
    </View>
  );
}
function EditorAudio(props: Props & { source: AudioSource }) {
  const player = useAudioPlayer(props.source, { updateInterval: 100 });
  const state = useAudioPlayerStatus(player);
  const visible = useForeground();
  const index = useRef(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    player.muted = props.muted;
  }, [player, props.muted]);
  useEffect(() => {
    if (visible && !props.paused && state.isLoaded) player.play();
    else player.pause();
  }, [player, visible, props.paused, state.isLoaded]);
  useEffect(() => {
    if (state.isLoaded && state.duration)
      callbacks.current.onDuration(state.duration);
  }, [state.duration, state.isLoaded]);
  useEffect(() => {
    if (!state.isLoaded) return;
    const target = locate(props.clips, props.seek.time);
    index.current = target.index;
    player.setPlaybackRate(props.clips[target.index]?.speed || 1);
    void player.seekTo(target.source);
  }, [player, state.isLoaded, props.seek.nonce]);
  useEffect(() => {
    const clip = props.clips[index.current];
    if (clip && !props.paused && state.currentTime >= clip.end - 0.04) {
      index.current = (index.current + 1) % props.clips.length;
      player.setPlaybackRate(props.clips[index.current].speed || 1);
      void player.seekTo(props.clips[index.current].start);
    } else
      callbacks.current.onTime(
        outputTime(props.clips, index.current, state.currentTime),
      );
  }, [player, state.currentTime]);
  return null;
}
export function EditorSoundtrack({
  mediaId,
  uri,
  paused,
  time,
  volume,
  start = 0,
}: {
  mediaId?: string | null;
  uri?: string;
  paused: boolean;
  time: number;
  volume: number;
  start?: number;
}) {
  const { session } = useZiipa();
  const focused = useIsFocused();
  const { source } = usePlaybackSource(
    mediaId ? `/api/creator/media/${mediaId}` : null,
    session?.access_token,
    false,
    focused,
    uri,
  );
  return source ? (
    <SoundtrackAudio
      source={source}
      paused={paused}
      time={time}
      volume={volume}
      start={start}
    />
  ) : null;
}
function SoundtrackAudio({
  source,
  paused,
  time,
  volume,
  start,
}: {
  source: AudioSource;
  paused: boolean;
  time: number;
  volume: number;
  start: number;
}) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const state = useAudioPlayerStatus(player);
  const visible = useForeground();
  useEffect(() => {
    player.volume = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : 0;
    player.loop = false;
  }, [player, volume]);
  useEffect(() => {
    if (!state.isLoaded) return;
    const position = state.duration
      ? Math.min(time + start, state.duration)
      : time + start;
    if (Math.abs(state.currentTime - position) > 0.4)
      void player.seekTo(position);
  }, [player, state.isLoaded, time, start]);
  useEffect(() => {
    if (
      visible &&
      !paused &&
      state.isLoaded &&
      (!state.duration || time + start < state.duration)
    )
      player.play();
    else player.pause();
  }, [player, visible, paused, state.isLoaded, state.duration, time, start]);
  return null;
}
export function effectFilter(effect: VisualEffect) {
  return {
    none: "none",
    vivid: "saturate(1.35) contrast(1.08)",
    mono: "grayscale(1)",
    warm: "sepia(.3) saturate(1.15)",
    cool: "hue-rotate(12deg) saturate(.85)",
    fade: "contrast(.85) brightness(1.1)",
    cinema: "contrast(1.18) saturate(.8)",
  }[effect];
}
const p = StyleSheet.create({
  message: {
    position: "absolute",
    bottom: 25,
    left: 16,
    right: 16,
    color: "white",
    backgroundColor: "#120D20D9",
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
  },
});
