export type AgentTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentPolicy = {
  enabled: boolean;
  allowed_tools: string[];
  max_steps: number;
  daily_task_limit: number;
  revision: number;
  updated_at: string | null;
};

export type AgentConfig = {
  enabled: boolean;
  worker_ready: boolean;
  can_run: boolean;
  inference: { mode: string; available: boolean; model: string | null };
  tools: { id: string; title: string }[];
  effective_tools: string[];
  max_steps: number;
  detail: string;
};

export type AgentTask = {
  id: string;
  objective: string;
  project_id: string | null;
  render_item_id: string | null;
  allowed_tools: string[];
  max_steps: number;
  step_count: number;
  model_calls: number;
  status: AgentTaskStatus;
  detail: string;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  deadline: string | null;
};

export type AgentStep = {
  id: string;
  position: number;
  tool: string;
  title: string;
  action_id: string | null;
  status: "prepared" | "running" | "completed" | "blocked";
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type AgentTaskDetail = AgentTask & { steps: AgentStep[] };

export const agentTaskActive = (task: AgentTask) =>
  task.status === "queued" || task.status === "running";
