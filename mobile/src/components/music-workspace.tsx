import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  Check,
  Music2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react-native";
import { Action, Field, Notice, Pill } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { MusicAudition } from "./audio-audition";
import { VoiceNarrationWorkspace } from "./voice-narration-workspace";
import {
  generatedMusicFile,
  type GeneratedMusicFile,
} from "../lib/generated-music-file";
import {
  composeMusic,
  musicMoods,
  musicPlan,
  musicStyles,
  ownedAudioTracks,
  planMusicPrompt,
  type MusicSettings,
  type MusicPlan,
  type OwnedAudio,
} from "../lib/music-composer";
import { synthesizeAiMusic, type AiMusicConfig } from "../lib/ai-music";
import {
  knownAudioDuration,
  parseSoundtrackStart,
} from "../lib/soundtrack-controls";
import type { UploadFile } from "../lib/api";
import type { Library } from "../lib/media-os-types";
import { color, font, styles } from "../theme";

export type MusicWorkspaceProps = {
  /** Creation makes the generated WAV the source; soundtrack keeps existing media. */
  purpose?: "soundtrack" | "creation";
  busy?: boolean;
  selectedName?: string;
  selectedFile?: UploadFile | null;
  selectedMediaId?: string | null;
  /** Percentage, matching the editor's existing 0–100 soundtrack control. */
  volume: number;
  onVolumeChange: (percent: number) => void;
  /** Seconds skipped from the selected audio file, not an output-timeline delay. */
  start?: number;
  onStartChange?: (seconds: number) => void;
  onRemove?: () => void;
  /** Actual selected attachment metadata only; null means not yet known. */
  onDurationChange?: (seconds: number | null) => void;
  onUpload: () => void;
  /** Called only for an explicit Play gesture, before audition playback starts. */
  onAuditionStart?: () => void;
  onUseOwned: (audio: { media_id: string; name: string }) => void;
  /** Parent owns this lease after attachment, until replacement/unmount. */
  onUseGenerated: (
    file: UploadFile,
    release: () => Promise<void>,
    title: string,
  ) => void;
};

type Audition = { name: string; path?: string; uri?: string };
type GeneratedPlan =
  | MusicPlan
  | {
      engine: "ziipa-llm-composer-v1";
      style: MusicSettings["style"];
      summary: string;
      title: string;
      model: string;
      fingerprint: string;
    };
type Generated = GeneratedMusicFile & {
  plan: GeneratedPlan;
  transferred: boolean;
};
const generatedName = (plan: GeneratedPlan) =>
  "title" in plan ? plan.title : `${plan.style} instrumental`;
const emptyLibrary = (): Library => ({ items: [], media: [] });
const initialSettings: MusicSettings = {
  prompt: "A calm lo-fi instrumental for a short creator video, 90 BPM",
  style: "lofi",
  mood: "calm",
  bpm: 90,
  duration: 20,
  variation: 0,
};

export function MusicWorkspace(props: MusicWorkspaceProps) {
  const { session } = useZiipa();
  return (
    <ScopedMusicWorkspace
      key={`${session?.access_token || "guest"}:${props.purpose || "soundtrack"}`}
      {...props}
    />
  );
}

function ScopedMusicWorkspace({
  purpose = "soundtrack",
  busy = false,
  selectedName,
  selectedFile,
  selectedMediaId,
  volume,
  onVolumeChange,
  start = 0,
  onStartChange,
  onRemove,
  onDurationChange,
  onUpload,
  onAuditionStart,
  onUseOwned,
  onUseGenerated,
}: MusicWorkspaceProps) {
  const { api, session } = useZiipa();
  const { desktop } = useDesktopLayout();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const [tab, setTab] = useState<"library" | "create">(
    purpose === "creation" ? "create" : "library",
  );
  const [library, setLibrary] = useState<Library>(emptyLibrary);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [rights, setRights] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [startDraft, setStartDraft] = useState(String(start));
  const [startError, setStartError] = useState("");
  const [audioDuration, setAudioDuration] = useState<{
    key: string;
    duration: number | null;
  } | null>(null);
  const [audition, setAudition] = useState<Audition | null>(null);
  const [settings, setSettings] = useState<MusicSettings>(initialSettings);
  const [generating, setGenerating] = useState(false);
  const [createMode, setCreateMode] = useState<"ai" | "voice" | "offline">(
    "ai",
  );
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiMusicConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const generationCapture = useOperationScope(
    `${session?.access_token || "guest"}:${tab}`,
    focused && tab === "create",
  );
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [attached, setAttached] = useState(false);
  const generatedRef = useRef<Generated | null>(null);
  const auditionPause = useRef<(() => void) | null>(null);
  const registerAuditionPause = useCallback((pause: (() => void) | null) => {
    auditionPause.current = pause;
  }, []);
  const pauseForVoiceCapture = useCallback(() => {
    auditionPause.current?.();
    onAuditionStart?.();
  }, [onAuditionStart]);
  const generationLock = useRef(false);
  const ownerId = session?.user.id || 0;
  const tracks = session
    ? ownedAudioTracks(library, ownerId).filter((track) =>
        `${track.name} ${track.media_id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : [];
  const selected =
    audition ||
    (selectedFile
      ? { name: selectedName || selectedFile.name, uri: selectedFile.uri }
      : selectedMediaId
        ? {
            name: selectedName || "Selected soundtrack",
            path: `/api/creator/media/${selectedMediaId}`,
          }
        : null);
  const disabled = busy || generating || voiceBusy;
  const attachmentKey = selectedFile?.uri || selectedMediaId || "";
  const latestAttachment = useRef(attachmentKey);
  latestAttachment.current = attachmentKey;
  const attachmentDuration =
    audioDuration?.key === attachmentKey ? audioDuration.duration : null;
  const auditionIsAttachment =
    !!attachmentKey &&
    (selectedFile
      ? selected?.uri === selectedFile.uri
      : selected?.path === `/api/creator/media/${selectedMediaId}`);
  const receiveAttachmentDuration = useCallback(
    (seconds: number | null) => {
      if (latestAttachment.current !== attachmentKey) return;
      const duration = knownAudioDuration(seconds);
      setAudioDuration((previous) =>
        previous?.key === attachmentKey && previous.duration === duration
          ? previous
          : { key: attachmentKey, duration },
      );
    },
    [attachmentKey],
  );
  useEffect(() => {
    setStartDraft(String(start));
    setStartError("");
  }, [attachmentKey, start]);
  useEffect(() => {
    onDurationChange?.(purpose === "creation" ? null : attachmentDuration);
  }, [attachmentKey, attachmentDuration, onDurationChange, purpose]);

  const load = useCallback(async () => {
    if (!session || !focused) return;
    const current = capture();
    setLoading(true);
    setError("");
    try {
      const result = await api<Library>("/api/os/library");
      if (current()) setLibrary(result);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Your owned audio could not load.",
        );
    } finally {
      if (current()) setLoading(false);
    }
  }, [api, session?.access_token, focused, capture]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setAudition(null);
    const held = generatedRef.current;
    // The parent released/replaced this attachment. Do not offer a stale URI.
    if (held?.transferred && selectedFile?.uri !== held.file.uri) {
      generatedRef.current = null;
      setGenerated(null);
      setAttached(false);
    }
  }, [selectedFile?.uri, selectedMediaId]);
  useEffect(() => {
    if (!focused || tab !== "create") setGenerating(false);
    if (!focused) setConfigLoading(false);
  }, [focused, tab]);
  const loadAiConfig = useCallback(async () => {
    if (!session || !focused) return;
    const current = capture();
    setConfigLoading(true);
    try {
      const result = await api<AiMusicConfig>("/api/music/config");
      if (current()) setAiConfig(result);
    } catch (cause) {
      if (current()) {
        setAiConfig(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "Model readiness could not load.",
        );
      }
    } finally {
      if (current()) setConfigLoading(false);
    }
  }, [api, session?.access_token, focused, capture]);
  useEffect(() => {
    if (tab === "create") void loadAiConfig();
  }, [tab, loadAiConfig]);
  useEffect(() => setAiConsent(false), [aiConfig?.provider, aiConfig?.model]);
  useEffect(
    () => () => {
      const held = generatedRef.current;
      if (held && !held.transferred) void held.release().catch(() => {});
    },
    [],
  );

  async function generate() {
    if (disabled || generationLock.current || !focused || tab !== "create")
      return;
    if (
      createMode === "ai" &&
      (!session ||
        !aiConfig?.available ||
        !aiConsent ||
        !settings.prompt.trim())
    )
      return;
    const current = generationCapture();
    generationLock.current = true;
    setGenerating(true);
    setError("");
    setNotice("");
    let next: GeneratedMusicFile | undefined;
    try {
      // Let the progress message paint before this bounded, local CPU task.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      if (!current()) return;
      const nextSettings =
        createMode === "offline" && generatedRef.current
          ? { ...settings, variation: (settings.variation + 1) % 10000 }
          : { ...settings };
      let bytes: Uint8Array;
      let resultPlan: GeneratedPlan;
      if (createMode === "ai") {
        const response = await api<unknown>("/api/music/compose", {
          prompt: nextSettings.prompt.trim(),
          style: nextSettings.style,
          mood: nextSettings.mood,
          bpm: nextSettings.bpm,
          duration: nextSettings.duration,
          consent: true,
        });
        if (!current()) return;
        const result = synthesizeAiMusic(response, nextSettings);
        bytes = result.bytes;
        resultPlan = {
          engine: result.engine,
          title: result.arrangement.title,
          model: result.model,
          fingerprint: result.fingerprint,
          style: nextSettings.style,
          summary: result.summary,
        };
      } else {
        const result = composeMusic(nextSettings);
        bytes = result.bytes;
        resultPlan = result.plan;
      }
      next = await generatedMusicFile(bytes);
      if (!current()) {
        await next.release();
        return;
      }
      const previous = generatedRef.current;
      if (previous && !previous.transferred) await previous.release();
      if (!current()) {
        await next.release();
        return;
      }
      const held: Generated = {
        ...next,
        plan: resultPlan,
        transferred: false,
      };
      generatedRef.current = held;
      setSettings(nextSettings);
      setGenerated(held);
      setAttached(false);
      setAudition({
        name: generatedName(resultPlan),
        uri: next.file.uri,
      });
      setNotice(
        resultPlan.engine === "ziipa-llm-composer-v1"
          ? "AI-composed score rendered to WAV on this device. Preview it, then explicitly attach and save; nothing was published."
          : "Offline procedural WAV is ready. No AI model was used. It stays local until you attach it and save the draft.",
      );
      next = undefined;
    } catch (cause) {
      await next?.release().catch(() => {});
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Music could not be generated on this device.",
        );
    } finally {
      generationLock.current = false;
      if (current()) setGenerating(false);
    }
  }

  function attachGenerated() {
    const held = generatedRef.current;
    if (!held || held.transferred || disabled || !focused) return;
    try {
      onUseGenerated(held.file, held.release, generatedName(held.plan));
      held.transferred = true;
      setAttached(true);
      setNotice(
        purpose === "creation"
          ? "Generated audio selected as your creation. Nothing is uploaded, saved or published until you review and save it."
          : "Generated music attached to this edit. Save the draft to upload it; publishing still requires its separate review.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Music could not be attached.",
      );
    }
  }
  function attachOwned(track: OwnedAudio) {
    if (!rights || track.rightsExpired || disabled || !focused || !session)
      return;
    onUseOwned({ media_id: track.media_id, name: track.name });
    setAudition({
      name: track.name,
      path: `/api/creator/media/${track.media_id}`,
    });
    setNotice(
      "Owned audio attached. Review the mix and save your draft before publishing.",
    );
  }
  const plan = musicPlan(settings);
  const safeVolume = Number.isFinite(volume)
    ? Math.max(0, Math.min(100, volume))
    : 70;
  return (
    <View style={{ gap: desktop ? 16 : 20 }}>
      <View style={[styles.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={{ gap: 5, flex: 1, minWidth: 180 }}>
          <Text style={[styles.heading, desktop && { fontSize: 19 }]}>
            {purpose === "creation" ? "AI audio creation" : "Audio Workspace"}
          </Text>
          <Text style={styles.small}>
            Upload audio you have rights to use, compose instrumental music, or
            create voice narration. Preview and choose the audio before saving.
            Video generation and voice cloning are not connected.
          </Text>
        </View>
        <Action
          secondary
          title="Upload audio"
          icon={Upload}
          disabled={disabled}
          onPress={onUpload}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {purpose !== "creation" && (
          <Pill
            title="Your audio"
            active={tab === "library"}
            onPress={() => {
              if (!disabled) setTab("library");
            }}
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="AI Creation"
          accessibilityHint="Compose instrumental music or create voice narration. No audio upload is needed."
          accessibilityState={{ selected: tab === "create" }}
          onPress={() => {
            if (disabled) return;
            setCreateMode("ai");
            setTab("create");
          }}
          style={{
            minHeight: desktop ? 34 : 42,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingHorizontal: desktop ? 12 : 15,
            paddingVertical: desktop ? 8 : 10,
            borderRadius: desktop ? 7 : 22,
            borderWidth: 1,
            borderColor: tab === "create" ? color.purple : color.border,
            backgroundColor: tab === "create" ? color.purple : color.panel,
          }}
        >
          <Sparkles size={16} color={color.lime} />
          <Text
            style={{ fontFamily: font.medium, color: color.text, fontSize: 13 }}
          >
            AI Creation
          </Text>
        </Pressable>
      </View>
      {!!error && <Notice error text={error} />}
      {!!notice && <Notice text={notice} />}
      {selected && !voiceBusy && (
        <View style={[styles.panel, { gap: 12, padding: desktop ? 16 : 20 }]}>
          <Text style={styles.label}>Audition · {selected.name}</Text>
          <MusicAudition
            key={selected.uri || selected.path}
            audition={selected}
            volume={safeVolume}
            start={purpose !== "creation" && auditionIsAttachment ? start : 0}
            onDuration={
              purpose !== "creation" && auditionIsAttachment
                ? receiveAttachmentDuration
                : undefined
            }
            onAuditionStart={onAuditionStart}
            onPauseReady={registerAuditionPause}
          />
          {purpose !== "creation" && (
            <Field
              label="Soundtrack mix level (%)"
              value={String(Math.round(safeVolume))}
              keyboardType="number-pad"
              maxLength={3}
              editable={!disabled}
              onChangeText={(text) => {
                if (/^\d{1,3}$/.test(text) && Number(text) <= 100)
                  onVolumeChange(Number(text));
              }}
            />
          )}
          {purpose !== "creation" && (
            <Text style={styles.small}>
              Preview volume uses the mix level. The final mix is applied when
              the saved edit is rendered.
            </Text>
          )}
        </View>
      )}
      {purpose !== "creation" && !!attachmentKey && (
        <View style={[styles.panel, { gap: 10, padding: desktop ? 16 : 20 }]}>
          <Text style={styles.label}>
            Attached audio ·{" "}
            {selectedName || selectedFile?.name || "Selected soundtrack"}
          </Text>
          {onStartChange && (
            <>
              <Field
                label="Start within audio file (seconds)"
                value={startDraft}
                keyboardType="decimal-pad"
                maxLength={14}
                editable={!disabled}
                onChangeText={(value) => {
                  setStartDraft(value);
                  setStartError("");
                }}
                placeholder="0"
              />
              <Text style={styles.small}>
                Skip this many seconds from the audio file. The selected audio
                still begins at the start of your edit.
                {attachmentDuration === null
                  ? " Duration is unavailable until this audio's preview loads."
                  : ` Audio duration: ${attachmentDuration.toFixed(3).replace(/\.?0+$/, "")} seconds.`}
              </Text>
              <Action
                secondary
                title="Apply audio start"
                disabled={disabled}
                onPress={() => {
                  if (disabled || !focused) return;
                  try {
                    const value = parseSoundtrackStart(
                      startDraft,
                      attachmentDuration,
                    );
                    auditionPause.current?.();
                    onAuditionStart?.();
                    onStartChange(value);
                    setStartDraft(String(value));
                    setStartError("");
                    setAudition(null);
                    setNotice(
                      `Audio begins at ${value}s in the file. Review the edit and save your draft.`,
                    );
                  } catch (cause) {
                    setStartError(
                      cause instanceof Error
                        ? cause.message
                        : "Audio start is invalid.",
                    );
                  }
                }}
              />
              {!!startError && <Notice error text={startError} />}
            </>
          )}
          {onRemove && (
            <Action
              secondary
              title="Remove attached audio"
              icon={Trash2}
              disabled={disabled}
              onPress={() => {
                if (disabled || !focused) return;
                auditionPause.current?.();
                onAuditionStart?.();
                onRemove();
                setAudition(null);
                setStartError("");
                setNotice(
                  "Audio removed from this edit. Save your draft to keep the change. Existing library files are kept.",
                );
              }}
            />
          )}
        </View>
      )}
      {tab === "library" && (
        <View style={{ gap: 14 }}>
          <View style={[styles.between, { gap: 10 }]}>
            <Text style={[styles.heading, { fontSize: 18 }]}>
              Your uploaded audio
            </Text>
            <Action
              secondary
              title="Refresh audio"
              icon={RefreshCw}
              busy={loading}
              disabled={disabled || !session}
              onPress={() => void load()}
            />
          </View>
          <Field
            label="Search your audio"
            value={query}
            onChangeText={setQuery}
            maxLength={140}
            placeholder="Search by creation title or audio ID"
          />
          {!session ? (
            <Notice text="Sign in to search your private uploaded audio. You can still compose and audition local music without publishing it." />
          ) : loading ? (
            <View style={styles.row}>
              <ActivityIndicator color={color.lime} />
              <Text style={styles.small}>Loading owned audio…</Text>
            </View>
          ) : !tracks.length ? (
            <Notice
              text={
                query
                  ? "No owned audio matches this search."
                  : "No owned audio uploads yet. Upload an audio file to start your library."
              }
            />
          ) : (
            <>
              <Consent
                checked={rights}
                disabled={disabled}
                onChange={() => setRights((value) => !value)}
                label="I own this audio or have permission to use it in this creation."
              />
              {tracks.slice(0, 40).map((track) => (
                <View
                  key={track.media_id}
                  style={[
                    styles.panel,
                    { gap: 10, padding: desktop ? 16 : 20 },
                  ]}
                >
                  <View style={[styles.row, { gap: 10 }]}>
                    <Music2 size={22} color={color.lime} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.label}>{track.name}</Text>
                      <Text style={styles.small}>
                        {(track.size / 1024 / 1024).toFixed(1)} MB · uploaded
                        file
                        {track.rightsExpired
                          ? " · recorded rights expired"
                          : ""}
                      </Text>
                    </View>
                  </View>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    <Action
                      secondary
                      title="Preview audio"
                      icon={Play}
                      disabled={disabled}
                      onPress={() =>
                        setAudition({
                          name: track.name,
                          path: `/api/creator/media/${track.media_id}`,
                        })
                      }
                    />
                    <Action
                      title={
                        selectedMediaId === track.media_id
                          ? "Use selected audio"
                          : "Use audio"
                      }
                      disabled={disabled || !rights || track.rightsExpired}
                      onPress={() => attachOwned(track)}
                    />
                  </View>
                </View>
              ))}
              {tracks.length > 40 && (
                <Text style={styles.small}>
                  Showing the first 40 matches. Narrow your search to find
                  another track.
                </Text>
              )}
            </>
          )}
          <Text style={styles.small}>
            An upload proves storage ownership, not a music license. Expired
            recorded rights must be updated in the library before reuse.
          </Text>
        </View>
      )}
      {tab === "create" && (
        <View style={[styles.panel, { gap: 14 }]}>
          <View style={styles.row}>
            <Sparkles size={22} color={color.lime} />
            <Text style={[styles.heading, { fontSize: 18 }]}>
              Create audio with AI
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pill
              title="AI composer"
              active={createMode === "ai"}
              onPress={() => {
                if (!disabled) setCreateMode("ai");
              }}
            />
            <Pill
              title="AI Voice Narration"
              active={createMode === "voice"}
              onPress={() => {
                if (!disabled) setCreateMode("voice");
              }}
            />
            <Pill
              title="Offline fallback"
              active={createMode === "offline"}
              onPress={() => {
                if (!disabled) setCreateMode("offline");
              }}
            />
          </View>
          {createMode === "voice" ? (
            <VoiceNarrationWorkspace
              key={`${session?.access_token || "guest"}:${purpose}`}
              purpose={purpose}
              attachedFileUri={selectedFile?.uri || null}
              busy={busy || generating}
              onBusyChange={setVoiceBusy}
              onAuditionStart={pauseForVoiceCapture}
              onUseGenerated={onUseGenerated}
            />
          ) : (
            <>
              {createMode === "ai" ? (
                <View style={{ gap: 10 }}>
                  <Notice
                    text={`A language model composes the actual melody, harmony, rhythm and instrument events; Ziipa renders the score to WAV locally. ${aiConfig?.provider === "cloudflare" ? "Your description and controls are sent to Cloudflare Workers AI, a third-party inference service subject to its policies." : aiConfig?.provider === "private" ? "Your description and controls are sent to Ziipa's private configured inference service." : "Refresh status to identify the configured inference provider before consenting."} No uploaded audio or library context is sent. This is instrumental score synthesis, not a vocals or studio-audio model.`}
                  />
                  <Text style={styles.small}>
                    {!session
                      ? "Sign in to use Ziipa's AI composer. The offline fallback remains available."
                      : configLoading
                        ? "Checking music model readiness..."
                        : aiConfig?.available
                          ? `Model ready: ${aiConfig.model || "configured model"}. Up to 48 notes / 30 seconds.`
                          : aiConfig?.detail ||
                            "AI model availability has not been verified. Refresh status or explicitly choose the offline fallback."}
                  </Text>
                  <Action
                    secondary
                    title="Refresh model status"
                    icon={RefreshCw}
                    busy={configLoading}
                    disabled={disabled || !session}
                    onPress={() => void loadAiConfig()}
                  />
                  <Consent
                    checked={aiConsent}
                    disabled={disabled}
                    onChange={() => setAiConsent((value) => !value)}
                    label={
                      aiConfig?.provider === "cloudflare"
                        ? "Send my description and arrangement controls to Cloudflare Workers AI (third-party inference) to compose this instrumental."
                        : aiConfig?.provider === "private"
                          ? "Send my description and arrangement controls to Ziipa's private inference model to compose this instrumental."
                          : "I will review the identified inference provider before generating music."
                    }
                  />
                </View>
              ) : (
                <Notice text="Offline procedural composer: no AI model. Keyword rules suggest controls; mathematical synthesis creates a WAV on this device. No vocals, artist imitation, samples, paid API or external training. It is never used silently when AI is unavailable." />
              )}

              <Field
                label="Describe your instrumental"
                value={settings.prompt}
                onChangeText={(prompt) =>
                  setSettings((value) => ({ ...value, prompt }))
                }
                maxLength={500}
                multiline
                editable={!disabled}
                placeholder="Bright electronic instrumental, 120 BPM, for a travel video"
              />
              {createMode === "offline" && (
                <Action
                  secondary
                  title="Plan from prompt"
                  disabled={disabled}
                  onPress={() => {
                    setSettings((value) =>
                      planMusicPrompt(value.prompt, value),
                    );
                    setNotice(
                      "Arrangement updated from recognized keywords. Review the controls before creating audio.",
                    );
                  }}
                />
              )}
              <Text style={styles.label}>Arrangement</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {musicStyles.map((style) => (
                  <Pill
                    key={style}
                    title={style}
                    active={settings.style === style}
                    onPress={() => {
                      if (!disabled)
                        setSettings((value) => ({ ...value, style }));
                    }}
                  />
                ))}
              </View>
              <Text style={styles.label}>Mood</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {musicMoods.map((mood) => (
                  <Pill
                    key={mood}
                    title={mood}
                    active={settings.mood === mood}
                    onPress={() => {
                      if (!disabled)
                        setSettings((value) => ({ ...value, mood }));
                    }}
                  />
                ))}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {[70, 90, 110, 130, 150].map((bpm) => (
                  <Pill
                    key={bpm}
                    title={`${bpm} BPM`}
                    active={settings.bpm === bpm}
                    onPress={() => {
                      if (!disabled)
                        setSettings((value) => ({ ...value, bpm }));
                    }}
                  />
                ))}
              </View>
              <Text style={styles.label}>Duration</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {[10, 20, 30].map((duration) => (
                  <Pill
                    key={duration}
                    title={`${duration} seconds`}
                    active={settings.duration === duration}
                    onPress={() => {
                      if (!disabled)
                        setSettings((value) => ({ ...value, duration }));
                    }}
                  />
                ))}
              </View>
              <Text style={styles.small}>
                {createMode === "offline"
                  ? `${plan.summary} · ${plan.voices.join(", ")}`
                  : `${settings.duration}s / ${settings.bpm} BPM / ${settings.style} / ${settings.mood}. The AI chooses the actual notes and voices.`}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Action
                  title={
                    createMode === "ai"
                      ? "Generate AI Music"
                      : generated
                        ? "Create another offline version"
                        : "Create offline instrumental"
                  }
                  icon={Sparkles}
                  busy={generating}
                  disabled={
                    busy ||
                    (createMode === "ai" &&
                      (!session ||
                        !aiConfig?.available ||
                        !aiConsent ||
                        !settings.prompt.trim()))
                  }
                  onPress={() => void generate()}
                />
                {createMode === "offline" && (
                  <Action
                    secondary
                    title="New variation"
                    disabled={disabled}
                    onPress={() =>
                      setSettings((value) => ({
                        ...value,
                        variation: (value.variation + 1) % 10000,
                      }))
                    }
                  />
                )}
              </View>
              <Text style={styles.small}>
                {createMode === "offline"
                  ? `Variation ${settings.variation + 1}. `
                  : "AI score rendered locally. "}{" "}
                PCM WAV, mono 22.05 kHz, up to 30 seconds. Changing controls
                does not alter an already generated version.
              </Text>
              {generated && (
                <View
                  style={{
                    gap: 10,
                    paddingTop: 10,
                    borderTopWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <Text style={styles.label}>
                    Generated version · {generated.plan.summary}
                  </Text>
                  {"model" in generated.plan && (
                    <Text style={styles.small}>
                      AI model: {generated.plan.model}. Score{" "}
                      {generated.plan.fingerprint.slice(0, 12)}
                    </Text>
                  )}
                  <Text style={styles.small}>
                    {generated.plan.engine === "ziipa-llm-composer-v1"
                      ? "AI-composed. "
                      : "Offline procedural. "}
                    {(generated.file.size / 1024 / 1024).toFixed(1)} MB ·
                    synthesized audio. Review the source and musical rights
                    before sharing or minting. AI generation does not establish
                    ownership or copyright exclusivity.
                  </Text>
                  <Action
                    secondary
                    title="Audition generated version"
                    icon={Play}
                    disabled={disabled}
                    onPress={() =>
                      setAudition({
                        name: generatedName(generated.plan),
                        uri: generated.file.uri,
                      })
                    }
                  />
                  <Action
                    title={
                      purpose === "creation"
                        ? attached
                          ? "Selected as audio creation"
                          : "Use as audio creation"
                        : attached
                          ? "Attached to this edit"
                          : "Attach generated music"
                    }
                    icon={Check}
                    disabled={disabled || attached}
                    onPress={attachGenerated}
                  />
                </View>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

function Consent({
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
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onChange}
      style={[styles.row, { gap: 10, paddingVertical: 8 }]}
    >
      <View
        style={{
          width: 23,
          height: 23,
          borderWidth: 1,
          borderColor: color.lime,
          borderRadius: 6,
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
