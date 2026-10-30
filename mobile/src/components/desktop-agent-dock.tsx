import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Mic, Sparkles, X } from "lucide-react-native";
import { createAutomationChatController } from "../lib/automation-chat";
import { useAutomationDictation } from "../lib/automation-dictation";
import type { AssistantReply } from "../lib/media-os-types";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";

/** Mounted by the desktop shell, keyed to the signed-in session. */
export function DesktopAgentDock({
  routeKey,
  openWorkspace,
}: {
  routeKey: string;
  openWorkspace: () => void;
}) {
  const { session, api } = useZiipa();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [reply, setReply] = useState<AssistantReply | null>(null);
  const current = useRef(true);
  const controller = useRef(createAutomationChatController()).current;
  const dictation = useAutomationDictation({
    owner: session?.access_token,
    enabled: !!session && !sending,
    value: draft,
    onChange: setDraft,
    maxLength: 3000,
  });
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
      controller.cancel();
    };
  }, [controller]);
  useEffect(() => {
    dictation.cancel();
  }, [routeKey, dictation.cancel]);

  const send = () => {
    if (sending || dictation.listening || dictation.pending) return;
    dictation.cancel();
    if (!draft.trim()) {
      setExpanded(true);
      return;
    }
    const submitted = draft;
    void controller.send({
      draft: submitted,
      owner: session?.access_token,
      projectId: null,
      isCurrent: () => current.current,
      open: () => {
        setExpanded(true);
        setReply(null);
      },
      busy: setSending,
      error: setError,
      post: async (body) => {
        const result = await api<AssistantReply>(
          "/api/os/assistant/messages",
          body,
        );
        if (current.current) setReply(result);
        return result;
      },
      accepted: () => setDraft((value) => (value === submitted ? "" : value)),
      // This endpoint already returns the persisted reply. Media OS loads the
      // shared conversation and proposals when the user opens its review screen.
      refresh: async () => {},
    });
  };
  const blocked = !session || sending;
  const speechMessage = dictation.listening
    ? "Listening… tap the microphone to finish. Review the text before sending."
    : dictation.error;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        bottom: 18,
        left: 24,
        right: 24,
        alignItems: "center",
        zIndex: 30,
      }}
    >
      <View
        pointerEvents="box-none"
        style={{ width: "100%", maxWidth: 760, gap: 10 }}
      >
        {expanded && (
          <View
            testID="desktop-agent-reply"
            style={{
              borderWidth: 1,
              borderColor: color.border,
              borderRadius: 18,
              backgroundColor: color.panel,
              padding: 16,
              gap: 12,
              boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 9 }}
            >
              <Sparkles size={18} color={color.lime} />
              <Text
                style={{
                  flex: 1,
                  color: color.text,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                Ziipa AI
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close Ziipa AI reply"
                onPress={() => setExpanded(false)}
                style={{ padding: 8 }}
              >
                <X size={18} color={color.muted} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 220 }}>
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.body, { fontSize: 14, color: color.text }]}
              >
                {sending
                  ? "Ziipa is preparing a reply…"
                  : error ||
                    reply?.message?.body ||
                    "Ask Ziipa to plan your next creation or organize your workspace. Review proposed changes in Media OS before they run."}
              </Text>
              {!!reply?.proposal && (
                <Text style={[styles.small, { marginTop: 10 }]}>
                  {reply.proposal.title} · Review required
                </Text>
              )}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Ziipa AI conversation in Media OS"
              onPress={() => {
                dictation.cancel();
                setExpanded(false);
                openWorkspace();
              }}
              style={{ alignSelf: "flex-start", paddingVertical: 8 }}
            >
              <Text
                style={{
                  color: color.lime,
                  fontFamily: font.medium,
                  fontSize: 13,
                }}
              >
                {reply?.proposal
                  ? "Review in Media OS"
                  : "Open conversation in Media OS"}
              </Text>
            </Pressable>
          </View>
        )}
        {!!speechMessage && (
          <Text
            accessibilityLiveRegion="polite"
            style={[
              styles.small,
              {
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: color.panel,
                borderRadius: 12,
              },
            ]}
          >
            {speechMessage}
          </Text>
        )}
        <View
          testID="desktop-agent-composer"
          style={{
            minHeight: 56,
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            padding: 5,
            borderWidth: 1,
            borderColor: color.border,
            borderRadius: 32,
            backgroundColor: color.panel,
            boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              draft.trim() ? "Send to Ziipa AI" : "Open Ziipa AI chat"
            }
            accessibilityState={{
              disabled: blocked || dictation.listening || dictation.pending,
              busy: sending,
            }}
            disabled={blocked || dictation.listening || dictation.pending}
            onPress={send}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 24,
              backgroundColor: color.purple,
              opacity: blocked || pressed ? 0.6 : 1,
            })}
          >
            {sending ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Sparkles size={21} color="white" />
            )}
          </Pressable>
          <TextInput
            accessibilityLabel="Ask Ziipa to Automate"
            placeholder="Ask Ziipa to Automate..."
            placeholderTextColor={color.faint}
            value={draft}
            editable={!blocked}
            onChangeText={(text) => {
              dictation.cancel();
              setDraft(text);
            }}
            maxLength={3000}
            returnKeyType="send"
            onSubmitEditing={() => {
              if (dictation.listening) dictation.stop();
              else send();
            }}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              color: color.text,
              fontFamily: font.regular,
              fontSize: 14,
              paddingVertical: 10,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              dictation.listening ? "Stop voice input" : "Use voice to type"
            }
            accessibilityHint="Use your device's speech service, then review the text before sending."
            accessibilityState={{
              disabled: blocked || dictation.pending,
              busy: dictation.pending,
              selected: dictation.listening,
            }}
            disabled={blocked || dictation.pending}
            onPress={() => {
              if (dictation.listening) dictation.stop();
              else void dictation.start();
            }}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: blocked || pressed ? 0.6 : 1,
            })}
          >
            {dictation.pending ? (
              <ActivityIndicator size="small" color={color.muted} />
            ) : (
              <Mic
                size={21}
                color={dictation.listening ? color.lime : color.text}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
