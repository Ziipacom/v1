import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  calendarCanAcknowledge,
  calendarInput,
  calendarPreflightCurrent,
  calendarTimezone,
  calendarWallTime,
  calendarMonthGrid,
  shiftCalendarMonth,
  nextCalendarWallTime,
  type CalendarDraft,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarPreflight,
} from "../src/lib/calendar-types.ts";

const draft: CalendarDraft = {
  title: "Friday studio",
  notes: "Private plan",
  kind: "reminder",
  timezone: "America/New_York",
  startsLocal: "2026-11-01T01:30:00",
  fold: "earlier",
  duration: "60",
  reminder: "15",
  frequency: "none",
  interval: "1",
  count: "1",
  weekdays: [],
  until: "",
  streamId: null,
  campaignId: null,
};

test("calendar sends local wall time, IANA zone and explicit repeated-hour choice without UTC normalization", () => {
  assert.equal(calendarWallTime("2026-11-01T01:30"), "2026-11-01T01:30:00");
  const early = calendarInput(draft),
    late = calendarInput({ ...draft, fold: "later" });
  assert.equal(early.starts_local, late.starts_local);
  assert.equal(early.timezone, "America/New_York");
  assert.equal(early.fold, "earlier");
  assert.equal(late.fold, "later");
  assert.equal(calendarTimezone("Europe/London"), "Europe/London");
  for (const value of [
    "2026-02-30T12:00",
    "2026-01-01T24:00",
    "2026-01-01T12:00Z",
    "2026-01-01T12:00-04:00",
    "not-a-date",
  ])
    assert.throws(() => calendarWallTime(value));
  assert.throws(() => calendarTimezone("Imaginary/Nowhere"));
});

test("weekly recurrence is bounded, Monday-indexed and does not grant stream or campaign authority", () => {
  const body = calendarInput({
    ...draft,
    frequency: "weekly",
    weekdays: [4, 0, 4],
    count: "8",
    interval: "2",
    until: "2026-12-31",
    streamId: "hidden-stream",
    campaignId: "hidden-campaign",
  });
  assert.deepEqual(body.recurrence.weekdays, [0, 4]);
  assert.equal(body.recurrence.count, 8);
  assert.equal(body.recurrence.interval, 2);
  assert.equal(body.stream_id, null);
  assert.equal(body.campaign_id, null);
  assert.equal("automatic_broadcast" in body, false);
  assert.equal("publish" in body, false);
  for (const patch of [
    { count: "53" },
    { interval: "0" },
    { interval: "1.5" },
    { duration: "721" },
    { reminder: "-1" },
    { weekdays: [] },
    { weekdays: [7] },
  ])
    assert.throws(() =>
      calendarInput({
        ...draft,
        frequency: "weekly",
        weekdays: [0],
        count: "8",
        ...patch,
      }),
    );
});

test("stream preflight freshness is a provider check, never automatic start or proof of broadcasting", () => {
  const current = Date.parse("2026-10-20T12:00:00Z");
  const preflight = {
    status: "verified",
    provider_verified: true,
    provider_active: false,
    automatic_broadcast: false,
    requires_explicit_start: true,
    checked_at: "2026-10-20T11:59:50Z",
    expires_at: "2026-10-20T12:00:10Z",
    checks: [],
    detail: "Read-only check",
  } as CalendarPreflight;
  assert.equal(calendarPreflightCurrent(preflight, current), true);
  assert.equal(preflight.provider_active, false);
  for (const patch of [
    { expires_at: "2026-10-20T11:59:59Z" },
    { status: "unknown" as const },
    { provider_verified: false },
    { checked_at: "2026-10-20T12:01:00Z" },
  ])
    assert.equal(
      calendarPreflightCurrent({ ...preflight, ...patch }, current),
      false,
    );
  assert.equal(calendarPreflightCurrent(null, current), false);
  assert.equal(
    calendarPreflightCurrent({} as CalendarPreflight, current),
    false,
  );
});

test("acknowledgment uses the reminder's revision and does not mark a plan complete", () => {
  const event = { status: "active", revision: 4 } as CalendarEvent;
  const occurrence = {
    revision: 2,
    status: "reminder_ready",
  } as CalendarOccurrence;
  assert.equal(calendarCanAcknowledge(event, occurrence), true);
  assert.equal(
    calendarCanAcknowledge({ ...event, status: "cancelled" }, occurrence),
    false,
  );
  for (const status of [
    "scheduled",
    "cancelled",
    "acknowledged",
    "missed",
  ] as const)
    assert.equal(
      calendarCanAcknowledge(event, { ...occurrence, status }),
      false,
    );
});

test("month grid is Monday-first, includes leap days and crosses year boundaries without timezone shifts", () => {
  const february = calendarMonthGrid("2028-02");
  assert.equal(february.length, 42);
  assert.equal(february[0].date, "2028-01-31");
  assert.equal(february.filter((day) => day.inMonth).length, 29);
  assert.equal(february.find((day) => day.date === "2028-02-29")?.day, 29);
  assert.equal(shiftCalendarMonth("2026-12", 1), "2027-01");
  assert.equal(shiftCalendarMonth("2026-01", -1), "2025-12");
  assert.equal(shiftCalendarMonth("2000-01", -1), "2000-01");
  assert.throws(() => calendarMonthGrid("2026-99"));
  assert.throws(() => shiftCalendarMonth("2026-99", 1));
});

test("new event seed is the next rounded hour in its chosen IANA timezone", () => {
  assert.equal(
    nextCalendarWallTime(
      "America/New_York",
      Date.parse("2026-10-20T18:32:10Z"),
    ),
    "2026-10-20T15:00:00",
  );
  assert.equal(
    nextCalendarWallTime("Asia/Kolkata", Date.parse("2026-10-20T18:32:10Z")),
    "2026-10-21T01:00:00",
  );
});
