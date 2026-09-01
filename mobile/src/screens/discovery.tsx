import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
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
import { LinearGradient } from "expo-linear-gradient";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ChevronLeft,
  ChevronRight,
  LockKeyholeOpen,
  Menu,
  Play,
  Search,
  SlidersHorizontal,
} from "lucide-react-native";
import {
  CategoryDock,
  FloatButton,
  floating,
  worlds,
} from "../components/floating";
import { Cover, Logo } from "../components/ui";
import { inCreativeWorld, searchItems } from "../lib/domain";
import type { Category, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function DiscoverScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Main">) {
  const { data, guest } = useZiipa();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<Category>(
    route.params?.category || "music",
  );
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (route.params?.category) {
      setCategory(route.params.category);
      setIndex(0);
    }
  }, [route.params?.category]);
  const items = searchItems(data.items, query).filter((i) =>
    inCreativeWorld(i, category),
  );
  const current = Math.min(index, Math.max(0, items.length - 1));
  function select(id: Category) {
    setCategory(id);
    setIndex(0);
  }
  function move(direction: number) {
    if (!items.length) return;
    setIndex((current + direction + items.length) % items.length);
    fade.setValue(0.55);
    Animated.timing(fade, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderRelease: (_, g) => {
          if (Math.abs(g.dx) > 35) move(g.dx < 0 ? 1 : -1);
        },
      }),
    [current, items.length],
  );
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
          onPress={() => navigation.navigate("Studio")}
        />
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
            setIndex(0);
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
          <>
            <Animated.View
              {...swipe.panHandlers}
              style={{
                flex: 1,
                opacity: fade,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              {items.length > 1 &&
                [-1, 1].map((offset) => (
                  <View
                    key={offset}
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      width: width * 0.64,
                      height: "81%",
                      left: offset < 0 ? -width * 0.07 : width * 0.43,
                      borderRadius: 25,
                      overflow: "hidden",
                      opacity: 0.55,
                      transform: [{ scale: 0.95 }],
                    }}
                  >
                    <Cover
                      item={
                        items[(current + offset + items.length) % items.length]
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Watch ${items[current].title}`}
                onPress={() =>
                  navigation.navigate("Watch", {
                    itemId: items[current].id,
                    category,
                  })
                }
                style={{
                  width: "69%",
                  height: "100%",
                  minHeight: 245,
                  borderRadius: 26,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor: "#765898",
                  boxShadow: "0 18px 28px #0005",
                }}
              >
                <Cover
                  item={items[current]}
                  style={{ position: "absolute", inset: 0 }}
                />
                <LinearGradient
                  colors={
                    category === "music"
                      ? ["#5300AF55", "#30005F00", "#160A29ED"]
                      : ["#0001", "#0000", "#110D1CED"]
                  }
                  style={{
                    flex: 1,
                    padding: 21,
                    justifyContent: "space-between",
                  }}
                >
                  <Text
                    style={{
                      color: "#F1E9FF",
                      fontFamily: font.medium,
                      fontSize: 11,
                      letterSpacing: 2,
                    }}
                  >
                    {activeWorld?.title.toUpperCase()}
                  </Text>
                  <View style={{ gap: 12 }}>
                    <Text
                      style={{
                        fontFamily: font.semibold,
                        fontSize: 32,
                        lineHeight: 34,
                        color: "white",
                      }}
                    >
                      {items[current].title}
                    </Text>
                    <Text
                      style={{
                        color: "#D9CDEB",
                        fontSize: 12,
                        fontFamily: font.regular,
                      }}
                    >
                      {items[current].creator}
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <View
                        style={{
                          borderRadius: 20,
                          padding: 10,
                          backgroundColor: "#FFF",
                        }}
                      >
                        <Play
                          size={14}
                          fill={color.purple}
                          color={color.purple}
                        />
                      </View>
                      <Text
                        style={{
                          color: "white",
                          fontSize: 12,
                          fontFamily: font.medium,
                        }}
                      >
                        {items[current].media_url
                          ? "Watch film"
                          : "Explore collection"}
                      </Text>
                    </View>
                  </View>
                </LinearGradient>
              </Pressable>
              {items.length > 1 && (
                <>
                  <View style={{ position: "absolute", left: 2 }}>
                    <FloatButton
                      label="Previous creation"
                      icon={ChevronLeft}
                      plain
                      onPress={() => move(-1)}
                    />
                  </View>
                  <View style={{ position: "absolute", right: 2 }}>
                    <FloatButton
                      label="Next creation"
                      icon={ChevronRight}
                      plain
                      onPress={() => move(1)}
                    />
                  </View>
                </>
              )}
            </Animated.View>
            <View
              style={{
                flexDirection: "row",
                gap: 17,
                paddingHorizontal: 30,
                paddingTop: 23,
                height: 44,
              }}
            >
              {items.map((item, i) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Show creation ${i + 1}`}
                  accessibilityState={{ selected: i === current }}
                  onPress={() => setIndex(i)}
                  style={{ flex: 1, minHeight: 22, justifyContent: "center" }}
                >
                  <View
                    style={{
                      height: 4,
                      borderRadius: 3,
                      backgroundColor: current === i ? color.purple : "#ACA7AE",
                    }}
                  />
                </Pressable>
              ))}
            </View>
          </>
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
