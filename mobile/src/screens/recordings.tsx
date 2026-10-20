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
import { Bell, Check, Clapperboard, RefreshCw } from "lucide-react-native";
import { Action, Field, Notice, Pill } from "../components/ui";
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
  const { desktop, contentWidth } = useDesktopLayout();
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
            : "Your private recording receipts could not be loaded.",
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
      <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
        <Notice text="Sign in to view private recordings. No broadcasts, recordings or clips are created in sample mode." />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </ScrollView>
    );
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.page,
        desktop && {
          width: "100%",
          maxWidth: 1480,
          alignSelf: "center",
          paddingHorizontal: 28,
          paddingTop: 24,
          gap: 20,
        },
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {desktop ? (
        <View
          style={[
            styles.between,
            { flexWrap: "wrap", alignItems: "flex-start", gap: 16 },
          ]}
        >
          <View style={{ flex: 1, minWidth: 220, gap: 5 }}>
            <Text style={[styles.heading, { fontSize: 25 }]}>
              Recordings & clips
            </Text>
            <Text style={styles.small}>
              Private recordings, excerpt workflows and processing receipts.
            </Text>
          </View>
          <View style={[styles.row, { gap: 8, flexWrap: "wrap" }]}>
            <Action
              secondary
              title="Notifications"
              icon={Bell}
              disabled={busy}
              onPress={() => navigation.navigate("Notifications")}
            />
            <Action
              secondary
              title="Refresh"
              icon={RefreshCw}
              disabled={busy}
              busy={loading}
              onPress={() => void load()}
            />
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.eyebrow}>LIVE → RECORDING → REVIEW</Text>
          <Text style={styles.title}>Keep the moment.</Text>
          <Notice text="Recordings and clips are private Ziipa drafts. Automatic excerpts never publish, post to social networks or start another stream. Provider recording retention and access are separate from Ziipa privacy." />
          <Action
            secondary
            title="Notification preferences"
            icon={Bell}
            disabled={busy}
            onPress={() => navigation.navigate("Notifications")}
          />
        </>
      )}
      {desktop && (
        <Text style={[styles.small, { color: "#A28CB6" }]}>
          Recordings and excerpts stay private in Ziipa. Automatic processing
          never publishes or starts another stream; provider retention is
          separate.
        </Text>
      )}
      {desktop && !!error && <Notice text={error} error />}
      {desktop && !!message && <Notice text={message} />}
      <DesktopGroup
        style={{
          flexDirection: contentWidth >= 780 ? "row" : "column",
          alignItems: "flex-start",
          gap: 22,
        }}
      >
        <DesktopGroup
          style={{
            width:
              contentWidth >= 780 ? (contentWidth >= 1200 ? 320 : 270) : "100%",
            gap: 18,
          }}
        >
          {config && (
            <View
              style={[
                styles.panel,
                desktop && { padding: 17, borderRadius: 12 },
              ]}
            >
              <Text style={[styles.heading, desktop && { fontSize: 17 }]}>
                Recording readiness
              </Text>
              <Text
                style={[
                  styles.body,
                  desktop && { fontSize: 13, lineHeight: 20 },
                ]}
              >
                {config.detail}
              </Text>
              <Text style={styles.small}>
                Import {config.enabled ? "enabled" : "disabled"} · webhook{" "}
                {config.webhook_configured ? "configured" : "needs setup"} ·
                worker {config.worker_ready ? "ready" : "not ready"}. Up to{" "}
                {Math.round(config.max_bytes / 1024 / 1024)} MiB /{" "}
                {Math.round(config.max_duration_seconds / 60)} minutes. This is
                configuration readiness, not proof that a public livestream
                succeeded.
              </Text>
            </View>
          )}
          {!desktop && !!error && <Notice text={error} error />}
          {!desktop && !!message && <Notice text={message} />}
          <View
            style={[styles.panel, desktop && { padding: 17, borderRadius: 12 }]}
          >
            <Text style={[styles.heading, desktop && { fontSize: 17 }]}>
              {desktop ? "Broadcast filter" : "Your broadcast recordings"}
            </Text>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              <Pill
                title="All recordings"
                active={!streamId}
                onPress={() => {
                  if (!busy) setStreamId(null);
                }}
              />
              {streams.map((value) => (
                <Pill
                  key={value.id}
                  title={value.title}
                  active={streamId === value.id}
                  onPress={() => {
                    if (!busy) setStreamId(value.id);
                  }}
                />
              ))}
            </View>
            <Text style={styles.small}>
              Recording is selected when preparing a broadcast. It cannot be
              enabled retroactively for a stream created without recording.
            </Text>
          </View>
          {stream && policy && (
            <View
              style={[
                styles.panel,
                desktop && { padding: 17, borderRadius: 12 },
              ]}
            >
              <Text style={[styles.heading, desktop && { fontSize: 17 }]}>
                Private excerpt automation
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
                Excerpts are the first sequential portions of the recording, not
                AI-selected highlights. Formats fit the frame with padding; they
                do not crop people or objects.
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
                title="Save private recording workflow"
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
                        "Recording workflow saved. Outputs stay private; review a rendered clip in Campaigns before approving publication.",
                      );
                    }
                  })
                }
              />
              <Action
                secondary
                title="Open this broadcast's manual live controls"
                disabled={busy}
                onPress={() =>
                  navigation.navigate("Live", {
                    tab: "broadcast",
                    streamId: stream.id,
                  })
                }
              />
            </View>
          )}
        </DesktopGroup>
        <DesktopGroup style={{ flex: 1, width: "100%", minWidth: 0, gap: 18 }}>
          {desktop && (
            <View style={[styles.between, { flexWrap: "wrap", gap: 10 }]}>
              <Text style={[styles.heading, { fontSize: 18 }]}>
                Recording library
              </Text>
              <Text style={styles.small}>
                {loading
                  ? "Refreshing…"
                  : `${receipts.length} import receipts · ${receipts.reduce((sum, receipt) => sum + receipt.clips.length, 0)} excerpts`}
              </Text>
            </View>
          )}
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
          {receipts.length === 0 &&
            !loading &&
            (desktop ? (
              <View
                style={{
                  minHeight: 265,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: "#513861",
                  borderRadius: 14,
                  padding: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 14,
                }}
              >
                <Clapperboard size={34} color="#B392D4" strokeWidth={1.3} />
                <Text
                  style={[
                    styles.heading,
                    { fontSize: 20, textAlign: "center" },
                  ]}
                >
                  No imported recordings yet
                </Text>
                <Text
                  style={[styles.small, { textAlign: "center", maxWidth: 390 }]}
                >
                  Recording-enabled broadcasts appear after a verified provider
                  event and worker import. Nothing is created from this page
                  automatically.
                </Text>
                <Action
                  secondary
                  title="Open live controls"
                  onPress={() =>
                    navigation.navigate("Live", { tab: "broadcast" })
                  }
                />
              </View>
            ) : (
              <Notice text="No imported recording receipts yet. Recording-enabled streams appear here only after a verified provider recording event and worker import." />
            ))}
          {receipts.map((receipt) => (
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
                {receipt.status.replace(/_/g, " ")}
              </Text>
              <Text style={styles.body}>{receipt.detail}</Text>
              <Text style={styles.small}>
                {new Date(receipt.created_at).toLocaleString()}
                {receipt.duration != null
                  ? ` · ${receipt.duration.toFixed(1)}s`
                  : ""}
                {receipt.size != null
                  ? ` · ${(receipt.size / 1024 / 1024).toFixed(1)} MiB`
                  : ""}{" "}
                · revision {receipt.revision}
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
                        if (valid()) navigation.navigate("Composer", { item });
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
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}
                  >
                    {clip.status === "ready" && clip.render_id && (
                      <Action
                        title="Preview actual rendered clip"
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
                          if (valid())
                            navigation.navigate("Composer", { item });
                        })
                      }
                    />
                    <Action
                      title="Create a publication campaign"
                      disabled={busy || clip.status !== "ready"}
                      onPress={() =>
                        void run(async (valid) => {
                          await ownedItem(clip.item_id, valid);
                          if (valid())
                            navigation.navigate("Campaigns", {
                              itemId: clip.item_id,
                            });
                        })
                      }
                    />
                  </DesktopGroup>
                  <Text style={styles.small}>
                    The saved clip is an editable private trim of the source.
                    Campaigns renders its current saved edit again and requires
                    an explicit preview, schedule and destination approval.
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
          {items.length > 0 && (
            <Text style={styles.small}>
              Owned sources loaded from your account. Imported drafts remain
              available in Studio even after this recording receipt finishes.
            </Text>
          )}
          {!desktop && (
            <Action
              secondary
              title="Refresh recordings and clips"
              icon={RefreshCw}
              disabled={busy}
              busy={loading}
              onPress={() => void load()}
            />
          )}
        </DesktopGroup>
      </DesktopGroup>
    </ScrollView>
  );
}
