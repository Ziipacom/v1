import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  boundedAudioPreviewSeek,
  knownAudioDuration,
  soundtrackPreviewPosition,
  validateSoundtrackStart,
} from "../lib/soundtrack-controls";
import { styles } from "../theme";
type Audition = { name: string; path?: string; uri?: string };

export function MusicAudition({
  audition,
  volume,
  start = 0,
  onDuration,
  onAuditionStart,
  onPauseReady,
}: {
  audition: Audition;
  volume: number;
  start?: number;
  onDuration?: (seconds: number | null) => void;
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
      key={audition.uri || audition.path}
      source={source}
      volume={volume}
      start={start}
      onDuration={onDuration}
      onAuditionStart={onAuditionStart}
      onPauseReady={onPauseReady}
    />
  );
}

function AuditionPlayer({
  source,
  volume,
  start,
  onDuration,
  onAuditionStart,
  onPauseReady,
}: {
  source: AudioSource;
  volume: number;
  start: number;
  onDuration?: (seconds: number | null) => void;
  onAuditionStart?: () => void;
  onPauseReady?: (pause: (() => void) | null) => void;
}) {
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const focused = useIsFocused();
  const [error, setError] = useState("");
  const [seeking, setSeeking] = useState(false);
  const duration = status.isLoaded ? knownAudioDuration(status.duration) : null;
  const scope = useRef({
    mounted: true,
    generation: 0,
    focused,
    foreground: !AppState.currentState || AppState.currentState === "active",
    source,
    start,
    loaded: status.isLoaded,
    duration,
    restart: true,
  });
  // Invalidate a pending seek during render, before passive navigation cleanup.
  if (
    scope.current.focused !== focused ||
    scope.current.source !== source ||
    scope.current.start !== start ||
    scope.current.loaded !== status.isLoaded ||
    scope.current.duration !== duration
  ) {
    scope.current.generation++;
    scope.current.restart = true;
    scope.current.focused = focused;
    scope.current.source = source;
    scope.current.start = start;
    scope.current.loaded = status.isLoaded;
    scope.current.duration = duration;
  }
  const pause = useCallback(() => {
    scope.current.generation++;
    player.pause();
    if (scope.current.mounted) setSeeking(false);
  }, [player]);
  let offsetError = "";
  try {
    validateSoundtrackStart(start, duration);
  } catch (cause) {
    offsetError = (cause as Error).message;
  }
  useEffect(() => {
    onDuration?.(duration);
  }, [duration, onDuration]);
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
      scope.current.generation++;
      player.pause();
    };
  }, [player]);
  useEffect(() => {
    onPauseReady?.(pause);
    return () => onPauseReady?.(null);
  }, [pause, onPauseReady]);
  useEffect(() => {
    player.volume = Math.max(0, Math.min(1, volume / 100));
  }, [player, volume]);
  useEffect(() => {
    pause();
    setError("");
    const subscription = AppState.addEventListener("change", (state) => {
      scope.current.foreground = state === "active";
      if (state !== "active") pause();
    });
    return () => subscription.remove();
  }, [pause, focused, source, start, status.isLoaded, duration]);
  return (
    <View style={{ gap: 8 }}>
      <Action
        secondary
        title={status.playing ? "Pause audio" : "Play audio preview"}
        icon={status.playing ? Pause : Play}
        busy={seeking}
        disabled={!status.isLoaded || !!offsetError || !focused}
        onPress={async () => {
          if (status.playing) pause();
          else {
            if (seeking || offsetError || !focused || !scope.current.foreground)
              return;
            onAuditionStart?.();
            const held = scope.current;
            const generation = ++held.generation;
            const current = () =>
              scope.current === held &&
              held.mounted &&
              held.generation === generation &&
              held.focused &&
              held.foreground &&
              held.loaded;
            setError("");
            setSeeking(true);
            try {
              const position = soundtrackPreviewPosition(
                start,
                status.currentTime,
                duration,
                status.didJustFinish || held.restart,
              );
              await boundedAudioPreviewSeek(player.seekTo(position));
              if (!current()) return;
              held.restart = false;
              player.play();
            } catch {
              if (current())
                setError("Audio preview could not seek. Try again.");
            } finally {
              if (current()) setSeeking(false);
            }
          }
        }}
      />
      <Text style={styles.small}>
        {Math.floor(status.currentTime)}s /{" "}
        {duration === null
          ? "duration unavailable"
          : `${Math.floor(duration)}s`}{" "}
        · explicit preview, no autoplay
      </Text>
      {!!(offsetError || error) && (
        <Text accessibilityRole="alert" style={styles.error}>
          {offsetError || error}
        </Text>
      )}
    </View>
  );
}
