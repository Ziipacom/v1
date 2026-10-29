import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ArrowLeft, ChartColumn, RefreshCw } from "lucide-react-native";
import { FloatButton } from "../components/floating";
import { Notice } from "../components/ui";
import { useDesktopLayout } from "../components/desktop-layout";
import { useZiipa } from "../provider";
import {
  creationTrend,
  dashboardBars,
  type CreatorInsights,
} from "../lib/creator-dashboard";
import type { RootStack } from "../lib/types";
import {
  audienceNumber,
  type AudienceCounts,
} from "../lib/profile-collections";
import { color, font, styles } from "../theme";

export function DashboardScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Dashboard">) {
  const { session, guest } = useZiipa();
  return (
    <ScopedDashboard
      key={session?.access_token || String(guest)}
      onBack={() => navigation.goBack()}
    />
  );
}

function ScopedDashboard({ onBack }: { onBack: () => void }) {
  const { api, data, session, guest } = useZiipa();
  const { desktop } = useDesktopLayout();
  const [insights, setInsights] = useState<CreatorInsights | null>(null);
  const [audience, setAudience] = useState<{
    ziipa: AudienceCounts;
    networks: {
      provider: string;
      name: string;
      counts: AudienceCounts | null;
    }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [days, setDays] = useState(30);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (session && !guest)
        void api<CreatorInsights>("/api/os/insights")
          .then((value) => {
            if (active) {
              setInsights(value);
              setError("");
            }
          })
          .catch(() => {
            if (active)
              setError(
                "Dashboard metrics could not refresh. Previously loaded totals may be out of date.",
              );
          });
      if (session && !guest)
        void api<typeof audience>("/api/creator/profile/audience")
          .then((value) => {
            if (active) setAudience(value);
          })
          .catch(() => {
            if (active) setAudience(null);
          });
      return () => {
        active = false;
      };
    }, [api, refresh, session?.access_token, guest]),
  );
  const trend = useMemo(
    () => creationTrend(data.drafts, new Date(), days),
    [data.drafts, days, refresh],
  );
  const maximum = Math.max(1, ...trend.map((point) => point.count));
  const audienceSources = audience
    ? [{ name: "Ziipa", counts: audience.ziipa }, ...audience.networks]
    : [];
  const knownAudience = (kind: "followers" | "following") => {
    const values = audienceSources
      .map((source) => audienceNumber(source.counts?.[kind]))
      .filter((value): value is number => value !== null);
    return {
      total: values.reduce((sum, value) => sum + value, 0),
      available: values.length,
      missing: audienceSources.length - values.length,
    };
  };
  const metrics = [
    ["Published", insights?.library.by_visibility.published ?? 0],
    ["Private drafts", insights?.library.by_visibility.draft ?? 0],
    ["Ziipa likes", insights?.engagement.likes],
    ["Ziipa comments", insights?.engagement.comments],
    ["Ziipa saves", insights?.engagement.saves],
    ["Render jobs", insights?.rendering.total],
  ];
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={{
          padding: desktop ? 32 : 20,
          paddingBottom: 48,
          gap: 20,
          maxWidth: 1100,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={styles.between}>
          <FloatButton
            label="Back from Dashboard"
            icon={ArrowLeft}
            plain
            onPress={onBack}
          />
          <View style={styles.row}>
            <ChartColumn color={color.lime} size={22} />
            <Text style={styles.heading}>Dashboard</Text>
          </View>
          <FloatButton
            label="Refresh Dashboard metrics"
            icon={RefreshCw}
            plain
            onPress={() => setRefresh((value) => value + 1)}
          />
        </View>
        <Text style={styles.body}>
          Your creations and recorded performance across Ziipa.
        </Text>
        {!!error && <Notice text={error} />}
        {guest || !session ? (
          <Notice text="Sign in to see your account's real metrics. Sample data is not analytics." />
        ) : (
          <>
            {!insights && !error && <Notice text="Loading your metrics…" />}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {metrics.map(([label, value]) => (
                <View
                  key={String(label)}
                  style={{
                    minWidth: desktop ? 145 : "46%",
                    flexGrow: 1,
                    padding: 16,
                    gap: 7,
                    borderRadius: 14,
                    backgroundColor: color.panel,
                    borderWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <Text style={styles.small}>{label}</Text>
                  <Text style={[styles.heading, { color: color.lime }]}>
                    {insights && typeof value === "number" ? value : "—"}
                  </Text>
                </View>
              ))}
            </View>
            <View style={panel}>
              <Text style={styles.heading}>Creations added</Text>
              <Text style={styles.small}>
                Your saved creations by creation date · UTC · includes drafts
              </Text>
              <View style={styles.row}>
                {[7, 30, 90].map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${value} days of creations`}
                    accessibilityState={{ selected: days === value }}
                    onPress={() => setDays(value)}
                    style={{
                      padding: 10,
                      borderBottomWidth: days === value ? 2 : 0,
                      borderColor: color.lime,
                    }}
                  >
                    <Text
                      style={{
                        color: days === value ? color.lime : color.muted,
                      }}
                    >
                      {value} days
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View
                accessible
                accessibilityLabel={`${trend.reduce((sum, day) => sum + day.count, 0)} creations added in the last ${days} UTC days`}
                style={{
                  height: 140,
                  flexDirection: "row",
                  alignItems: "flex-end",
                  gap: days > 30 ? 1 : 3,
                }}
              >
                {trend.map((point) => (
                  <View
                    key={point.date}
                    accessibilityLabel={`${point.date}: ${point.count} creations`}
                    style={{
                      flex: 1,
                      height: `${Math.max(point.count ? 2 : 0, (point.count / maximum) * 100)}%`,
                      borderRadius: 3,
                      backgroundColor: color.purple,
                    }}
                  />
                ))}
              </View>
              <View style={styles.between}>
                <Text style={styles.small}>{trend[0].date}</Text>
                <Text style={styles.small}>{trend[trend.length - 1].date}</Text>
              </View>
            </View>
            <View style={panel}>
              <Text style={styles.heading}>Combined accounts</Text>
              <Text style={styles.small}>
                Network totals can include the same person more than once. These
                are accounts, not unique people.
              </Text>
              {(["followers", "following"] as const).map((kind) => {
                const summary = knownAudience(kind);
                return (
                  <Text key={kind} style={styles.body}>
                    {kind === "followers"
                      ? "Followers / subscribers"
                      : "Following"}
                    : {summary.available ? summary.total.toLocaleString() : "—"}
                    {summary.missing
                      ? ` · ${summary.missing} network count${summary.missing === 1 ? "" : "s"} unavailable`
                      : ""}
                  </Text>
                );
              })}
              {audienceSources.map((source) => (
                <Text key={source.name} style={styles.small}>
                  {source.name}:{" "}
                  {audienceNumber(source.counts?.followers) ?? "—"} followers ·{" "}
                  {audienceNumber(source.counts?.following) ?? "—"} following
                  {source.counts?.updated_at &&
                  Number.isFinite(Date.parse(source.counts.updated_at))
                    ? ` · Updated ${new Date(source.counts.updated_at).toLocaleString()}`
                    : ""}
                </Text>
              ))}
            </View>
            <Bars title="Media mix" counts={insights?.library.by_category} />
            <Bars
              title="Publishing outcomes"
              counts={insights?.publishing.by_status}
            />
            <Bars
              title="Render job outcomes"
              counts={insights?.rendering.by_status}
            />
            <Notice text="Likes, comments and saves are counts recorded within Ziipa. External views, audience reach, watch time, follower growth and verified revenue are not connected yet. They are unavailable, rather than zero." />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const panel = {
  padding: 18,
  borderRadius: 16,
  backgroundColor: color.panel,
  borderWidth: 1,
  borderColor: color.border,
  gap: 12,
};
function Bars({ title, counts }: { title: string; counts: unknown }) {
  const rows = dashboardBars(counts);
  return (
    <View style={panel}>
      <Text style={styles.heading}>{title}</Text>
      {rows.map((row) => (
        <View key={row.label} style={{ gap: 5 }}>
          <View style={styles.between}>
            <Text style={styles.small}>{row.label.replaceAll("_", " ")}</Text>
            <Text style={{ color: color.text, fontFamily: font.medium }}>
              {row.count}
            </Text>
          </View>
          <View
            accessibilityLabel={`${row.label}: ${row.count}`}
            style={{
              height: 8,
              backgroundColor: color.border,
              borderRadius: 5,
            }}
          >
            <View
              style={{
                width: `${row.percent}%`,
                height: 8,
                borderRadius: 5,
                backgroundColor: color.purple,
              }}
            />
          </View>
        </View>
      ))}
      {!rows.length && (
        <Text style={styles.small}>
          {counts ? "No recorded activity yet." : "Metrics unavailable."}
        </Text>
      )}
    </View>
  );
}
