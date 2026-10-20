import type { TimelineClip } from "./types";
export type { TimelineClip } from "./types";
/** One source asset; clip order defines the output sequence. */
export const MIN_CLIP_SECONDS = 0.2;
export const MAX_TIMELINE_SECONDS = 90;
export const MAX_TIMELINE_CLIPS = 12;
const epsilon = 0.000001;
const round = (value: number) => Math.round(value * 1000000) / 1000000;

export function totalDuration(clips: readonly TimelineClip[]) {
  return clips.reduce(
    (total, clip) =>
      total + Math.max(0, clip.end - clip.start) / (clip.speed ?? 1),
    0,
  );
}

export function validateClips(
  clips: readonly TimelineClip[],
  sourceDuration = 86400,
) {
  if (
    !Number.isFinite(sourceDuration) ||
    sourceDuration < 0 ||
    sourceDuration > 86400
  )
    throw new Error("The source duration is unavailable or invalid.");
  if (clips.length > MAX_TIMELINE_CLIPS)
    throw new Error(`Use up to ${MAX_TIMELINE_CLIPS} clips in a sequence.`);
  const ids = new Set<string>();
  for (const clip of clips) {
    if (!clip.id || ids.has(clip.id))
      throw new Error("Each clip needs a unique identity.");
    ids.add(clip.id);
    if (
      !Number.isFinite(clip.start) ||
      !Number.isFinite(clip.end) ||
      clip.start < 0 ||
      clip.end > sourceDuration + epsilon ||
      clip.end - clip.start < MIN_CLIP_SECONDS - epsilon ||
      (clip.speed !== undefined && ![0.5, 1, 1.5, 2].includes(clip.speed))
    )
      throw new Error(
        "Keep each clip within the source and at least 0.2 seconds long.",
      );
  }
  if (totalDuration(clips) > MAX_TIMELINE_SECONDS + epsilon)
    throw new Error("Keep the sequence at or below 90 seconds.");
}

/** A cut belongs to the following clip, except the final sequence endpoint. */
export function sequenceToSource(
  clips: readonly TimelineClip[],
  sequenceTime: number,
) {
  if (!clips.length || !Number.isFinite(sequenceTime)) return null;
  const total = totalDuration(clips);
  if (!Number.isFinite(total) || total <= 0) return null;
  const time = Math.max(0, Math.min(total, sequenceTime));
  let offset = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const speed = clip.speed ?? 1;
    const length = (clip.end - clip.start) / speed;
    if (length <= 0 || !Number.isFinite(length)) return null;
    if (time < offset + length - epsilon || index === clips.length - 1)
      return {
        clip,
        index,
        sourceTime: Math.max(
          clip.start,
          Math.min(clip.end, clip.start + (time - offset) * speed),
        ),
      };
    offset += length;
  }
  return null;
}

/** A preferred clip disambiguates repeated or overlapping source regions. */
export function sourceToSequence(
  clips: readonly TimelineClip[],
  sourceTime: number,
  clipId?: string,
) {
  if (!Number.isFinite(sourceTime)) return null;
  let offset = 0;
  for (const clip of clips) {
    if (
      (!clipId || clip.id === clipId) &&
      sourceTime >= clip.start - epsilon &&
      sourceTime <= clip.end + epsilon
    )
      return (
        offset +
        Math.max(0, Math.min(clip.end - clip.start, sourceTime - clip.start)) /
          (clip.speed ?? 1)
      );
    offset += Math.max(0, clip.end - clip.start) / (clip.speed ?? 1);
  }
  return null;
}

export function trimClip(
  clips: readonly TimelineClip[],
  id: string,
  start: number,
  end: number,
  sourceDuration = 86400,
): TimelineClip[] {
  if (!clips.some((clip) => clip.id === id))
    throw new Error("Select a clip to trim.");
  const next = clips.map((clip) =>
    clip.id === id
      ? { ...clip, start: round(start), end: round(end) }
      : { ...clip },
  );
  validateClips(next, sourceDuration);
  return next;
}

export function canSplitAt(
  clips: readonly TimelineClip[],
  sequenceTime: number,
) {
  if (clips.length >= MAX_TIMELINE_CLIPS) return false;
  const position = sequenceToSource(clips, sequenceTime);
  return (
    !!position &&
    position.sourceTime - position.clip.start >= MIN_CLIP_SECONDS - epsilon &&
    position.clip.end - position.sourceTime >= MIN_CLIP_SECONDS - epsilon
  );
}

export function splitClip(
  clips: readonly TimelineClip[],
  sequenceTime: number,
  newId: string,
): TimelineClip[] {
  validateClips(clips);
  if (!newId || clips.some((clip) => clip.id === newId))
    throw new Error("The new clip needs a unique identity.");
  const position = sequenceToSource(clips, sequenceTime);
  if (!position || !canSplitAt(clips, sequenceTime))
    throw new Error(
      "Split at least 0.2 seconds from either clip edge, with fewer than 12 clips.",
    );
  const cut = round(position.sourceTime);
  const next = clips.flatMap((clip, index) =>
    index === position.index
      ? [
          { ...clip, end: cut },
          { ...clip, id: newId, start: cut },
        ]
      : [{ ...clip }],
  );
  validateClips(next);
  return next;
}

export function deleteClip(
  clips: readonly TimelineClip[],
  id: string,
): TimelineClip[] {
  return clips.filter((clip) => clip.id !== id).map((clip) => ({ ...clip }));
}

/** Handle dragging clamps the edited edge, preserving the other source edge. */
export function clampClipEdge(
  clip: TimelineClip,
  edge: "start" | "end",
  requested: number,
  sourceDuration: number,
  maxClipDuration = MAX_TIMELINE_SECONDS,
): TimelineClip {
  if (
    !Number.isFinite(requested) ||
    !Number.isFinite(sourceDuration) ||
    sourceDuration <= 0
  )
    return { ...clip };
  const maxLength = Math.max(MIN_CLIP_SECONDS, maxClipDuration);
  return edge === "start"
    ? {
        ...clip,
        start: round(
          Math.max(
            0,
            clip.end - maxLength,
            Math.min(clip.end - MIN_CLIP_SECONDS, requested),
          ),
        ),
      }
    : {
        ...clip,
        end: round(
          Math.min(
            sourceDuration,
            clip.start + maxLength,
            Math.max(clip.start + MIN_CLIP_SECONDS, requested),
          ),
        ),
      };
}

export function formatTimelineTime(seconds: number) {
  const tenths = Math.max(
    0,
    Math.round((Number.isFinite(seconds) ? seconds : 0) * 10),
  );
  const minutes = Math.floor(tenths / 600);
  const remaining = (tenths % 600) / 10;
  return `${minutes}:${remaining.toFixed(1).padStart(4, "0")}`;
}
