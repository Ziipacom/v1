import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bookmark,
  Flag,
  Heart,
  Scissors,
  Share2,
  ShieldOff,
  X,
} from "lucide-react-native";
import { Action, Field, IconButton, Notice, Pill } from "../components/ui";
import { MediaPlayer } from "../components/player";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";
import type { Comment, RootStack } from "../lib/types";

const reasons = [
  { id: "harassment", title: "Harassment" },
  { id: "sexual_content", title: "Sexual content" },
  { id: "violence", title: "Violence" },
  { id: "hate", title: "Hate" },
  { id: "spam", title: "Spam" },
  { id: "copyright", title: "Copyright" },
  { id: "child_safety", title: "Child safety" },
  { id: "other", title: "Other" },
];
export function PostScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Post">) {
  const { item: routed } = route.params;
  const { data, session, guest, api, toggle, refresh } = useZiipa();
  const item =
    data.drafts.find((i) => i.id === routed.id) ||
    data.items.find((i) => i.id === routed.id) ||
    routed;
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reporting, setReporting] = useState(false);
  const [commentId, setCommentId] = useState<string | undefined>();
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");
  useEffect(() => {
    let live = true;
    if (session)
      api<Comment[]>(`/api/creator/items/${item.id}/comments`)
        .then((c) => {
          if (live) setComments(c);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [item.id, session, api]);
  function requireAccount(action: () => void) {
    if (guest) navigation.navigate("Login");
    else action();
  }
  async function change(key: "liked" | "saved") {
    setBusy(true);
    setError("");
    try {
      await toggle(key, item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function comment() {
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api<Comment>(
        `/api/creator/items/${item.id}/comments`,
        { body: body.trim() },
      );
      setComments((c) => [saved, ...c]);
      setBody("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submitReport() {
    setBusy(true);
    setError("");
    try {
      await api("/api/safety/reports", {
        item_id: item.id,
        comment_id: commentId,
        reason,
        details,
      });
      setReporting(false);
      setDetails("");
      Alert.alert(
        "Report received",
        "Your report is saved for the Ziipa moderation team. If someone is in immediate danger, contact local emergency services.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function block(userId: number, name: string) {
    Alert.alert(
      `Block ${name}?`,
      "Their posts, media, and comments will be hidden from your experience.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            void api("/api/safety/block", { user_id: userId, blocked: true })
              .then(async () => {
                await refresh();
                navigation.goBack();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  }
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.page}
      >
        <MediaPlayer item={item} />
        <View style={{ gap: 11 }}>
          <Text style={styles.eyebrow}>
            {item.demo
              ? item.label.toUpperCase()
              : item.visibility === "draft"
                ? "PRIVATE DRAFT"
                : "CREATOR POST"}
          </Text>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.body}>
            By {item.creator}
            {item.city ? ` · ${item.city}` : ""}
          </Text>
          <Text style={styles.body}>{item.description}</Text>
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {item.tags.map((t) => (
              <Text
                key={t}
                style={{ color: "#B995FB", fontFamily: font.medium }}
              >
                #{t}
              </Text>
            ))}
          </View>
          {item.price_cents !== null && item.price_cents !== undefined && (
            <Text style={styles.heading}>
              ${(item.price_cents / 100).toFixed(2)}{" "}
              <Text style={styles.small}>USD · listing only, no checkout</Text>
            </Text>
          )}
        </View>
        <View style={styles.between}>
          <View style={styles.row}>
            <IconButton
              label={
                data.preferences.liked.includes(item.id) ? "Unlike" : "Like"
              }
              icon={Heart}
              active={data.preferences.liked.includes(item.id)}
              disabled={busy}
              onPress={() => requireAccount(() => void change("liked"))}
            />
            <IconButton
              label={
                data.preferences.saved.includes(item.id) ? "Unsave" : "Save"
              }
              icon={Bookmark}
              active={data.preferences.saved.includes(item.id)}
              disabled={busy}
              onPress={() => requireAccount(() => void change("saved"))}
            />
            <IconButton
              label="Share title"
              icon={Share2}
              onPress={() => {
                void Share.share({
                  message: `${item.title} — ${item.creator} on Ziipa. https://ziipa.com`,
                }).catch((e) => setError(e.message));
              }}
            />
          </View>
          <IconButton
            label="Report post"
            icon={Flag}
            onPress={() =>
              requireAccount(() => {
                setCommentId(undefined);
                setReporting(true);
              })
            }
          />
        </View>
        {item.creator_id && item.creator_id !== session?.user.id && (
          <Action
            secondary
            title={`Block ${item.creator}`}
            icon={ShieldOff}
            onPress={() =>
              requireAccount(() => block(item.creator_id!, item.creator))
            }
            disabled={busy}
          />
        )}
        <Action
          secondary
          title="Remix this idea"
          icon={Scissors}
          onPress={() =>
            requireAccount(() =>
              navigation.navigate("Composer", { remix: item }),
            )
          }
        />
        <Text style={styles.small}>
          A remix starts your own draft with attribution. Only upload media you
          have permission to use.
        </Text>
        {!!error && <Notice error text={error} />}
        <View style={styles.separator} />
        <Text style={styles.heading}>The conversation</Text>
        {guest ? (
          <Action
            secondary
            title="Sign in to join in"
            onPress={() => navigation.navigate("Login")}
          />
        ) : (
          <>
            <Field
              label="Add a comment"
              value={body}
              onChangeText={setBody}
              maxLength={1000}
              multiline
              editable={!busy}
              placeholder="Keep it thoughtful. Keep it kind."
            />
            <Action
              title="Post comment"
              onPress={() => void comment()}
              busy={busy}
              disabled={!body.trim()}
            />
          </>
        )}
        {comments.length === 0 && (
          <Text style={styles.small}>No comments yet.</Text>
        )}
        {comments.map((c) => (
          <View key={c.id} style={styles.panel}>
            <View style={styles.between}>
              <Text style={{ fontFamily: font.semibold, color: color.text }}>
                {c.creator}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Report comment by ${c.creator}`}
                onPress={() => {
                  setCommentId(c.id);
                  setReporting(true);
                }}
                style={{ padding: 10 }}
              >
                <Flag size={16} color={color.faint} />
              </Pressable>
            </View>
            <Text style={styles.body}>{c.body}</Text>
            {c.creator_id !== session?.user.id && (
              <Pressable
                accessibilityRole="button"
                onPress={() => block(c.creator_id, c.creator)}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={styles.small}>Block creator</Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>
      <Modal
        visible={reporting}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!busy) setReporting(false);
        }}
      >
        <SafeAreaView style={styles.screen}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.page}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.between}>
              <Text style={styles.heading}>
                {commentId ? "Report comment" : "Report this post"}
              </Text>
              <IconButton
                icon={X}
                label="Close report"
                disabled={busy}
                onPress={() => setReporting(false)}
              />
            </View>
            <Text style={styles.body}>
              Tell us what needs attention. Reports are shared only with the
              moderation team.
            </Text>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {reasons.map((r) => (
                <Pill
                  title={r.title}
                  key={r.id}
                  active={reason === r.id}
                  onPress={() => setReason(r.id)}
                />
              ))}
            </View>
            <Field
              label="More context (optional)"
              value={details}
              onChangeText={setDetails}
              multiline
              maxLength={2000}
              editable={!busy}
            />
            {!!error && <Notice error text={error} />}
            <Action
              title="Send report"
              onPress={() => void submitReport()}
              busy={busy}
            />
            <Notice text="In development, reports stay in this installation’s database. A configured moderator must review them; no external team is notified automatically." />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </KeyboardAvoidingView>
  );
}
