import { useEffect } from "react";
import { AppState, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioSource,
} from "expo-audio";
import { Pause, Play } from "lucide-react-native";
import { Action } from "./ui";
import { useZiipa } from "../provider";
import { usePlaybackSource } from "../lib/media-playback";
import { styles } from "../theme";
type Audition = { name: string; path?: string; uri?: string };

export function MusicAudition({
  audition,
  volume,
  onAuditionStart,
  onPauseReady,
}: {
  audition: Audition;
  volume: number;
  onAuditionStart?: () => void;
  onPauseReady?: (pause: (() => void) | null) => void;
}) {
  const { session } = useZiipa();
  const focused = useIsFocused();
  const { source, loading, error } = usePlaybackSource(
    audition.path || null,
    session?.access_token,
    false,
    focused,
    audition.uri,
  );
  if (!source)
    return (
      <Text style={error ? styles.error : styles.small}>
        {error ||
          (loading
            ? "Loading private audio…"
            : "Audio preview is unavailable. Choose or upload the audio again.")}
      </Text>
    );
  return (
    <AuditionPlayer
      source={source}
      volume={volume}
      onAuditionStart={onAuditionStart}
      onPauseReady={onPauseReady}
    />
  );
}

function AuditionPlayer({
  source,
  volume,
  onAuditionStart,
  onPauseReady,
}: {
  source: AudioSource;
  volume: number;
  onAuditionStart?: () => void;
  onPauseReady?: (pause: (() => void) | null) => void;
}) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const focused = useIsFocused();
  useEffect(() => {
    onPauseReady?.(() => player.pause());
    return () => onPauseReady?.(null);
  }, [player, onPauseReady]);
  useEffect(() => {
    player.volume = Math.max(0, Math.min(1, volume / 100));
  }, [player, volume]);
  useEffect(() => {
    if (!focused) player.pause();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") player.pause();
    });
    return () => subscription.remove();
  }, [player, focused]);
  return (
    <View style={{ gap: 8 }}>
      <Action
        secondary
        title={status.playing ? "Pause audio" : "Play audio preview"}
        icon={status.playing ? Pause : Play}
        disabled={!status.isLoaded}
        onPress={() => {
          if (status.playing) player.pause();
          else {
            onAuditionStart?.();
            if (status.didJustFinish) void player.seekTo(0);
            player.play();
          }
        }}
      />
      <Text style={styles.small}>
        {Math.floor(status.currentTime)}s / {Math.floor(status.duration)}s ·
        explicit preview, no autoplay
      </Text>
    </View>
  );
}
