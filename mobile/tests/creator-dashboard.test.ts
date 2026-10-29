import test from "node:test";
import assert from "node:assert/strict";
import { creationTrend, dashboardBars } from "../src/lib/creator-dashboard.ts";
import type { Item } from "../src/lib/types.ts";

test("graphs preserve real zero counts and omit unavailable or malformed metrics", () => {
  assert.deepEqual(
    dashboardBars({
      likes: 4,
      saves: 0,
      views: null,
      invalid: -1,
      unknown: undefined,
      unbounded: Infinity,
    }),
    [
      { label: "likes", count: 4, percent: 100 },
      { label: "saves", count: 0, percent: 0 },
    ],
  );
  assert.deepEqual(dashboardBars(null), []);
});

test("creation trend uses UTC timestamps once per real creation and never counts samples or future work", () => {
  const item = (id: string, created_at: string, demo = false) =>
    ({ id, created_at, demo }) as Item;
  const now = new Date("2026-10-29T12:00:00Z");
  const trend = creationTrend(
    [
      item("one", "2026-10-28T23:30:00-04:00"),
      item("one", "2026-10-29T04:00:00Z"),
      item("two", "2026-10-28T00:00:00Z"),
      item("old", "2026-10-01T00:00:00Z"),
      item("sample", "2026-10-29T05:00:00Z", true),
      item("future", "2026-10-29T20:00:00Z"),
      item("invalid", "not a date"),
    ],
    now,
    2,
  );
  assert.deepEqual(trend, [
    { date: "2026-10-28", count: 1 },
    { date: "2026-10-29", count: 1 },
  ]);
});
