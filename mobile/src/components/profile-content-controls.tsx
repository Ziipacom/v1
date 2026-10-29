import { Pressable, Text, View } from "react-native";
import {
  Bookmark,
  ContactRound,
  Grid3X3,
  Images,
  RefreshCw,
} from "lucide-react-native";
import type { ProfileCollection } from "../lib/profile-collections";
import { color, font } from "../theme";

export function ProfileContentControls({
  collection,
  grid,
  onCollection,
  onGrid,
  onGallery,
  onReset,
  visitor = false,
}: {
  collection: ProfileCollection;
  grid: boolean;
  visitor?: boolean;
  onCollection: (value: ProfileCollection) => void;
  onGrid: () => void;
  onReset: () => void;
  onGallery: () => void;
}) {
  const buttons = [
    {
      Icon: RefreshCw,
      label: "Reset Profile to all creations",
      selected: false,
      onPress: onReset,
    },
    {
      Icon: Images,
      label: "Open creator Gallery",
      selected: false,
      onPress: onGallery,
    },
    {
      Icon: Grid3X3,
      label: "Show profile as a grid",
      selected: collection === "creations" && grid,
      onPress: onGrid,
    },
    {
      Icon: Bookmark,
      label:
        collection === "saved"
          ? "Show creations"
          : visitor
            ? "Saved collections are private"
            : "Show saved creations",
      selected: collection === "saved",
      onPress: () =>
        onCollection(collection === "saved" ? "creations" : "saved"),
    },
    {
      Icon: ContactRound,
      label: "Show tagged media",
      selected: collection === "tagged",
      onPress: () =>
        onCollection(collection === "tagged" ? "creations" : "tagged"),
    },
  ];
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}
    >
      <Text
        style={{
          color: color.faint,
          fontFamily: font.regular,
          fontSize: 12,
          marginRight: 3,
        }}
      >
        {collection === "saved"
          ? "Saved"
          : collection === "tagged"
            ? "Tagged"
            : "Creations"}
      </Text>
      {buttons.map(({ Icon, label, selected, onPress }) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected }}
          aria-pressed={selected}
          onPress={onPress}
          style={{
            minWidth: Icon === RefreshCw ? 44 : 36,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={17} color={selected ? color.lime : color.muted} />
        </Pressable>
      ))}
    </View>
  );
}
