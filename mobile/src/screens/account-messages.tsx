import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import { Bell, Check, Inbox, RefreshCw, Settings } from "lucide-react-native";
import { Action, Notice } from "../components/ui";
import { useDesktopLayout } from "../components/desktop-layout";
import { workspace, WorkspaceHeading } from "../components/desktop-workspace";
import { useZiipa } from "../provider";
import { isUnreadNotification, notificationMessageTitle } from "../lib/account-messages";
import { notificationStatus } from "../lib/notification-types";
import { useNotificationMessages } from "../lib/use-account-messages";
import type { RootStack } from "../lib/types";
import { color, font, styles } from "../theme";

type Navigation = Pick<NativeStackNavigationProp<RootStack>, "navigate">;
const dateLabel = (value: string) => new Date(value).toLocaleString();

export function InboxScreen({ navigation }: NativeStackScreenProps<RootStack, "Inbox">) {
  return <InboxContent navigation={navigation} />;
}

/** Also used by the older Utility/inbox route; no fabricated conversations. */
export function InboxContent({ navigation }: { navigation: Navigation }) {
  const { desktop } = useDesktopLayout();
  const { session, guest } = useZiipa();
  return <ScrollView style={styles.screen} contentContainerStyle={desktop ? [workspace.page, workspace.narrow] : styles.page}>
    {desktop ? <WorkspaceHeading title="Inbox" description="Your creator conversations." /> : <Text accessibilityRole="header" style={styles.title}>Inbox</Text>}
    <View style={[styles.panel, { alignItems: "center", gap: 15, paddingVertical: 32 }]}>
      <Inbox color={color.muted} size={38} />
      <Text style={[styles.heading, { textAlign: "center" }]}>Direct messages are not available yet</Text>
      <Text style={[styles.body, { textAlign: "center" }]}>Ziipa does not currently have private conversations or connected email. Your calendar, recording and campaign notification receipts have their own page.</Text>
    </View>
    {(!session || guest) && <Notice text="Sign in to see notification receipts for your own Ziipa account." />}
    <Action title="View notifications" icon={Bell} onPress={() => navigation.navigate("NotificationMessages")} />
    <Action secondary title="Explore creations" onPress={() => navigation.navigate("Main")} />
  </ScrollView>;
}

export function NotificationMessagesScreen({ navigation }: NativeStackScreenProps<RootStack, "NotificationMessages">) {
  const { session } = useZiipa();
  return <NotificationMessagesContent key={session?.access_token || "guest"} navigation={navigation} />;
}

function NotificationMessagesContent({ navigation }: { navigation: Navigation }) {
  const { desktop } = useDesktopLayout();
  const { session, guest } = useZiipa();
  const { deliveries, loading, markingId, error, unreadNotifications, refresh, markOpened } = useNotificationMessages();
  const [expanded, setExpanded] = useState<string | null>(null);
  return <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}
    contentContainerStyle={desktop ? [workspace.page, workspace.narrow] : styles.page}>
    {desktop ? <WorkspaceHeading title="Notifications" description="Private updates from your Ziipa activity." />
      : <Text accessibilityRole="header" style={styles.title}>Notifications</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      <Action title="Refresh notifications" secondary icon={RefreshCw} busy={loading} disabled={!!markingId || !session || guest} onPress={() => void refresh()} />
      <Action title="Notification settings" secondary icon={Settings} onPress={() => navigation.navigate("Notifications")} />
    </View>
    {!session || guest ? <Notice text="Sign in to see your private Ziipa notification history. No sample messages are shown." /> : <>
      {!!error && <Notice text={error} error />}
      <Text style={styles.small}>{loading ? "Checking notification history…" : unreadNotifications === null ? "Notification status is unavailable." : `${unreadNotifications} new · latest 100 delivery receipts`}</Text>
      <Text style={styles.small}>A new badge means the push provider accepted an update that you have not opened here. Provider acceptance does not prove it appeared on your device. Queued, failed and unverified deliveries are shown without a new badge.</Text>
      {!loading && !error && deliveries?.length === 0 && <View style={[styles.panel, { alignItems: "center", paddingVertical: 30, gap: 12 }]}>
        <Bell color={color.muted} size={32} /><Text style={styles.heading}>No notifications yet</Text>
        <Text style={[styles.small, { textAlign: "center" }]}>Your calendar, recording and campaign delivery receipts will appear here when they exist. Nothing is sent by opening this page.</Text>
      </View>}
      {deliveries?.map((delivery) => {
        const unread = isUnreadNotification(delivery), open = expanded === delivery.id;
        return <View key={delivery.id} style={[styles.panel, { padding: 0, overflow: "hidden", borderColor: unread ? color.lime : color.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${notificationMessageTitle(delivery)}${unread ? ", new" : ""}. ${open ? "Close" : "Open"} details`}
            accessibilityState={{ expanded: open, disabled: !!markingId }} disabled={!!markingId}
            onPress={() => {
              setExpanded(open ? null : delivery.id);
              if (!open && unread) void markOpened(delivery.id);
            }} style={{ padding: 18, gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Bell color={unread ? color.lime : color.muted} size={20} />
              <Text style={{ flex: 1, color: color.text, fontFamily: font.semibold, fontSize: 16 }}>{notificationMessageTitle(delivery)}</Text>
              {unread && <Text style={{ color: color.lime, fontFamily: font.semibold, fontSize: 12 }}>New</Text>}
            </View>
            <Text style={styles.small}>{notificationStatus(delivery.status)} · {dateLabel(delivery.created_at)}</Text>
          </Pressable>
          {open && <View style={{ padding: 18, paddingTop: 0, gap: 10 }}>
            {!!delivery.detail && <Text style={styles.body}>{delivery.detail}</Text>}
            <Text style={styles.small}>{delivery.provider === "expo" ? "Android / native push" : "Browser push"}{delivery.provider_accepted_at ? ` · provider accepted ${dateLabel(delivery.provider_accepted_at)}` : " · provider acceptance not confirmed"}</Text>
            {!!delivery.opened_at && <Text style={styles.small}>Opened in Ziipa · {dateLabel(delivery.opened_at)}</Text>}
            <Action title={delivery.category === "calendar" ? "View calendar" : delivery.category === "recordings" ? "View recordings" : "View campaigns"} secondary
              disabled={!!markingId} onPress={() => navigation.navigate(delivery.category === "calendar" ? "Calendar" : delivery.category === "recordings" ? "Recordings" : "Campaigns")} />
          </View>}
          {unread && <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}><Action secondary title="Mark as read" icon={Check} busy={markingId === delivery.id}
            disabled={!!markingId && markingId !== delivery.id} onPress={() => void markOpened(delivery.id)} /></View>}
        </View>;
      })}
    </>}
  </ScrollView>;
}
