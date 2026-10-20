import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Captions, Check, RefreshCw, Sparkles, Trash2 } from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { useZiipa } from "../provider";
import { Action, Notice } from "./ui";
import { color, font, styles } from "../theme";
import { formatTimelineTime } from "../lib/editor-timeline";
import { validateCaptionCues } from "../lib/auto-captions";
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
export function EditorAutoCaptions({ itemId, mediaId, sourceKey, accepted,
  disabled, onApply, onSaveSource, onRights }: {
  itemId?: string;
  mediaId?: string | null;
  sourceKey: string;
  accepted: Caption[] | null;
  disabled: boolean;
  onApply: (cues: Caption[] | null) => void;
  onSaveSource: () => void;
  onRights: () => void;
}) {
  const { api, session, guest } = useZiipa();
  const [config, setConfig] = useState<Config | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Caption[] | null>(null);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const active = useRef(true);
  const scope = `${session?.access_token || "guest"}:${itemId || ""}:${mediaId || ""}:${sourceKey}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { active.current = true; return () => { active.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    epoch.current++;
    setProposal(null); setConsent(false); setBusy(false); setMessage("");
    setConfig(null);
  }, [scope]);
  const valid = (run: number, key: string) => active.current && epoch.current === run && currentScope.current === key;
  async function loadConfig() {
    if (!session || guest) return;
    const run = ++epoch.current, key = scope;
    setConfig(null); setConsent(false);
    try {
      const result = await api<Config>("/api/editor/captions/config");
      if (valid(run, key)) { setConsent(false); setConfig(result); }
    } catch (error) {
      if (valid(run, key)) setMessage(error instanceof Error ? error.message : "Caption status is unavailable.");
    }
  }
  useEffect(() => { void loadConfig(); }, [scope]);
  async function recognize() {
    if (disabled || busy || !consent || !config?.can_run || !itemId || !mediaId) return;
    const run = ++epoch.current, key = scope;
    setBusy(true); setProposal(null); setMessage("Reading speech… Your current captions are unchanged.");
    try {
      let result = await api<Job>(`/api/editor/items/${encodeURIComponent(itemId)}/captions`, {
        request_id: Crypto.randomUUID(), consent: true,
        expected_media_id: mediaId, expected_provider: config.provider || "private", language: "auto",
      });
      const deadline = Date.now() + 125000;
      while (["queued", "running"].includes(result.status) && valid(run, key)) {
        if (Date.now() >= deadline) throw new Error("Recognition is taking too long. Your caption track is unchanged; retry later.");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!valid(run, key)) return;
        result = await api<Job>(`/api/editor/caption-jobs/${encodeURIComponent(result.job_id)}`);
      }
      if (!valid(run, key)) return;
      if (result.source_media_id !== mediaId) throw new Error("The source changed. Run Auto captions again for the selected media.");
      if (result.status === "ready") {
        const cues = validateCaptionCues(result.segments);
        if (!cues.length) throw new Error("No speech was recognized. Your caption track is unchanged.");
        setProposal(cues);
        setMessage("Review the words below. Nothing changes until you apply this draft.");
      } else setMessage(result.detail || "Speech recognition is unavailable. Your caption track is unchanged.");
    } catch (error) {
      if (valid(run, key)) setMessage(error instanceof Error ? error.message : "Captions could not be recognized.");
    } finally { if (valid(run, key)) setBusy(false); }
  }
  const rows = proposal || accepted;
  function change(index: number, text: string) {
    if (!rows || busy || disabled) return;
    const next = rows.map((cue, n) => n === index ? { ...cue, text } : cue);
    if (proposal) setProposal(next); else onApply(next);
  }
  function remove(index: number) {
    if (!rows || busy || disabled) return;
    const next = rows.filter((_, n) => n !== index);
    if (proposal) setProposal(next); else onApply(next);
  }
  return <View style={{ gap: 10 }}>
    <View style={styles.between}>
      <View style={styles.row}><Captions size={18} color={color.lime} /><Text style={styles.label}>Caption track</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh auto caption status" disabled={busy || disabled} onPress={() => void loadConfig()} style={{ padding: 8 }}>
        <RefreshCw color={color.muted} size={17} />
      </Pressable>
    </View>
    <Action title={busy ? "Reading speech…" : "Auto captions"} icon={Sparkles}
      disabled={disabled || busy || !consent || !itemId || !mediaId || !config?.can_run}
      onPress={() => void recognize()} />
    {guest ? <Text style={styles.small}>Sign in and save your own video or audio to recognize speech.</Text> : !itemId || !mediaId ? <>
      <Text style={styles.small}>Save your video or audio privately first. Recognition uses its original speech, not your added soundtrack.</Text>
      <Action title="Save privately for captions" disabled={disabled || busy} onPress={onSaveSource} secondary />
    </> : <>
      <Text style={styles.small}>{config?.detail || "Checking speech recognition…"}</Text>
      <Action title="Review media rights & AI permission" secondary disabled={disabled || busy} onPress={onRights} />
      <Pressable accessibilityRole="checkbox" accessibilityLabel={config?.consent_detail || "Allow speech recognition for this selected source."}
        accessibilityState={{ checked: consent, disabled: disabled || busy || !config }} aria-checked={consent}
        disabled={disabled || busy || !config} onPress={() => setConsent((value) => !value)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 6 }}>
        <View style={{ width: 19, height: 19, borderWidth: 1, borderColor: consent ? color.lime : color.muted, borderRadius: 4, alignItems: "center", justifyContent: "center" }}>
          {consent && <Check size={15} color={color.lime} />}
        </View>
        <Text style={[styles.small, { flex: 1 }]}>{config?.consent_detail || "Allow speech recognition for this selected source."}</Text>
      </Pressable>
    </>}
    {!!message && <Notice text={message} />}
    {!!rows && <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: proposal ? color.lime : color.text }]}>{proposal ? "Caption draft · review before applying" : "Accepted caption track"}</Text>
      <Text style={styles.small}>Source timestamps · your cuts and speed changes retime these captions in the final edit.</Text>
      {rows.map((cue, index) => <View key={`${cue.start}:${cue.end}:${index}`} style={{ flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: color.panel, padding: 9, borderRadius: 8, borderWidth: 1, borderColor: color.border }}>
        <View style={{ width: 65 }}><Text style={[styles.small, { fontSize: 10 }]}>{formatTimelineTime(cue.start)}</Text><Text style={[styles.small, { fontSize: 10 }]}>{formatTimelineTime(cue.end)}</Text></View>
        <TextInput accessibilityLabel={`Caption ${index + 1} words`} value={cue.text} onChangeText={(text) => change(index, text)} maxLength={250} editable={!disabled && !busy} multiline
          style={{ flex: 1, color: color.text, fontFamily: font.regular, fontSize: 14, minHeight: 36, padding: 4 }} />
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove caption ${index + 1}`} disabled={disabled || busy} onPress={() => remove(index)} style={{ padding: 7 }}><Trash2 color={color.muted} size={16} /></Pressable>
      </View>)}
      {proposal ? <View style={{ gap: 8 }}>
        <Action title="Apply caption draft" icon={Check} disabled={disabled || busy} onPress={() => {
          try { onApply(validateCaptionCues(proposal)); setProposal(null); setMessage("Caption draft applied to this edit. Save when you are ready."); }
          catch (error) { setMessage(error instanceof Error ? error.message : "Review caption words and timing."); }
        }} />
        <Action title="Discard caption draft" secondary disabled={disabled || busy} onPress={() => { setProposal(null); setMessage("Caption draft discarded. Your existing track is unchanged."); }} />
      </View> : <Action title="Remove auto caption track" secondary disabled={disabled || busy} onPress={() => onApply(null)} />}
    </View>}
    <Text style={[styles.small, { fontSize: 11 }]}>Machine recognition can make mistakes. Review names, words and timing. No captions are published automatically.</Text>
  </View>;
}
