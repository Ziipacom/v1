import type { Caption, Item, TimelineClip } from "./types";

/** Preserve full cue tracks and retime legacy source cues when a first cut is made. */
export function editorCaptions(
  existing: Item | undefined,
  text: string,
  clips: TimelineClip[],
  timelineEdited: boolean,
  fallback: Caption[],
): Caption[] {
  const changed = text !== (existing?.captions?.[0]?.text || "");
  if (!timelineEdited)
    return !changed && existing?.captions?.length
      ? existing.captions
      : fallback;
  const duration = clips.reduce(
    (total, clip) => total + (clip.end - clip.start) / (clip.speed || 1),
    0,
  );
  if (changed || !existing?.captions?.length)
    return text.trim() && duration > 0
      ? [{ start: 0, end: duration, text: text.trim() }]
      : [];
  let oldOffset = 0;
  const prior = existing.timeline?.clips.map((clip) => {
    const offset = oldOffset;
    oldOffset += (clip.end - clip.start) / (clip.speed || 1);
    return { clip, offset };
  });
  let offset = 0;
  return clips.flatMap((clip) => {
    const speed = clip.speed || 1;
    const origin =
      prior?.find((region) => region.clip.id === clip.id) ||
      prior?.find(
        (region) =>
          clip.start >= region.clip.start && clip.end <= region.clip.end,
      );
    const sourceCues = !prior
      ? existing.captions!
      : !origin
        ? []
        : existing.captions!.flatMap((cue) => {
            const speed = origin.clip.speed || 1;
            const start = Math.max(cue.start, origin.offset);
            const end = Math.min(
              cue.end,
              origin.offset + (origin.clip.end - origin.clip.start) / speed,
            );
            return end > start
              ? [
                  {
                    ...cue,
                    start: origin.clip.start + (start - origin.offset) * speed,
                    end: origin.clip.start + (end - origin.offset) * speed,
                  },
                ]
              : [];
          });
    const cues = sourceCues.flatMap((cue) => {
      const start = Math.max(cue.start, clip.start),
        end = Math.min(cue.end, clip.end);
      return end > start
        ? [
            {
              ...cue,
              start: offset + (start - clip.start) / speed,
              end: offset + (end - clip.start) / speed,
            },
          ]
        : [];
    });
    offset += (clip.end - clip.start) / speed;
    return cues;
  });
}
