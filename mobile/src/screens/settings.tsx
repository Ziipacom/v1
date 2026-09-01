import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, Switch, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LogOut, ShieldCheck, Trash2 } from "lucide-react-native";
import { Action, Field, Notice } from "../components/ui";
import { useZiipa } from "../provider";
import { color, styles } from "../theme";
import { apiOrigin, legalUrls, supportEmail } from "../lib/config";
import type { Item, RootStack } from "../lib/types";

export function SettingsScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Settings">) {
  const { session, data, preferences, refresh, logout, forgetSession, api } =
    useZiipa();
  const [words, setWords] = useState(data.preferences.muted_words.join(", "));
  const [showDemos, setShowDemos] = useState(data.preferences.show_demos);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveSafety() {
    const muted_words = words
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    if (muted_words.length > 50 || muted_words.some((w) => w.length > 140))
      throw new Error(
        "Use up to 50 words or phrases, each under 140 characters.",
      );
    await preferences({ muted_words, show_demos: showDemos });
    await refresh();
    setMessage("Your safety preferences are saved.");
  }
  function deleteAccount() {
    Alert.alert(
      "Permanently delete your account?",
      "This deletes your Ziipa account and server data, including wallet links and metadata history. Public IPFS copies, blockchain transactions, and assets in your external wallet cannot be deleted by Ziipa. This cannot be undone.",
      [
        { text: "Keep account", style: "cancel" },
        {
          text: "Delete permanently",
          style: "destructive",
          onPress: () => {
            void run(async () => {
              const result = await api<{ pending_media_cleanup: boolean }>(
                "/api/account/delete",
                { password, confirmation },
              );
              await forgetSession();
              Alert.alert(
                "Account deleted",
                result.pending_media_cleanup
                  ? "Your account is removed. Some stored files are queued for cleanup."
                  : "Your account and uploaded files have been removed.",
              );
            });
          },
        },
      ],
    );
  }
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Make it{"\n"}your space.</Text>
      <View style={styles.panel}>
        <Text style={styles.heading}>{session?.user.name}</Text>
        <Text style={styles.body}>{session?.user.email}</Text>
        <Text style={styles.small}>
          The same account is used in the web portal and mobile app.
        </Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.heading}>Your boundaries</Text>
        <Field
          label="Muted words and phrases"
          value={words}
          onChangeText={setWords}
          multiline
          maxLength={5000}
          placeholder="Separate entries with commas"
          editable={!busy}
        />
        <Text style={styles.small}>
          Matching posts and comments are hidden from your experience. This does
          not replace platform moderation.
        </Text>
        <View style={styles.between}>
          <Text style={styles.body}>Show sample collections</Text>
          <Switch
            accessibilityLabel="Show sample collections"
            value={showDemos}
            onValueChange={setShowDemos}
            trackColor={{ true: color.purple }}
            disabled={busy}
          />
        </View>
        <Action
          title="Save preferences"
          icon={ShieldCheck}
          onPress={() => void run(saveSafety)}
          busy={busy}
        />
        {data.preferences.blocked_user_ids.length > 0 && (
          <Text style={styles.heading}>Blocked creators</Text>
        )}
        {data.preferences.blocked_user_ids.map((id) => (
          <Action
            key={id}
            secondary
            title={`Unblock creator #${id}`}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await api("/api/safety/block", { user_id: id, blocked: false });
                await refresh();
              })
            }
          />
        ))}
        {data.preferences.blocked_creators.map((name) => (
          <Action
            key={name}
            secondary
            title={`Unhide ${name}`}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await preferences({
                  blocked_creators: data.preferences.blocked_creators.filter(
                    (n) => n !== name,
                  ),
                });
                await refresh();
              })
            }
          />
        ))}
      </View>
      {!!error && <Notice error text={error} />}
      {!!message && <Notice text={message} />}
      <View style={styles.panel}>
        <Text style={styles.heading}>Good to know</Text>
        {(["privacy", "terms", "community"] as const).map((kind) => (
          <Action
            key={kind}
            secondary
            title={
              kind === "privacy"
                ? "Privacy information"
                : kind === "terms"
                  ? "Terms of use"
                  : "Community rules"
            }
            onPress={() => navigation.navigate("Legal", { kind })}
          />
        ))}
        <Action
          secondary
          title="Contact Ziipa"
          onPress={() =>
            void Linking.openURL(`mailto:${supportEmail}`).catch(() =>
              setError(`Email ${supportEmail} for help.`),
            )
          }
        />
        {session?.user.is_moderator && (
          <Action
            secondary
            title="Moderation inbox"
            onPress={() => navigation.navigate("Moderation")}
          />
        )}
      </View>
      <Action
        title="Sign out"
        secondary
        icon={LogOut}
        onPress={() => void run(logout)}
        busy={busy}
      />
      <View style={styles.separator} />
      <Text style={styles.heading}>Account deletion</Text>
      <Text style={styles.body}>
        Permanently remove your account and its content from this server.
        Confirm with your password before anything is deleted.
      </Text>
      {!deleting ? (
        <Action
          secondary
          title="Delete my account…"
          icon={Trash2}
          disabled={busy}
          onPress={() => setDeleting(true)}
        />
      ) : (
        <>
          <Field
            label="Current password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            maxLength={128}
            autoCapitalize="none"
            editable={!busy}
          />
          <Field
            label="Type DELETE to confirm"
            value={confirmation}
            onChangeText={setConfirmation}
            autoCapitalize="characters"
            maxLength={6}
            editable={!busy}
          />
          <Action
            danger
            title="Permanently delete account"
            icon={Trash2}
            onPress={deleteAccount}
            busy={busy}
            disabled={confirmation !== "DELETE" || !password}
          />
          <Action
            secondary
            title="Cancel deletion"
            onPress={() => {
              setDeleting(false);
              setPassword("");
              setConfirmation("");
            }}
            disabled={busy}
          />
        </>
      )}
      {__DEV__ && (
        <Notice
          text={`Development server: ${apiOrigin}\nWalletConnect pairs with an external wallet. Test networks only; no private keys or seed phrases are collected by Ziipa.`}
        />
      )}
    </ScrollView>
  );
}

const policies = {
  privacy: {
    title: "Your privacy",
    sections: [
      [
        "What this build stores",
        "Ziipa stores your name, email, password hash, uploaded media, posts, comments, feed rules, likes, bookmarks, safety preferences, and reports on the configured Ziipa server. Passwords are never saved as plain text.",
      ],
      [
        "On your device",
        "Your session is kept in iOS Keychain or Android encrypted storage. Selected files may be temporarily copied into the app cache for upload. Private media is requested with your session; it is not intentionally cached for offline playback.",
      ],
      [
        "Your choices",
        "Camera access is optional and requested only when you take a photo. File selection uses the operating system picker. WalletConnect uses a third-party relay when you connect. Ziipa stores linked public wallet addresses, chain IDs, metadata and transaction history; it never collects seed phrases or private keys. No contacts, precise location or advertising access is requested.",
      ],
      [
        "Deletion and support",
        `Delete your account in Settings with your password. This removes server account data, wallet links and the metadata index, and queues failed private-media cleanup for retry. Public IPFS copies, blockchain records and assets held in your external wallet remain. Contact ${supportEmail} with privacy questions. Production retention and operator details require review before release.`,
      ],
    ],
  },
  terms: {
    title: "A space we share",
    sections: [
      [
        "Your account",
        "This first release is intended for adults aged 18 and older. Use accurate account information, keep your password private, and do not impersonate others. You are responsible for activity on your account.",
      ],
      [
        "Your creations",
        "Upload only work you own or have permission to share. You retain your rights. By publishing, you permit Ziipa to store and display that content to members as needed to operate the service. Do not share someone else’s private information.",
      ],
      [
        "Respect the community",
        "Follow the community rules. Ziipa may remove violating content. Blocking and reporting are available on posts and comments. Contact support if you believe a removal is mistaken.",
      ],
      [
        "Preview limitations",
        "Wallet connections, metadata storage, collectible minting, fixed-supply creator tokens, transfers and tips operate on configured test networks only. Assets have no promised value. IPFS and on-chain records may be permanent; Ziipa does not hold private keys. Broadcasting, federation, subscriptions and checkout are not implemented. Full commercial terms require owner and legal review before public distribution.",
      ],
    ],
  },
  community: {
    title: "Keep it creative.\nKeep it kind.",
    sections: [
      [
        "Respect people",
        "No harassment, threats, hate speech, impersonation, doxxing, scams, or spam. Disagree with ideas without targeting people.",
      ],
      [
        "Protect the community",
        "No sexual exploitation, child abuse material, non-consensual intimate content, instructions encouraging dangerous harm, or promotion of illegal activity. This release does not allow sexually explicit content.",
      ],
      [
        "Respect ownership",
        "Share only content you own or are licensed to use. Credit inspiration. Remix attribution does not grant copyright permission.",
      ],
      [
        "Speak up",
        `Use Report on a post or comment and choose the reason. Block a creator to hide their content. Contact ${supportEmail} for appeals or safety concerns. A staffed moderation process is required before this development service is opened to the public.`,
      ],
    ],
  },
};
export function LegalScreen({
  route,
}: NativeStackScreenProps<RootStack, "Legal">) {
  const { kind } = route.params;
  const policy = policies[kind];
  const [error, setError] = useState("");
  const url = legalUrls[kind];
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={styles.page}
    >
      <Text style={styles.eyebrow}>ZIIPA · TRUST & COMMUNITY</Text>
      <Text style={styles.title}>{policy.title}</Text>
      {url ? (
        <Action
          title="Read the published policy"
          secondary
          onPress={() =>
            void Linking.openURL(url).catch(() =>
              setError("Could not open the policy. Please try again."),
            )
          }
        />
      ) : (
        <Notice text="Development policy draft · not the final published policy. Operator details, retention terms, and public policy URLs must be reviewed before store release." />
      )}
      {!!error && <Notice error text={error} />}
      {policy.sections.map(([title, body]) => (
        <View key={title} style={{ gap: 12 }}>
          <Text style={styles.heading}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
type Report = {
  id: string;
  item_id: string;
  comment_id: string | null;
  reason: string;
  details: string;
  created_at: string;
  item: Item | null;
  comment_body: string | null;
};
export function ModerationScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Moderation">) {
  const { api } = useZiipa();
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setReports(await api<Report[]>("/api/moderation/reports"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function resolve(id: string, action: "remove" | "dismiss") {
    Alert.alert(
      action === "remove"
        ? "Remove the reported content?"
        : "Dismiss this report?",
      "This action will be recorded on the server.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () => {
            setBusy(true);
            void api(`/api/moderation/reports/${id}`, { action })
              .then(load)
              .catch((e) => {
                setError(e.message);
                setBusy(false);
              });
          },
        },
      ],
    );
  }
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={styles.page}
    >
      <Text style={styles.title}>Moderation inbox</Text>
      <Notice text="Only allowlisted moderators can access this queue. Review the context before removing content. Reports are not proof of a violation." />
      <Action
        secondary
        title="Refresh reports"
        onPress={() => void load()}
        busy={busy}
      />
      {!!error && <Notice error text={error} />}
      {reports.length === 0 && (
        <Text style={styles.body}>No open reports.</Text>
      )}
      {reports.map((r) => (
        <View key={r.id} style={styles.panel}>
          <Text style={styles.heading}>{r.reason.replace("_", " ")}</Text>
          <Text style={styles.small}>
            Post: {r.item_id}
            {r.comment_id ? `\nComment: ${r.comment_id}` : ""}
          </Text>
          <Text style={styles.body}>
            {r.details || "No additional details provided."}
          </Text>
          {!!r.comment_body && (
            <Notice text={`Reported comment: ${r.comment_body}`} />
          )}
          {r.item && (
            <Action
              secondary
              title={`Review: ${r.item.title}`}
              onPress={() => navigation.navigate("Post", { item: r.item! })}
            />
          )}
          <Action
            danger
            title="Remove reported content"
            disabled={busy}
            onPress={() => resolve(r.id, "remove")}
          />
          <Action
            secondary
            title="Dismiss report"
            disabled={busy}
            onPress={() => resolve(r.id, "dismiss")}
          />
        </View>
      ))}
    </ScrollView>
  );
}
