import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import {
  CalendarDays,
  Check,
  Link2,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { Sheet } from "./floating";
import { Action, Field, Notice } from "./ui";
import { color, font, styles } from "../theme";
import type { CalendarEvent } from "../lib/calendar-types";
import { validateOrigin } from "../lib/config";
import { calendarAuthorizationUrl } from "../lib/calendar-connections";

const root = "/api/os/calendar/connections";
type Connection = {
  id: string;
  provider: "google" | "microsoft";
  selected: boolean;
  calendar_name: string;
  last_sync_at: string | null;
};
type RemoteEvent = {
  id: string;
  connection_id: string;
  revision: number;
  title: string;
  notes: string;
  starts_at: string;
  ends_at: string;
  editable: boolean;
  all_day: boolean;
};
type State = {
  providers: {
    provider: string;
    ready: boolean;
    requirements: string[];
    testing_only?: boolean;
  }[];
  connections: Connection[];
  events: RemoteEvent[];
  device_snapshots?: { id: string; calendar_name: string; synced_at: string }[];
};
const labels: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Outlook / Microsoft Teams",
  device: "iOS / device calendars",
};

/** Explicit connection consent; loading this page never starts calendar access. */
export function CalendarConnections({
  events,
  onChanged,
}: {
  events: CalendarEvent[];
  onChanged?: () => void;
}) {
  const { session, guest } = useZiipa();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Connect external calendar"
        accessibilityState={{ disabled: !session || guest }}
        disabled={!session || guest}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: 44,
          paddingHorizontal: 13,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.panel,
          opacity: !session || guest || pressed ? 0.6 : 1,
        })}
      >
        <Link2 size={18} color={color.lime} />
        <Text
          style={{ fontFamily: font.medium, color: color.text, fontSize: 13 }}
        >
          Connect
        </Text>
        <Plus size={14} color={color.text} />
      </Pressable>
      {open && session && (
        <ConnectionPanel
          key={session.access_token}
          events={events}
          onClose={() => {
            setOpen(false);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

function ConnectionPanel({
  events,
  onClose,
}: {
  events: CalendarEvent[];
  onClose: () => void;
}) {
  const { api } = useZiipa();
  const [state, setState] = useState<State | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [exporting, setExporting] = useState<{
    connection: Connection;
    occurrence: string;
    title: string;
  } | null>(null);
  const [editing, setEditing] = useState<RemoteEvent | null>(null);
  const mounted = useRef(true);
  const gate = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    const result = await api<State>(root);
    if (mounted.current) setState(result);
  }
  async function run(work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "Calendar request could not be completed.",
        );
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    void run(load);
  }, []);
  const connection = state?.connections.find(
    (row) => row.provider === provider,
  );
  async function connect() {
    const result = await api<{
      auth_url: string | null;
      portal_url?: string;
      detail?: string;
    }>(root + "/oauth/" + provider + "/start", {});
    if (!mounted.current) return;
    const value = result.auth_url || result.portal_url;
    if (!value)
      throw new Error(
        result.detail || "Calendar authorization could not start.",
      );
    const target = calendarAuthorizationUrl(value, validateOrigin());
    if (result.detail) setNotice(result.detail);
    await Linking.openURL(target);
  }
  async function chooseCalendar() {
    if (!connection) return;
    const result = await api<{ calendars: { id: string; name: string }[] }>(
      root + "/" + connection.id + "/calendars",
    );
    if (mounted.current) setChoices(result.calendars);
  }
  return (
    <Sheet title="Connect calendars" onClose={onClose} maxWidth={720}>
      <Text style={styles.small}>
        Choose an account and calendar. Sync imports event titles, notes and
        times into your private Ziipa account. Calendar exports and edits
        require your review. No guests are invited or media published.
      </Text>
      {error ? <Notice error text={error} /> : null}
      {notice ? <Notice text={notice} /> : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text style={styles.small}>Calendar accounts</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh calendar connections"
          disabled={busy}
          onPress={() => void run(load)}
          style={{ padding: 10 }}
        >
          {busy ? (
            <ActivityIndicator color={color.lime} />
          ) : (
            <RefreshCw size={19} color={color.lime} />
          )}
        </Pressable>
      </View>
      {["google", "microsoft", "device"].map((name) => {
        const linked = state?.connections.find((row) => row.provider === name);
        const configured = state?.providers.find(
          (row) => row.provider === name,
        )?.ready;
        return (
          <View
            key={name}
            style={{
              borderWidth: 1,
              borderColor: color.border,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={labels[name]}
              accessibilityState={{ expanded: provider === name }}
              disabled={busy}
              onPress={() => {
                setProvider(provider === name ? null : name);
                setChoices([]);
                setExporting(null);
                setEditing(null);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                padding: 14,
              }}
            >
              <CalendarDays
                size={21}
                color={provider === name ? color.lime : color.text}
              />
              <View style={{ flex: 1, gap: 3 }}>
                <Text
                  style={{
                    color: color.text,
                    fontFamily: font.medium,
                    fontSize: 14,
                  }}
                >
                  {labels[name]}
                </Text>
                <Text style={styles.small}>
                  {name === "device"
                    ? Platform.OS === "web"
                      ? "Connect from the Ziipa mobile app"
                      : "Device permission required"
                    : linked
                      ? linked.calendar_name || "Choose a calendar"
                      : configured
                        ? "Not connected"
                        : "Setup required"}
                </Text>
              </View>
              {linked ? (
                <Check size={16} color={color.lime} />
              ) : (
                <Plus size={16} color={color.muted} />
              )}
            </Pressable>
            {provider === name && (
              <View style={{ padding: 14, paddingTop: 0, gap: 12 }}>
                {name === "device" ? (
                  <DeviceCalendarPanel events={events} />
                ) : (
                  <>
                    {name === "microsoft" && (
                      <Text style={styles.small}>
                        Teams meetings use the calendar belonging to your
                        Microsoft 365 / Outlook account. Creating Teams meeting
                        links needs separate provider setup.
                      </Text>
                    )}
                    {!configured && (
                      <Notice text="Ziipa’s operator still needs to configure this provider’s calendar OAuth app and callback. Your account has not been connected. No passwords or API keys should be entered here." />
                    )}
                    {configured && (
                      <Notice
                        text={
                          state?.providers.find(
                            (item) => item.provider === name,
                          )?.testing_only
                            ? name === "google"
                              ? "This Google connection is in private provider testing. Only approved Google test accounts can authorize it; public availability still needs Google review."
                              : "This Microsoft connection is in provider testing. Publisher verification or your organization’s policies may prevent authorization. Each user must authorize their own calendar."
                            : "Authorize only the calendar access you want to use. You can disconnect later."
                        }
                      />
                    )}
                    {configured && (
                      <Action
                        secondary
                        title={
                          linked
                            ? "Reconnect account"
                            : "Authorize calendar access"
                        }
                        disabled={busy}
                        onPress={() => void run(connect)}
                      />
                    )}
                    {linked && (
                      <>
                        <Action
                          secondary
                          title={
                            linked.selected
                              ? "Change calendar"
                              : "Choose a calendar"
                          }
                          disabled={busy}
                          onPress={() => void run(chooseCalendar)}
                        />
                        {choices.map((choice) => (
                          <Action
                            key={choice.id}
                            secondary
                            title={choice.name}
                            disabled={busy}
                            onPress={() =>
                              void run(async () => {
                                await api(root + "/" + linked.id + "/select", {
                                  calendar_id: choice.id,
                                });
                                if (mounted.current) setChoices([]);
                                await load();
                              })
                            }
                          />
                        ))}
                        {linked.selected && (
                          <>
                            <Text style={styles.small}>
                              {linked.last_sync_at
                                ? "Last synced " +
                                  new Date(linked.last_sync_at).toLocaleString()
                                : "Not synced yet"}{" "}
                              · Sync now covers the last 30 and next 90 days.
                              Background sync is not enabled.
                            </Text>
                            <Action
                              title="Sync now"
                              icon={RefreshCw}
                              disabled={busy}
                              onPress={() =>
                                void run(async () => {
                                  const result = await api<{ detail: string }>(
                                    root + "/" + linked.id + "/sync",
                                    {},
                                  );
                                  await load();
                                  if (mounted.current) setNotice(result.detail);
                                })
                              }
                            />
                            <Text style={styles.small}>
                              Add a Ziipa event to {linked.calendar_name}
                            </Text>
                            {events
                              .filter((event) => event.status === "active")
                              .slice(0, 30)
                              .map((event) => {
                                const next = event.occurrences.find(
                                  (item) =>
                                    item.status !== "cancelled" &&
                                    Date.parse(item.starts_at) > Date.now(),
                                );
                                return next ? (
                                  <Action
                                    key={event.id}
                                    secondary
                                    title={event.title}
                                    disabled={busy}
                                    onPress={() =>
                                      setExporting({
                                        connection: linked,
                                        occurrence: next.id,
                                        title: event.title,
                                      })
                                    }
                                  />
                                ) : null;
                              })}
                            {state?.events
                              .filter(
                                (event) => event.connection_id === linked.id,
                              )
                              .slice(0, 100)
                              .map((event) => (
                                <View
                                  key={event.id}
                                  style={{
                                    gap: 5,
                                    paddingVertical: 10,
                                    borderTopWidth: 1,
                                    borderTopColor: color.border,
                                  }}
                                >
                                  <Text
                                    style={{
                                      color: color.text,
                                      fontFamily: font.medium,
                                    }}
                                  >
                                    {event.title}
                                  </Text>
                                  <Text style={styles.small}>
                                    {new Date(event.starts_at).toLocaleString()}
                                  </Text>
                                  {event.editable && !event.all_day ? (
                                    <Action
                                      secondary
                                      title="Edit calendar event"
                                      disabled={busy}
                                      onPress={() => setEditing(event)}
                                    />
                                  ) : (
                                    <Text style={styles.small}>
                                      Edit meetings with guests, recurring or
                                      all-day events in the original calendar.
                                    </Text>
                                  )}
                                </View>
                              ))}
                          </>
                        )}
                        <Action
                          secondary
                          title="Disconnect"
                          icon={Unplug}
                          disabled={busy}
                          onPress={() =>
                            void run(async () => {
                              await api(
                                root + "/" + linked.id + "/disconnect",
                                {},
                              );
                              await load();
                              if (mounted.current)
                                setNotice(
                                  "Ziipa access removed. External calendar events stay in their original calendar.",
                                );
                            })
                          }
                        />
                      </>
                    )}
                  </>
                )}
              </View>
            )}
          </View>
        );
      })}
      {!!state?.device_snapshots?.length && (
        <>
          <Text style={styles.label}>Saved device calendars</Text>
          {state.device_snapshots.map((snapshot) => (
            <View key={snapshot.id} style={{ gap: 6 }}>
              <Text style={styles.small}>
                {snapshot.calendar_name} ·{" "}
                {new Date(snapshot.synced_at).toLocaleString()}
              </Text>
              <Action
                secondary
                title="Remove this calendar snapshot from Ziipa"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await api(
                      root + "/device/" + snapshot.id + "/disconnect",
                      {},
                    );
                    await load();
                  })
                }
              />
            </View>
          ))}
        </>
      )}
      {exporting && (
        <View
          style={{
            gap: 10,
            padding: 14,
            borderWidth: 1,
            borderColor: color.border,
            borderRadius: 12,
          }}
        >
          <Text style={styles.body}>
            Add “{exporting.title}” to {exporting.connection.calendar_name}?
          </Text>
          <Text style={styles.small}>
            This creates one event with a link to its Ziipa schedule, without
            guests. Repeating this action does not create another copy.
          </Text>
          <Action
            title="Confirm calendar export"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const result = await api<{ detail: string }>(
                  root + "/" + exporting.connection.id + "/export",
                  { occurrence_id: exporting.occurrence },
                );
                if (mounted.current) {
                  setExporting(null);
                  setNotice(result.detail);
                }
              })
            }
          />
          <Action
            secondary
            title="Cancel export"
            disabled={busy}
            onPress={() => setExporting(null)}
          />
        </View>
      )}
      {editing && (
        <View
          style={{
            gap: 10,
            padding: 14,
            borderWidth: 1,
            borderColor: color.border,
            borderRadius: 12,
          }}
        >
          <Text style={styles.small}>
            Changes will be sent to the original calendar only when you save.
          </Text>
          <Field
            label="Event title"
            value={editing.title}
            onChangeText={(title) => setEditing({ ...editing, title })}
          />
          <Field
            label="Notes"
            multiline
            value={editing.notes}
            onChangeText={(notes) => setEditing({ ...editing, notes })}
          />
          <Field
            label="Starts · date/time with timezone"
            value={editing.starts_at}
            onChangeText={(starts_at) => setEditing({ ...editing, starts_at })}
          />
          <Field
            label="Ends · date/time with timezone"
            value={editing.ends_at}
            onChangeText={(ends_at) => setEditing({ ...editing, ends_at })}
          />
          <Action
            title="Save to connected calendar"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const {
                  id,
                  connection_id,
                  revision,
                  title,
                  notes,
                  starts_at,
                  ends_at,
                } = editing;
                await api(
                  root + "/" + connection_id + "/events/" + id + "/edit",
                  { revision, title, notes, starts_at, ends_at },
                );
                await load();
                if (mounted.current) {
                  setEditing(null);
                  setNotice("Calendar event saved.");
                }
              })
            }
          />
          <Action
            secondary
            title="Cancel edit"
            disabled={busy}
            onPress={() => setEditing(null)}
          />
        </View>
      )}
    </Sheet>
  );
}

// Device access is loaded only inside its explicit permission flow. The web
// implementation offers a mobile handoff without attempting to read a device.
import { DeviceCalendarPanel } from "./device-calendar-panel";
