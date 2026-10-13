import type { Item } from "./types";

export type MediaOSTab =
  "Overview" | "Library" | "Memory" | "Assistant" | "Workflows" | "Insights";
export type Project = {
  id: string;
  name: string;
  description: string;
  status: string;
  asset_ids: string[];
  revision: number;
};
export type Memory = {
  id: string;
  kind: "preference" | "style" | "context";
  body: string;
  source: string;
  revision: number;
};
export type GoalStep = { id: string; title: string; completed: boolean };
export type Goal = {
  id: string;
  title: string;
  description: string;
  project_id: string | null;
  due_at: string | null;
  status: string;
  steps: GoalStep[];
  revision: number;
  progress?: { completed: number; total: number; percent: number };
};
export type AssetRights = {
  basis: "original" | "licensed" | "permission" | "unknown";
  license_note: string;
  source_url: string;
  expires_at: string | null;
  allow_ai: boolean;
  expired?: boolean;
  effective_allow_ai?: boolean;
};
export type AssetMetadata = {
  notes: string;
  tags: string[];
  project_id: string | null;
  rights: AssetRights;
  revision: number;
};
export type LibraryItem = Item & {
  metadata?: AssetMetadata;
  asset_metadata?: AssetMetadata;
  project_id?: string | null;
};
export type LibraryMedia = {
  id: string;
  content_type: string;
  size: number;
  name?: string;
  filename?: string;
  original_name?: string;
  created_at?: string;
};
export type Library = {
  items: LibraryItem[];
  media?: LibraryMedia[];
  provenance?: string | Record<string, unknown>;
};
export type Workflow = {
  id: string;
  name: string;
  action: "reminder" | "render" | "bluesky_sync";
  target_id: string | null;
  trigger: "scheduled" | "media_saved" | "render_ready";
  run_at: string | null;
  interval_minutes: number | null;
  enabled: boolean;
  rights_confirmed: boolean;
  revision: number;
  next_run?: string | null;
};
export type WorkflowRun = {
  id: string;
  workflow_id: string;
  status: string;
  detail?: string;
  error?: string;
  result?: Record<string, unknown>;
  created_at: string;
  finished_at?: string | null;
  attempts?: number;
};
export type RevenueEntry = {
  id: string;
  amount_minor: number;
  currency: string;
  type: "income" | "expense";
  status: "received" | "expected";
  category: string;
  note: string;
  occurred_at: string;
  item_id: string | null;
};
export type Activity = {
  id: string;
  action?: string;
  kind?: string;
  title?: string;
  summary?: string;
  detail?: string;
  created_at: string;
  status?: string;
};
export type AssistantMessage = {
  id: string;
  role: string;
  body: string;
  created_at: string;
};
export type AssistantProposal = {
  id: string;
  tool: string;
  title: string;
  summary: string;
  arguments: Record<string, unknown>;
  status: string;
  expires_at: string;
  revision?: number;
};
export type AssistantReply = {
  message: AssistantMessage;
  proposal?: AssistantProposal | null;
};
export type AssistantConfig = {
  mode: string;
  skills?: string[];
  available?: boolean;
  local_ai?: { available?: boolean; model?: string | null };
  inference?: {
    mode: "local_ai" | "hosted_ai" | "guided";
    available: boolean;
    model: string | null;
  };
  detail?: string;
  tools?: { id: string; title?: string }[];
};
export type Insights = {
  engagement?: Record<string, unknown>;
  publishing?: Record<string, unknown>;
  rendering?: Record<string, unknown>;
  economics?: unknown;
  provenance?: unknown;
};
export type Workspace = {
  projects: Project[];
  goals: Goal[];
  memories: Memory[];
  library: Library;
  workflows: Workflow[];
  runs: WorkflowRun[];
  revenue: RevenueEntry[];
  activity: Activity[];
  insights: Insights;
  messages: AssistantMessage[];
  actions: AssistantProposal[];
  permissions: string[];
  assistant: AssistantConfig | null;
  workflowConfig: Record<string, unknown>;
};
export const emptyWorkspace = (): Workspace => ({
  projects: [],
  goals: [],
  memories: [],
  library: { items: [] },
  workflows: [],
  runs: [],
  revenue: [],
  activity: [],
  insights: {},
  messages: [],
  actions: [],
  permissions: [],
  assistant: null,
  workflowConfig: {},
});
export const emptyAssetMetadata = (): AssetMetadata => ({
  notes: "",
  tags: [],
  project_id: null,
  rights: {
    basis: "unknown",
    license_note: "",
    source_url: "",
    expires_at: null,
    allow_ai: false,
  },
  revision: 0,
});

/** Use an explicit offset so a schedule means the same instant on mobile and web. */
export function isoInstant(value: string, required = false): string | null {
  const input = value.trim();
  if (!input) {
    if (required)
      throw new Error(
        "Enter a date and time with a timezone, such as 2026-10-20T18:00:00Z.",
      );
    return null;
  }
  const parts = input.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  const calendar = new Date(0);
  if (parts)
    calendar.setUTCFullYear(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
    );
  if (
    !parts ||
    !Number.isFinite(Date.parse(input)) ||
    calendar.getUTCFullYear() !== Number(parts[1]) ||
    calendar.getUTCMonth() !== Number(parts[2]) - 1 ||
    calendar.getUTCDate() !== Number(parts[3]) ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6] || 0) > 59
  )
    throw new Error(
      "Use a valid date and time with Z or a timezone offset, such as 2026-10-20T18:00:00Z.",
    );
  return new Date(input).toISOString();
}

/** Record currency in its own minor unit; never combine unrelated currencies. */
export function parseMinorAmount(value: string): number {
  if (!/^\d+$/.test(value.trim()))
    throw new Error(
      "Enter a whole number of minor units (for USD, 1250 means $12.50).",
    );
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000)
    throw new Error("Enter a positive amount up to 1,000,000,000 minor units.");
  return amount;
}
export function economicTotals(entries: RevenueEntry[]) {
  const totals: Record<
    string,
    {
      received: number;
      spent: number;
      expectedIncome: number;
      expectedExpense: number;
    }
  > = {};
  for (const entry of entries) {
    const total = (totals[entry.currency] ??= {
      received: 0,
      spent: 0,
      expectedIncome: 0,
      expectedExpense: 0,
    });
    if (entry.status === "received")
      total[entry.type === "income" ? "received" : "spent"] +=
        entry.amount_minor;
    else
      total[entry.type === "income" ? "expectedIncome" : "expectedExpense"] +=
        entry.amount_minor;
  }
  return totals;
}
export function readableStatus(value: string) {
  return value.replace(/_/g, " ");
}
export function goalStepsFromText(
  value: string,
  existing: GoalStep[] = [],
  prefix = `step-${Date.now()}`,
): GoalStep[] {
  const titles = value
    .split("\n")
    .map((title) => title.trim())
    .filter(Boolean);
  if (titles.length > 50 || titles.some((title) => title.length > 140))
    throw new Error(
      "Use up to 50 goal steps, each with at most 140 characters.",
    );
  const used = new Set<string>();
  return titles.map((title, index) => {
    const previous = existing.find(
      (step) => step.title === title && !used.has(step.id),
    );
    const id = previous?.id || `${prefix}-${index}`;
    used.add(id);
    return { id, title, completed: previous?.completed || false };
  });
}
export function listOf<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (
    value &&
    typeof value === "object" &&
    key in value &&
    Array.isArray((value as Record<string, unknown>)[key])
  )
    return (value as Record<string, unknown>)[key] as T[];
  return [];
}
