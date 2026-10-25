import { useDesktopLayout } from "../components/desktop-layout";
import { workspace, WorkspaceHeading } from "../components/desktop-workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  Image,
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
  RefreshCw,
  Sparkles,
} from "lucide-react-native";
import {
  CategoryDock,
  FloatButton,
  Sheet,
  WorldGlyph,
  worlds,
} from "../components/floating";
import { Action, Notice, Pill, allCategories } from "../components/ui";
import { SignOutButton } from "../components/account-menu";
import { ProfileImageControls } from "../components/profile-image-controls";
import {
  ProfileMediaPreview,
  useProfilePreviewActivity,
} from "../components/profile-media-preview";
import { coverSource } from "../lib/assets";
import { useProfileImageSource } from "../lib/profile-image-source";
import {
  profileCardVisible,
  profileCreations,
  profileVideoSelection,
  type ProfileCategory,
  type ProfileCardBounds,
} from "../lib/profile-preview";
import type { Category, ProfileImages, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function ProfileScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Profile">) {
  const { desktop } = useDesktopLayout();
  const { session, guest, data, recordProfileImages, refreshProfileImages } =
    useZiipa();
  const [category, setCategory] = useState<ProfileCategory>("all");
  const [saved, setSaved] = useState(false);
  const [sheet, setSheet] = useState<"art" | "account" | "social" | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [gridTop, setGridTop] = useState(0);
  const [cardLayouts, setCardLayouts] = useState<{
    key: string;
    values: Record<string, ProfileCardBounds>;
  }>({ key: "", values: {} });
  const [previewBanner, setPreviewBanner] = useState<string | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<object | null>(null);
  const profile = data.profile;
  const banner = previewBanner || profile?.cover_url || "/media/studio.jpg";
  const bannerSource = useProfileImageSource(banner, session?.access_token);
  const avatarSource = useProfileImageSource(
    profile?.avatar_url,
    session?.access_token,
  );
  // A successful account read supplies a new profile receipt, allowing one
  // retry of the same URL. Failed reads keep that receipt and its failure.
  const avatarIdentity = useMemo(
    () => ({}),
    [profile, avatarSource, session?.access_token],
  );
  const currentAvatarIdentity = useRef(avatarIdentity);
  currentAvatarIdentity.current = avatarIdentity;
  useEffect(() => {
    setPreviewBanner(null);
  }, [session?.access_token]);
  useFocusEffect(
    useCallback(() => {
      if (!session || guest) return;
      void refreshProfileImages().catch(() => {
        /* A failed read keeps the last confirmed account artwork. */
      });
    }, [refreshProfileImages, guest, session?.access_token]),
  );
  function savedProfile(images: ProfileImages) {
    if (!session) return;
    recordProfileImages(images, session.access_token);
    setPreviewBanner(null);
  }
  const insets = useSafeAreaInsets();
  const source = saved
    ? data.items.filter((i) => data.preferences.saved.includes(i.id))
    : guest
      ? data.items
      : data.drafts.filter((i) => i.visibility === "published");
  const items = profileCreations(source, category);
  const layoutKey = `${category}:${saved}:${items.map((item) => item.id).join(",")}`;
  const layoutIdentity = useRef(layoutKey);
  layoutIdentity.current = layoutKey;
  const cardBounds = cardLayouts.key === layoutKey ? cardLayouts.values : {};
  const viewport = { top: scrollY, height: viewportHeight, gridTop };
  const activity = useProfilePreviewActivity(!!sheet);
  const activeVideo = activity.mountVideo
    ? profileVideoSelection(items, cardBounds, viewport)
    : null;
  const createCategory: Category = category === "all" ? "video" : category;
  return (
    <View style={styles.screen}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={80}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          setViewportHeight(height);
        }}
        onScroll={(event) => {
          const offset = event.nativeEvent.contentOffset.y;
          setScrollY(offset);
        }}
        contentContainerStyle={
          desktop ? workspace.page : { paddingBottom: 108 + insets.bottom }
        }
      >
        {desktop && (
          <WorkspaceHeading
            title="Your profile"
            description="Your published creations and saved inspiration."
          />
        )}
        <ImageBackground
          source={bannerSource || coverSource("/media/studio.jpg")}
          style={
            desktop
              ? { height: 180, borderRadius: 12, overflow: "hidden" }
              : { height: 216 + insets.top }
          }
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
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <SignOutButton />
                <FloatButton
                  label="Open Studio menu"
                  icon={Menu}
                  onPress={() => navigation.navigate("Studio")}
                />
              </View>
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
              {profile?.avatar_url &&
              avatarSource &&
              failedAvatar !== avatarIdentity ? (
                <Image
                  source={avatarSource}
                  onError={() => {
                    if (currentAvatarIdentity.current === avatarIdentity)
                      setFailedAvatar(avatarIdentity);
                  }}
                  resizeMode="cover"
                  style={{ width: "100%", height: "100%", borderRadius: 39 }}
                />
              ) : (
                <Text
                  style={{
                    fontFamily: font.semibold,
                    fontSize: 32,
                    color: "#170D27",
                  }}
                >
                  {session?.user.name.slice(0, 1) || "Z"}
                </Text>
              )}
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
              onPress={() =>
                navigation.navigate("Composer", { category: createCategory })
              }
              style={p.action}
            >
              <Plus size={18} color="white" />
              <Text style={p.actionText}>Create</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your creations"
              onPress={() =>
                navigation.navigate("Studio", {
                  category: createCategory,
                  edit: true,
                })
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
        <View style={{ paddingHorizontal: 23, paddingTop: 14 }}>
          <Action
            secondary
            title="Open your Personal Media OS"
            icon={Sparkles}
            onPress={() => navigation.navigate("MediaOS")}
          />
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reset Profile to all creations"
              accessibilityHint="Clears the category and Saved view. Your account and saved settings are unchanged."
              onPress={() => {
                setCategory("all");
                setSaved(false);
              }}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <RefreshCw size={16} color={color.muted} />
            </Pressable>
          </View>
          <View style={styles.row}>
            <Text style={p.label}>
              {category === "all"
                ? "All creations"
                : worlds.find((w) => w.id === category)?.title}
            </Text>
            {category !== "all" && <WorldGlyph id={category} size={19} />}
          </View>
        </View>
        <View
          testID="profile-creations-feed"
          onLayout={(event) => {
            const top = event.nativeEvent.layout.y;
            setGridTop(top);
          }}
          style={{
            width: "100%",
            maxWidth: desktop ? 900 : undefined,
            alignSelf: "center",
            paddingHorizontal: desktop ? 0 : 23,
            gap: desktop ? 18 : 10,
          }}
        >
          {items.map((item) => {
            const world = allCategories.find(
              (entry) => entry.id === item.category,
            );
            const worldTitle =
              item.category === "video" || item.category === "music"
                ? "Music & Film"
                : world?.title || "Creation";
            const WorldIcon = world?.icon || Sparkles;
            // Retained cards may keep identical geometry after a filter.
            // Remount this measured leaf, never the scroll container.
            return (
              <Pressable
                key={`${layoutKey}:${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Watch ${item.title} · ${worldTitle}`}
                onLayout={(event) => {
                  const { y, height } = event.nativeEvent.layout;
                  if (layoutIdentity.current !== layoutKey) return;
                  setCardLayouts((previous) => {
                    if (layoutIdentity.current !== layoutKey) return previous;
                    const values =
                      previous.key === layoutKey ? previous.values : {};
                    return values[item.id]?.top === y &&
                      values[item.id]?.height === height
                      ? previous
                      : {
                          key: layoutKey,
                          values: { ...values, [item.id]: { top: y, height } },
                        };
                  });
                }}
                onPress={() =>
                  navigation.navigate("Watch", {
                    itemId: item.id,
                    category: item.category,
                  })
                }
                style={{
                  width: "100%",
                  height: desktop ? 320 : 179,
                  borderRadius: desktop ? 12 : 25,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor: "#5D506E",
                }}
              >
                <ProfileMediaPreview
                  item={item}
                  visible={
                    activity.visible &&
                    profileCardVisible(cardBounds[item.id], viewport)
                  }
                  videoActive={activeVideo === item.id}
                  autoplay={activity.autoplay}
                  allowVideoStill={activity.mountVideo}
                />
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: 14,
                    backgroundColor: "#0C04185C",
                    gap: 6,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <WorldIcon size={15} color="white" />
                    <Text
                      style={{
                        color: "white",
                        fontFamily: font.medium,
                        fontSize: 11,
                      }}
                    >
                      {worldTitle}
                    </Text>
                  </View>
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
            );
          })}
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
                  navigation.navigate("Studio", {
                    category: createCategory,
                    edit: true,
                  })
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
            <ProfileImageControls
              key={`cover:${session?.access_token || "guest"}`}
              kind="cover"
              profile={profile}
              onSaved={savedProfile}
              onPreviewSample={setPreviewBanner}
            />
          ) : sheet === "social" ? (
            <>
              <Notice text="Find your public following and supported network feeds in Networks. Importing a profile never invents Ziipa followers or sends invitations automatically." />
              <Action
                title="Open people & networks"
                onPress={() => {
                  setSheet(null);
                  navigation.navigate("Connections", { tab: "people" });
                }}
              />
            </>
          ) : (
            <>
              <ProfileImageControls
                key={`avatar:${session?.access_token || "guest"}`}
                kind="avatar"
                profile={profile}
                onSaved={savedProfile}
              />
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
                title={guest ? "Sign in to Ziipa" : "Account settings"}
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
