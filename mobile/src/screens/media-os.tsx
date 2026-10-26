import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bell,
  Brain,
  CalendarClock,
  Check,
  Clapperboard,
  FolderOpen,
  Megaphone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "../components/ui";
import { AgentTasks } from "../components/agent-tasks";
import { useDesktopLayout } from "../components/desktop-layout";
import { ApiError } from "../lib/api";
import {
  authorizationHeaders,
  portalMode,
  validateOrigin,
} from "../lib/config";
import { useZiipa } from "../provider";
import { color, styles } from "../theme";
import type { Item, RootStack } from "../lib/types";
import {
  economicTotals,
  emptyAssetMetadata,
  emptyWorkspace,
  goalStepsFromText,
  isoInstant,
  listOf,
  parseMinorAmount,
  readableStatus,
  type Activity,
  type AssistantConfig,
  type AssistantReply,
  type AssetMetadata,
  type Goal,
  type Library,
  type LibraryItem,
  type LibraryMedia,
  type MediaOSTab,
  type Memory,
  type Project,
  type RevenueEntry,
  type Workflow,
  type Workspace,
} from "../lib/media-os-types";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Mutate = (
  path: string,
  method: Method,
  body?: unknown,
) => Promise<boolean>;
type WorkspaceTab = MediaOSTab | "Agent";
const tabs: WorkspaceTab[] = [
  "Overview",
  "Library",
  "Memory",
  "Assistant",
  "Agent",
  "Workflows",
  "Insights",
];
const desktopTitles: Record<WorkspaceTab, { title: string; detail: string }> = {
  Overview: {
    title: "Workspace",
    detail: "Projects, goals and the work ahead.",
  },
  Library: {
    title: "Personal library",
    detail: "Organize owned media, originals and usage rights.",
  },
  Memory: {
    title: "Personal memory",
    detail: "Review exactly what Ziipa remembers for you.",
  },
  Assistant: {
    title: "Assistant",
    detail: "Plan in conversation. Review changes before they run.",
  },
  Agent: {
    title: "Agent workspace",
    detail: "Private tasks, tool permissions and verified receipts.",
  },
  Workflows: {
    title: "Workflow workbench",
    detail: "Configure scheduled work and follow each run.",
  },
  Insights: {
    title: "Insights & economics",
    detail: "Ziipa activity and your recorded creator ledger.",
  },
};

function WorkspaceColumns({
  main,
  aside,
  asideWidth = 330,
}: {
  main: ReactNode;
  aside: ReactNode;
  asideWidth?: number;
}) {
  const { contentWidth } = useDesktopLayout();
  const columns = contentWidth >= 940;
  return (
    <View
      style={{
        flexDirection: columns ? "row" : "column",
        gap: 20,
        alignItems: "stretch",
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 20 }}>{main}</View>
      <View
        style={{ width: columns ? asideWidth : "100%", minWidth: 0, gap: 20 }}
      >
        {aside}
      </View>
    </View>
  );
}

function WorkspaceGrid({
  children,
  minimum = 280,
}: {
  children: ReactNode;
  minimum?: number;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
      {Children.toArray(children).map((child, index) => (
        <View
          key={isValidElement(child) ? child.key || index : index}
          style={{
            flexGrow: 1,
            flexBasis: minimum,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          {child}
        </View>
      ))}
    </View>
  );
}
const toolTitles: Record<string, string> = {
  "project.create": "Create projects",
  "project.update": "Update projects",
  "memory.create": "Remember preferences",
  "memory.update": "Update memories",
  "memory.delete": "Forget memories",
  "goal.create": "Plan goals",
  "goal.update": "Update goals",
  "library.search": "Search my media",
  "workflow.create": "Prepare workflows",
  "render.create": "Render owned media",
  "bluesky.sync": "Sync connected Bluesky",
  "revenue.create": "Record earnings",
  project_create: "Create projects",
  memory_create: "Remember preferences",
  goal_create: "Plan goals",
  workflow_create: "Prepare workflows",
  render: "Render owned media",
  bluesky_sync: "Sync connected Bluesky",
};
function Block({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { desktop } = useDesktopLayout();
  return (
    <View
      style={[
        styles.panel,
        { gap: 14 },
        desktop && { padding: 20, borderRadius: 14, minWidth: 0 },
      ]}
    >
      <Text style={[styles.heading, desktop && { fontSize: 18 }]}>{title}</Text>
      {subtitle ? <Text style={styles.small}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}
function Choices<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((option) => (
        <Pill
          key={option}
          title={readableStatus(option)}
          active={value === option}
          onPress={() => onChange(option)}
        />
      ))}
    </View>
  );
}
function Toggle({
  title,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[
        styles.row,
        { minHeight: 46, paddingVertical: 8, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          borderWidth: 1,
          borderColor: value ? color.lime : color.muted,
          backgroundColor: value ? color.purple : color.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Check size={17} color={color.text} /> : null}
      </View>
      <Text style={[styles.body, { flex: 1, color: color.text }]}>{title}</Text>
    </Pressable>
  );
}
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Field
        label={label}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        placeholder="2026-10-20T18:00:00Z"
      />
      <Text style={styles.small}>
        Use Z for UTC or include your timezone offset, such as -04:00.
      </Text>
    </View>
  );
}
function ProjectPicker({
  projects,
  selected,
  onChange,
}: {
  projects: Project[];
  selected: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>Project</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill
          title="No project"
          active={!selected}
          onPress={() => onChange(null)}
        />
        {projects.map((p) => (
          <Pill
            key={p.id}
            title={p.name}
            active={selected === p.id}
            onPress={() => onChange(p.id)}
          />
        ))}
      </View>
    </View>
  );
}
function Remove({
  title,
  onConfirm,
  busy,
  detail,
}: {
  title: string;
  onConfirm: () => void;
  busy: boolean;
  detail?: string;
}) {
  const [review, setReview] = useState(false);
  return review ? (
    <View style={{ gap: 8 }}>
      <Notice
        text={`${title}? ${detail || "This removes this workspace record."}`}
      />
      <Action
        title={`Confirm ${title.toLowerCase()}`}
        danger
        busy={busy}
        onPress={onConfirm}
      />
      <Action
        title="Keep it"
        secondary
        disabled={busy}
        onPress={() => setReview(false)}
      />
    </View>
  ) : (
    <Action
      title={title}
      secondary
      icon={Trash2}
      disabled={busy}
      onPress={() => setReview(true)}
    />
  );
}

export function MediaOSScreen({
  navigation,
  route,
}: NativeStackScreenProps<RootStack, "MediaOS">) {
  const { session, forgetSession } = useZiipa();
  const { desktop } = useDesktopLayout();
  const [tab, setTab] = useState<WorkspaceTab>(route.params?.tab || "Overview");
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const contentScroll = useRef<ScrollView>(null);
  const mutationLock = useRef(false);
  const owner = useRef(session?.access_token);
  owner.current = session?.access_token;
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const api = useCallback(
    async <T,>(
      path: string,
      method: Method = "GET",
      body?: unknown,
    ): Promise<T> => {
      const token = session?.access_token;
      if (!token || owner.current !== token)
        throw new Error("Sign in to use your personal workspace.");
      if (
        !(path === "/api/os" || path.startsWith("/api/os/")) ||
        path.includes("..")
      )
        throw new Error("Invalid workspace request.");
      const controller = new AbortController();
      requests.current.add(controller);
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(validateOrigin() + path, {
          method,
          headers: {
            ...authorizationHeaders(token),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: portalMode ? "include" : "omit",
          redirect: "error",
          signal: controller.signal,
        });
        const value = await response.json().catch(() => null);
        if (owner.current !== token)
          throw new Error("Your account changed. Reopen the workspace.");
        if (!response.ok) {
          if (response.status === 401) await forgetSession();
          throw new ApiError(
            response.status === 409
              ? "This record changed elsewhere. Refresh, then reopen this record to load its current version before editing again."
              : typeof value?.detail === "string"
                ? value.detail
                : Array.isArray(value?.detail)
                  ? value.detail
                      .map((d: { msg?: string }) => d.msg || "Invalid input")
                      .join("\n")
                  : "The workspace request could not be completed.",
            response.status,
          );
        }
        return value as T;
      } finally {
        clearTimeout(timer);
        requests.current.delete(controller);
      }
    },
    [session?.access_token, forgetSession],
  );
  const load = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;
    const current = ++generation.current;
    setLoading(true);
    setError("");
    const paths: Partial<Record<keyof Workspace, string>> = {
      projects: "/api/os/projects",
      goals: "/api/os/goals",
      library: "/api/os/library",
      ...(tab === "Memory" ? { memories: "/api/os/memories" } : {}),
      ...(tab === "Assistant"
        ? {
            memories: "/api/os/memories",
            messages: "/api/os/assistant/messages",
            actions: "/api/os/assistant/actions",
            permissions: "/api/os/assistant/permissions",
            assistant: "/api/os/assistant/config",
          }
        : {}),
      ...(tab === "Workflows" || tab === "Overview"
        ? {
            workflows: "/api/os/workflows",
            runs: "/api/os/workflows/runs",
            workflowConfig: "/api/os/workflows/config",
          }
        : {}),
      ...(tab === "Insights" || tab === "Overview"
        ? {
            revenue: "/api/os/revenue",
            insights: "/api/os/insights",
            activity: "/api/os/activity",
          }
        : {}),
    };
    const entries = Object.entries(paths) as [keyof Workspace, string][];
    // Bound simultaneous connections for native browsers and the small free API.
    // Stop the remaining batches if the user changes accounts or workspaces.
    const results: PromiseSettledResult<unknown>[] = [];
    for (let offset = 0; offset < entries.length; offset += 3) {
      results.push(
        ...(await Promise.allSettled(
          entries
            .slice(offset, offset + 3)
            .map(([, path]) => api<unknown>(path)),
        )),
      );
      if (owner.current !== token || generation.current !== current) return;
    }
    if (owner.current !== token || generation.current !== current) return;
    const update: Partial<Workspace> = {};
    const failures: string[] = [];
    results.forEach((result, index) => {
      const key = entries[index][0];
      if (result.status === "rejected") {
        const source = entries[index][1]
          .replace("/api/os/", "")
          .split("/")
          .map(readableStatus)
          .join(" · ");
        failures.push(
          result.reason instanceof Error
            ? `${source}: ${result.reason instanceof ApiError ? result.reason.message : "Could not reach this workspace tool. Check the API connection, then refresh."}`
            : `${source}: Could not load this workspace tool.`,
        );
        return;
      }
      const value = result.value;
      if (key === "permissions")
        update.permissions =
          (value as { allowed_tools?: string[] })?.allowed_tools || [];
      else if (key === "library")
        update.library = Array.isArray(value)
          ? { items: value as LibraryItem[] }
          : (value as Library) || { items: [] };
      else if (key === "assistant") update.assistant = value as AssistantConfig;
      else if (key === "insights")
        update.insights = value as Workspace["insights"];
      else if (key === "workflowConfig")
        update.workflowConfig = (value as Record<string, unknown>) || {};
      else (update as Record<string, unknown>)[key] = listOf(value, key);
    });
    setWorkspace((previous) => ({ ...previous, ...update }));
    setError([...new Set(failures)].join("\n"));
    setLoading(false);
  }, [api, session?.access_token, tab]);
  useEffect(() => {
    generation.current++;
    mutationLock.current = false;
    setWorkspace(emptyWorkspace());
    setError("");
    setNotice("");
    setBusy(false);
    return () => {
      generation.current++;
      requests.current.forEach((request) => request.abort());
      requests.current.clear();
    };
  }, [session?.access_token]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.tab]);
  useEffect(() => {
    contentScroll.current?.scrollTo({ y: 0, animated: false });
  }, [tab]);
  const mutate: Mutate = async (path, method, body) => {
    const token = owner.current;
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, method, body);
      if (owner.current !== token) return false;
      setNotice("Saved to your Ziipa workspace.");
      await load();
      return true;
    } catch (e) {
      if (owner.current === token)
        setError(
          e instanceof Error ? e.message : "Could not save. Please try again.",
        );
      return false;
    } finally {
      if (owner.current === token) {
        mutationLock.current = false;
        setBusy(false);
      }
    }
  };
  const openItem = (item: Item) => navigation.navigate("Composer", { item });
  return (
    <View style={styles.screen}>
      {desktop ? (
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 22,
            paddingBottom: 14,
            gap: 7,
          }}
        >
          <View style={styles.between}>
            <Text
              accessibilityRole="header"
              style={[styles.heading, { fontSize: 24 }]}
            >
              {desktopTitles[tab].title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh workspace"
              disabled={busy || loading || !session}
              onPress={() => void load()}
              style={{ padding: 8 }}
            >
              <RefreshCw color={color.lime} size={18} />
            </Pressable>
          </View>
          <Text style={styles.small}>{desktopTitles[tab].detail}</Text>
        </View>
      ) : (
        <View
          style={{
            paddingHorizontal: 20,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderColor: color.border,
            gap: 8,
          }}
        >
          <View style={styles.between}>
            <Text style={styles.eyebrow}>YOUR PERSONAL MEDIA OS</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh workspace"
              disabled={busy || loading || !session}
              onPress={() => void load()}
              style={{ padding: 8 }}
            >
              <RefreshCw color={color.lime} size={20} />
            </Pressable>
          </View>
          <Text style={[styles.heading, { fontSize: 29 }]}>
            Your creative world, connected.
          </Text>
          <Text style={styles.small}>
            Media, memory, plans and a helping hand in one private workspace.
          </Text>
          <View
            accessibilityRole="toolbar"
            accessibilityLabel="Automate tools"
            testID="media-os-automate-actions"
            style={{ flexDirection: "row", gap: 6 }}
          >
            {[
              {
                label: "Campaigns",
                description: "Campaigns · create, review and distribute",
                icon: Megaphone,
                onPress: () => navigation.navigate("Campaigns"),
              },
              {
                label: "Calendar",
                description: "Calendar · schedules and stream preflight",
                icon: CalendarClock,
                onPress: () => navigation.navigate("Calendar"),
              },
              {
                label: "Recordings",
                description: "Recordings · private VODs and clips",
                icon: Clapperboard,
                onPress: () => navigation.navigate("Recordings"),
              },
              ...(session
                ? [
                    {
                      label: "Updates",
                      description: "Private updates · opt-in notifications",
                      icon: Bell,
                      onPress: () => navigation.navigate("Notifications"),
                    },
                  ]
                : []),
            ].map(({ label, description, icon: Icon, onPress }) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={description}
                onPress={onPress}
                style={({ pressed }) => ({
                  flex: 1,
                  minWidth: 0,
                  minHeight: 60,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 5,
                  paddingHorizontal: 3,
                  paddingVertical: 8,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: color.border,
                  backgroundColor: color.panel,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Icon size={20} color={color.text} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.small,
                    {
                      fontSize: 11,
                      lineHeight: 14,
                      textAlign: "center",
                      color: color.text,
                    },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{
          flexGrow: 0,
          flexShrink: 0,
          height: desktop ? 54 : 70,
          minHeight: desktop ? 54 : 70,
        }}
        contentContainerStyle={{
          gap: 8,
          padding: desktop ? 8 : 14,
          paddingHorizontal: desktop ? 24 : 14,
          alignItems: "center",
        }}
      >
        {tabs.map((value) => (
          <Pill
            key={value}
            title={value}
            active={tab === value}
            onPress={() => {
              setNotice("");
              setTab(value);
              if (desktop) navigation.setParams({ tab: value });
            }}
          />
        ))}
      </ScrollView>
      <ScrollView
        ref={contentScroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: desktop ? 24 : 18,
          paddingTop: desktop ? 12 : 0,
          paddingBottom: 45,
          gap: 18,
          width: "100%",
          maxWidth: desktop ? 1440 : 980,
          alignSelf: "center",
        }}
      >
        {!session ? (
          <>
            <Block
              title="Make Ziipa yours"
              subtitle="Your workspace stays empty until you add your own media and memories."
            >
              <Action
                title="Sign in to your workspace"
                onPress={() => navigation.navigate("Login")}
              />
              <Notice text="Build projects, remember your creative preferences, review assistant actions, schedule media work and keep an honest record of your earnings." />
            </Block>
            <Block
              title={
                tab === "Assistant"
                  ? "An assistant that asks before acting"
                  : `${tab} for your creative life`
              }
            >
              <Text style={styles.body}>
                {tab === "Library"
                  ? "Connect original media, drafts, exports and rights to projects. Search the library you own."
                  : tab === "Memory"
                    ? "You decide what Ziipa remembers. Inspect, edit or forget every preference."
                    : tab === "Workflows"
                      ? "Schedule reminders, rendered exports and supported network sync. Follow every run to a verified result."
                      : tab === "Insights"
                        ? "See verified local activity and record income and expenses in their original currencies."
                        : tab === "Assistant"
                          ? "Ask to create a project, remember a style, plan a goal or prepare a workflow. Review the proposed change before it runs."
                          : tab === "Agent"
                            ? "Give Ziipa a private workspace objective, choose the tools it may use and follow each verified step. Sign in to enable autonomous tasks."
                            : "Start with a project and a goal, then bring your media and creative workflow together."}
              </Text>
              <Action
                secondary
                title="Explore Creator Studio"
                onPress={() => navigation.navigate("Studio")}
              />
            </Block>
          </>
        ) : (
          <View key={session.access_token} style={{ gap: 18 }}>
            {loading ? (
              <View style={[styles.row, { padding: 12 }]}>
                <ActivityIndicator color={color.lime} />
                <Text style={styles.small}>Refreshing your workspace…</Text>
              </View>
            ) : null}
            {error ? <Notice error text={error} /> : null}
            {notice ? <Notice text={notice} /> : null}
            {tab === "Overview" ? (
              <Overview
                workspace={workspace}
                busy={busy}
                mutate={mutate}
                go={setTab}
              />
            ) : null}
            {tab === "Library" ? (
              <LibraryPanel
                workspace={workspace}
                busy={busy}
                mutate={mutate}
                openItem={openItem}
                exports={(id) => navigation.navigate("Exports", { itemId: id })}
                publish={(id) =>
                  navigation.navigate("Publishing", { itemId: id })
                }
                create={() => navigation.navigate("Composer")}
                useUpload={(upload) =>
                  navigation.navigate("Composer", {
                    upload,
                    category: upload.content_type.startsWith("audio/")
                      ? "music"
                      : "video",
                  })
                }
              />
            ) : null}
            {tab === "Memory" ? (
              <MemoryPanel
                memories={workspace.memories}
                busy={busy}
                mutate={mutate}
              />
            ) : null}
            {tab === "Assistant" ? (
              <AssistantPanel
                workspace={workspace}
                busy={busy}
                api={api}
                mutate={mutate}
                refresh={load}
                report={setError}
                connected={() => navigation.navigate("Connections")}
                publish={() => navigation.navigate("Publishing")}
                openResult={(result) => {
                  const itemId =
                    typeof result.item_id === "string"
                      ? result.item_id
                      : typeof result.itemId === "string"
                        ? result.itemId
                        : undefined;
                  if (result.screen === "Composer")
                    navigation.navigate("Composer");
                  else if (result.screen === "Exports" && itemId)
                    navigation.navigate("Exports", { itemId });
                  else if (result.screen === "Exports" || result.job_id) {
                    setTab("Library");
                    setNotice(
                      "Choose a creation to review its rendered exports.",
                    );
                  } else if (result.screen === "Networks")
                    navigation.navigate("Connections");
                  else if (result.screen === "Publishing")
                    navigation.navigate("Publishing", { itemId });
                  else if (result.screen === "Wallet")
                    navigation.navigate("Utility", { kind: "wallet" });
                }}
              />
            ) : null}
            {tab === "Workflows" ? (
              <WorkflowsPanel
                workspace={workspace}
                busy={busy}
                mutate={mutate}
                connect={() => navigation.navigate("Connections")}
              />
            ) : null}
            {tab === "Agent" ? (
              <AgentTasks
                api={api}
                projects={workspace.projects}
                permissions={() => setTab("Assistant")}
              />
            ) : null}
            {tab === "Insights" ? (
              <InsightsPanel
                workspace={workspace}
                busy={busy}
                mutate={mutate}
              />
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Overview({
  workspace,
  busy,
  mutate,
  go,
}: {
  workspace: Workspace;
  busy: boolean;
  mutate: Mutate;
  go: (tab: MediaOSTab) => void;
}) {
  const { desktop } = useDesktopLayout();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("active");
  const [goal, setGoal] = useState<Goal | null>(null);
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDescription, setGoalDescription] = useState("");
  const [goalProject, setGoalProject] = useState<string | null>(null);
  const [goalStatus, setGoalStatus] = useState("active");
  const [due, setDue] = useState("");
  const [stepText, setStepText] = useState("");
  const [validation, setValidation] = useState("");
  const editProject = (value: Project | null) => {
    setProject(value);
    setName(value?.name || "");
    setDescription(value?.description || "");
    setStatus(value?.status || "active");
  };
  const editGoal = (value: Goal | null) => {
    setGoal(value);
    setGoalTitle(value?.title || "");
    setGoalDescription(value?.description || "");
    setGoalProject(value?.project_id || null);
    setGoalStatus(value?.status || "active");
    setDue(value?.due_at || "");
    setStepText(value?.steps.map((s) => s.title).join("\n") || "");
  };
  const saveProject = async () => {
    if (!name.trim()) {
      setValidation("Give your project a name.");
      return;
    }
    setValidation("");
    if (
      await mutate(
        project ? `/api/os/projects/${project.id}` : "/api/os/projects",
        project ? "PATCH" : "POST",
        {
          name: name.trim(),
          description,
          status,
          asset_ids: project?.asset_ids || [],
          ...(project ? { revision: project.revision } : {}),
        },
      )
    )
      editProject(null);
  };
  const saveGoal = async () => {
    try {
      if (!goalTitle.trim()) throw new Error("Give your goal a title.");
      const due_at = isoInstant(due);
      const steps = goalStepsFromText(stepText, goal?.steps);
      setValidation("");
      if (
        await mutate(
          goal ? `/api/os/goals/${goal.id}` : "/api/os/goals",
          goal ? "PATCH" : "POST",
          {
            title: goalTitle.trim(),
            description: goalDescription,
            project_id: goalProject,
            due_at,
            status: goalStatus,
            steps,
            ...(goal ? { revision: goal.revision } : {}),
          },
        )
      )
        editGoal(null);
    } catch (e) {
      setValidation((e as Error).message);
    }
  };
  const snapshot = (
    <Block
      title={desktop ? "Workspace snapshot" : "A home for your creative life"}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {[
          ["Projects", workspace.projects.length],
          ["Creations", workspace.library.items?.length || 0],
          ["Goals", workspace.goals.length],
          [
            "Active workflows",
            workspace.workflows.filter((w) => w.enabled).length,
          ],
        ].map(([label, count]) => (
          <View
            key={label}
            style={{
              minWidth: 115,
              padding: 16,
              borderRadius: 17,
              backgroundColor: color.bg,
              flex: 1,
            }}
          >
            <Text style={[styles.heading, { color: color.lime }]}>{count}</Text>
            <Text style={styles.small}>{label}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill title="Organize library" onPress={() => go("Library")} />
        <Pill title="Ask Ziipa" onPress={() => go("Assistant")} />
        <Pill title="Your memory" onPress={() => go("Memory")} />
      </View>
    </Block>
  );
  const validationNotice = validation ? (
    <Notice text={validation} error />
  ) : null;
  const projectEditor = (
    <Block title={project ? `Edit ${project.name}` : "Start a project"}>
      <Field
        label="Project name"
        value={name}
        onChangeText={setName}
        maxLength={120}
      />
      <Field
        label="Description"
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={3000}
      />
      <Choices
        options={["active", "paused", "completed"]}
        value={status}
        onChange={setStatus}
      />
      <Action
        title={project ? "Save project changes" : "Create project"}
        icon={FolderOpen}
        busy={busy}
        onPress={() => void saveProject()}
      />
      {project ? (
        <Action
          secondary
          title="Cancel edit"
          onPress={() => editProject(null)}
        />
      ) : null}
    </Block>
  );
  const projectList = workspace.projects.map((p) => (
    <Block
      key={p.id}
      title={p.name}
      subtitle={`${readableStatus(p.status)} · ${new Set([...(p.asset_ids || []), ...workspace.library.items.filter((item) => item.metadata?.project_id === p.id).map((item) => item.id)]).size} linked assets`}
    >
      <Text style={styles.body}>
        {p.description || "Add a description to shape this project."}
      </Text>
      <Action
        secondary
        title="Edit project"
        disabled={busy}
        onPress={() => editProject(p)}
      />
      <Remove
        title="Delete project"
        busy={busy}
        onConfirm={() =>
          void mutate(
            `/api/os/projects/${p.id}?revision=${p.revision}`,
            "DELETE",
          )
        }
      />
    </Block>
  ));
  const goalEditor = (
    <Block title={goal ? "Edit your goal" : "Set a creative goal"}>
      <Field
        label="Goal title"
        value={goalTitle}
        onChangeText={setGoalTitle}
        maxLength={120}
      />
      <Field
        label="What does success look like?"
        value={goalDescription}
        onChangeText={setGoalDescription}
        multiline
        maxLength={3000}
      />
      <ProjectPicker
        projects={workspace.projects}
        selected={goalProject}
        onChange={setGoalProject}
      />
      <DateField
        label="Due date and time (optional)"
        value={due}
        onChange={setDue}
      />
      <Choices
        options={
          goal ? ["active", "paused", "completed"] : ["active", "paused"]
        }
        value={goalStatus}
        onChange={setGoalStatus}
      />
      <Field
        label="Steps (one per line)"
        value={stepText}
        onChangeText={setStepText}
        multiline
        placeholder="Record the first episode\nEdit three clips\nReview the publishing plan"
      />
      <Action
        title={goal ? "Save goal changes" : "Create goal"}
        icon={Plus}
        busy={busy}
        onPress={() => void saveGoal()}
      />
      {goal ? (
        <Action
          secondary
          title="Cancel goal edit"
          onPress={() => editGoal(null)}
        />
      ) : null}
    </Block>
  );
  const goalList = workspace.goals.map((g) => (
    <Block
      key={g.id}
      title={g.title}
      subtitle={`${readableStatus(g.status)} · ${g.steps.filter((s) => s.completed).length}/${g.steps.length} steps completed${g.due_at ? ` · Due ${new Date(g.due_at).toLocaleString()}` : ""}`}
    >
      <Text style={styles.body}>{g.description}</Text>
      {g.steps.map((step) => (
        <Toggle
          key={step.id}
          title={step.title}
          disabled={busy}
          value={step.completed}
          onChange={(completed) => {
            if (!busy)
              void mutate(`/api/os/goals/${g.id}`, "PATCH", {
                revision: g.revision,
                steps: g.steps.map((s) =>
                  s.id === step.id ? { ...s, completed } : s,
                ),
              });
          }}
        />
      ))}
      <Action
        secondary
        title="Edit goal"
        disabled={busy}
        onPress={() => editGoal(g)}
      />
      <Remove
        title="Delete goal"
        busy={busy}
        onConfirm={() =>
          void mutate(`/api/os/goals/${g.id}?revision=${g.revision}`, "DELETE")
        }
      />
    </Block>
  ));
  return desktop ? (
    <View style={{ gap: 20 }}>
      {snapshot}
      {validationNotice}
      <WorkspaceColumns
        asideWidth={400}
        main={
          <>
            {projectEditor}
            {projectList}
          </>
        }
        aside={
          <>
            {goalEditor}
            {goalList}
          </>
        }
      />
    </View>
  ) : (
    <>
      {snapshot}
      {validationNotice}
      {projectEditor}
      {projectList}
      {goalEditor}
      {goalList}
    </>
  );
}

function LibraryPanel({
  workspace,
  busy,
  mutate,
  openItem,
  exports,
  publish,
  create,
  useUpload,
}: {
  workspace: Workspace;
  busy: boolean;
  mutate: Mutate;
  openItem: (item: Item) => void;
  exports: (id: string) => void;
  publish: (id: string) => void;
  create: () => void;
  useUpload: (upload: LibraryMedia) => void;
}) {
  const { desktop } = useDesktopLayout();
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState(30);
  const [visibleOriginals, setVisibleOriginals] = useState(30);
  useEffect(() => setVisibleItems(30), [query, projectFilter]);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [meta, setMeta] = useState<AssetMetadata>(emptyAssetMetadata);
  const [tags, setTags] = useState("");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState("");
  const choose = (item: LibraryItem) => {
    const metadata =
      item.metadata || item.asset_metadata || emptyAssetMetadata();
    setSelected(item);
    setMeta(metadata);
    setTags(metadata.tags.join(", "));
    setExpiry(metadata.rights.expires_at || "");
    setError("");
  };
  const items = (workspace.library.items || []).filter((item) => {
    const metadata = item.metadata || item.asset_metadata;
    const text = [
      item.title,
      item.description,
      metadata?.notes,
      ...(metadata?.tags || []),
      ...(item.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return (
      (!query || text.includes(query.toLowerCase())) &&
      (!projectFilter ||
        metadata?.project_id === projectFilter ||
        workspace.projects
          .find((p) => p.id === projectFilter)
          ?.asset_ids.includes(item.id))
    );
  });
  const originals = (workspace.library.media || []).filter(
    (media) =>
      !workspace.library.items.some((item) => item.media_id === media.id),
  );
  const save = async () => {
    if (!selected) return;
    try {
      const expires_at = isoInstant(expiry);
      if (
        meta.rights.source_url.trim() &&
        !/^https:\/\//i.test(meta.rights.source_url)
      )
        throw new Error("Source links must begin with https://.");
      if (meta.rights.allow_ai && meta.rights.basis === "unknown")
        throw new Error(
          "Record the rights basis before allowing assistant use.",
        );
      setError("");
      const { basis, license_note, source_url, allow_ai } = meta.rights;
      if (
        await mutate(
          `/api/os/assets/${encodeURIComponent(selected.id)}/metadata`,
          "PUT",
          {
            notes: meta.notes,
            project_id: meta.project_id,
            revision: meta.revision,
            tags: tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
            rights: { basis, license_note, source_url, allow_ai, expires_at },
          },
        )
      )
        setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const libraryToolbar = (
    <Block
      title="Your personal library"
      subtitle="Owned Ziipa media, organized across drafts and published creations. External networks remain in Your networks."
    >
      <Field
        label="Search titles, notes and tags"
        value={query}
        onChangeText={setQuery}
        placeholder="Find an idea or a recording"
      />
      <ProjectPicker
        projects={workspace.projects}
        selected={projectFilter}
        onChange={setProjectFilter}
      />
      <Action title="Create or upload media" icon={Plus} onPress={create} />
      {workspace.library.media?.length ? (
        <Text style={styles.small}>
          {workspace.library.media.length} original uploads connected to this
          library.
        </Text>
      ) : null}
    </Block>
  );
  const originalUploads =
    !query && !projectFilter && originals.length ? (
      <Block
        title="Original uploads"
        subtitle="Your stored files. Give an upload a title by creating a draft, then add notes and rights."
      >
        {originals.slice(0, visibleOriginals).map((media) => (
          <View
            key={media.id}
            style={{
              gap: 8,
              paddingTop: 12,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            <Text style={[styles.body, { color: color.text }]}>
              {media.content_type.startsWith("video/")
                ? "Video upload"
                : media.content_type.startsWith("audio/")
                  ? "Audio upload"
                  : media.content_type.startsWith("image/")
                    ? "Image upload"
                    : "File upload"}{" "}
              · {media.id.slice(0, 8)}
            </Text>
            <Text style={styles.small}>
              {(media.size / 1024 / 1024).toFixed(2)} MB
            </Text>
            <Action
              secondary
              title="Create a draft from this upload"
              onPress={() => useUpload(media)}
            />
          </View>
        ))}
        {originals.length > visibleOriginals ? (
          <Action
            secondary
            title="Show more original uploads"
            onPress={() => setVisibleOriginals((n) => n + 30)}
          />
        ) : null}
      </Block>
    ) : null;
  const metadataEditor = selected ? (
    <Block
      title={`Organize ${selected.title}`}
      subtitle="Rights information is your declaration, not independent verification."
    >
      <Field
        label="Private notes"
        value={meta.notes}
        onChangeText={(notes) => setMeta((v) => ({ ...v, notes }))}
        multiline
      />
      <Field
        label="Tags, separated by commas"
        value={tags}
        onChangeText={setTags}
      />
      <ProjectPicker
        projects={workspace.projects}
        selected={meta.project_id}
        onChange={(project_id) => setMeta((v) => ({ ...v, project_id }))}
      />
      <Text style={styles.label}>Rights basis</Text>
      <Choices
        options={["original", "licensed", "permission", "unknown"] as const}
        value={meta.rights.basis}
        onChange={(basis) =>
          setMeta((v) => ({ ...v, rights: { ...v.rights, basis } }))
        }
      />
      <Field
        label="License or permission notes"
        value={meta.rights.license_note}
        onChangeText={(license_note) =>
          setMeta((v) => ({ ...v, rights: { ...v.rights, license_note } }))
        }
        multiline
      />
      <Field
        label="Original source URL (optional)"
        value={meta.rights.source_url}
        onChangeText={(source_url) =>
          setMeta((v) => ({ ...v, rights: { ...v.rights, source_url } }))
        }
        autoCapitalize="none"
        keyboardType="url"
      />
      <DateField
        label="Rights expiry (optional)"
        value={expiry}
        onChange={setExpiry}
      />
      <Toggle
        title="Allow the assistant to use this media within these rights"
        value={meta.rights.allow_ai}
        disabled={busy}
        onChange={(allow_ai) =>
          setMeta((v) => ({ ...v, rights: { ...v.rights, allow_ai } }))
        }
      />
      {meta.rights.expired ? (
        <Notice
          error
          text="The recorded rights have expired. Update your permission before reusing this asset."
        />
      ) : null}
      {error ? <Notice error text={error} /> : null}
      <Action
        title="Save media details"
        busy={busy}
        onPress={() => void save()}
      />
      <Action
        secondary
        title="Close media details"
        onPress={() => setSelected(null)}
      />
    </Block>
  ) : null;
  const emptyLibrary = !items.length ? (
    <Notice
      text={
        query || projectFilter
          ? "No media matches this search."
          : "Your personal library is empty. Upload or record media to get started."
      }
    />
  ) : null;
  const mediaCards = items.slice(0, visibleItems).map((item) => (
    <Block
      key={item.id}
      title={item.title}
      subtitle={`${readableStatus(item.visibility || "draft")} · ${readableStatus(item.category)}`}
    >
      <Cover item={item} style={{ height: 160, borderRadius: 18 }} />
      <Text style={styles.body}>{item.description}</Text>
      <Text style={styles.small}>
        {(item.metadata?.tags || item.tags || []).join(" · ") || "No tags yet"}{" "}
        · Rights: {item.metadata?.rights?.basis || "unknown"}
      </Text>
      <Action
        secondary
        title="Notes, project and rights"
        icon={ShieldCheck}
        onPress={() => choose(item)}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill title="Edit media" onPress={() => openItem(item)} />
        <Pill title="Rendered exports" onPress={() => exports(item.id)} />
        <Pill title="Review publishing" onPress={() => publish(item.id)} />
      </View>
    </Block>
  ));
  const moreMedia =
    items.length > visibleItems ? (
      <Action
        secondary
        title={`Show more media (${items.length - visibleItems} remaining)`}
        onPress={() => setVisibleItems((n) => n + 30)}
      />
    ) : null;
  return desktop ? (
    <View style={{ gap: 20 }}>
      {libraryToolbar}
      <WorkspaceColumns
        main={
          <>
            {emptyLibrary}
            <WorkspaceGrid minimum={290}>{mediaCards}</WorkspaceGrid>
            {moreMedia}
            {originalUploads}
          </>
        }
        aside={
          selected ? (
            metadataEditor
          ) : (
            <Block
              title="Media organization"
              subtitle="Select Notes, rights & project on a creation to edit its private metadata."
            >
              <Text style={styles.small}>
                Original uploads, editable creations and rendered exports remain
                separate. Only your owned media can be edited.
              </Text>
            </Block>
          )
        }
      />
    </View>
  ) : (
    <>
      {libraryToolbar}
      {originalUploads}
      {metadataEditor}
      {emptyLibrary}
      {mediaCards}
      {moreMedia}
    </>
  );
}

function MemoryPanel({
  memories,
  busy,
  mutate,
}: {
  memories: Memory[];
  busy: boolean;
  mutate: Mutate;
}) {
  const { desktop } = useDesktopLayout();
  const [editing, setEditing] = useState<Memory | null>(null);
  const [kind, setKind] = useState<Memory["kind"]>("preference");
  const [body, setBody] = useState("");
  const [visibleMemories, setVisibleMemories] = useState(30);
  const choose = (memory: Memory | null) => {
    setEditing(memory);
    setKind(memory?.kind || "preference");
    setBody(memory?.body || "");
  };
  const save = async () => {
    if (
      await mutate(
        editing ? `/api/os/memories/${editing.id}` : "/api/os/memories",
        editing ? "PATCH" : "POST",
        {
          kind,
          body: body.trim(),
          ...(editing ? { revision: editing.revision } : { source: "user" }),
        },
      )
    )
      choose(null);
  };
  const memoryEditor = (
    <Block
      title={desktop ? "Save a memory" : "You decide what Ziipa remembers"}
      subtitle="These are facts and preferences you choose to save. Inspect, change or forget them at any time."
    >
      <Choices
        options={["preference", "style", "context"] as const}
        value={kind}
        onChange={setKind}
      />
      <Field
        label={
          editing
            ? "Edit saved memory"
            : "A preference, style or useful context"
        }
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={2000}
        placeholder="I like concise captions and original music."
      />
      <Action
        title={editing ? "Save memory changes" : "Remember this"}
        icon={Brain}
        busy={busy}
        disabled={!body.trim()}
        onPress={() => void save()}
      />
      {editing ? (
        <Action
          secondary
          title="Cancel memory edit"
          onPress={() => choose(null)}
        />
      ) : null}
    </Block>
  );
  const emptyMemory = !memories.length ? (
    <Notice text="No personal memories saved yet. Ziipa will only use the context you provide." />
  ) : null;
  const memoriesList = memories.slice(0, visibleMemories).map((memory) => (
    <Block
      key={memory.id}
      title={readableStatus(memory.kind)}
      subtitle="Saved by you"
    >
      <Text style={styles.body}>{memory.body}</Text>
      <Action
        secondary
        title="Edit memory"
        disabled={busy}
        onPress={() => choose(memory)}
      />
      <Remove
        title="Forget memory"
        busy={busy}
        onConfirm={() =>
          void mutate(
            `/api/os/memories/${memory.id}?revision=${memory.revision}`,
            "DELETE",
          )
        }
      />
    </Block>
  ));
  const moreMemories =
    memories.length > visibleMemories ? (
      <Action
        secondary
        title="Show more memories"
        onPress={() => setVisibleMemories((n) => n + 30)}
      />
    ) : null;
  return desktop ? (
    <WorkspaceColumns
      asideWidth={360}
      main={
        <>
          {emptyMemory}
          <WorkspaceGrid>{memoriesList}</WorkspaceGrid>
          {moreMemories}
        </>
      }
      aside={memoryEditor}
    />
  ) : (
    <>
      {memoryEditor}
      {emptyMemory}
      {memoriesList}
      {moreMemories}
    </>
  );
}

function AssistantPanel({
  workspace,
  busy,
  api,
  mutate,
  refresh,
  report,
  connected,
  publish,
  openResult,
}: {
  workspace: Workspace;
  busy: boolean;
  api: <T>(path: string, method?: Method, body?: unknown) => Promise<T>;
  mutate: Mutate;
  refresh: () => Promise<void>;
  report: (message: string) => void;
  connected: () => void;
  publish: () => void;
  openResult: (result: Record<string, unknown>) => void;
}) {
  const { desktop } = useDesktopLayout();
  const [message, setMessage] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const availableTools =
    workspace.assistant?.tools ||
    workspace.assistant?.skills?.map((id) => ({
      id,
      title: toolTitles[id] || readableStatus(id),
    })) ||
    [];
  const chat = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    report("");
    try {
      await api<AssistantReply>("/api/os/assistant/messages", "POST", {
        message: message.trim(),
        project_id: project,
      });
      setMessage("");
      await refresh();
    } catch (e) {
      report(
        e instanceof Error
          ? e.message
          : "The assistant could not finish this request.",
      );
    } finally {
      setSending(false);
    }
  };
  const permissions = (tool: string) =>
    workspace.permissions.includes(tool)
      ? workspace.permissions.filter((t) => t !== tool)
      : [...workspace.permissions, tool];
  const approve = async (id: string, revision: number) => {
    if (sending || busy) return;
    setSending(true);
    report("");
    try {
      const result = await api<{ result?: Record<string, unknown> }>(
        `/api/os/assistant/actions/${id}/approve`,
        "POST",
        { revision },
      );
      await refresh();
      setReview(null);
      if (result.result) openResult(result.result);
    } catch (e) {
      report(e instanceof Error ? e.message : "The action did not complete.");
    } finally {
      setSending(false);
    }
  };
  const messageComposer = (
    <Block
      title={desktop ? "Message Ziipa" : "Ziipa Assistant"}
      subtitle={
        workspace.assistant?.mode === "local_ai"
          ? "Your local AI helps prepare actions. You approve changes before they run."
          : workspace.assistant?.mode === "hosted_ai"
            ? "A private inference gateway helps prepare actions. You approve changes before they run."
            : "Guided assistant · Prepare supported actions and review every change."
      }
    >
      {!desktop ? (
        <Text style={styles.body}>
          Try “Create a project called Launch”, “Remember that I prefer short
          captions” or “Create a goal called Record my first episode”.
        </Text>
      ) : null}
      {workspace.assistant?.detail ? (
        <Notice text={workspace.assistant.detail} />
      ) : null}
      {workspace.assistant?.inference?.available &&
      workspace.assistant.inference.model ? (
        <Text style={styles.small}>
          Model: {workspace.assistant.inference.model}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {[
          "Create a project called Launch",
          "Remember: I prefer short captions",
          "Create a goal called Record an episode",
          "Show my insights",
          "Open editor",
        ].map((command) => (
          <Pill
            key={command}
            title={command}
            onPress={() => setMessage(command)}
          />
        ))}
      </View>
      <ProjectPicker
        projects={workspace.projects}
        selected={project}
        onChange={setProject}
      />
      <Field
        label="What would you like to do?"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={3000}
        placeholder="Help me organize my next release."
      />
      <Action
        title="Ask Ziipa"
        icon={Sparkles}
        busy={sending}
        disabled={!message.trim() || busy}
        onPress={() => void chat()}
      />
      <Text style={styles.small}>
        An assistant reply is not proof an action completed. Completed actions
        appear in your activity history.
      </Text>
    </Block>
  );
  const permissionPanel = (
    <Block
      title="Assistant permissions"
      subtitle="Choose tools for Assistant chat. Chat changes need review; separately enabled Agent tasks may also use these grants within their saved policy."
    >
      {availableTools.length ? (
        availableTools.map((tool) => (
          <Toggle
            key={tool.id}
            title={tool.title || toolTitles[tool.id] || readableStatus(tool.id)}
            value={workspace.permissions.includes(tool.id)}
            disabled={busy || sending}
            onChange={() => {
              if (!busy && !sending)
                void mutate("/api/os/assistant/permissions", "PUT", {
                  allowed_tools: permissions(tool.id),
                });
            }}
          />
        ))
      ) : (
        <Text style={styles.small}>
          Tool permissions will appear when the assistant configuration loads.
        </Text>
      )}
      <Action secondary title="Manage connected networks" onPress={connected} />
      <Action secondary title="Review a publishing request" onPress={publish} />
    </Block>
  );
  const conversationControls = workspace.messages.length ? (
    <Block title="Conversation controls">
      <Remove
        title="Clear conversation"
        busy={busy || sending}
        onConfirm={() => void mutate("/api/os/assistant/messages", "DELETE")}
      />
    </Block>
  ) : null;
  const conversationMessages = workspace.messages.map((msg) => (
    <View
      key={msg.id}
      style={[
        styles.panel,
        {
          backgroundColor: msg.role === "user" ? color.raised : color.panel,
        },
      ]}
    >
      <Text style={styles.eyebrow}>
        {msg.role === "user" ? "YOU" : "ZIIPA"}
      </Text>
      <Text style={[styles.body, { color: color.text }]}>{msg.body}</Text>
      <Text style={styles.small}>
        {new Date(msg.created_at).toLocaleString()}
      </Text>
    </View>
  ));
  const actionProposals = workspace.actions.map((action) => {
    const pending = ["pending", "proposed", "awaiting_approval"].includes(
      action.status,
    );
    const expired =
      !!action.expires_at && Date.parse(action.expires_at) <= Date.now();
    return (
      <Block
        key={action.id}
        title={action.title}
        subtitle={
          expired && pending
            ? "Proposal expired · Ask again to prepare a fresh action"
            : readableStatus(action.status)
        }
      >
        <Text style={styles.body}>{action.summary}</Text>
        {pending && !expired ? (
          <>
            {review === action.id ? (
              <>
                <Text style={styles.label}>Review the proposed change</Text>
                {Object.entries(action.arguments || {}).map(([key, value]) => (
                  <View key={key} style={{ gap: 3 }}>
                    <Text style={styles.small}>{readableStatus(key)}</Text>
                    <Text style={[styles.body, { color: color.text }]}>
                      {typeof value === "string"
                        ? value
                        : value === null
                          ? "None"
                          : JSON.stringify(value, null, 2)}
                    </Text>
                  </View>
                ))}
                <Notice text="Approving executes only this proposed action. Publishing, messaging and wallet spending use their separate review screens." />
                <Action
                  title="Approve this action"
                  busy={sending || busy}
                  onPress={() => void approve(action.id, action.revision ?? 1)}
                />
              </>
            ) : (
              <Action
                title="Review proposed action"
                icon={ShieldCheck}
                disabled={busy || sending}
                onPress={() => setReview(action.id)}
              />
            )}
            <Action
              secondary
              title="Reject proposal"
              disabled={busy || sending}
              onPress={() =>
                void mutate(
                  `/api/os/assistant/actions/${action.id}/reject`,
                  "POST",
                  { revision: action.revision ?? 1 },
                )
              }
            />
          </>
        ) : null}
      </Block>
    );
  });
  return desktop ? (
    <WorkspaceColumns
      asideWidth={340}
      main={
        <>
          <View style={[styles.panel, { gap: 14, padding: 20 }]}>
            <View style={styles.between}>
              <Text style={[styles.heading, { fontSize: 18 }]}>
                Conversation
              </Text>
              <Text style={styles.small}>
                {workspace.messages.length} messages
              </Text>
            </View>
            {workspace.messages.length ? (
              conversationMessages
            ) : (
              <Text style={styles.small}>
                Start a conversation below. Suggestions prepare a message; they
                do not execute an action.
              </Text>
            )}
          </View>
          {messageComposer}
          {actionProposals}
          {conversationControls}
        </>
      }
      aside={
        <>
          <Block title="Project context">
            <Text style={styles.small}>
              {project
                ? workspace.projects.find((entry) => entry.id === project)
                    ?.name || "Selected project"
                : "Whole workspace"}
            </Text>
            {workspace.projects.slice(0, 5).map((entry) => (
              <View key={entry.id} style={{ gap: 3, paddingVertical: 6 }}>
                <Text style={styles.label}>{entry.name}</Text>
                <Text style={styles.small}>{readableStatus(entry.status)}</Text>
              </View>
            ))}
            {!workspace.projects.length ? (
              <Text style={styles.small}>
                Create a project to give future requests a focused context.
              </Text>
            ) : null}
            <Text style={styles.small}>
              {workspace.actions.length} recorded action proposals ·{" "}
              {
                workspace.actions.filter(
                  (entry) => entry.status === "completed",
                ).length
              }{" "}
              completed
            </Text>
          </Block>
          {permissionPanel}
        </>
      }
    />
  ) : (
    <>
      {messageComposer}
      {permissionPanel}
      {conversationControls}
      {conversationMessages}
      {actionProposals}
    </>
  );
}

const actionNames: Record<Workflow["action"], string> = {
  reminder: "Private reminder",
  render: "Render media",
  bluesky_sync: "Sync connected Bluesky",
};
const triggerNames: Record<Workflow["trigger"], string> = {
  scheduled: "At a scheduled time",
  media_saved: "When media is saved",
  render_ready: "When an export is ready",
};
function WorkflowsPanel({
  workspace,
  busy,
  mutate,
  connect,
}: {
  workspace: Workspace;
  busy: boolean;
  mutate: Mutate;
  connect: () => void;
}) {
  const { desktop } = useDesktopLayout();
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [name, setName] = useState("");
  const [action, setAction] = useState<Workflow["action"]>("reminder");
  const [trigger, setTrigger] = useState<Workflow["trigger"]>("scheduled");
  const [target, setTarget] = useState<string | null>(null);
  const [runAt, setRunAt] = useState("");
  const [interval, setInterval] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [rights, setRights] = useState(false);
  const [validation, setValidation] = useState("");
  const [runReview, setRunReview] = useState<string | null>(null);
  const choose = (workflow: Workflow | null) => {
    setEditing(workflow);
    setName(workflow?.name || "");
    setAction(workflow?.action || "reminder");
    setTrigger(workflow?.trigger || "scheduled");
    setTarget(workflow?.target_id || null);
    setRunAt(workflow?.run_at || "");
    setInterval(workflow?.interval_minutes?.toString() || "");
    setEnabled(workflow?.enabled ?? false);
    setRights(workflow?.rights_confirmed || false);
    setValidation("");
  };
  const save = async () => {
    try {
      if (!name.trim()) throw new Error("Give this workflow a name.");
      const run_at = trigger === "scheduled" ? isoInstant(runAt, true) : null;
      if (run_at && Date.parse(run_at) <= Date.now())
        throw new Error("Choose a future time for this schedule.");
      const interval_minutes = interval.trim() ? Number(interval) : null;
      if (
        interval_minutes !== null &&
        (!/^\d+$/.test(interval) ||
          !Number.isSafeInteger(interval_minutes) ||
          interval_minutes < 15 ||
          interval_minutes > 44640)
      )
        throw new Error(
          "Repeat intervals must be a whole number from 15 to 44,640 minutes.",
        );
      if (action === "render" && (!target || !rights))
        throw new Error(
          "Select your media and confirm the rights needed for this export.",
        );
      setValidation("");
      if (
        await mutate(
          editing ? `/api/os/workflows/${editing.id}` : "/api/os/workflows",
          editing ? "PATCH" : "POST",
          {
            name: name.trim(),
            action,
            target_id: action === "render" ? target : null,
            trigger,
            run_at,
            interval_minutes: trigger === "scheduled" ? interval_minutes : null,
            enabled,
            rights_confirmed: action === "render" && rights,
            ...(editing ? { revision: editing.revision } : {}),
          },
        )
      )
        choose(null);
    } catch (e) {
      setValidation((e as Error).message);
    }
  };
  const workerStatus = (
    <Block
      title={desktop ? "Worker connection" : "Background workflows"}
      subtitle="A schedule continues on the Ziipa worker when you close the app. Run history records completion and failures."
    >
      {!desktop ? (
        <Text style={styles.body}>
          Prepare reminders, rendered exports and supported network
          synchronization. Publishing still opens its separate review flow.
        </Text>
      ) : null}
      <Action secondary title="Manage network connections" onPress={connect} />
      <Notice
        text={
          typeof workspace.workflowConfig.can_run !== "boolean"
            ? "Checking the background worker connection…"
            : workspace.workflowConfig.can_run === true
              ? "Background worker connected. Check run history for each verified result."
              : "The background worker is currently unavailable. Scheduled work stays pending until a worker is connected."
        }
      />
      {typeof workspace.workflowConfig.notice === "string" ? (
        <Text style={styles.small}>{workspace.workflowConfig.notice}</Text>
      ) : null}
    </Block>
  );
  const workflowEditor = (
    <Block title={editing ? "Edit workflow" : "Create a workflow"}>
      <Field
        label="Workflow name"
        value={name}
        onChangeText={setName}
        maxLength={120}
      />
      <Text style={styles.label}>What should happen?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(Object.keys(actionNames) as Workflow["action"][]).map((value) => (
          <Pill
            key={value}
            title={actionNames[value]}
            active={action === value}
            onPress={() => setAction(value)}
          />
        ))}
      </View>
      <Text style={styles.label}>When should it happen?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(Object.keys(triggerNames) as Workflow["trigger"][]).map((value) => (
          <Pill
            key={value}
            title={triggerNames[value]}
            active={trigger === value}
            onPress={() => setTrigger(value)}
          />
        ))}
      </View>
      {trigger === "scheduled" ? (
        <>
          <DateField
            label="First run date and time"
            value={runAt}
            onChange={setRunAt}
          />
          <Field
            label="Repeat every N minutes (optional)"
            value={interval}
            onChangeText={setInterval}
            keyboardType="number-pad"
            placeholder="Leave empty for one run"
          />
        </>
      ) : null}
      {action === "render" ? (
        <>
          <Text style={styles.label}>Choose owned media</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {workspace.library.items.map((item) => (
              <Pill
                key={item.id}
                title={item.title}
                active={target === item.id}
                onPress={() => setTarget(item.id)}
              />
            ))}
          </View>
          <Toggle
            title="I have the rights to export this media, music and overlays"
            value={rights}
            onChange={setRights}
          />
        </>
      ) : null}
      {action === "bluesky_sync" ? (
        <Notice text="Uses only the Bluesky account you connected to Ziipa and the feeds its provider permits." />
      ) : null}
      <Toggle
        title="Enable this workflow"
        disabled={busy}
        value={enabled}
        onChange={setEnabled}
      />
      {validation ? <Notice text={validation} error /> : null}
      <Action
        title={editing ? "Save workflow changes" : "Create workflow"}
        icon={CalendarClock}
        busy={busy}
        onPress={() => void save()}
      />
      {editing ? (
        <Action
          secondary
          title="Cancel workflow edit"
          onPress={() => choose(null)}
        />
      ) : null}
    </Block>
  );
  const emptyWorkflows = !workspace.workflows.length ? (
    <Notice text="No workflows yet. Create a private reminder to try a scheduled task." />
  ) : null;
  const workflowList = workspace.workflows.map((workflow) => (
    <Block
      key={workflow.id}
      title={workflow.name}
      subtitle={`${workflow.enabled ? "Enabled" : "Paused"} · ${actionNames[workflow.action]} · ${triggerNames[workflow.trigger]}`}
    >
      <Text style={styles.small}>
        {workflow.next_run || workflow.run_at
          ? `${workflow.enabled ? "Next scheduled time" : "Saved schedule"}: ${new Date(workflow.next_run || workflow.run_at!).toLocaleString()}`
          : "Runs when its trigger occurs."}
        {workflow.interval_minutes
          ? ` · Repeats every ${workflow.interval_minutes} minutes`
          : ""}
      </Text>
      <Action
        secondary
        title="Edit workflow"
        disabled={busy}
        onPress={() => choose(workflow)}
      />
      <Action
        secondary
        title={workflow.enabled ? "Pause workflow" : "Resume workflow"}
        busy={busy}
        onPress={() =>
          void mutate(
            workflow.enabled
              ? `/api/os/workflows/${workflow.id}/pause`
              : `/api/os/workflows/${workflow.id}`,
            workflow.enabled ? "POST" : "PATCH",
            workflow.enabled
              ? undefined
              : {
                  name: workflow.name,
                  action: workflow.action,
                  target_id: workflow.target_id,
                  trigger: workflow.trigger,
                  run_at: workflow.run_at,
                  interval_minutes: workflow.interval_minutes,
                  rights_confirmed: workflow.rights_confirmed,
                  revision: workflow.revision,
                  enabled: true,
                },
          )
        }
      />
      {runReview === workflow.id ? (
        <>
          <Notice
            text={`Run “${workflow.name}” now? ${workflow.action === "render" ? "This will request an export of the selected media using your confirmed rights." : workflow.action === "bluesky_sync" ? "This will refresh the supported feeds of your connected account." : "This will create a private reminder."}`}
          />
          <Action
            title="Confirm run now"
            busy={busy}
            onPress={() => {
              setRunReview(null);
              void mutate(`/api/os/workflows/${workflow.id}/run`, "POST");
            }}
          />
          <Action
            secondary
            title="Keep the schedule"
            onPress={() => setRunReview(null)}
          />
        </>
      ) : (
        <Action
          secondary
          title="Review run now"
          disabled={busy}
          onPress={() => setRunReview(workflow.id)}
        />
      )}
      <Remove
        title="Delete workflow"
        detail="This deletes the workflow and its run history."
        busy={busy}
        onConfirm={() =>
          void mutate(`/api/os/workflows/${workflow.id}`, "DELETE")
        }
      />
    </Block>
  ));
  const workflowHistory = (
    <Block
      title="Run history"
      subtitle="Queued work is not yet complete. A completed status is produced by the worker."
    >
      {!workspace.runs.length ? (
        <Text style={styles.small}>
          Runs will appear here after a schedule or trigger starts.
        </Text>
      ) : (
        workspace.runs.map((run) => (
          <View
            key={run.id}
            style={{
              gap: 10,
              borderTopWidth: 1,
              borderColor: color.border,
              paddingTop: 14,
            }}
          >
            <Text style={[styles.body, { color: color.text }]}>
              {workspace.workflows.find((w) => w.id === run.workflow_id)
                ?.name || "Workflow"}{" "}
              · {readableStatus(run.status)}
            </Text>
            <Text style={styles.small}>
              {new Date(run.created_at).toLocaleString()}
              {run.attempts ? ` · Attempt ${run.attempts}` : ""}
            </Text>
            {run.detail || run.error ? (
              <Notice
                text={run.error || run.detail || ""}
                error={["failed", "blocked"].includes(run.status)}
              />
            ) : null}
            {["failed", "blocked", "cancelled"].includes(run.status) ? (
              <Action
                secondary
                title="Retry this run"
                disabled={busy}
                onPress={() =>
                  void mutate(`/api/os/workflows/runs/${run.id}/retry`, "POST")
                }
              />
            ) : null}
            {["queued", "running"].includes(run.status) ? (
              <Action
                secondary
                title="Cancel this run"
                disabled={busy}
                onPress={() =>
                  void mutate(`/api/os/workflows/runs/${run.id}/cancel`, "POST")
                }
              />
            ) : null}
          </View>
        ))
      )}
    </Block>
  );
  return desktop ? (
    <View style={{ gap: 20 }}>
      {workerStatus}
      <WorkspaceColumns
        asideWidth={380}
        main={
          <>
            {emptyWorkflows}
            {workflowList}
            {workflowHistory}
          </>
        }
        aside={workflowEditor}
      />
    </View>
  ) : (
    <>
      {workerStatus}
      {workflowEditor}
      {emptyWorkflows}
      {workflowList}
      {workflowHistory}
    </>
  );
}

function money(minor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    const precision = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** precision);
  } catch {
    return `${minor} ${currency} minor units`;
  }
}
function metric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "Not available";
}
function ActivityRows({ activity }: { activity: Activity[] }) {
  return (
    <>
      {activity.map((event) => (
        <View
          key={event.id}
          style={{
            gap: 5,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderColor: color.border,
          }}
        >
          <Text style={[styles.body, { color: color.text }]}>
            {event.title ||
              event.summary ||
              readableStatus(
                event.action || event.kind || "Workspace activity",
              )}
          </Text>
          {event.detail ? (
            <Text style={styles.small}>{event.detail}</Text>
          ) : null}
          <Text style={styles.small}>
            {new Date(event.created_at).toLocaleString()}
            {event.status ? ` · ${readableStatus(event.status)}` : ""}
          </Text>
        </View>
      ))}
    </>
  );
}
function InsightsPanel({
  workspace,
  busy,
  mutate,
}: {
  workspace: Workspace;
  busy: boolean;
  mutate: Mutate;
}) {
  const { desktop } = useDesktopLayout();
  const [amount, setAmount] = useState("");
  const [visibleEntries, setVisibleEntries] = useState(30);
  const [currency, setCurrency] = useState("USD");
  const [type, setType] = useState<RevenueEntry["type"]>("income");
  const [status, setStatus] = useState<RevenueEntry["status"]>("received");
  const [category, setCategory] = useState("creator");
  const [note, setNote] = useState("");
  const [occurred, setOccurred] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const save = async () => {
    try {
      const amount_minor = parseMinorAmount(amount);
      if (!/^[A-Z]{3}$/.test(currency))
        throw new Error(
          "Enter a three-letter currency code, such as USD, EUR or JPY.",
        );
      const occurred_at = isoInstant(occurred) || new Date().toISOString();
      setValidation("");
      if (
        await mutate("/api/os/revenue", "POST", {
          amount_minor,
          currency,
          type,
          status,
          category: category.trim(),
          note,
          occurred_at,
          item_id: itemId,
        })
      ) {
        setAmount("");
        setNote("");
      }
    } catch (e) {
      setValidation((e as Error).message);
    }
  };
  const totals = economicTotals(workspace.revenue);
  const engagement = workspace.insights.engagement || {};
  const engagementSummary = (
    <Block
      title="Insights grounded in your activity"
      subtitle="Counts below come from Ziipa. External network views and payouts are not inferred."
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {[
          ["Likes", engagement.likes],
          ["Saves", engagement.saves],
          ["Comments", engagement.comments],
        ].map(([label, count]) => (
          <View
            key={String(label)}
            style={{
              flex: 1,
              minWidth: 90,
              padding: 12,
              borderRadius: 15,
              backgroundColor: color.bg,
            }}
          >
            <Text style={[styles.heading, { color: color.lime }]}>
              {metric(count)}
            </Text>
            <Text style={styles.small}>{String(label)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.small}>
        Views: {metric(engagement.views)} · Verified provider analytics will
        appear only when connected and supported.
      </Text>
      <Text style={styles.small}>
        Publishing requests: {metric(workspace.insights.publishing?.total)} ·
        Render requests: {metric(workspace.insights.rendering?.total)}
      </Text>
    </Block>
  );
  const economicsSummary = (
    <Block
      title="Creator economics"
      subtitle="Your recorded ledger. These figures are user-reported and are not verified payment receipts."
    >
      {Object.entries(totals).length ? (
        Object.entries(totals).map(([code, total]) => (
          <View
            key={code}
            style={{
              gap: 6,
              padding: 14,
              borderRadius: 15,
              backgroundColor: color.bg,
            }}
          >
            <Text style={styles.heading}>{code}</Text>
            <Text style={styles.body}>
              Received income: {money(total.received, code)}
            </Text>
            <Text style={styles.body}>
              Paid expenses: {money(total.spent, code)}
            </Text>
            <Text style={[styles.body, { color: color.lime }]}>
              Realized net: {money(total.received - total.spent, code)}
            </Text>
            <Text style={styles.small}>
              Expected income: {money(total.expectedIncome, code)} · Expected
              expenses: {money(total.expectedExpense, code)}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.small}>
          No recorded revenue or expenses. Expected amounts will stay separate
          from realized results.
        </Text>
      )}
    </Block>
  );
  const ledgerEditor = (
    <Block title="Record income or an expense">
      <Choices
        options={["income", "expense"] as const}
        value={type}
        onChange={setType}
      />
      <Text style={styles.label}>Payment state</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pill
          title={type === "income" ? "Received" : "Paid"}
          active={status === "received"}
          onPress={() => setStatus("received")}
        />
        <Pill
          title="Expected"
          active={status === "expected"}
          onPress={() => setStatus("expected")}
        />
      </View>
      <Field
        label="Amount in minor units"
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
        placeholder="1250"
      />
      <Text style={styles.small}>
        For USD, 1250 means $12.50. For JPY, 1250 means ¥1,250. Enter a positive
        amount.
      </Text>
      <Field
        label="Currency code"
        value={currency}
        onChangeText={(v) => setCurrency(v.toUpperCase())}
        autoCapitalize="characters"
        maxLength={3}
      />
      <Field
        label="Category"
        value={category}
        onChangeText={setCategory}
        maxLength={80}
      />
      <Field
        label="Private note"
        value={note}
        onChangeText={setNote}
        multiline
      />
      <DateField
        label="Occurred at (optional; defaults to now)"
        value={occurred}
        onChange={setOccurred}
      />
      <Text style={styles.label}>Related media (optional)</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill title="None" active={!itemId} onPress={() => setItemId(null)} />
        {workspace.library.items.map((item) => (
          <Pill
            key={item.id}
            title={item.title}
            active={item.id === itemId}
            onPress={() => setItemId(item.id)}
          />
        ))}
      </View>
      {validation ? <Notice error text={validation} /> : null}
      <Action
        title="Save ledger entry"
        busy={busy}
        onPress={() => void save()}
      />
    </Block>
  );
  const ledgerEntries = workspace.revenue
    .slice(0, visibleEntries)
    .map((entry) => (
      <Block
        key={entry.id}
        title={`${entry.type === "expense" ? "Expense" : "Income"} · ${money(entry.amount_minor, entry.currency)}`}
        subtitle={`${entry.status === "received" ? (entry.type === "expense" ? "Paid" : "Received") : "Expected"} · ${entry.category} · ${new Date(entry.occurred_at).toLocaleString()}`}
      >
        <Text style={styles.body}>{entry.note}</Text>
        <Remove
          title="Delete ledger entry"
          busy={busy}
          onConfirm={() => void mutate(`/api/os/revenue/${entry.id}`, "DELETE")}
        />
      </Block>
    ));
  const moreEntries =
    workspace.revenue.length > visibleEntries ? (
      <Action
        secondary
        title="Show more ledger entries"
        onPress={() => setVisibleEntries((n) => n + 30)}
      />
    ) : null;
  const activityHistory = (
    <Block
      title="Your activity history"
      subtitle="Workspace changes and verified tool outcomes."
    >
      {workspace.activity.length ? (
        <ActivityRows activity={workspace.activity} />
      ) : (
        <Text style={styles.small}>
          Your workspace activity will appear here.
        </Text>
      )}
    </Block>
  );
  return desktop ? (
    <View style={{ gap: 20 }}>
      <WorkspaceGrid minimum={350}>
        {engagementSummary}
        {economicsSummary}
      </WorkspaceGrid>
      <WorkspaceColumns
        asideWidth={360}
        main={
          <>
            <Text style={[styles.heading, { fontSize: 18 }]}>
              Ledger entries
            </Text>
            {workspace.revenue.length ? (
              ledgerEntries
            ) : (
              <Notice text="No ledger entries recorded. Add received or expected amounts without mixing their totals." />
            )}
            {moreEntries}
            {activityHistory}
          </>
        }
        aside={ledgerEditor}
      />
    </View>
  ) : (
    <>
      {engagementSummary}
      {economicsSummary}
      {ledgerEditor}
      {ledgerEntries}
      {moreEntries}
      {activityHistory}
    </>
  );
}
