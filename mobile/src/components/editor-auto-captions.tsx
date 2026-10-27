import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  Captions,
  Check,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { useZiipa } from "../provider";
import { Action, Notice } from "./ui";
import { color, font, styles } from "../theme";
import { formatTimelineTime } from "../lib/editor-timeline";
import { validateCaptionCues } from "../lib/auto-captions";
import {
  addCaptionDraft,
  applyCaptionDraft,
  captionDrafts,
  captionSourceLimit,
  captionTimeText,
  MAX_CAPTION_CUES,
  parseCaptionTime,
  type CaptionDraft,
  type CaptionEditorDraftState,
} from "../lib/caption-editor";
import type { Caption } from "../lib/types";

type Config = {
  can_run: boolean;
  provider?: string;
  detail: string;
  consent_detail?: string;
};
type Job = {
  job_id: string;
  status: "queued" | "running" | "ready" | "no_speech" | "unavailable";
  source_media_id: string;
  segments: Caption[];
  detail: string;
};

/** Proposals never change the edit until Apply is explicitly chosen. */
export function EditorAutoCaptions({
  itemId,
  mediaId,
  sourceKey,
  accepted,
  sourceDuration,
  sourceTime,
  onSeekSource,
  onDraftChange,
  draftState,
  onDraftStateChange,
  disabled,
  onApply,
  onSaveSource,
  onRights,
}: {
  itemId?: string;
  mediaId?: string | null;
  sourceKey: string;
  accepted: Caption[] | null;
  sourceDuration: number;
  sourceTime?: number;
  onSeekSource?: (time: number) => boolean | void;
  onDraftChange?: (pending: boolean) => void;
  /** Keep this in the Composer parent to retain edits across responsive layouts. */
  draftState?: CaptionEditorDraftState | null;
  onDraftStateChange?: (draft: CaptionEditorDraftState | null) => void;
  disabled: boolean;
  onApply: (cues: Caption[] | null) => void;
  onSaveSource: () => void;
  onRights: () => void;
}) {
  const { api, session, guest } = useZiipa();
  const [config, setConfig] = useState<Config | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localDraft, setLocalDraft] = useState<CaptionEditorDraftState | null>(
    null,
  );
  const heldDraft = draftState === undefined ? localDraft : draftState;
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const active = useRef(true);
  const scope = JSON.stringify([
    session?.user.id ?? "guest",
    itemId || "",
    mediaId || "",
    sourceKey,
  ]);
  // A newly rendered source/account must never expose the old draft while
  // waiting for passive cleanup, even when both accepted tracks are null.
  const proposalScope = heldDraft?.scope;
  const proposalBase = heldDraft?.base;
  const proposal = proposalScope === scope ? heldDraft!.rows : null;
  function writeDraft(next: CaptionEditorDraftState | null) {
    if (draftState === undefined) setLocalDraft(next);
    onDraftStateChange?.(next);
  }
  function setProposal(rows: CaptionDraft[]) {
    if (heldDraft?.scope === scope) writeDraft({ ...heldDraft, rows });
  }
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const acceptedKey = JSON.stringify(accepted);
  const currentAccepted = useRef(acceptedKey);
  currentAccepted.current = acceptedKey;
  const limit = captionSourceLimit(sourceDuration);
  const acceptedChanged = proposal !== null && proposalBase !== acceptedKey;
  const hasDraft = proposal !== null;
  useEffect(() => {
    onDraftChange?.(hasDraft);
    return () => {
      onDraftChange?.(false);
    };
  }, [hasDraft, onDraftChange]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    if (heldDraft && heldDraft.scope !== scope) writeDraft(null);
    setConsent(false);
    setBusy(false);
    setMessage("");
    setConfig(null);
  }, [scope]);
  const valid = (run: number, key: string) =>
    active.current && epoch.current === run && currentScope.current === key;
  async function loadConfig() {
    if (!session || guest) return;
    const run = ++epoch.current,
      key = scope;
    setConfig(null);
    setConsent(false);
    try {
      const result = await api<Config>("/api/editor/captions/config");
      if (valid(run, key)) {
        setConsent(false);
        setConfig(result);
      }
    } catch (error) {
      if (valid(run, key))
        setMessage(
          error instanceof Error
            ? error.message
            : "Caption status is unavailable.",
        );
    }
  }
  useEffect(() => {
    void loadConfig();
  }, [scope]);
  async function recognize() {
    if (
      disabled ||
      busy ||
      proposal !== null ||
      !consent ||
      !config?.can_run ||
      !itemId ||
      !mediaId
    )
      return;
    const run = ++epoch.current,
      key = scope;
    const base = currentAccepted.current;
    setBusy(true);
    setMessage("Reading speech… Your current captions are unchanged.");
    try {
      let result = await api<Job>(
        `/api/editor/items/${encodeURIComponent(itemId)}/captions`,
        {
          request_id: Crypto.randomUUID(),
          consent: true,
          expected_media_id: mediaId,
          expected_provider: config.provider || "private",
          language: "auto",
        },
      );
      const deadline = Date.now() + 125000;
      while (["queued", "running"].includes(result.status) && valid(run, key)) {
        if (Date.now() >= deadline)
          throw new Error(
            "Recognition is taking too long. Your caption track is unchanged; retry later.",
          );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!valid(run, key)) return;
        result = await api<Job>(
          `/api/editor/caption-jobs/${encodeURIComponent(result.job_id)}`,
        );
      }
      if (!valid(run, key)) return;
      if (result.source_media_id !== mediaId)
        throw new Error(
          "The source changed. Run Auto captions again for the selected media.",
        );
      if (result.status === "ready") {
        const cues = validateCaptionCues(result.segments);
        if (!cues.length)
          throw new Error(
            "No speech was recognized. Your caption track is unchanged.",
          );
        writeDraft({ scope: key, base, rows: captionDrafts(cues) });
        setMessage(
          "Review the words below. Nothing changes until you apply this draft.",
        );
      } else
        setMessage(
          result.detail ||
            "Speech recognition is unavailable. Your caption track is unchanged.",
        );
    } catch (error) {
      if (valid(run, key))
        setMessage(
          error instanceof Error
            ? error.message
            : "Captions could not be recognized.",
        );
    } finally {
      if (valid(run, key)) setBusy(false);
    }
  }
  function beginDraft() {
    if (busy || disabled || !limit) return;
    writeDraft({
      scope,
      base: acceptedKey,
      rows: captionDrafts(accepted || []),
    });
    setMessage(
      "Edit source timestamps and words, then apply. Your current track is unchanged.",
    );
  }
  function change(
    id: string,
    patch: Partial<Pick<CaptionDraft, "start" | "end" | "text">>,
  ) {
    if (!proposal || busy || disabled || acceptedChanged) return;
    setProposal(
      proposal.map((cue) => (cue.id === id ? { ...cue, ...patch } : cue)),
    );
  }
  function add() {
    if (!proposal || busy || disabled || acceptedChanged) return;
    try {
      setProposal(addCaptionDraft(proposal, sourceTime ?? 0, sourceDuration));
      setMessage(
        "Add the caption words, review its source times, then apply the track.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Choose a source gap for this caption.",
      );
    }
  }
  function preview(time: string) {
    try {
      const seconds = parseCaptionTime(time);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds >= limit)
        throw new Error(
          "Keep the preview time inside the original media's caption range.",
        );
      if (onSeekSource?.(seconds) === false)
        setMessage(
          "This source moment is outside your current clips. Restore that section to preview it.",
        );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Enter a valid caption start before previewing.",
      );
    }
  }
  function applyDraft() {
    if (
      !active.current ||
      currentScope.current !== scope ||
      disabled ||
      busy ||
      proposal === null ||
      proposalScope !== scope ||
      currentAccepted.current !== proposalBase
    )
      return;
    try {
      onApply(applyCaptionDraft(proposal, sourceDuration));
      writeDraft(null);
      setMessage(
        "Caption draft applied to this edit. Save when you are ready.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Review caption words and source times.",
      );
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.between}>
        <View style={styles.row}>
          <Captions size={18} color={color.lime} />
          <Text style={styles.label}>Caption track</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh auto caption status"
          disabled={busy || disabled}
          onPress={() => void loadConfig()}
          style={{ padding: 8 }}
        >
          <RefreshCw color={color.muted} size={17} />
        </Pressable>
      </View>
      <Action
        title={busy ? "Reading speech…" : "Auto captions"}
        icon={Sparkles}
        disabled={
          disabled ||
          busy ||
          proposal !== null ||
          !consent ||
          !itemId ||
          !mediaId ||
          !config?.can_run
        }
        onPress={() => void recognize()}
      />
      {guest ? (
        <Text style={styles.small}>
          Sign in and save your own video or audio to recognize speech.
        </Text>
      ) : !itemId || !mediaId ? (
        <>
          <Text style={styles.small}>
            Save your video or audio privately first. Recognition uses its
            original speech, not your added soundtrack.
          </Text>
          <Action
            title="Save privately for captions"
            disabled={disabled || busy}
            onPress={onSaveSource}
            secondary
          />
        </>
      ) : (
        <>
          <Text style={styles.small}>
            {config?.detail || "Checking speech recognition…"}
          </Text>
          <Action
            title="Review media rights & AI permission"
            secondary
            disabled={disabled || busy}
            onPress={onRights}
          />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={
              config?.consent_detail ||
              "Allow speech recognition for this selected source."
            }
            accessibilityState={{
              checked: consent,
              disabled: disabled || busy || !config,
            }}
            aria-checked={consent}
            disabled={disabled || busy || !config}
            onPress={() => setConsent((value) => !value)}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 9,
              paddingVertical: 6,
            }}
          >
            <View
              style={{
                width: 19,
                height: 19,
                borderWidth: 1,
                borderColor: consent ? color.lime : color.muted,
                borderRadius: 4,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {consent && <Check size={15} color={color.lime} />}
            </View>
            <Text style={[styles.small, { flex: 1 }]}>
              {config?.consent_detail ||
                "Allow speech recognition for this selected source."}
            </Text>
          </Pressable>
        </>
      )}
      {!!message && <Notice text={message} />}
      <View style={{ gap: 8 }}>
        <Text
          style={[
            styles.label,
            { color: proposal !== null ? color.lime : color.text },
          ]}
        >
          {proposal !== null
            ? "Caption draft · review before applying"
            : "Timed captions"}
        </Text>
        <Text style={styles.small}>
          Use original-media timestamps. Your cuts and speed changes retime
          these captions in the edited sequence.
          {sourceDuration > 90
            ? " Source captions currently cover only the first 90 seconds."
            : ""}
        </Text>
        {!limit && (
          <Text style={styles.small}>
            Load video or audio to check its duration before creating timed
            captions.
          </Text>
        )}
        {proposal === null ? (
          <>
            {accepted?.map((cue, index) => (
              <View
                key={`${index}:${cue.start}:${cue.end}`}
                style={{
                  flexDirection: "row",
                  gap: 8,
                  alignItems: "center",
                  paddingVertical: 5,
                }}
              >
                <Text style={[styles.small, { flex: 1 }]}>
                  {formatTimelineTime(cue.start)}–{formatTimelineTime(cue.end)}{" "}
                  · {cue.text}
                </Text>
                {!!onSeekSource && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Preview caption ${index + 1}`}
                    disabled={disabled || busy || !limit}
                    onPress={() => preview(String(cue.start))}
                    style={{ padding: 8 }}
                  >
                    <Play color={color.muted} size={16} />
                  </Pressable>
                )}
              </View>
            ))}
            <Action
              title={
                accepted !== null ? "Edit timed track" : "Create a timed track"
              }
              secondary
              icon={Plus}
              disabled={disabled || busy || !limit}
              onPress={beginDraft}
            />
            <Text style={[styles.small, { fontSize: 11 }]}>
              You can write captions manually even when Auto captions is
              unavailable. Applying a timed track replaces the manual caption
              below.
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.small, { fontSize: 11 }]}>
              These changes stay in this panel until Apply. Discard or leaving
              this creation keeps the accepted track. {proposal.length}/
              {MAX_CAPTION_CUES} cues.
            </Text>
            {acceptedChanged && (
              <Notice
                error
                text="The accepted track changed while this draft was open. Discard this draft, then edit the current track again."
              />
            )}
            {proposal.map((cue, index) => (
              <View
                key={cue.id}
                style={{
                  gap: 7,
                  backgroundColor: color.panel,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: color.border,
                }}
              >
                <View
                  style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
                >
                  <Text style={[styles.small, { fontSize: 11 }]}>
                    {index + 1}
                  </Text>
                  {(["start", "end"] as const).map((edge) => (
                    <View key={edge} style={{ flex: 1, gap: 3 }}>
                      <Text style={[styles.small, { fontSize: 10 }]}>
                        {edge === "start" ? "Start" : "End"} · source seconds
                      </Text>
                      <TextInput
                        accessibilityLabel={`Caption ${index + 1} ${edge}`}
                        value={cue[edge]}
                        onChangeText={(value) =>
                          change(cue.id, { [edge]: value })
                        }
                        editable={!disabled && !busy && !acceptedChanged}
                        keyboardType="numbers-and-punctuation"
                        maxLength={24}
                        style={{
                          color: color.text,
                          borderWidth: 1,
                          borderColor: color.border,
                          borderRadius: 6,
                          fontFamily: font.regular,
                          minHeight: 38,
                          padding: 7,
                        }}
                      />
                    </View>
                  ))}
                  {!!onSeekSource && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Preview caption ${index + 1}`}
                      disabled={disabled || busy || !limit}
                      onPress={() => preview(cue.start)}
                      style={{ padding: 7 }}
                    >
                      <Play color={color.muted} size={16} />
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove caption ${index + 1}`}
                    disabled={disabled || busy || acceptedChanged}
                    onPress={() =>
                      setProposal(proposal.filter((row) => row.id !== cue.id))
                    }
                    style={{ padding: 7 }}
                  >
                    <Trash2 color={color.muted} size={16} />
                  </Pressable>
                </View>
                <TextInput
                  accessibilityLabel={`Caption ${index + 1} words`}
                  value={cue.text}
                  onChangeText={(text) => change(cue.id, { text })}
                  maxLength={250}
                  editable={!disabled && !busy && !acceptedChanged}
                  multiline
                  placeholder="Caption words…"
                  placeholderTextColor={color.faint}
                  style={{
                    color: color.text,
                    fontFamily: font.regular,
                    fontSize: 14,
                    minHeight: 42,
                    padding: 7,
                    borderWidth: 1,
                    borderColor: color.border,
                    borderRadius: 6,
                  }}
                />
              </View>
            ))}
            {!proposal.length && (
              <Text style={styles.small}>
                This draft is empty. Add a cue, or apply it to clear the timed
                track.
              </Text>
            )}
            {!!proposal.length && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear caption draft"
                disabled={disabled || busy || acceptedChanged}
                onPress={() => setProposal([])}
                style={{
                  flexDirection: "row",
                  gap: 6,
                  alignItems: "center",
                  alignSelf: "flex-end",
                  padding: 8,
                }}
              >
                <Trash2 color={color.muted} size={14} />
                <Text style={[styles.small, { fontSize: 12 }]}>
                  Clear draft
                </Text>
              </Pressable>
            )}
            <Action
              title={
                sourceTime === undefined
                  ? "Add caption"
                  : `Add at ${captionTimeText(Math.round(sourceTime * 1000) / 1000)} source seconds`
              }
              icon={Plus}
              secondary
              disabled={
                disabled ||
                busy ||
                acceptedChanged ||
                !limit ||
                proposal.length >= MAX_CAPTION_CUES
              }
              onPress={add}
            />
            <Action
              title={
                proposal.length ? "Apply caption draft" : "Apply empty track"
              }
              icon={Check}
              disabled={disabled || busy || acceptedChanged || !limit}
              onPress={applyDraft}
            />
            <Action
              title="Discard caption draft"
              secondary
              disabled={disabled || busy}
              onPress={() => {
                writeDraft(null);
                setMessage(
                  "Caption draft discarded. Your accepted track is unchanged.",
                );
              }}
            />
          </>
        )}
      </View>
      <Text style={[styles.small, { fontSize: 11 }]}>
        Machine recognition can make mistakes. Review names, words and timing.
        No captions are published automatically.
      </Text>
    </View>
  );
}
