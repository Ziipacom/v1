import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import {
  Camera,
  ArrowRight,
  Check,
  Columns2,
  Music2,
  Play,
  RefreshCw,
  Scissors,
  Video,
  Upload,
} from "lucide-react-native";
import { Sheet } from "./floating";
import { Action, Field, IconButton, Notice, Pill } from "./ui";
import { HelpLabel } from "./help-label";
import { InfoTip } from "./info-tip";
import { OverlaySlider } from "./editor-overlay-controls";
import { WorkflowProgress } from "./workflow-progress";
import { Disclosure } from "./disclosure";
import { MediaPlayer } from "./player";
import { Recorder } from "./recorder";
import { useZiipa } from "../provider";
import {
  creatorMimeType,
  uploadLimit,
  uploadMedia,
  type UploadFile,
} from "../lib/api";
import { pickCreatorMedia } from "../lib/creator-media-picker";
import { useOperationScope } from "../lib/use-operation-scope";
import {
  appliedRemix,
  remixCreate,
  remixId,
  remixModes,
  remixRange,
  remixReceipt,
  remixSnapshot,
  validateRemixClip,
  validateRemixFields,
  type RemixAudience,
  type RemixCreate,
  type RemixCredit,
  type RemixMode,
  type RemixReceipt,
  type RemixSnapshot,
} from "../lib/remix";
import type { Item } from "../lib/types";
import { color, styles } from "../theme";

type Props = {
  item: Item;
  onClose: () => void;
  onOpenDraft: (item: Item) => void;
  onViewItem: (id: string) => void;
  onSignIn: () => void;
};
const modeNames: Record<RemixMode, string> = {
  stitch: "Stitch",
  split_screen: "Split screen",
  use_sound: "Use sound",
};
const modeHelp: Record<RemixMode, string> = {
  stitch: "Play 1–5 seconds of the source, followed by your response video.",
  split_screen: "Place the selected source segment beside your response video.",
  use_sound:
    "Use audio from the selected source segment with your response video.",
};
const modeIcons = {
  stitch: Scissors,
  split_screen: Columns2,
  use_sound: Music2,
};
const remixSteps = [
  { title: "Clip", icon: Scissors },
  { title: "Response", icon: Video },
  { title: "Review", icon: Check },
] as const;
const pending = (status?: RemixReceipt["status"]) =>
  status === "queued" || status === "processing";
const statusNames: Record<RemixReceipt["status"], string> = {
  queued: "Waiting to process",
  processing: "Creating your remix",
  ready: "Ready to prepare your draft",
  applied: "Draft ready",
  failed: "Could not create this remix",
  stale: "Source or permissions changed",
  cancelled: "Cancelled",
};
const unavailable = (error: unknown) =>
  (error as { status?: number })?.status === 404
    ? "Remixing is unavailable right now. Check your library for any response video you already uploaded."
    : error instanceof Error
      ? error.message
      : "Could not reach Ziipa. Check your connection and refresh.";

type LocalSelection = {
  file: UploadFile;
  uploadedId: string | null;
  using: boolean;
  releaseRequested: boolean;
};
async function releaseSelection(selection: LocalSelection | null) {
  if (!selection) return;
  selection.releaseRequested = true;
  if (selection.using) return;
  const uri = selection.file.uri;
  if (Platform.OS === "web") {
    if (uri.startsWith("blob:")) URL.revokeObjectURL(uri);
  } else if (
    FileSystem.cacheDirectory &&
    uri.startsWith(FileSystem.cacheDirectory) &&
    !/[?#]/.test(uri)
  ) {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory)
      await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}

export function RemixPanel(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedRemixPanel
      key={`${session?.access_token || "guest"}:${props.item.id}`}
      {...props}
    />
  );
}

function ScopedRemixPanel({
  item,
  onClose,
  onOpenDraft,
  onViewItem,
  onSignIn,
}: Props) {
  const { api, guest, session, recordSavedItem, refresh } = useZiipa();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const capture = useOperationScope(
    `${session?.access_token || "guest"}:${item.id}`,
    focused && foreground,
  );
  const [snapshot, setSnapshot] = useState<RemixSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<RemixMode>("stitch");
  const [start, setStart] = useState("0");
  const [seconds, setSeconds] = useState("5");
  const [title, setTitle] = useState(() =>
    `Remix of ${item.title}`.slice(0, 140),
  );
  const [rights, setRights] = useState(false);
  const [file, setFile] = useState<UploadFile | null>(null);
  const [progress, setProgress] = useState(0);
  const [receipt, setReceipt] = useState<RemixReceipt | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [submitted, setSubmitted] = useState<RemixCreate | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [pollBudget, setPollBudget] = useState(0);
  const [audience, setAudience] = useState<RemixAudience>("disabled");
  const [policyModes, setPolicyModes] = useState<RemixMode[]>([]);
  const [policyConsent, setPolicyConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [step, setStep] = useState(0);
  const [showPermissions, setShowPermissions] = useState(false);
  const selected = useRef<LocalSelection | null>(null);
  const locked = useRef(false);
  const statusReading = useRef(false);
  const recordingScope = useRef<(() => boolean) | null>(null);
  const requestId = useRef(Crypto.randomUUID());
  const path = `/api/remix/items/${encodeURIComponent(item.id)}`;
  const signedIn = !!session && !guest && !item.demo && remixId(item.id);
  const editing = !busy && !submitted && !receipt;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(
    () => () => {
      void releaseSelection(selected.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!focused) setRecording(false);
  }, [focused]);
  const load = useCallback(async () => {
    if (!signedIn || !focused || !foreground) return;
    const current = capture();
    setLoading(true);
    setError("");
    try {
      const next = remixSnapshot(await api<unknown>(path));
      if (!current()) return;
      setSnapshot(next);
      if (next.allowed_modes.length)
        setMode((previous) =>
          next.allowed_modes.includes(previous)
            ? previous
            : next.allowed_modes[0],
        );
      if (next.policy) {
        setAudience(next.policy.audience);
        setPolicyModes(next.policy.modes);
        setPolicyConsent(false);
      }
    } catch (cause) {
      if (current()) {
        setSnapshot(null);
        setError(unavailable(cause));
      }
    } finally {
      setLoading(false);
    }
  }, [api, path, signedIn, focused, foreground, capture]);
  useEffect(() => {
    void load();
  }, [load]);

  const checkStatus = useCallback(
    async (id: string, automatic = false) => {
      if (!foreground || !focused || locked.current || statusReading.current)
        return;
      statusReading.current = true;
      const current = capture();
      if (!automatic) {
        setBusy("Checking status");
        setError("");
      }
      try {
        const next = remixReceipt(
          await api<unknown>(`/api/remix/projects/${id}`),
          id,
        );
        if (!current()) return;
        setReceipt(next);
        setUnconfirmed(false);
        if (!pending(next.status)) setPollBudget(0);
      } catch (cause) {
        if (current()) {
          setError(unavailable(cause));
          setPollBudget(0);
        }
      } finally {
        statusReading.current = false;
        if (!automatic) setBusy("");
      }
    },
    [api, capture, foreground, focused],
  );
  useEffect(() => {
    if (
      !receipt ||
      !pending(receipt.status) ||
      pollBudget <= 0 ||
      !foreground ||
      !focused ||
      busy
    )
      return;
    const timer = setTimeout(() => {
      setPollBudget((value) => Math.max(0, value - 1));
      void checkStatus(receipt.item_id, true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [
    receipt?.item_id,
    receipt?.status,
    pollBudget,
    foreground,
    focused,
    busy,
    checkStatus,
  ]);

  async function pick() {
    if (!editing || !signedIn || locked.current) return;
    locked.current = true;
    setBusy("Choosing response");
    setError("");
    const current = capture();
    let lease: LocalSelection | null = null;
    try {
      const result = await pickCreatorMedia(["video/*"], "media", current);
      if (result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      lease = {
        file: {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType || "",
          size: asset.size || 0,
        },
        uploadedId: null,
        using: false,
        releaseRequested: false,
      };
      const mimeType = creatorMimeType(asset.name, asset.mimeType || "");
      if (!["video/mp4", "video/quicktime", "video/webm"].includes(mimeType))
        throw new Error("Choose an MP4, MOV or WebM response video.");
      const info =
        asset.size == null && Platform.OS !== "web"
          ? await FileSystem.getInfoAsync(asset.uri)
          : null;
      const size =
        asset.size ?? (info?.exists && !info.isDirectory ? info.size : 0);
      lease.file = { uri: asset.uri, name: asset.name, mimeType, size };
      if (!Number.isSafeInteger(size) || size <= 0 || size > uploadLimit)
        throw new Error(
          "Choose a non-empty response video no larger than 100 MB.",
        );
      if (!current()) return;
      await releaseSelection(selected.current);
      selected.current = lease;
      setFile(lease.file);
      setRights(false);
      setProgress(0);
      requestId.current = Crypto.randomUUID();
      lease = null;
    } catch (cause) {
      if (current()) setError(unavailable(cause));
    } finally {
      if (lease) await releaseSelection(lease).catch(() => {});
      locked.current = false;
      setBusy("");
    }
  }
  async function acceptRecording(response: UploadFile) {
    const lease: LocalSelection = {
      file: response,
      uploadedId: null,
      using: false,
      releaseRequested: false,
    };
    setRecording(false);
    if (
      !recordingScope.current?.() ||
      !editing ||
      !["video/mp4", "video/quicktime", "video/webm"].includes(
        response.mimeType,
      ) ||
      response.size <= 0 ||
      response.size > uploadLimit
    ) {
      await releaseSelection(lease).catch(() => {});
      setError("Choose a supported response video up to 100 MB.");
      return;
    }
    const previous = selected.current;
    selected.current = lease;
    setFile(response);
    setRights(false);
    setProgress(0);
    requestId.current = Crypto.randomUUID();
    await releaseSelection(previous).catch(() => {});
  }
  async function create(retry = false) {
    if (
      locked.current ||
      !signedIn ||
      !session ||
      !foreground ||
      (!retry && (!editing || !snapshot || !selected.current))
    )
      return;
    const current = capture();
    const lease = selected.current;
    let posted = false;
    let uploading = false;
    locked.current = true;
    setBusy("Creating remix");
    setError("");
    setNotice("");
    try {
      let body = retry ? submitted : null;
      if (!retry) {
        if (!lease || !snapshot) return;
        // Validate consent/range/capability before uploading even one byte.
        validateRemixFields(mode, start, seconds, title, rights, snapshot);
        if (!lease.uploadedId) {
          lease.using = true;
          uploading = true;
          try {
            const uploaded = await uploadMedia(
              lease.file,
              session.access_token,
              (percent) => {
                if (current()) setProgress(percent);
              },
            );
            if (!remixId(uploaded.id))
              throw new Error(
                "The response upload was not confirmed. Check your library before trying again.",
              );
            lease.uploadedId = uploaded.id;
            if (!current()) return;
          } finally {
            lease.using = false;
            if (lease.releaseRequested)
              await releaseSelection(lease).catch(() => {});
          }
        }
        if (!current()) return;
        body = remixCreate(
          {
            request_id: requestId.current,
            mode,
            source_start: start,
            source_seconds: seconds,
            response_media_id: lease.uploadedId,
            title,
            rights_confirmed: rights,
          },
          snapshot,
        );
        setSubmitted(body);
        setUnconfirmed(true);
      }
      if (!body) return;
      posted = true;
      const next = remixReceipt(await api<unknown>(`${path}/projects`, body));
      if (!current()) return;
      setReceipt(next);
      setUnconfirmed(false);
      setPollBudget(pending(next.status) ? 12 : 0);
      // The receipt has only IDs. Read the saved private item into the regular
      // Profile/Studio library so closing this sheet does not hide the project.
      void refresh().catch(() => {});
    } catch (cause) {
      if (current()) {
        const code = (cause as { status?: number })?.status;
        const uncertain =
          posted &&
          ((cause as { outcome?: string })?.outcome === "unconfirmed" ||
            !code ||
            code >= 500);
        setUnconfirmed(uncertain);
        if (uncertain) void refresh().catch(() => {});
        if (!uncertain && !receipt) setSubmitted(null);
        setError(
          uncertain
            ? "The remix request was not confirmed. Do not start another. Check the same request below; it reuses the original request ID and uploaded response."
            : !posted && uploading
              ? `The response upload was not confirmed. No remix request was sent. Check your library before uploading again. ${unavailable(cause)}`
              : unavailable(cause),
        );
      }
    } finally {
      locked.current = false;
      setBusy("");
    }
  }
  async function apply() {
    if (
      !receipt ||
      !["ready", "applied"].includes(receipt.status) ||
      locked.current ||
      !session ||
      !foreground
    )
      return;
    const current = capture();
    locked.current = true;
    setBusy("Preparing draft");
    setError("");
    try {
      const saved = appliedRemix(
        await api<unknown>(`/api/remix/projects/${receipt.item_id}/apply`, {}),
        receipt,
        session.user.id,
        item.id,
      );
      if (!current()) return;
      recordSavedItem(saved, session.access_token);
      setDraft(saved);
      setReceipt({ ...receipt, status: "applied" });
      setNotice("");
    } catch (cause) {
      if (current()) setError(unavailable(cause));
    } finally {
      locked.current = false;
      setBusy("");
    }
  }
  async function savePolicy() {
    if (
      !snapshot?.policy ||
      !session ||
      item.creator_id !== session.user.id ||
      !policyConsent ||
      locked.current ||
      !foreground
    )
      return;
    if (audience !== "disabled" && !policyModes.length) {
      setError("Choose at least one remix mode.");
      return;
    }
    const current = capture(),
      previous = snapshot.policy;
    locked.current = true;
    setBusy("Saving permissions");
    setError("");
    try {
      const nextModes = audience === "disabled" ? [] : policyModes;
      await api(`${path}/policy`, {
        revision: previous.revision,
        audience,
        modes: nextModes,
      });
      if (!current()) return;
      const next = remixSnapshot(await api<unknown>(path));
      if (!current()) return;
      setSnapshot(next);
      setPolicyConsent(false);
      if (
        !next.policy ||
        next.policy.revision <= previous.revision ||
        next.policy.audience !== audience ||
        [...next.policy.modes].sort().join() !== [...nextModes].sort().join()
      )
        throw new Error(
          "Your remix permissions were not confirmed. Refresh before trying again.",
        );
      setNotice("Remix permissions saved.");
    } catch (cause) {
      if (current()) setError(unavailable(cause));
    } finally {
      locked.current = false;
      setBusy("");
    }
  }
  const close = () => {
    if (locked.current || busy) {
      setNotice("Wait for this request to finish.");
      return;
    }
    onClose();
  };
  const clipRange = remixRange(mode);
  const maxLength = Math.max(
    clipRange.min,
    Math.min(clipRange.max, 90 - (Number(start) || 0)),
  );
  const lengthValue = Math.min(
    maxLength,
    Math.max(clipRange.min, Number(seconds) || clipRange.min),
  );
  const changeStep = (next: number) => {
    setError("");
    setNotice("");
    setStep(next);
  };
  const reviewClip = () => {
    if (!snapshot) return;
    try {
      validateRemixClip(mode, start, seconds, snapshot);
      setShowSource(false);
      changeStep(1);
    } catch (cause) {
      setError(unavailable(cause));
    }
  };
  return (
    <Sheet title="Remix this creation" onClose={close} maxWidth={760}>
      {!signedIn ? (
        <>
          <Notice
            text={
              item.demo
                ? "Sample media is unavailable for remixing."
                : "Sign in to remix."
            }
          />
          <Action title="Sign in" onPress={onSignIn} />
        </>
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heading}>{item.title}</Text>
              <Text style={styles.small}>By {item.creator}</Text>
            </View>
            <IconButton
              label="Refresh permissions and availability"
              icon={RefreshCw}
              disabled={!!busy || loading}
              onPress={() => void load()}
            />
          </View>
          {loading && (
            <Text style={styles.small}>Checking remix permissions…</Text>
          )}
          {snapshot && (
            <>
              <AttributionLinks snapshot={snapshot} onViewItem={onViewItem} />
              {(!snapshot.allowed_modes.length || !snapshot.available) && (
                <Notice
                  text={
                    snapshot.allowed_modes.length
                      ? "Remix processing is unavailable."
                      : "Remix is unavailable for this creation."
                  }
                />
              )}
              {snapshot.available &&
                snapshot.allowed_modes.length > 0 &&
                !receipt &&
                !submitted && (
                  <>
                    <WorkflowProgress
                      steps={remixSteps}
                      activeStep={step}
                      onStepPress={editing ? changeStep : undefined}
                    />
                    {step === 0 && (
                      <>
                        <HelpLabel
                          label="Mode"
                          help={`${modeHelp[mode]} Choose your own response video; the result stays private until you review and publish. Only modes permitted by this creator are offered. Permission is checked before processing and applying the remix.`}
                        />
                        <View
                          style={{
                            flexDirection: "row",
                            flexWrap: "wrap",
                            gap: 8,
                          }}
                        >
                          {snapshot.allowed_modes.map((value) => {
                            const Icon = modeIcons[value];
                            return (
                              <Pressable
                                key={value}
                                accessibilityRole="radio"
                                accessibilityLabel={modeNames[value]}
                                aria-checked={mode === value}
                                accessibilityState={{
                                  checked: mode === value,
                                  disabled: !editing,
                                }}
                                disabled={!editing}
                                style={{
                                  flex: 1,
                                  minWidth: 80,
                                  minHeight: 62,
                                  gap: 5,
                                  alignItems: "center",
                                  justifyContent: "center",
                                  borderRadius: 12,
                                  borderWidth: 1,
                                  borderColor:
                                    mode === value ? color.lime : color.border,
                                  backgroundColor: color.panel,
                                  opacity: editing ? 1 : 0.55,
                                }}
                                onPress={() => {
                                  if (!editing) return;
                                  setMode(value);
                                  const range = remixRange(value);
                                  setSeconds(
                                    String(
                                      Math.max(
                                        range.min,
                                        Math.min(
                                          range.max,
                                          Number(seconds) || 5,
                                        ),
                                      ),
                                    ),
                                  );
                                  setRights(false);
                                }}
                              >
                                <Icon
                                  size={21}
                                  color={
                                    mode === value ? color.lime : color.text
                                  }
                                />
                                <Text style={styles.small}>
                                  {modeNames[value]}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Preview source"
                          accessibilityState={{ expanded: showSource }}
                          onPress={() => setShowSource((value) => !value)}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 7,
                            minHeight: 44,
                          }}
                        >
                          <Play size={17} color={color.text} />
                          <Text style={styles.small}>
                            {showSource ? "Hide source" : "Preview source"}
                          </Text>
                        </Pressable>
                        {showSource && !recording && (
                          <MediaPlayer item={item} />
                        )}
                        <View style={[styles.panel, { padding: 12, gap: 8 }]}>
                          <Field
                            label="Start (s)"
                            help="Time is measured from the beginning of the published clip."
                            value={start}
                            keyboardType="decimal-pad"
                            editable={editing}
                            onChangeText={(value) => {
                              setStart(value);
                              if (
                                Number.isFinite(Number(value)) &&
                                Number(seconds) + Number(value) > 90
                              )
                                setSeconds(
                                  String(
                                    Math.max(
                                      clipRange.min,
                                      Number((90 - Number(value)).toFixed(1)),
                                    ),
                                  ),
                                );
                              setRights(false);
                            }}
                          />
                          <OverlaySlider
                            label="Clip length"
                            value={lengthValue}
                            min={clipRange.min}
                            max={maxLength}
                            step={0.1}
                            disabled={!editing}
                            valueText={`${lengthValue}s`}
                            formatValue={(value) => `${value}s`}
                            onChange={(value) => {
                              setSeconds(String(value));
                              setRights(false);
                            }}
                          />
                        </View>
                        <Action
                          title="Continue to response"
                          icon={ArrowRight}
                          onPress={reviewClip}
                          disabled={!editing}
                        />
                      </>
                    )}
                    {step === 1 && (
                      <>
                        <HelpLabel
                          label="Response video"
                          help="Upload or record a video you have permission to use. MP4, MOV, and WebM up to 100 MB."
                        />
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <Action
                              secondary
                              title={file ? "Replace" : "Upload"}
                              icon={Upload}
                              disabled={!editing || !foreground}
                              onPress={() => void pick()}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Action
                              secondary
                              title="Camera"
                              icon={Camera}
                              disabled={!editing || !foreground}
                              onPress={() => {
                                setError("");
                                recordingScope.current = capture();
                                setRecording(true);
                              }}
                            />
                          </View>
                        </View>
                        {file && (
                          <Text style={styles.small} numberOfLines={2}>
                            {file.name} · {(file.size / 1024 / 1024).toFixed(1)}{" "}
                            MB
                          </Text>
                        )}
                        <Action
                          title="Review remix"
                          icon={ArrowRight}
                          disabled={!file || !editing}
                          onPress={() => changeStep(2)}
                        />
                      </>
                    )}
                    {step === 2 && (
                      <>
                        <View style={[styles.panel, { padding: 12, gap: 3 }]}>
                          <Text style={styles.label}>
                            {modeNames[mode]} · {start}s–
                            {Number(
                              (Number(start) + Number(seconds)).toFixed(2),
                            )}
                            s
                          </Text>
                          <Text numberOfLines={2} style={styles.small}>
                            {file?.name}
                          </Text>
                        </View>
                        <Field
                          label="Title"
                          value={title}
                          maxLength={140}
                          editable={editing}
                          onChangeText={setTitle}
                        />
                        <HelpLabel
                          label="Ziipa-only remix"
                          help="Remix permission covers the signed-in Ziipa feed only. External publishing, public galleries and minting need a separate source license and are not available for this remix. You must have permission for both your response video and the selected source segment."
                        />
                        <RightsConsent
                          checked={rights}
                          disabled={!editing}
                          onChange={() => setRights((value) => !value)}
                          label="I have permission to use both clips on Ziipa."
                        />
                        <Action
                          title="Create private remix"
                          icon={Scissors}
                          busy={!!busy && busy !== "Saving permissions"}
                          disabled={
                            !editing ||
                            loading ||
                            !snapshot.available ||
                            !snapshot.allowed_modes.includes(mode) ||
                            !file ||
                            !title.trim() ||
                            !rights ||
                            !foreground
                          }
                          onPress={() => void create()}
                        />
                      </>
                    )}
                    {busy === "Creating remix" && (
                      <Text
                        accessibilityLiveRegion="polite"
                        style={styles.small}
                      >
                        {progress < 100
                          ? `Uploading response · ${progress}%`
                          : "Submitting remix request…"}
                      </Text>
                    )}
                  </>
                )}
              {snapshot.policy && item.creator_id === session?.user.id && (
                <Disclosure
                  title="Remix permissions"
                  detail={
                    audience === "disabled"
                      ? "Off"
                      : audience === "everyone"
                        ? "Everyone"
                        : "Followers"
                  }
                  expanded={showPermissions}
                  onToggle={() => setShowPermissions((previous) => !previous)}
                >
                  <HelpLabel
                    label="Who can remix this creation?"
                    style={styles.heading}
                    help="Allow only uses you have rights to grant inside the signed-in Ziipa feed. External publishing, public galleries and minting are excluded. Changes can stop pending remixes and make existing remixes unavailable. Attribution is retained; copyright stays with its owners."
                  />
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    {(
                      [
                        ["disabled", "Off"],
                        ["followers", "Followers"],
                        ["everyone", "Everyone"],
                      ] as const
                    ).map(([value, label]) => (
                      <Pill
                        key={value}
                        title={label}
                        active={audience === value}
                        onPress={() => {
                          if (!busy) {
                            setAudience(value);
                            setPolicyConsent(false);
                          }
                        }}
                      />
                    ))}
                  </View>
                  {audience !== "disabled" &&
                    remixModes.map((value) => (
                      <RightsConsent
                        key={value}
                        checked={policyModes.includes(value)}
                        disabled={!!busy}
                        onChange={() => {
                          setPolicyModes((previous) =>
                            previous.includes(value)
                              ? previous.filter((entry) => entry !== value)
                              : [...previous, value],
                          );
                          setPolicyConsent(false);
                        }}
                        label={modeNames[value]}
                      />
                    ))}
                  <RightsConsent
                    checked={policyConsent}
                    disabled={!!busy}
                    onChange={() => setPolicyConsent((value) => !value)}
                    label={
                      audience === "disabled"
                        ? "Turn off remixing; pending and existing remixes may become unavailable."
                        : "I own or have permission to grant these remix uses for this source media."
                    }
                  />
                  <Action
                    title="Save remix permissions"
                    disabled={!!busy || !policyConsent || !foreground}
                    onPress={() => void savePolicy()}
                  />
                </Disclosure>
              )}
              {snapshot.children.length > 0 && (
                <View style={{ gap: 4 }}>
                  <Text style={styles.label}>Remixes of this creation</Text>
                  {snapshot.children.slice(0, 20).map((child) => (
                    <CreditLink
                      key={child.id}
                      credit={child}
                      prefix="Remix"
                      onViewItem={onViewItem}
                    />
                  ))}
                </View>
              )}
            </>
          )}
          {unconfirmed && submitted && !receipt && (
            <Action
              secondary
              title="Check the same remix request"
              disabled={!!busy || !foreground}
              onPress={() => void create(true)}
            />
          )}
          {receipt && (
            <View style={[styles.panel, { gap: 10 }]}>
              <View style={styles.between}>
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.heading, { flex: 1 }]}
                >
                  {statusNames[receipt.status]}
                </Text>
                <InfoTip
                  title="Remix status"
                  content="Find this private creation in your Profile. Processing continues after you close this panel."
                />
                <IconButton
                  label="Refresh remix status"
                  icon={RefreshCw}
                  disabled={!!busy || !foreground}
                  onPress={() => {
                    setPollBudget(12);
                    void checkStatus(receipt.item_id);
                  }}
                />
              </View>
              {["ready", "applied"].includes(receipt.status) && !draft && (
                <Action
                  title="Prepare editable draft"
                  disabled={!!busy || !foreground}
                  onPress={() => void apply()}
                />
              )}
              {draft && (
                <Action
                  title="Open draft in editor"
                  disabled={!!busy}
                  onPress={() => onOpenDraft(draft)}
                />
              )}
            </View>
          )}
          {!!busy && (
            <Text accessibilityLiveRegion="polite" style={styles.small}>
              {busy}…
            </Text>
          )}
          {recording && (
            <Recorder
              mode="record"
              onClose={() => setRecording(false)}
              onCapture={(response) => void acceptRecording(response)}
              onNetworks={() => setRecording(false)}
            />
          )}
          {!!error && <Notice error text={error} />}
          {!!notice && <Notice text={notice} />}
        </>
      )}
    </Sheet>
  );
}

function RightsConsent({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onChange}
      style={[styles.row, { gap: 10, paddingVertical: 8 }]}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderWidth: 1,
          borderRadius: 5,
          borderColor: color.lime,
          backgroundColor: checked ? color.purple : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={16} color={color.text} />}
      </View>
      <Text style={[styles.small, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
function CreditLink({
  credit,
  prefix,
  onViewItem,
  onDark = false,
}: {
  credit: RemixCredit;
  prefix: string;
  onViewItem: (id: string) => void;
  onDark?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${prefix}: ${credit.title} by ${credit.creator}`}
      onPress={() => onViewItem(credit.id)}
      style={{ minHeight: 40, justifyContent: "center", paddingVertical: 4 }}
    >
      <Text
        numberOfLines={2}
        style={[
          styles.small,
          {
            color: onDark ? "#D6B6FF" : color.lime,
            textDecorationLine: "underline",
          },
        ]}
      >
        {prefix}: {credit.title || "Creation"} · {credit.creator}
      </Text>
    </Pressable>
  );
}
function AttributionLinks({
  snapshot,
  onViewItem,
  onDark = false,
}: {
  snapshot: RemixSnapshot;
  onViewItem: (id: string) => void;
  onDark?: boolean;
}) {
  const { parent, root } = snapshot.attribution || {};
  return (
    <View>
      {parent && (
        <CreditLink
          credit={parent}
          prefix="Remixed from"
          onViewItem={onViewItem}
          onDark={onDark}
        />
      )}
      {root && root.id !== parent?.id && (
        <CreditLink
          credit={root}
          prefix="Original"
          onViewItem={onViewItem}
          onDark={onDark}
        />
      )}
    </View>
  );
}
export function RemixAttribution(props: {
  item: Item;
  onViewItem: (id: string) => void;
  onDark?: boolean;
}) {
  const { session } = useZiipa();
  return props.item.remix_of ? (
    <ScopedAttribution
      key={`${session?.access_token || "guest"}:${props.item.id}`}
      {...props}
    />
  ) : null;
}
function ScopedAttribution({
  item,
  onViewItem,
  onDark,
}: {
  item: Item;
  onViewItem: (id: string) => void;
  onDark?: boolean;
}) {
  const { api, guest, session } = useZiipa();
  const focused = useIsFocused();
  const [snapshot, setSnapshot] = useState<RemixSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    if (focused && session && !guest && remixId(item.id))
      void api<unknown>(`/api/remix/items/${item.id}`)
        .then((value) => {
          const next = remixSnapshot(value);
          if (current) setSnapshot(next);
        })
        .catch(() => {
          if (current) setFailed(true);
        });
    return () => {
      current = false;
    };
  }, [api, focused, session?.access_token, guest, item.id]);
  if (!session || guest)
    return (
      <Text style={[styles.small, onDark && { color: "#E7DCF5" }]}>
        Sign in to view remix credits.
      </Text>
    );
  return snapshot ? (
    <AttributionLinks
      snapshot={snapshot}
      onViewItem={onViewItem}
      onDark={onDark}
    />
  ) : (
    <Text style={[styles.small, onDark && { color: "#E7DCF5" }]}>
      {failed ? "Source credits unavailable" : "Loading remix credits…"}
    </Text>
  );
}

type ProjectProps = {
  item: Item;
  /** Exact editor revision: consent cannot outlive a subsequent local edit. */
  unsavedKey: string | null;
  disabled: boolean;
  /** Returns a scope-bound release only if the editor save lock was acquired. */
  acquire: () => (() => void) | null;
  onOpenDraft: (item: Item) => void;
  onViewItem: (id: string) => void;
};

/** A regular Profile/Studio draft remains the recovery entry point after closing Remix. */
export function RemixProjectStatus(props: ProjectProps) {
  const { session, guest } = useZiipa();
  return session &&
    !guest &&
    props.item.creator_id === session.user.id &&
    props.item.visibility === "draft" &&
    remixId(props.item.id) &&
    remixId(props.item.remix_of) ? (
    <ScopedProjectStatus
      key={`${session.access_token}:${props.item.id}`}
      {...props}
    />
  ) : null;
}
function ScopedProjectStatus({
  item,
  unsavedKey,
  disabled,
  acquire,
  onOpenDraft,
  onViewItem,
}: ProjectProps) {
  const { api, session, recordSavedItem } = useZiipa();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const capture = useOperationScope(
    `${session?.access_token}:${item.id}`,
    focused && foreground,
  );
  const [receipt, setReceipt] = useState<RemixReceipt | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [draft, setDraft] = useState<Item | null>(null);
  const [discardKey, setDiscardKey] = useState<string | null>(null);
  const [pollBudget, setPollBudget] = useState(12);
  const readLock = useRef(false),
    applyLock = useRef(false);
  const canReplace = !unsavedKey || discardKey === unsavedKey;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const read = useCallback(async () => {
    if (!focused || !foreground || readLock.current || applyLock.current)
      return;
    const current = capture();
    readLock.current = true;
    setReading(true);
    setError("");
    try {
      const next = remixReceipt(
        await api<unknown>(`/api/remix/projects/${item.id}`),
        item.id,
      );
      if (!current()) return;
      setReceipt(next);
      setMissing(false);
      if (!pending(next.status)) setPollBudget(0);
    } catch (cause) {
      if (current()) {
        // Older attribution-only drafts are not processing projects.
        if ((cause as { status?: number })?.status === 404) setMissing(true);
        else setError(unavailable(cause));
        setPollBudget(0);
      }
    } finally {
      readLock.current = false;
      setReading(false);
    }
  }, [api, capture, item.id, focused, foreground]);
  useEffect(() => {
    void read();
  }, [read]);
  useEffect(() => {
    if (
      !receipt ||
      !pending(receipt.status) ||
      !pollBudget ||
      !focused ||
      !foreground ||
      reading ||
      applying ||
      disabled
    )
      return;
    const timer = setTimeout(() => {
      setPollBudget((value) => Math.max(0, value - 1));
      void read();
    }, 5000);
    return () => clearTimeout(timer);
  }, [
    receipt?.status,
    pollBudget,
    focused,
    foreground,
    reading,
    applying,
    disabled,
    read,
  ]);
  async function apply() {
    if (
      !receipt ||
      !["ready", "applied"].includes(receipt.status) ||
      !session ||
      disabled ||
      !canReplace ||
      !focused ||
      !foreground ||
      readLock.current ||
      applyLock.current
    )
      return;
    const release = acquire();
    if (!release) return;
    const current = capture();
    applyLock.current = true;
    setApplying(true);
    setError("");
    try {
      const saved = appliedRemix(
        await api<unknown>(`/api/remix/projects/${item.id}/apply`, {}),
        receipt,
        session.user.id,
        item.remix_of!,
      );
      if (!current()) return;
      recordSavedItem(saved, session.access_token);
      setDraft(saved);
      setReceipt({ ...receipt, status: "applied" });
    } catch (cause) {
      if (current())
        setError(
          `The prepared draft was not confirmed. Refresh its status, then retry preparing this same remix. ${unavailable(cause)}`,
        );
    } finally {
      applyLock.current = false;
      setApplying(false);
      release();
    }
  }
  if (missing) return null;
  return (
    <View style={[styles.panel, { gap: 10 }]}>
      <View style={styles.between}>
        <Text style={[styles.heading, { flex: 1 }]}>Remix draft</Text>
        <InfoTip
          title="Remix draft"
          content="Processing continues after you close the editor."
        />
        <IconButton
          label="Refresh saved remix"
          icon={RefreshCw}
          disabled={disabled || applying || reading || !focused || !foreground}
          onPress={() => {
            setPollBudget(12);
            void read();
          }}
        />
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.small}>
        {receipt
          ? statusNames[receipt.status]
          : reading
            ? "Checking…"
            : "Status unavailable"}
      </Text>
      {receipt && ["ready", "applied"].includes(receipt.status) && (
        <>
          {!!unsavedKey && (
            <RightsConsent
              checked={canReplace}
              disabled={disabled || applying}
              onChange={() => setDiscardKey(canReplace ? null : unsavedKey)}
              label="Replace my unsaved editor changes with the prepared remix."
            />
          )}
          {!draft ? (
            <Action
              title="Prepare saved remix"
              busy={applying}
              disabled={
                disabled ||
                applying ||
                reading ||
                !canReplace ||
                !focused ||
                !foreground
              }
              onPress={() => void apply()}
            />
          ) : (
            <Action
              title="Load prepared remix in editor"
              disabled={
                disabled || applying || !canReplace || !focused || !foreground
              }
              onPress={() => {
                if (!disabled && canReplace && focused && foreground)
                  onOpenDraft(draft);
              }}
            />
          )}
          <Text style={styles.small}>
            Review the finished media before publishing inside Ziipa. Loading
            replaces this editor’s current changes.
          </Text>
        </>
      )}
      <Action
        secondary
        title="View source creation"
        disabled={disabled || applying}
        onPress={() => onViewItem(item.remix_of!)}
      />
      {!!error && <Notice error text={error} />}
    </View>
  );
}
