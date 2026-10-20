import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react-native";
import { Action, Field, Notice, Pill } from "../components/ui";
import { ApiError } from "../lib/api";
import {
  adminMutation,
  adminPagePath,
  adminRoot,
  canAdmin,
  isAdminIdentity,
  type AdminAudit,
  type AdminComment,
  type AdminContent,
  type AdminIdentity,
  type AdminOverview,
  type AdminPage,
  type AdminReport,
  type AdminSettings,
  type AdminUser,
  type ReportStatus,
} from "../lib/admin-api";
import type { RootStack } from "../lib/types";
import { useOperationScope } from "../lib/use-operation-scope";
import { useZiipa } from "../provider";
import { themedStyles, themeValue, color, font, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Administration">;
type Tab = "overview" | "users" | "content" | "reports" | "settings" | "audit";
const tabs: { id: Tab; title: string; permission: string }[] = [
  { id: "overview", title: "Overview", permission: "overview.read" },
  { id: "users", title: "Users", permission: "users.read" },
  { id: "content", title: "Content", permission: "content.read" },
  { id: "reports", title: "Reports", permission: "reports.read" },
  { id: "settings", title: "App settings", permission: "settings.read" },
  { id: "audit", title: "Activity", permission: "audit.read" },
];
type Change = {
  title: string;
  description: string;
  path: string;
  method: "PATCH" | "PUT";
  body: Record<string, unknown> & { expected_version: number };
  danger?: boolean;
};
const reportStatuses: ReportStatus[] = [
  "open",
  "reviewing",
  "resolved",
  "dismissed",
];
function date(value: string) {
  const stamp = new Date(value);
  return Number.isFinite(stamp.getTime())
    ? stamp.toLocaleString()
    : "Date unavailable";
}
function Badge({
  text,
  protectedOwner = false,
}: {
  text: string;
  protectedOwner?: boolean;
}) {
  return (
    <View style={[a.badge, protectedOwner && a.ownerBadge]}>
      {protectedOwner && <ShieldCheck size={13} color={color.lime} />}
      <Text style={[a.badgeText, protectedOwner && { color: color.lime }]}>
        {text}
      </Text>
    </View>
  );
}
function Consent({
  checked,
  disabled,
  onPress,
}: {
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel="I have reviewed this change and its effect on Ziipa"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, { alignItems: "flex-start", paddingVertical: 9 }]}
    >
      <View style={[a.check, checked && { backgroundColor: color.purple }]}>
        {checked && <Check size={18} color="white" />}
      </View>
      <Text style={[styles.small, { flex: 1 }]}>
        I have reviewed this change and its effect on Ziipa.
      </Text>
    </Pressable>
  );
}

export function AdministrationScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedAdministration
      key={session?.access_token || "signed-out"}
      {...props}
    />
  );
}

function ScopedAdministration({ navigation }: Props) {
  const { session, guest, api } = useZiipa();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>("overview");
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminPage<AdminUser> | null>(null);
  const [content, setContent] = useState<AdminPage<AdminContent> | null>(null);
  const [reports, setReports] = useState<AdminPage<AdminReport> | null>(null);
  const [audit, setAudit] = useState<AdminPage<AdminAudit> | null>(null);
  const [comments, setComments] = useState<AdminPage<AdminComment> | null>(
    null,
  );
  const [commentContext, setCommentContext] = useState<{
    kind: "item_id" | "comment_id";
    id: string;
  } | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [banner, setBanner] = useState("");
  const [maintenance, setMaintenance] = useState(false);
  const [signupPaused, setSignupPaused] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [reportFilter, setReportFilter] = useState("open");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<Change | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const sequence = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const mutation = useRef(false);
  const commentSequence = useRef(0);
  const capture = useOperationScope(
    `${session?.access_token || "guest"}:${tab}:${page}:${query}:${reportFilter}`,
    focused,
  );

  const clearPrivateData = useCallback(() => {
    setUsers(null);
    setContent(null);
    setReports(null);
    setAudit(null);
    setComments(null);
    setCommentContext(null);
    setSettings(null);
    setOverview(null);
    setPending(null);
    setReason("");
    setConfirmed(false);
  }, []);
  const load = useCallback(
    async (preserveError = false) => {
      if (!session || guest || mutation.current) return;
      const current = ++sequence.current;
      const valid = capture();
      const active = () => valid() && current === sequence.current;
      setLoading(true);
      setBusy(false);
      if (!preserveError) setError("");
      try {
        const access = await api<AdminIdentity>(`${adminRoot}/me`);
        if (!active()) return;
        if (!isAdminIdentity(access)) {
          clearPrivateData();
          setIdentity(null);
          throw new Error(
            "Administrative access could not be verified. Refresh before continuing.",
          );
        }
        setIdentity(access);
        if (access.role === "member") {
          clearPrivateData();
          return;
        }
        const allowed = tabs.filter((item) =>
          canAdmin(access, item.permission),
        );
        const target =
          allowed.find((item) => item.id === tab)?.id || allowed[0]?.id;
        if (!target) {
          clearPrivateData();
          return;
        }
        if (target !== tab) {
          setTab(target);
          return;
        }
        if (tab === "overview") {
          const value = await api<AdminOverview>(`${adminRoot}/overview`);
          if (active()) setOverview(value);
        } else if (tab === "settings") {
          const value = await api<AdminSettings>(`${adminRoot}/settings`);
          if (active()) {
            setSettings(value);
            setBanner(value.banner);
            setMaintenance(value.maintenance_mode);
            setSignupPaused(value.signup_paused);
          }
        } else {
          const path = adminPagePath(
            tab,
            page,
            tab === "reports" ? reportFilter : query,
          );
          if (tab === "users") {
            const value = await api<AdminPage<AdminUser>>(path);
            if (active()) setUsers(value);
          }
          if (tab === "content") {
            const value = await api<AdminPage<AdminContent>>(path);
            if (active()) setContent(value);
          }
          if (tab === "reports") {
            const value = await api<AdminPage<AdminReport>>(path);
            if (active()) setReports(value);
          }
          if (tab === "audit") {
            const value = await api<AdminPage<AdminAudit>>(path);
            if (active()) setAudit(value);
          }
        }
      } catch (e) {
        if (!active()) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clearPrivateData();
          setIdentity(null);
        }
        setError(
          e instanceof Error ? e.message : "The dashboard could not be loaded.",
        );
      } finally {
        if (active()) setLoading(false);
      }
    },
    [
      session,
      guest,
      api,
      capture,
      tab,
      page,
      query,
      reportFilter,
      clearPrivateData,
    ],
  );
  useEffect(() => {
    if (focused) void load();
  }, [focused, load]);
  useEffect(() => {
    commentSequence.current++;
    setComments(null);
    setCommentContext(null);
    setCommentsLoading(false);
  }, [focused, tab, page, query, reportFilter]);

  async function viewComments(
    context: { kind: "item_id" | "comment_id"; id: string },
    commentPage = 1,
  ) {
    if (
      busy ||
      loading ||
      mutation.current ||
      !canAdmin(identity, "content.read")
    )
      return;
    const current = ++commentSequence.current;
    const valid = capture();
    setComments(null);
    setCommentContext(context);
    setCommentsLoading(true);
    setPending(null);
    setError("");
    try {
      const result = await api<AdminPage<AdminComment>>(
        `${adminRoot}/comments?${context.kind}=${encodeURIComponent(context.id)}&page=${commentPage}&page_size=25`,
      );
      if (valid() && current === commentSequence.current) setComments(result);
    } catch (e) {
      if (!valid() || current !== commentSequence.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearPrivateData();
        setIdentity(null);
      }
      setError(
        e instanceof Error ? e.message : "Comments could not be loaded.",
      );
    } finally {
      if (valid() && current === commentSequence.current)
        setCommentsLoading(false);
    }
  }

  function chooseTab(value: Tab) {
    if (busy || loading) return;
    setPending(null);
    setReason("");
    setConfirmed(false);
    setMessage("");
    setSearch("");
    setQuery("");
    setPage(1);
    setTab(value);
  }
  function stage(value: Change) {
    if (busy || loading) return;
    setPending(value);
    setReason("");
    setConfirmed(false);
    setError("");
    setMessage("");
  }
  async function confirmChange() {
    if (
      !pending ||
      !session ||
      !confirmed ||
      mutation.current ||
      reason.trim().length < 5
    )
      return;
    const valid = capture();
    const change = pending;
    mutation.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // The server rechecks the current role and record version for this mutation.
      const result = await adminMutation<{
        session_revocation_pending?: boolean;
      }>(change.path, session.access_token, change.method, {
        ...change.body,
        reason: reason.trim(),
      });
      if (!valid()) return;
      setPending(null);
      setReason("");
      setConfirmed(false);
      setMessage(
        result.session_revocation_pending
          ? "Account suspended in Ziipa. Existing access is blocked, but session cleanup is pending. Reactivation requires session cleanup to complete. Review activity before another action."
          : "Change saved. The administrative audit history records who changed it and why.",
      );
      setComments(null);
      setCommentContext(null);
    } catch (e) {
      if (!valid()) return;
      setPending(null);
      setReason("");
      setConfirmed(false);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearPrivateData();
        setIdentity(null);
      }
      setError(
        e instanceof Error
          ? e.message
          : "The change could not be confirmed. Refresh before trying again.",
      );
    } finally {
      mutation.current = false;
      if (valid()) {
        setBusy(false);
        void load(true);
      }
    }
  }
  const staff = !!identity && identity.role !== "member";
  const list =
    tab === "users"
      ? users
      : tab === "content"
        ? content
        : tab === "reports"
          ? reports
          : tab === "audit"
            ? audit
            : null;
  const disabled = busy || loading;

  if (!session || guest)
    return (
      <View style={[styles.screen, styles.page]}>
        <Notice
          error
          text="Sign in to your Ziipa account to check administrative access."
        />
        <Action
          title="Back to your account"
          onPress={() =>
            navigation.canGoBack()
              ? navigation.goBack()
              : navigation.navigate("Studio")
          }
        />
      </View>
    );

  return (
    <ScrollView
      ref={scroll}
      style={styles.screen}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}
    >
      <View style={[a.page, { paddingHorizontal: width > 780 ? 32 : 20 }]}>
        <View
          style={[
            styles.between,
            { alignItems: "flex-start", flexWrap: "wrap" },
          ]}
        >
          <View style={{ gap: 9, flex: 1, minWidth: 220 }}>
            <Text style={styles.eyebrow}>ZIIPA CONTROL ROOM</Text>
            <Text style={styles.title}>
              A healthy space.{"\n"}A trusted team.
            </Text>
            <Text style={styles.body}>
              Manage the community with clear permissions and a record of every
              change.
            </Text>
          </View>
          {staff && (
            <Badge
              text={
                identity.role === "owner" ? "Protected owner" : identity.role
              }
              protectedOwner={identity.role === "owner"}
            />
          )}
        </View>
        <Action
          title={loading ? "Checking access…" : "Refresh dashboard"}
          secondary
          icon={RefreshCw}
          busy={loading}
          disabled={busy}
          onPress={() => {
            setPending(null);
            void load();
          }}
        />
        {!!error && <Notice error text={error} />}
        {!!message && <Notice text={message} />}
        <Action
          title="Return to Studio"
          secondary
          disabled={busy}
          onPress={() => navigation.navigate("Studio")}
        />
        {!loading && !staff && (
          <View style={styles.panel}>
            <ShieldCheck color={color.lime} size={28} />
            <Text style={styles.heading}>Administration is restricted</Text>
            <Text style={styles.body}>
              This account does not currently have owner, administrator or
              moderator access. Signing up never grants administrative
              privileges.
            </Text>
            <Action
              title="Return to account settings"
              secondary
              onPress={() => navigation.navigate("Settings")}
            />
          </View>
        )}
        {staff && (
          <>
            <View style={a.tabs} accessibilityRole="tablist">
              {tabs
                .filter((item) => canAdmin(identity, item.permission))
                .map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: tab === item.id, disabled }}
                    disabled={disabled}
                    onPress={() => chooseTab(item.id)}
                    style={[a.tab, tab === item.id && a.activeTab]}
                  >
                    <Text
                      style={[
                        a.tabText,
                        tab === item.id && { color: color.text },
                      ]}
                    >
                      {item.title}
                    </Text>
                  </Pressable>
                ))}
            </View>
            {loading ? (
              <View style={a.loading}>
                <ActivityIndicator color={color.lime} />
                <Text style={styles.small}>
                  Loading current server records…
                </Text>
              </View>
            ) : (
              <>
                {tab === "overview" && overview && (
                  <>
                    <View style={a.metrics}>
                      {(
                        [
                          ["Members", overview.users],
                          ["Active accounts", overview.active_users],
                          ["Suspended accounts", overview.suspended_users],
                          ["Published creations", overview.published_content],
                          ["Hidden creations", overview.hidden_content],
                          ["Open reports", overview.open_reports],
                        ] as [string, number | null][]
                      )
                        .filter(([, value]) => value !== null)
                        .map(([label, value]) => (
                          <View key={label} style={a.metric}>
                            <Text style={a.metricValue}>
                              {value?.toLocaleString()}
                            </Text>
                            <Text style={styles.small}>{label}</Text>
                          </View>
                        ))}
                    </View>
                    <View style={styles.panel}>
                      <Text style={styles.heading}>
                        Permissions stay deliberate
                      </Text>
                      <Text style={styles.body}>
                        Only the owner can assign team roles. Administrators
                        manage ordinary accounts, content and safe app settings.
                        Moderators review content and reports.
                      </Text>
                      <Text style={styles.small}>
                        The owner cannot be suspended, demoted or transferred
                        through this dashboard. No passwords, provider keys,
                        wallet credentials or session tokens are displayed.
                      </Text>
                    </View>
                  </>
                )}

                {(tab === "users" || tab === "content") && (
                  <View style={styles.panel}>
                    <Field
                      label={
                        tab === "users" ? "Find a member" : "Find a creation"
                      }
                      value={search}
                      onChangeText={setSearch}
                      placeholder={
                        tab === "users" ? "Name or email" : "Creation title"
                      }
                      maxLength={80}
                      editable={!disabled}
                      returnKeyType="search"
                      onSubmitEditing={() => {
                        setPage(1);
                        setQuery(search.trim());
                      }}
                    />
                    <Action
                      title="Search"
                      secondary
                      disabled={disabled}
                      onPress={() => {
                        setPage(1);
                        setQuery(search.trim());
                      }}
                    />
                  </View>
                )}

                {tab === "users" && users && (
                  <View style={{ gap: 14 }}>
                    <Text style={styles.small}>
                      {users.total.toLocaleString()} matching accounts · page{" "}
                      {users.page}
                    </Text>
                    {users.items.length === 0 && (
                      <Notice text="No matching accounts. Try a different search." />
                    )}
                    {users.items.map((user) => (
                      <View key={user.id} style={styles.panel}>
                        <View
                          style={[
                            styles.between,
                            { alignItems: "flex-start", flexWrap: "wrap" },
                          ]}
                        >
                          <View style={{ flex: 1, minWidth: 180 }}>
                            <Text style={styles.heading}>{user.name}</Text>
                            <Text selectable style={styles.body}>
                              {user.email}
                            </Text>
                          </View>
                          <Badge
                            text={
                              user.role === "owner"
                                ? "Protected owner"
                                : user.role
                            }
                            protectedOwner={user.role === "owner"}
                          />
                        </View>
                        <Text style={styles.small}>
                          Account #{user.id} · {user.status} · joined{" "}
                          {date(user.created_at)}
                        </Text>
                        {user.role === "owner" ? (
                          <Notice text="Owner access is protected. This dashboard cannot suspend, demote or transfer this account." />
                        ) : (
                          <>
                            {canAdmin(identity, "users.suspend") &&
                              user.role === "member" && (
                                <Action
                                  title={
                                    user.status === "active"
                                      ? "Suspend account…"
                                      : "Reactivate account…"
                                  }
                                  secondary
                                  disabled={disabled}
                                  onPress={() =>
                                    stage({
                                      title:
                                        user.status === "active"
                                          ? "Suspend this account"
                                          : "Reactivate this account",
                                      description: `${user.name} (#${user.id}). ${user.status === "active" ? "Their authenticated access will be blocked until the account is reactivated." : "The member will be able to sign in and use Ziipa again."}`,
                                      path: `${adminRoot}/users/${user.id}/status`,
                                      method: "PATCH",
                                      danger: user.status === "active",
                                      body: {
                                        expected_version: user.version,
                                        status:
                                          user.status === "active"
                                            ? "suspended"
                                            : "active",
                                      },
                                    })
                                  }
                                />
                              )}
                            {canAdmin(identity, "roles.write") && (
                              <View style={{ gap: 9 }}>
                                <Text style={styles.label}>Team access</Text>
                                <View style={a.pills}>
                                  {(
                                    ["member", "moderator", "admin"] as const
                                  ).map((role) => (
                                    <Pill
                                      key={role}
                                      title={
                                        role === "member"
                                          ? "Member"
                                          : role === "moderator"
                                            ? "Moderator"
                                            : "Administrator"
                                      }
                                      active={user.role === role}
                                      onPress={() => {
                                        if (user.role !== role)
                                          stage({
                                            title: `Change role to ${role}`,
                                            description: `${user.name} (#${user.id}). ${role === "admin" ? "Administrators can manage ordinary accounts and app settings." : role === "moderator" ? "Moderators can review community content and reports." : "This removes administrative and moderation access."}`,
                                            path: `${adminRoot}/users/${user.id}/role`,
                                            method: "PATCH",
                                            body: {
                                              expected_version: user.version,
                                              role,
                                            },
                                          });
                                      }}
                                    />
                                  ))}
                                </View>
                              </View>
                            )}
                          </>
                        )}
                      </View>
                    ))}
                  </View>
                )}

                {tab === "content" && content && (
                  <View style={{ gap: 14 }}>
                    <Text style={styles.small}>
                      {content.total.toLocaleString()} matching creations ·
                      metadata only, no private media access
                    </Text>
                    {content.items.length === 0 && (
                      <Notice text="No matching creations." />
                    )}
                    {content.items.map((item) => (
                      <View key={item.id} style={styles.panel}>
                        <Text style={styles.heading}>
                          {item.title || "Untitled creation"}
                        </Text>
                        <View style={a.pills}>
                          <Badge
                            text={
                              item.hidden
                                ? "Hidden by moderation"
                                : item.visibility
                            }
                          />
                          <Badge text={item.category} />
                        </View>
                        <Text style={styles.small}>
                          By {item.owner_name} · account #{item.owner_id} ·{" "}
                          {date(item.created_at)}
                        </Text>
                        <Text selectable style={styles.small}>
                          Creation {item.id}
                        </Text>
                        <Action
                          title="Review public comments"
                          secondary
                          disabled={disabled || commentsLoading}
                          onPress={() =>
                            void viewComments({ kind: "item_id", id: item.id })
                          }
                        />
                        {canAdmin(identity, "content.moderate") && (
                          <Action
                            title={
                              item.hidden
                                ? "Restore creation…"
                                : "Hide creation…"
                            }
                            secondary
                            disabled={disabled}
                            onPress={() =>
                              stage({
                                title: item.hidden
                                  ? "Restore this creation"
                                  : "Hide this creation",
                                description: `${item.title || item.id}. ${item.hidden ? "Remove the moderation restriction. The creator’s own publication/privacy settings still apply." : "Remove it from public Ziipa discovery without deleting the creator’s asset."}`,
                                path: `${adminRoot}/content/${encodeURIComponent(item.id)}/visibility`,
                                method: "PATCH",
                                danger: !item.hidden,
                                body: {
                                  expected_version: item.version,
                                  hidden: !item.hidden,
                                },
                              })
                            }
                          />
                        )}
                      </View>
                    ))}
                  </View>
                )}

                {tab === "reports" && (
                  <>
                    <View style={a.pills}>
                      {[
                        "open",
                        "reviewing",
                        "resolved",
                        "dismissed",
                        "all",
                      ].map((value) => (
                        <Pill
                          key={value}
                          title={value}
                          active={reportFilter === value}
                          onPress={() => {
                            if (!disabled) {
                              setPending(null);
                              setPage(1);
                              setReportFilter(value);
                            }
                          }}
                        />
                      ))}
                    </View>
                    {reports && (
                      <View style={{ gap: 14 }}>
                        <Text style={styles.small}>
                          {reports.total.toLocaleString()} reports ·{" "}
                          {reportFilter}
                        </Text>
                        {reports.items.length === 0 && (
                          <Notice text="No reports in this view." />
                        )}
                        {reports.items.map((report) => (
                          <View key={report.id} style={styles.panel}>
                            <View
                              style={[styles.between, { flexWrap: "wrap" }]}
                            >
                              <Text style={styles.heading}>
                                {report.reason}
                              </Text>
                              <Badge text={report.status} />
                            </View>
                            {!!report.details && (
                              <Text style={styles.body}>{report.details}</Text>
                            )}
                            <Text selectable style={styles.small}>
                              Report {report.id}
                              {"\n"}
                              {report.comment_id
                                ? `Comment ${report.comment_id}`
                                : report.item_id
                                  ? `Creation ${report.item_id}`
                                  : "Target unavailable"}
                              {"\n"}
                              {date(report.created_at)}
                            </Text>
                            {!!report.comment_id &&
                              canAdmin(identity, "content.read") && (
                                <Action
                                  title="Review reported comment"
                                  secondary
                                  disabled={disabled || commentsLoading}
                                  onPress={() =>
                                    void viewComments({
                                      kind: "comment_id",
                                      id: report.comment_id!,
                                    })
                                  }
                                />
                              )}
                            {canAdmin(identity, "reports.triage") && (
                              <View style={a.pills}>
                                {reportStatuses
                                  .filter((status) => status !== report.status)
                                  .map((status) => (
                                    <Pill
                                      key={status}
                                      title={`Mark ${status}…`}
                                      onPress={() =>
                                        stage({
                                          title: `Mark report ${status}`,
                                          description: `Report ${report.id}. This updates the review status only; it does not delete content or contact the reporter.`,
                                          path: `${adminRoot}/reports/${encodeURIComponent(report.id)}`,
                                          method: "PATCH",
                                          body: {
                                            expected_version: report.version,
                                            status,
                                          },
                                        })
                                      }
                                    />
                                  ))}
                              </View>
                            )}
                          </View>
                        ))}
                      </View>
                    )}
                  </>
                )}

                {tab === "settings" && settings && (
                  <View style={styles.panel}>
                    <Text style={styles.heading}>App controls</Text>
                    <Text style={styles.body}>
                      These settings are shared by the website and mobile API.
                      Infrastructure, billing and provider secrets stay outside
                      this dashboard.
                    </Text>
                    <View style={styles.between}>
                      <View style={{ flex: 1 }}>
                        <Text style={a.settingTitle}>Maintenance mode</Text>
                        <Text style={styles.small}>
                          Temporarily restrict ordinary app activity.
                          Owner/admin access remains available.
                        </Text>
                      </View>
                      <Switch
                        accessibilityLabel="Maintenance mode"
                        value={maintenance}
                        onValueChange={setMaintenance}
                        disabled={
                          disabled || !canAdmin(identity, "settings.write")
                        }
                        trackColor={{ true: color.purple }}
                      />
                    </View>
                    <View style={styles.between}>
                      <View style={{ flex: 1 }}>
                        <Text style={a.settingTitle}>
                          Pause new registrations
                        </Text>
                        <Text style={styles.small}>
                          Existing members retain their accounts.
                        </Text>
                      </View>
                      <Switch
                        accessibilityLabel="Pause new registrations"
                        value={signupPaused}
                        onValueChange={setSignupPaused}
                        disabled={
                          disabled || !canAdmin(identity, "settings.write")
                        }
                        trackColor={{ true: color.purple }}
                      />
                    </View>
                    <Field
                      label="Member announcement (one line)"
                      value={banner}
                      onChangeText={setBanner}
                      maxLength={500}
                      placeholder="Optional plain-text app announcement"
                      editable={
                        !disabled && canAdmin(identity, "settings.write")
                      }
                    />
                    <Text style={styles.small}>
                      {banner.length}/500 · plain text, one line
                    </Text>
                    {canAdmin(identity, "settings.write") && (
                      <Action
                        title="Review app settings…"
                        disabled={
                          disabled ||
                          (banner === settings.banner &&
                            maintenance === settings.maintenance_mode &&
                            signupPaused === settings.signup_paused)
                        }
                        onPress={() =>
                          stage({
                            title: "Update Ziipa app settings",
                            description: `Maintenance: ${maintenance ? "on" : "off"}. New registrations: ${signupPaused ? "paused" : "open"}. The announcement will ${banner.trim() ? "be visible to members" : "be cleared"}.`,
                            path: `${adminRoot}/settings`,
                            method: "PUT",
                            body: {
                              expected_version: settings.version,
                              maintenance_mode: maintenance,
                              signup_paused: signupPaused,
                              banner: banner.trim(),
                            },
                          })
                        }
                      />
                    )}
                  </View>
                )}

                {tab === "audit" && audit && (
                  <View style={{ gap: 14 }}>
                    <Text style={styles.small}>
                      A server-recorded history of administrative changes.
                      Entries cannot be edited here.
                    </Text>
                    {audit.items.length === 0 && (
                      <Notice text="No administrative changes are recorded yet." />
                    )}
                    {audit.items.map((event) => (
                      <View key={event.id} style={styles.panel}>
                        <Text style={a.settingTitle}>{event.action}</Text>
                        <Text style={styles.small}>
                          By account #{event.actor_id} ·{" "}
                          {date(event.created_at)}
                        </Text>
                        <Text selectable style={styles.small}>
                          {event.target_type} · {event.target_id}
                        </Text>
                        <Text style={styles.body}>{event.reason}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {list && (
                  <View style={[styles.between, { flexWrap: "wrap" }]}>
                    <Action
                      title="Previous"
                      secondary
                      icon={ChevronLeft}
                      disabled={disabled || page <= 1}
                      onPress={() => {
                        setPending(null);
                        setPage((value) => value - 1);
                      }}
                    />
                    <Text style={styles.small}>
                      Page {list.page} of{" "}
                      {Math.max(1, Math.ceil(list.total / list.page_size))}
                    </Text>
                    <Action
                      title="Next"
                      secondary
                      icon={ChevronRight}
                      disabled={disabled || page * list.page_size >= list.total}
                      onPress={() => {
                        setPending(null);
                        setPage((value) => value + 1);
                      }}
                    />
                  </View>
                )}
              </>
            )}
            {commentContext && (
              <View
                style={styles.panel}
                onLayout={(event) =>
                  scroll.current?.scrollTo({
                    y: event.nativeEvent.layout.y,
                    animated: true,
                  })
                }
              >
                <Text style={styles.eyebrow}>SCOPED COMMENT REVIEW</Text>
                <Text style={styles.heading}>Public conversation</Text>
                <Text style={styles.small}>
                  Only comments attached to published or moderated public
                  creations are available here. Draft conversations stay
                  private.
                </Text>
                {commentsLoading && <ActivityIndicator color={color.lime} />}
                {comments && comments.items.length === 0 && (
                  <Notice text="No reviewable comments match this selection." />
                )}
                {comments?.items.map((comment) => (
                  <View
                    key={comment.id}
                    style={[styles.panel, { backgroundColor: color.bg }]}
                  >
                    <Badge
                      text={
                        comment.hidden
                          ? "Hidden by moderation"
                          : "Visible comment"
                      }
                    />
                    <Text style={styles.body}>{comment.body}</Text>
                    <Text selectable style={styles.small}>
                      Comment {comment.id}
                      {"\n"}By account #{comment.owner_id} ·{" "}
                      {date(comment.created_at)}
                    </Text>
                    {canAdmin(identity, "content.moderate") && (
                      <Action
                        title={
                          comment.hidden ? "Restore comment…" : "Hide comment…"
                        }
                        secondary
                        disabled={disabled}
                        onPress={() =>
                          stage({
                            title: comment.hidden
                              ? "Restore this comment"
                              : "Hide this comment",
                            description: `Comment ${comment.id}. ${comment.hidden ? "Remove the moderation restriction, subject to the creation’s own visibility." : "Hide this comment from public Ziipa views without deleting it."}`,
                            path: `${adminRoot}/comments/${encodeURIComponent(comment.id)}/visibility`,
                            method: "PATCH",
                            danger: !comment.hidden,
                            body: {
                              expected_version: comment.version,
                              hidden: !comment.hidden,
                            },
                          })
                        }
                      />
                    )}
                  </View>
                ))}
                {comments && comments.total > comments.page_size && (
                  <View style={[styles.between, { flexWrap: "wrap" }]}>
                    <Action
                      title="Previous comments"
                      secondary
                      disabled={
                        disabled || commentsLoading || comments.page <= 1
                      }
                      onPress={() =>
                        void viewComments(commentContext, comments.page - 1)
                      }
                    />
                    <Text style={styles.small}>Page {comments.page}</Text>
                    <Action
                      title="Next comments"
                      secondary
                      disabled={
                        disabled ||
                        commentsLoading ||
                        comments.page * comments.page_size >= comments.total
                      }
                      onPress={() =>
                        void viewComments(commentContext, comments.page + 1)
                      }
                    />
                  </View>
                )}
                <Action
                  title="Close comment review"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    commentSequence.current++;
                    setComments(null);
                    setCommentContext(null);
                    setCommentsLoading(false);
                  }}
                />
              </View>
            )}
            {pending && (
              <View
                style={[styles.panel, a.confirmPanel]}
                onLayout={(event) =>
                  scroll.current?.scrollTo({
                    y: event.nativeEvent.layout.y,
                    animated: true,
                  })
                }
              >
                <Text style={styles.eyebrow}>REVIEW BEFORE APPLYING</Text>
                <Text style={styles.heading}>{pending.title}</Text>
                <Text style={styles.body}>{pending.description}</Text>
                <Field
                  label="Reason for this change"
                  value={reason}
                  onChangeText={setReason}
                  maxLength={500}
                  placeholder="Explain the decision for the administrative audit history"
                  editable={!busy}
                />
                <Text style={styles.small}>
                  5–500 characters on one line. Never include passwords, API
                  keys or private financial information.
                </Text>
                <Consent
                  checked={confirmed}
                  disabled={busy}
                  onPress={() => setConfirmed((value) => !value)}
                />
                <Action
                  title="Confirm and apply change"
                  icon={ShieldCheck}
                  danger={pending.danger}
                  busy={busy}
                  disabled={!confirmed || reason.trim().length < 5}
                  onPress={() => void confirmChange()}
                />
                <Action
                  title="Cancel change"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setPending(null);
                    setReason("");
                    setConfirmed(false);
                  }}
                />
              </View>
            )}
            <Text style={styles.small}>
              Administrative access is verified by the API on every request.
              Hidden content and suspended accounts remain recoverable; this
              dashboard never permanently deletes user data.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const a = themedStyles(() => StyleSheet.create({
  page: { width: "100%", maxWidth: 1100, paddingTop: 28, gap: 22 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tab: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 14,
    paddingHorizontal: 17,
    paddingVertical: 13,
    minHeight: 46,
    justifyContent: "center",
  },
  activeTab: { backgroundColor: color.purple, borderColor: color.purple },
  tabText: { fontFamily: font.medium, color: color.muted, fontSize: 15 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 30,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: "flex-start",
  },
  ownerBadge: { borderColor: themeValue("#576D25", color.border), backgroundColor: themeValue("#202A16", color.panel) },
  badgeText: {
    color: color.muted,
    fontFamily: font.medium,
    fontSize: 12,
    textTransform: "capitalize",
  },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 13 },
  metric: {
    backgroundColor: color.panel,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
    gap: 8,
    minWidth: 145,
    flexGrow: 1,
    flexBasis: "28%",
  },
  metricValue: { fontFamily: font.bold, fontSize: 36, color: color.lime },
  loading: { paddingVertical: 32, gap: 15, alignItems: "center" },
  settingTitle: { fontFamily: font.semibold, color: color.text, fontSize: 18 },
  confirmPanel: { borderColor: color.lime, borderWidth: 1 },
  check: {
    width: 25,
    height: 25,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: color.lime,
    alignItems: "center",
    justifyContent: "center",
  },
}));
