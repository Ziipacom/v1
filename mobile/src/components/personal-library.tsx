import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ImageIcon,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";
import { Action, Notice } from "./ui";
import { networkInfo, type NetworkHub } from "../lib/network-hub";
import {
  discoveryConnectionIdentity,
  discoveryPostUrl,
  discoveryThumbnailUrl,
  importedDiscoveryMedia,
} from "../lib/discovery-feed";
import { useNetworkSnapshotExpiry } from "../lib/use-network-snapshot-expiry";
import { sectionHelp } from "../lib/field-help";
import { InfoTip } from "./info-tip";

export function LibrarySection({
  title,
  count,
  initiallyOpen = true,
  children,
}: {
  title: string;
  count?: number;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color.border,
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: color.panel,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingRight: sectionHelp[title] ? 10 : 0,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          onPress={() => setExpanded((value) => !value)}
          style={{
            minHeight: 58,
            padding: 16,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            flex: 1,
          }}
        >
          {expanded ? (
            <ChevronDown size={20} color={color.muted} />
          ) : (
            <ChevronRight size={20} color={color.muted} />
          )}
          <Text
            style={{
              fontFamily: font.semibold,
              fontSize: 18,
              color: color.text,
              flex: 1,
            }}
          >
            {title}
          </Text>
          {count !== undefined ? (
            <Text
              style={{
                ...styles.small,
                backgroundColor: color.raised,
                paddingHorizontal: 9,
                paddingVertical: 3,
                borderRadius: 8,
              }}
            >
              {count}
            </Text>
          ) : null}
        </Pressable>
        {sectionHelp[title] ? (
          <InfoTip title={title} content={sectionHelp[title]} />
        ) : null}
      </View>
      {expanded ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 14 }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

/** Two compact columns on phones; add columns as the actual container grows. */
export function LibraryGrid({ children }: { children: ReactNode[] }) {
  const [width, setWidth] = useState(0);
  const columns = width >= 960 ? 4 : width >= 660 ? 3 : width >= 280 ? 2 : 1;
  const cardWidth = width
    ? Math.floor((width - (columns - 1) * 12) / columns)
    : undefined;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, minWidth: 0 }}
    >
      {children.map((child, index) => (
        <View
          key={(child as { key?: string })?.key || index}
          style={{ width: cardWidth ?? "100%", minWidth: 0 }}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

/** Reads the existing account snapshot. Opening the library never initiates a sync. */
export function NetworkLibrary({
  query,
  manage,
}: {
  query: string;
  manage: () => void;
}) {
  const { api, data } = useZiipa();
  const focused = useIsFocused();
  const [hub, setHub] = useState<NetworkHub | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(24);
  const identity = discoveryConnectionIdentity(data.connections || []);
  useNetworkSnapshotExpiry(hub);
  useEffect(() => setVisible(24), [query]);
  useEffect(() => {
    if (!focused) return;
    let current = true;
    setHub(null);
    setLoading(true);
    setError("");
    void api<NetworkHub>("/api/social/hub")
      .then((value) => {
        if (current) setHub(value);
      })
      .catch(() => {
        if (current)
          setError(
            "Network media could not load. Try again or open Your networks.",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, focused, identity, attempt]);
  const media = importedDiscoveryMedia(focused ? hub : null).filter((item) =>
    [
      item.title,
      item.text,
      item.author,
      item.handle,
      networkInfo[item.provider].name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const providers = Object.keys(networkInfo) as (keyof typeof networkInfo)[];
  return (
    <LibrarySection
      title="By Network Syncs"
      count={loading || error ? undefined : media.length}
      initiallyOpen={false}
    >
      {loading ? (
        <ActivityIndicator
          accessibilityLabel="Loading synced media"
          color={color.purple}
        />
      ) : null}
      {error ? (
        <>
          <Notice error text={error} />
          <Action
            secondary
            title="Retry"
            onPress={() => setAttempt((value) => value + 1)}
          />
        </>
      ) : null}
      {!loading && !error && !media.length ? (
        <Text style={styles.small}>
          {query
            ? "No synced media matches this search."
            : "No synced posts yet. Connect a network and sync its available posts in Your networks."}
        </Text>
      ) : null}
      {providers.map((provider) => {
        const items = media.filter((item) => item.provider === provider);
        if (!items.length) return null;
        return (
          <LibrarySection
            key={provider}
            title={networkInfo[provider].name}
            count={items.length}
          >
            <LibraryGrid>
              {items.slice(0, visible).map((item) => {
                const thumbnail = discoveryThumbnailUrl(item);
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${item.title || "post"} on ${networkInfo[provider].name}`}
                    onPress={() => {
                      const url = discoveryPostUrl(item);
                      if (url)
                        void Linking.openURL(url).catch(() =>
                          setError(
                            "This post could not open. Try again from Your networks.",
                          ),
                        );
                    }}
                    style={{
                      borderRadius: 12,
                      overflow: "hidden",
                      borderWidth: 1,
                      borderColor: color.border,
                      backgroundColor: color.bg,
                    }}
                  >
                    <View
                      style={{
                        aspectRatio: 1,
                        backgroundColor: color.raised,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {thumbnail ? (
                        <Image
                          source={{ uri: thumbnail }}
                          style={{ width: "100%", height: "100%" }}
                          contentFit="cover"
                          cachePolicy="none"
                          accessibilityLabel={
                            item.title || "Network media preview"
                          }
                        />
                      ) : (
                        <ImageIcon size={28} color={color.muted} />
                      )}
                      <View
                        style={{
                          position: "absolute",
                          right: 8,
                          bottom: 8,
                          borderRadius: 16,
                          padding: 6,
                          backgroundColor: color.panel,
                        }}
                      >
                        <ExternalLink size={16} color={color.text} />
                      </View>
                    </View>
                    <View style={{ padding: 10, gap: 4 }}>
                      <Text
                        numberOfLines={2}
                        style={{
                          fontFamily: font.semibold,
                          fontSize: 15,
                          color: color.text,
                        }}
                      >
                        {item.title || item.text || "Network post"}
                      </Text>
                      <Text numberOfLines={1} style={styles.small}>
                        {item.author || item.handle} · Opens original
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </LibraryGrid>
            {items.length > visible ? (
              <Action
                secondary
                title={`Show more from ${networkInfo[provider].name}`}
                onPress={() => setVisible((value) => value + 24)}
              />
            ) : null}
          </LibrarySection>
        );
      })}
      <Action secondary title="Your networks" onPress={manage} />
    </LibrarySection>
  );
}
