import { Pressable, Text, TextInput, View } from "react-native";
import type { ReactNode } from "react";
import { Image, type ImageSource } from "expo-image";
import {
  Trash2,
  Type,
  Captions,
  Sparkles,
  ArrowUp,
  AlignCenter,
  ArrowDown,
} from "lucide-react-native";
import { color, font, styles } from "../theme";
import type { Overlay, VisualEffect } from "../lib/types";
import { effectFilter } from "./editor-preview";

export const overlayAppearance = (theme: Overlay["theme"]) => ({
  color: theme === "light" ? "#160F20" : theme === "lime" ? "#132000" : "white",
  backgroundColor: {
    light: "#FFFFFFE8",
    dark: "#09060EDB",
    purple: "#5420ABE8",
    lime: "#A6E21BE8",
  }[theme],
});
const templates: {
  title: string;
  text: string;
  theme: Overlay["theme"];
  position: Overlay["position"];
}[] = [
  { title: "Title", text: "YOUR STORY", theme: "light", position: "center" },
  {
    title: "Lower third",
    text: "Your name · Creator",
    theme: "dark",
    position: "bottom",
  },
  {
    title: "Call to action",
    text: "WATCH NEXT >",
    theme: "lime",
    position: "bottom",
  },
  { title: "Episode", text: "EPISODE 01", theme: "purple", position: "top" },
  { title: "Live badge", text: "LIVE NOW", theme: "purple", position: "top" },
  {
    title: "Quote",
    text: "Make something worth sharing.",
    theme: "dark",
    position: "center",
  },
];
const effects: { id: VisualEffect; title: string; bg: string }[] = [
  { id: "none", title: "Original", bg: "#747F9B" },
  { id: "vivid", title: "Vivid", bg: "#8E37CF" },
  { id: "mono", title: "Mono", bg: "#808080" },
  { id: "warm", title: "Warm", bg: "#C2835E" },
  { id: "cool", title: "Cool", bg: "#6494BD" },
  { id: "fade", title: "Fade", bg: "#A79BBA" },
  { id: "cinema", title: "Cinema", bg: "#44565E" },
];
export function EditorOverlays({
  overlays,
  selectedId,
  effect,
  caption,
  sourceCover,
  disabled,
  onChange,
  onSelect,
  onEffect,
  onCaption,
  captionTools,
}: {
  overlays: Overlay[];
  selectedId: string | null;
  effect: VisualEffect;
  caption: string;
  sourceCover?: ImageSource;
  disabled: boolean;
  onChange: (overlays: Overlay[]) => void;
  onSelect: (id: string | null) => void;
  onEffect: (effect: VisualEffect) => void;
  onCaption: (value: string) => void;
  captionTools?: ReactNode;
}) {
  const selected = overlays.find((layer) => layer.id === selectedId);
  function add(template: (typeof templates)[number]) {
    if (overlays.length >= 8 || disabled) return;
    const id = `layer-${Date.now()}-${overlays.length}`;
    onChange([
      ...overlays,
      {
        id,
        text: template.text,
        theme: template.theme,
        position: template.position,
      },
    ]);
    onSelect(id);
  }
  function update(patch: Partial<Overlay>) {
    if (selected)
      onChange(
        overlays.map((layer) =>
          layer.id === selected.id ? { ...layer, ...patch } : layer,
        ),
      );
  }
  return (
    <View style={{ gap: 18 }}>
      <View style={styles.row}>
        <Type color={color.lime} size={18} />
        <Text style={[styles.label, { flex: 1 }]}>Text & title templates</Text>
        <Text style={styles.small}>{overlays.length}/8 layers</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {templates.map((template) => (
          <Pressable
            key={template.title}
            accessibilityRole="button"
            accessibilityLabel={`Add ${template.title} overlay`}
            disabled={disabled || overlays.length >= 8}
            onPress={() => add(template)}
            style={{
              width: "31%",
              minWidth: 82,
              minHeight: 76,
              borderWidth: 1,
              borderColor: color.border,
              borderRadius: 9,
              padding: 8,
              gap: 9,
              justifyContent: "center",
              opacity: overlays.length >= 8 ? 0.4 : 1,
            }}
          >
            <Text
              numberOfLines={1}
              style={[
                {
                  alignSelf: "center",
                  fontFamily: font.semibold,
                  fontSize: 11,
                  padding: 5,
                  borderRadius: 3,
                },
                overlayAppearance(template.theme),
              ]}
            >
              {template.text}
            </Text>
            <Text
              style={{
                color: color.muted,
                textAlign: "center",
                fontFamily: font.regular,
                fontSize: 11,
              }}
            >
              {template.title}
            </Text>
          </Pressable>
        ))}
      </View>
      {!!overlays.length && (
        <View style={{ gap: 8 }}>
          {overlays.map((layer, i) => (
            <Pressable
              key={layer.id}
              accessibilityRole="button"
              accessibilityLabel={`Select text layer ${i + 1}: ${layer.text}`}
              accessibilityState={{ selected: selectedId === layer.id }}
              onPress={() => onSelect(layer.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                borderWidth: 1,
                borderColor:
                  selectedId === layer.id ? color.lime : color.border,
                borderRadius: 7,
                padding: 9,
                backgroundColor: color.panel,
              }}
            >
              <Type color={color.muted} size={14} />
              <Text
                numberOfLines={1}
                style={{ color: "white", flex: 1, fontSize: 12 }}
              >
                {layer.text || "Empty text"}
              </Text>
              <Text style={styles.small}>{layer.position}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {selected && (
        <View
          style={{
            padding: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: color.border,
            gap: 12,
          }}
        >
          <TextInput
            accessibilityLabel="Selected overlay text"
            value={selected.text}
            onChangeText={(text) => update({ text })}
            maxLength={120}
            editable={!disabled}
            multiline
            style={{
              color: color.text,
              fontSize: 18,
              fontFamily: font.semibold,
              minHeight: 55,
              padding: 8,
              backgroundColor: color.bg,
              borderRadius: 7,
            }}
          />
          <View style={[styles.between, { gap: 10 }]}>
            <View style={{ flexDirection: "row", gap: 5 }}>
              {(["top", "center", "bottom"] as const).map((position, i) => {
                const Icon = [ArrowUp, AlignCenter, ArrowDown][i];
                return (
                  <Pressable
                    key={position}
                    accessibilityRole="button"
                    accessibilityLabel={`Place text ${position}`}
                    accessibilityState={{
                      selected: selected.position === position,
                    }}
                    onPress={() => update({ position })}
                    disabled={disabled}
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      backgroundColor:
                        selected.position === position
                          ? color.purple
                          : color.panel,
                    }}
                  >
                    <Icon color="white" size={17} />
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: "row", gap: 7 }}>
              {(["purple", "dark", "light", "lime"] as const).map((theme) => (
                <Pressable
                  key={theme}
                  accessibilityRole="button"
                  accessibilityLabel={`${theme} text style`}
                  accessibilityState={{ selected: selected.theme === theme }}
                  onPress={() => update({ theme })}
                  disabled={disabled}
                  style={{
                    width: 27,
                    height: 27,
                    borderRadius: 14,
                    borderWidth: 2,
                    borderColor: selected.theme === theme ? "white" : "#554560",
                    backgroundColor: overlayAppearance(theme).backgroundColor,
                  }}
                />
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete selected text layer"
              onPress={() => {
                onChange(overlays.filter((layer) => layer.id !== selected.id));
                onSelect(null);
              }}
              disabled={disabled}
              style={{ padding: 8 }}
            >
              <Trash2 color="#FF7C95" size={18} />
            </Pressable>
          </View>
        </View>
      )}
      {captionTools || <View style={styles.row}>
        <Captions color={color.lime} size={18} />
        <Text style={styles.label}>Caption track</Text>
      </View>}
      <Text style={[styles.small, { fontSize: 11 }]}>Manual caption · replaces the timed track when edited</Text>
      <TextInput
        accessibilityLabel="Caption text"
        placeholder="Add a caption to your edit…"
        placeholderTextColor={color.faint}
        value={caption}
        onChangeText={onCaption}
        maxLength={250}
        editable={!disabled}
        multiline
        style={{
          color: color.text,
          fontFamily: font.regular,
          minHeight: 68,
          padding: 12,
          backgroundColor: color.panel,
          borderWidth: 1,
          borderColor: color.border,
          borderRadius: 9,
        }}
      />
      <View style={styles.row}>
        <Sparkles color={color.lime} size={18} />
        <Text style={styles.label}>Color effects</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {effects.map((preset) => (
          <Pressable
            key={preset.id}
            accessibilityRole="button"
            accessibilityLabel={`${preset.title} effect`}
            accessibilityState={{ selected: effect === preset.id }}
            onPress={() => onEffect(preset.id)}
            disabled={disabled}
            style={{ width: "22%", minWidth: 66, gap: 5 }}
          >
            <View
              style={{
                height: 58,
                backgroundColor: preset.bg,
                borderWidth: 2,
                borderColor: effect === preset.id ? color.lime : "transparent",
                borderRadius: 8,
                overflow: "hidden",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              {sourceCover ? (
                <Image
                  source={sourceCover}
                  style={
                    {
                      width: "100%",
                      height: "100%",
                      filter: effectFilter(preset.id),
                    } as never
                  }
                  contentFit="cover"
                />
              ) : (
                <Sparkles color="white" size={20} />
              )}
            </View>
            <Text
              style={{
                textAlign: "center",
                color: effect === preset.id ? color.lime : color.muted,
                fontFamily: font.medium,
                fontSize: 11,
              }}
            >
              {preset.title}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={[styles.small, { fontSize: 11 }]}>
        Text stays editable. Color effects are applied to the saved export;
        native color previews may vary by device.
      </Text>
    </View>
  );
}
