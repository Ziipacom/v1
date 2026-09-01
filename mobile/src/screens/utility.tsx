import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { MailOpen, Megaphone } from "lucide-react-native";
import { Action, Field, Notice } from "../components/ui";
import { WalletScreen } from "./wallet";
import { styles } from "../theme";

import type { RootStack } from "../lib/types";
export function UtilityScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Utility">) {
  const kind = route.params.kind;
  const [audience, setAudience] = useState("");
  const [saved, setSaved] = useState(false);
  if (kind === "wallet")
    return (
      <WalletScreen
        key={route.params.item?.id || "wallet"}
        navigation={navigation}
        initialItem={route.params.item}
      />
    );
  const Icon = kind === "promote" ? Megaphone : MailOpen;
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={styles.page}
    >
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
        <Icon size={32} color="white" />
      </View>
      <Text style={styles.title}>
        {kind === "promote" ? "Find your audience" : "Your inbox"}
      </Text>
      <Text style={styles.eyebrow}>DESIGN PREVIEW · NOT CONNECTED</Text>
      {kind === "promote" ? (
        <>
          <Text style={styles.body}>
            Sketch the audience for your next creation.
          </Text>
          <Field
            label="Audience or topic"
            value={audience}
            onChangeText={(v) => {
              setAudience(v);
              setSaved(false);
            }}
            maxLength={100}
            placeholder="Electronic music, independent film…"
          />
          <Action
            title="Preview campaign idea"
            disabled={!audience.trim()}
            onPress={() => setSaved(true)}
          />
          {saved && (
            <Notice
              text={`Campaign concept for “${audience.trim()}”. No campaign is running, no audience data is collected, and no money is spent.`}
            />
          )}
          <Notice text="Campaign targeting, ad delivery, budgeting, and attribution are not connected. This is a local planning preview." />
        </>
      ) : (
        <>
          <Text style={styles.body}>
            A place for creator conversations and community updates.
          </Text>
          <Notice text="Direct messaging is not connected yet. You can try the comment sheet on each creation in the sample feed." />
          <Action
            title="Explore creations"
            onPress={() => navigation.navigate("Main")}
          />
        </>
      )}
      <Action
        secondary
        title="Back to Studio"
        onPress={() => navigation.navigate("Studio")}
      />
    </ScrollView>
  );
}
