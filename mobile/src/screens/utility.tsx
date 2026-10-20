import { useDesktopLayout } from "../components/desktop-layout";
import { workspace, WorkspaceHeading } from "../components/desktop-workspace";
import { ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { MailOpen } from "lucide-react-native";
import { Action, Notice } from "../components/ui";
import { PromotionHub } from "../components/promotion-hub";
import { WalletScreen } from "./wallet";
import { styles } from "../theme";

import type { RootStack } from "../lib/types";
export function UtilityScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Utility">) {
  const { desktop } = useDesktopLayout();
  const kind = route.params.kind;
  if (kind === "wallet")
    return (
      <WalletScreen
        key={route.params.item?.id || "wallet"}
        navigation={navigation}
        initialItem={route.params.item}
      />
    );
  if (kind === "promote")
    return (
      <PromotionHub navigation={navigation} initialItem={route.params.item} />
    );
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={
        desktop ? [workspace.page, workspace.narrow] : styles.page
      }
    >
      {!desktop && (
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            borderWidth: 1,
            borderColor: "#947DAF",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#301553",
          }}
        >
          <MailOpen size={32} color="white" />
        </View>
      )}
      {desktop ? (
        <WorkspaceHeading
          title="Inbox"
          description="Creator conversations and community updates."
        />
      ) : (
        <Text style={styles.title}>Your inbox</Text>
      )}
      <Text style={styles.eyebrow}>DESIGN PREVIEW · NOT CONNECTED</Text>
      <Text style={styles.body}>
        A place for creator conversations and community updates.
      </Text>
      <Notice text="Direct messaging is not connected yet. You can try the comment sheet on each creation in the sample feed." />
      <Action
        title="Explore creations"
        onPress={() => navigation.navigate("Main")}
      />
      <Action
        secondary
        title="Back to Studio"
        onPress={() => navigation.navigate("Studio")}
      />
    </ScrollView>
  );
}
