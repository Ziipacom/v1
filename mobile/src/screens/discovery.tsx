import { useEffect, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Menu,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react-native";
import {
  CategoryDock,
  FloatButton,
  floating,
  worlds,
} from "../components/floating";
import { Logo } from "../components/ui";
import { GallerySlider } from "../components/gallery-slider";
import { AccountMenu } from "../components/account-menu";
import { useDesktopLayout } from "../components/desktop-layout";
import { DesktopExplore } from "./desktop-explore";
import { galleryItems } from "../lib/gallery";
import { useDiscoveryFeed } from "../lib/use-discovery-feed";
import type { Category, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function DiscoverScreen(
  props: NativeStackScreenProps<RootStack, "Main">,
) {
  const { desktop } = useDesktopLayout();
  return desktop ? (
    <DesktopExplore {...props} />
  ) : (
    <MobileDiscoverScreen {...props} />
  );
}

function MobileDiscoverScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Main">) {
  const { guest } = useZiipa();
  const discovery = useDiscoveryFeed();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const logoWidth = Math.max(96, Math.min(145, width - 188));
  const category = route.params?.category || "all";
  const [query, setQuery] = useState(route.params?.query || "");
  const [resetVersion, setResetVersion] = useState(0);
  useEffect(() => setQuery(route.params?.query || ""), [route.params?.query]);
  const items = galleryItems(
    discovery.entries.flatMap((entry) =>
      entry.source === "ziipa" ? [entry.item] : [],
    ),
    category,
    query,
  );
  function select(id: Category) {
    navigation.setParams({ category: id });
  }
  function reset() {
    setQuery("");
    navigation.setParams({
      category: undefined,
      query: undefined,
      collection: undefined,
    });
    setResetVersion((version) => version + 1);
  }
  const activeWorld = worlds.find((w) => w.id === category);
  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { overflow: "hidden" }]}
    >
      <View style={[floating.header, { height: 87 }]}>
        <FloatButton
          label="Open Studio"
          icon={Menu}
          plain
          size={44}
          onPress={() => navigation.navigate("Studio")}
        />
        <Logo width={logoWidth} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 0 }}>
          <FloatButton
            label="Open settings"
            icon={Settings}
            plain
            size={44}
            onPress={() => navigation.navigate("Settings")}
          />
          <AccountMenu navigation={navigation} />
        </View>
      </View>
      <View
        style={{
          marginHorizontal: 24,
          flexDirection: "row",
          alignItems: "center",
          borderRadius: 14,
          backgroundColor: color.panel,
          paddingHorizontal: 14,
          height: 47,
        }}
      >
        <TextInput
          accessibilityLabel="Search creations"
          placeholder="Search"
          placeholderTextColor="#928B9E"
          value={query}
          onChangeText={(value) => {
            setQuery(value);
          }}
          style={{
            flex: 1,
            fontFamily: font.regular,
            color: color.text,
            fontSize: 19,
            height: 47,
          }}
        />
        <Search color="#A69CAF" size={24} strokeWidth={1.3} />
      </View>
      <View
        style={{ flex: 1, marginTop: 18, marginBottom: 112 + insets.bottom }}
      >
        {items.length ? (
          <GallerySlider
            key={`${category}:${query}:${resetVersion}`}
            items={items}
            label={activeWorld?.title || "All creations"}
            startMuted={resetVersion > 0 ? true : undefined}
            onOpen={(item) =>
              navigation.navigate("Watch", {
                itemId: item.id,
                category: item.category,
              })
            }
          />
        ) : (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              padding: 25,
              gap: 12,
            }}
          >
            <Search color={color.muted} size={32} />
            <Text style={styles.heading}>Nothing here yet</Text>
            <Text style={[styles.small, { textAlign: "center" }]}>
              Try another search or creative world.
            </Text>
          </View>
        )}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            gap: 14,
            alignItems: "center",
            minHeight: 32,
          }}
        >
          <Text
            style={{
              color: color.faint,
              fontSize: 10,
              fontFamily: font.regular,
            }}
          >
            {guest ? "SAMPLE STUDIO" : "YOUR CREATIVE WORLD"}
            {activeWorld?.concept ? " · CONCEPT" : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset gallery to all creations and clear search"
            accessibilityHint="Returns to the first creation. Your saved settings are unchanged."
            onPress={reset}
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <RefreshCw size={16} color={color.muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Build a custom feed"
            onPress={() => navigation.navigate("Feeds")}
            style={{ padding: 9 }}
          >
            <SlidersHorizontal size={16} color={color.muted} />
          </Pressable>
        </View>
        {discovery.networkCount > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Browse imported public posts in Discover"
            onPress={() => navigation.navigate("Studio")}
            style={{
              alignSelf: "center",
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text style={[styles.small, { fontSize: 11 }]}>
              Ziipa + {discovery.networkCount} Bluesky public posts in Discover
            </Text>
          </Pressable>
        )}
      </View>
      <CategoryDock
        selected={category}
        onSelect={select}
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
    </SafeAreaView>
  );
}
