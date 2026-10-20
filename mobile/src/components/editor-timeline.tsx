import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image, type ImageProps } from "expo-image";
import {
  Captions,
  Film,
  GripVertical,
  Music2,
  Redo2,
  ScanLine,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react-native";
import {
  MAX_TIMELINE_SECONDS,
  canSplitAt,
  clampClipEdge,
  formatTimelineTime,
  totalDuration,
  type TimelineClip,
} from "../lib/editor-timeline";
import { color, font } from "../theme";

export type TimelineThumbnail = {
  time: number;
  uri?: string;
  source?: ImageProps["source"];
};
export type EditorTimelineProps = {
  duration: number;
  currentTime: number;
  sourceTime?: number;
  clips: readonly TimelineClip[];
  selectedId?: string | null;
  thumbnails?: readonly TimelineThumbnail[];
  thumbnailsLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  onSeek: (sequenceTime: number) => void;
  onSelect: (id: string) => void;
  onTrim: (id: string, trim: { start: number; end: number }) => void;
  onInteractionStart?: () => void;
  onSplit?: () => void;
  onDelete?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canSplit?: boolean;
  canDelete?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  captionLabel?: string;
  musicLabel?: string;
  onCaption?: () => void;
  onMusic?: () => void;
};

type WebKeyEvent = {
  nativeEvent?: { key?: string; shiftKey?: boolean };
  key?: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
// React Native Web forwards DOM keyboard handlers; native uses accessibility actions.
function webKeys(
  handler: (key: string, shift: boolean, event: WebKeyEvent) => void,
) {
  return Platform.OS === "web"
    ? {
        onKeyDown: (event: WebKeyEvent) =>
          handler(
            event.nativeEvent?.key || event.key || "",
            !!(event.nativeEvent?.shiftKey || event.shiftKey),
            event,
          ),
      }
    : {};
}

function webSliderValue(min: number, max: number, now: number, text: string) {
  // RN Web 0.21 reads flat ARIA props, while native reads accessibilityValue.
  return Platform.OS === "web"
    ? {
        "aria-valuemin": min,
        "aria-valuemax": max,
        "aria-valuenow": now,
        "aria-valuetext": text,
      }
    : {};
}

/** Visual editing only. The parent owns playback, edit history and persistence. */
export function EditorTimeline(props: EditorTimelineProps) {
  const {
    duration,
    currentTime,
    sourceTime,
    clips,
    selectedId,
    thumbnails = [],
    disabled = false,
    compact = false,
  } = props;
  const [viewport, setViewport] = useState(300);
  const [zoomScale, setZoomScale] = useState<number | null>(null);
  const timelineScroll = useRef<ScrollView>(null);
  const [preview, setPreview] = useState<TimelineClip | null>(null);
  const [dragging, setDragging] = useState(false);
  const displayed = preview
    ? clips.map((clip) => (clip.id === preview.id ? preview : clip))
    : clips;
  const total = totalDuration(displayed);
  const selected = displayed.find((clip) => clip.id === selectedId);
  const fitScale = Math.max(
    4,
    Math.min(80, (viewport - 32) / Math.max(totalDuration(clips), 1)),
  );
  const scale = zoomScale ?? fitScale;
  const trackWidth = Math.max(viewport - 32, total * scale);
  const playhead = Math.max(
    0,
    Math.min(total, Number.isFinite(currentTime) ? currentTime : 0),
  );
  const validDuration = Number.isFinite(duration) && duration > 0;
  const frameSamples = useMemo(
    () =>
      thumbnails
        .filter(
          (frame) =>
            Number.isFinite(frame.time) &&
            frame.time >= 0 &&
            (frame.source || frame.uri),
        )
        .slice()
        .sort((a, b) => a.time - b.time),
    [thumbnails],
  );
  const latest = useRef({ props, scale, total });
  latest.current = { props, scale, total };
  const origin = useRef(0);
  useEffect(() => {
    setPreview(null);
    setDragging(false);
  }, [selectedId]);
  useEffect(() => setZoomScale(null), [duration]);
  const scrub = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          !latest.current.props.disabled && latest.current.total > 0,
        onMoveShouldSetPanResponder: (_, gesture) =>
          !latest.current.props.disabled && Math.abs(gesture.dx) > 3,
        onPanResponderGrant: (event) => {
          latest.current.props.onInteractionStart?.();
          origin.current = event.nativeEvent.locationX;
          latest.current.props.onSeek(
            Math.max(
              0,
              Math.min(
                latest.current.total,
                origin.current / latest.current.scale,
              ),
            ),
          );
          setDragging(true);
        },
        onPanResponderMove: (_, gesture) =>
          !latest.current.props.disabled &&
          latest.current.props.onSeek(
            Math.max(
              0,
              Math.min(
                latest.current.total,
                (origin.current + gesture.dx) / latest.current.scale,
              ),
            ),
          ),
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  function nudgeSeek(delta: number) {
    if (disabled || !total) return;
    props.onInteractionStart?.();
    props.onSeek(Math.max(0, Math.min(total, playhead + delta)));
  }
  let offset = 0;
  const positions = displayed.map((clip, index) => {
    const entry = {
      clip,
      index,
      offset,
      width: ((clip.end - clip.start) / (clip.speed ?? 1)) * scale,
    };
    offset += (clip.end - clip.start) / (clip.speed ?? 1);
    return entry;
  });
  const tickStep =
    [1, 2, 5, 10, 15, 30].find((step) => step * scale >= 50) || 30;
  const ticks = Array.from(
    { length: Math.min(92, Math.floor(total / tickStep) + 1) },
    (_, index) => index * tickStep,
  );

  const zoomTools = (
    <>
      <Tool
        compact={compact}
        title="Zoom out"
        Icon={ZoomOut}
        enabled={!disabled && !dragging && scale > 4}
        onPress={() => setZoomScale(Math.max(4, scale / 1.5))}
      />
      <Tool
        compact={compact}
        title="Fit"
        Icon={ScanLine}
        enabled={!disabled && !dragging}
        onPress={() => {
          setZoomScale(null);
          timelineScroll.current?.scrollTo({ x: 0, animated: false });
        }}
      />
      <Tool
        compact={compact}
        title="Zoom in"
        Icon={ZoomIn}
        enabled={!disabled && !dragging && scale < 160}
        onPress={() => setZoomScale(Math.min(160, scale * 1.5))}
      />
    </>
  );
  return (
    <View style={[s.panel, compact && { paddingTop: 8, gap: 6 }]}>
      <View style={[s.toolbar, compact && { paddingHorizontal: 10, gap: 6 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Film size={16} color={color.lime} />
          <Text style={s.heading}>Timeline</Text>
          <Text style={s.muted}>{clips.length}/12 clips</Text>
        </View>
        <View style={s.tools}>
          <Tool
            compact={compact}
            title="Undo"
            Icon={Undo2}
            enabled={!disabled && !!props.canUndo}
            onPress={props.onUndo}
          />
          <Tool
            compact={compact}
            title="Redo"
            Icon={Redo2}
            enabled={!disabled && !!props.canRedo}
            onPress={props.onRedo}
          />
          <Tool
            compact={compact}
            title="Split"
            Icon={Scissors}
            enabled={
              !disabled && (props.canSplit ?? canSplitAt(clips, playhead))
            }
            onPress={props.onSplit}
          />
          <Tool
            compact={compact}
            title="Delete"
            Icon={Trash2}
            enabled={!disabled && (props.canDelete ?? !!selected)}
            onPress={props.onDelete}
          />
          {compact && zoomTools}
        </View>
      </View>
      {!compact && (
        <View
          style={[s.tools, { paddingHorizontal: 14, alignItems: "center" }]}
        >
          {zoomTools}
          <Text style={[s.muted, { paddingHorizontal: 5 }]}>
            {zoomScale === null ? "Fit to view" : `${Math.round(scale)} px/s`}
          </Text>
        </View>
      )}
      {!compact && (
        <View style={s.timeRow}>
          <Text style={s.time}>
            {formatTimelineTime(playhead)}{" "}
            <Text style={s.muted}>/ {formatTimelineTime(total)}</Text>
          </Text>
          {sourceTime !== undefined && (
            <Text style={s.muted}>Source {formatTimelineTime(sourceTime)}</Text>
          )}
        </View>
      )}
      {!clips.length ? (
        <View style={s.empty}>
          <Film size={25} color={color.faint} />
          <Text style={s.muted}>Add media to begin your timeline.</Text>
        </View>
      ) : (
        <>
          <ScrollView
            ref={timelineScroll}
            horizontal
            scrollEnabled={!dragging}
            showsHorizontalScrollIndicator={false}
            onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: compact ? 0 : 12,
            }}
          >
            <View style={{ width: trackWidth, height: compact ? 90 : 128 }}>
              <View
                {...scrub.panHandlers}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Timeline playhead"
                accessibilityHint="Drag to seek. Use arrow keys or adjustment actions for tenths of a second."
                accessibilityState={{ disabled }}
                accessibilityValue={{
                  min: 0,
                  max: total,
                  now: playhead,
                  text: formatTimelineTime(playhead),
                }}
                {...webSliderValue(
                  0,
                  total,
                  playhead,
                  formatTimelineTime(playhead),
                )}
                accessibilityActions={[
                  { name: "increment", label: "Seek forward" },
                  { name: "decrement", label: "Seek backward" },
                ]}
                onAccessibilityAction={(event) =>
                  nudgeSeek(
                    event.nativeEvent.actionName === "increment" ? 0.1 : -0.1,
                  )
                }
                tabIndex={disabled ? -1 : 0}
                {...webKeys((key, shift, event) => {
                  if (key === "ArrowLeft" || key === "ArrowRight") {
                    event.preventDefault();
                    nudgeSeek(
                      (key === "ArrowRight" ? 1 : -1) * (shift ? 1 : 0.1),
                    );
                  } else if (key === "Home" || key === "End") {
                    event.preventDefault();
                    props.onInteractionStart?.();
                    if (!disabled) props.onSeek(key === "Home" ? 0 : total);
                  }
                })}
                style={[s.ruler, compact && { height: 24 }]}
              >
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  {ticks.map((time) => (
                    <View
                      key={time}
                      style={{
                        position: "absolute",
                        left: time * scale,
                        top: 0,
                        height: compact ? 21 : 31,
                        borderLeftWidth: 1,
                        borderColor: "#675678",
                      }}
                    >
                      <Text style={[s.tick, { marginLeft: 4 }]}>
                        {formatTimelineTime(time)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
              <View style={[s.track, compact && { top: 28, height: 56 }]}>
                {positions.map(({ clip, index, offset: start, width }) => {
                  const active = selectedId === clip.id;
                  const cells = Math.max(
                    1,
                    Math.min(48, Math.ceil(width / 44)),
                  );
                  return (
                    <View
                      key={clip.id}
                      style={{
                        position: "absolute",
                        left: start * scale,
                        top: 0,
                        width: Math.max(1, width),
                        height: compact ? 56 : 74,
                        zIndex: active ? 3 : 1,
                      }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Select clip ${index + 1}, source ${formatTimelineTime(clip.start)} to ${formatTimelineTime(clip.end)}`}
                        accessibilityState={{ selected: active, disabled }}
                        disabled={disabled}
                        onPress={() => props.onSelect(clip.id)}
                        style={[s.clip, active && s.selected]}
                      >
                        <View
                          pointerEvents="none"
                          style={{
                            position: "absolute",
                            inset: 0,
                            flexDirection: "row",
                          }}
                        >
                          {Array.from({ length: cells }, (_, frameIndex) => {
                            const sourceSecond =
                              clip.start +
                              (clip.end - clip.start) *
                                ((frameIndex + 0.5) / cells);
                            const frame = frameSamples.reduce<
                              TimelineThumbnail | undefined
                            >(
                              (nearest, candidate) =>
                                !nearest ||
                                Math.abs(candidate.time - sourceSecond) <
                                  Math.abs(nearest.time - sourceSecond)
                                  ? candidate
                                  : nearest,
                              undefined,
                            );
                            return (
                              <View
                                key={frameIndex}
                                style={{
                                  flex: 1,
                                  borderRightWidth: 1,
                                  borderColor: "#120D1F55",
                                  backgroundColor: "#342344",
                                }}
                              >
                                {frame ? (
                                  <Image
                                    source={frame.source || { uri: frame.uri }}
                                    style={{ width: "100%", height: "100%" }}
                                    contentFit="cover"
                                    cachePolicy="none"
                                    accessible={false}
                                  />
                                ) : null}
                              </View>
                            );
                          })}
                        </View>
                        <View
                          pointerEvents="none"
                          style={[s.clipShade, compact && { padding: 4 }]}
                        >
                          <Text numberOfLines={1} style={s.clipLabel}>
                            Clip {index + 1}
                          </Text>
                          {width > 80 && (
                            <Text numberOfLines={1} style={s.clipTime}>
                              {formatTimelineTime(
                                (clip.end - clip.start) / (clip.speed ?? 1),
                              )}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                      {active &&
                        validDuration &&
                        (["start", "end"] as const).map((edge) => (
                          <TrimHandle
                            key={edge}
                            clip={clip}
                            edge={edge}
                            sourceDuration={duration}
                            maxClipDuration={
                              (clip.speed ?? 1) *
                              Math.max(
                                0.2,
                                MAX_TIMELINE_SECONDS -
                                  totalDuration(
                                    clips.filter(
                                      (entry) => entry.id !== clip.id,
                                    ),
                                  ),
                              )
                            }
                            scale={scale}
                            disabled={disabled}
                            onStart={() => {
                              props.onInteractionStart?.();
                              setDragging(true);
                            }}
                            onPreview={setPreview}
                            onFinish={(next) => {
                              setDragging(false);
                              setPreview(null);
                              if (next)
                                props.onTrim(clip.id, {
                                  start: next.start,
                                  end: next.end,
                                });
                            }}
                          />
                        ))}
                    </View>
                  );
                })}
              </View>
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: Math.max(0, playhead * scale - 1),
                  top: compact ? 18 : 25,
                  bottom: 4,
                  width: 2,
                  backgroundColor: "white",
                  zIndex: 9,
                }}
              >
                <View style={s.playheadCap} />
              </View>
            </View>
          </ScrollView>
          <View
            style={[s.footer, compact && { paddingHorizontal: 12, gap: 4 }]}
          >
            <Text
              numberOfLines={compact ? 1 : undefined}
              style={[
                s.muted,
                { flex: 1 },
                compact && { fontSize: 10, lineHeight: 12 },
              ]}
            >
              {selected
                ? `Selected source ${formatTimelineTime(selected.start)}–${formatTimelineTime(selected.end)}`
                : "Select a clip to trim or delete."}
            </Text>
            <Text style={s.muted}>
              {frameSamples.length
                ? props.thumbnailsLabel || "Source frames"
                : "Clip strip · no thumbnails yet"}
            </Text>
          </View>
          {(props.captionLabel || props.musicLabel) && (
            <View
              style={{
                paddingHorizontal: compact ? 12 : 16,
                gap: compact ? 4 : 7,
              }}
            >
              {props.captionLabel && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit caption track: ${props.captionLabel}`}
                  accessibilityState={{
                    disabled: disabled || !props.onCaption,
                  }}
                  disabled={disabled || !props.onCaption}
                  onPress={props.onCaption}
                  style={{
                    minHeight: compact ? 26 : 35,
                    borderRadius: 7,
                    borderLeftWidth: 3,
                    borderColor: "#B58CE8",
                    backgroundColor: "#41205D",
                    paddingHorizontal: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Captions size={16} color="#E8D6FF" />
                  <Text
                    numberOfLines={1}
                    style={[s.muted, { color: "#E8D6FF", flex: 1 }]}
                  >
                    {props.captionLabel}
                  </Text>
                  <Text style={s.tick}>Captions</Text>
                </Pressable>
              )}
              {props.musicLabel && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit music track: ${props.musicLabel}`}
                  accessibilityState={{ disabled: disabled || !props.onMusic }}
                  disabled={disabled || !props.onMusic}
                  onPress={props.onMusic}
                  style={{
                    minHeight: compact ? 26 : 35,
                    borderRadius: 7,
                    borderLeftWidth: 3,
                    borderColor: color.lime,
                    backgroundColor: "#26351E",
                    paddingHorizontal: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Music2 size={16} color={color.lime} />
                  <Text
                    numberOfLines={1}
                    style={[s.muted, { color: "#DBEAC7", flex: 1 }]}
                  >
                    {props.musicLabel}
                  </Text>
                  <Text style={s.tick}>Music</Text>
                </Pressable>
              )}
            </View>
          )}
          <Text
            numberOfLines={compact ? 1 : undefined}
            style={[
              s.hint,
              compact && {
                fontSize: 9,
                lineHeight: 12,
                paddingHorizontal: 12,
                paddingBottom: 8,
              },
            ]}
          >
            Drag the ruler to seek. Drag the lime handles to trim. Changes stay
            in this draft until you save.
          </Text>
        </>
      )}
    </View>
  );
}

function Tool({
  title,
  Icon,
  enabled,
  onPress,
  compact = false,
}: {
  compact?: boolean;
  title: string;
  Icon: typeof Film;
  enabled: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} timeline edit`}
      accessibilityState={{ disabled: !enabled || !onPress }}
      disabled={!enabled || !onPress}
      onPress={onPress}
      style={[
        s.tool,
        compact && {
          minHeight: 28,
          minWidth: 28,
          paddingHorizontal: 6,
          justifyContent: "center",
        },
        (!enabled || !onPress) && { opacity: 0.35 },
      ]}
    >
      <Icon size={16} color={title === "Delete" ? color.danger : color.text} />
      {!compact && <Text style={s.toolLabel}>{title}</Text>}
    </Pressable>
  );
}

function TrimHandle(props: {
  clip: TimelineClip;
  edge: "start" | "end";
  sourceDuration: number;
  maxClipDuration: number;
  scale: number;
  disabled: boolean;
  onStart: () => void;
  onPreview: (clip: TimelineClip | null) => void;
  onFinish: (clip: TimelineClip | null) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const initial = useRef(props.clip);
  const changed = useRef<TimelineClip | null>(null);
  const apply = (delta: number) => {
    const options = latest.current;
    if (options.disabled) return;
    options.onStart();
    const next = clampClipEdge(
      options.clip,
      options.edge,
      options.clip[options.edge] + delta,
      options.sourceDuration,
      options.maxClipDuration,
    );
    options.onFinish(next);
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onMoveShouldSetPanResponder: () => !latest.current.disabled,
        onPanResponderGrant: () => {
          initial.current = latest.current.clip;
          changed.current = null;
          latest.current.onStart();
        },
        onPanResponderMove: (_, gesture) => {
          const options = latest.current;
          if (options.disabled) return;
          const next = clampClipEdge(
            initial.current,
            options.edge,
            initial.current[options.edge] +
              (gesture.dx / options.scale) * (initial.current.speed ?? 1),
            options.sourceDuration,
            options.maxClipDuration,
          );
          changed.current = next;
          options.onPreview(next);
        },
        onPanResponderRelease: () => {
          latest.current.onFinish(
            latest.current.disabled ? null : changed.current,
          );
          changed.current = null;
        },
        onPanResponderTerminate: () => {
          latest.current.onFinish(null);
          changed.current = null;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  const start = props.edge === "start";
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Clip ${props.edge} trim handle`}
      accessibilityHint="Drag horizontally. Arrow keys or adjustment actions change by 0.1 seconds."
      accessibilityState={{ disabled: props.disabled }}
      accessibilityValue={{
        min: start
          ? Math.max(0, props.clip.end - props.maxClipDuration)
          : props.clip.start + 0.2,
        max: start
          ? props.clip.end - 0.2
          : Math.min(
              props.sourceDuration,
              props.clip.start + props.maxClipDuration,
            ),
        now: props.clip[props.edge],
        text: formatTimelineTime(props.clip[props.edge]),
      }}
      {...webSliderValue(
        start
          ? Math.max(0, props.clip.end - props.maxClipDuration)
          : props.clip.start + 0.2,
        start
          ? props.clip.end - 0.2
          : Math.min(
              props.sourceDuration,
              props.clip.start + props.maxClipDuration,
            ),
        props.clip[props.edge],
        formatTimelineTime(props.clip[props.edge]),
      )}
      accessibilityActions={[
        { name: "increment", label: `Move ${props.edge} forward` },
        { name: "decrement", label: `Move ${props.edge} backward` },
      ]}
      onAccessibilityAction={(event) =>
        apply(event.nativeEvent.actionName === "increment" ? 0.1 : -0.1)
      }
      tabIndex={props.disabled ? -1 : 0}
      {...webKeys((key, shift, event) => {
        if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          apply((key === "ArrowRight" ? 1 : -1) * (shift ? 1 : 0.1));
        }
      })}
      style={[
        s.handle,
        start ? { left: -8 } : { right: -8 },
        props.disabled && { opacity: 0.4 },
        Platform.OS === "web" && { cursor: "pointer" },
      ]}
    >
      <GripVertical size={15} color="#172000" />
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#4A365E",
    backgroundColor: "#171020",
    overflow: "hidden",
    paddingTop: 14,
    gap: 12,
  },
  toolbar: {
    paddingHorizontal: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: { color: color.text, fontFamily: font.semibold, fontSize: 15 },
  tools: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tool: {
    minHeight: 38,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: "#2B1D3B",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  toolLabel: { color: color.text, fontFamily: font.medium, fontSize: 11 },
  timeRow: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  time: {
    color: color.text,
    fontFamily: font.semibold,
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
  muted: {
    color: color.muted,
    fontFamily: font.regular,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  ruler: { height: 36, borderBottomWidth: 1, borderColor: "#493654" },
  tick: {
    color: color.faint,
    fontFamily: font.medium,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  track: {
    position: "absolute",
    top: 40,
    left: 0,
    right: 0,
    height: 74,
    backgroundColor: "#21152C",
    borderRadius: 6,
  },
  clip: {
    flex: 1,
    borderWidth: 2,
    borderColor: "#8B5BCA",
    borderRadius: 5,
    overflow: "hidden",
  },
  selected: { borderColor: color.lime },
  clipShade: {
    flex: 1,
    backgroundColor: "#120D1F35",
    justifyContent: "space-between",
    padding: 7,
  },
  clipLabel: {
    color: "white",
    fontFamily: font.semibold,
    fontSize: 10,
    textShadowColor: "#000",
    textShadowRadius: 4,
  },
  clipTime: {
    color: "white",
    fontFamily: font.medium,
    fontSize: 10,
    textShadowColor: "#000",
    textShadowRadius: 4,
  },
  handle: {
    position: "absolute",
    top: -3,
    bottom: -3,
    width: 20,
    borderRadius: 6,
    backgroundColor: color.lime,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  playheadCap: {
    position: "absolute",
    top: -4,
    left: -5,
    width: 12,
    height: 10,
    backgroundColor: "white",
    borderRadius: 3,
  },
  footer: {
    paddingHorizontal: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  hint: {
    color: color.faint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  empty: {
    minHeight: 115,
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
});
