import { useEffect, useMemo } from "react";
import { AppState, Text, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEvent } from "expo";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useIsFocused } from "@react-navigation/native";
import { Pause, Play } from "lucide-react-native";
import { playbackSource } from "../lib/assets";
import { visibleCaption } from "../lib/domain";
import type { Item } from "../lib/types";
import { useZiipa } from "../provider";
import { Action, Cover, Notice } from "./ui";
import { color, styles } from "../theme";

export function MediaPlayer({ item }: { item: Item }) {
  const { session } = useZiipa();
  const source = useMemo(
    () => playbackSource(item.media_url, session?.access_token),
    [item.media_url, session?.access_token],
  );
  if (!source)
    return (
      <View style={{ gap: 12 }}>
        <Cover item={item} style={{ height: 390, borderRadius: 24 }} />
        {item.demo && (
          <Text style={styles.small}>
            {item.label}. This card is a visual collection, not a playing video
            or live broadcast.
          </Text>
        )}
      </View>
    );
  return item.content_type?.startsWith("audio/") ? (
    <AudioPlayer source={source} item={item} />
  ) : (
    <VideoPlayer source={source} item={item} />
  );
}
type Props = {
  source: NonNullable<ReturnType<typeof playbackSource>>;
  item: Item;
};
function VideoPlayer({ source, item }: Props) {
  const focused = useIsFocused();
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.loop = false;
  });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const { status, error } = useEvent(player, "statusChange", {
    status: player.status,
    error: undefined,
  });
  useEffect(() => {
    if (!focused) player.pause();
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") player.pause();
    });
    return () => listener.remove();
  }, [focused, player]);
  useEffect(() => {
    if (status === "readyToPlay" && item.trim_start)
      player.currentTime = item.trim_start;
  }, [status, item.trim_start, player]);
  useEffect(() => {
    if (item.trim_end && currentTime >= item.trim_end) {
      player.pause();
      player.currentTime = item.trim_start || 0;
    } else if (player.playing && currentTime < (item.trim_start || 0))
      player.currentTime = item.trim_start || 0;
  }, [currentTime, item.trim_start, item.trim_end, player]);
  const caption = visibleCaption(item.captions, currentTime);
  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          height: 360,
          borderRadius: 23,
          overflow: "hidden",
          backgroundColor: "#000",
        }}
      >
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="contain"
          nativeControls
          fullscreenOptions={{ enable: !item.captions?.length }}
          allowsPictureInPicture={false}
        />
        {!!caption && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              bottom: 65,
              left: 22,
              right: 22,
              backgroundColor: "#000C",
              padding: 9,
              borderRadius: 7,
            }}
          >
            <Text
              style={[styles.body, { textAlign: "center", color: color.text }]}
            >
              {caption}
            </Text>
          </View>
        )}
      </View>
      {status === "error" && (
        <Notice
          error
          text={
            error?.message ||
            "This media could not play. Check your connection and supported file format."
          }
        />
      )}
      {!!item.captions?.length && (
        <Text style={styles.small}>
          Caption and trim preview · the original file is unchanged.
        </Text>
      )}
    </View>
  );
}
function AudioPlayer({ source, item }: Props) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) player.pause();
    const listener = AppState.addEventListener("change", (s) => {
      if (s !== "active") player.pause();
    });
    return () => listener.remove();
  }, [focused, player]);
  useEffect(() => {
    if (item.trim_end && status.currentTime >= item.trim_end) {
      player.pause();
      void player.seekTo(item.trim_start || 0);
    }
  }, [item.trim_end, item.trim_start, status.currentTime, player]);
  function toggle() {
    if (status.playing) player.pause();
    else {
      if (status.didJustFinish || status.currentTime < (item.trim_start || 0))
        void player.seekTo(item.trim_start || 0);
      player.play();
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <Cover item={item} style={{ height: 290, borderRadius: 22 }} />
      <Action
        title={status.playing ? "Pause audio" : "Play audio"}
        icon={status.playing ? Pause : Play}
        onPress={toggle}
        disabled={!status.isLoaded}
      />
      <Text style={styles.small}>
        {Math.floor(status.currentTime)}s / {Math.floor(status.duration)}s ·
        original audio
      </Text>
    </View>
  );
}
