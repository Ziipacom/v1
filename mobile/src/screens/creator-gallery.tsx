import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ArrowLeft } from "lucide-react-native";
import { FloatButton } from "../components/floating";
import { GallerySlider } from "../components/gallery-slider";
import { Action, Notice } from "../components/ui";
import { useProfileCollections } from "../lib/use-profile-collections";
import type { RootStack } from "../lib/types";
import { styles } from "../theme";

/** Loads this creator's authorised collection, never another account's cache. */
export function CreatorGalleryScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "CreatorGallery">) {
  const result = useProfileCollections(route.params?.creatorId);
  const profile = result.value;
  const items = profile?.access === "allowed" ? profile.items : [];
  return (
    <SafeAreaView style={styles.screen}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 12,
        }}
      >
        <FloatButton
          icon={ArrowLeft}
          label="Back to Profile"
          onPress={() =>
            navigation.canGoBack()
              ? navigation.goBack()
              : navigation.navigate("Profile", route.params)
          }
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.heading}>Gallery</Text>
          <Text numberOfLines={1} style={styles.small}>
            {profile?.creator.name || "Creator"}
          </Text>
        </View>
      </View>
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
            paddingBottom: 16,
          }}
        >
          <GallerySlider
            items={items}
            label="All creations"
            onOpen={(item) =>
              navigation.navigate("Watch", {
                itemId: item.id,
                category: item.category,
              })
            }
          />
        </View>
      ) : profile?.access === "allowed" ? (
        <Notice text="No published creations in this Gallery yet." />
      ) : null}
    </SafeAreaView>
  );
}
