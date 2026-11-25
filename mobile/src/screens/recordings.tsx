import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bell,
  Check,
  Clapperboard,
  RefreshCw,
  Radio,
  Settings2,
  CalendarDays,
  Play,
  Pencil,
  Send,
  X,
  Info,
} from "lucide-react-native";
import {
  Action,
  Cover,
  Field,
  IconButton,
  Notice,
  Pill,
} from "../components/ui";
import { Sheet } from "../components/floating";
import { LibraryGrid } from "../components/personal-library";
import {
  BroadcastEvents,
  BroadcastTile,
  LiveCatalogue,
} from "../components/broadcast-catalogue";
import { horizontalMouseDrag } from "../lib/horizontal-mouse-drag";
import { Platform } from "react-native";
import { InfoTip } from "../components/info-tip";
import { MediaPlayer } from "../components/player";
import { useDesktopLayout } from "../components/desktop-layout";
import { useZiipa } from "../provider";
import { creatorRequest } from "../lib/creator-request";
import { useOperationScope } from "../lib/use-operation-scope";
import { campaignFormats, type CampaignRendition } from "../lib/campaign-types";
import {
  recordingAutomationInput,
  recordingClipPreview,
  recordingNeedsPolling,
  recordingRoot,
  type RecordingAutomation,
  type RecordingClip,
  type RecordingConfig,
  type RecordingReceipt,
} from "../lib/recording-types";
import type { LiveBroadcast } from "../lib/live-types";
import type { RenderJob } from "../lib/render-types";
import type { MediaExport } from "../lib/share-types";
import type { Bootstrap, Item, RootStack } from "../lib/types";
import { color, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Recordings">;

export function recordingScreenError(cause: unknown, loading = false) {
  const error = cause as { status?: number; outcome?: string } | null;
  if (error?.outcome === "unconfirmed")
    return "This change was not confirmed. Refresh the recording before trying again.";
  if (error?.status === 401) return "Sign in again to view your recordings.";
  if (error?.status === 403)
    return "This recording action is unavailable for your account.";
  if (error?.status === 409)
    return "This recording changed. Refresh before trying again.";
  if (error?.status === 413)
    return "This recording exceeds the supported size.";
  if (error?.status === 429) return "Please wait a moment before trying again.";
  if (error?.status === 503)
    return "Recording processing is unavailable right now.";
  const local = cause instanceof Error ? cause.message : "";
  if (local === "Choose between one and three excerpts.")
    return "Choose 1–3 clips.";
  if (local === "Each excerpt must be 15 to 90 seconds.")
    return "Choose a clip length of 15–90 seconds.";
  return loading
    ? "Recordings could not be loaded. Refresh to try again."
    : "That recording action could not be completed. Refresh and try again.";
}
export function recordingClipState(status: string) {
  return (
    (
      {
        ready: "Private clip",
        queued: "Queued",
        processing: "Processing",
        blocked: "Needs attention",
        failed: "Needs attention",
        stale: "Needs review",
        cancelled: "Cancelled",
      } as Record<string, string>
    )[status] || "Status unavailable"
  );
}
export function recordingDetail(status: string) {
  return (
    (
      {
        ready: "Saved privately in your library.",
        queued: "Waiting to import this recording.",
        processing: "Saving the recording to your private library.",
        blocked: "Import needs attention. Check availability before retrying.",
        failed: "Import could not finish. Check availability before retrying.",
        cancelled: "Pending recording work was cancelled.",
      } as Record<string, string>
    )[status] || "Refresh to check this recording."
  );
}
function RecordingState({
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

function Toggle({
  title,
  checked,
  disabled,
  change,
}: {
  title: string;
  checked: boolean;
  disabled: boolean;
  change: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={change}
      style={[styles.row, { paddingVertical: 8 }]}
    >
      <View
        style={{
          width: 25,
          height: 25,
          borderColor: color.lime,
          borderWidth: 1,
          borderRadius: 6,
          backgroundColor: checked ? color.purple : "transparent",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {checked && <Check color="white" size={18} />}
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{title}</Text>
    </Pressable>
  );
}
export function RecordingsScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedRecordingsScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.streamId || ""}`}
      {...props}
    />
  );
}
function ScopedRecordingsScreen({ navigation, route }: Props) {
  const { api, session, guest } = useZiipa();
  const { desktop } = useDesktopLayout();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const active = focused && foreground;
  const [config, setConfig] = useState<RecordingConfig | null>(null);
  const [streams, setStreams] = useState<LiveBroadcast[]>([]);
  const [streamId, setStreamId] = useState<string | null>(
    route.params?.streamId || null,
  );
  const [policy, setPolicy] = useState<RecordingAutomation | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [count, setCount] = useState("1");
  const [seconds, setSeconds] = useState("30");
  const [rendition, setRendition] = useState<CampaignRendition>("portrait");
  const [receipts, setReceipts] = useState<RecordingReceipt[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState<{ item: Item; label: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<
    "Live now" | "Events" | "Recordings" | "Clips"
  >("Recordings");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(
    null,
  );
  const tabScroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !active) return;
    const node = tabScroll.current?.getScrollableNode() as HTMLElement | null;
    return node ? horizontalMouseDrag(node) : undefined;
  }, [active]);
  const mutation = useRef(false);
  const capture = useOperationScope(
    `${session?.access_token || "guest"}:${streamId || "all"}`,
    active,
  );
  const stream = streams.find((value) => value.id === streamId);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (value) =>
      setForeground(value === "active"),
    );
    return () => listener.remove();
  }, []);
  const load = useCallback(async () => {
    if (!session || guest || mutation.current) return;
    const valid = capture();
    setLoading(true);
    try {
      const [configuration, owned, list, bootstrap, automation] =
        await Promise.all([
          api<RecordingConfig>(`${recordingRoot}/config`),
          api<LiveBroadcast[]>("/api/live/streams"),
          api<RecordingReceipt[]>(
            `${recordingRoot}${streamId ? `?stream_id=${encodeURIComponent(streamId)}` : ""}`,
          ),
          api<Bootstrap>("/api/creator/bootstrap"),
          streamId
            ? api<RecordingAutomation>(
                `/api/live/streams/${streamId}/recording-automation`,
              )
            : Promise.resolve(null),
        ]);
      if (!valid()) return;
      setConfig(configuration);
      setStreams(owned);
      setReceipts(list);
      setItems(
        [...bootstrap.drafts, ...bootstrap.items].filter(
          (item) =>
            !item.demo &&
            item.creator_id === session.user.id &&
            item.visibility !== "hidden",
        ),
      );
      setPolicy(automation);
      setEnabled(automation?.enabled || false);
      setConsent(false);
      setCount(String(automation?.clip_count || 1));
      setSeconds(String(automation?.clip_seconds || 30));
      setRendition(automation?.rendition || "portrait");
      setError("");
    } catch (cause) {
      if (valid()) setError(recordingScreenError(cause, true));
    } finally {
      if (valid()) setLoading(false);
    }
  }, [api, capture, guest, session, streamId]);
  useEffect(() => {
    setPreview(null);
    setPolicy(null);
    setConsent(false);
    if (active) void load();
  }, [active, load]);
  const processing = recordingNeedsPolling(receipts);
  useEffect(() => {
    if (!active || !processing || !session || guest) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!mutation.current) {
        const valid = capture();
        try {
          const list = await api<RecordingReceipt[]>(
            `${recordingRoot}${streamId ? `?stream_id=${encodeURIComponent(streamId)}` : ""}`,
          );
          if (!stopped && valid()) setReceipts(list);
        } catch {
          /* Keep actual last receipt; explicit refresh reports failures. */
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), 10000);
    };
    timer = setTimeout(() => void tick(), 10000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, api, capture, guest, processing, session, streamId]);
  async function run(action: (valid: () => boolean) => Promise<void>) {
    if (mutation.current || loading || !session) return;
    mutation.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action(valid);
    } catch (cause) {
      if (valid()) setError(recordingScreenError(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function ownedItem(id: string, valid: () => boolean) {
    const bootstrap = await api<Bootstrap>("/api/creator/bootstrap");
    if (!valid())
      throw new Error("Your account or recording selection changed.");
    const item = [...bootstrap.drafts, ...bootstrap.items].find(
      (value) =>
        value.id === id &&
        value.creator_id === session?.user.id &&
        !value.demo &&
        value.visibility !== "hidden",
    );
    if (!item)
      throw new Error(
        "This recording's owned creation is unavailable. Refresh before continuing.",
      );
    setItems((previous) => [
      item,
      ...previous.filter((value) => value.id !== id),
    ]);
    return item;
  }
  async function clipPreview(clip: RecordingClip, valid: () => boolean) {
    const item = await ownedItem(clip.item_id, valid);
    const [job, info] = await Promise.all([
      api<RenderJob>(`/api/render/jobs/${clip.render_id}`),
      api<MediaExport>(`/api/render/jobs/${clip.render_id}/export`, {}),
    ]);
    if (valid())
      setPreview({
        item: recordingClipPreview(item, clip, job, info),
        label: "Actual rendered clip · private MP4",
      });
  }
  if (!session || guest)
    return (
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.page}
      >
        <Notice text="Sign in to view your private recordings." />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </ScrollView>
    );
  const importsReady = !!(
    config?.enabled &&
    config.webhook_configured &&
    config.worker_ready
  );
  const recordingStatus = (receipt: RecordingReceipt) =>
    ({
      ready: "Private recording",
      queued: "Queued",
      processing: "Processing",
      blocked: "Needs attention",
      failed: "Needs attention",
      cancelled: "Cancelled",
    })[receipt.status];
  const tileCover = (itemId: string | null) => {
    const item = items.find((value) => value.id === itemId);
    return item ? (
      <Cover item={item} style={{ width: "100%", height: "100%" }} />
    ) : (
      <Clapperboard size={32} color={color.muted} />
    );
  };
  const chooseReceipt = (id: string) => {
    setPreview(null);
    setSelectedReceiptId(id);
  };
  const clips = receipts.flatMap((receipt) =>
    receipt.clips.map((clip, index) => ({ receipt, clip, index })),
  );
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={[
        styles.page,
        { width: "100%", maxWidth: 1280, alignSelf: "center", gap: 16 },
        desktop && { paddingHorizontal: 28 },
      ]}
    >
      <View style={styles.between}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.heading, { fontSize: desktop ? 26 : 20 }]}>
            Live & recordings
          </Text>
          <Text style={styles.small}>Broadcasts, recordings and clips</Text>
        </View>
        <IconButton
          label="Recording settings"
          icon={Settings2}
          disabled={busy}
          onPress={() => setSettingsOpen(true)}
        />
        <IconButton
          label="Refresh recordings"
          icon={RefreshCw}
          disabled={busy || loading}
          onPress={() => {
            if (tab === "Live now" || tab === "Events")
              setCatalogueRevision((value) => value + 1);
            else void load();
          }}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {[
          { title: "Recordings", value: config ? receipts.length : "—" },
          { title: "Clips", value: config ? clips.length : "—" },
          {
            title: "Processing",
            value: config
              ? receipts.filter(
                  (receipt) =>
                    receipt.status === "queued" ||
                    receipt.status === "processing",
                ).length
              : "—",
          },
        ].map((metric) => (
          <View
            key={metric.title}
            style={{
              flex: 1,
              padding: 12,
              borderWidth: 1,
              borderColor: color.border,
              borderRadius: 12,
              backgroundColor: color.panel,
            }}
          >
            <Text style={[styles.heading, { fontSize: 21 }]}>
              {metric.value}
            </Text>
            <Text style={styles.small}>{metric.title}</Text>
          </View>
        ))}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Action
            title="Broadcast"
            icon={Radio}
            onPress={() => navigation.navigate("Live", { tab: "broadcast" })}
          />
          <Action
            secondary
            title="Schedule"
            icon={CalendarDays}
            onPress={() => navigation.navigate("Calendar", { kind: "stream" })}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recording service status"
          onPress={() => setServiceOpen(true)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            minHeight: 44,
          }}
        >
          <RecordingState
            label={
              config
                ? importsReady
                  ? "Auto-save ready"
                  : "Auto-save unavailable"
                : loading
                  ? "Checking service"
                  : "Status unavailable"
            }
            active={importsReady}
          />
          <Info size={17} color={color.muted} />
        </Pressable>
      </View>
      <ScrollView
        ref={tabScroll}
        horizontal
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="handled"
        style={{ flexGrow: 0, width: "100%" }}
        contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
      >
        {(["Live now", "Events", "Recordings", "Clips"] as const).map(
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
      {!!error && !settingsOpen && !selectedReceiptId && (
        <Notice error text={error} />
      )}
      {!!message && <Notice text={message} />}
      {tab === "Live now" ? (
        <LiveCatalogue
          key={catalogueRevision}
          active={active}
          open={(id) =>
            navigation.navigate("Live", { tab: "watch", watchId: id })
          }
          prepare={() => navigation.navigate("Live", { tab: "broadcast" })}
        />
      ) : null}
      {tab === "Events" ? (
        <BroadcastEvents
          key={catalogueRevision}
          active={active}
          open={(id) => navigation.navigate("Calendar", { eventId: id })}
          create={() => navigation.navigate("Calendar", { kind: "stream" })}
        />
      ) : null}
      {tab === "Recordings" || tab === "Clips" ? (
        <>
          <View style={[styles.between, { flexWrap: "wrap" }]}>
            <Text style={styles.small}>
              {tab === "Recordings"
                ? `${receipts.length} ${receipts.length === 1 ? "recording" : "recordings"}`
                : `${clips.length} ${clips.length === 1 ? "clip" : "clips"}`}
              {stream ? ` · ${stream.title}` : ""} · Private
            </Text>
            <InfoTip
              title="Private recordings and clips"
              content="Saving or editing a recording does not publish it. Review the creation and choose Publish Creation when you want to make it visible on Ziipa."
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Filter recordings by broadcast"
              onPress={() => setSettingsOpen(true)}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={[styles.small, { color: color.text }]}>
                {stream ? "Change broadcast" : "All broadcasts"} ▾
              </Text>
            </Pressable>
          </View>
          {tab === "Recordings" ? (
            <>
              {!loading && !error && !receipts.length ? (
                <View
                  style={[
                    styles.panel,
                    { alignItems: "center", paddingVertical: 32 },
                  ]}
                >
                  <Clapperboard size={32} color={color.muted} />
                  <Text style={[styles.heading, { fontSize: 20 }]}>
                    No recordings yet
                  </Text>
                  <Text style={[styles.small, { textAlign: "center" }]}>
                    Your saved broadcast recordings will appear here.
                  </Text>
                  <InfoTip
                    title="Saving a broadcast"
                    content="Choose recording in Broadcast before you go live. Completed recordings are imported only when the recording service is available. Saving and editing do not publish your media."
                  />
                </View>
              ) : null}
              <LibraryGrid>
                {receipts.map((receipt) => (
                  <BroadcastTile
                    key={receipt.id}
                    title={receipt.title}
                    status={recordingStatus(receipt)}
                    detail={`${new Date(receipt.created_at).toLocaleDateString()}${receipt.duration != null ? ` · ${Math.round(receipt.duration / 60)} min` : ""}`}
                    label={`Open recording ${receipt.title}`}
                    onPress={() => chooseReceipt(receipt.id)}
                  >
                    {tileCover(receipt.item_id)}
                  </BroadcastTile>
                ))}
              </LibraryGrid>
            </>
          ) : (
            <>
              {!loading && !error && !clips.length ? (
                <View
                  style={[
                    styles.panel,
                    { alignItems: "center", paddingVertical: 32 },
                  ]}
                >
                  <Clapperboard size={32} color={color.muted} />
                  <Text style={[styles.heading, { fontSize: 20 }]}>
                    No clips yet
                  </Text>
                  <Text style={[styles.small, { textAlign: "center" }]}>
                    Create private clips from your recordings.
                  </Text>
                </View>
              ) : null}
              <LibraryGrid>
                {clips.map(({ receipt, clip, index }) => (
                  <BroadcastTile
                    key={`${receipt.id}:${clip.item_id}`}
                    title={
                      items.find((item) => item.id === clip.item_id)?.title ||
                      `${receipt.title} · Clip ${index + 1}`
                    }
                    detail={`${clip.end - clip.start}s · ${clip.rendition}`}
                    status={recordingClipState(clip.status)}
                    label={`Open clip ${index + 1} from ${receipt.title}`}
                    onPress={() => chooseReceipt(receipt.id)}
                  >
                    {tileCover(clip.item_id)}
                  </BroadcastTile>
                ))}
              </LibraryGrid>
            </>
          )}
        </>
      ) : null}
      {settingsOpen ? (
        <Sheet
          title="Recording settings"
          onClose={() => setSettingsOpen(false)}
          maxWidth={760}
        >
          <Text style={styles.label}>Broadcast</Text>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            <Pill
              title="All broadcasts"
              active={!streamId}
              onPress={() => {
                if (!busy) {
                  setStreamId(null);
                  setSelectedReceiptId(null);
                }
              }}
            />
            {streams.map((value) => (
              <Pill
                key={value.id}
                title={value.title}
                active={streamId === value.id}
                onPress={() => {
                  if (!busy) {
                    setStreamId(value.id);
                    setSelectedReceiptId(null);
                  }
                }}
              />
            ))}
          </View>
          <InfoTip
            title="Recording choices"
            content="Select a broadcast to manage its private clips. Recording must be chosen before starting that broadcast. Automatic clips use its first sequential portions; formats contain the full frame with padding. No recording or clip is published automatically."
          />
          {!!error && <Notice error text={error} />}
          {!!message && <Notice text={message} />}
          {stream && policy && (
            <View
              style={[
                styles.panel,
                desktop && { padding: 17, borderRadius: 12 },
              ]}
            >
              <Text style={[styles.heading, desktop && { fontSize: 17 }]}>
                Automatic private clips
              </Text>
              <Text style={styles.body}>
                {stream.title} · recording {stream.record ? "enabled" : "off"}
              </Text>
              <RecordingState
                label={
                  policy.enabled ? "Automatic clips on" : "Automatic clips off"
                }
                active={policy.enabled}
              />
              <Toggle
                title="Create clips automatically"
                checked={enabled}
                disabled={busy || !stream.record}
                change={() => {
                  setEnabled(!enabled);
                  setConsent(false);
                }}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                <View style={{ flex: 1, minWidth: 110 }}>
                  <Field
                    label="Clips (1-3)"
                    value={count}
                    onChangeText={(value) => {
                      setCount(value);
                      setConsent(false);
                    }}
                    keyboardType="number-pad"
                    editable={!busy}
                    maxLength={1}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 110 }}>
                  <Field
                    label="Length (15-90s)"
                    value={seconds}
                    onChangeText={(value) => {
                      setSeconds(value);
                      setConsent(false);
                    }}
                    keyboardType="number-pad"
                    editable={!busy}
                    maxLength={2}
                  />
                </View>
              </View>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {campaignFormats.map((format) => (
                  <Pill
                    key={format.id}
                    title={format.title}
                    active={rendition === format.id}
                    onPress={() => {
                      if (!busy) {
                        setRendition(format.id);
                        setConsent(false);
                      }
                    }}
                  />
                ))}
              </View>
              <InfoTip
                title="Automatic private clips"
                content="Ziipa imports this recording and creates clips from its first sequential portions, using the length and format you choose. Your rights approval is required. Clips stay private and editable until you separately approve publishing."
              />
              {enabled && (
                <Toggle
                  title="I can use this recording and approve private import and clips."
                  checked={consent}
                  disabled={busy}
                  change={() => setConsent(!consent)}
                />
              )}
              <Action
                title="Save settings"
                icon={Check}
                disabled={
                  busy ||
                  (enabled && (!config?.enabled || !stream.record || !consent))
                }
                onPress={() =>
                  void run(async (valid) => {
                    const fields = recordingAutomationInput(
                      policy,
                      { enabled, consent, count, seconds, rendition },
                      stream.record,
                    );
                    const result = await creatorRequest<RecordingAutomation>(
                      `/api/live/streams/${stream.id}/recording-automation`,
                      session.access_token,
                      "PUT",
                      fields,
                    );
                    if (valid()) {
                      setPolicy(result);
                      setConsent(false);
                      setMessage(
                        "Settings saved. Recordings and clips stay private.",
                      );
                    }
                  })
                }
              />
              <Action
                secondary
                title="Broadcast controls"
                icon={Radio}
                disabled={busy}
                onPress={() => {
                  setSettingsOpen(false);
                  navigation.navigate("Live", {
                    tab: "broadcast",
                    streamId: stream.id,
                  });
                }}
              />
            </View>
          )}

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <InfoTip
              title="Recording availability"
              content="Imports depend on recording events and media processing. Check status for current availability. Your originals and existing private recordings are unchanged when automatic saving is unavailable."
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View recording service status"
              onPress={() => {
                setSettingsOpen(false);
                setServiceOpen(true);
              }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={styles.small}>View status</Text>
            </Pressable>
            <IconButton
              icon={Bell}
              label="Notification preferences"
              onPress={() => {
                setSettingsOpen(false);
                navigation.navigate("Notifications", { tab: "Preferences" });
              }}
            />
          </View>
        </Sheet>
      ) : null}
      {serviceOpen ? (
        <Sheet
          title="Recording service"
          onClose={() => setServiceOpen(false)}
          maxWidth={620}
        >
          <Text style={styles.heading}>
            {importsReady
              ? "Ready to save recordings"
              : "Automatic saving unavailable"}
          </Text>
          <Text style={styles.body}>
            {importsReady
              ? "Completed broadcast recordings can be saved to your private library."
              : "Automatic saving is unavailable right now. You can still open existing recordings and use the editor."}
          </Text>
          {config ? (
            <View style={{ gap: 10 }}>
              <Text style={styles.small}>
                Automatic saving: {config.enabled ? "Enabled" : "Not enabled"}
              </Text>
              <Text style={styles.small}>
                Recording updates:{" "}
                {config.webhook_configured ? "Enabled" : "Unavailable"}
              </Text>
              <Text style={styles.small}>
                Media processing:{" "}
                {config.worker_ready ? "Available" : "Unavailable"}
              </Text>
              <Text style={styles.small}>
                Recording limits: {Math.round(config.max_bytes / 1024 / 1024)}{" "}
                MB · {Math.round(config.max_duration_seconds / 60)} minutes
              </Text>
            </View>
          ) : (
            <Text style={styles.small}>
              Service status could not be loaded. Refresh to try again.
            </Text>
          )}
          <Text style={styles.small}>
            Recordings and clips remain private until you choose to publish
            them. Live broadcasting has separate availability.
          </Text>
        </Sheet>
      ) : null}
      {selectedReceiptId ? (
        <Sheet
          title="Recording details"
          onClose={() => {
            setSelectedReceiptId(null);
            setPreview(null);
          }}
          maxWidth={900}
        >
          {!!error && <Notice error text={error} />}
          {preview && (
            <View
              style={[
                styles.panel,
                desktop && { padding: 20, borderRadius: 12 },
              ]}
            >
              <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
                {preview.label}
              </Text>
              <Text style={styles.body}>{preview.item.title}</Text>
              <MediaPlayer
                key={`${preview.item.id}:${preview.item.media_id}`}
                item={preview.item}
              />
              <IconButton
                icon={X}
                label="Close preview"
                onPress={() => setPreview(null)}
              />
            </View>
          )}
          {receipts
            .filter((receipt) => receipt.id === selectedReceiptId)
            .map((receipt) => (
              <View
                key={receipt.id}
                style={[
                  styles.panel,
                  desktop && { padding: 20, borderRadius: 12 },
                ]}
              >
                <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
                  {receipt.title}
                </Text>
                <Text style={styles.eyebrow}>{recordingStatus(receipt)}</Text>
                <Text style={styles.small}>
                  {recordingDetail(receipt.status)}
                </Text>
                <Text style={styles.small}>
                  {new Date(receipt.created_at).toLocaleString()}
                  {receipt.duration != null
                    ? ` · ${receipt.duration.toFixed(1)}s`
                    : ""}
                  {receipt.size != null
                    ? ` · ${(receipt.size / 1024 / 1024).toFixed(1)} MiB`
                    : ""}
                </Text>
                {receipt.item_id && receipt.status === "ready" && (
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}
                  >
                    <Action
                      secondary
                      title="Preview"
                      icon={Play}
                      disabled={busy}
                      onPress={() =>
                        void run(async (valid) => {
                          const item = await ownedItem(receipt.item_id!, valid);
                          if (valid())
                            setPreview({
                              item,
                              label:
                                "Private imported source · not a rendered clip",
                            });
                        })
                      }
                    />
                    <Action
                      secondary
                      title="Edit recording"
                      icon={Pencil}
                      disabled={busy}
                      onPress={() =>
                        void run(async (valid) => {
                          const item = await ownedItem(receipt.item_id!, valid);
                          if (valid()) {
                            setSelectedReceiptId(null);
                            setPreview(null);
                            navigation.navigate("Composer", { item });
                          }
                        })
                      }
                    />
                  </View>
                )}
                {receipt.clips.map((clip) => (
                  <View
                    key={clip.item_id}
                    style={{
                      gap: 10,
                      borderTopWidth: 1,
                      borderColor: color.border,
                      paddingTop: 15,
                    }}
                  >
                    <Text style={styles.body}>
                      Excerpt {clip.start}s–{clip.end}s · {clip.rendition} ·{" "}
                      {recordingClipState(clip.status)}
                    </Text>
                    <View
                      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                    >
                      {clip.status === "ready" && clip.render_id && (
                        <Action
                          title="Preview"
                          icon={Play}
                          secondary
                          disabled={busy}
                          onPress={() =>
                            void run((valid) => clipPreview(clip, valid))
                          }
                        />
                      )}
                      <Action
                        title="Edit clip"
                        icon={Pencil}
                        secondary
                        disabled={busy}
                        onPress={() =>
                          void run(async (valid) => {
                            const item = await ownedItem(clip.item_id, valid);
                            if (valid()) {
                              setSelectedReceiptId(null);
                              setPreview(null);
                              navigation.navigate("Composer", { item });
                            }
                          })
                        }
                      />
                      <Action
                        title="Campaign"
                        icon={Send}
                        disabled={busy || clip.status !== "ready"}
                        onPress={() =>
                          void run(async (valid) => {
                            await ownedItem(clip.item_id, valid);
                            if (valid()) {
                              setSelectedReceiptId(null);
                              setPreview(null);
                              navigation.navigate("Campaigns", {
                                itemId: clip.item_id,
                              });
                            }
                          })
                        }
                      />
                    </View>
                    <InfoTip
                      title="Review before sharing"
                      content="This clip stays private and editable. Preview checks the real rendered MP4. Edit opens the saved creation; Campaign opens a separate review and approval flow and never publishes automatically."
                    />
                  </View>
                ))}
                {["blocked", "failed"].includes(receipt.status) && (
                  <Action
                    secondary
                    title="Retry import"
                    icon={RefreshCw}
                    disabled={busy || !config?.worker_ready}
                    onPress={() =>
                      void run(async (valid) => {
                        const result = await api<RecordingReceipt>(
                          `${recordingRoot}/${receipt.id}/retry`,
                          { revision: receipt.revision },
                        );
                        if (valid())
                          setReceipts((previous) =>
                            previous.map((value) =>
                              value.id === result.id ? result : value,
                            ),
                          );
                      })
                    }
                  />
                )}
                {["queued", "processing"].includes(receipt.status) && (
                  <Action
                    secondary
                    title="Cancel work"
                    icon={X}
                    disabled={busy}
                    onPress={() =>
                      void run(async (valid) => {
                        const result = await api<RecordingReceipt>(
                          `${recordingRoot}/${receipt.id}/cancel`,
                          { revision: receipt.revision },
                        );
                        if (valid())
                          setReceipts((previous) =>
                            previous.map((value) =>
                              value.id === result.id ? result : value,
                            ),
                          );
                      })
                    }
                  />
                )}
              </View>
            ))}
        </Sheet>
      ) : null}
    </ScrollView>
  );
}
