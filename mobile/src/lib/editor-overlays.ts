import type { Overlay, TimelineClip } from "./types";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export const OVERLAY_API_REQUIRED =
  "This server needs the overlay update before it can save positioning, size or timing. Your changes are still here; do not publish until the server is updated.";

export function overlayCoordinates(layer: Overlay) {
  return {
    x: layer.x ?? 0.5,
    y:
      layer.y ??
      (layer.position === "top"
        ? 0.12
        : layer.position === "bottom"
          ? 0.8
          : 0.5),
  };
}

/** Shared with render_services: explicit lines, Unicode code points, no font guess. */
export function customOverlayText(text: string, scale = 1) {
  const columns = Math.max(1, Math.floor(15 / scale));
  return text
    .split("\n")
    .map((paragraph) => {
      const clean = paragraph
        .replace(/[^\S\n]+/gu, " ")
        .replace(/\p{C}/gu, "")
        .trim();
      if (!clean) return "";
      const lines: string[] = [];
      let line: string[] = [];
      for (const word of clean.split(" ")) {
        let points = Array.from(word);
        if (line.length && line.length + 1 + points.length > columns) {
          lines.push(line.join(""));
          line = [];
        }
        while (points.length > columns) {
          lines.push(points.slice(0, columns).join(""));
          points = points.slice(columns);
        }
        if (points.length)
          line = line.length ? [...line, " ", ...points] : points;
      }
      if (line.length) lines.push(line.join(""));
      return lines.join("\n");
    })
    .join("\n");
}

/** UI handles are bounded to this edit; saved intervals remain output-relative. */
export function overlayTimeRange(layer: Overlay, duration: number) {
  const length = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const start = clamp(layer.start ?? 0, 0, length);
  return { start, end: clamp(layer.end ?? length, start, length) };
}

export function overlayVisibleAt(layer: Overlay, time: number) {
  return (
    Number.isFinite(time) &&
    time >= (layer.start ?? 0) &&
    (layer.end == null || time < layer.end)
  );
}

/** Keep legacy anchors pixel-identical; custom positions clamp the whole box. */
export function overlayBox(
  layer: Overlay,
  frame: { width: number; height: number },
  measured: { width: number; height: number },
) {
  const width = Math.max(0, Math.min(frame.width, measured.width));
  const height = Math.max(0, Math.min(frame.height, measured.height));
  const custom = layer.x != null && layer.y != null;
  const padding = frame.width / 90;
  return {
    x: custom
      ? clamp(layer.x! * frame.width - width / 2, 0, frame.width - width)
      : (frame.width - width) / 2,
    y: custom
      ? clamp(layer.y! * frame.height - height / 2, 0, frame.height - height)
      : layer.position === "top"
        ? frame.height * 0.12 - padding
        : layer.position === "bottom"
          ? frame.height * 0.8 + padding - height
          : (frame.height - height) / 2,
    width,
    height,
  };
}

export function hasAdvancedOverlays(overlays: readonly Overlay[]) {
  return overlays.some((layer) =>
    [layer.x, layer.y, layer.scale, layer.start, layer.end].some(
      (value) => value != null,
    ),
  );
}

export function overlayLayoutSupported(config: unknown): boolean {
  const layout = (config as { overlay_layout?: Record<string, unknown> } | null)
    ?.overlay_layout;
  return (
    !!layout &&
    layout.version === 1 &&
    layout.coordinates === "normalized_media_center" &&
    layout.timing === "output" &&
    layout.interval === "half_open" &&
    layout.scale_min === 0.5 &&
    layout.scale_max === 2 &&
    layout.max_overlays === 8
  );
}

export function validateOverlays(overlays: readonly Overlay[]) {
  if (overlays.length > 8) throw new Error("Use up to eight text layers.");
  for (const layer of overlays) {
    if ((layer.x != null) !== (layer.y != null))
      throw new Error("Set both text coordinates together.");
    for (const value of [layer.x, layer.y])
      if (value != null && (!Number.isFinite(value) || value < 0 || value > 1))
        throw new Error("Keep text positions inside the media.");
    if (
      layer.scale != null &&
      (!Number.isFinite(layer.scale) || layer.scale < 0.5 || layer.scale > 2)
    )
      throw new Error("Text size must be between 50% and 200%.");
    const start = layer.start ?? 0;
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      start > 86400 ||
      (layer.end != null &&
        (!Number.isFinite(layer.end) ||
          layer.end <= start ||
          layer.end > 86400))
    )
      throw new Error("Text timing needs a valid start and a later end.");
  }
}

export function overlayClipRange(
  clips: readonly TimelineClip[],
  id: string | null,
) {
  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const end = start + (clip.end - clip.start) / (clip.speed ?? 1);
    if (clip.id === id) return { start, end, label: `Clip ${index + 1}` };
    start = end;
  }
  return null;
}
