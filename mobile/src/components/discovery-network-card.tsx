import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { ExternalLink } from "lucide-react-native";
import {
  discoveryProviderName,
  discoveryThumbnailUrl,
} from "../lib/discovery-feed";
import type { NetworkMedia } from "../lib/network-hub";
import { color, font, styles } from "../theme";

/** A public still, never an invented Ziipa upload or a second autoplay player. */
export function DiscoveryNetworkPreview({ media }: { media: NetworkMedia }) {
  const url = discoveryThumbnailUrl(media);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: color.panel }]}
    >
      {url && failed !== url ? (
        <Image
          key={url}
          source={{ uri: url }}
          cachePolicy="memory"
          contentFit="contain"
          accessibilityLabel={`Public ${discoveryProviderName(media.provider)} post thumbnail`}
          style={StyleSheet.absoluteFill}
          onError={() => setFailed(url)}
        />
      ) : (
        <View
          style={{
            flex: 1,
            gap: 12,
            alignItems: "center",
            justifyContent: "center",
            padding: 26,
          }}
        >
          <ExternalLink size={36} color={color.muted} />
          <Text
            numberOfLines={5}
            style={[styles.body, { textAlign: "center" }]}
          >
            {media.text ||
              media.title ||
              `Open the original ${discoveryProviderName(media.provider)} post`}
          </Text>
        </View>
      )}
    </View>
  );
}

export function DiscoveryNetworkCard({
  media,
  onOpen,
  style,
}: {
  media: NetworkMedia;
  onOpen: (media: NetworkMedia) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${media.title || "public post"} by ${media.author || media.handle || "network account"} on ${discoveryProviderName(media.provider)}`}
      onPress={() => onOpen(media)}
      style={[
        {
          borderWidth: 1,
          borderColor: color.border,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: color.panel,
        },
        style,
      ]}
    >
      <View pointerEvents="none" style={{ height: 190 }}>
        <DiscoveryNetworkPreview media={media} />
      </View>
      <View pointerEvents="none" style={{ padding: 16, gap: 7 }}>
        <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
          <ExternalLink size={14} color={color.lime} />
          <Text style={[styles.small, { color: color.lime }]}>
            {discoveryProviderName(media.provider)} · {media.kind}
          </Text>
        </View>
        <Text
          numberOfLines={3}
          style={{ fontFamily: font.semibold, color: color.text, fontSize: 16 }}
        >
          {media.title || media.text || "Public post"}
        </Text>
        <Text numberOfLines={1} style={styles.small}>
          {media.author || media.handle || "Network account"}
        </Text>
        <Text style={[styles.small, { fontSize: 11 }]}>
          Imported public snapshot · Opens original
        </Text>
      </View>
    </Pressable>
  );
}
