import { useMemo, useRef, useState } from "react";
import { PanResponder, Platform, Text, View } from "react-native";
import { color, font } from "../theme";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

type WebKeyEvent = {
  nativeEvent?: { key?: string; shiftKey?: boolean };
  key?: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/** Shared native/web slider: drag, tap, keyboard or screen-reader adjustment. */
export function OverlaySlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  valueText: string;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
  range?: { start: number; end: number };
  rangeEdge?: "start" | "end";
  lowerLimit?: number;
  upperLimit?: number;
  playhead?: number;
}) {
  const [width, setWidth] = useState(240);
  const [preview, setPreview] = useState<number | null>(null);
  const latest = useRef({ props, width });
  latest.current = { props, width };
  const origin = useRef(0);
  const changed = useRef<number | null>(null);
  const adjust = (raw: number, commit = true) => {
    const options = latest.current.props;
    if (options.disabled || options.max <= options.min) return;
    const low = options.lowerLimit ?? options.min;
    const high = options.upperLimit ?? options.max;
    const next = Number(
      clamp(Math.round(raw / options.step) * options.step, low, high).toFixed(
        3,
      ),
    );
    if (commit) options.onChange(next);
    else {
      changed.current = next;
      setPreview(next);
    }
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          !latest.current.props.disabled &&
          latest.current.props.max > latest.current.props.min,
        onMoveShouldSetPanResponder: (_, gesture) =>
          !latest.current.props.disabled && Math.abs(gesture.dx) > 3,
        onPanResponderGrant: (event) => {
          changed.current = null;
          origin.current = event.nativeEvent.locationX;
          const options = latest.current.props;
          adjust(
            options.min +
              (clamp(origin.current - 22, 0, latest.current.width - 44) /
                Math.max(1, latest.current.width - 44)) *
                (options.max - options.min),
            false,
          );
        },
        onPanResponderMove: (_, gesture) => {
          const options = latest.current.props;
          adjust(
            options.min +
              (clamp(
                origin.current + gesture.dx - 22,
                0,
                latest.current.width - 44,
              ) /
                Math.max(1, latest.current.width - 44)) *
                (options.max - options.min),
            false,
          );
        },
        onPanResponderRelease: () => {
          if (!latest.current.props.disabled && changed.current !== null)
            latest.current.props.onChange(changed.current);
          changed.current = null;
          setPreview(null);
        },
        onPanResponderTerminate: () => {
          changed.current = null;
          setPreview(null);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  const ratio = (value: number) =>
    props.max > props.min
      ? clamp((value - props.min) / (props.max - props.min), 0, 1)
      : 0;
  const trackWidth = Math.max(0, width - 44);
  const valid = !props.disabled && props.max > props.min;
  const displayedValue = preview ?? props.value;
  const displayedText =
    preview !== null && props.formatValue
      ? props.formatValue(preview)
      : props.valueText;
  const low = props.lowerLimit ?? props.min;
  const high = props.upperLimit ?? props.max;
  const displayedRange =
    props.range && props.rangeEdge
      ? { ...props.range, [props.rangeEdge]: displayedValue }
      : props.range;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text
          style={{ color: color.muted, fontSize: 12, fontFamily: font.medium }}
        >
          {props.label}
        </Text>
        <Text
          style={{ color: color.text, fontSize: 12, fontFamily: font.semibold }}
        >
          {displayedText}
        </Text>
      </View>
      <View
        {...responder.panHandlers}
        onLayout={(event) => {
          const measuredWidth = event.nativeEvent.layout.width;
          setWidth(measuredWidth);
        }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityHint="Drag horizontally. Use arrow keys or adjustment actions for precise control."
        accessibilityState={{ disabled: !valid }}
        accessibilityValue={{
          min: low,
          max: high,
          now: clamp(displayedValue, low, high),
          text: displayedText,
        }}
        accessibilityActions={[
          { name: "increment", label: `Increase ${props.label}` },
          { name: "decrement", label: `Decrease ${props.label}` },
        ]}
        onAccessibilityAction={(event) => {
          const direction =
            event.nativeEvent.actionName === "increment" ? 1 : -1;
          adjust(props.value + direction * props.step);
        }}
        tabIndex={valid ? 0 : -1}
        {...(Platform.OS === "web"
          ? {
              "aria-valuemin": low,
              "aria-valuemax": high,
              "aria-valuenow": clamp(displayedValue, low, high),
              "aria-valuetext": displayedText,
              onKeyDown: (event: WebKeyEvent) => {
                const key = event.nativeEvent?.key || event.key;
                if (!valid) return;
                if (
                  key === "ArrowLeft" ||
                  key === "ArrowDown" ||
                  key === "ArrowRight" ||
                  key === "ArrowUp" ||
                  key === "Home" ||
                  key === "End"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  const direction =
                    key === "ArrowRight" || key === "ArrowUp" ? 1 : -1;
                  const step =
                    props.step *
                    (event.nativeEvent?.shiftKey || event.shiftKey ? 10 : 1);
                  adjust(
                    key === "Home"
                      ? low
                      : key === "End"
                        ? high
                        : props.value + direction * step,
                  );
                }
              },
            }
          : {})}
        style={{
          height: 44,
          justifyContent: "center",
          opacity: valid ? 1 : 0.4,
        }}
      >
        <View
          pointerEvents="none"
          style={{
            marginHorizontal: 22,
            height: 6,
            borderRadius: 4,
            backgroundColor: color.border,
          }}
        >
          <View
            style={{
              position: "absolute",
              left: displayedRange
                ? ratio(displayedRange.start) * trackWidth
                : 0,
              width: displayedRange
                ? Math.max(
                    0,
                    (ratio(displayedRange.end) - ratio(displayedRange.start)) *
                      trackWidth,
                  )
                : ratio(displayedValue) * trackWidth,
              height: 6,
              borderRadius: 4,
              backgroundColor: color.purple,
            }}
          />
          {props.playhead !== undefined && (
            <View
              style={{
                position: "absolute",
                left: ratio(props.playhead) * trackWidth,
                top: -5,
                height: 16,
                width: 2,
                backgroundColor: color.text,
              }}
            />
          )}
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: ratio(displayedValue) * trackWidth,
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: props.range ? 16 : 20,
              height: props.range ? 30 : 20,
              borderRadius: props.range ? 5 : 10,
              backgroundColor: color.lime,
              borderWidth: 2,
              borderColor: color.bg,
            }}
          />
        </View>
      </View>
    </View>
  );
}
