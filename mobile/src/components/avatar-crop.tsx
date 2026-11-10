import { useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import type { ImageRef } from "expo-image-manipulator";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Minus,
  Plus,
} from "lucide-react-native";
import { Action } from "./ui";
import {
  avatarCropRect,
  centeredAvatarCrop,
  maxAvatarZoom,
  moveAvatarCrop,
  type AvatarCropPosition,
} from "../lib/avatar-crop";
import { color, styles } from "../theme";

export function AvatarCrop({
  image,
  onCancel,
  onSave,
}: {
  image: ImageRef;
  onCancel: () => void;
  onSave: (rect: ReturnType<typeof avatarCropRect>) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const frame = Math.min(220, Math.max(1, windowWidth - 88));
  const { width, height } = image;
  const [position, setPosition] = useState(centeredAvatarCrop);
  const current = useRef(position);
  current.current = position;
  const dragStart = useRef<AvatarCropPosition>(position);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          Math.abs(gesture.dx) + Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          dragStart.current = current.current;
        },
        onPanResponderMove: (_, gesture) =>
          setPosition(
            moveAvatarCrop(
              width,
              height,
              dragStart.current,
              gesture.dx,
              gesture.dy,
              frame,
            ),
          ),
        onPanResponderTerminationRequest: () => false,
      }),
    [width, height, frame],
  );
  const rect = avatarCropRect(width, height, position);
  const scale = frame / rect.width;
  const controls = [
    {
      label: "Zoom out",
      icon: Minus,
      disabled: position.zoom === 1,
      zoom: -0.25,
    },
    {
      label: "Zoom in",
      icon: Plus,
      disabled: position.zoom === maxAvatarZoom,
      zoom: 0.25,
    },
    { label: "Move photo left", icon: ArrowLeft, dx: -22, dy: 0 },
    { label: "Move photo up", icon: ArrowUp, dx: 0, dy: -22 },
    { label: "Move photo down", icon: ArrowDown, dx: 0, dy: 22 },
    { label: "Move photo right", icon: ArrowRight, dx: 22, dy: 0 },
  ];

  return (
    <View style={{ gap: 12, alignItems: "center" }}>
      <Text accessibilityRole="header" style={styles.heading}>
        Crop profile photo
      </Text>
      <Text style={[styles.small, { textAlign: "center" }]}>
        Drag to reposition. Zoom to select what appears in your avatar.
      </Text>
      <View
        {...drag.panHandlers}
        style={[
          {
            width: frame,
            height: frame,
            overflow: "hidden",
            borderRadius: frame / 2,
            backgroundColor: color.panel,
          },
          Platform.OS === "web"
            ? ({ touchAction: "none", cursor: "move" } as unknown as ViewStyle)
            : null,
        ]}
      >
        <Image
          accessibilityLabel="Profile photo crop preview"
          source={image}
          cachePolicy="none"
          contentFit="fill"
          style={{
            position: "absolute",
            width: width * scale,
            height: height * scale,
            left: -rect.originX * scale,
            top: -rect.originY * scale,
          }}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          justifyContent: "center",
        }}
      >
        {controls.map(({ label, icon: Icon, disabled, zoom, dx, dy }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={label}
            disabled={disabled}
            onPress={() =>
              setPosition((previous) => {
                if (zoom === undefined)
                  return moveAvatarCrop(
                    width,
                    height,
                    previous,
                    dx ?? 0,
                    dy ?? 0,
                    frame,
                  );
                const next = { ...previous, zoom: previous.zoom + zoom };
                return moveAvatarCrop(width, height, next, 0, 0, frame);
              })
            }
            style={{
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderRadius: 10,
              borderColor: color.border,
              opacity: disabled ? 0.45 : 1,
            }}
          >
            <Icon size={19} color={color.text} />
          </Pressable>
        ))}
      </View>
      <View
        style={{
          alignSelf: "stretch",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Action title="Cancel" secondary onPress={onCancel} />
        <Action title="Save profile photo" onPress={() => onSave(rect)} />
      </View>
    </View>
  );
}
