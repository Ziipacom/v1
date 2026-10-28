import type { PropsWithChildren } from "react";
import { Pressable, Text, View } from "react-native";
import { Minus, Plus, type LucideIcon } from "lucide-react-native";
import { color, styles, useTheme } from "../theme";

export function Disclosure({
  title,
  detail,
  icon: Icon,
  expanded,
  onToggle,
  children,
}: PropsWithChildren<{
  title: string;
  detail?: string;
  icon?: LucideIcon;
  expanded: boolean;
  onToggle: () => void;
}>) {
  useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: expanded ? color.purple : color.border,
        borderRadius: 18,
        backgroundColor: color.panel,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: "row",
          gap: 12,
          alignItems: "center",
          minHeight: 70,
          padding: 16,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {Icon && <Icon size={21} color={expanded ? color.lime : color.text} strokeWidth={1.7} />}
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[styles.label, { marginBottom: 0 }]}>{title}</Text>
          {!!detail && (
            <Text numberOfLines={1} style={[styles.small, { fontSize: 12 }]}>
              {detail}
            </Text>
          )}
        </View>
        {expanded ? <Minus size={19} color={color.lime} /> : <Plus size={19} color={color.muted} />}
      </Pressable>
      {expanded && <View style={{ padding: 16, paddingTop: 4, gap: 15 }}>{children}</View>}
    </View>
  );
}
