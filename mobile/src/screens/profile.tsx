import { useState } from "react";
import {
  ImageBackground,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ArrowLeft,
  Camera,
  LockKeyholeOpen,
  Menu,
  Pencil,
  Plus,
} from "lucide-react-native";
import {
  CategoryDock,
  FloatButton,
  Sheet,
  WorldGlyph,
  worlds,
} from "../components/floating";
import { Action, Cover, Notice, Pill } from "../components/ui";
import { coverSource } from "../lib/assets";
import { inCreativeWorld } from "../lib/domain";
import type { Category, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function ProfileScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Profile">) {
  const { session, guest, data } = useZiipa();
  const [category, setCategory] = useState<Category>("music");
  const [saved, setSaved] = useState(false);
  const [sheet, setSheet] = useState<"art" | "account" | "social" | null>(null);
  const [banner, setBanner] = useState("/media/studio.jpg");
  const insets = useSafeAreaInsets();
  const source = saved
    ? data.items.filter((i) => data.preferences.saved.includes(i.id))
    : guest
      ? data.items
      : data.drafts.filter((i) => i.visibility === "published");
  const items = source.filter((i) => inCreativeWorld(i, category));
  return (
    <View style={styles.screen}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 108 + insets.bottom }}
      >
        <ImageBackground
          source={coverSource(banner, session?.access_token)}
          style={{ height: 216 + insets.top }}
          imageStyle={{ opacity: 0.8 }}
        >
          <SafeAreaView
            edges={["top"]}
            style={{ flex: 1, backgroundColor: "#08031220" }}
          >
            <View
              style={[styles.between, { paddingHorizontal: 15, paddingTop: 5 }]}
            >
              <FloatButton
                label="Back to discovery"
                icon={ArrowLeft}
                plain
                onPress={() => navigation.navigate("Main")}
              />
              <FloatButton
                label="Open Studio menu"
                icon={Menu}
                onPress={() => navigation.navigate("Studio")}
              />
            </View>
            <View
              style={{
                position: "absolute",
                bottom: 17,
                left: 115,
                right: 14,
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Follower information"
                onPress={() => setSheet("social")}
                style={{ alignItems: "center", padding: 8 }}
              >
                <Text style={p.stat}>—</Text>
                <Text style={p.label}>Followers</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Following information"
                onPress={() => setSheet("social")}
                style={{ alignItems: "center", padding: 8 }}
              >
                <Text style={p.stat}>—</Text>
                <Text style={p.label}>Following</Text>
              </Pressable>
              <FloatButton
                label="Change cover artwork"
                size={36}
                icon={Camera}
                onPress={() => setSheet("art")}
              />
            </View>
          </SafeAreaView>
        </ImageBackground>
        <View
          style={{
            borderBottomWidth: 1,
            borderColor: color.border,
            paddingBottom: 12,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              paddingHorizontal: 16,
              alignItems: "center",
              gap: 12,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Your profile information"
              onPress={() => setSheet("account")}
              style={{
                width: 82,
                height: 82,
                borderRadius: 43,
                borderWidth: 4,
                borderColor: color.bg,
                marginTop: -31,
                backgroundColor: "#FB772F",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontFamily: font.semibold,
                  fontSize: 32,
                  color: "#170D27",
                }}
              >
                {session?.user.name.slice(0, 1) || "Z"}
              </Text>
              <View
                style={{
                  position: "absolute",
                  right: -3,
                  bottom: 0,
                  padding: 3,
                  backgroundColor: "#09060D",
                  borderRadius: 12,
                }}
              >
                <Camera size={14} color="white" />
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create"
              onPress={() => navigation.navigate("Composer", { category })}
              style={p.action}
            >
              <Plus size={18} color="white" />
              <Text style={p.actionText}>Create</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your creations"
              onPress={() =>
                navigation.navigate("Studio", { category, edit: true })
              }
              style={p.action}
            >
              <Pencil size={16} color="white" />
              <Text style={p.actionText}>Edit</Text>
            </Pressable>
            <FloatButton
              label="Account and wallet"
              icon={LockKeyholeOpen}
              size={36}
              onPress={() => setSheet("account")}
            />
          </View>
          <View
            style={{
              paddingHorizontal: 23,
              marginTop: 6,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text
              style={{
                color: "#F5EDF9",
                fontFamily: font.medium,
                fontSize: 13,
              }}
            >
              {session?.user.name || "Ziipa Studio"}
            </Text>
            <Text
              style={{
                color: color.faint,
                fontFamily: font.regular,
                fontSize: 10,
              }}
            >
              {guest ? "SAMPLE PROFILE" : "CREATOR"}
            </Text>
          </View>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 24,
            paddingVertical: 15,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              saved ? "Show creations" : "Show saved creations"
            }
            onPress={() => setSaved(!saved)}
            style={{ paddingVertical: 6 }}
          >
            <Text
              style={{
                color: saved ? color.lime : color.faint,
                fontFamily: font.regular,
                fontSize: 12,
              }}
            >
              {saved ? "Saved" : "Creations"}
            </Text>
          </Pressable>
          <View style={styles.row}>
            <Text style={p.label}>
              {worlds.find((w) => w.id === category)?.title}
            </Text>
            <WorldGlyph id={category} size={19} />
          </View>
        </View>
        <View style={{ paddingHorizontal: 23, gap: 10 }}>
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Watch ${item.title}`}
              onPress={() =>
                navigation.navigate("Watch", { itemId: item.id, category })
              }
              style={{
                height: 179,
                borderRadius: 25,
                overflow: "hidden",
                borderWidth: 1,
                borderColor: "#5D506E",
              }}
            >
              <Cover item={item} style={{ flex: 1 }} />
              <View
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: 14,
                  backgroundColor: "#0C04185C",
                }}
              >
                <Text
                  style={{
                    color: "white",
                    fontSize: 19,
                    fontFamily: font.semibold,
                  }}
                >
                  {item.title}
                </Text>
              </View>
            </Pressable>
          ))}
          {!items.length && (
            <View style={{ paddingVertical: 35, gap: 12 }}>
              <Text style={styles.heading}>
                {saved ? "Keep your inspiration." : "Your next creation."}
              </Text>
              <Text style={styles.body}>
                {saved
                  ? "Save a creation from the floating bookmark button in the feed."
                  : "Add a creation in Studio to start this collection."}
              </Text>
              <Action
                title="Open Studio"
                secondary
                onPress={() =>
                  navigation.navigate("Studio", { category, edit: true })
                }
              />
            </View>
          )}
        </View>
      </ScrollView>
      <CategoryDock
        selected={category}
        onSelect={setCategory}
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
      {sheet && (
        <Sheet
          title={
            sheet === "art"
              ? "Cover artwork"
              : sheet === "social"
                ? "Your community"
                : "Your creative space"
          }
          onClose={() => setSheet(null)}
        >
          {sheet === "art" ? (
            <>
              <Notice text="Try a cover from the sample collection. This appearance preview lasts until the app restarts; it is not uploaded to your account." />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {data.items.slice(0, 5).map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${item.title} artwork`}
                    onPress={() => {
                      setBanner(item.cover);
                      setSheet(null);
                    }}
                  >
                    <Cover
                      item={item}
                      style={{ height: 88, width: 94, borderRadius: 13 }}
                    />
                  </Pressable>
                ))}
              </View>
            </>
          ) : sheet === "social" ? (
            <Notice text="The follower graph is not connected yet. These values remain empty rather than showing fictional follower counts." />
          ) : (
            <>
              <Text style={styles.body}>
                {guest
                  ? "Explore your Studio, drafts, saved creations and feed rules. Sample changes stay in memory and reset on restart."
                  : session?.user.name}
              </Text>
              <Action
                title="Creator Studio"
                onPress={() => {
                  setSheet(null);
                  navigation.navigate("Studio");
                }}
              />
              <Action
                title="My feed rules"
                secondary
                onPress={() => {
                  setSheet(null);
                  navigation.navigate("Feeds");
                }}
              />
              <Action
                title="Connected networks"
                secondary
                onPress={() => {
                  setSheet(null);
                  navigation.navigate("Connections");
                }}
              />
              <Action
                title="Wallet"
                secondary
                onPress={() => {
                  setSheet(null);
                  navigation.navigate("Utility", { kind: "wallet" });
                }}
              />
              <Pill
                title={
                  guest ? "Sign in on a native device" : "Account settings"
                }
                onPress={() => {
                  setSheet(null);
                  navigation.navigate(guest ? "Login" : "Settings");
                }}
              />
            </>
          )}
        </Sheet>
      )}
    </View>
  );
}
const p = {
  stat: { color: "white", fontFamily: font.bold, fontSize: 22 },
  label: { color: "#E5DCEA", fontFamily: font.regular, fontSize: 13 },
  action: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 5,
    height: 33,
    borderWidth: 1,
    borderRadius: 4,
    borderColor: color.border,
  },
  actionText: { color: color.text, fontFamily: font.medium, fontSize: 16 },
};
