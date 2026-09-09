import { useEffect } from "react";
import { Text, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEvent } from "expo";
import { styles } from "../theme";

/** Public HLS only: never attach a Ziipa session header to provider playback. */
export function LiveViewer({ url }: { url: string }) {
  const player = useVideoPlayer({ uri: url, contentType: "hls" }, (value) => {
    value.muted = true;
  });
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  useEffect(() => {
    if (status === "readyToPlay") player.play();
  }, [player, status]);
  return (
    <View style={{ gap: 10 }}>
      <VideoView
        player={player}
        nativeControls
        playsInline
        allowsPictureInPicture={false}
        contentFit="contain"
        style={{
          width: "100%",
          aspectRatio: 9 / 12,
          borderRadius: 18,
          backgroundColor: "black",
        }}
      />
      {status === "error" && (
        <Text style={styles.error}>
          Live playback is unavailable. Refresh the stream status or choose
          another broadcast.
        </Text>
      )}
    </View>
  );
}
