import { useState } from "react";
import {
  Image,
  ImageBackground,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ArrowLeft, UserRound } from "lucide-react-native";
import { FloatButton, Sheet } from "../components/floating";
import { Action, Notice } from "../components/ui";
import { ProfileContentControls } from "../components/profile-content-controls";
import { ProfileAudience } from "../components/profile-audience";
import {
  ProfileMediaPreview,
  useProfilePreviewActivity,
} from "../components/profile-media-preview";
import { DiscoveryNetworkCard } from "../components/discovery-network-card";
import { useDesktopLayout } from "../components/desktop-layout";
import {
  importedDiscoveryMedia,
  discoveryPostUrl,
} from "../lib/discovery-feed";
import { useNetworkSnapshotExpiry } from "../lib/use-network-snapshot-expiry";
import { useProfileCollections } from "../lib/use-profile-collections";
import { useProfileImageSource } from "../lib/profile-image-source";
import type { ProfileCollection } from "../lib/profile-collections";
import type { RootStack } from "../lib/types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

export function VisitorProfileScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Profile">) {
  const { desktop } = useDesktopLayout();
  const { session, data, api } = useZiipa();
  const result = useProfileCollections(route.params?.creatorId);
  const profile = result.value;
  const [collection, setCollection] = useState<ProfileCollection>("creations");
  const [grid, setGrid] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [limit, setLimit] = useState(20);
  const [message, setMessage] = useState("");
  const avatar = useProfileImageSource(
    profile?.profile.avatar_url,
    session?.access_token,
  );
  const cover = useProfileImageSource(
    profile?.profile.cover_url,
    session?.access_token,
  );
  const activity = useProfilePreviewActivity(false);
  useNetworkSnapshotExpiry(profile?.network || null);
  const network =
    collection === "creations"
      ? importedDiscoveryMedia(profile?.network || null)
      : [];
  const items =
    collection === "tagged"
      ? profile?.tagged || []
      : collection === "saved"
        ? []
        : profile?.items || [];
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: 32,
          maxWidth: desktop ? 1000 : undefined,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <ImageBackground
          source={cover || undefined}
          style={{ height: desktop ? 220 : 195, backgroundColor: color.panel }}
        >
          <View style={{ padding: 12 }}>
            <FloatButton
              icon={ArrowLeft}
              label="Back from creator profile"
              plain
              onPress={() => navigation.goBack()}
            />
          </View>
        </ImageBackground>
        <View style={{ padding: 20, gap: 12 }}>
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 44,
              borderWidth: 3,
              borderColor: color.bg,
              marginTop: -55,
              backgroundColor: color.panel,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {avatar ? (
              <Image
                source={avatar}
                style={{ width: "100%", height: "100%" }}
              />
            ) : (
              <UserRound size={30} color={color.muted} />
            )}
          </View>
          <Text style={styles.heading}>
            {profile?.creator.name || "Creator profile"}
          </Text>
          <Text style={styles.small}>
            {profile?.privacy.visibility === "private"
              ? "Followers-only creations"
              : "Public creations"}
            {" · Connected posts shared by this creator"}
          </Text>
          <ProfileAudience
            profile={profile}
            onPeople={() =>
              setMessage(
                "These are this creator's network-specific counts. Manage your own follows from your Profile.",
              )
            }
          />
          {profile && !profile.relationship.self && (
            <Action
              secondary
              disabled={tagBusy}
              title={
                profile.relationship.status === "accepted"
                  ? "Following · Unfollow"
                  : profile.relationship.status === "pending"
                    ? "Cancel follow request"
                    : profile.privacy.visibility === "private"
                      ? "Request to follow"
                      : "Follow on Ziipa"
              }
              onPress={() => {
                if (tagBusy) return;
                setTagBusy(true);
                setMessage("");
                const operation = ["accepted", "pending"].includes(
                  profile.relationship.status,
                )
                  ? "unfollow"
                  : "follow";
                void api(
                  `/api/creator/profiles/${profile.creator.id}/${operation}`,
                  { revision: profile.relationship.revision },
                )
                  .then(() => result.reload())
                  .catch(() =>
                    setMessage(
                      "Follow status could not save. Refresh and try again.",
                    ),
                  )
                  .finally(() => setTagBusy(false));
              }}
            />
          )}
          {profile?.access === "followers_only" && (
            <Notice text="This profile is followers-only. Request to follow; the creator must approve before their profile artwork and creations become available." />
          )}
          {result.loading && <Notice text="Loading creator profile…" />}
          {!!(result.error || message) && (
            <Notice text={result.error || message} />
          )}
          {profile?.access === "allowed" &&
            session?.user.id !== profile.creator.id && (
              <Action
                title="Tag in a creation"
                secondary
                onPress={() => setTagOpen(true)}
              />
            )}
          <ProfileContentControls
            collection={collection}
            grid={grid}
            visitor
            onGallery={() =>
              navigation.navigate("CreatorGallery", {
                creatorId: route.params?.creatorId,
              })
            }
            onGrid={() => {
              setCollection("creations");
              setGrid(true);
              setMessage("");
            }}
            onCollection={(value) => {
              setCollection(value);
              setLimit(20);
              setMessage(
                value === "saved"
                  ? "Saved collections are private to their owner."
                  : "",
              );
            }}
            onReset={() => {
              setCollection("creations");
              setGrid(false);
              setLimit(20);
              setMessage("");
              result.reload();
            }}
          />
          <View
            testID="visitor-profile-creations-feed"
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: grid ? 0 : 8,
              marginHorizontal: grid ? -20 : 0,
            }}
          >
            {items.slice(0, limit).map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Watch ${item.title}`}
                onPress={() =>
                  navigation.navigate("Watch", {
                    itemId: item.id,
                    category: item.category,
                  })
                }
                style={{
                  width: grid ? "33.333333%" : "100%",
                  height: grid ? undefined : desktop ? 300 : 190,
                  aspectRatio: grid ? 1 : undefined,
                  borderRadius: grid ? 0 : 22,
                  borderWidth: grid ? 1 : 0,
                  borderColor: color.bg,
                  overflow: "hidden",
                  backgroundColor: color.panel,
                }}
              >
                <ProfileMediaPreview
                  item={item}
                  thumbnailOnly={grid}
                  visible={activity.visible}
                  videoActive={false}
                  autoplay={false}
                  allowVideoStill={activity.mountVideo}
                />
                {!grid && (
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: grid ? 6 : 14,
                      backgroundColor: "#10081EA8",
                      gap: 4,
                    }}
                  >
                    {!grid && (
                      <Text style={styles.small}>
                        {item.category === "video" || item.category === "music"
                          ? "Music & Film"
                          : item.category}
                      </Text>
                    )}
                    <Text
                      numberOfLines={2}
                      style={{
                        fontFamily: font.semibold,
                        color: "white",
                        fontSize: grid ? 11 : 19,
                      }}
                    >
                      {item.title}
                    </Text>
                  </View>
                )}
              </Pressable>
            ))}
            {network.slice(0, limit).map((media) => (
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
                      setMessage("The original network post could not open."),
                    );
                }}
              />
            ))}
          </View>
          {items.length > limit && (
            <Action
              title="Load more creations"
              secondary
              onPress={() => setLimit((value) => value + 20)}
            />
          )}
          {network.length > limit && (
            <Action
              title="Load more connected posts"
              secondary
              onPress={() => setLimit((value) => value + 20)}
            />
          )}
          {profile && !items.length && !network.length && (
            <Text style={styles.body}>
              {collection === "saved"
                ? "Only the owner can view this collection."
                : collection === "tagged"
                  ? "No approved public tagged media yet."
                  : "No public creations or shared connected posts yet."}
            </Text>
          )}
        </View>
      </ScrollView>
      {tagOpen && (
        <Sheet
          title={`Tag ${profile?.creator.name || "creator"}`}
          onClose={() => setTagOpen(false)}
        >
          <Text style={styles.body}>
            Choose your published creation. The creator must accept before it
            appears on their profile.
          </Text>
          {data.drafts
            .filter((item) => item.visibility === "published")
            .slice(0, 50)
            .map((item) => (
              <Action
                key={item.id}
                title={item.title}
                secondary
                disabled={tagBusy}
                onPress={() => {
                  if (!profile || tagBusy) return;
                  setTagBusy(true);
                  void api(`/api/creator/profiles/${profile.creator.id}/tags`, {
                    item_id: item.id,
                  })
                    .then(() => {
                      setMessage("Tag request sent for the creator to review.");
                      setTagOpen(false);
                    })
                    .catch(() =>
                      setMessage(
                        "The tag request could not be sent. Check the creation and try again.",
                      ),
                    )
                    .finally(() => setTagBusy(false));
                }}
              />
            ))}
          {!data.drafts.some((item) => item.visibility === "published") && (
            <Notice text="Publish a creation before requesting a tag." />
          )}
        </Sheet>
      )}
    </SafeAreaView>
  );
}
