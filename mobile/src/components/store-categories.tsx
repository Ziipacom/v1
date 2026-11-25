import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { productCategories } from "../lib/commerce";
import { color, styles } from "../theme";

export function StoreCategories({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = [
    { id: "all", title: "All categories" },
    ...productCategories,
  ];
  const current =
    choices.find((entry) => entry.id === value)?.title || "All categories";
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Category: ${current}`}
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{
          minHeight: 44,
          paddingHorizontal: 14,
          paddingVertical: 10,
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          backgroundColor: color.panel,
          borderRadius: 12,
        }}
      >
        <Text style={[styles.body, { flex: 1 }]}>{current}</Text>
        {open ? (
          <ChevronUp size={17} color={color.muted} />
        ) : (
          <ChevronDown size={17} color={color.muted} />
        )}
      </Pressable>
      {open && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {choices.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="radio"
              accessibilityLabel={entry.title}
              accessibilityState={{ checked: value === entry.id }}
              aria-checked={value === entry.id}
              onPress={() => {
                onChange(entry.id);
                setOpen(false);
              }}
              style={{
                width: "48%",
                flexGrow: 1,
                minWidth: 115,
                minHeight: 44,
                padding: 12,
                borderRadius: 12,
                backgroundColor:
                  value === entry.id ? color.purple : color.panel,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Text style={[styles.small, { flex: 1, color: color.text }]}>
                {entry.title}
              </Text>
              {value === entry.id && <Check size={15} color={color.text} />}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
