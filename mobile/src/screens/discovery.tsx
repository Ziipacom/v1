import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  LockKeyholeOpen,
  Menu,
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
import { useDesktopLayout } from "../components/desktop-layout";
import { DesktopExplore } from "./desktop-explore";
import { galleryItems } from "../lib/gallery";
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
  const { data, guest } = useZiipa();
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<Category>(
    route.params?.category || "music",
  );
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (route.params?.category) {
      setCategory(route.params.category);
    }
  }, [route.params?.category]);
  const items = galleryItems(data.items, category, query);
  function select(id: Category) {
    setCategory(id);
  }
  const activeWorld = worlds.find((w) => w.id === category);
  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { overflow: "hidden" }]}
    >
      <View style={[floating.header, { height: 87 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 0 }}>
          <FloatButton
            label="Open settings"
            icon={Settings}
            plain
            size={40}
            onPress={() => navigation.navigate("Settings")}
          />
          <FloatButton
            label="Open Studio"
            icon={Menu}
            plain
            onPress={() => navigation.navigate("Studio")}
          />
        </View>
        <Logo width={145} />
        <FloatButton
          label="Your creator profile"
          icon={LockKeyholeOpen}
          onPress={() => navigation.navigate("Profile")}
        />
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
            key={`${category}:${query}`}
            items={items}
            label={activeWorld?.title || "Gallery"}
            onOpen={(item) =>
              navigation.navigate("Watch", { itemId: item.id, category })
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
            accessibilityLabel="Build a custom feed"
            onPress={() => navigation.navigate("Feeds")}
            style={{ padding: 9 }}
          >
            <SlidersHorizontal size={16} color={color.muted} />
          </Pressable>
        </View>
      </View>
      <CategoryDock
        selected={category}
        onSelect={select}
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
    </SafeAreaView>
  );
}
