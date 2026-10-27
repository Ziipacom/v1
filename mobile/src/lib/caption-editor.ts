import type { Caption } from "./types";

export type CaptionDraft = {
  id: string;
  start: string;
  end: string;
  text: string;
};

/** Parent-held UI state only; contains no authentication credential. */
export type CaptionEditorDraftState = {
  scope: string;
  base: string;
  rows: CaptionDraft[];
};

export const MAX_CAPTION_CUES = 100;
export const MAX_SOURCE_CAPTION_SECONDS = 90;

/** Source cues use the existing server limit; unknown media duration is not guessed. */
export function captionSourceLimit(sourceDuration: number): number {
  return Number.isFinite(sourceDuration) && sourceDuration > 0
    ? Math.min(sourceDuration, MAX_SOURCE_CAPTION_SECONDS)
    : 0;
}

export function captionTimeText(seconds: number): string {
  return String(seconds);
}

/** Accept decimal seconds or a clock timestamp, never exponent/hex/empty coercion. */
export function parseCaptionTime(input: string): number {
  const value = input.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (clock) {
    const hours = Number(clock[1] || 0);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    if (minutes < 60 && seconds < 60)
      return (
        hours * 3600 + minutes * 60 + seconds + Number(`0.${clock[4] || 0}`)
      );
  }
  throw new Error(
    "Use seconds, such as 3.5, or a timestamp, such as 0:03.500.",
  );
}

export function captionDrafts(cues: readonly Caption[]): CaptionDraft[] {
  return cues.map((cue, index) => ({
    id: `caption-${index + 1}`,
    start: captionTimeText(cue.start),
    end: captionTimeText(cue.end),
    text: cue.text,
  }));
}

function draftRanges(rows: readonly CaptionDraft[], sourceDuration: number) {
  const limit = captionSourceLimit(sourceDuration);
  if (!limit)
    throw new Error(
      "Wait for the original media duration before editing timed captions.",
    );
  if (rows.length > MAX_CAPTION_CUES)
    throw new Error(`Use up to ${MAX_CAPTION_CUES} timed captions.`);
  let previousEnd = 0;
  return rows.map((row, index) => {
    let start: number;
    let end: number;
    try {
      start = parseCaptionTime(row.start);
      end = parseCaptionTime(row.end);
    } catch {
      throw new Error(
        `Caption ${index + 1}: enter a valid start and end in seconds or clock timestamps.`,
      );
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    )
      throw new Error(
        `Caption ${index + 1}: end must follow a nonnegative start.`,
      );
    if (end > limit)
      throw new Error(
        sourceDuration > MAX_SOURCE_CAPTION_SECONDS
          ? `Caption ${index + 1}: source captions currently cover only the first 90 seconds of the original media.`
          : `Caption ${index + 1}: keep its times within the original media (${captionTimeText(limit)} seconds).`,
      );
    if (start < previousEnd)
      throw new Error(
        `Caption ${index + 1}: times must follow the previous caption without overlapping.`,
      );
    previousEnd = end;
    return { start, end };
  });
}

/** Conversion is all-or-nothing: invalid drafts never replace the accepted track. */
export function applyCaptionDraft(
  rows: readonly CaptionDraft[],
  sourceDuration: number,
): Caption[] {
  const ranges = draftRanges(rows, sourceDuration);
  return rows.map((row, index) => {
    if (!row.text.trim() || row.text.length > 250)
      throw new Error(
        `Caption ${index + 1}: enter between 1 and 250 characters.`,
      );
    return { ...ranges[index], text: row.text.trim() };
  });
}

/** Insert one blank cue in the current source gap, preserving all existing draft rows. */
export function addCaptionDraft(
  rows: readonly CaptionDraft[],
  sourceTime: number,
  sourceDuration: number,
): CaptionDraft[] {
  const ranges = draftRanges(rows, sourceDuration);
  if (rows.length >= MAX_CAPTION_CUES)
    throw new Error(`Use up to ${MAX_CAPTION_CUES} timed captions.`);
  const limit = captionSourceLimit(sourceDuration);
  sourceTime = Math.round(sourceTime * 1000) / 1000;
  if (!Number.isFinite(sourceTime) || sourceTime < 0 || sourceTime >= limit)
    throw new Error(
      `Move the playhead inside the caption range, from 0 to ${captionTimeText(limit)} source seconds.`,
    );
  if (ranges.some((cue) => sourceTime >= cue.start && sourceTime < cue.end))
    throw new Error(
      "A caption already covers this source time. Move the playhead into a gap or edit that caption.",
    );
  const next = ranges.findIndex((cue) => cue.start > sourceTime);
  const end = Math.min(sourceTime + 2, next < 0 ? limit : ranges[next].start);
  if (end <= sourceTime)
    throw new Error("Choose a source time with room for a caption.");
  const ids = new Set(rows.map((row) => row.id));
  let serial = 1;
  while (ids.has(`caption-${serial}`)) serial += 1;
  const row: CaptionDraft = {
    id: `caption-${serial}`,
    start: captionTimeText(sourceTime),
    end: captionTimeText(end),
    text: "",
  };
  const result = rows.map((cue) => ({ ...cue }));
  result.splice(next < 0 ? result.length : next, 0, row);
  return result;
}
