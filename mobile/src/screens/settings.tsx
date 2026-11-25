import { InfoTip } from "../components/info-tip";
import { HelpLabel } from "../components/help-label";
import { Sheet } from "../components/floating";
import { useDesktopLayout } from "../components/desktop-layout";
import { workspace } from "../components/desktop-workspace";
import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Share,
  Switch,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Link2,
  LogOut,
  Mail,
  Monitor,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react-native";
import { Action, Field, IconButton, Notice, Pill } from "../components/ui";
import { SettingsControls } from "../components/settings-controls";
import { AdPrivacyOptions } from "../components/sponsored-ad";
import { PublicGallerySettingsPanel } from "../components/public-gallery-settings";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";
import {
  androidPlayInternal,
  iosExternalTestflight,
  legalOperatorName,
  legalUrls,
  supportEmail,
} from "../lib/config";
import type { Item, RootStack } from "../lib/types";
import {
  adminRoot,
  isAdminIdentity,
  type AdminIdentity,
} from "../lib/admin-api";

const settingsTabs = [
  { label: "Account", Icon: UserRound },
  { label: "Device", Icon: Monitor },
  { label: "Privacy", Icon: ShieldCheck },
  { label: "Feed", Icon: SlidersHorizontal },
] as const;

function SettingsLink({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        ...styles.row,
        minHeight: 45,
        paddingVertical: 7,
        borderBottomWidth: 1,
        borderBottomColor: color.border,
        opacity: pressed || disabled ? 0.6 : 1,
      })}
    >
      <Icon size={17} color={color.muted} />
      <Text style={[styles.label, { flex: 1, marginBottom: 0 }]}>{label}</Text>
      <ChevronRight size={15} color={color.muted} />
    </Pressable>
  );
}

export function SettingsScreen(
  props: NativeStackScreenProps<RootStack, "Settings">,
) {
  const { session } = useZiipa();
  return (
    <ScopedSettingsScreen key={session?.access_token || "guest"} {...props} />
  );
}
function ScopedSettingsScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Settings">) {
  const { desktop } = useDesktopLayout();
  const { session, data, preferences, refresh, logout, forgetSession, api } =
    useZiipa();
  const [words, setWords] = useState(data.preferences.muted_words.join(", "));
  const [showDemos, setShowDemos] = useState(data.preferences.show_demos);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] =
    useState<(typeof settingsTabs)[number]["label"]>("Account");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [administration, setAdministration] = useState<AdminIdentity | null>(
    null,
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setAdministration(null);
      if (session)
        void api<AdminIdentity>(`${adminRoot}/me`)
          .then((identity) => {
            if (active)
              setAdministration(isAdminIdentity(identity) ? identity : null);
          })
          // A legacy deployment or an ordinary account must not expose admin entry.
          .catch(() => {
            if (active) setAdministration(null);
          });
      return () => {
        active = false;
      };
    }, [session?.access_token, api]),
  );
  const [privacy, setPrivacy] = useState({
    profile_visibility: "public",
    discoverable: true,
    personalized_feeds: true,
    marketing_emails: false,
  });
  const [privacyReady, setPrivacyReady] = useState(false);
  const [galleryRefreshKey, setGalleryRefreshKey] = useState(0);
  useEffect(() => {
    if (!session) return;
    let active = true;
    setPrivacyReady(false);
    void api<typeof privacy>("/api/account/privacy")
      .then((value) => {
        if (active) {
          setPrivacy(value);
          setPrivacyReady(true);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [session?.access_token, api]);
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
  const safetyPanel = (
    <View style={[styles.panel, desktop && workspace.panel]}>
      <Text style={styles.heading}>Feed preferences</Text>
      <Field
        label="Muted words and phrases"
        help="Hide posts and comments containing these words or phrases."
        value={words}
        onChangeText={setWords}
        multiline
        maxLength={5000}
        placeholder="Separate entries with commas"
        editable={!busy}
      />
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
  );
  const privacyPanel = (
    <View style={[styles.panel, desktop && workspace.panel]}>
      <HelpLabel
        label="Privacy controls"
        style={styles.heading}
        help="Profile visibility, discovery and feed personalization are separate settings. Review your choices and press Save privacy controls to apply them."
      />
      <AdPrivacyOptions />
      <View style={{ gap: 4 }}>
        <HelpLabel
          label="Profile visibility"
          help="Choose who can see your profile."
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["public", "members", "private"] as const).map((value) => (
            <Pill
              key={value}
              title={value[0].toUpperCase() + value.slice(1)}
              active={privacyReady && privacy.profile_visibility === value}
              onPress={() => {
                if (privacyReady && !busy)
                  setPrivacy({ ...privacy, profile_visibility: value });
              }}
            />
          ))}
        </View>
      </View>
      {(
        [
          ["discoverable", "Appear in creator discovery"],
          ["personalized_feeds", "Personalize my feeds"],
          ["marketing_emails", "Product and creator emails"],
        ] as const
      ).map(([key, label]) => (
        <View style={styles.between} key={key}>
          <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
          <InfoTip
            title={label}
            content={
              key === "discoverable"
                ? "Controls whether your profile can appear in creator discovery. It does not publish private drafts."
                : key === "personalized_feeds"
                  ? "Controls whether Ziipa uses your activity to personalize your feeds."
                  : "Controls your preference for product and creator emails. Save your privacy controls to apply the change."
            }
          />
          <Switch
            accessibilityLabel={label}
            value={privacy[key]}
            onValueChange={(value) => setPrivacy({ ...privacy, [key]: value })}
            trackColor={{ true: color.purple }}
            disabled={busy || !privacyReady}
          />
        </View>
      ))}
      <Action
        title="Save privacy controls"
        icon={ShieldCheck}
        busy={busy}
        disabled={!privacyReady}
        onPress={() =>
          void run(async () => {
            setPrivacy(
              await api<typeof privacy>("/api/account/privacy", privacy),
            );
            setGalleryRefreshKey((value) => value + 1);
            setMessage("Your privacy controls are saved.");
          })
        }
      />
      <SettingsLink
        icon={Download}
        label="Export my Ziipa data"
        disabled={busy}
        onPress={() =>
          void run(async () => {
            const exported = await api<Record<string, unknown>>(
              "/api/account/export",
            );
            await Share.share({
              title: "My Ziipa data export",
              message: JSON.stringify(exported, null, 2),
            });
          })
        }
      />
    </View>
  );
  const policyPanel = (
    <View style={[styles.panel, desktop && workspace.panel]}>
      <Text style={styles.heading}>Help & policies</Text>
      {(["privacy", "terms", "community"] as const).map((kind) => (
        <SettingsLink
          key={kind}
          icon={FileText}
          label={
            kind === "privacy"
              ? "Privacy information"
              : kind === "terms"
                ? "Terms of use"
                : "Community rules"
          }
          onPress={() => navigation.navigate("Legal", { kind })}
        />
      ))}
      <SettingsLink
        icon={Mail}
        label="Contact Ziipa"
        onPress={() =>
          void Linking.openURL(`mailto:${supportEmail}`).catch(() =>
            setError(`Email ${supportEmail} for help.`),
          )
        }
      />
    </View>
  );
  const closeDeletion = () => {
    if (busy) return;
    setDeleting(false);
    setPassword("");
    setConfirmation("");
    setError("");
  };
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={
        desktop
          ? [workspace.page, workspace.narrow]
          : [styles.page, { gap: 14 }]
      }
    >
      <View style={styles.between}>
        <Text accessibilityRole="header" style={styles.heading}>
          Settings
        </Text>
        {session && (
          <IconButton
            label="Sign out"
            icon={LogOut}
            disabled={busy}
            onPress={() => void run(logout)}
          />
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          gap: 5,
          padding: 4,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.panel,
          borderRadius: 13,
        }}
      >
        {settingsTabs.map(({ label, Icon }) => (
          <Pressable
            key={label}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === label }}
            onPress={() => {
              setTab(label);
              setMessage("");
            }}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 46,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              padding: 3,
              gap: 3,
              backgroundColor: tab === label ? color.purple : "transparent",
            }}
          >
            <Icon
              size={16}
              color={tab === label ? color.onAccent : color.muted}
            />
            <Text
              style={{
                fontFamily: font.semibold,
                fontSize: 12,
                textAlign: "center",
                color: tab === label ? color.onAccent : color.text,
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {!!error && !deleting && <Notice error text={error} />}
      {!!message && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          {message}
        </Text>
      )}
      {tab === "Account" && (
        <>
          {session ? (
            <View
              style={[styles.panel, desktop && workspace.panel, { gap: 4 }]}
            >
              <Text style={styles.heading}>{session.user.name}</Text>
              <Text style={styles.small}>{session.user.email}</Text>
              <SettingsLink
                icon={UserRound}
                label="Creator profile"
                onPress={() =>
                  navigation.navigate("Profile", { creatorId: undefined })
                }
              />
              <SettingsLink
                icon={Link2}
                label="Connected networks"
                onPress={() =>
                  navigation.navigate("Connections", { tab: "accounts" })
                }
              />
              <SettingsLink
                icon={FolderOpen}
                label="Personal library & rights"
                onPress={() =>
                  navigation.navigate("MediaOS", { tab: "Library" })
                }
              />
              {administration &&
                administration.role !== "member" &&
                administration.permissions.length > 0 && (
                  <SettingsLink
                    icon={ShieldCheck}
                    label="Administration"
                    onPress={() => navigation.navigate("Administration")}
                  />
                )}
              <SettingsLink
                icon={Trash2}
                label="Delete account"
                disabled={busy}
                onPress={() => {
                  setError("");
                  setDeleting(true);
                }}
              />
            </View>
          ) : (
            <Action
              title="Sign in to Ziipa"
              onPress={() => navigation.navigate("Login")}
            />
          )}
          {policyPanel}
        </>
      )}
      {tab === "Device" && <SettingsControls navigation={navigation} />}
      {tab === "Privacy" &&
        (session ? (
          <>
            {privacyPanel}
            <PublicGallerySettingsPanel
              disabled={busy}
              refreshKey={galleryRefreshKey}
              onOpenCreations={() =>
                navigation.navigate("CreatorStudio", { tab: "library" })
              }
            />
          </>
        ) : (
          <Action
            title="Sign in to manage privacy"
            onPress={() => navigation.navigate("Login")}
          />
        ))}
      {tab === "Feed" && safetyPanel}
      {session && deleting && (
        <Sheet
          title="Delete account"
          onClose={closeDeletion}
          footer={
            <Action
              danger
              title="Permanently delete account"
              icon={Trash2}
              onPress={deleteAccount}
              busy={busy}
              disabled={confirmation !== "DELETE" || !password}
            />
          }
        >
          <Text style={styles.body}>
            This permanently deletes your Ziipa account and content.
          </Text>
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
          {!!error && <Notice error text={error} />}
        </Sheet>
      )}
    </ScrollView>
  );
}

const policies = {
  privacy: {
    title: "Your privacy",
    sections: [
      [
        "Account and media",
        "Ziipa uses your name, email, password hash and account settings to provide and protect your account. We store the media, edits, posts, comments, feeds, and preferences you save. Connected-network authorizations are encrypted.",
      ],
      [
        "On your device",
        "The app keeps your session in secure device storage. The website uses a session cookie. The app may temporarily store files you select, record, or export. Your private media requires your session to open.",
      ],
      [
        "Your choices",
        "You choose which device permissions to enable. Ziipa asks for confirmation before a public broadcast, and before publishing or relaying to a connected network.",
      ],
      [
        "Deletion and support",
        `Ziipa is operated by ${legalOperatorName}. You can export your account data or delete your account in Settings. When media cleanup fails, Ziipa queues it for retry. Public blockchain records and copies on other services may remain. Contact ${supportEmail} with privacy questions.`,
      ],
    ],
  },
  terms: {
    title: "Terms of use",
    sections: [
      [
        "Your account",
        "You must be at least 18 years old to register in the app. Use accurate account information, keep your password private, and do not impersonate others. You are responsible for activity on your account.",
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
        "Connected services",
        "Connected networks have their own terms and account requirements. Review the destination before sharing media or broadcasting. You can disconnect services in Ziipa.",
      ],
    ],
  },
  community: {
    title: "Community rules",
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
        `Use Report on a post or comment to flag it for review. Block a creator to hide their content. Contact ${supportEmail} for appeals or safety concerns.`,
      ],
    ],
  },
};
export function LegalScreen({
  route,
}: NativeStackScreenProps<RootStack, "Legal">) {
  const { desktop } = useDesktopLayout();
  const { kind } = route.params;
  const policy = policies[kind];
  const [error, setError] = useState("");
  const url = legalUrls[kind];
  const betaPrivacy =
    (iosExternalTestflight || androidPlayInternal) && kind === "privacy";
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={
        desktop ? [workspace.page, workspace.narrow] : styles.page
      }
    >
      <Text style={styles.title}>{policy.title}</Text>
      {url ? (
        <Action
          title={betaPrivacy ? "Open beta privacy notice" : "Read on ziipa.com"}
          secondary
          onPress={() =>
            void Linking.openURL(url).catch(() =>
              setError("Could not open the policy. Please try again."),
            )
          }
        />
      ) : null}
      {!!error && <Notice error text={error} />}
      {betaPrivacy ? (
        <Text
          style={styles.body}
        >{`Read the beta privacy notice for details about account data, selected media, permissions and deletion choices. Ziipa is operated by ${legalOperatorName}. Contact ${supportEmail} with privacy questions.`}</Text>
      ) : (
        policy.sections.map(([title, body]) => (
          <View key={title} style={{ gap: 12 }}>
            <Text style={styles.heading}>{title}</Text>
            <Text style={styles.body}>{body}</Text>
          </View>
        ))
      )}
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
  const { desktop } = useDesktopLayout();
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
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={
        desktop ? [workspace.page, workspace.narrow] : styles.page
      }
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
        <View key={r.id} style={[styles.panel, desktop && workspace.panel]}>
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
