import { Text, View } from "react-native";
import { VideoView, useVideoPlayer, type VideoSource } from "expo-video";
import { useZiipa } from "../provider";
import { usePlaybackSource } from "../lib/media-playback";
import { MusicAudition } from "./audio-audition";
import { styles } from "../theme";

function Video({ source }: { source: VideoSource }) {
  const player = useVideoPlayer(source);
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: "100%", aspectRatio: 16 / 9 }}
    />
  );
}
export function StoreMediaPreview({
  path,
  contentType,
}: {
  path: string;
  contentType: string;
}) {
  return contentType.startsWith("audio/") ? (
    <MusicAudition audition={{ name: "Product preview", path }} volume={1} />
  ) : (
    <ProductVideo path={path} />
  );
}
function ProductVideo({ path }: { path: string }) {
  const { session } = useZiipa();
  const { source, loading, error } = usePlaybackSource(
    path,
    session?.access_token,
  );
  return (
    <View>
      {source ? (
        <Video source={source} />
      ) : (
        <Text style={styles.small}>
          {error || (loading ? "Loading preview…" : "Preview unavailable.")}
        </Text>
      )}
    </View>
  );
}
