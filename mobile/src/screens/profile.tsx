import { useDesktopLayout } from "../components/desktop-layout";
import { workspace, WorkspaceHeading } from "../components/desktop-workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  Image,
  ImageBackground,
  Linking,
  Platform,
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
  LockKeyhole,
  Menu,
  Pencil,
  Plus,
  Eye,
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
import { VisitorProfileScreen } from "./visitor-profile";
import { ProfileContentControls } from "../components/profile-content-controls";
import { ProfileAudience } from "../components/profile-audience";
import { DiscoveryNetworkCard } from "../components/discovery-network-card";
import {
  importedDiscoveryMedia,
  discoveryPostUrl,
} from "../lib/discovery-feed";
import { useProfileCollections } from "../lib/use-profile-collections";
import { useNetworkSnapshotExpiry } from "../lib/use-network-snapshot-expiry";
import type { ProfileCollection } from "../lib/profile-collections";
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
import {
  observeProfileWebLayout,
  type ProfileWebLayout,
} from "../lib/profile-web-layout";
import type { Category, ProfileImages, RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function ProfileScreen(
  props: NativeStackScreenProps<RootStack, "Profile">,
) {
  const { session } = useZiipa();
  return props.route.params?.creatorId ? (
    <VisitorProfileScreen
      key={`${session?.access_token}:${props.route.params.creatorId}`}
      {...props}
    />
  ) : (
    <OwnedProfileScreen key={session?.access_token || "guest"} {...props} />
  );
}

function OwnedProfileScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Profile">) {
  const { desktop } = useDesktopLayout();
  const {
    session,
    guest,
    data,
    api,
    recordProfileImages,
    refreshProfileImages,
  } = useZiipa();
  const [category, setCategory] = useState<ProfileCategory>("all");
  const [collection, setCollection] = useState<ProfileCollection>("creations");
  const saved = collection === "saved";
  const [grid, setGrid] = useState(false);
  const collections = useProfileCollections();
  useNetworkSnapshotExpiry(collections.value?.network || null);
  const imported =
    collection === "creations" && category === "all"
      ? importedDiscoveryMedia(collections.value?.network || null)
      : [];
  const [collectionMessage, setCollectionMessage] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [sheet, setSheet] = useState<
    "art" | "account" | "social" | "privacy" | "networks" | null
  >(null);
  const [communityKind, setCommunityKind] = useState<"followers" | "following">(
    "followers",
  );
  const [community, setCommunity] = useState<{
    followers: { id: number; name: string; status: string; revision: number }[];
    following: { id: number; name: string; revision: number }[];
  } | null>(null);
  const [communityRevision, setCommunityRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (sheet === "social" && session && !guest)
      void api<typeof community>("/api/creator/profile/followers")
        .then((value) => {
          if (active) setCommunity(value);
        })
        .catch(() => {
          if (active)
            setCollectionMessage(
              "Community information could not load. Close and reopen this panel to try again.",
            );
        });
    return () => {
      active = false;
    };
  }, [sheet, communityRevision, api, session?.access_token, guest]);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [gridTop, setGridTop] = useState(0);
  const [cardLayouts, setCardLayouts] = useState<{
    key: string;
    values: Record<string, ProfileCardBounds>;
  }>({ key: "", values: {} });
  const scrollRef = useRef<ScrollView>(null);
  const webCards = useRef(new Map<string, Element>());
  const [webLayout, setWebLayout] = useState<{
    identity: object;
    layout: ProfileWebLayout;
  } | null>(null);
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
  const source =
    collection === "tagged"
      ? collections.value?.tagged || []
      : saved
        ? data.items.filter((i) => data.preferences.saved.includes(i.id))
        : guest
          ? data.items
          : data.drafts.filter((i) => i.visibility === "published");
  const items = profileCreations(source, category);
  const layoutKey = `${category}:${collection}:${grid}:${items.map((item) => item.id).join(",")}`;
  const layoutIdentity = useRef(layoutKey);
  layoutIdentity.current = layoutKey;
  const webIdentity = useMemo(() => ({}), [layoutKey, session?.access_token]);
  const currentWebIdentity = useRef(webIdentity);
  currentWebIdentity.current = webIdentity;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const scroller = scrollRef.current?.getScrollableNode() as Element | null;
    if (!scroller?.getBoundingClientRect) return;
    return observeProfileWebLayout(scroller, webCards.current, (layout) => {
      if (currentWebIdentity.current === webIdentity)
        setWebLayout({ identity: webIdentity, layout });
    });
  }, [webIdentity]);
  const currentWebLayout =
    webLayout?.identity === webIdentity ? webLayout.layout : null;
  const cardBounds =
    Platform.OS === "web"
      ? (currentWebLayout?.bounds ?? {})
      : cardLayouts.key === layoutKey
        ? cardLayouts.values
        : {};
  const viewport =
    Platform.OS === "web"
      ? (currentWebLayout?.viewport ?? { top: 0, height: 0, gridTop: 0 })
      : { top: scrollY, height: viewportHeight, gridTop };
  const activity = useProfilePreviewActivity(!!sheet);
  const activeVideo =
    activity.mountVideo && !grid
      ? profileVideoSelection(items, cardBounds, viewport)
      : null;
  const createCategory: Category = category === "all" ? "video" : category;
  return (
    <View style={styles.screen}>
      <ScrollView
        ref={scrollRef}
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
              <ProfileAudience
                profile={collections.value}
                onPeople={(kind, provider) => {
                  if (provider !== "ziipa") {
                    navigation.navigate("Connections", { tab: "accounts" });
                    return;
                  }
                  setCommunityKind(kind);
                  setSheet("social");
                }}
              />
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
              label={
                collections.value?.privacy.visibility === "private"
                  ? "Profile is followers-only · change privacy"
                  : "Make profile followers-only"
              }
              icon={
                collections.value?.privacy.visibility === "private"
                  ? LockKeyhole
                  : LockKeyholeOpen
              }
              size={36}
              onPress={() => {
                setCollectionMessage("");
                setSheet("privacy");
              }}
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
          {!!session && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Preview your creator profile"
              onPress={() =>
                navigation.navigate("Profile", { creatorId: session.user.id })
              }
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                padding: 12,
              }}
            >
              <Eye size={16} color={color.muted} />
              <Text style={styles.small}>Preview profile</Text>
            </Pressable>
          )}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 24,
            paddingVertical: 15,
            flexWrap: "wrap",
          }}
        >
          <ProfileContentControls
            collection={collection}
            grid={grid}
            onGallery={() =>
              navigation.navigate("CreatorGallery", {
                creatorId: session?.user.id,
              })
            }
            onGrid={() => {
              setCollection("creations");
              setCategory("all");
              setGrid(true);
            }}
            onCollection={(value) => {
              setCollection(value);
              setCategory("all");
            }}
            onReset={() => {
              setCategory("all");
              setCollection("creations");
              setGrid(false);
              collections.reload();
            }}
          />
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
            paddingHorizontal: grid || desktop ? 0 : 23,
            gap: grid ? 0 : desktop ? 18 : 10,
            flexDirection: "row",
            flexWrap: "wrap",
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
                ref={(node) => {
                  if (Platform.OS !== "web") return;
                  if (node)
                    webCards.current.set(item.id, node as unknown as Element);
                  else webCards.current.delete(item.id);
                }}
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
                          values: {
                            ...values,
                            [item.id]: { top: y, height },
                          },
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
                  width: grid ? "33.333333%" : "100%",
                  height: grid ? undefined : desktop ? 320 : 179,
                  aspectRatio: grid ? 1 : undefined,
                  borderRadius: grid ? 0 : desktop ? 12 : 25,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor: grid ? color.bg : "#5D506E",
                }}
              >
                <ProfileMediaPreview
                  item={item}
                  thumbnailOnly={grid}
                  visible={
                    activity.visible &&
                    profileCardVisible(cardBounds[item.id], viewport)
                  }
                  videoActive={activeVideo === item.id}
                  autoplay={activity.autoplay}
                  allowVideoStill={activity.mountVideo}
                />
                {!grid && (
                  <View
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: grid ? 6 : 14,
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
                        fontSize: grid ? 11 : 19,
                        fontFamily: font.semibold,
                      }}
                    >
                      {item.title}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
          {collection === "tagged" &&
            collections.value?.tagged.map((tag) => (
              <View key={`remove-tag:${tag.id}`} style={{ width: "100%" }}>
                <Action
                  title={`Remove tag · ${tag.title}`}
                  secondary
                  disabled={collectionBusy}
                  onPress={() => {
                    setCollectionBusy(true);
                    setCollectionMessage("");
                    void api(`/api/creator/profile/tags/${tag.id}`, {
                      accepted: false,
                      revision: tag.profile_tag_revision,
                    })
                      .then(() => collections.reload())
                      .catch(() =>
                        setCollectionMessage(
                          "The tag could not be removed. Refresh and try again.",
                        ),
                      )
                      .finally(() => setCollectionBusy(false));
                  }}
                />
              </View>
            ))}
          {collection === "tagged" &&
            collections.value?.pending_tags.map((tag) => (
              <View
                key={`tag:${tag.item.id}`}
                style={{
                  width: "100%",
                  padding: 14,
                  gap: 8,
                  backgroundColor: color.panel,
                  borderRadius: 12,
                }}
              >
                <Text style={styles.body}>
                  {tag.item.creator} tagged you in {tag.item.title}
                </Text>
                <Text style={styles.small}>
                  Accept to display this public creation on your profile.
                </Text>
                <View style={styles.row}>
                  {[true, false].map((accepted) => (
                    <Action
                      key={String(accepted)}
                      title={accepted ? "Accept tag" : "Dismiss"}
                      secondary
                      disabled={collectionBusy}
                      onPress={() => {
                        setCollectionBusy(true);
                        setCollectionMessage("");
                        void api(`/api/creator/profile/tags/${tag.item.id}`, {
                          accepted,
                          revision: tag.revision,
                        })
                          .then(() => collections.reload())
                          .catch(() =>
                            setCollectionMessage(
                              "The tag could not be updated. Refresh and try again.",
                            ),
                          )
                          .finally(() => setCollectionBusy(false));
                      }}
                    />
                  ))}
                </View>
              </View>
            ))}
          {!!(collections.error || collectionMessage) && (
            <Notice text={collections.error || collectionMessage} />
          )}
          {imported.map((media) => (
            <DiscoveryNetworkCard
              key={`${media.provider}:${media.id}`}
              media={media}
              compact={grid}
              style={
                grid
                  ? {
                      width: "33.333333%",
                      aspectRatio: 1,
                      borderRadius: 0,
                      borderColor: color.bg,
                    }
                  : { width: "100%" }
              }
              onOpen={(value) => {
                const url = discoveryPostUrl(value);
                if (url)
                  void Linking.openURL(url).catch(() =>
                    setCollectionMessage(
                      "The original network post could not open.",
                    ),
                  );
              }}
            />
          ))}
          {!items.length && !imported.length && (
            <View
              testID="profile-empty-collection"
              style={{
                width: "100%",
                minWidth: 0,
                paddingHorizontal: grid ? 23 : 0,
                paddingVertical: 22,
                gap: 8,
              }}
            >
              <Text style={[styles.heading, { fontSize: 18, flexShrink: 1 }]}>
                {collection === "tagged"
                  ? "Your tagged media."
                  : saved
                    ? "Keep your inspiration."
                    : "Your next creation."}
              </Text>
              <Text style={[styles.body, { fontSize: 14, flexShrink: 1 }]}>
                {collection === "tagged"
                  ? "Approved public media tags appear here. New tags need your review."
                  : saved
                    ? "Save a creation from the floating bookmark button in the feed."
                    : "Add a creation in Studio to start this collection."}
              </Text>
              <Action
                title={saved ? "Explore creations" : "Open Studio"}
                secondary
                onPress={() =>
                  saved
                    ? navigation.navigate("Main")
                    : navigation.navigate("Studio", {
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
        onSelect={(id) =>
          id === "store" ? navigation.navigate("Store") : setCategory(id)
        }
        onInbox={() => navigation.navigate("Utility", { kind: "inbox" })}
      />
      {sheet && (
        <Sheet
          title={
            sheet === "networks"
              ? "Profile network visibility"
              : sheet === "art"
                ? "Cover artwork"
                : sheet === "privacy"
                  ? "Profile privacy"
                  : sheet === "social"
                    ? "Your community"
                    : "Your creative space"
          }
          onClose={() => setSheet(null)}
        >
          {sheet === "networks" ? (
            <View style={{ width: "100%", gap: 8, paddingVertical: 12 }}>
              <Text style={styles.heading}>Connected posts</Text>
              <Text style={styles.small}>
                Your imported public posts. Choose which networks to display to
                profile visitors.
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {collections.value?.network.providers.map((account) => {
                  const selected =
                    !!collections.value?.sharing?.providers.includes(
                      account.provider,
                    );
                  return (
                    <Pill
                      key={account.provider}
                      active={selected}
                      title={`${selected ? "✓ " : ""}${account.name}`}
                      onPress={() => {
                        const sharing = collections.value?.sharing;
                        if (!sharing || collectionBusy) return;
                        setCollectionBusy(true);
                        setCollectionMessage("");
                        const providers = selected
                          ? sharing.providers.filter(
                              (value) => value !== account.provider,
                            )
                          : [...sharing.providers, account.provider];
                        void api("/api/creator/profile/network-sharing", {
                          providers,
                          revision: sharing.revision,
                        })
                          .then(() => collections.reload())
                          .catch(() =>
                            setCollectionMessage(
                              "Profile sharing could not be updated. Check your public profile and network connection, then refresh.",
                            ),
                          )
                          .finally(() => setCollectionBusy(false));
                      }}
                    />
                  );
                })}
              </View>
              {!imported.length && (
                <Text style={styles.small}>
                  {collections.loading
                    ? "Loading connected posts…"
                    : "No supported public imports available. Connect and sync your accounts in Networks."}
                </Text>
              )}
              <Action
                title="Manage connected networks"
                secondary
                onPress={() =>
                  navigation.navigate("Connections", { tab: "accounts" })
                }
              />
            </View>
          ) : sheet === "art" ? (
            <ProfileImageControls
              key={`cover:${session?.access_token || "guest"}`}
              kind="cover"
              profile={profile}
              onSaved={savedProfile}
              onPreviewSample={setPreviewBanner}
            />
          ) : sheet === "privacy" ? (
            <>
              <Notice
                text={
                  collections.value?.privacy.visibility === "private"
                    ? "Only approved Ziipa followers can view your profile artwork and published creations. New follow requests need your approval. Saved collections remain private to you."
                    : "Your published profile is visible to permitted Ziipa members. Make it followers-only to approve new followers before they can view it. Existing followers retain access."
                }
              />
              {!!collectionMessage && <Notice text={collectionMessage} />}
              <Action
                title={
                  collections.value?.privacy.visibility === "private"
                    ? "Make profile public"
                    : "Make profile followers-only"
                }
                disabled={collectionBusy || !collections.value?.privacy}
                onPress={() => {
                  const privacy = collections.value?.privacy;
                  if (!privacy || collectionBusy) return;
                  setCollectionBusy(true);
                  setCollectionMessage("");
                  void api("/api/creator/profile/privacy", {
                    private: privacy.visibility !== "private",
                    expected_visibility: privacy.visibility,
                    revision: privacy.revision,
                  })
                    .then(() => {
                      collections.reload();
                      setSheet(null);
                    })
                    .catch(() =>
                      setCollectionMessage(
                        "Privacy could not be changed. Check live-session status, refresh your profile and try again.",
                      ),
                    )
                    .finally(() => setCollectionBusy(false));
                }}
              />
            </>
          ) : sheet === "social" ? (
            <>
              <Text style={styles.heading}>
                {communityKind === "followers"
                  ? "Ziipa followers & requests"
                  : "Following on Ziipa"}
              </Text>
              {!!collectionMessage && <Notice text={collectionMessage} />}
              {!community && (
                <Text style={styles.small}>Loading community…</Text>
              )}
              <ScrollView style={{ maxHeight: 310 }}>
                {communityKind === "followers"
                  ? community?.followers.map((person) => (
                      <View
                        key={person.id}
                        style={{ gap: 6, paddingVertical: 10 }}
                      >
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`View ${person.name}'s profile`}
                          onPress={() => {
                            setSheet(null);
                            navigation.navigate("Profile", {
                              creatorId: person.id,
                            });
                          }}
                        >
                          <Text style={styles.body}>
                            {person.name} ·{" "}
                            {person.status === "pending"
                              ? "Request pending"
                              : "Following you"}
                          </Text>
                        </Pressable>
                        <View style={styles.row}>
                          {(person.status === "pending"
                            ? [true, false]
                            : [false]
                          ).map((accepted) => (
                            <Action
                              key={String(accepted)}
                              secondary
                              title={
                                accepted
                                  ? "Approve"
                                  : person.status === "pending"
                                    ? "Decline"
                                    : "Remove follower"
                              }
                              disabled={collectionBusy}
                              onPress={() => {
                                setCollectionBusy(true);
                                setCollectionMessage("");
                                void api(
                                  `/api/creator/profile/followers/${person.id}`,
                                  { accepted, revision: person.revision },
                                )
                                  .then(() => {
                                    setCommunityRevision((value) => value + 1);
                                    collections.reload();
                                  })
                                  .catch(() =>
                                    setCollectionMessage(
                                      "Follow status changed or could not save. Reopen this panel and try again.",
                                    ),
                                  )
                                  .finally(() => setCollectionBusy(false));
                              }}
                            />
                          ))}
                        </View>
                      </View>
                    ))
                  : community?.following.map((person) => (
                      <View
                        key={person.id}
                        style={{ gap: 6, paddingVertical: 10 }}
                      >
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`View ${person.name}'s profile`}
                          onPress={() => {
                            setSheet(null);
                            navigation.navigate("Profile", {
                              creatorId: person.id,
                            });
                          }}
                        >
                          <Text style={styles.body}>{person.name}</Text>
                        </Pressable>
                        <Action
                          secondary
                          title="Unfollow"
                          disabled={collectionBusy}
                          onPress={() => {
                            setCollectionBusy(true);
                            void api(
                              `/api/creator/profiles/${person.id}/unfollow`,
                              { revision: person.revision },
                            )
                              .then(() => {
                                setCommunityRevision((value) => value + 1);
                                collections.reload();
                              })
                              .catch(() =>
                                setCollectionMessage(
                                  "Unfollow could not save. Reopen this panel and try again.",
                                ),
                              )
                              .finally(() => setCollectionBusy(false));
                          }}
                        />
                      </View>
                    ))}
              </ScrollView>
              {community &&
                !(
                  communityKind === "followers"
                    ? community.followers
                    : community.following
                ).length && (
                  <Text style={styles.small}>
                    {communityKind === "followers"
                      ? "No Ziipa followers or requests yet."
                      : "You are not following any Ziipa creators yet."}
                  </Text>
                )}
              <Text style={styles.small}>
                Shows up to 200 recent Ziipa relationships. Connected-network
                counts remain separate.
              </Text>
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
              {!guest && (
                <Action
                  title="Profile network visibility"
                  secondary
                  onPress={() => setSheet("networks")}
                />
              )}
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
