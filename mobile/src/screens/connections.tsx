import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Check, Link2, RefreshCw, Unlink } from "lucide-react-native";
import { Action, Notice } from "../components/ui";
import { useZiipa } from "../provider";
import { socialProvider } from "../lib/social";
import type { RootStack, SocialConnection, SocialProvider } from "../lib/types";
import { color, font, styles } from "../theme";

export function ConnectionsScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Connections">) {
  const { guest, data, api, refresh } = useZiipa();
  const [connections, setConnections] = useState(data.connections);
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setConnections(data.connections), [data.connections]);
  async function change(connection: SocialConnection) {
    setError("");
    setNotice("");
    const next = connection.status === "connected" ? "disconnect" : "connect";
    if (guest) {
      setConnections((current) =>
        current.map((item) =>
          item.provider === connection.provider
            ? {
                ...item,
                status:
                  next === "connect"
                    ? ("connected" as const)
                    : ("disconnected" as const),
                handle: next === "connect" ? `@ziipa.${item.provider}` : "",
              }
            : item,
        ),
      );
      setNotice(
        next === "connect"
          ? `${connection.name} added to this sample workspace.`
          : `${connection.name} removed from this sample workspace.`,
      );
      return;
    }
    setBusy(connection.provider);
    try {
      const result = await api<SocialConnection>(
        `/api/creator/connections/${connection.provider}`,
        { action: next },
      );
      setConnections((current) =>
        current.map((item) =>
          item.provider === result.provider ? result : item,
        ),
      );
      await refresh();
      setNotice(`${connection.name} disconnected from Ziipa.`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={[styles.page, { paddingBottom: 48 }]}
    >
      <View style={{ gap: 7 }}>
        <Text style={styles.eyebrow}>CREATOR NETWORK</Text>
        <Text style={styles.title}>One studio. Every channel.</Text>
        <Text style={styles.body}>
          Link the accounts you publish with, choose destinations per creation,
          and follow every delivery from Ziipa.
        </Text>
      </View>
      {guest && (
        <Notice text="Sample connections are interactive and reset with the preview. Live accounts use provider OAuth and require approved Ziipa developer credentials." />
      )}
      {!!notice && <Notice text={notice} />}
      {!!error && <Notice text={error} error />}
      <View style={{ gap: 11 }}>
        {connections.map((connection) => {
          const provider = socialProvider(connection.provider);
          const connected = connection.status === "connected";
          return (
            <View key={connection.provider} style={styles.panel}>
              <View style={styles.between}>
                <View style={[styles.row, { flex: 1 }]}>
                  <View
                    style={{
                      width: 45,
                      height: 45,
                      borderRadius: 23,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: provider.color,
                      borderWidth: 1,
                      borderColor: "#FFFFFF55",
                    }}
                  >
                    <Text style={{ color: "white", fontFamily: font.bold }}>
                      {provider.short}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.heading, { fontSize: 18 }]}>
                      {connection.name}
                    </Text>
                    <Text style={styles.small}>
                      {connected && connection.handle
                        ? connection.handle
                        : connection.capability}
                    </Text>
                  </View>
                </View>
                {connected && <Check size={19} color={color.lime} />}
              </View>
              <Text style={[styles.small, { color: color.faint }]}>
                {provider.formats}
              </Text>
              <Action
                title={connected ? "Disconnect" : "Connect account"}
                icon={connected ? Unlink : Link2}
                secondary={connected}
                busy={busy === connection.provider}
                onPress={() => void change(connection)}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.panel}>
        <Text style={[styles.heading, { fontSize: 20 }]}>
          Ziipa media library
        </Text>
        <Text style={styles.small}>
          Your original creation remains in Ziipa with its edit settings and
          selected destinations.
        </Text>
        {data.drafts.length ? (
          data.drafts.slice(0, 12).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${item.title}`}
              onPress={() => navigation.navigate("Composer", { item })}
              style={{
                gap: 7,
                paddingVertical: 10,
                borderTopWidth: 1,
                borderColor: color.border,
              }}
            >
              <View style={styles.between}>
                <Text
                  numberOfLines={1}
                  style={[styles.label, { flex: 1, marginBottom: 0 }]}
                >
                  {item.title}
                </Text>
                <Text style={styles.eyebrow}>
                  {item.visibility === "published" ? "LIVE" : "DRAFT"}
                </Text>
              </View>
              <View style={[styles.row, { flexWrap: "wrap", gap: 6 }]}>
                <View style={connectionStyle.destination}>
                  <Text style={connectionStyle.destinationText}>ZIIPA</Text>
                </View>
                {item.distribution_targets?.map((provider) => (
                  <View key={provider} style={connectionStyle.destination}>
                    <Text style={connectionStyle.destinationText}>
                      {socialProvider(provider).short}
                    </Text>
                  </View>
                ))}
              </View>
            </Pressable>
          ))
        ) : (
          <Text style={styles.small}>Create media to start your library.</Text>
        )}
      </View>
      <View style={styles.panel}>
        <View style={styles.between}>
          <Text style={[styles.heading, { fontSize: 20 }]}>
            Delivery center
          </Text>
          <RefreshCw size={19} color={color.muted} />
        </View>
        {data.distributions.length ? (
          data.distributions.map((job) => (
            <Pressable
              key={job.id}
              accessibilityRole="button"
              onPress={() => navigation.navigate("Studio", { edit: true })}
              style={{ gap: 3, paddingVertical: 5 }}
            >
              <Text style={styles.label}>
                {socialProvider(job.provider).short} ·{" "}
                {job.status.replaceAll("_", " ").toUpperCase()}
              </Text>
              <Text style={styles.small}>{job.detail || job.status}</Text>
            </Pressable>
          ))
        ) : (
          <Text style={styles.small}>
            Published destinations and delivery status will appear here.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const connectionStyle = {
  destination: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#2D1749",
    borderWidth: 1,
    borderColor: "#503470",
  },
  destinationText: {
    color: "#DCCBEE",
    fontFamily: font.semibold,
    fontSize: 9,
    letterSpacing: 0.7,
  },
};
