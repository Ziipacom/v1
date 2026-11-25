import { useDesktopLayout } from "../components/desktop-layout";
import { workspace } from "../components/desktop-workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import {
  CalendarClock,
  Bell,
  Clapperboard,
  Check,
  Plus,
  Radio,
  RefreshCw,
  Square,
} from "lucide-react-native";
import { Action, Empty, Field, IconButton, Pill } from "../components/ui";
import { LiveTransmitter } from "../components/live-transmitter";
import { LiveViewer } from "../components/live-viewer";
import { LiveDestinations } from "../components/live-destinations";
import { HelpLabel } from "../components/help-label";
import { useZiipa } from "../provider";
import { request } from "../lib/api";
import {
  checkedIngest,
  checkedLivePlayback,
  liveStatusLabel,
  verifiedLive,
  type LiveBroadcast,
  type LiveConfig,
  type LiveIngest,
  type LiveTransmitterHandle,
  type PublicLiveBroadcast,
} from "../lib/live-types";
import type { RootStack } from "../lib/types";
import { color, font, styles } from "../theme";

type Tab = "watch" | "broadcast";
export function LiveScreen({
  route,
}: {
  route?: { params?: { tab?: Tab; streamId?: string; watchId?: string } };
}) {
  const { desktop } = useDesktopLayout();
  const { api, guest, session } = useZiipa();
  const publicApi = useCallback(
    <T,>(path: string): Promise<T> =>
      guest || !session ? request<T>(path) : api<T>(path),
    [api, guest, session],
  );
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [tab, setTab] = useState<Tab>(route?.params?.tab || "watch");
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [mine, setMine] = useState<LiveBroadcast[]>([]);
  const [publics, setPublics] = useState<PublicLiveBroadcast[]>([]);
  const [selected, setSelected] = useState<LiveBroadcast | null>(null);
  const [watching, setWatching] = useState<PublicLiveBroadcast | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [savingDestinations, setSavingDestinations] = useState(false);
  const [record, setRecord] = useState(false);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transport, setTransport] = useState("");
  const [clock, setClock] = useState(Date.now());
  const transmitter = useRef<LiveTransmitterHandle | null>(null);
  const selectedRef = useRef(selected);
  const watchingRef = useRef(watching);
  const mounted = useRef(true);
  const enabledRef = useRef(false);
  const loadingRef = useRef(false);
  const busyRef = useRef("");
  const attempted = useRef(false);
  const linkedSelection = useRef<string | null>(null);
  const startPromise = useRef<Promise<LiveIngest> | null>(null);
  const endPromise = useRef<Promise<void> | null>(null);
  const createRequest = useRef<{
    request_id: string;
    title: string;
    description: string;
    record: boolean;
  } | null>(null);
  const enabled = focused && foreground;
  enabledRef.current = enabled;
  selectedRef.current = selected;
  watchingRef.current = watching;
  function setMutation(value: string) {
    busyRef.current = value;
    if (mounted.current) setBusy(value);
  }
  function choose(value: LiveBroadcast | null) {
    selectedRef.current = value;
    if (mounted.current) setSelected(value);
  }
  function report(message: string) {
    if (mounted.current) setTransport(message);
  }
  useEffect(() => {
    if (route?.params?.tab) setTab(route.params.tab);
  }, [route?.params?.tab]);
  useEffect(() => {
    const requested = route?.params?.streamId;
    if (!focused || !requested) return;
    if (attempted.current || busyRef.current) {
      setError(
        "End or finish the current broadcast action before opening the linked stream.",
      );
      return;
    }
    transmitter.current?.stopLocal();
    choose(null);
    setConsent(false);
    setTab("broadcast");
    linkedSelection.current = requested;
  }, [focused, route?.params?.streamId]);
  useEffect(() => {
    mounted.current = true;
    const app = AppState.addEventListener("change", (value) => {
      // iOS permission sheets temporarily report inactive. The native
      // transmitter independently stops active capture on interruptions.
      if (value === "active") setForeground(true);
      else if (value === "background" || Platform.OS === "web")
        setForeground(false);
    });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      mounted.current = false;
      app.remove();
      clearInterval(timer);
    };
  }, []);

  const stopBroadcast = useCallback(() => {
    transmitter.current?.stopLocal();
    if (endPromise.current) return endPromise.current;
    const current = selectedRef.current;
    if (!current || current.status === "ended") {
      attempted.current = false;
      return Promise.resolve();
    }
    const operation = (async () => {
      setMutation("end");
      if (mounted.current) setError("");
      try {
        // Never allow a delayed Start response to arrive after End and reactivate ingest.
        await startPromise.current?.catch(() => {});
        const value = await api<LiveBroadcast>(
          `/api/live/streams/${current.id}/end`,
          {},
        );
        if (selectedRef.current?.id === current.id) choose(value);
        attempted.current = value.status !== "ended";
        report(
          value.status === "ended"
            ? "Camera, microphone and broadcast are stopped."
            : value.detail,
        );
      } catch (cause) {
        attempted.current = true;
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Stop is not confirmed. Stop your external encoder and retry End broadcast.",
          );
        if (selectedRef.current?.id === current.id)
          choose({
            ...current,
            live: false,
            status: "ending",
            playback_url: null,
            checked_at: null,
          });
      } finally {
        setMutation("");
        endPromise.current = null;
      }
    })();
    endPromise.current = operation;
    return operation;
  }, [api]);
  const stopRef = useRef(stopBroadcast);
  stopRef.current = stopBroadcast;
  useEffect(() => {
    if (!enabled) {
      transmitter.current?.stopLocal();
      if (attempted.current) void stopRef.current();
    }
  }, [enabled]);
  useEffect(() => {
    const id = route?.params?.watchId;
    if (!enabled || !id) return;
    let current = true;
    setTab("watch");
    setWatching(null);
    watchingRef.current = null;
    void publicApi<PublicLiveBroadcast>(
      `/api/live/public/${encodeURIComponent(id)}`,
    )
      .then((value) => {
        if (!current) return;
        if (!verifiedLive(value) || !checkedLivePlayback(value.playback_url))
          throw new Error("This broadcast is no longer live.");
        setWatching(value);
        watchingRef.current = value;
      })
      .catch(() => {
        if (current)
          setError("This broadcast is no longer live or is unavailable.");
      });
    return () => {
      current = false;
    };
  }, [enabled, publicApi, route?.params?.watchId]);
  useEffect(
    () => () => {
      transmitter.current?.stopLocal();
      if (attempted.current) void stopRef.current();
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (loadingRef.current || busyRef.current || !enabledRef.current) return;
    loadingRef.current = true;
    if (mounted.current) setLoading(true);
    try {
      const [configuration, feed, own] = await Promise.all([
        publicApi<LiveConfig>("/api/live/config"),
        publicApi<PublicLiveBroadcast[]>("/api/live/public"),
        guest || !session
          ? Promise.resolve([])
          : api<LiveBroadcast[]>("/api/live/streams"),
      ]);
      if (!mounted.current || !enabledRef.current) return;
      setConfig(configuration);
      setPublics(feed);
      setMine(own);
      if (!busyRef.current) setError("");
      const linkedId = linkedSelection.current;
      if (linkedId && !busyRef.current && !attempted.current) {
        const linked = own.find((value) => value.id === linkedId);
        linkedSelection.current = null;
        if (linked) {
          choose(linked);
          setConsent(false);
          setTab("broadcast");
          setTransport(
            "Opened your linked broadcast for review. Camera and Go live still require your explicit actions.",
          );
        } else
          setError(
            "The linked broadcast is unavailable in your owned broadcast list. No new broadcast was created.",
          );
      }
      const current = selectedRef.current;
      if (current && !busyRef.current) {
        try {
          const value = await api<LiveBroadcast>(
            `/api/live/streams/${current.id}`,
          );
          if (
            mounted.current &&
            selectedRef.current?.id === current.id &&
            !busyRef.current
          ) {
            choose(value);
            if (value.status === "ended") {
              attempted.current = false;
              transmitter.current?.stopLocal();
            }
          }
        } catch {
          if (
            mounted.current &&
            selectedRef.current?.id === current.id &&
            !busyRef.current
          )
            choose({
              ...current,
              live: false,
              playback_url: null,
              checked_at: null,
            });
        }
      }
      const viewing = watchingRef.current;
      if (viewing) {
        try {
          const value = await publicApi<PublicLiveBroadcast>(
            `/api/live/public/${viewing.id}`,
          );
          if (mounted.current && watchingRef.current?.id === viewing.id)
            setWatching(value);
        } catch {
          if (mounted.current && watchingRef.current?.id === viewing.id) {
            setWatching(null);
            report(
              "This broadcast is no longer verified live or is unavailable.",
            );
          }
        }
      }
    } catch {
      if (mounted.current) {
        setPublics([]);
        setError("Live feeds didn’t load.");
      }
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [api, publicApi, guest, session]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), 10000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, refresh]);

  async function prepare() {
    if (busyRef.current || !enabled || guest || !session || !config?.configured)
      return;
    if (!createRequest.current) {
      if (!title.trim()) {
        setError("Give your broadcast a title first.");
        return;
      }
      try {
        createRequest.current = {
          request_id: Crypto.randomUUID(),
          title: title.trim(),
          description: description.trim(),
          record,
        };
      } catch {
        setError(
          "Open a trusted HTTPS or localhost preview to prepare a broadcast securely.",
        );
        return;
      }
    }
    setMutation("prepare");
    setError("");
    try {
      const value = await api<LiveBroadcast>(
        "/api/live/streams",
        createRequest.current,
      );
      if (mounted.current) {
        choose(value);
        setMine((rows) => [
          value,
          ...rows.filter((row) => row.id !== value.id),
        ]);
        setConsent(false);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Preparation failed. Retry with the saved request ID.",
        );
    } finally {
      setMutation("");
    }
  }
  function begin(): Promise<LiveIngest> {
    const current = selectedRef.current;
    if (
      !current ||
      !consent ||
      !enabledRef.current ||
      busyRef.current ||
      savingDestinations ||
      startPromise.current
    )
      return Promise.reject(new Error("Confirm public broadcasting first."));
    attempted.current = true;
    setMutation("start");
    setError("");
    const promise = (async () => {
      try {
        const started = await api<LiveBroadcast>(
          `/api/live/streams/${current.id}/start`,
          { confirm_public: true },
        );
        if (mounted.current && selectedRef.current?.id === current.id)
          choose(started);
        return checkedIngest(
          await api<LiveIngest>(`/api/live/streams/${current.id}/ingest`, {}),
          current.id,
        );
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Public ingest could not be confirmed. End the broadcast before retrying.",
          );
        throw new Error("Public ingest could not be confirmed.");
      } finally {
        if (!endPromise.current) setMutation("");
        startPromise.current = null;
      }
    })();
    startPromise.current = promise;
    return promise;
  }
  async function switchTab(next: Tab) {
    if (next === tab) return;
    transmitter.current?.stopLocal();
    if (attempted.current) await stopBroadcast();
    if (mounted.current && !attempted.current) {
      setWatching(null);
      setTab(next);
    }
  }
  const canStart =
    !!selected &&
    ["prepared", "awaiting_media", "unknown"].includes(selected.status) &&
    consent &&
    !busy &&
    !savingDestinations &&
    !!config?.configured;
  const watchedUrl =
    watching && verifiedLive(watching, clock)
      ? checkedLivePlayback(watching.playback_url)
      : null;
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={desktop ? workspace.page : [styles.page, { gap: 14 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.between}>
        <View style={[styles.row, { flex: 1, flexWrap: "wrap", gap: 7 }]}>
          <Pill title="Watch live" active={tab === "watch"} onPress={() => void switchTab("watch")} />
          <Pill title="Your broadcast" active={tab === "broadcast"} onPress={() => void switchTab("broadcast")} />
        </View>
        <IconButton icon={RefreshCw} label="Refresh live feeds" disabled={loading || !!busy} onPress={() => void refresh()} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, maxWidth: 360 }}>
        {[
          {
            title: "Calendar",
            Icon: CalendarClock,
            visible: true,
            open: () =>
              navigation.navigate("Calendar", {
                kind: "stream",
                streamId: selected?.id,
              }),
          },
          {
            title: "Recordings",
            Icon: Clapperboard,
            visible: !!session && !guest,
            open: () =>
              navigation.navigate("Recordings", { streamId: selected?.id }),
          },
          {
            title: "Updates",
            Icon: Bell,
            visible: !!session && !guest,
            open: () => navigation.navigate("Notifications"),
          },
        ]
          .filter((shortcut) => shortcut.visible)
          .map(({ title, Icon, open }) => (
            <Pressable
              key={title}
              accessibilityRole="button"
              accessibilityLabel={title}
              accessibilityState={{ disabled: !!busy || attempted.current }}
              disabled={!!busy || attempted.current}
              onPress={open}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 58,
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: color.border,
                backgroundColor: color.panel,
                opacity: busy || attempted.current || pressed ? 0.6 : 1,
              })}
            >
              <Icon size={20} color={color.text} />
              <Text
                style={{
                  fontFamily: font.medium,
                  fontSize: 11,
                  color: color.text,
                }}
              >
                {title}
              </Text>
            </Pressable>
          ))}
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!!transport && <Text style={styles.small}>{transport}</Text>}
      {tab === "watch" ? (
        <>
          {watching && (
            <View style={[styles.panel, desktop && workspace.panel]}>
              <Text style={styles.heading}>{watching.title}</Text>
              <Text style={styles.eyebrow}>
                {liveStatusLabel(watching, clock)}
              </Text>
              {watchedUrl && enabled ? (
                <LiveViewer key={watching.id} url={watchedUrl} />
              ) : (
                <Text style={styles.body}>
                  Checking playback…
                </Text>
              )}
              <Action
                title="Close player"
                secondary
                onPress={() => setWatching(null)}
              />
            </View>
          )}
          {publics.length === 0 ? (
            <Empty
              title="No live broadcasts right now"
              body="Broadcasts appear here once incoming video is confirmed."
            />
          ) : (
            publics.map((value) => (
              <View
                style={[styles.panel, desktop && workspace.panel]}
                key={value.id}
              >
                <Text style={styles.eyebrow}>
                  {liveStatusLabel(value, clock)}
                </Text>
                <Text style={styles.heading}>{value.title}</Text>
                <Text style={styles.body}>{value.description}</Text>
                <Action
                  title="Watch broadcast"
                  icon={Radio}
                  disabled={!verifiedLive(value, clock)}
                  onPress={() => {
                    setWatching(value);
                    watchingRef.current = value;
                    void refresh();
                  }}
                />
              </View>
            ))
          )}
        </>
      ) : guest || !session ? (
        <View style={[styles.panel, desktop && workspace.panel]}>
          <Text style={styles.heading}>Sign in to broadcast</Text>
          <Action
            title="Sign in or register"
            onPress={() => navigation.navigate("Login")}
          />
        </View>
      ) : (
        <>
          {config && !config.configured && (
            <View style={[styles.panel, desktop && workspace.panel]}>
              <HelpLabel
                label="Broadcasting unavailable"
                style={styles.heading}
                help="Refresh to check service availability. Camera and microphone stay off until you start a broadcast."
              />
            </View>
          )}
          {!selected ? (
            <View style={[styles.panel, desktop && workspace.panel]}>
              <Text style={styles.heading}>Prepare your live session</Text>
              <Field
                label="Broadcast title"
                value={title}
                onChangeText={setTitle}
                maxLength={140}
                editable={!createRequest.current}
                placeholder="What are you sharing live?"
              />
              <Field
                label="Description"
                value={description}
                onChangeText={setDescription}
                maxLength={1000}
                editable={!createRequest.current}
                multiline
                placeholder="Let your community know what to expect"
              />
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{
                  checked: record,
                  disabled: !!busy || !!createRequest.current,
                }}
                disabled={!!busy || !!createRequest.current}
                onPress={() => setRecord(!record)}
                style={[styles.row, { paddingVertical: 12 }]}
              >
                <View
                  style={{
                    width: 25,
                    height: 25,
                    borderWidth: 1,
                    borderColor: color.lime,
                    borderRadius: 6,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: record ? color.purple : "transparent",
                  }}
                >
                  {record && <Check size={18} color="white" />}
                </View>
                <Text style={[styles.body, { flex: 1 }]}>
                  Record as a private draft. I have permission to record.
                </Text>
              </Pressable>
              <HelpLabel label={record ? "Recording on" : "Recording off"}
                help="Confirm rights for participants, music and media before recording. Preparing sends no media. Your provider may retain a recording. Imports stay private until published." />
              <Action
                title={
                  createRequest.current
                    ? "Retry saved broadcast request"
                    : "Prepare broadcast"
                }
                icon={Plus}
                busy={busy === "prepare"}
                disabled={!config?.configured || !!busy}
                onPress={() => void prepare()}
              />
              {createRequest.current && (
                <Text style={styles.small}>
                  Use this same request if preparation is unconfirmed. Do not
                  start a second request; refresh the broadcast status first.
                </Text>
              )}
            </View>
          ) : (
            <>
              <View style={[styles.panel, desktop && workspace.panel]}>
                <Text style={styles.heading}>{selected.title}</Text>
                <Text
                  style={[
                    styles.eyebrow,
                    {
                      color: verifiedLive(selected, clock)
                        ? color.lime
                        : color.muted,
                    },
                  ]}
                >
                  {liveStatusLabel(selected, clock)}
                </Text>
                <Text style={styles.body}>{selected.detail}</Text>
                <Text style={styles.small}>
                  {selected.record
                    ? "Recording is on. Before going live, open Live & recordings to enable private saving and clips. The streaming service may keep its own recording."
                    : "Recording is off for this broadcast. Prepare a new broadcast with recording selected to create a recording; it cannot be added retroactively."}
                </Text>
              </View>
              {!["creating", "provisioning_unknown"].includes(
                selected.status,
              ) && (
                <LiveDestinations
                  broadcast={selected}
                  focused={enabled}
                  disabled={
                    !!busy || attempted.current || selected.status === "ended"
                  }
                  onConnections={() =>
                    navigation.navigate("Publishing", { tab: "connections" })
                  }
                  onSavingChange={setSavingDestinations}
                />
              )}
              {selected.status !== "ended" &&
                !["creating", "provisioning_unknown", "ending"].includes(
                  selected.status,
                ) && (
                  <>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: consent,
                        disabled: !!busy || attempted.current,
                      }}
                      onPress={() => setConsent(!consent)}
                      style={[styles.panel, styles.row]}
                      disabled={!!busy || attempted.current}
                    >
                      <View
                        style={{
                          width: 26,
                          height: 26,
                          borderColor: color.lime,
                          borderWidth: 1,
                          borderRadius: 6,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: consent
                            ? color.purple
                            : "transparent",
                        }}
                      >
                        {consent && <Check color="white" size={20} />}
                      </View>
                      <Text
                        style={[styles.body, { flex: 1, color: color.text }]}
                      >
                        I understand this broadcast is public. I have permission
                        to share the people, music and media shown.
                      </Text>
                    </Pressable>
                    <LiveTransmitter
                      key={selected.id}
                      ref={transmitter}
                      enabled={enabled}
                      busy={!!busy}
                      canStart={canStart}
                      onStart={begin}
                      onStop={stopBroadcast}
                      onTransport={report}
                    />
                    {
                      <Text style={styles.small}>
                        Leaving this screen or putting the app in the background
                        stops the camera and requests provider shutdown. A
                        network interruption can delay server confirmation.
                      </Text>
                    }
                  </>
                )}
              {selected.status !== "ended" && (
                <Action
                  title={
                    selected.status === "ending"
                      ? "Retry End broadcast"
                      : "End broadcast"
                  }
                  icon={Square}
                  danger
                  busy={busy === "end"}
                  disabled={!!busy && busy !== "start" && busy !== "end"}
                  onPress={() => void stopBroadcast()}
                />
              )}
              {selected.status === "ended" && (
                <Action
                  title="Prepare another broadcast"
                  icon={Plus}
                  onPress={() => {
                    choose(null);
                    createRequest.current = null;
                    setConsent(false);
                    setTransport("");
                    setTitle("");
                    setDescription("");
                    setRecord(false);
                  }}
                />
              )}
            </>
          )}
          {mine.length > 0 && (
            <View style={{ gap: 12 }}>
              <Text style={styles.heading}>Your broadcasts</Text>
              {mine.map((value) => (
                <Pressable
                  key={value.id}
                  accessibilityRole="button"
                  disabled={!!busy || attempted.current}
                  onPress={() => {
                    transmitter.current?.stopLocal();
                    choose(value);
                    setConsent(false);
                    setTransport("");
                  }}
                  style={[styles.panel, desktop && workspace.panel]}
                >
                  <Text
                    style={{
                      color: color.text,
                      fontFamily: font.semibold,
                      fontSize: 18,
                    }}
                  >
                    {value.title}
                  </Text>
                  <Text style={styles.small}>
                    {liveStatusLabel(value, clock)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
