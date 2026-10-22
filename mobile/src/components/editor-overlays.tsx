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
  Copy,
  Move,
  Clock3,
  Play,
  RefreshCw,
} from "lucide-react-native";
import { color, font, styles } from "../theme";
import type { Overlay, VisualEffect } from "../lib/types";
import { effectFilter } from "./editor-preview";
import { formatTimelineTime } from "../lib/editor-timeline";
import { overlayCoordinates, overlayTimeRange } from "../lib/editor-overlays";
import { OverlaySlider } from "./editor-overlay-controls";

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
  time = 0,
  duration = 0,
  selectedClipRange,
  onSeek,
  advancedSupported = false,
  advancedStatus,
  onRefreshCapabilities,
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
  /** Current time and bounds in the edited output, not original source time. */
  time?: number;
  duration?: number;
  selectedClipRange?: { start: number; end: number; label?: string } | null;
  onSeek?: (time: number) => void;
  advancedSupported?: boolean;
  advancedStatus?: "checking" | "unavailable" | "unsupported" | "ready";
  onRefreshCapabilities?: () => void;
}) {
  const selected = overlays.find((layer) => layer.id === selectedId);
  const measuredDuration =
    Number.isFinite(duration) && duration > 0 ? duration : 0;
  const playhead = Math.max(
    0,
    Math.min(measuredDuration, Number.isFinite(time) ? time : 0),
  );
  const range = selected
    ? overlayTimeRange(selected, measuredDuration)
    : { start: 0, end: measuredDuration };
  const coordinates = selected
    ? overlayCoordinates(selected)
    : { x: 0.5, y: 0.5 };
  const timed = !!selected && (selected.start != null || selected.end != null);
  const timingDisabled = disabled || !advancedSupported || !measuredDuration;
  const minSpan = Math.min(0.1, measuredDuration);
  const activeAtPlayhead = playhead >= range.start && playhead < range.end;
  const capabilityStatus =
    advancedStatus ?? (advancedSupported ? "ready" : "unavailable");
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
    if (selected && !disabled)
      onChange(
        overlays.map((layer) =>
          layer.id === selected.id ? { ...layer, ...patch } : layer,
        ),
      );
  }
  function updateTiming(edge: "start" | "end", value: number) {
    if (timingDisabled || !selected) return;
    const start =
      edge === "start"
        ? Math.max(0, Math.min(range.end - minSpan, value))
        : range.start;
    const end =
      edge === "end"
        ? Math.min(measuredDuration, Math.max(range.start + minSpan, value))
        : range.end;
    update({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
  }
  const chipStyle = (active = false, muted = false) => ({
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexDirection: "row" as const,
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: active ? color.purple : color.border,
    backgroundColor: active ? color.purple : color.panel,
    opacity: muted ? 0.4 : 1,
  });
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
                minHeight: 48,
                backgroundColor: color.panel,
              }}
            >
              <Type color={color.muted} size={14} />
              <Text
                numberOfLines={1}
                style={{ color: color.text, flex: 1, fontSize: 12 }}
              >
                {layer.text || "Empty text"}
              </Text>
              <Text style={[styles.small, { fontSize: 11 }]}>
                {layer.start != null || layer.end != null
                  ? `${formatTimelineTime(overlayTimeRange(layer, measuredDuration).start)}–${formatTimelineTime(overlayTimeRange(layer, measuredDuration).end)}`
                  : "Entire edit"}
              </Text>
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
          <View style={[styles.between, { gap: 10, flexWrap: "wrap" }]}>
            <View style={{ flexDirection: "row", gap: 5 }}>
              {(["top", "center", "bottom"] as const).map((position, i) => {
                const Icon = [ArrowUp, AlignCenter, ArrowDown][i];
                return (
                  <Pressable
                    key={position}
                    accessibilityRole="button"
                    accessibilityLabel={`Place text ${position}`}
                    accessibilityState={{
                      selected:
                        selected.position === position &&
                        selected.x == null &&
                        selected.y == null,
                    }}
                    onPress={() =>
                      update({ position, x: undefined, y: undefined })
                    }
                    disabled={disabled}
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 6,
                      backgroundColor:
                        selected.position === position &&
                        selected.x == null &&
                        selected.y == null
                          ? color.purple
                          : color.panel,
                    }}
                  >
                    <Icon
                      color={
                        selected.position === position &&
                        selected.x == null &&
                        selected.y == null
                          ? "white"
                          : color.text
                      }
                      size={17}
                    />
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
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor:
                      selected.theme === theme ? color.lime : color.border,
                  }}
                >
                  <View
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: color.border,
                      backgroundColor: overlayAppearance(theme).backgroundColor,
                    }}
                  />
                </Pressable>
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
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Trash2 color="#FF7C95" size={18} />
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Duplicate selected text layer"
              disabled={
                disabled ||
                overlays.length >= 8 ||
                (!advancedSupported &&
                  (selected.x != null ||
                    selected.y != null ||
                    selected.scale != null ||
                    timed))
              }
              onPress={() => {
                if (
                  disabled ||
                  overlays.length >= 8 ||
                  (!advancedSupported &&
                    (selected.x != null ||
                      selected.y != null ||
                      selected.scale != null ||
                      timed))
                )
                  return;
                const id = `layer-${Date.now()}-${overlays.length}`;
                onChange([...overlays, { ...selected, id }]);
                onSelect(id);
              }}
              style={chipStyle(false, disabled || overlays.length >= 8)}
            >
              <Copy color={color.text} size={15} />
              <Text
                style={{
                  color: color.text,
                  fontFamily: font.medium,
                  fontSize: 12,
                }}
              >
                Duplicate layer
              </Text>
            </Pressable>
            {onSeek && measuredDuration > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Preview the beginning of this text layer"
                disabled={disabled}
                onPress={() => onSeek(range.start)}
                style={chipStyle(false, disabled)}
              >
                <Play color={color.text} size={15} />
                <Text
                  style={{
                    color: color.text,
                    fontFamily: font.medium,
                    fontSize: 12,
                  }}
                >
                  Preview layer
                </Text>
              </Pressable>
            )}
          </View>
          {!advancedSupported && (
            <View style={{ gap: 8 }}>
              <Text accessibilityLiveRegion="polite" style={styles.small}>
                {capabilityStatus === "checking"
                  ? "Checking Ziipa’s support for free positioning, size and timed layers…"
                  : capabilityStatus === "unsupported"
                    ? "This Ziipa server needs an update before it can save free positioning, size and timed layers. Existing layer data is kept."
                    : "Couldn’t check Ziipa’s overlay support. Check your connection and refresh the status. Existing layer data is kept; advanced controls stay off until support is confirmed."}
              </Text>
              {onRefreshCapabilities && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh overlay support status"
                  accessibilityState={{
                    disabled: capabilityStatus === "checking",
                    busy: capabilityStatus === "checking",
                  }}
                  disabled={capabilityStatus === "checking"}
                  onPress={() => {
                    if (capabilityStatus !== "checking")
                      onRefreshCapabilities();
                  }}
                  style={[
                    chipStyle(false, capabilityStatus === "checking"),
                    { alignSelf: "flex-start" },
                  ]}
                >
                  <RefreshCw color={color.text} size={15} />
                  <Text
                    style={{
                      color: color.text,
                      fontFamily: font.medium,
                      fontSize: 12,
                    }}
                  >
                    Refresh status
                  </Text>
                </Pressable>
              )}
            </View>
          )}
          <View
            style={{
              gap: 9,
              borderTopWidth: 1,
              borderTopColor: color.border,
              paddingTop: 12,
            }}
          >
            <View style={styles.row}>
              <Move color={color.lime} size={17} />
              <Text
                style={{
                  color: color.text,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                Position & size
              </Text>
            </View>
            <Text style={[styles.small, { fontSize: 12 }]}>
              Drag the selected text on the video to place it anywhere. Use the
              grid for quick alignment.
            </Text>
            <View
              style={{
                alignSelf: "center",
                width: 166,
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 5,
              }}
            >
              {[0.14, 0.5, 0.86].flatMap((y, row) =>
                [0.14, 0.5, 0.86].map((x, column) => {
                  const active =
                    Math.abs(coordinates.x - x) < 0.02 &&
                    Math.abs(coordinates.y - y) < 0.02;
                  const label = `${["Top", "Middle", "Bottom"][row]} ${["left", "center", "right"][column]}`;
                  return (
                    <Pressable
                      key={`${row}-${column}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Align text ${label.toLowerCase()}`}
                      accessibilityState={{
                        selected: active,
                        disabled: disabled || !advancedSupported,
                      }}
                      disabled={disabled || !advancedSupported}
                      onPress={() => advancedSupported && update({ x, y })}
                      style={{
                        ...chipStyle(active, disabled || !advancedSupported),
                        width: 52,
                        height: 44,
                        paddingHorizontal: 0,
                      }}
                    >
                      <View
                        style={{
                          width: 10,
                          height: 4,
                          borderRadius: 2,
                          backgroundColor: active ? "white" : color.muted,
                        }}
                      />
                    </Pressable>
                  );
                }),
              )}
            </View>
            <OverlaySlider
              key={`${selected.id}-size`}
              label="Text size"
              value={selected.scale ?? 1}
              min={0.5}
              max={2}
              step={0.05}
              disabled={disabled || !advancedSupported}
              valueText={`${Math.round((selected.scale ?? 1) * 100)}%`}
              formatValue={(scale) => `${Math.round(scale * 100)}%`}
              onChange={(scale) => advancedSupported && update({ scale })}
            />
          </View>
          <View
            style={{
              gap: 9,
              borderTopWidth: 1,
              borderTopColor: color.border,
              paddingTop: 12,
            }}
          >
            <View style={styles.row}>
              <Clock3 color={color.lime} size={17} />
              <Text
                style={{
                  color: color.text,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                When text appears
              </Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show text for the entire edit"
                accessibilityState={{
                  selected: !timed,
                  disabled: timingDisabled,
                }}
                disabled={timingDisabled}
                onPress={() =>
                  !timingDisabled &&
                  update({ start: undefined, end: undefined })
                }
                style={chipStyle(!timed, timingDisabled)}
              >
                <Text
                  style={{
                    color: !timed ? "white" : color.text,
                    fontFamily: font.medium,
                    fontSize: 12,
                  }}
                >
                  Entire edit
                </Text>
              </Pressable>
              {!!selectedClipRange && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Set text timing to the selected clip's current edited time range"
                  disabled={
                    timingDisabled ||
                    selectedClipRange.end <= selectedClipRange.start
                  }
                  onPress={() => {
                    if (timingDisabled) return;
                    const start = Math.max(
                      0,
                      Math.min(measuredDuration, selectedClipRange.start),
                    );
                    const end = Math.max(
                      start,
                      Math.min(measuredDuration, selectedClipRange.end),
                    );
                    if (end > start) update({ start, end });
                  }}
                  style={chipStyle(false, timingDisabled)}
                >
                  <Text
                    style={{
                      color: color.text,
                      fontFamily: font.medium,
                      fontSize: 12,
                    }}
                  >
                    Use selected clip range
                  </Text>
                </Pressable>
              )}
            </View>
            {!measuredDuration ? (
              <Text style={styles.small}>
                Upload a video or audio file and wait for its duration to load
                to set layer timing.
              </Text>
            ) : (
              <>
                <Text style={[styles.small, { fontSize: 12 }]}>
                  {formatTimelineTime(range.start)} →{" "}
                  {formatTimelineTime(range.end)} ·{" "}
                  {activeAtPlayhead ? "Visible" : "Hidden"} at playhead{" "}
                  {formatTimelineTime(playhead)}
                </Text>
                <OverlaySlider
                  key={`${selected.id}-start`}
                  label="Overlay start"
                  value={range.start}
                  min={0}
                  max={measuredDuration}
                  step={0.1}
                  disabled={timingDisabled}
                  valueText={formatTimelineTime(range.start)}
                  formatValue={formatTimelineTime}
                  range={range}
                  rangeEdge="start"
                  upperLimit={Math.max(0, range.end - minSpan)}
                  playhead={playhead}
                  onChange={(value) => updateTiming("start", value)}
                />
                <OverlaySlider
                  key={`${selected.id}-end`}
                  label="Overlay end"
                  value={range.end}
                  min={0}
                  max={measuredDuration}
                  step={0.1}
                  disabled={timingDisabled}
                  valueText={formatTimelineTime(range.end)}
                  formatValue={formatTimelineTime}
                  range={range}
                  rangeEdge="end"
                  lowerLimit={Math.min(measuredDuration, range.start + minSpan)}
                  playhead={playhead}
                  onChange={(value) => updateTiming("end", value)}
                />
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start text at the playhead"
                    disabled={timingDisabled || playhead >= range.end}
                    onPress={() => updateTiming("start", playhead)}
                    style={chipStyle(
                      false,
                      timingDisabled || playhead >= range.end,
                    )}
                  >
                    <Text
                      style={{
                        color: color.text,
                        fontFamily: font.medium,
                        fontSize: 12,
                      }}
                    >
                      Start here
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="End text at the playhead"
                    disabled={timingDisabled || playhead <= range.start}
                    onPress={() => updateTiming("end", playhead)}
                    style={chipStyle(
                      false,
                      timingDisabled || playhead <= range.start,
                    )}
                  >
                    <Text
                      style={{
                        color: color.text,
                        fontFamily: font.medium,
                        fontSize: 12,
                      }}
                    >
                      End here
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
            <Text style={[styles.small, { fontSize: 11 }]}>
              Times refer to the edited video. “Use selected clip range” copies
              its current time range; it does not follow that clip after later
              cuts or reordering.
            </Text>
          </View>
        </View>
      )}
      {captionTools || (
        <View style={styles.row}>
          <Captions color={color.lime} size={18} />
          <Text style={styles.label}>Caption track</Text>
        </View>
      )}
      <Text style={[styles.small, { fontSize: 11 }]}>
        Manual caption · replaces the timed track when edited
      </Text>
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
