import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Overlay } from "../lib/types";
import { color, font } from "../theme";

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
        .filter((layer) => layer.text.trim())
        .map((layer) => (
          <OverlayLayer
            key={layer.id}
            layer={layer}
            width={frame.width}
            height={frame.height}
            padding={padding}
            selected={selectedId === layer.id}
            onSelect={onSelect}
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
}: {
  layer: Overlay;
  width: number;
  height: number;
  padding: number;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const fontSize = width / 19;
  const [measuredHeight, setMeasuredHeight] = useState(
    fontSize * 1.15 + padding * 2,
  );
  const position =
    layer.position === "top"
      ? { top: height * 0.12 - padding }
      : layer.position === "bottom"
        ? { bottom: height * 0.2 - padding }
        : { top: (height - measuredHeight) / 2 };
  const theme = themes[layer.theme];
  return (
    <View
      pointerEvents="box-none"
      style={[
        { position: "absolute", left: 0, right: 0, alignItems: "center" },
        position,
      ]}
    >
      <Pressable
        accessibilityRole={onSelect ? "button" : "text"}
        accessibilityLabel={
          onSelect ? `Edit overlay: ${layer.text}` : layer.text
        }
        accessibilityState={onSelect ? { selected } : undefined}
        pointerEvents={onSelect ? "auto" : "none"}
        disabled={!onSelect}
        onPress={() => onSelect?.(layer.id)}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height;
          setMeasuredHeight((previous) =>
            Math.abs(previous - next) >= 0.5 ? next : previous,
          );
        }}
        style={{
          maxWidth: "90%",
          alignSelf: "center",
          padding,
          backgroundColor: theme.backgroundColor,
        }}
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
          {layer.text}
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
    </View>
  );
}
