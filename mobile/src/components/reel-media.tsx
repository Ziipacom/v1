import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { VideoView, useVideoPlayer, type VideoSource } from "expo-video";
import { useEvent } from "expo";
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioSource,
} from "expo-audio";
import { useIsFocused } from "@react-navigation/native";
import { Cover } from "./ui";
import { usePlaybackSource } from "../lib/media-playback";
import { visibleCaption } from "../lib/domain";
import { useZiipa } from "../provider";
import type { Item } from "../lib/types";
import { font } from "../theme";
import { EditorCanvasLayers } from "./editor-canvas-layers";
import { EditorPreview, EditorSoundtrack } from "./editor-preview";
import type { TimelineClip } from "../lib/types";

export function ReelMedia({
  item,
  active,
  paused,
  muted,
  localUri,
}: {
  item: Item;
  active: boolean;
  paused: boolean;
  muted: boolean;
  localUri?: string;
}) {
  const { session } = useZiipa();
  const focused = useIsFocused();
  const editedSequence =
    !!item.timeline?.clips?.length ||
    (!!item.visual_effect && item.visual_effect !== "none") ||
    !!item.soundtrack ||
    !!item.overlays?.length ||
    !!item.captions?.length;
  const { source, loading, error } = usePlaybackSource(
    item.media_url,
    session?.access_token,
    !!item.demo,
    active && focused && !editedSequence,
    localUri,
  );
  if (editedSequence && active)
    return (
      <EditedReel
        key={JSON.stringify([
          item.id,
          item.media_url,
          item.timeline,
          item.trim_start,
          item.trim_end,
          item.content_type,
        ])}
        item={item}
        paused={paused}
        muted={muted}
        localUri={localUri}
      />
    );
  return (
    <View style={StyleSheet.absoluteFill}>
      <Cover item={item} style={{ flex: 1 }} />
      {active && (loading || !!error) && (
        <Text style={r.caption}>{error || "Loading media…"}</Text>
      )}
      {active &&
        !!source &&
        (item.content_type?.startsWith("audio/") ? (
          <ReelAudio
            key={localUri || item.media_url}
            source={source}
            item={item}
            paused={paused}
            muted={muted}
          />
        ) : (
          <ReelVideo
            key={localUri || item.media_url}
            source={source}
            item={item}
            paused={paused}
            muted={muted}
          />
        ))}
      {!source && !!item.captions?.[0]?.text && (
        <Text style={r.caption}>{item.captions[0].text}</Text>
      )}
    </View>
  );
}
function EditedReel({
  item,
  paused,
  muted,
  localUri,
}: {
  item: Item;
  paused: boolean;
  muted: boolean;
  localUri?: string;
}) {
  const [time, setTime] = useState(0);
  const [area, setArea] = useState({ width: 320, height: 400 });
  const [aspect, setAspect] = useState(16 / 9);
  const width = Math.min(area.width, area.height * aspect),
    height = width / aspect;
  const frame = {
    x: (area.width - width) / 2,
    y: (area.height - height) / 2,
    width,
    height,
  };
  const [clips, setClips] = useState<TimelineClip[]>(
    item.timeline?.clips || [],
  );
  const [seek] = useState({ time: 0, nonce: 0 });
  const caption = visibleCaption(
    item.captions,
    item.timeline ? time : time + (item.trim_start || 0),
  );
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        // Native events may be released before a queued updater is evaluated.
        const { width, height } = event.nativeEvent.layout;
        setArea((previous) =>
          previous.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      }}
    >
      <EditorPreview
        item={item}
        paused={paused}
        muted={muted}
        localUri={localUri}
        clips={clips}
        seek={seek}
        onTime={setTime}
        onDuration={(duration) =>
          setClips((current) =>
            current.length
              ? current
              : [
                  {
                    id: "legacy",
                    start: item.trim_start || 0,
                    end: Math.min(item.trim_end || duration, duration),
                  },
                ],
          )
        }
        onFrames={() => {}}
        generateFrames={false}
        onDimensions={(w, h) => {
          if (w > 0 && h > 0) setAspect(w / h);
        }}
      />
      {item.soundtrack && (
        <EditorSoundtrack
          mediaId={item.soundtrack.media_id}
          uri={item.demo ? item.soundtrack.local_uri : undefined}
          start={item.soundtrack.start}
          paused={paused || muted}
          time={time}
          volume={item.soundtrack.volume}
        />
      )}
      <EditorCanvasLayers
        frame={frame}
        overlays={item.overlays || []}
        caption={caption}
      />
    </View>
  );
}
function ReelAudio({
  source,
  item,
  paused,
  muted,
}: {
  source: AudioSource;
  item: Item;
  paused: boolean;
  muted: boolean;
}) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const state = useAudioPlayerStatus(player);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const appliedStart = useRef<number | null>(null);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (s) =>
      setForeground(s === "active"),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    player.muted = muted;
    player.loop = true;
  }, [player, muted]);
  useEffect(() => {
    if (focused && foreground && !paused && state.isLoaded) player.play();
    else player.pause();
  }, [player, focused, foreground, paused, state.isLoaded]);
  useEffect(() => {
    const start = item.trim_start || 0;
    if (state.isLoaded && appliedStart.current !== start) {
      appliedStart.current = start;
      void player.seekTo(start);
    }
  }, [player, state.isLoaded, item.trim_start]);
  useEffect(() => {
    if (item.trim_end && state.currentTime >= item.trim_end)
      void player.seekTo(item.trim_start || 0);
  }, [player, state.currentTime, item.trim_end, item.trim_start]);
  const caption = visibleCaption(item.captions, state.currentTime);
  return caption ? <Text style={r.caption}>{caption}</Text> : null;
}
function ReelVideo({
  source,
  item,
  paused,
  muted,
}: {
  source: VideoSource;
  item: Item;
  paused: boolean;
  muted: boolean;
}) {
  const focused = useIsFocused();
  const appliedStart = useRef<number | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const player = useVideoPlayer(source, (p) => {
    p.muted = true;
    p.loop = true;
    p.timeUpdateEventInterval = 0.25;
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
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) =>
      setForeground(s === "active"),
    );
    return () => sub.remove();
  }, []);
  useEffect(() => {
    player.muted = muted;
  }, [player, muted]);
  useEffect(() => {
    if (focused && foreground && !paused && status === "readyToPlay")
      player.play();
    else player.pause();
  }, [player, focused, foreground, paused, status]);
  useEffect(() => {
    const start = item.trim_start || 0;
    // Seeking causes another buffering/ready cycle. Apply each requested start
    // once so the player is not repeatedly reset before its first frame.
    if (status === "readyToPlay" && appliedStart.current !== start) {
      appliedStart.current = start;
      player.currentTime = start;
    }
  }, [player, status, item.trim_start]);
  useEffect(() => {
    if (item.trim_end && currentTime >= item.trim_end)
      player.currentTime = item.trim_start || 0;
  }, [player, currentTime, item.trim_end, item.trim_start]);
  const caption = visibleCaption(item.captions, currentTime);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <VideoView
        player={player}
        // Web renders a replaced <video> element; inset alone preserves its
        // intrinsic size instead of filling the portrait feed viewport.
        style={[StyleSheet.absoluteFill, { width: "100%", height: "100%" }]}
        contentFit="cover"
        nativeControls={false}
        playsInline
        allowsPictureInPicture={false}
        surfaceType="textureView"
      />
      {!!caption && <Text style={r.caption}>{caption}</Text>}
      {status === "error" && (
        <Text style={r.caption}>
          Video unavailable. Swipe to keep exploring.
        </Text>
      )}
      <View
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 2,
          backgroundColor: "#FFFFFF30",
        }}
      >
        <View
          style={{
            height: 2,
            width: `${Math.min(100, player.duration ? (currentTime / player.duration) * 100 : 0)}%`,
            backgroundColor: "#AE76FF",
          }}
        />
      </View>
    </View>
  );
}
const r = StyleSheet.create({
  caption: {
    position: "absolute",
    bottom: "32%",
    alignSelf: "center",
    maxWidth: "75%",
    color: "white",
    textAlign: "center",
    fontSize: 17,
    fontFamily: font.medium,
    backgroundColor: "#0009",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
});
