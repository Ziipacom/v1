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
import { color, font, styles } from "../theme";
import { conceptsEnabled } from "../lib/config";
import type { Category } from "../lib/types";

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
].filter((w) => conceptsEnabled || !w.concept) as {
  id: Category;
  title: string;
  icon: LucideIcon;
  concept?: boolean;
}[];

export function WorldGlyph({
  id,
  size = 24,
}: {
  id: Category | "inbox";
  size?: number;
}) {
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
        <Hexagon size={size + 6} fill={color.text} color={color.text} />
        <Text
          style={{
            position: "absolute",
            color: color.bg,
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
        <Video size={size - 3} color={color.text} fill={color.text} />
        <Text
          style={{
            color: color.text,
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
      color={color.text}
      fill={id === "music" ? color.text : "none"}
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
}: PropsWithChildren<{
  label: string;
  icon?: LucideIcon;
  onPress: () => void;
  active?: boolean;
  size?: number;
  plain?: boolean;
}>) {
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
        borderColor: active ? color.purple : "#AAA3B5",
        backgroundColor: active
          ? color.purple
          : plain
            ? "transparent"
            : "#0B0814B8",
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      {Icon ? (
        <Icon size={24} color={color.text} strokeWidth={1.65} />
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
  selected: Category;
  onSelect: (id: Category) => void;
  onInbox: () => void;
}) {
  const insets = useSafeAreaInsets();
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
          <WorldGlyph id={w.id} />
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

export const floating = StyleSheet.create({
  dock: {
    position: "absolute",
    left: 14,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 9,
    paddingHorizontal: 6,
    backgroundColor: "#09060EF2",
    borderRadius: 45,
    borderWidth: 1,
    borderColor: "#3C3348",
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
  small: { color: "#D2CADC", fontFamily: font.regular, fontSize: 13 },
});
