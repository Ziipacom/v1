import type { Caption, TimelineClip } from "./types";

/** Recognition returns source timestamps. Never guess timing from plain text. */
export function validateCaptionCues(value: unknown, maxSeconds = 90): Caption[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Caption recognition returned an invalid track.");
  let previous = 0;
  return value.map((cue) => {
    if (!cue || typeof cue !== "object" ||
        typeof cue.start !== "number" || typeof cue.end !== "number" ||
        !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < previous || cue.end <= cue.start || cue.end > maxSeconds ||
        typeof cue.text !== "string" || !cue.text.trim() || cue.text.length > 250)
      throw new Error("Review caption words and timing before applying.");
    previous = cue.end;
    return { start: cue.start, end: cue.end, text: cue.text.trim() };
  });
}

/** Apply cuts, reorder and speed to accepted source cues, without altering them. */
export function sourceCaptionsForEdit(cues: Caption[], clips?: TimelineClip[]): Caption[] {
  validateCaptionCues(cues);
  if (!clips) return cues.map((cue) => ({ ...cue }));
  let offset = 0;
  const result = clips.flatMap((clip) => {
    const speed = clip.speed || 1;
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) ||
        clip.start < 0 || clip.end <= clip.start || ![0.5, 1, 1.5, 2].includes(speed))
      throw new Error("Review your timeline before applying captions.");
    const track = cues.flatMap((cue) => {
      const start = Math.max(clip.start, cue.start), end = Math.min(clip.end, cue.end);
      return end > start ? [{
        text: cue.text,
        start: offset + (start - clip.start) / speed,
        end: offset + (end - clip.start) / speed,
      }] : [];
    });
    offset += (clip.end - clip.start) / speed;
    return track;
  });
  if (result.length > 100) throw new Error("Use up to 100 captions in the edited sequence.");
  return result;
}
