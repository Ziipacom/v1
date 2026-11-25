import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
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
import {
  Bell,
  Check,
  Clapperboard,
  RefreshCw,
  Radio,
  Settings2,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "../components/ui";
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
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Your recordings could not be loaded. Refresh to try again.",
        );
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
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "This recording action could not complete.",
        );
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
        { width: "100%", maxWidth: 1440, alignSelf: "center" },
        desktop && { paddingHorizontal: 28 },
      ]}
    >
      <View style={[styles.between, { flexWrap: "wrap" }]}>
        {desktop ? (
          <Text style={[styles.heading, { fontSize: 26 }]}>
            Live & recordings
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Notification preferences"
            onPress={() =>
              navigation.navigate("Notifications", { tab: "Preferences" })
            }
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Bell size={21} color={color.muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Recording settings"
            onPress={() => setSettingsOpen(true)}
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Settings2 size={21} color={color.muted} />
          </Pressable>
          <Action
            secondary
            title="Refresh"
            icon={RefreshCw}
            disabled={busy}
            busy={loading}
            onPress={() => {
              if (tab === "Live now" || tab === "Events")
                setCatalogueRevision((value) => value + 1);
              else void load();
            }}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Action
          title="Broadcast"
          icon={Radio}
          onPress={() => navigation.navigate("Live", { tab: "broadcast" })}
        />
        <Action
          secondary
          title="Schedule"
          onPress={() => navigation.navigate("Calendar", { kind: "stream" })}
        />
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
      {!!error && <Notice error text={error} />}
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
          {config && !importsReady ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Recording service status"
              onPress={() => setServiceOpen(true)}
              style={{
                padding: 14,
                borderRadius: 12,
                backgroundColor: color.panel,
                borderWidth: 1,
                borderColor: color.border,
              }}
            >
              <Text style={styles.small}>
                Automatic saving is unavailable · View status ›
              </Text>
            </Pressable>
          ) : null}
          {tab === "Recordings" ? (
            <>
              {!loading && !receipts.length ? (
                <View
                  style={[
                    styles.panel,
                    { alignItems: "center", paddingVertical: 32 },
                  ]}
                >
                  <Clapperboard size={32} color={color.muted} />
                  <Text style={styles.heading}>No recordings yet</Text>
                  <Text style={[styles.small, { textAlign: "center" }]}>
                    Your saved broadcast recordings will appear here.
                  </Text>
                  <Action
                    secondary
                    title="Broadcast studio"
                    onPress={() =>
                      navigation.navigate("Live", { tab: "broadcast" })
                    }
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
              {!loading && !clips.length ? (
                <View
                  style={[
                    styles.panel,
                    { alignItems: "center", paddingVertical: 32 },
                  ]}
                >
                  <Clapperboard size={32} color={color.muted} />
                  <Text style={styles.heading}>No clips yet</Text>
                  <Text style={[styles.small, { textAlign: "center" }]}>
                    Open a recording to edit it, or choose Recording settings to
                    prepare private clips.
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
                    status={
                      clip.status === "ready"
                        ? "Private clip"
                        : clip.status.replace(/_/g, " ")
                    }
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
          <Text style={styles.small}>
            Select a broadcast to manage its private clips. Recording must be
            chosen before starting a broadcast.
          </Text>
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
              <Text style={styles.small}>{policy.detail}</Text>
              <Toggle
                title="Create private excerpts when this recording is imported"
                checked={enabled}
                disabled={busy || !stream.record}
                change={() => {
                  setEnabled(!enabled);
                  setConsent(false);
                }}
              />
              <DesktopGroup style={{ flexDirection: "row", gap: 12 }}>
                <DesktopGroup style={{ flex: 1, minWidth: 0 }}>
                  <Field
                    label="Number of excerpts (1–3)"
                    value={count}
                    onChangeText={(value) => {
                      setCount(value);
                      setConsent(false);
                    }}
                    keyboardType="number-pad"
                    editable={!busy}
                    maxLength={1}
                  />
                </DesktopGroup>
                <DesktopGroup style={{ flex: 1, minWidth: 0 }}>
                  <Field
                    label="Seconds per excerpt (15–90)"
                    value={seconds}
                    onChangeText={(value) => {
                      setSeconds(value);
                      setConsent(false);
                    }}
                    keyboardType="number-pad"
                    editable={!busy}
                    maxLength={2}
                  />
                </DesktopGroup>
              </DesktopGroup>
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
              <Text style={styles.small}>
                Clips use the first sequential portions of the recording.
                Formats fit the full frame with padding.
              </Text>
              {enabled && (
                <Toggle
                  title="I have the rights to this recording and consent to importing it and generating these private excerpts."
                  checked={consent}
                  disabled={busy}
                  change={() => setConsent(!consent)}
                />
              )}
              <Action
                title="Save recording settings"
                icon={Clapperboard}
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
                        "Recording settings saved. New recordings and clips stay private until you publish them.",
                      );
                    }
                  })
                }
              />
              <Action
                secondary
                title="Open broadcast controls"
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

          <Action
            secondary
            title="Service status"
            onPress={() => {
              setSettingsOpen(false);
              setServiceOpen(true);
            }}
          />
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
              <Action
                secondary
                title="Close preview"
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
                <Text style={styles.eyebrow}>
                  {recordingStatus(receipt)}
                </Text>
                <Text style={styles.body}>{receipt.detail}</Text>
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
                  <DesktopGroup
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}
                  >
                    <Action
                      secondary
                      title="Preview imported recording (source)"
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
                      title="Edit full recording"
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
                  </DesktopGroup>
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
                      {clip.status}
                    </Text>
                    <Text style={styles.small}>{clip.detail}</Text>
                    <DesktopGroup
                      style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: 10,
                      }}
                    >
                      {clip.status === "ready" && clip.render_id && (
                        <Action
                          title="Preview exported clip"
                          secondary
                          disabled={busy}
                          onPress={() =>
                            void run((valid) => clipPreview(clip, valid))
                          }
                        />
                      )}
                      <Action
                        title="Review clip in editor"
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
                        title="Create a publication campaign"
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
                    </DesktopGroup>
                    <Text style={styles.small}>
                      Your clip stays private and editable. Review its rendered
                      version and approve sharing in Campaigns.
                    </Text>
                  </View>
                ))}
                {["blocked", "failed"].includes(receipt.status) && (
                  <Action
                    secondary
                    title="Retry recording import"
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
                    title="Cancel pending recording work"
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
