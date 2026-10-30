export type CalendarKind = "reminder" | "stream" | "campaign";
export type CalendarRecurrence = {
  frequency: "none" | "daily" | "weekly";
  interval: number;
  count: number;
  weekdays?: number[];
  until?: string | null;
};
export type CalendarPreflight = {
  status: "needs_setup" | "needs_review" | "verified" | "unknown";
  checked_at: string | null;
  expires_at: string | null;
  provider_verified: boolean;
  provider_active: boolean;
  automatic_broadcast: false;
  requires_explicit_start: true;
  checks: {
    id: string;
    label: string;
    status: "ready" | "needs_action" | "unknown";
    detail: string;
  }[];
  detail: string;
};
export type CalendarOccurrence = {
  id: string;
  revision: number;
  starts_at: string;
  remind_at: string;
  status:
    "scheduled" | "reminder_ready" | "missed" | "cancelled" | "acknowledged";
  detail: string;
};
export type CalendarEvent = {
  id: string;
  revision: number;
  status: "active" | "paused" | "cancelled";
  kind: CalendarKind;
  title: string;
  notes: string;
  timezone: string;
  starts_local: string;
  fold: "earlier" | "later";
  duration_minutes: number;
  reminder_minutes: number;
  recurrence: CalendarRecurrence;
  stream_id: string | null;
  campaign_id: string | null;
  occurrences: CalendarOccurrence[];
  next_reminder_at: string | null;
  preflight: CalendarPreflight | null;
};
export type CalendarCampaign = {
  id: string;
  name?: string;
  title?: string;
  status: string;
  schedule_at?: string | null;
};
export type CalendarList = {
  connected_events?: {
    id: string;
    title: string;
    source: string;
    starts_at: string;
    ends_at: string;
    notes: string;
    all_day?: boolean;
  }[];
  events: CalendarEvent[];
  campaigns: CalendarCampaign[];
  automation: { reminders_only: boolean; automatic_broadcast: boolean };
};
export type CalendarDraft = {
  title: string;
  notes: string;
  kind: CalendarKind;
  timezone: string;
  startsLocal: string;
  fold: "earlier" | "later";
  duration: string;
  reminder: string;
  frequency: CalendarRecurrence["frequency"];
  interval: string;
  count: string;
  weekdays: number[];
  until: string;
  streamId: string | null;
  campaignId: string | null;
};
export const calendarRoot = "/api/os/calendar";
export const calendarWeekdays = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

export function nextCalendarWallTime(timezone: string, current = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(current));
  const value = (kind: string) =>
    Number(parts.find((part) => part.type === kind)?.value);
  // Arithmetic here is on wall-clock fields only. The server still resolves DST.
  return new Date(
    Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour") + 1,
    ),
  )
    .toISOString()
    .slice(0, 19);
}

export function shiftCalendarMonth(month: string, offset: number) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(offset))
    throw new Error("Choose a valid calendar month.");
  const [year, index] = month.split("-").map(Number);
  const result = new Date(Date.UTC(year, index - 1 + offset, 1));
  const shifted = result.toISOString().slice(0, 7);
  return shifted < "2000-01"
    ? "2000-01"
    : shifted > "2100-12"
      ? "2100-12"
      : shifted;
}

export function calendarMonthGrid(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Choose a valid calendar month.");
  const [year, index] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, cell) => {
    const day = new Date(Date.UTC(year, index - 1, 1 - mondayOffset + cell));
    const date = day.toISOString().slice(0, 10);
    return {
      date,
      day: day.getUTCDate(),
      inMonth: date.startsWith(month),
      supported: day.getUTCFullYear() >= 2000 && day.getUTCFullYear() <= 2100,
    };
  });
}

export function calendarTimezone(value: string) {
  const zone = value.trim();
  if (!zone || zone.length > 80)
    throw new Error(
      "Enter an IANA timezone, such as America/New_York or Europe/London.",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
  } catch {
    throw new Error(
      "Use a supported IANA timezone, such as America/New_York or Europe/London.",
    );
  }
  return zone;
}

/** Preserve wall-clock input; the API resolves zone rules and DST fold explicitly. */
export function calendarWallTime(value: string) {
  const text = value.trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match)
    throw new Error(
      "Use a local date and time without an offset: YYYY-MM-DDTHH:mm:ss. Choose its timezone separately.",
    );
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((value) => Number(value || 0));
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 2000 ||
    year > 2100 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new Error(
      "Choose a real calendar date and time between 2000 and 2100.",
    );
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
}

function integer(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`${label} must be a whole number.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return result;
}

export function calendarInput(draft: CalendarDraft) {
  if (!draft.title.trim() || draft.title.trim().length > 140)
    throw new Error("Give the event a title of 1–140 characters.");
  if (draft.notes.length > 2000)
    throw new Error("Use up to 2,000 characters of notes.");
  const recurrence: CalendarRecurrence = {
    frequency: draft.frequency,
    interval: integer(draft.interval, 1, 12, "Repeat interval"),
    count:
      draft.frequency === "none"
        ? 1
        : integer(draft.count, 1, 52, "Occurrence count"),
    weekdays:
      draft.frequency === "weekly" ? [...new Set(draft.weekdays)].sort() : [],
  };
  if (
    recurrence.weekdays?.some(
      (day) => !Number.isInteger(day) || day < 0 || day > 6,
    )
  )
    throw new Error("Choose weekdays from Monday through Sunday.");
  if (draft.frequency === "weekly" && !recurrence.weekdays?.length)
    throw new Error("Choose at least one weekday for a weekly schedule.");
  if (draft.frequency !== "none" && draft.until.trim()) {
    const ending = calendarWallTime(`${draft.until.trim()}T00:00:00`).slice(
      0,
      10,
    );
    recurrence.until = ending;
  }
  return {
    title: draft.title.trim(),
    notes: draft.notes,
    kind: draft.kind,
    timezone: calendarTimezone(draft.timezone),
    starts_local: calendarWallTime(draft.startsLocal),
    fold: draft.fold,
    duration_minutes: integer(draft.duration, 1, 720, "Duration"),
    reminder_minutes: integer(draft.reminder, 0, 10080, "Reminder lead time"),
    recurrence,
    stream_id: draft.kind === "stream" ? draft.streamId : null,
    campaign_id: draft.kind === "campaign" ? draft.campaignId : null,
  };
}

export function calendarMoment(iso: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function calendarPreflightCurrent(
  value: CalendarPreflight | null,
  current = Date.now(),
) {
  return (
    !!value &&
    value.status === "verified" &&
    value.provider_verified === true &&
    value.automatic_broadcast === false &&
    value.requires_explicit_start === true &&
    !!value.checked_at &&
    Date.parse(value.checked_at) <= current + 5000 &&
    !!value.expires_at &&
    Date.parse(value.expires_at) > current
  );
}

export function calendarCanAcknowledge(
  event: CalendarEvent,
  occurrence: CalendarOccurrence,
) {
  return (
    event.status === "active" &&
    occurrence.status === "reminder_ready" &&
    Number.isSafeInteger(occurrence.revision) &&
    occurrence.revision >= 1
  );
}
