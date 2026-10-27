import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  Check,
  Mic,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { Action, Field, Notice, Pill } from "./ui";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import { useVoiceCapture } from "../lib/voice-capture";
import {
  generatedMusicFile,
  type GeneratedMusicFile,
} from "../lib/generated-music-file";
import {
  narrationRequest,
  validateNarrationAudio,
  validateNarrationConfig,
  type NarrationConfig,
  type NarrationVoiceId,
} from "../lib/voice-narration";
import type { UploadFile } from "../lib/api";
import { color, styles } from "../theme";
import { MusicAudition } from "./audio-audition";

type Props = {
  purpose: "creation" | "soundtrack";
  /** Undefined retains standalone behavior; null means no parent attachment. */
  attachedFileUri?: string | null;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onAuditionStart?: () => void;
  onUseGenerated: (
    file: UploadFile,
    release: () => Promise<void>,
    title: string,
  ) => void;
};
type Held = GeneratedMusicFile & {
  title: string;
  kind: "preset" | "recording";
  transferred: boolean;
};

export function VoiceNarrationWorkspace({ ...props }: Props) {
  const { session } = useZiipa();
  return (
    <ScopedVoiceNarrationWorkspace
      key={`${session?.access_token || "guest"}:${props.purpose}`}
      {...props}
    />
  );
}

function ScopedVoiceNarrationWorkspace({
  purpose,
  attachedFileUri,
  busy,
  onBusyChange,
  onAuditionStart,
  onUseGenerated,
}: Props) {
  const { api, session } = useZiipa();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const capture = useOperationScope(
    session?.access_token || "guest",
    focused && foreground,
  );
  const recording = useVoiceCapture();
  const [config, setConfig] = useState<NarrationConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState("");
  const [voiceId, setVoiceId] = useState<NarrationVoiceId>("athena");
  const [consent, setConsent] = useState(false);
  const [recordConsent, setRecordConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lease = useRef<Held | null>(null);
  useEffect(() => {
    const previous = lease.current;
    if (
      attachedFileUri !== undefined &&
      previous?.transferred &&
      previous.file.uri !== attachedFileUri
    ) {
      // The parent owns disposal after transfer. Never audition its released file.
      lease.current = null;
      setHeld(null);
    }
  }, [attachedFileUri, held?.transferred]);
  const auditionPause = useRef<(() => void) | null>(null);
  const registerAuditionPause = useCallback((pause: (() => void) | null) => {
    auditionPause.current = pause;
  }, []);
  const epoch = useRef(0),
    lock = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const stopRef = useRef<() => void>(() => {});
  const clearTimers = useCallback(() => {
    clearTimeout(timer.current);
    clearInterval(ticker.current);
  }, []);
  const cancel = useCallback(() => {
    epoch.current++;
    lock.current = false;
    clearTimers();
    recording.cancel();
    const previous = lease.current;
    lease.current = null;
    if (previous && !previous.transferred)
      void previous.release().catch(() => {});
    setHeld(null);
    setWorking(false);
    setIsRecording(false);
    setSeconds(0);
    setLoading(false);
    setConsent(false);
    setRecordConsent(false);
    onBusyChange(false);
  }, [clearTimers, recording.cancel, onBusyChange]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active") cancel();
    });
    return () => listener.remove();
  }, [cancel]);
  useEffect(() => {
    if (!focused) cancel();
  }, [focused, cancel]);
  useEffect(
    () => () => {
      epoch.current++;
      clearTimers();
      recording.cancel();
      const previous = lease.current;
      if (previous && !previous.transferred)
        void previous.release().catch(() => {});
      onBusyChange(false);
    },
    [clearTimers, recording.cancel, onBusyChange],
  );
  useEffect(() => {
    onBusyChange(working);
  }, [working, onBusyChange]);
  const loadConfig = useCallback(async () => {
    if (!session || !focused || !foreground) return;
    const current = capture(),
      operation = epoch.current;
    setLoading(true);
    setError("");
    try {
      const next = validateNarrationConfig(
        await api<unknown>("/api/audio/narration/config"),
      );
      if (current() && epoch.current === operation) setConfig(next);
    } catch (cause) {
      if (current() && epoch.current === operation) {
        setConfig(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "Voice status could not load.",
        );
      }
    } finally {
      if (current() && epoch.current === operation) setLoading(false);
    }
  }, [api, session?.access_token, focused, foreground, capture]);
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function keep(
    bytes: Uint8Array,
    title: string,
    kind: Held["kind"],
    current: () => boolean,
  ) {
    if (!current()) return;
    const next = await generatedMusicFile(bytes);
    if (!current()) {
      await next.release();
      return;
    }
    const previous = lease.current;
    if (previous && !previous.transferred) await previous.release();
    if (!current()) {
      await next.release();
      return;
    }
    const value: Held = { ...next, title, kind, transferred: false };
    lease.current = value;
    setHeld(value);
    setNotice(
      kind === "recording"
        ? "Your recorded narration is a local WAV. Preview and explicitly attach it; it has not been uploaded or used for cloning."
        : "Narration WAV passed its format and SHA-256 checks. Preview and explicitly attach it; it has not been saved or shared.",
    );
  }
  async function generate() {
    if (busy || lock.current || !focused || !foreground || !session || !config)
      return;
    let request;
    try {
      request = narrationRequest(config, script, voiceId, consent);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    lock.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    const scope = capture(),
      operation = ++epoch.current;
    const current = () => scope() && epoch.current === operation;
    try {
      const response = await api<unknown>("/api/audio/narration", request);
      if (!current()) return;
      const bytes = await validateNarrationAudio(
        response,
        voiceId,
        async (value) => {
          const copy = new Uint8Array(value.length);
          copy.set(value);
          const hash = new Uint8Array(
            await Crypto.digest(
              Crypto.CryptoDigestAlgorithm.SHA256,
              copy.buffer,
            ),
          );
          return Array.from(hash, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        },
      );
      await keep(
        bytes,
        `${config.voices.find((voice) => voice.id === voiceId)?.label || "AI"} narration`,
        "preset",
        current,
      );
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Narration could not be generated. No fallback was substituted.",
        );
    } finally {
      if (current()) {
        lock.current = false;
        setWorking(false);
      }
    }
  }
  async function startRecording() {
    if (
      busy ||
      lock.current ||
      !recordConsent ||
      !focused ||
      !foreground ||
      !session
    )
      return;
    lock.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    const scope = capture(),
      operation = ++epoch.current;
    const current = () => scope() && epoch.current === operation;
    try {
      auditionPause.current?.();
      onAuditionStart?.();
      // Unmount audition before permission/capture so a prior take cannot feed
      // its playback into the microphone. Unattached files are never retained.
      const previous = lease.current;
      lease.current = null;
      setHeld(null);
      if (previous && !previous.transferred) await previous.release();
      if (!current()) return;
      await recording.start();
      if (!current()) {
        recording.cancel();
        return;
      }
      setSeconds(0);
      setIsRecording(true);
      ticker.current = setInterval(
        () => setSeconds((value) => Math.min(30, value + 1)),
        1000,
      );
      timer.current = setTimeout(() => stopRef.current(), 30000);
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Microphone recording failed.",
        );
        lock.current = false;
        setWorking(false);
      }
    }
  }
  async function stopRecording() {
    if (!lock.current || !isRecording) return;
    clearTimers();
    setIsRecording(false);
    const scope = capture(),
      operation = epoch.current;
    const current = () => scope() && epoch.current === operation;
    try {
      const bytes = await recording.stop();
      await keep(bytes, "My voice narration", "recording", current);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Recording could not be converted to WAV.",
        );
    } finally {
      if (current()) {
        lock.current = false;
        setWorking(false);
      }
    }
  }
  stopRef.current = () => void stopRecording();
  const disabled = busy || working || !focused || !foreground;
  const selected = config?.voices.find((voice) => voice.id === voiceId);
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.heading}>AI Voice Narration</Text>
      <Notice text="Turn your script into a real audio file using a preset voice, or record your own narration locally. Recording your voice does not clone it. No microphone sample is sent to Cloudflare." />
      <Text style={styles.small}>
        {loading
          ? "Checking voice service…"
          : config?.available
            ? "Preset narration is available on the configured free service."
            : config?.detail ||
              "Preset narration is unavailable until Ziipa verifies the free provider."}
      </Text>
      <Action
        secondary
        title="Refresh voice status"
        icon={RefreshCw}
        busy={loading}
        disabled={disabled || !session}
        onPress={() => void loadConfig()}
      />
      <Field
        label="Narration script"
        value={script}
        onChangeText={(value) => {
          setScript(value);
          setConsent(false);
        }}
        multiline
        maxLength={300}
        editable={!disabled}
        placeholder="Write what you want the narrator to say…"
      />
      <Text style={styles.small}>
        {script.length}/300 characters · up to 30 seconds
      </Text>
      <Text style={styles.label}>Preset voice and accent</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {config?.voices.map((voice) => (
          <Pill
            key={voice.id}
            title={voice.label}
            active={voiceId === voice.id}
            onPress={() => {
              if (!disabled) {
                setVoiceId(voice.id);
                setConsent(false);
              }
            }}
          />
        ))}
      </View>
      {selected && (
        <Text style={styles.small}>
          {selected.language} ·{" "}
          {selected.available ? "Preset available" : "Preset unavailable"}
        </Text>
      )}
      <VoiceConsent
        checked={consent}
        disabled={disabled}
        onChange={() => setConsent((value) => !value)}
        label="Send only this script to Cloudflare Workers AI, a third-party service, to generate narration in the selected preset voice. Do not include confidential or personal information."
      />
      <Action
        title="Generate AI narration"
        icon={Sparkles}
        busy={working && !isRecording}
        disabled={
          disabled ||
          !session ||
          !config?.available ||
          !selected?.available ||
          !consent ||
          !script.trim()
        }
        onPress={() => void generate()}
      />
      <View
        style={{
          gap: 10,
          borderTopWidth: 1,
          borderColor: color.border,
          paddingTop: 14,
        }}
      >
        <Text style={styles.label}>Record your own narration</Text>
        <VoiceConsent
          checked={recordConsent}
          disabled={disabled}
          onChange={() => setRecordConsent((value) => !value)}
          label="I consent to microphone capture of my own voice on this device. This take stays local until I explicitly attach and save it. Leaving this screen or backgrounding deletes an un-attached take."
        />
        <Action
          title={
            isRecording
              ? `Stop recording · ${seconds}s / 30s`
              : "Record my voice"
          }
          icon={isRecording ? Square : Mic}
          disabled={
            busy || (!isRecording && (disabled || !recordConsent || !session))
          }
          onPress={() =>
            isRecording ? void stopRecording() : void startRecording()
          }
        />
        {working && (
          <Action secondary title="Cancel and discard" onPress={cancel} />
        )}
      </View>
      <Notice
        text={
          config?.clone.detail ||
          "Own-voice cloning is unavailable: no verified private cloning runtime is connected. You cannot upload a reference, clone another person, or generate cloned speech in this release."
        }
      />
      {!!error && <Notice error text={error} />}
      {!!notice && <Notice text={notice} />}
      {held && (
        <View style={[styles.panel, { gap: 10 }]}>
          <Text style={styles.label}>
            {held.title} · {(held.file.size / 1024).toFixed(0)} KB · WAV
          </Text>
          <MusicAudition
            audition={{ name: held.title, uri: held.file.uri }}
            volume={100}
            onAuditionStart={onAuditionStart}
            onPauseReady={registerAuditionPause}
          />
          <Action
            title={
              held.transferred
                ? "Audio attached"
                : purpose === "creation"
                  ? "Use as audio creation"
                  : "Attach narration to this edit"
            }
            icon={Check}
            disabled={disabled || held.transferred}
            onPress={() => {
              if (disabled || held.transferred || lease.current !== held)
                return;
              // Mark ownership before the callback, which may immediately unmount this view.
              held.transferred = true;
              try {
                onUseGenerated(held.file, held.release, held.title);
                setHeld({ ...held });
              } catch (cause) {
                held.transferred = false;
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Audio could not be attached.",
                );
              }
            }}
          />
          {!held.transferred && (
            <Action
              secondary
              title="Delete this take"
              icon={Trash2}
              disabled={disabled}
              onPress={cancel}
            />
          )}
          <Text style={styles.small}>
            {held.kind === "preset"
              ? "AI-generated preset speech. "
              : "Your direct microphone recording. "}
            Review the result before saving, sharing or minting. Generation does
            not establish exclusive rights.
          </Text>
        </View>
      )}
    </View>
  );
}

function VoiceConsent({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
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
