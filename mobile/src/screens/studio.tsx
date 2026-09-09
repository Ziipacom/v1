import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ChevronDown,
  LayoutGrid,
  Megaphone,
  Menu,
  Network,
  Pencil,
  Plus,
  SquarePlus,
  Wallet,
} from "lucide-react-native";
import {
  FloatButton,
  WorldGlyph,
  floating,
  worlds,
} from "../components/floating";
import { Cover, Logo } from "../components/ui";
import { StudioFeed } from "../components/studio-feed";
import { color, font, styles } from "../theme";
import { useZiipa } from "../provider";
import { inCreativeWorld, studioDiscoverItems } from "../lib/domain";
import type { Category, RootStack } from "../lib/types";

const menuOrder: Category[] = ["nft", "games", "live", "music", "store"];
export function StudioScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Studio">) {
  const { data, guest } = useZiipa();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Category>(
    route.params?.category || "nft",
  );
  const [editing, setEditing] = useState(route.params?.edit || false);
  const [page, setPage] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (route.params?.category) setSelected(route.params.category);
    if (route.params?.edit !== undefined) setEditing(route.params.edit);
  }, [route.params]);
  useEffect(() => {
    if (editing) {
      slide.setValue(40);
      Animated.timing(slide, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [editing, slide]);
  const items = data.drafts.filter(
    (i) => inCreativeWorld(i, selected) && i.visibility !== "hidden",
  );
  const world = worlds.find((w) => w.id === selected);
  const discoverItems = useMemo(
    () => studioDiscoverItems(data.items),
    [data.items],
  );
  const dockHeight = 76 + Math.max(insets.bottom, 10);
  const edit = () => setEditing((value) => !value);
  const add = () => navigation.navigate("Composer", { category: selected });
  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <View
        style={[
          floating.header,
          { borderBottomWidth: 1, borderBottomColor: "#29232F" },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to discovery"
          onPress={() => navigation.navigate("Main")}
        >
          <Logo width={96} />
        </Pressable>
        <FloatButton
          label="Close Studio menu"
          icon={Menu}
          plain
          onPress={() => navigation.navigate("Profile")}
        />
      </View>
      <View style={{ flex: 1, marginBottom: dockHeight, overflow: "hidden" }}>
        <StudioFeed
          items={discoverItems}
          editing={editing}
          onOpen={(item) =>
            navigation.navigate("Watch", {
              itemId: item.id,
              category: item.category,
            })
          }
        />
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            alignItems: "flex-end",
            gap: 12,
            paddingTop: 17,
            paddingRight: 20,
            paddingBottom: 22,
          }}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 172,
            maxWidth: "52%",
            bottom: editing ? 240 : 178,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new creation"
            onPress={add}
            style={s.menuRow}
          >
            <Text style={s.menuText}>Create</Text>
            <View style={s.circleSlot}>
              <SquarePlus size={25} color={color.text} strokeWidth={1.5} />
            </View>
          </Pressable>
          {menuOrder
            .map((id) => worlds.find((w) => w.id === id))
            .filter((w) => !!w)
            .map((w) => (
              <Pressable
                key={w.id}
                accessibilityRole="button"
                accessibilityLabel={
                  w.id === "live" ? "Open live broadcasts" : `Edit ${w.title}`
                }
                accessibilityState={{ selected: editing && selected === w.id }}
                onPress={() => {
                  if (w.id === "live") {
                    navigation.navigate("Live");
                    return;
                  }
                  setSelected(w.id);
                  setPage(0);
                  setEditing(true);
                }}
                style={s.menuRow}
              >
                <Text style={s.menuText}>{w.title}</Text>
                <View
                  style={[
                    s.circleSlot,
                    s.circle,
                    editing &&
                      selected === w.id && {
                        borderColor: "#B28CDD",
                        backgroundColor: "#32145A",
                      },
                  ]}
                >
                  <WorldGlyph id={w.id} size={25} />
                </View>
              </Pressable>
            ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open connected networks"
            onPress={() => navigation.navigate("Connections")}
            style={s.menuRow}
          >
            <Text style={s.menuText}>Networks</Text>
            <View style={[s.circleSlot, s.circle]}>
              <Network size={25} color={color.text} strokeWidth={1.5} />
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Studio"
            onPress={() => navigation.navigate("Profile")}
            style={s.menuRow}
          >
            <Text style={s.menuText}>Close</Text>
            <View style={s.circleSlot}>
              <ChevronDown size={29} color={color.text} strokeWidth={1.5} />
            </View>
          </Pressable>
        </ScrollView>
      </View>
      {editing && (
        <Animated.View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: dockHeight - 2,
            transform: [{ translateY: slide }],
          }}
        >
          <View
            style={{
              paddingLeft: 24,
              paddingBottom: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Text style={s.menuText}>{world?.title}</Text>
            <FloatButton
              label={`Browse ${world?.title}`}
              size={42}
              onPress={() =>
                navigation.navigate("Main", { category: selected })
              }
            >
              <WorldGlyph id={selected} size={21} />
            </FloatButton>
          </View>
          <View
            style={{
              backgroundColor: "#361A69",
              borderTopWidth: 1,
              borderColor: "#B5A6D1",
              paddingTop: 5,
              paddingBottom: 14,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Collapse editing tray"
              onPress={() => setEditing(false)}
              style={{ alignSelf: "center", paddingHorizontal: 36, height: 23 }}
            >
              <ChevronDown color="white" size={23} />
            </Pressable>
            <View
              style={[
                styles.between,
                { paddingHorizontal: 24, marginBottom: 8 },
              ]}
            >
              <Text style={s.trayText}>Edit Existing</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add New"
                onPress={add}
                style={[styles.row, { minHeight: 36, gap: 8 }]}
              >
                <Text style={s.trayText}>Add New</Text>
                <SquarePlus size={23} color="white" />
              </Pressable>
            </View>
            {items.length ? (
              <ScrollView
                showsVerticalScrollIndicator={false}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 22, gap: 11 }}
                onScroll={(e) =>
                  setPage(Math.round(e.nativeEvent.contentOffset.x / 123))
                }
                scrollEventThrottle={100}
              >
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${item.title}`}
                    onPress={() => navigation.navigate("Composer", { item })}
                    style={{
                      width: 112,
                      height: 109,
                      borderRadius: 20,
                      overflow: "hidden",
                      borderWidth: 1,
                      borderColor: "#FFFFFF33",
                    }}
                  >
                    <Cover
                      item={item}
                      style={{ position: "absolute", inset: 0 }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        inset: 0,
                        backgroundColor: "#0003",
                        padding: 9,
                        justifyContent: "flex-end",
                      }}
                    >
                      <View style={{ position: "absolute", top: 8, right: 7 }}>
                        <Pencil size={21} color="white" />
                      </View>
                      <Text
                        numberOfLines={2}
                        style={{
                          color: "white",
                          fontFamily: font.semibold,
                          fontSize: 12,
                        }}
                      >
                        {item.title}
                      </Text>
                      <Text
                        style={{
                          color: "#E2D7F4",
                          fontSize: 10,
                          fontFamily: font.regular,
                        }}
                      >
                        {guest ? "Sample draft" : item.visibility}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={add}
                style={{
                  marginHorizontal: 22,
                  height: 109,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: "#8A66B3",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Plus size={28} color="white" />
                <Text style={s.trayText}>Add your first creation</Text>
              </Pressable>
            )}
            <View
              style={{
                flexDirection: "row",
                gap: 18,
                paddingHorizontal: 27,
                marginTop: 15,
              }}
            >
              {Array.from(
                { length: Math.min(4, Math.max(1, items.length)) },
                (_, i) => (
                  <View
                    key={i}
                    style={{
                      flex: 1,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor:
                        i === Math.min(page, 3) ? color.lime : "#B7ACCB",
                    }}
                  />
                ),
              )}
            </View>
          </View>
        </Animated.View>
      )}
      <View
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: dockHeight,
          paddingBottom: Math.max(insets.bottom, 10),
          borderTopLeftRadius: 25,
          borderTopRightRadius: 25,
          borderWidth: 1,
          borderColor: "#342A42",
          backgroundColor: "#09060D",
          flexDirection: "row",
          justifyContent: "space-around",
          alignItems: "center",
        }}
      >
        {[
          {
            label: "Dashboard",
            Icon: LayoutGrid,
            active: !editing,
            action: () => navigation.navigate("Profile"),
          },
          { label: "Edit", Icon: Pencil, active: editing, action: edit },
          { label: "Add", Icon: SquarePlus, action: add },
          {
            label: "Promote",
            Icon: Megaphone,
            action: () => navigation.navigate("Utility", { kind: "promote" }),
          },
          {
            label: "Wallet",
            Icon: Wallet,
            action: () => navigation.navigate("Utility", { kind: "wallet" }),
          },
        ].map(({ label, Icon, active, action }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: !!active }}
            onPress={action}
            style={{
              flex: 1,
              alignItems: "center",
              paddingTop: 7,
              gap: 6,
              minHeight: 60,
            }}
          >
            <Icon
              size={25}
              color={active ? "white" : "#8E8795"}
              strokeWidth={1.5}
              fill={label === "Dashboard" && active ? "white" : "none"}
            />
            <Text
              style={{
                fontSize: 12,
                fontFamily: font.regular,
                color: active ? "white" : "#8E8795",
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
const s = {
  menuRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 13,
    minHeight: 45,
  },
  menuText: {
    color: "#FAF7FF",
    fontFamily: font.medium,
    fontSize: 14,
    textShadowColor: "#000",
    textShadowRadius: 8,
  },
  circleSlot: {
    width: 48,
    height: 48,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  circle: {
    borderRadius: 25,
    borderWidth: 1,
    borderColor: "#B5ADBF",
    backgroundColor: "#120D1F80",
  },
  trayText: { color: "#E9E0F5", fontFamily: font.regular, fontSize: 12 },
};
