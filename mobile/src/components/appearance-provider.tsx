import { useCallback, useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import { Appearance, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { appearanceStore, type AppearanceMode } from "../lib/appearance";
import { color, useTheme } from "../theme";
import { useDevicePreferences } from "./device-preferences";

/** Controls palette/native chrome only; children are never keyed by appearance. */
export function AppearanceProvider({ children }: PropsWithChildren) {
  const { preferences } = useDevicePreferences();
  useEffect(() => {
    const listener = Appearance.addChangeListener(({ colorScheme }) => {
      appearanceStore.set(appearanceStore.getSnapshot().mode, colorScheme);
    });
    return () => listener.remove();
  }, []);
  useLayoutEffect(() => {
    if (Platform.OS !== "web") Appearance.setColorScheme(preferences.appearance === "system" ? "unspecified" : preferences.appearance);
    appearanceStore.set(preferences.appearance, Appearance.getColorScheme());
  }, [preferences.appearance]);
  return <>{children}</>;
}

export function useAppearance() {
  const { preferences, ready, error, update } = useDevicePreferences();
  const { resolvedMode } = useTheme();
  const setMode = useCallback((mode: AppearanceMode) => update({ appearance: mode }), [update]);
  return { mode: preferences.appearance, resolvedMode, setMode, ready, error };
}

export function AppearanceChrome() {
  const { resolvedMode } = useTheme();
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const root = document.documentElement;
    const previousScheme = root.style.colorScheme;
    const previousBackground = document.body.style.backgroundColor;
    root.style.colorScheme = resolvedMode;
    document.body.style.backgroundColor = color.bg;
    return () => { root.style.colorScheme = previousScheme; document.body.style.backgroundColor = previousBackground; };
  }, [resolvedMode]);
  return <StatusBar style={resolvedMode === "dark" ? "light" : "dark"} />;
}
