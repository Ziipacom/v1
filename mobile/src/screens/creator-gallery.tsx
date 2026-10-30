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
  ArrowLeft,
  Menu,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react-native";
import {
  CategoryDock,
  FloatButton,
  Sheet,
  floating,
  worlds,
} from "../components/floating";
import { useDesktopLayout } from "../components/desktop-layout";
import { GallerySlider } from "../components/gallery-slider";
import { AccountMenu } from "../components/account-menu";
import { Action, Logo, Notice, Pill } from "../components/ui";
import { useProfileCollections } from "../lib/use-profile-collections";
import { galleryItems } from "../lib/gallery";
import type { Category, RootStack } from "../lib/types";
import { color, font, styles } from "../theme";

/** Loads this creator's authorised collection, never another account's cache. */
export function CreatorGalleryScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "CreatorGallery">) {
  const result = useProfileCollections(route.params?.creatorId);
  const insets = useSafeAreaInsets();
  const { desktop } = useDesktopLayout();
  const { width } = useWindowDimensions();
  const logoWidth = Math.max(96, Math.min(145, width - 188));
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  useEffect(() => {
    setCategory("all");
    setQuery("");
    setFiltersOpen(false);
    setResetVersion(0);
  }, [route.params?.creatorId]);
  const profile = result.value;
  const items = galleryItems(
    profile?.access === "allowed" ? profile.items : [],
    category,
    query,
  );
  const label =
    worlds.find((world) => world.id === category)?.title || "All creations";
  function reset() {
    setCategory("all");
    setQuery("");
    setResetVersion((value) => value + 1);
  }
  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { overflow: "hidden" }]}
    >
      {!desktop && (
        <View style={[floating.header, { height: 87 }]}>
          <FloatButton
            icon={Menu}
            label="Open Studio"
            plain
            size={44}
            onPress={() => navigation.navigate("Studio")}
          />
          <Logo width={logoWidth} />
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <FloatButton
              icon={Settings}
              label="Open settings"
              plain
              size={44}
              onPress={() => navigation.navigate("Settings")}
            />
            <AccountMenu navigation={navigation} />
          </View>
        </View>
      )}
      <View
        style={{
          marginHorizontal: 24,
          marginTop: desktop ? 16 : 0,
          flexDirection: "row",
          alignItems: "center",
          borderRadius: 14,
          backgroundColor: color.panel,
          paddingHorizontal: 14,
          height: 47,
        }}
      >
        <TextInput
          accessibilityLabel={`Search ${profile?.creator.name || "creator"} Gallery`}
          placeholder="Search"
          placeholderTextColor="#928B9E"
          value={query}
          onChangeText={setQuery}
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
        style={{
          flex: 1,
          minHeight: 0,
          marginTop: 18,
          marginBottom: desktop ? 96 : 112 + insets.bottom,
        }}
      >
        <View style={{ flex: 1, minHeight: 0 }}>
          {result.loading && <Notice text="Loading creator Gallery…" />}
          {result.error && (
            <View style={{ padding: 20, gap: 12 }}>
              <Notice text={result.error} />
              <Action title="Retry" onPress={result.reload} />
            </View>
          )}
          {profile?.access === "followers_only" && (
            <Notice text="This Gallery is followers-only. Return to the profile to request access." />
          )}
          {items.length > 0 ? (
            <View
              style={{
                flex: 1,
                width: "100%",
                maxWidth: 1000,
                alignSelf: "center",
              }}
            >
              <GallerySlider
                key={`${route.params?.creatorId}:${category}:${query}:${resetVersion}`}
                items={items}
                label={label}
                onOpen={(item) =>
                  navigation.navigate("Watch", {
                    itemId: item.id,
                    category: item.category,
                  })
                }
              />
            </View>
          ) : profile?.access === "allowed" ? (
            <Notice
              text={
                query.trim()
                  ? "No creations match this search in this Gallery. Try another search or reset to all creations."
                  : category === "all"
                    ? "No published creations in this Gallery yet."
                    : `No ${label.toLowerCase()} creations in this Gallery yet. Reset to see all creations.`
              }
            />
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            gap: 14,
            alignItems: "center",
            minHeight: 44,
          }}
        >
          <Text
            style={{
              color: color.faint,
              fontSize: 10,
              fontFamily: font.regular,
            }}
          >
            YOUR CREATIVE WORLD
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset creator Gallery to all creations and clear search"
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
            accessibilityLabel="Filter this creator Gallery"
            accessibilityState={{ expanded: filtersOpen }}
            onPress={() => setFiltersOpen(true)}
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <SlidersHorizontal size={16} color={color.muted} />
          </Pressable>
        </View>
      </View>
      <CategoryDock
        selected={category}
        onSelect={(id) => {
          if (id === "store") {
            navigation.navigate("Store", {
              sellerId: profile?.creator.id || route.params?.creatorId,
            });
          } else {
            setCategory(id);
          }
        }}
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
      {filtersOpen && (
        <Sheet title="Gallery filters" onClose={() => setFiltersOpen(false)}>
          <Text style={styles.small}>
            {profile?.creator.name || "Creator"}’s portfolio
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pill
              title="All creations"
              active={category === "all"}
              onPress={() => {
                setCategory("all");
                setFiltersOpen(false);
              }}
            />
            {worlds
              .filter((world) => world.id !== "store")
              .map((world) => (
                <Pill
                  key={world.id}
                  title={world.title}
                  active={category === world.id}
                  onPress={() => {
                    setCategory(world.id);
                    setFiltersOpen(false);
                  }}
                />
              ))}
          </View>
          <Action
            title="Reset filters and search"
            secondary
            onPress={() => {
              reset();
              setFiltersOpen(false);
            }}
          />
          <Action
            title="View creator Profile"
            icon={ArrowLeft}
            secondary
            onPress={() => {
              setFiltersOpen(false);
              navigation.navigate("Profile", route.params);
            }}
          />
        </Sheet>
      )}
    </SafeAreaView>
  );
}
