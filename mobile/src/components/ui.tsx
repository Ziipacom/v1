import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
  Image as RNImage,
} from "react-native";
import { Image } from "expo-image";
import {
  ArrowRight,
  Clapperboard,
  Gamepad2,
  Hexagon,
  Music2,
  Radio,
  Store,
  type LucideIcon,
} from "lucide-react-native";
import { color, font, styles, useTheme } from "../theme";
import { logo, logoLight, coverSource } from "../lib/assets";
import { conceptsEnabled } from "../lib/config";
import type { Category, Item } from "../lib/types";
import { useZiipa } from "../provider";
import { useDesktopLayout } from "./desktop-layout";

export function Logo({ width = 116 }: { width?: number }) {
  const { resolvedMode } = useTheme();
  return (
    <RNImage
      source={resolvedMode === "light" ? logoLight : logo}
      style={{
        width,
        height: (width * 3104) / 9446,
        backgroundColor: "transparent",
      }}
      resizeMode="contain"
      accessibilityLabel="Ziipa"
    />
  );
}
export function Action({
  title,
  onPress,
  icon: Icon,
  secondary,
  busy,
  disabled,
  danger,
  testID,
}: {
  title: string;
  onPress: () => void;
  icon?: LucideIcon;
  secondary?: boolean;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  testID?: string;
}) {
  const { desktop } = useDesktopLayout();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: desktop ? 38 : 50,
        paddingHorizontal: desktop ? 14 : 18,
        paddingVertical: desktop ? 8 : 13,
        borderRadius: desktop ? 8 : 14,
        ...(desktop
          ? { alignSelf: "flex-start" as const, maxWidth: "100%" as const }
          : {}),
        backgroundColor: secondary
          ? color.panel
          : danger
            ? "#742A40"
            : color.purple,
        borderColor: secondary ? color.border : "transparent",
        borderWidth: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: desktop ? 8 : 10,
        opacity: disabled || busy ? 0.55 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? color.text : color.onAccent} />
      ) : Icon ? (
        <Icon size={desktop ? 16 : 19} color={secondary ? color.text : color.onAccent} />
      ) : null}
      <Text
        style={{
          color: secondary ? color.text : color.onAccent,
          fontFamily: font.semibold,
          fontSize: desktop ? 14 : 16,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        borderWidth: 1,
        borderColor: active ? color.purple : color.border,
        backgroundColor: active ? color.purple : color.panel,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed || disabled ? 0.6 : 1,
      })}
    >
      <Icon size={21} color={active ? color.onAccent : color.text} />
    </Pressable>
  );
}
export function Field({
  label,
  style,
  ...props
}: TextInputProps & { label: string }) {
  const { desktop } = useDesktopLayout();
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={color.faint}
        selectionColor={color.purple}
        style={[
          styles.input,
          desktop && {
            minHeight: 40,
            paddingVertical: 10,
            borderRadius: 8,
            fontSize: 14,
          },
          props.multiline && { minHeight: 94, textAlignVertical: "top" },
          style,
        ]}
      />
    </View>
  );
}
export function Notice({ text, error }: { text: string; error?: boolean }) {
  const { desktop } = useDesktopLayout();
  return (
    <View
      style={{
        backgroundColor: error ? color.errorPanel : color.panel,
        borderRadius: desktop ? 8 : 13,
        padding: desktop ? 12 : 14,
        borderWidth: 1,
        borderColor: error ? color.errorBorder : color.border,
      }}
    >
      <Text
        accessibilityRole={error ? "alert" : undefined}
        style={error ? styles.error : styles.small}
      >
        {text}
      </Text>
    </View>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  useTheme();
  return (
    <View style={[styles.panel, { alignItems: "center", paddingVertical: 35 }]}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={[styles.body, { textAlign: "center" }]}>{body}</Text>
    </View>
  );
}
export const allCategories: {
  id: Category;
  title: string;
  icon: LucideIcon;
  concept?: boolean;
}[] = [
  { id: "video", title: "Videos", icon: Clapperboard },
  { id: "games", title: "Games", icon: Gamepad2 },
  { id: "music", title: "Music & film", icon: Music2 },
  { id: "live", title: "Live feeds", icon: Radio, concept: true },
  { id: "nft", title: "NFTs", icon: Hexagon, concept: true },
  { id: "store", title: "Store", icon: Store, concept: true },
];
export const categories = allCategories.filter(
  (c) => conceptsEnabled || !c.concept,
);
export function Pill({
  title,
  active,
  onPress,
}: {
  title: string;
  active?: boolean;
  onPress: () => void;
}) {
  const { desktop } = useDesktopLayout();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        minHeight: desktop ? 34 : 42,
        justifyContent: "center",
        paddingHorizontal: desktop ? 12 : 15,
        paddingVertical: desktop ? 8 : 10,
        borderRadius: desktop ? 7 : 22,
        borderWidth: 1,
        borderColor: active ? color.purple : color.border,
        backgroundColor: active ? color.purple : color.panel,
      }}
    >
      <Text
        style={{ fontFamily: font.medium, color: active ? color.onAccent : color.text, fontSize: 13 }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Cover({
  item,
  style,
}: {
  item: Item;
  style?: StyleProp<ViewStyle>;
}) {
  const { session } = useZiipa();
  return (
    <View
      style={[{ overflow: "hidden", backgroundColor: color.raised }, style]}
    >
      <Image
        source={coverSource(item.cover, session?.access_token)}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        cachePolicy={item.demo ? "memory-disk" : "none"}
        accessibilityLabel={item.title}
      />
    </View>
  );
}
export function ItemRow({
  item,
  onPress,
}: {
  item: Item;
  onPress: () => void;
}) {
  useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title}`}
      onPress={onPress}
      style={[styles.row, { paddingVertical: 12 }]}
    >
      <Cover item={item} style={{ height: 75, width: 72, borderRadius: 14 }} />
      <View style={{ flex: 1, gap: 5 }}>
        <Text
          numberOfLines={2}
          style={{ fontFamily: font.semibold, fontSize: 17, color: color.text }}
        >
          {item.title}
        </Text>
        <Text style={styles.small}>
          {item.creator} ·{" "}
          {item.demo
            ? "Preview"
            : item.visibility === "hidden"
              ? "Removed"
              : item.visibility === "draft"
                ? "Draft"
                : "Published"}
        </Text>
      </View>
      <ArrowRight size={18} color={color.muted} />
    </Pressable>
  );
}
