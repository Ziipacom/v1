import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Switch, Text, View } from "react-native";
import {
  Bot,
  Check,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { Action, Field, Notice, Pill } from "./ui";
import { useZiipa } from "../provider";
import { useDesktopLayout } from "./desktop-layout";
import { color, styles, font } from "../theme";
import { InfoTip } from "./info-tip";
import { HelpLabel } from "./help-label";
import { Sheet } from "./floating";
import { LibrarySection } from "./personal-library";
import { readableStatus, type Project } from "../lib/media-os-types";
import {
  agentTaskActive,
  type AgentConfig,
  type AgentPolicy,
  type AgentTask,
  type AgentTaskDetail,
} from "../lib/agent-types";

type AgentApi = <T>(
  path: string,
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
) => Promise<T>;

function budget(value: string, maximum: number) {
  if (!/^\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isInteger(result) && result >= 1 && result <= maximum
    ? result
    : null;
}

function statusColor(task: AgentTask) {
  return task.status === "completed"
    ? color.lime
    : task.status === "blocked" || task.status === "failed"
      ? "#FF9EAC"
      : color.text;
}

export function AgentTasks({
  api,
  projects,
  permissions,
}: {
  api: AgentApi;
  projects: Project[];
  permissions: () => void;
}) {
  const { desktop } = useDesktopLayout();
  const { session } = useZiipa();
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tools, setTools] = useState<string[]>([]);
  const [stepLimit, setStepLimit] = useState("5");
  const [dailyLimit, setDailyLimit] = useState("5");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selected, setSelected] = useState<AgentTaskDetail | null>(null);
  const [objective, setObjective] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [cancelReview, setCancelReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [pollRemaining, setPollRemaining] = useState(12);
  const [section, setSection] = useState<"Tasks" | "Activity" | "Settings">(
    "Tasks",
  );
  const alive = useRef(true);
  const owner = useRef(session?.access_token);
  owner.current = session?.access_token;
  const generation = useRef(0);
  const tasksGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const lock = useRef(false);
  const selectedId = useRef<string | null>(null);
  const requestId = useRef(Crypto.randomUUID());

  const valid = (token: string | undefined, current: number) =>
    alive.current &&
    !!token &&
    owner.current === token &&
    generation.current === current;

  const loadTasks = useCallback(async () => {
    const token = owner.current;
    const current = generation.current;
    const taskLoad = ++tasksGeneration.current;
    if (!token) return;
    const list = await api<AgentTask[]>("/api/os/agent/tasks");
    if (!valid(token, current) || tasksGeneration.current !== taskLoad) return;
    setTasks(list);
    const id = selectedId.current;
    if (id) {
      const detailLoad = ++detailGeneration.current;
      const detail = await api<AgentTaskDetail>(
        `/api/os/agent/tasks/${encodeURIComponent(id)}`,
      );
      if (
        valid(token, current) &&
        tasksGeneration.current === taskLoad &&
        detailGeneration.current === detailLoad &&
        selectedId.current === id
      )
        setSelected(detail);
    }
  }, [api]);

  const load = useCallback(async () => {
    const token = owner.current;
    const current = generation.current;
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [nextConfig, nextPolicy] = await Promise.all([
        api<AgentConfig>("/api/os/agent/config"),
        api<AgentPolicy>("/api/os/agent/policy"),
      ]);
      if (!valid(token, current)) return;
      setConfig(nextConfig);
      setPolicy(nextPolicy);
      setEnabled(nextPolicy.enabled);
      setTools(nextPolicy.allowed_tools);
      setStepLimit(String(nextPolicy.max_steps));
      setDailyLimit(String(nextPolicy.daily_task_limit));
      await loadTasks();
    } catch (e) {
      if (valid(token, current))
        setError(e instanceof Error ? e.message : "Could not load the agent.");
    } finally {
      if (valid(token, current)) setLoading(false);
    }
  }, [api, loadTasks]);

  useEffect(() => {
    alive.current = true;
    generation.current++;
    detailGeneration.current++;
    selectedId.current = null;
    setConfig(null);
    setPolicy(null);
    setTasks([]);
    setSelected(null);
    setEnabled(false);
    setTools([]);
    setObjective("");
    setProjectId(null);
    setReview(false);
    setCancelReview(null);
    setNotice("");
    requestId.current = Crypto.randomUUID();
    void load();
    return () => {
      alive.current = false;
      generation.current++;
      detailGeneration.current++;
      selectedId.current = null;
    };
  }, [session?.access_token, load]);

  useEffect(() => {
    const visible = () => {
      const webVisible =
        typeof document === "undefined" ||
        document.visibilityState !== "hidden";
      setForeground(AppState.currentState === "active" && webVisible);
    };
    const subscription = AppState.addEventListener("change", visible);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    visible();
    return () => {
      subscription.remove();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const active = tasks.some(agentTaskActive);
  useEffect(() => {
    if (!foreground || !active || busy || loading || pollRemaining <= 0) return;
    // Stop after two minutes. A manual refresh restarts this bounded window.
    const timer = setTimeout(() => {
      const token = owner.current;
      const current = generation.current;
      void loadTasks()
        .then(() => {
          if (valid(token, current))
            setPollRemaining((remaining) => Math.max(0, remaining - 1));
        })
        .catch((e) => {
          if (valid(token, current)) {
            setError(
              e instanceof Error ? e.message : "Could not refresh tasks.",
            );
            setPollRemaining(0);
          }
        });
    }, 10000);
    return () => clearTimeout(timer);
  }, [active, busy, foreground, loadTasks, loading, pollRemaining]);

  async function run(action: () => Promise<void>) {
    if (lock.current || !owner.current) return;
    lock.current = true;
    const token = owner.current;
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (valid(token, current))
        setError(
          e instanceof Error ? e.message : "The agent action did not complete.",
        );
    } finally {
      lock.current = false;
      if (valid(token, current)) setBusy(false);
    }
  }

  const steps = budget(stepLimit, config?.max_steps || 10);
  const daily = budget(dailyLimit, 20);
  const policyChanged =
    !!policy &&
    (enabled !== policy.enabled ||
      steps !== policy.max_steps ||
      daily !== policy.daily_task_limit ||
      [...tools].sort().join(",") !==
        [...policy.allowed_tools].sort().join(","));
  const canQueue =
    !!config?.can_run &&
    !!config?.effective_tools.some((tool) => tool !== "render.create") &&
    !!policy?.enabled &&
    !policyChanged &&
    !!objective.trim();

  async function savePolicy() {
    if (!policy || !steps || !daily) return;
    const token = owner.current;
    const current = generation.current;
    await api<AgentPolicy>("/api/os/agent/policy", "PUT", {
      enabled,
      allowed_tools: tools,
      max_steps: steps,
      daily_task_limit: daily,
      revision: policy.revision,
    });
    if (!valid(token, current)) return;
    requestId.current = Crypto.randomUUID();
    await load();
    if (valid(token, current))
      setNotice(
        enabled
          ? "Saved. New tasks may use your effective tool permissions without a separate approval for each private action."
          : "Agent disabled. Active tasks are paused by the server.",
      );
  }

  async function queueTask() {
    if (!canQueue || !policy) return;
    const token = owner.current;
    const current = generation.current;
    const task = await api<AgentTask>("/api/os/agent/tasks", "POST", {
      request_id: requestId.current,
      objective: objective.trim(),
      project_id: projectId,
      max_steps: policy.max_steps,
    });
    if (!valid(token, current)) return;
    requestId.current = Crypto.randomUUID();
    setReview(false);
    setObjective("");
    selectedId.current = task.id;
    detailGeneration.current++;
    setSelected({ ...task, steps: [] });
    setPollRemaining(12);
    setNotice("Task added. Follow its progress and completed steps below.");
    await loadTasks();
  }

  async function inspect(task: AgentTask) {
    const previousId = selectedId.current;
    selectedId.current = task.id;
    const detailLoad = ++detailGeneration.current;
    const token = owner.current;
    const current = generation.current;
    try {
      const detail = await api<AgentTaskDetail>(
        `/api/os/agent/tasks/${encodeURIComponent(task.id)}`,
      );
      if (
        valid(token, current) &&
        detailGeneration.current === detailLoad &&
        selectedId.current === task.id
      ) {
        setSelected(detail);
        setCancelReview(null);
      }
    } catch (e) {
      if (
        valid(token, current) &&
        detailGeneration.current === detailLoad &&
        selectedId.current === task.id
      )
        selectedId.current = previousId;
      throw e;
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!selected) return;
    const token = owner.current;
    const current = generation.current;
    await api<AgentTask>(
      `/api/os/agent/tasks/${encodeURIComponent(selected.id)}/${action}`,
      "POST",
      {
        revision: selected.revision,
      },
    );
    if (!valid(token, current)) return;
    setCancelReview(null);
    setPollRemaining(12);
    await loadTasks();
    if (!valid(token, current)) return;
    setNotice(
      action === "cancel"
        ? "Cancelled. Completed changes remain in your activity."
        : action === "pause"
          ? "Paused. An action already in progress may finish before the pause takes effect."
          : "Task resumed with your current permissions and remaining limits.",
    );
  }

  const agentReadiness = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {[
        ["Processing", !!config?.worker_ready],
        ["AI", !!config?.inference.available],
        ["Agent", !!policy?.enabled],
      ].map(([label, ready]) => (
        <View
          key={String(label)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: color.border,
            backgroundColor: color.bg,
          }}
        >
          <View
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: ready ? color.lime : color.faint,
            }}
          />
          <Text style={[styles.small, { fontSize: 12 }]}>
            {String(label)}{" "}
            {config
              ? label === "Agent"
                ? ready
                  ? "on"
                  : "off"
                : ready
                  ? "ready"
                  : "unavailable"
              : "checking"}
          </Text>
        </View>
      ))}
    </View>
  );
  const agentInference = config?.inference.model ? (
    <Text style={styles.small}>
      {config.inference.mode === "hosted_ai"
        ? "Private AI service"
        : "Local AI service"}{" "}
      · {config.inference.model}
    </Text>
  ) : null;
  const agentDetail = config?.detail ? <Notice text={config.detail} /> : null;
  const agentSafety = (
    <Notice text="Agent access is limited to your enabled Ziipa tools. It cannot run shell commands, publish publicly, send invitations, spend wallet funds or delete your account. Enable only the private actions you want it to complete without reviewing each step." />
  );
  const agentError = error ? <Notice error text={error} /> : null;
  const agentNotice = notice ? <Notice text={notice} /> : null;
  const refreshAgent = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh agent"
      accessibilityState={{ disabled: busy || loading, busy: loading }}
      disabled={busy || loading}
      onPress={() => {
        setPollRemaining(12);
        void load();
      }}
      style={{
        width: 36,
        height: 36,
        alignItems: "center",
        justifyContent: "center",
        opacity: loading ? 0.5 : 1,
      }}
    >
      <RefreshCw size={18} color={color.muted} />
    </Pressable>
  );
  const agentStatus = (
    <View
      style={[
        styles.panel,
        { gap: 12 },
        desktop && { padding: 18, borderRadius: 14 },
      ]}
    >
      <View style={styles.between}>
        <Text
          style={[styles.heading, { flex: 1, fontSize: desktop ? 20 : 24 }]}
        >
          Ziipa Agent
        </Text>
        <InfoTip
          title="Ziipa Agent"
          content="Ziipa can complete private tasks using only the tools and budgets you enable. Each completed step has a receipt. Public publishing, wallet transactions and account deletion are not automatic."
        />
        {refreshAgent}
      </View>
      {agentReadiness}
    </View>
  );
  const policyEditor =
    policy && config ? (
      <View
        style={[
          styles.panel,
          { gap: 14 },
          desktop && { padding: 20, borderRadius: 14, minWidth: 0 },
        ]}
      >
        <View style={styles.between}>
          <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
            Autonomy permissions
          </Text>
          <ShieldCheck size={24} color={color.lime} />
        </View>
        <View style={styles.between}>
          <Text style={[styles.body, { color: color.text, flex: 1 }]}>
            Enable private autonomous tasks
          </Text>
          <Switch
            accessibilityLabel="Enable private autonomous tasks"
            value={enabled}
            disabled={busy || loading}
            onValueChange={(value) => {
              setEnabled(value);
              setReview(false);
            }}
            trackColor={{ false: color.border, true: color.purple }}
            thumbColor={enabled ? color.lime : color.muted}
          />
        </View>
        {config.tools
          .filter((tool) => tool.id !== "render.create")
          .map((tool) => (
            <Pressable
              key={tool.id}
              accessibilityRole="checkbox"
              accessibilityState={{
                checked: tools.includes(tool.id),
                disabled: busy || loading,
              }}
              disabled={busy || loading}
              onPress={() => {
                setTools((previous) =>
                  previous.includes(tool.id)
                    ? previous.filter((id) => id !== tool.id)
                    : [...previous, tool.id],
                );
                setReview(false);
              }}
              style={[styles.row, { paddingVertical: 8, minHeight: 46 }]}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderWidth: 1,
                  borderColor: tools.includes(tool.id)
                    ? color.lime
                    : color.muted,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tools.includes(tool.id)
                    ? color.purple
                    : color.bg,
                }}
              >
                {tools.includes(tool.id) ? (
                  <Check size={17} color={color.onAccent} />
                ) : null}
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[styles.body, { color: color.text }]}>
                  {tool.title}
                </Text>
                <Text style={styles.small}>
                  {config.effective_tools.includes(tool.id)
                    ? "Enabled for tasks"
                    : "Also allow this action in Assistant permissions"}
                </Text>
              </View>
            </Pressable>
          ))}
        {tools.includes("render.create") ? (
          <Notice text="Your export permission is saved. Choose media and export settings in Creator Studio to create an export." />
        ) : null}
        <Text style={styles.small}>
          A tool must be enabled here and in Assistant permissions. Both grants
          are checked again before every action.
        </Text>
        <Action
          title="Review Assistant permissions"
          secondary
          disabled={busy}
          onPress={permissions}
        />
        <Field
          label="Maximum steps per task (1–10)"
          value={stepLimit}
          onChangeText={(value) => {
            setStepLimit(value);
            setReview(false);
          }}
          keyboardType="number-pad"
          maxLength={2}
          editable={!busy && !loading}
        />
        <Field
          label="Maximum tasks per UTC day (1–20)"
          value={dailyLimit}
          onChangeText={setDailyLimit}
          keyboardType="number-pad"
          maxLength={2}
          editable={!busy && !loading}
        />
        <Action
          title="Save agent settings"
          icon={ShieldCheck}
          busy={busy}
          disabled={loading || !steps || !daily || !policyChanged}
          onPress={() => void run(savePolicy)}
        />
      </View>
    ) : null;
  const taskComposer =
    policy && config ? (
      <View
        style={[
          styles.panel,
          { gap: 14 },
          desktop && { padding: 20, borderRadius: 14, minWidth: 0 },
        ]}
      >
        <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
          Start a task
        </Text>

        <Field
          label="What should Ziipa complete?"
          value={objective}
          onChangeText={(value) => {
            setObjective(value);
            setReview(false);
            requestId.current = Crypto.randomUUID();
          }}
          maxLength={3000}
          multiline
          editable={!busy}
          placeholder="Organize my next release using my private library."
        />
        <HelpLabel
          label="Project context"
          help="Choose a project to focus this task, or use the whole private workspace. The task still follows your saved tool permissions and limits."
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pill
            title="Whole workspace"
            active={!projectId}
            onPress={() => {
              if (!busy) {
                setProjectId(null);
                setReview(false);
                requestId.current = Crypto.randomUUID();
              }
            }}
          />
          {projects.map((project) => (
            <Pill
              key={project.id}
              title={project.name}
              active={projectId === project.id}
              onPress={() => {
                if (!busy) {
                  setProjectId(project.id);
                  setReview(false);
                  requestId.current = Crypto.randomUUID();
                }
              }}
            />
          ))}
        </View>
        {policyChanged ? (
          <Text style={styles.small}>
            Save your updated settings before starting a task.
          </Text>
        ) : !policy.enabled ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.small}>
              Agent is off. Enable it in Settings before starting a task.
            </Text>
            <Action
              secondary
              title="Agent settings"
              onPress={() => setSection("Settings")}
            />
          </View>
        ) : !config.can_run ||
          !config.effective_tools.some((tool) => tool !== "render.create") ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            <Text style={[styles.small, { flexShrink: 1 }]}>
              Tasks are currently unavailable.
            </Text>
            <InfoTip
              title="Task availability"
              content="Tasks need an available AI service and at least one action enabled in both Agent settings and Assistant permissions. Review your settings or refresh the status."
            />
          </View>
        ) : null}
        {review && canQueue ? (
          <>
            <Notice
              text={`Ziipa may complete ${config.effective_tools
                .filter((id) => id !== "render.create")
                .map(
                  (id) =>
                    config.tools.find((tool) => tool.id === id)?.title || id,
                )
                .join(
                  ", ",
                )} without separate approval, for up to ${policy.max_steps} steps. No public publishing or wallet actions are included.`}
            />
            <Action
              title="Confirm task"
              icon={Play}
              busy={busy}
              onPress={() => void run(queueTask)}
            />
            <Action
              title="Keep editing"
              secondary
              disabled={busy}
              onPress={() => setReview(false)}
            />
          </>
        ) : (
          <Action
            title="Review task"
            icon={Bot}
            disabled={busy || loading || !canQueue}
            onPress={() => setReview(true)}
          />
        )}
      </View>
    ) : null;
  const taskActivity = (
    <View
      style={[
        styles.panel,
        { gap: 14 },
        desktop && { padding: 20, borderRadius: 14, minWidth: 0 },
      ]}
    >
      <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
        Task activity
      </Text>
      <Text style={styles.small}>
        {active
          ? pollRemaining > 0 && foreground
            ? "Updating active tasks…"
            : "Refresh to check task progress."
          : "Your recent private tasks."}
      </Text>
      {!tasks.length ? (
        <Text style={styles.body}>No autonomous tasks yet.</Text>
      ) : (
        tasks.map((task) => (
          <Pressable
            key={task.id}
            accessibilityRole="button"
            accessibilityLabel={`Review ${task.objective}`}
            disabled={busy}
            onPress={() => void run(() => inspect(task))}
            style={{
              padding: 14,
              gap: 8,
              borderRadius: 14,
              borderWidth: 1,
              borderColor:
                selected?.id === task.id ? color.purple : color.border,
              backgroundColor: color.bg,
            }}
          >
            <Text style={[styles.label, { color: statusColor(task) }]}>
              {readableStatus(task.status)} · {task.step_count}/{task.max_steps}{" "}
              steps
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.body, { color: color.text }]}
            >
              {task.objective}
            </Text>
            <Text numberOfLines={2} style={styles.small}>
              {task.detail}
            </Text>
            <Text style={styles.small}>
              {new Date(task.updated_at).toLocaleString()}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
  const taskReceipts = selected ? (
    <View
      style={[
        styles.panel,
        { gap: 14 },
        desktop && { padding: 20, borderRadius: 14, minWidth: 0 },
      ]}
    >
      <Text style={[styles.heading, desktop && { fontSize: 18 }]}>
        Task receipts
      </Text>
      <Text style={[styles.body, { color: color.text }]}>
        {selected.objective}
      </Text>
      <Text style={[styles.label, { color: statusColor(selected) }]}>
        {readableStatus(selected.status)}
      </Text>
      <Text style={styles.small}>{selected.detail}</Text>
      {agentTaskActive(selected) ? (
        <Action
          title="Pause task"
          secondary
          icon={Pause}
          busy={busy}
          onPress={() => void run(() => control("pause"))}
        />
      ) : null}
      {selected.status === "paused" || selected.status === "blocked" ? (
        <Action
          title="Resume task"
          icon={Play}
          busy={busy}
          disabled={
            !config?.can_run ||
            !policy?.enabled ||
            !config?.effective_tools.length
          }
          onPress={() => void run(() => control("resume"))}
        />
      ) : null}
      {!["completed", "cancelled", "failed"].includes(selected.status) ? (
        cancelReview === selected.id ? (
          <>
            <Notice text="Cancel the remaining work? Steps already completed are retained and are not rolled back." />
            <Action
              title="Confirm cancellation"
              danger
              icon={X}
              busy={busy}
              onPress={() => void run(() => control("cancel"))}
            />
            <Action
              title="Keep task"
              secondary
              disabled={busy}
              onPress={() => setCancelReview(null)}
            />
          </>
        ) : (
          <Action
            title="Cancel remaining work"
            secondary
            icon={X}
            disabled={busy}
            onPress={() => setCancelReview(selected.id)}
          />
        )
      ) : null}
      {!selected.steps.length ? (
        <Text style={styles.small}>No verified steps yet.</Text>
      ) : (
        selected.steps.map((step) => (
          <View
            key={step.id}
            style={{
              gap: 7,
              paddingTop: 12,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            <Text style={styles.label}>
              {step.position}. {step.title}
            </Text>
            <Text style={styles.small}>
              {config?.tools.find((tool) => tool.id === step.tool)?.title ||
                "Workspace action"}{" "}
              · {readableStatus(step.status)}
            </Text>
            <LibrarySection title="Step details" initiallyOpen={false}>
              {step.action_id ? (
                <Text style={styles.small}>
                  Activity receipt: {step.action_id}
                </Text>
              ) : null}
              {step.result ? (
                <Text selectable style={styles.small}>
                  {JSON.stringify(step.result, null, 2).slice(0, 1500)}
                </Text>
              ) : null}
            </LibrarySection>
          </View>
        ))
      )}
    </View>
  ) : null;
  return (
    <View style={{ gap: 14 }}>
      {agentStatus}
      {agentError}
      {agentNotice}
      <View
        style={{
          flexDirection: "row",
          gap: 6,
          padding: 4,
          backgroundColor: color.panel,
          borderRadius: 12,
        }}
      >
        {(["Tasks", "Activity", "Settings"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            aria-selected={section === value}
            accessibilityState={{ selected: section === value }}
            onPress={() => setSection(value)}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 38,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: section === value ? color.purple : "transparent",
            }}
          >
            <Text
              style={{
                fontFamily: font.semibold,
                fontSize: 14,
                color: section === value ? color.onAccent : color.muted,
              }}
            >
              {value}
            </Text>
          </Pressable>
        ))}
      </View>
      {section === "Tasks" ? taskComposer : null}
      {section === "Activity" ? taskActivity : null}
      {section === "Settings" ? (
        <>
          {agentSafety}
          {policyEditor}
          <LibrarySection title="About task availability" initiallyOpen={false}>
            {agentInference}
            {agentDetail}
            <Text style={styles.small}>
              Service status does not change your saved permissions or enable
              the agent.
            </Text>
          </LibrarySection>
        </>
      ) : null}
      {selected ? (
        <Sheet
          title="Task progress"
          maxWidth={800}
          onClose={() => {
            selectedId.current = null;
            detailGeneration.current++;
            setSelected(null);
            setCancelReview(null);
          }}
        >
          {taskReceipts}
        </Sheet>
      ) : null}
    </View>
  );
}
