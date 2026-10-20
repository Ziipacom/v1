import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, font } from "../theme";

/** Used only by desktop branches. Shared data and action components stay in place. */
export function WorkspaceHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <View style={workspace.heading}>
      <View style={{ flex: 1, gap: 6, minWidth: 220 }}>
        <Text accessibilityRole="header" style={workspace.title}>
          {title}
        </Text>
        {description && (
          <Text style={workspace.description}>{description}</Text>
        )}
      </View>
      {actions && <View style={workspace.actions}>{actions}</View>}
    </View>
  );
}

export const workspace = StyleSheet.create({
  page: {
    width: "100%",
    maxWidth: 1240,
    alignSelf: "center",
    padding: 28,
    paddingBottom: 40,
    gap: 20,
  },
  narrow: { maxWidth: 1040 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    flexWrap: "wrap",
    marginBottom: 4,
  },
  title: {
    fontFamily: font.semibold,
    fontSize: 27,
    lineHeight: 33,
    color: color.text,
    letterSpacing: -0.5,
  },
  description: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    color: color.muted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  columns: { flexDirection: "row", alignItems: "flex-start", gap: 24 },
  main: { flex: 1, minWidth: 0, gap: 20 },
  rail: { width: 320, gap: 20 },
  panel: {
    borderRadius: 12,
    padding: 20,
    gap: 14,
    backgroundColor: "#1A1525",
    borderWidth: 1,
    borderColor: "#302738",
  },
});
