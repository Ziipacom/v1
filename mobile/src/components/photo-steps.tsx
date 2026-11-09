import { Pressable, Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { font } from "../theme";

export function PhotoSteps({
  index,
  count,
  onChange,
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
}) {
  if (count < 2) return null;
  const arrow = (direction: -1 | 1) => {
    const next = index + direction;
    const disabled = next < 0 || next >= count;
    const Arrow = direction < 0 ? ChevronLeft : ChevronRight;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction < 0 ? "Previous photo" : "Next photo"}
        disabled={disabled}
        onPress={() => onChange(next)}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1 }}
      >
        <Arrow size={18} color="white" />
      </Pressable>
    );
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", borderRadius: 24, backgroundColor: "#110D1CE6" }}>
      {arrow(-1)}
      <Text accessibilityLiveRegion="polite" style={{ color: "white", fontFamily: font.medium }}>
        {index + 1} / {count}
      </Text>
      {arrow(1)}
    </View>
  );
}
