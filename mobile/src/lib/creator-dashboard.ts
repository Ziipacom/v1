import type { Item } from "./types";

export type CreatorInsights = {
  library: {
    items: number;
    by_visibility: Record<string, number>;
    by_category: Record<string, number>;
  };
  engagement: {
    likes: number;
    comments: number;
    saves: number;
    views: number | null;
    external_analytics_available: boolean;
  };
  publishing: { total: number; by_status: Record<string, number> };
  rendering: { total: number; by_status: Record<string, number> };
};

export function dashboardBars(counts: unknown) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return [];
  const rows = Object.entries(counts).flatMap(([label, count]) =>
    Number.isSafeInteger(count) && (count as number) >= 0
      ? [{ label, count: count as number }]
      : [],
  );
  const max = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => ({ ...row, percent: (row.count / max) * 100 }));
}

/** Actual creation timestamps, not invented view/engagement history. UTC days. */
export function creationTrend(
  items: readonly Item[],
  now = new Date(),
  days = 30,
) {
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const start = end - (days - 1) * 86400000;
  const counts = Array.from({ length: days }, (_, index) => ({
    date: new Date(start + index * 86400000).toISOString().slice(0, 10),
    count: 0,
  }));
  const seen = new Set<string>();
  for (const item of items) {
    const time = item.created_at ? Date.parse(item.created_at) : NaN;
    const index = Math.floor((time - start) / 86400000);
    if (
      !item.demo &&
      !seen.has(item.id) &&
      Number.isFinite(time) &&
      index >= 0 &&
      index < days &&
      time <= now.getTime()
    ) {
      counts[index].count++;
      seen.add(item.id);
    }
  }
  return counts;
}
