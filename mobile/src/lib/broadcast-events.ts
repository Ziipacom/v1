import type { CalendarEvent, CalendarOccurrence } from "./calendar-types";

/** Saved stream events only; preparing a broadcast is not a scheduled event. */
export function upcomingBroadcastEvents(
  events: CalendarEvent[],
  now = Date.now(),
) {
  return events
    .flatMap((event) =>
      event.kind === "stream" && event.status === "active"
        ? event.occurrences.flatMap((occurrence) => {
            const starts = Date.parse(occurrence.starts_at);
            return Number.isFinite(starts) &&
              starts >= now &&
              !["cancelled", "missed"].includes(occurrence.status)
              ? [{ event, occurrence }]
              : [];
          })
        : [],
    )
    .sort(
      (a, b) =>
        Date.parse(a.occurrence.starts_at) - Date.parse(b.occurrence.starts_at),
    )
    .slice(0, 24) as { event: CalendarEvent; occurrence: CalendarOccurrence }[];
}
