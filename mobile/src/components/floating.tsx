import type { PropsWithChildren } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Gamepad2,
  Hexagon,
  MailOpen,
  Music2,
  Video,
  Store,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { color, font, styles, themedStyles, useTheme } from "../theme";
import { conceptsEnabled, iosLimitedTestflight } from "../lib/config";
import type { Category } from "../lib/types";
import { useDesktopLayout } from "./desktop-layout";

export const worlds: {
  id: Category;
  title: string;
  icon: LucideIcon;
  concept?: boolean;
}[] = [
  { id: "games", title: "Games", icon: Gamepad2 },
  { id: "live", title: "Live Feed", icon: Video, concept: true },
  { id: "music", title: "Music & Film", icon: Music2 },
  { id: "nft", title: "NFTs", icon: Hexagon, concept: true },
  { id: "store", title: "Store", icon: Store, concept: true },
// Category navigation is distinct from enabling a service. Keep the iPhone
// beta's menu/dock complete; wallet/import actions retain their own guards.
].filter((w) => conceptsEnabled || iosLimitedTestflight || !w.concept) as {
  id: Category;
  title: string;
  icon: LucideIcon;
  concept?: boolean;
}[];

export function WorldGlyph({
  id,
  size = 24,
  media = false,
  active = false,
}: {
  id: Category | "inbox";
  size?: number;
  media?: boolean;
  active?: boolean;
}) {
  useTheme();
  const foreground = media ? color.onMedia : active ? color.onAccent : color.text;
  if (id === "nft")
    return (
      <View
        style={{
          width: size + 6,
          height: size + 6,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Hexagon size={size + 6} fill={foreground} color={foreground} />
        <Text
          style={{
            position: "absolute",
            color: media || active ? "#120D1F" : color.bg,
            fontFamily: font.bold,
            fontSize: 9,
          }}
        >
          NFT
        </Text>
      </View>
    );
  if (id === "live")
    return (
      <View style={{ alignItems: "center" }}>
        <Video size={size - 3} color={foreground} fill={foreground} />
        <Text
          style={{
            color: foreground,
            fontFamily: font.bold,
            fontSize: 8,
            lineHeight: 9,
          }}
        >
          LIVE
        </Text>
      </View>
    );
  const Icon =
    id === "inbox" ? MailOpen : worlds.find((w) => w.id === id)?.icon || Music2;
  return (
    <Icon
      size={size}
      color={foreground}
      fill={id === "music" ? foreground : "none"}
      strokeWidth={1.6}
    />
  );
}

export function FloatButton({
  label,
  icon: Icon,
  onPress,
  active,
  children,
  size = 44,
  plain = false,
  media = false,
}: PropsWithChildren<{
  label: string;
  icon?: LucideIcon;
  onPress: () => void;
  active?: boolean;
  size?: number;
  plain?: boolean;
  media?: boolean;
}>) {
  useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: plain ? 0 : 1,
        borderColor: active ? color.purple : media ? "#AAA3B5" : color.border,
        backgroundColor: active
          ? color.purple
          : plain
            ? "transparent"
            : media ? "#0B0814B8" : color.panel,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      {Icon ? (
        <Icon size={24} color={media ? color.onMedia : active ? color.onAccent : color.text} strokeWidth={1.65} />
      ) : (
        children
      )}
    </Pressable>
  );
}

export function CategoryDock({
  selected,
  onSelect,
  onInbox,
}: {
  selected: Category | "all";
  onSelect: (id: Category) => void;
  onInbox: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { desktop } = useDesktopLayout();
  if (desktop) return null;
  return (
    <View
      style={[floating.dock, { bottom: Math.max(insets.bottom, 14) }]}
      accessibilityLabel="Creative worlds"
    >
      {worlds.map((w) => (
        <FloatButton
          key={w.id}
          label={w.title}
          active={
            selected === w.id || (selected === "video" && w.id === "music")
          }
          onPress={() => onSelect(w.id)}
        >
          <WorldGlyph id={w.id} active={selected === w.id || (selected === "video" && w.id === "music")} />
        </FloatButton>
      ))}
      <FloatButton label="Inbox" onPress={onInbox}>
        <WorldGlyph id="inbox" />
      </FloatButton>
    </View>
  );
}

export function Sheet({
  title,
  children,
  onClose,
}: PropsWithChildren<{ title: string; onClose: () => void }>) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: "#0007",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss panel"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={{
            maxHeight: "80%",
            minHeight: 200,
            backgroundColor: color.bg,
            borderTopLeftRadius: 27,
            borderTopRightRadius: 27,
            paddingBottom: Math.max(insets.bottom, 22),
            borderWidth: 1,
            borderColor: color.border,
          }}
        >
          <View
            style={{
              width: 36,
              height: 4,
              backgroundColor: "#756C82",
              borderRadius: 3,
              alignSelf: "center",
              marginTop: 10,
            }}
          />
          <View
            style={[
              styles.between,
              { paddingHorizontal: 22, paddingVertical: 10 },
            ]}
          >
            <Text style={[styles.heading, { fontSize: 21 }]}>{title}</Text>
            <FloatButton label="Close panel" icon={X} plain onPress={onClose} />
          </View>
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 22,
              gap: 16,
              paddingBottom: 12,
            }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export const floating = themedStyles(() => ({
  dock: {
    position: "absolute",
    left: 14,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 9,
    paddingHorizontal: 6,
    backgroundColor: color.dock,
    borderRadius: 45,
    borderWidth: 1,
    borderColor: color.border,
    elevation: 12,
    boxShadow: "0 8px 22px #0006",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 22,
    height: 76,
  },
  small: { color: color.muted, fontFamily: font.regular, fontSize: 13 },
}));
