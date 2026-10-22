import { overlayBox } from "./editor-overlays.ts";
import type { Overlay } from "./types";

type Point = { x: number; y: number };
type DragState = {
  layer: Overlay;
  width: number;
  height: number;
  measured: { width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
  onSelect?: (id: string) => void;
  onPositionChange?: (id: string, position: Point) => void;
  onInteractionStart?: () => void;
};
type Gesture = { dx: number; dy: number };

/** Attach these handlers to View, not Pressable (Pressability replaces them). */
export function overlayDragHandlers(
  read: () => DragState,
  preview: (point: Point | null) => void,
) {
  let origin: (Point & { id: string; width: number; height: number }) | null =
    null;
  const fits = (current: DragState) =>
    current.measured.width <= current.width &&
    current.measured.height <= current.height;
  const canMove = (_: unknown, gesture: Gesture) =>
    !!read().onPositionChange &&
    fits(read()) &&
    (Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3);
  const position = (gesture: Gesture) => {
    const current = read();
    if (
      !origin ||
      !current.onPositionChange ||
      !fits(current) ||
      current.layer.id !== origin.id ||
      current.width !== origin.width ||
      current.height !== origin.height
    )
      return null;
    const bounds = overlayBox(
      {
        ...current.layer,
        x: origin.x + gesture.dx / origin.width,
        y: origin.y + gesture.dy / origin.height,
      },
      current,
      current.measured,
    );
    return {
      x: (bounds.x + bounds.width / 2) / current.width,
      y: (bounds.y + bounds.height / 2) / current.height,
    };
  };
  return {
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: canMove,
    onMoveShouldSetPanResponderCapture: canMove,
    onPanResponderGrant: () => {
      const current = read();
      if (
        !current.onPositionChange ||
        !fits(current) ||
        current.width <= 0 ||
        current.height <= 0
      )
        return;
      origin = {
        id: current.layer.id,
        width: current.width,
        height: current.height,
        x: (current.box.x + current.box.width / 2) / current.width,
        y: (current.box.y + current.box.height / 2) / current.height,
      };
      current.onInteractionStart?.();
      current.onSelect?.(current.layer.id);
    },
    onPanResponderMove: (_: unknown, gesture: Gesture) => {
      const next = position(gesture);
      if (next) preview(next);
    },
    onPanResponderRelease: (_: unknown, gesture: Gesture) => {
      const next = position(gesture);
      if (next) read().onPositionChange?.(read().layer.id, next);
      origin = null;
      preview(null);
    },
    onPanResponderTerminate: () => {
      origin = null;
      preview(null);
    },
    onPanResponderTerminationRequest: () => false,
  };
}
