import { HelpLabel } from "../components/help-label";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import {
  Bell,
  CheckCircle2,
  List,
  Plus,
  Radio,
  RefreshCw,
} from "lucide-react-native";
import { Action, Field, IconButton, Notice, Pill } from "../components/ui";
import { CalendarDayPicker } from "../components/calendar-day-picker";
import {
  CalendarEventFlow,
  validateCalendarDetails,
  type CalendarEditorStep,
} from "../components/calendar-event-flow";
import { CalendarConnections } from "../components/calendar-connections";
import { useDesktopLayout } from "../components/desktop-layout";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import {
  authorizationHeaders,
  portalMode,
  validateOrigin,
} from "../lib/config";
import { ApiError } from "../lib/api";
import { campaignLabel } from "../lib/campaign-types";
import {
  calendarCanAcknowledge,
  calendarInput,
  calendarMoment,
  calendarPreflightCurrent,
  calendarRoot,
  calendarWeekdays,
  type CalendarCampaign,
  type CalendarDraft,
  nextCalendarWallTime,
  type CalendarEvent,
  type CalendarKind,
  type CalendarList,
} from "../lib/calendar-types";
import type { LiveBroadcast } from "../lib/live-types";
import type { RootStack } from "../lib/types";
import { color, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Calendar">;
function blankDraft(): CalendarDraft {
  let timezone = "America/New_York";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
  } catch {
    /* Use the editable default. */
  }
  return {
    title: "",
    notes: "",
    kind: "reminder",
    timezone,
    startsLocal: nextCalendarWallTime(timezone),
    fold: "earlier",
    duration: "60",
    reminder: "15",
    frequency: "none",
    interval: "1",
    count: "1",
    weekdays: [],
    until: "",
    streamId: null,
    campaignId: null,
  };
}
function eventDraft(event: CalendarEvent): CalendarDraft {
  return {
    title: event.title,
    notes: event.notes,
    kind: event.kind,
    timezone: event.timezone,
    startsLocal: event.starts_local,
    fold: event.fold,
    duration: String(event.duration_minutes),
    reminder: String(event.reminder_minutes),
    frequency: event.recurrence.frequency,
    interval: String(event.recurrence.interval),
    count: String(event.recurrence.count),
    weekdays: event.recurrence.weekdays || [],
    until: event.recurrence.until || "",
    streamId: event.stream_id,
    campaignId: event.campaign_id,
  };
}
function Card({ title, children }: { title: string; children: ReactNode }) {
  const { desktop } = useDesktopLayout();
  return (
    <View
      style={[
        styles.panel,
        { gap: 14 },
        desktop && { padding: 18, borderRadius: 12 },
      ]}
    >
      <Text style={[styles.heading, desktop && { fontSize: 18 }]}>{title}</Text>
      {children}
    </View>
  );
}

/** Fragments leave the native/compact layout tree exactly as it was. */
function DesktopGroup({
  children,
  style,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
}) {
  const { desktop } = useDesktopLayout();
  return desktop ? <View style={style}>{children}</View> : <>{children}</>;
}

export function CalendarScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedCalendarScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.eventId || ""}:${props.route.params?.streamId || ""}:${props.route.params?.campaignId || ""}`}
      {...props}
    />
  );
}

function ScopedCalendarScreen({ navigation, route }: Props) {
  const { session, guest, api, forgetSession } = useZiipa();
  const { desktop, contentWidth } = useDesktopLayout();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const active = focused && foreground;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [connectedEvents, setConnectedEvents] = useState<
    NonNullable<CalendarList["connected_events"]>
  >([]);
  const [connectedLimit, setConnectedLimit] = useState(20);
  const upcomingConnectedEvents = connectedEvents.filter(
    (entry) => Date.parse(entry.ends_at) >= Date.now(),
  );
  const [campaigns, setCampaigns] = useState<CalendarCampaign[]>([]);
  const [streams, setStreams] = useState<LiveBroadcast[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    route.params?.eventId || null,
  );
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [draft, setDraft] = useState<CalendarDraft>(() => ({
    ...blankDraft(),
    kind:
      route.params?.kind ||
      (route.params?.streamId
        ? "stream"
        : route.params?.campaignId
          ? "campaign"
          : "reminder"),
    streamId: route.params?.streamId || null,
    campaignId: route.params?.campaignId || null,
  }));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [advancedTime, setAdvancedTime] = useState(false);
  const [editorStep, setEditorStep] = useState<CalendarEditorStep>(
    route.params?.eventId ? 2 : 0,
  );
  const [agendaOpen, setAgendaOpen] = useState(false);
  const page = useRef<ScrollView>(null);
  const [preflightClock, setPreflightClock] = useState(Date.now());
  const requestId = useRef(Crypto.randomUUID());
  const requests = useRef(new Set<AbortController>());
  const owner = useRef(session?.access_token);
  owner.current = session?.access_token;
  const mutation = useRef(false);
  const version = useRef("");
  const capture = useOperationScope(
    `${session?.access_token}:${selectedId || "new"}`,
    active,
  );
  const dirty =
    !!event && JSON.stringify(draft) !== JSON.stringify(eventDraft(event));
  const day = /^\d{4}-\d{2}-\d{2}/.test(draft.startsLocal)
    ? draft.startsLocal.slice(0, 10)
    : blankDraft().startsLocal.slice(0, 10);
  const clockTime = draft.startsLocal.includes("T")
    ? draft.startsLocal.split("T")[1].slice(0, 5)
    : "";

  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) =>
      setForeground(value === "active"),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!active) requests.current.forEach((request) => request.abort());
    return () => {
      requests.current.forEach((request) => request.abort());
    };
  }, [active]);
  useEffect(() => {
    setPreflightClock(Date.now());
    const expires = event?.preflight?.expires_at
      ? Date.parse(event.preflight.expires_at)
      : 0;
    if (!active || !expires || expires <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setPreflightClock(current);
      if (current >= expires) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, event?.preflight?.expires_at, event?.preflight?.checked_at]);
  useEffect(() => {
    setBusy(false);
    setError("");
    setNotice("");
  }, [selectedId]);
  useEffect(() => {
    if (!event) return;
    const key = `${event.id}:${event.revision}`;
    if (version.current !== key) {
      version.current = key;
      setDraft(eventDraft(event));
    }
  }, [event?.id, event?.revision]);

  const calendarRequest = useCallback(
    async <T,>(
      path: string,
      method: "PUT" | "POST",
      body: unknown,
    ): Promise<T> => {
      const token = session?.access_token;
      if (
        !token ||
        owner.current !== token ||
        !path.startsWith(calendarRoot + "/") ||
        path.includes("..")
      )
        throw new Error("Sign in to your calendar.");
      const controller = new AbortController();
      requests.current.add(controller);
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(validateOrigin() + path, {
          method,
          headers: {
            ...authorizationHeaders(token),
            "Content-Type": "application/json",
          },
          credentials: portalMode ? "include" : "omit",
          signal: controller.signal,
          redirect: "error",
          body: JSON.stringify(body),
        });
        const value = await response.json().catch(() => null);
        if (owner.current !== token)
          throw new Error("Your account changed. Reopen the calendar.");
        if (!response.ok) {
          if (response.status === 401) await forgetSession();
          throw new ApiError(
            typeof value?.detail === "string"
              ? value.detail
              : "The schedule could not be saved. Check the date, timezone and current revision.",
            response.status,
          );
        }
        return value as T;
      } finally {
        clearTimeout(timer);
        requests.current.delete(controller);
      }
    },
    [session?.access_token, forgetSession],
  );

  const load = useCallback(async () => {
    if (!session || guest || !active) return;
    const valid = capture();
    setLoading(true);
    setError("");
    try {
      const [list, broadcasts] = await Promise.all([
        api<CalendarList>(`${calendarRoot}/events`),
        api<LiveBroadcast[]>("/api/live/streams"),
      ]);
      if (!valid()) return;
      setEvents(list.events);
      setConnectedEvents(list.connected_events || []);
      setCampaigns(list.campaigns);
      setStreams(broadcasts);
      if (selectedId) {
        const result = await api<CalendarEvent>(
          `${calendarRoot}/events/${selectedId}`,
        );
        if (valid()) setEvent(result);
      } else setEvent(null);
    } catch (e) {
      if (valid())
        setError(e instanceof Error ? e.message : "Calendar could not load.");
    } finally {
      if (valid()) setLoading(false);
    }
  }, [session?.access_token, guest, active, capture, api, selectedId]);
  useEffect(() => {
    void load();
  }, [load]);
  const waitingForReminder = events.some(
    (entry) =>
      entry.status === "active" &&
      entry.occurrences.some((occurrence) => occurrence.status === "scheduled"),
  );
  useEffect(() => {
    if (!active || !session || !waitingForReminder) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (mutation.current) return;
      const valid = capture();
      void api<CalendarList>(`${calendarRoot}/events`)
        .then((list) => {
          if (stopped || !valid()) return;
          setEvents(list.events);
          setCampaigns(list.campaigns);
          if (selectedId && !dirty) {
            const current = list.events.find(
              (entry) => entry.id === selectedId,
            );
            if (current) setEvent(current);
          }
        })
        .catch(() => {
          /* Keep the last saved receipts; manual refresh exposes errors. */
        });
    }, 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    active,
    session?.access_token,
    waitingForReminder,
    selectedId,
    dirty,
    api,
    capture,
  ]);

  async function run(work: (valid: () => boolean) => Promise<void>) {
    if (mutation.current || !session || !active || guest) return;
    mutation.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(valid);
    } catch (e) {
      if (valid())
        setError(
          e instanceof Error
            ? e.message
            : "This calendar action could not complete.",
        );
    } finally {
      mutation.current = false;
      if (valid()) setBusy(false);
    }
  }
  function remember(result: CalendarEvent) {
    version.current = `${result.id}:${result.revision}`;
    setEvent(result);
    setDraft(eventDraft(result));
    setEvents((previous) => [
      result,
      ...previous.filter((entry) => entry.id !== result.id),
    ]);
  }
  function change<K extends keyof CalendarDraft>(
    key: K,
    value: CalendarDraft[K],
  ) {
    if (busy || event?.status === "cancelled") return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError("");
    setNotice("");
  }
  async function save(valid: () => boolean) {
    const fields = calendarInput(draft);
    const result = event
      ? await calendarRequest<CalendarEvent>(
          `${calendarRoot}/events/${event.id}`,
          "PUT",
          { revision: event.revision, ...fields },
        )
      : await api<CalendarEvent>(`${calendarRoot}/events`, {
          request_id: requestId.current,
          ...fields,
        });
    if (!valid()) return;
    remember(result);
    setSelectedId(result.id);
    setEditorStep(2);
    setNotice("Event saved to your calendar.");
  }
  async function control(
    operation: "pause" | "resume" | "cancel",
    valid: () => boolean,
  ) {
    if (!event) return;
    const result = await calendarRequest<CalendarEvent>(
      `${calendarRoot}/events/${event.id}/${operation}`,
      "POST",
      { revision: event.revision },
    );
    if (valid()) remember(result);
  }
  function newEvent() {
    if (busy) return;
    setSelectedId(null);
    setEvent(null);
    setDraft(blankDraft());
    requestId.current = Crypto.randomUUID();
    version.current = "";
    setEditorStep(0);
    setAdvancedTime(false);
    setError("");
    setNotice("");
    setAgendaOpen(false);
    page.current?.scrollTo({ y: 0, animated: true });
  }

  if (!session || guest)
    return (
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.page}
      >
        <Card title="Calendar">
          <Action
            title="Sign in to your calendar"
            onPress={() => navigation.navigate("Login")}
          />
        </Card>
      </ScrollView>
    );

  return (
    <ScrollView
      ref={page}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      showsVerticalScrollIndicator={false}

      contentContainerStyle={[
        styles.page,
        {
          width: "100%",
          maxWidth: desktop ? 1480 : 960,
          alignSelf: "center",
          paddingBottom: desktop ? 136 : 50,
        },
        desktop && { paddingHorizontal: 28, paddingTop: 24, gap: 20 },
      ]}
    >
      {desktop ? (
        <View
          style={[
            styles.between,
            { alignItems: "flex-start", flexWrap: "wrap", gap: 16 },
          ]}
        >
          <View style={{ gap: 5, flex: 1, minWidth: 220 }}>
            <Text style={[styles.heading, { fontSize: 25 }]}>Calendar</Text>
          </View>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
            <CalendarConnections
              events={events}
              onChanged={() => void load()}
            />
            <Action
              secondary
              title="Notifications"
              disabled={busy}
              onPress={() => navigation.navigate("Notifications")}
            />
            <Action
              title="New event"
              icon={Plus}
              disabled={busy}
              onPress={newEvent}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh calendar"
              disabled={busy || loading}
              onPress={() => void load()}
              style={{ padding: 10 }}
            >
              <RefreshCw size={18} color={color.muted} />
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.between}>
            <View style={{ flex: 1 }}>
              <HelpLabel
                label="Calendar"
                style={styles.title}
                help="Connect calendars, add an event, and choose which reminders reach your devices. Scheduled broadcasts still need you to start them."
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh calendar"
              disabled={busy || loading}
              onPress={() => void load()}
              style={{ padding: 12 }}
            >
              <RefreshCw color={color.lime} size={24} />
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <CalendarConnections
                events={events}
                onChanged={() => void load()}
                deviceConnectRequest={route.params?.deviceConnectRequest}
              />
            </View>
            <IconButton
              icon={List}
              label={`${agendaOpen ? "Hide" : "Show"} agenda, ${events.length} events`}
              active={agendaOpen}
              onPress={() => setAgendaOpen((value) => !value)}
            />
            <IconButton
              icon={Bell}
              label="Notifications & devices"
              onPress={() => navigation.navigate("Notifications")}
            />
            <IconButton
              icon={Plus}
              label="New calendar event"
              disabled={busy}
              onPress={newEvent}
            />
          </View>
        </>
      )}
      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator color={color.lime} />
          <Text style={styles.small}>Loading your calendar…</Text>
        </View>
      ) : null}
      {error && selectedId && !event ? <Notice error text={error} /> : null}
      {notice ? <Notice text={notice} /> : null}
      <DesktopGroup
        style={{
          flexDirection: contentWidth >= 760 ? "row" : "column",
          alignItems: "flex-start",
          gap: 20,
        }}
      >
        <DesktopGroup
          style={{
            width:
              contentWidth >= 760 ? (contentWidth >= 1200 ? 310 : 240) : "100%",
            gap: 16,
          }}
        >
          {(desktop || agendaOpen) && (
            <Card title="Your agenda">
              {desktop && (
                <Text style={styles.small}>
                  {events.length} saved{" "}
                  {events.length === 1 ? "event" : "events"} · select one to
                  review its schedule
                </Text>
              )}
              {!events.length ? (
                <Text style={styles.small}>
                  No saved events yet. Add your first schedule below.
                </Text>
              ) : null}
              {events.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: selectedId === entry.id,
                    disabled: busy,
                  }}
                  disabled={busy}
                  onPress={() => {
                    setEditorStep(2);
                    setAgendaOpen(false);
                    page.current?.scrollTo({ y: 0, animated: true });
                    if (selectedId === entry.id) void load();
                    else {
                      setEvent(null);
                      setSelectedId(entry.id);
                    }
                  }}
                  style={{
                    gap: 6,
                    padding: desktop ? 11 : 14,
                    borderRadius: desktop ? 9 : 14,
                    borderWidth: 1,
                    borderColor:
                      selectedId === entry.id ? color.lime : color.border,
                  }}
                >
                  <View style={styles.between}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      {entry.title}
                    </Text>
                    <Text style={[styles.small, { color: color.lime }]}>
                      {campaignLabel(entry.status)}
                    </Text>
                  </View>
                  <Text style={styles.small}>
                    {campaignLabel(entry.kind)} ·{" "}
                    {entry.starts_local.replace("T", " ")} · {entry.timezone}
                  </Text>
                  <Text style={styles.small}>
                    {entry.recurrence.frequency === "none"
                      ? "One occurrence"
                      : `Every ${entry.recurrence.interval} ${entry.recurrence.frequency === "daily" ? "day(s)" : "week(s)"} · up to ${entry.recurrence.count} occurrences`}
                  </Text>
                </Pressable>
              ))}
              {upcomingConnectedEvents.length ? (
                <>
                  <Text style={styles.label}>Connected calendars</Text>
                  <HelpLabel
                    label="Imported events"
                    help="Use Connect to sync your calendars. Plan media opens a draft request for you to review before taking action."
                  />
                  {upcomingConnectedEvents
                    .slice(0, connectedLimit)
                    .map((entry) => (
                      <View
                        key={entry.id}
                        style={{
                          paddingVertical: 10,
                          gap: 6,
                          borderTopWidth: 1,
                          borderTopColor: color.border,
                        }}
                      >
                        <Text style={styles.body}>{entry.title}</Text>
                        <Text style={styles.small}>
                          {entry.source} ·{" "}
                          {entry.all_day
                            ? `All day · ${entry.starts_at.slice(0, 10)}`
                            : new Date(entry.starts_at).toLocaleString()}
                        </Text>
                        <Action
                          secondary
                          title="Plan media with Ziipa"
                          onPress={() =>
                            navigation.navigate("MediaOS", {
                              tab: "Assistant",
                              prompt: `Help me prepare media for a calendar event. Event title: ${JSON.stringify(entry.title)}. Starts: ${entry.starts_at}. Ask me to review the production plan, draft and destinations before taking action.`,
                            })
                          }
                        />
                      </View>
                    ))}
                  {upcomingConnectedEvents.length > connectedLimit && (
                    <Action
                      secondary
                      title="Show more calendar events"
                      onPress={() => setConnectedLimit((limit) => limit + 20)}
                    />
                  )}
                </>
              ) : null}
              {campaigns.length ? (
                <>
                  <Text style={styles.label}>Reviewed campaign schedules</Text>
                  <HelpLabel
                    label="Campaign timing"
                    help="Publishing times and approvals stay in Campaigns. Linking a calendar event does not change a post."
                  />
                  {campaigns.map((entry) => (
                    <Action
                      key={entry.id}
                      secondary
                      title={`${entry.name || entry.title || "Campaign"} · ${campaignLabel(entry.status)}`}
                      onPress={() =>
                        navigation.navigate("Campaigns", {
                          campaignId: entry.id,
                        })
                      }
                    />
                  ))}
                </>
              ) : null}
            </Card>
          )}
        </DesktopGroup>
        <DesktopGroup style={{ flex: 1, minWidth: 0, width: "100%", gap: 18 }}>
          {selectedId && !event ? (
            <Notice text="Loading event…" />
          ) : (
            <>
              <Card title={event ? "Your event" : "New event"}>
                <CalendarEventFlow
                  key={selectedId || requestId.current}
                  step={editorStep}
                  changeStep={(step) => {
                    setEditorStep(step);
                    page.current?.scrollTo({ y: 0, animated: true });
                  }}
                  busy={busy}
                  canSave={!event || dirty}
                  readOnly={event?.status === "cancelled"}
                  existing={!!event}
                  error={error}
                  validateDetails={() => validateCalendarDetails(draft)}
                  validateSchedule={() => {
                    calendarInput(draft);
                  }}
                  onSave={() => void run(save)}
                  details={
                    <>
                      <Field
                        label="Event title"
                        value={draft.title}
                        editable={!busy && event?.status !== "cancelled"}
                        maxLength={140}
                        onChangeText={(value) => change("title", value)}
                      />
                      <View
                        style={{
                          flexDirection: "row",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        {(
                          ["reminder", "campaign", "stream"] as CalendarKind[]
                        ).map((kind) => (
                          <Pill
                            key={kind}
                            title={campaignLabel(kind)}
                            active={draft.kind === kind}
                            onPress={() => {
                              if (!busy && event?.status !== "cancelled")
                                change("kind", kind);
                            }}
                          />
                        ))}
                      </View>
                      <Field
                        label="Notes"
                        value={draft.notes}
                        multiline
                        maxLength={2000}
                        editable={!busy && event?.status !== "cancelled"}
                        onChangeText={(value) => change("notes", value)}
                      />
                      {draft.kind === "campaign" ? (
                        <>
                          <Text style={styles.label}>Campaign (optional)</Text>
                          <Pill
                            title="No link"
                            active={!draft.campaignId}
                            onPress={() => change("campaignId", null)}
                          />
                          {campaigns.map((entry) => (
                            <Pill
                              key={entry.id}
                              title={entry.name || entry.title || entry.id}
                              active={draft.campaignId === entry.id}
                              onPress={() => {
                                if (!busy) change("campaignId", entry.id);
                              }}
                            />
                          ))}
                          <Notice text="Set publishing times in the linked campaign." />
                        </>
                      ) : null}
                      {draft.kind === "stream" ? (
                        <>
                          <Text style={styles.label}>Broadcast (optional)</Text>
                          <Pill
                            title="No link yet"
                            active={!draft.streamId}
                            onPress={() => change("streamId", null)}
                          />
                          {streams.map((stream) => (
                            <Pill
                              key={stream.id}
                              title={`${stream.title} · ${campaignLabel(stream.status)}`}
                              active={draft.streamId === stream.id}
                              onPress={() => {
                                if (!busy) change("streamId", stream.id);
                              }}
                            />
                          ))}
                          <Action
                            secondary
                            title="Prepare a broadcast in Live controls"
                            icon={Radio}
                            onPress={() =>
                              navigation.navigate("Live", { tab: "broadcast" })
                            }
                          />
                          <Notice text="Start your broadcast from Live Feed." />
                        </>
                      ) : null}
                    </>
                  }
                  schedule={
                    <>
                      <DesktopGroup
                        style={{
                          flexDirection:
                            contentWidth >= 1260 ? "row" : "column",
                          gap: 22,
                          alignItems: "stretch",
                        }}
                      >
                        <DesktopGroup style={{ flex: 1, minWidth: 0, gap: 14 }}>
                          <Text style={styles.label}>
                            Choose a date · {draft.timezone}
                          </Text>
                          <CalendarDayPicker
                            value={day}
                            disabled={busy || event?.status === "cancelled"}
                            onChange={(date) =>
                              change(
                                "startsLocal",
                                `${date}T${clockTime || "18:00"}`,
                              )
                            }
                          />
                        </DesktopGroup>
                        <DesktopGroup style={{ flex: 1, minWidth: 0, gap: 14 }}>
                          <Field
                            label="Time (24-hour)"
                            value={clockTime}
                            editable={!busy && event?.status !== "cancelled"}
                            placeholder="18:00"
                            maxLength={5}
                            onChangeText={(value) =>
                              change("startsLocal", `${day}T${value}`)
                            }
                          />
                          <Pill
                            title={
                              advancedTime
                                ? "Hide advanced date and time"
                                : "Advanced date and time"
                            }
                            active={advancedTime}
                            onPress={() => setAdvancedTime((value) => !value)}
                          />
                          {advancedTime ? (
                            <View style={{ gap: 12 }}>
                              <Field
                                label="Timezone"
                                help="Use a location such as America/New_York or Europe/London. Event times follow that timezone."
                                value={draft.timezone}
                                autoCapitalize="none"
                                editable={
                                  !busy && event?.status !== "cancelled"
                                }
                                placeholder="America/New_York"
                                onChangeText={(value) =>
                                  change("timezone", value)
                                }
                              />
                              <Field
                                label="Exact local date and time"
                                value={draft.startsLocal}
                                editable={
                                  !busy && event?.status !== "cancelled"
                                }
                                placeholder="2026-10-20T18:00:00"
                                onChangeText={(value) =>
                                  change("startsLocal", value)
                                }
                              />
                              <HelpLabel
                                label="If the clock repeats this hour"
                                help="When clocks move back, the same local time can occur twice. Choose whether your event uses the earlier or later occurrence."
                              />
                              <View style={{ flexDirection: "row", gap: 8 }}>
                                <Pill
                                  title="Earlier occurrence"
                                  active={draft.fold === "earlier"}
                                  onPress={() => {
                                    if (!busy) change("fold", "earlier");
                                  }}
                                />
                                <Pill
                                  title="Later occurrence"
                                  active={draft.fold === "later"}
                                  onPress={() => {
                                    if (!busy) change("fold", "later");
                                  }}
                                />
                              </View>
                            </View>
                          ) : null}
                          <View
                            style={{
                              flexDirection: "row",
                              flexWrap: "wrap",
                              gap: 12,
                            }}
                          >
                            <View style={{ flex: 1, minWidth: 130 }}>
                              <Field
                                label="Duration (minutes)"
                                value={draft.duration}
                                keyboardType="number-pad"
                                editable={
                                  !busy && event?.status !== "cancelled"
                                }
                                onChangeText={(value) =>
                                  change("duration", value)
                                }
                              />
                            </View>
                            <View style={{ flex: 1, minWidth: 130 }}>
                              <Field
                                label="Remind me (minutes before)"
                                value={draft.reminder}
                                keyboardType="number-pad"
                                editable={
                                  !busy && event?.status !== "cancelled"
                                }
                                onChangeText={(value) =>
                                  change("reminder", value)
                                }
                              />
                            </View>
                          </View>
                          <HelpLabel
                            label="Reminder delivery"
                            help="Ziipa saves your reminders in your account. Device alerts also need your notification preferences and permission."
                          />
                          <HelpLabel
                            label="Repeat"
                            help="Creates recurring event dates. A scheduled stream is a plan; you must still start the broadcast yourself."
                          />
                          <View
                            style={{
                              flexDirection: "row",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            {(["none", "daily", "weekly"] as const).map(
                              (frequency) => (
                                <Pill
                                  key={frequency}
                                  title={campaignLabel(frequency)}
                                  active={draft.frequency === frequency}
                                  onPress={() => {
                                    if (!busy) change("frequency", frequency);
                                  }}
                                />
                              ),
                            )}
                          </View>
                          {draft.frequency !== "none" ? (
                            <>
                              <Field
                                label={`Repeat every · ${draft.frequency === "daily" ? "days" : "weeks"}`}
                                value={draft.interval}
                                keyboardType="number-pad"
                                editable={!busy}
                                onChangeText={(value) =>
                                  change("interval", value)
                                }
                              />
                              <Field
                                label="Maximum occurrences · 1–52"
                                value={draft.count}
                                keyboardType="number-pad"
                                editable={!busy}
                                onChangeText={(value) => change("count", value)}
                              />
                              <Field
                                label="Optional last local date · YYYY-MM-DD"
                                value={draft.until}
                                editable={!busy}
                                placeholder="2026-12-31"
                                onChangeText={(value) => change("until", value)}
                              />
                            </>
                          ) : null}
                          {draft.frequency === "weekly" ? (
                            <View
                              style={{
                                flexDirection: "row",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              {calendarWeekdays.map((day, index) => (
                                <Pill
                                  key={day}
                                  title={day}
                                  active={draft.weekdays.includes(index)}
                                  onPress={() => {
                                    if (!busy)
                                      change(
                                        "weekdays",
                                        draft.weekdays.includes(index)
                                          ? draft.weekdays.filter(
                                              (value) => value !== index,
                                            )
                                          : [...draft.weekdays, index].sort(),
                                      );
                                  }}
                                />
                              ))}
                            </View>
                          ) : null}
                        </DesktopGroup>
                      </DesktopGroup>
                    </>
                  }
                  review={
                    <View style={{ gap: 14 }}>
                      <View style={{ gap: 5 }}>
                        <Text style={styles.heading}>
                          {draft.title || "Untitled event"}
                        </Text>
                        <Text style={styles.small}>
                          {campaignLabel(draft.kind)}
                          {event
                            ? ` · ${campaignLabel(event.status)}`
                            : " · Private plan"}
                        </Text>
                      </View>
                      <View
                        style={{
                          padding: 14,
                          borderRadius: 12,
                          borderWidth: 1,
                          borderColor: color.border,
                          gap: 8,
                        }}
                      >
                        <Text style={styles.label}>
                          {draft.startsLocal.replace("T", " · ")}
                        </Text>
                        <Text style={styles.small}>
                          {draft.timezone} · {draft.duration} minutes
                        </Text>
                        <Text style={styles.body}>
                          {draft.reminder === "0"
                            ? "Reminder at the start"
                            : `Reminder ${draft.reminder} minutes before`}
                        </Text>
                        <Text style={styles.small}>
                          {draft.frequency === "none"
                            ? "Does not repeat"
                            : `Every ${draft.interval} ${draft.frequency === "daily" ? "day(s)" : "week(s)"} · up to ${draft.count} dates`}
                        </Text>
                        {draft.frequency === "weekly" && (
                          <Text style={styles.small}>
                            {draft.weekdays
                              .map((index) => calendarWeekdays[index])
                              .join(" · ")}
                          </Text>
                        )}
                        {!!draft.until && draft.frequency !== "none" && (
                          <Text style={styles.small}>Until {draft.until}</Text>
                        )}
                      </View>
                      {!!draft.notes.trim() && (
                        <Text style={styles.body}>{draft.notes}</Text>
                      )}
                      {draft.kind === "stream" && draft.streamId && (
                        <Text style={styles.body}>
                          Broadcast ·{" "}
                          {streams.find((value) => value.id === draft.streamId)
                            ?.title || "Linked broadcast"}
                        </Text>
                      )}
                      {draft.kind === "campaign" && draft.campaignId && (
                        <Text style={styles.body}>
                          Campaign ·{" "}
                          {campaigns.find(
                            (value) => value.id === draft.campaignId,
                          )?.name ||
                            campaigns.find(
                              (value) => value.id === draft.campaignId,
                            )?.title ||
                            "Linked campaign"}
                        </Text>
                      )}
                      <HelpLabel
                        label="Private schedule"
                        help="Saving an event creates its dates and Ziipa reminders. Broadcasting and publishing still need your separate approval. Choose device notifications in Notifications."
                      />
                    </View>
                  }
                />
              </Card>

              {event && editorStep === 2 ? (
                <>
                  {event.kind === "stream" ? (
                    <Card title="Broadcast checks">
                      <HelpLabel
                        label="About this check"
                        help="Checks the linked broadcast without starting it or opening your camera. Start the broadcast yourself in Live controls."
                      />
                      <Action
                        secondary
                        title="Check this linked broadcast"
                        icon={CheckCircle2}
                        busy={busy}
                        disabled={
                          dirty || !event.stream_id || event.status !== "active"
                        }
                        onPress={() =>
                          void run(async (valid) => {
                            const result = await calendarRequest<CalendarEvent>(
                              `${calendarRoot}/events/${event.id}/preflight`,
                              "POST",
                              { revision: event.revision },
                            );
                            if (valid()) remember(result);
                          })
                        }
                      />
                      {event.preflight ? (
                        <>
                          <Text
                            style={[
                              styles.label,
                              {
                                color: calendarPreflightCurrent(
                                  event.preflight,
                                  preflightClock,
                                )
                                  ? color.lime
                                  : color.muted,
                              },
                            ]}
                          >
                            {calendarPreflightCurrent(
                              event.preflight,
                              preflightClock,
                            )
                              ? "Provider check current · manual start still required"
                              : "Preflight needs a fresh check or setup"}
                          </Text>
                          <Text style={styles.small}>
                            {event.preflight.detail}
                          </Text>
                          {event.preflight.checked_at ? (
                            <Text style={styles.small}>
                              Checked{" "}
                              {calendarMoment(
                                event.preflight.checked_at,
                                event.timezone,
                              )}
                            </Text>
                          ) : null}
                          {(event.preflight.checks || []).map((check) => (
                            <View
                              key={check.id}
                              style={{
                                gap: 4,
                                padding: 12,
                                borderWidth: 1,
                                borderColor: color.border,
                                borderRadius: 12,
                              }}
                            >
                              <Text style={styles.label}>
                                {check.label} · {campaignLabel(check.status)}
                              </Text>
                              <Text style={styles.small}>{check.detail}</Text>
                            </View>
                          ))}
                        </>
                      ) : null}
                      <Action
                        title="Open linked Live controls · start manually"
                        icon={Radio}
                        onPress={() =>
                          navigation.navigate("Live", {
                            tab: "broadcast",
                            streamId: event.stream_id || undefined,
                          })
                        }
                      />
                      {event.stream_id ? (
                        <Text style={styles.small}>
                          Select your linked broadcast:{" "}
                          {streams.find(
                            (stream) => stream.id === event.stream_id,
                          )?.title || event.stream_id}
                          .
                        </Text>
                      ) : null}
                    </Card>
                  ) : null}
                  {event.kind === "campaign" && event.campaign_id ? (
                    <Action
                      secondary
                      title="Open campaign review and publishing schedule"
                      onPress={() =>
                        navigation.navigate("Campaigns", {
                          campaignId: event.campaign_id!,
                        })
                      }
                    />
                  ) : null}
                  <Card title="Schedule activity">
                    {!event.occurrences.length ? (
                      <Text style={styles.small}>
                        No planned occurrences are available for this schedule.
                      </Text>
                    ) : null}
                    {event.occurrences.map((occurrence) => (
                      <View
                        key={occurrence.id}
                        style={{
                          gap: 8,
                          borderWidth: 1,
                          borderColor: color.border,
                          borderRadius: 14,
                          padding: 14,
                        }}
                      >
                        <Text style={styles.label}>
                          {calendarMoment(occurrence.starts_at, event.timezone)}{" "}
                          · {event.timezone}
                        </Text>
                        <HelpLabel
                          label={campaignLabel(occurrence.status)}
                          help={
                            occurrence.detail || "Your saved reminder status."
                          }
                          style={styles.small}
                        />
                        <Text style={styles.small}>
                          Reminder ·{" "}
                          {calendarMoment(occurrence.remind_at, event.timezone)}
                        </Text>
                        {calendarCanAcknowledge(event, occurrence) ? (
                          <Action
                            secondary
                            title="Acknowledge this reminder"
                            busy={busy}
                            onPress={() =>
                              void run(async (valid) => {
                                await calendarRequest(
                                  `${calendarRoot}/occurrences/${occurrence.id}/acknowledge`,
                                  "POST",
                                  { revision: occurrence.revision },
                                );
                                if (valid()) await load();
                              })
                            }
                          />
                        ) : null}
                      </View>
                    ))}
                    {event.status !== "cancelled" ? (
                      <View
                        style={{
                          flexDirection: "row",
                          flexWrap: "wrap",
                          gap: 8,
                        }}
                      >
                        <Action
                          secondary
                          title={
                            event.status === "paused"
                              ? "Resume schedule"
                              : "Pause schedule"
                          }
                          busy={busy}
                          onPress={() =>
                            void run((valid) =>
                              control(
                                event.status === "paused" ? "resume" : "pause",
                                valid,
                              ),
                            )
                          }
                        />
                        <Action
                          danger
                          title="Cancel future reminders"
                          busy={busy}
                          onPress={() =>
                            void run((valid) => control("cancel", valid))
                          }
                        />
                      </View>
                    ) : null}
                  </Card>
                </>
              ) : null}
            </>
          )}
        </DesktopGroup>
      </DesktopGroup>
    </ScrollView>
  );
}
