import { StyleSheet } from "react-native";
import { useSyncExternalStore } from "react";
import { appearanceStore, palettes, themeRecord, type ThemeColor } from "./lib/appearance";
export const color = Object.defineProperties({} as Record<ThemeColor, string>,
  Object.fromEntries(Object.keys(palettes.dark).map(key => [key, { enumerable: true,
    get: () => palettes[appearanceStore.getSnapshot().resolvedMode][key as ThemeColor] }])));
export function useTheme() {
  return useSyncExternalStore(appearanceStore.subscribe, appearanceStore.getSnapshot, appearanceStore.getSnapshot);
}
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(factory: () => T): T {
  return themeRecord(() => StyleSheet.create(factory()), () => appearanceStore.getSnapshot().resolvedMode);
}
export function themeValue<T>(dark: T, light: T): T {
  return appearanceStore.getSnapshot().resolvedMode === "light" ? light : dark;
}
export const font = {
  regular: "Barlow",
  medium: "BarlowMedium",
  semibold: "BarlowSemiBold",
  bold: "BarlowBold",
};
export const styles = themedStyles(() => ({
  screen: { flex: 1, backgroundColor: color.bg },
  page: { padding: 22, paddingBottom: 32, gap: 22 },
  title: {
    fontFamily: font.bold,
    color: color.text,
    fontSize: 36,
    lineHeight: 39,
    letterSpacing: -1,
  },
  heading: {
    fontFamily: font.semibold,
    color: color.text,
    fontSize: 24,
    letterSpacing: -0.5,
  },
  body: {
    fontFamily: font.regular,
    color: color.muted,
    fontSize: 16,
    lineHeight: 24,
  },
  small: {
    fontFamily: font.regular,
    color: color.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  eyebrow: {
    fontFamily: font.medium,
    color: color.lime,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  panel: {
    backgroundColor: color.panel,
    borderColor: color.border,
    borderWidth: 1,
    padding: 20,
    borderRadius: 22,
    gap: 14,
  },
  label: {
    color: color.text,
    fontFamily: font.medium,
    fontSize: 14,
    marginBottom: 8,
  },
  input: {
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 13,
    paddingHorizontal: 15,
    paddingVertical: 13,
    color: color.text,
    fontFamily: font.regular,
    fontSize: 16,
    minHeight: 50,
  },
  error: {
    color: color.danger,
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
  },
  separator: { height: 1, backgroundColor: color.border },
}));
