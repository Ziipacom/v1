import { useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import type { Overlay } from "../lib/types";
import { color, font } from "../theme";
import {
  customOverlayText,
  overlayBox,
  overlayVisibleAt,
} from "../lib/editor-overlays";
import { overlayDragHandlers } from "../lib/overlay-gestures";

export type EditorCanvasFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type EditorCanvasLayersProps = {
  frame: EditorCanvasFrame;
  overlays: readonly Overlay[];
  caption?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  time?: number;
  onPositionChange?: (id: string, position: { x: number; y: number }) => void;
  onInteractionStart?: () => void;
};

const themes = {
  light: { color: "#000000", backgroundColor: "rgba(255,255,255,0.9)" },
  dark: { color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.75)" },
  purple: { color: "#FFFFFF", backgroundColor: "rgba(84,36,175,0.9)" },
  lime: { color: "#000000", backgroundColor: "rgba(164,233,0,0.95)" },
} as const;

/** These coordinates belong to the contained media, never the letterbox pane. */
export function EditorCanvasLayers({
  frame,
  overlays,
  caption,
  selectedId,
  onSelect,
  time = 0,
  onPositionChange,
  onInteractionStart,
}: EditorCanvasLayersProps) {
  if (
    ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    return null;
  const padding = Math.max(1, frame.width / 90);
  const captionPadding = Math.max(1, frame.width / 135);
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        overflow: "hidden",
      }}
    >
      {overlays
        .filter((layer) => layer.text.trim() && overlayVisibleAt(layer, time))
        .map((layer) => (
          <OverlayLayer
            key={layer.id}
            layer={layer}
            width={frame.width}
            height={frame.height}
            padding={padding}
            selected={selectedId === layer.id}
            onSelect={onSelect}
            onPositionChange={onPositionChange}
            onInteractionStart={onInteractionStart}
          />
        ))}
      {!!caption?.trim() && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: frame.height * 0.09 - captionPadding,
            alignItems: "center",
          }}
        >
          <View
            style={{
              maxWidth: "90%",
              alignSelf: "center",
              backgroundColor: "rgba(0,0,0,0.7)",
              padding: captionPadding,
            }}
          >
            <Text
              style={{
                color: "white",
                fontFamily: font.regular,
                fontSize: frame.width / 23,
                lineHeight: (frame.width / 23) * 1.15,
                textAlign: "center",
                includeFontPadding: false,
              }}
            >
              {caption}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

function OverlayLayer({
  layer,
  width,
  height,
  padding,
  selected,
  onSelect,
  onPositionChange,
  onInteractionStart,
}: {
  layer: Overlay;
  width: number;
  height: number;
  padding: number;
  selected: boolean;
  onSelect?: (id: string) => void;
  onPositionChange?: EditorCanvasLayersProps["onPositionChange"];
  onInteractionStart?: () => void;
}) {
  const fontSize = (width / 19) * (layer.scale ?? 1);
  const [measured, setMeasured] = useState({
    width: 0,
    height: fontSize * 1.15 + padding * 2,
  });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const activeLayer = drag ? { ...layer, ...drag } : layer;
  const box = overlayBox(activeLayer, { width, height }, measured);
  const latest = useRef({
    layer,
    width,
    height,
    measured,
    box,
    onSelect,
    onPositionChange,
    onInteractionStart,
  });
  latest.current = {
    layer,
    width,
    height,
    measured,
    box,
    onSelect,
    onPositionChange,
    onInteractionStart,
  };
  const responder = useMemo(
    () =>
      PanResponder.create(overlayDragHandlers(() => latest.current, setDrag)),
    [],
  );
  const theme = themes[layer.theme];
  return (
    <View
      {...responder.panHandlers}
      pointerEvents="box-none"
      style={[
        { position: "absolute", left: 0, right: 0, alignItems: "center" },
        { top: box.y },
      ]}
    >
      <Pressable
        accessibilityRole={onSelect ? "button" : "text"}
        accessibilityLabel={
          onSelect ? `Edit overlay: ${layer.text}` : layer.text
        }
        accessibilityState={onSelect ? { selected } : undefined}
        accessibilityHint={
          onPositionChange
            ? "Drag to move this text. Position buttons are also available below."
            : undefined
        }
        pointerEvents={onSelect ? "auto" : "none"}
        disabled={!onSelect}
        onPress={() => onSelect?.(layer.id)}
        onLayout={(event) => {
          const { width: nextWidth, height: nextHeight } =
            event.nativeEvent.layout;
          setMeasured((previous) =>
            Math.abs(previous.width - nextWidth) >= 0.5 ||
            Math.abs(previous.height - nextHeight) >= 0.5
              ? { width: nextWidth, height: nextHeight }
              : previous,
          );
        }}
        style={[
          {
            maxWidth: "90%",
            alignSelf: "center",
            padding,
            backgroundColor: theme.backgroundColor,
            transform: [{ translateX: box.x + box.width / 2 - width / 2 }],
          },
          Platform.OS === "web" && onPositionChange
            ? // RN Web supports these DOM-only CSS properties.
              ({ touchAction: "none", cursor: "move" } as unknown as ViewStyle)
            : null,
        ]}
      >
        <Text
          style={{
            color: theme.color,
            fontFamily: font.semibold,
            fontSize,
            lineHeight: fontSize * 1.15,
            textAlign: "center",
            includeFontPadding: false,
          }}
        >
          {layer.x != null && layer.y != null
            ? customOverlayText(layer.text, layer.scale ?? 1)
            : layer.text}
        </Text>
        {selected && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { borderWidth: 1, borderColor: color.lime },
            ]}
          />
        )}
      </Pressable>
      {selected && measured.height > height && (
        <Text
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            color: "white",
            backgroundColor: "#8D173CEB",
            padding: 6,
            fontSize: 12,
          }}
        >
          Text exceeds this canvas. Reduce its size or shorten it before
          exporting.
        </Text>
      )}
    </View>
  );
}
