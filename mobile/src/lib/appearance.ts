export type AppearanceMode = "dark" | "light" | "system";
export type ResolvedAppearance = "dark" | "light";

export const palettes = {
  dark: {
    bg: "#120D1F", panel: "#211C2C", raised: "#2C213B", border: "#383040",
    text: "#FAF7FF", muted: "#B5A8C7", faint: "#87789A", purple: "#5420AB",
    lime: "#A6E21B", danger: "#FFA6A6", onAccent: "#FFFFFF", onMedia: "#FFFFFF",
    accentSoft: "#5420AB45", hover: "#FFFFFF09", errorPanel: "#341C2B", errorBorder: "#71394D",
    sidebar: "#100B1B", input: "#1A1425", dock: "#09060E", onLime: "#142000",
  },
  light: {
    bg: "#F5F3FA", panel: "#FFFFFF", raised: "#ECE5F4", border: "#CFC3DD",
    text: "#21132E", muted: "#5D4D70", faint: "#746281", purple: "#5420AB",
    lime: "#427500", danger: "#B22040", onAccent: "#FFFFFF", onMedia: "#FFFFFF",
    accentSoft: "#E9DFF5", hover: "#EEE7F7", errorPanel: "#FCE8ED", errorBorder: "#DC8BA0",
    sidebar: "#FFFFFF", input: "#F1EDF7", dock: "#FFFFFF", onLime: "#FFFFFF",
  },
} as const;
export type ThemeColor = keyof typeof palettes.dark;
export type AppearanceSnapshot = { mode: AppearanceMode; resolvedMode: ResolvedAppearance };

export function resolveAppearance(mode: AppearanceMode, system: unknown): ResolvedAppearance {
  return mode === "system" ? system === "light" ? "light" : "dark" : mode;
}

/** Pure external state: palette updates never recreate navigation or editor state. */
export function createAppearanceStore(initialMode: AppearanceMode = "dark", initialSystem: unknown = "dark") {
  let system = initialSystem;
  let snapshot: AppearanceSnapshot = { mode: initialMode, resolvedMode: resolveAppearance(initialMode, system) };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(mode: AppearanceMode, systemValue: unknown = system) {
      if (!["dark", "light", "system"].includes(mode)) throw new Error("Choose Dark, Light or System appearance.");
      system = systemValue;
      const resolvedMode = resolveAppearance(mode, system);
      if (mode === snapshot.mode && resolvedMode === snapshot.resolvedMode) return;
      snapshot = { mode, resolvedMode };
      for (const listener of listeners) listener();
    },
  };
}

export const appearanceStore = createAppearanceStore();

/** Style factories are cached by palette, while their public object stays stable. */
export function themeRecord<T extends object>(factory: () => T, palette: () => ResolvedAppearance): T {
  const cache = new Map<ResolvedAppearance, T>();
  const current = () => {
    const key = palette();
    if (!cache.has(key)) cache.set(key, factory());
    return cache.get(key)!;
  };
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(current(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
