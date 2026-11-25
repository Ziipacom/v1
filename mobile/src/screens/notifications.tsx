import { useDesktopLayout } from "../components/desktop-layout";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bell,
  Check,
  RefreshCw,
  ShieldCheck,
  Trash2,
  ArrowUpRight,
  Smartphone,
  Monitor,
  Plus,
  Settings2,
  CalendarDays,
  Clapperboard,
  Send,
  Info,
} from "lucide-react-native";
import { Action, Field, IconButton, Notice, Pill } from "../components/ui";
import { Sheet } from "../components/floating";
import { InfoTip } from "../components/info-tip";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { releaseNotes } from "../lib/release-notes";
import { horizontalMouseDrag } from "../lib/horizontal-mouse-drag";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { creatorRequest } from "../lib/creator-request";
import {
  pushCapability,
  registerPushDevice,
  type PushCapability,
} from "../lib/notification-client";
import {
  notificationCategories,
  notificationPreferenceInput,
  notificationProviderReadiness,
  notificationRoot,
  type NotificationCategory,
  type PushConfig,
  type PushDelivery,
  type PushDevice,
  type PushPreferences,
} from "../lib/notification-types";
import type { RootStack } from "../lib/types";
import { color, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Notifications">;

export function notificationScreenError(cause: unknown, loading = false) {
  const error = cause as { status?: number; outcome?: string } | null;
  if (error?.outcome === "unconfirmed")
    return "This change was not confirmed. Refresh its status before trying again.";
  if (error?.status === 401) return "Sign in again to view your updates.";
  if (error?.status === 403)
    return "This notification action is unavailable for your account.";
  if (error?.status === 404)
    return "This update or device is no longer available. Refresh to check.";
  if (error?.status === 409)
    return "Your preferences changed. Refresh before saving again.";
  if (error?.status === 429) return "Please wait a moment before trying again.";
  if (error?.status === 503)
    return "Device notifications are unavailable right now. In-app updates remain available.";
  return loading
    ? "Updates could not be loaded. Refresh to try again."
    : "That change could not be completed. Refresh and try again.";
}
export function notificationScreenStatus(status: string) {
  const labels: Record<string, string> = {
    pending: "Queued",
    queued: "Queued",
    sending: "Sending",
    accepted: "Sent to service",
    provider_accepted: "Sent to service",
    delivered: "Delivery receipt",
    opened: "Opened",
    failed: "Not sent",
    blocked: "Blocked",
    disabled: "Off",
    revoked: "Removed",
    active: "Registered",
    uncertain: "Not confirmed",
    skipped: "Not sent",
  };
  return labels[status] || "Status unavailable";
}
function NotificationState({
  label,
  active = false,
}: {
  label: string;
  active?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: active ? color.lime : color.muted,
        }}
      />
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

function Consent({
  text,
  checked,
  disabled,
  onPress,
}: {
  text: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={text}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, { gap: 12, paddingVertical: 10 }]}
    >
      <View
        style={{
          width: 25,
          height: 25,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: checked ? color.purple : color.border,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: checked ? color.purple : "transparent",
        }}
      >
        {checked && <Check color="white" size={18} />}
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{text}</Text>
    </Pressable>
  );
}
export function NotificationsScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedNotificationsScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.deliveryId || ""}`}
      {...props}
    />
  );
}
function ScopedNotificationsScreen({ navigation, route }: Props) {
  const { desktop } = useDesktopLayout();
  const { session, guest, api } = useZiipa();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const capture = useOperationScope(
    session?.access_token || "guest",
    focused && foreground,
  );
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [capability, setCapability] = useState<PushCapability | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [deliveries, setDeliveries] = useState<PushDelivery[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [categories, setCategories] = useState<NotificationCategory[]>([]);
  const [accountConsent, setAccountConsent] = useState(false);
  const [deviceConsent, setDeviceConsent] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<
    "Activity" | "Preferences" | "Devices" | "App"
  >(route.params?.deliveryId ? "Activity" : route.params?.tab || "Activity");
  useEffect(() => {
    if (route.params?.deliveryId) setTab("Activity");
    else if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.deliveryId, route.params?.tab]);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const tabsScroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !focused) return;
    const node = tabsScroll.current?.getScrollableNode() as HTMLElement | null;
    return node ? horizontalMouseDrag(node) : undefined;
  }, [focused]);
  const mutation = useRef(false);
  const loading = useRef(false);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) => {
      if (value === "active") setForeground(true);
      else if (value === "background" || Platform.OS === "web")
        setForeground(false);
    });
    return () => listener.remove();
  }, []);
  const load = useCallback(async () => {
    if (!session || guest || mutation.current || loading.current) return;
    loading.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    try {
      if (route.params?.deliveryId) {
        try {
          await api(
            `${notificationRoot}/deliveries/${route.params.deliveryId}/opened`,
            {},
          );
        } catch {
          if (valid())
            setMessage(
              "This update is unavailable. You can still manage your notifications below.",
            );
        }
        if (!valid()) return;
      }
      const [configuration, settings, installed, receipts, supported] =
        await Promise.all([
          api<PushConfig>(`${notificationRoot}/config`),
          api<PushPreferences>(`${notificationRoot}/preferences`),
          api<PushDevice[]>(`${notificationRoot}/devices`),
          api<PushDelivery[]>(`${notificationRoot}/deliveries`),
          pushCapability(),
        ]);
      if (!valid()) return;
      setConfig(configuration);
      setPreferences(settings);
      setDevices(installed);
      setDeliveries(receipts);
      setCapability(supported);
      setEnabled(settings.enabled);
      setCategories(settings.categories);
      setAccountConsent(false);
      setDeviceConsent(false);
    } catch (cause) {
      if (valid()) setError(notificationScreenError(cause, true));
    } finally {
      loading.current = false;
      setBusy(false);
    }
  }, [api, capture, guest, route.params?.deliveryId, session]);
  useEffect(() => {
    if (focused && foreground) void load();
  }, [focused, foreground, load]);
  async function mutate(action: (valid: () => boolean) => Promise<void>) {
    if (busy || mutation.current || loading.current || !session) return;
    mutation.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action(valid);
    } catch (cause) {
      if (valid()) setError(notificationScreenError(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function save(valid: () => boolean) {
    if (!preferences || !session) return;
    const fields = notificationPreferenceInput(
      enabled,
      categories,
      preferences.revision,
      accountConsent,
    );
    const result = await creatorRequest<PushPreferences>(
      `${notificationRoot}/preferences`,
      session.access_token,
      "PUT",
      fields,
    );
    if (!valid()) return;
    setPreferences(result);
    setEnabled(result.enabled);
    setCategories(result.categories);
    setAccountConsent(false);
    setMessage(
      result.enabled
        ? "Preferences saved. Enable each device separately."
        : "Account notifications are off.",
    );
  }
  async function register(valid: () => boolean) {
    if (!config || !deviceConsent || !preferences?.enabled)
      throw new Error(
        "Enable your account preferences and explicitly consent to register this device first.",
      );
    const registration = await registerPushDevice(config, label, valid);
    if (!valid()) return;
    const device = await api<PushDevice>(
      `${notificationRoot}/devices`,
      registration,
    );
    if (!valid()) return;
    const supported = await pushCapability();
    if (!valid()) return;
    setDevices((previous) => [
      device,
      ...previous.filter((entry) => entry.id !== device.id),
    ]);
    setCapability(supported);
    setDeviceConsent(false);
    setMessage("Device registered with Ziipa.");
    setEnrollmentOpen(false);
  }
  if (!session || guest)
    return (
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.page}
      >
        <Notice text="Sign in to manage your notifications and registered devices." />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </ScrollView>
    );
  const deviceReady = !!(
    config?.enabled &&
    config.worker_ready &&
    (Platform.OS === "web" ? config.web_ready : config.expo_ready)
  );
  const blockedReason = !capability
    ? "Checking notification support…"
    : !capability.supported
      ? "Notifications are unavailable on this device."
      : capability.permission === "denied"
        ? "Allow notifications in your device or browser settings before enabling them here."
        : !preferences?.enabled
          ? "Turn on and save account notifications in Preferences first."
          : !deviceReady
            ? "Device notifications are unavailable right now. Your activity remains in Ziipa."
            : "";
  const permission =
    capability?.permission === "granted"
      ? "Allowed"
      : capability?.permission === "denied"
        ? "Blocked"
        : capability?.permission === "default" ||
            capability?.permission === "undetermined"
          ? "Not enabled"
          : capability?.permission === "unavailable"
            ? "Unavailable"
            : "Checking...";
  const appVersion =
    Application.nativeApplicationVersion ||
    Constants.expoConfig?.version ||
    null;
  const appBuild = Application.nativeBuildVersion;
  const platformName =
    Platform.OS === "ios"
      ? "iOS"
      : Platform.OS === "android"
        ? "Android"
        : "Web";
  const panel = [styles.panel, { padding: 16, borderRadius: 16, gap: 14 }];
  const registered = devices.filter((device) => device.status !== "revoked");
  const unread = deliveries.filter((delivery) => !delivery.opened_at).length;
  const accountPanel = (
    <View style={[...panel, { maxWidth: 760 }]}>
      <View style={styles.between}>
        <Text style={[styles.heading, { fontSize: 19 }]}>Preferences</Text>
        <InfoTip
          title="Your notification choices"
          content="Choose the updates Ziipa may send. Saving an opt-in requires your consent. Each device also needs its own registration and system permission; turning this account setting off does not change that system permission."
        />
      </View>
      <Consent
        text="Account notifications"
        checked={enabled}
        disabled={busy}
        onPress={() => {
          setEnabled(!enabled);
          setAccountConsent(false);
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {notificationCategories.map((category) => (
          <View
            key={category}
            style={{ flexGrow: 1, flexBasis: "45%", minWidth: 140 }}
          >
            <Consent
              text={
                category === "calendar"
                  ? "Calendar reminders"
                  : category === "recordings"
                    ? "Recordings & clips"
                    : "Publishing updates"
              }
              checked={categories.includes(category)}
              disabled={busy}
              onPress={() => {
                setCategories((previous) =>
                  previous.includes(category)
                    ? previous.filter((value) => value !== category)
                    : [...previous, category],
                );
                setAccountConsent(false);
              }}
            />
          </View>
        ))}
      </View>
      {enabled && (
        <Consent
          text="I agree to receive these selected updates."
          checked={accountConsent}
          disabled={busy}
          onPress={() => setAccountConsent(!accountConsent)}
        />
      )}
      <View style={{ alignSelf: "flex-start" }}>
        <Action
          title="Save preferences"
          icon={ShieldCheck}
          disabled={
            busy ||
            !preferences ||
            (enabled && (!accountConsent || !categories.length))
          }
          onPress={() => void mutate(save)}
        />
      </View>
    </View>
  );
  const enrollment = (
    <>
      <View style={styles.between}>
        <Text style={[styles.heading, { fontSize: 19 }]}>{platformName}</Text>
        <NotificationState
          label={permission}
          active={capability?.permission === "granted"}
        />
      </View>
      {blockedReason ? <Notice text={blockedReason} /> : null}
      <InfoTip
        title="Enable this device"
        content="Ziipa asks for system permission only after you choose Enable on this device. Account preferences, registration and system permission are separate. Removing a registration stops future Ziipa notifications to that device and does not change its system settings."
      />
      {!preferences?.enabled && (
        <View style={{ alignSelf: "flex-start" }}>
          <Action
            secondary
            title="Choose preferences"
            icon={Settings2}
            onPress={() => {
              setEnrollmentOpen(false);
              setTab("Preferences");
            }}
          />
        </View>
      )}
      <Field
        label="Device name"
        help="Optional: a name to recognise this phone or browser."
        value={label}
        onChangeText={setLabel}
        maxLength={60}
        editable={!busy}
        placeholder="My phone"
      />
      <Consent
        text="Enable notifications and register this device with my Ziipa account."
        checked={deviceConsent}
        disabled={busy}
        onPress={() => setDeviceConsent(!deviceConsent)}
      />
      <View style={{ alignSelf: "flex-start" }}>
        <Action
          title="Enable on this device"
          icon={Bell}
          disabled={
            busy ||
            !deviceConsent ||
            capability?.permission === "denied" ||
            !preferences?.enabled ||
            !capability?.supported ||
            !deviceReady
          }
          onPress={() => void mutate(register)}
        />
      </View>
    </>
  );
  const devicesPanel = (
    <View style={panel}>
      <View style={styles.between}>
        <View>
          <Text style={[styles.heading, { fontSize: 19 }]}>Devices</Text>
          <Text style={styles.small}>
            {preferences
              ? `${registered.length} registered`
              : error
                ? "Unavailable"
                : "Checking devices"}
          </Text>
        </View>
        <IconButton
          icon={Plus}
          label="Set up this device"
          disabled={busy}
          onPress={() => setEnrollmentOpen(true)}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderColor: color.border,
        }}
      >
        {Platform.OS === "web" ? (
          <Monitor size={22} color={color.text} />
        ) : (
          <Smartphone size={22} color={color.text} />
        )}
        <View style={{ flex: 1 }}>
          <Text style={[styles.body, { color: color.text }]}>
            {platformName} · this device
          </Text>
          <NotificationState
            label={permission}
            active={capability?.permission === "granted"}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage this device notifications"
          onPress={() => setEnrollmentOpen(true)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={[styles.small, { color: color.text }]}>Manage</Text>
        </Pressable>
      </View>
      {!devices.length && (
        <View style={{ alignItems: "center", gap: 8, paddingVertical: 24 }}>
          <Smartphone size={27} color={color.muted} />
          <Text style={[styles.body, { color: color.text }]}>
            {preferences
              ? "No devices registered"
              : error
                ? "Devices unavailable"
                : "Checking devices"}
          </Text>
          <Text style={styles.small}>
            Use + to enable this phone or browser.
          </Text>
        </View>
      )}
      {devices.map((device) => (
        <View
          key={device.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderColor: color.border,
          }}
        >
          {device.provider === "web" ? (
            <Monitor size={21} color={color.muted} />
          ) : (
            <Smartphone size={21} color={color.muted} />
          )}
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text
              numberOfLines={1}
              style={[styles.body, { color: color.text }]}
            >
              {device.label || "Unnamed device"}
            </Text>
            <NotificationState
              label={notificationScreenStatus(device.status)}
              active={device.status === "active"}
            />
            <Text style={styles.small}>
              {new Date(device.last_registered_at).toLocaleDateString()}
            </Text>
          </View>
          <IconButton
            icon={Trash2}
            label={`Remove ${device.label || "device"}`}
            disabled={busy || device.status === "revoked"}
            onPress={() =>
              void mutate(async (valid) => {
                await creatorRequest(
                  `${notificationRoot}/devices/${device.id}?revision=${device.revision}`,
                  session.access_token,
                  "DELETE",
                );
                if (valid()) {
                  setDevices((previous) =>
                    previous.map((value) =>
                      value.id === device.id
                        ? { ...value, status: "revoked" }
                        : value,
                    ),
                  );
                  setMessage("Device removed from Ziipa.");
                }
              })
            }
          />
        </View>
      ))}
      <InfoTip
        title="Registered devices"
        content="A registered device has permission to receive selected Ziipa updates. Registration does not confirm a notification was displayed. Removing a device stops future sends; manage its system permission in the phone or browser settings."
      />
    </View>
  );
  const receiptsPanel = (
    <View style={panel}>
      <View style={styles.between}>
        <View>
          <Text style={[styles.heading, { fontSize: 19 }]}>Recent updates</Text>
          <Text style={styles.small}>
            {preferences
              ? `${unread} unopened`
              : error
                ? "Unavailable"
                : "Checking updates"}
          </Text>
        </View>
        <InfoTip
          title="Delivery status"
          content="Queued, sent to service and device display are different stages. A provider receipt or accepted status does not prove a notification appeared on your device. Open an update to review its related Ziipa activity."
        />
      </View>
      {!deliveries.length && (
        <View style={{ alignItems: "center", gap: 8, paddingVertical: 28 }}>
          <Bell size={29} color={color.muted} />
          <Text style={[styles.body, { color: color.text }]}>
            {error ? "Updates unavailable" : "You're up to date"}
          </Text>
          <Text style={styles.small}>
            {error
              ? "Refresh to check again."
              : "New reminders and creation updates appear here."}
          </Text>
        </View>
      )}
      {deliveries.map((delivery) => {
        const Icon =
          delivery.category === "calendar"
            ? CalendarDays
            : delivery.category === "recordings"
              ? Clapperboard
              : Send;
        const title =
          delivery.category === "calendar"
            ? "Calendar reminder"
            : delivery.category === "recordings"
              ? "Recording update"
              : "Publishing update";
        return (
          <View
            key={delivery.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 13,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            <Icon size={21} color={color.muted} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text style={[styles.body, { color: color.text }]}>{title}</Text>
              <NotificationState
                label={
                  delivery.opened_at
                    ? "Opened"
                    : notificationScreenStatus(delivery.status)
                }
                active={!!delivery.opened_at}
              />
              <Text style={styles.small}>
                {new Date(delivery.created_at).toLocaleString()} ·{" "}
                {delivery.provider === "web" ? "Browser" : "App"}
              </Text>
            </View>
            <InfoTip
              title={title}
              content={`Created ${new Date(delivery.created_at).toLocaleString()}.${delivery.provider_accepted_at ? ` Accepted by delivery service ${new Date(delivery.provider_accepted_at).toLocaleString()}.` : ""}${delivery.opened_at ? ` Opened in Ziipa ${new Date(delivery.opened_at).toLocaleString()}.` : ""} Delivery status does not confirm device display.`}
            />
            {!delivery.opened_at && (
              <IconButton
                icon={ArrowUpRight}
                label="Open update"
                disabled={busy}
                onPress={() =>
                  void mutate(async (valid) => {
                    await api(
                      `${notificationRoot}/deliveries/${delivery.id}/opened`,
                      {},
                    );
                    if (valid())
                      navigation.navigate(
                        delivery.category === "calendar"
                          ? "Calendar"
                          : delivery.category === "recordings"
                            ? "Recordings"
                            : "Campaigns",
                      );
                  })
                }
              />
            )}
          </View>
        );
      })}
    </View>
  );
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={[
        styles.page,
        { width: "100%", maxWidth: 1080, alignSelf: "center", gap: 16 },
        desktop && { paddingHorizontal: 28 },
      ]}
    >
      <View style={styles.between}>
        <View>
          <Text style={[styles.heading, { fontSize: desktop ? 26 : 20 }]}>
            Notifications & devices
          </Text>
          <Text style={styles.small}>Your private updates</Text>
        </View>
        <IconButton
          label="Refresh notifications"
          icon={RefreshCw}
          disabled={busy}
          onPress={() => void load()}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        <NotificationState
          label={
            preferences
              ? `Account ${preferences.enabled ? "on" : "off"}`
              : "Checking account"
          }
          active={!!preferences?.enabled}
        />
        <Text style={styles.small}>
          {preferences ? `${registered.length} devices` : "Checking devices"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Notification service status"
          onPress={() => setServiceOpen(true)}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Info size={18} color={color.muted} />
        </Pressable>
      </View>
      <ScrollView
        ref={tabsScroll}
        horizontal
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="handled"
        style={{ width: "100%", flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
      >
        {(["Activity", "Devices", "Preferences", "App"] as const).map(
          (value) => (
            <Pill
              key={value}
              title={value}
              active={tab === value}
              onPress={() => setTab(value)}
            />
          ),
        )}
      </ScrollView>
      {!!error && !enrollmentOpen && !serviceOpen && (
        <Notice error text={error} />
      )}
      {!!message && <Notice text={message} />}
      {tab === "Activity" ? receiptsPanel : null}
      {tab === "Preferences" ? accountPanel : null}
      {tab === "Devices" ? devicesPanel : null}
      {tab === "App" && (
        <View style={panel}>
          <View style={styles.between}>
            <Text style={[styles.heading, { fontSize: 19 }]}>Ziipa</Text>
            <InfoTip
              title="Version notes"
              content={releaseNotes
                .map(
                  (release) =>
                    `Ziipa ${release.version}\n${release.changes.join("\n")}`,
                )
                .join("\n\n")}
            />
          </View>
          <View style={styles.between}>
            <Text style={styles.small}>Version</Text>
            <Text style={[styles.body, { color: color.text }]}>
              {appVersion || "Not available"}
              {appBuild ? ` (${appBuild})` : ""}
            </Text>
          </View>
          <View style={styles.between}>
            <Text style={styles.small}>Platform</Text>
            <Text style={[styles.body, { color: color.text }]}>
              {platformName}
              {Platform.OS !== "web" ? ` · ${String(Platform.Version)}` : ""}
            </Text>
          </View>
        </View>
      )}
      {enrollmentOpen && (
        <Sheet
          title="Enable this device"
          onClose={() => setEnrollmentOpen(false)}
          maxWidth={560}
        >
          {!!error && <Notice error text={error} />}
          {enrollment}
        </Sheet>
      )}
      {serviceOpen && (
        <Sheet
          title="Notification status"
          onClose={() => setServiceOpen(false)}
          maxWidth={560}
        >
          <NotificationState
            label={
              deviceReady
                ? "Device notifications available"
                : "Device notifications unavailable"
            }
            active={deviceReady}
          />
          <Text style={styles.small}>In-app updates remain available.</Text>
          {config ? (
            <View style={{ gap: 12 }}>
              <View style={styles.between}>
                <Text style={styles.small}>Account service</Text>
                <Text style={styles.small}>
                  {config.enabled ? "On" : "Off"}
                </Text>
              </View>
              <View style={styles.between}>
                <Text style={styles.small}>App delivery</Text>
                <Text style={styles.small}>
                  {notificationProviderReadiness(config, "expo")}
                </Text>
              </View>
              <View style={styles.between}>
                <Text style={styles.small}>Browser delivery</Text>
                <Text style={styles.small}>
                  {notificationProviderReadiness(config, "web")}
                </Text>
              </View>
            </View>
          ) : (
            <Text style={styles.small}>Refresh to load availability.</Text>
          )}
          <InfoTip
            title="What availability means"
            content="Account settings, device permission and registration are separate. Sending to a delivery service does not confirm a notification appeared. Ziipa never starts a camera, broadcast or publication when you enable notifications."
          />
        </Sheet>
      )}
    </ScrollView>
  );
}
