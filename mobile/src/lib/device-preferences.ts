export type AppearancePreference = "system" | "dark" | "light";
export type DevicePreferences = {
  appearance: AppearancePreference;
  autoplay: boolean;
  startMuted: boolean;
  reduceMotion: boolean;
};
export const devicePreferencesKey = "@ziipa.device-preferences.v1";
export const defaultDevicePreferences: DevicePreferences = {
  appearance: "dark",
  autoplay: true,
  startMuted: true,
  reduceMotion: false,
};
export function parseDevicePreferences(raw: string | null): DevicePreferences {
  if (!raw) return { ...defaultDevicePreferences };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ...defaultDevicePreferences };
    const data = value as Record<string, unknown>;
    if (data.version !== 1) return { ...defaultDevicePreferences };
    return {
      appearance:
        data.appearance === "system" ||
        data.appearance === "light" ||
        data.appearance === "dark"
          ? data.appearance
          : "dark",
      autoplay: typeof data.autoplay === "boolean" ? data.autoplay : true,
      startMuted: typeof data.startMuted === "boolean" ? data.startMuted : true,
      reduceMotion:
        typeof data.reduceMotion === "boolean" ? data.reduceMotion : false,
    };
  } catch {
    return { ...defaultDevicePreferences };
  }
}
export function updateDevicePreferences(
  current: DevicePreferences,
  patch: Partial<DevicePreferences>,
): DevicePreferences {
  if (
    Object.keys(patch).some(
      (key) =>
        !["appearance", "autoplay", "startMuted", "reduceMotion"].includes(key),
    )
  )
    throw new Error("Unknown device preference.");
  if (
    patch.appearance !== undefined &&
    !["system", "dark", "light"].includes(patch.appearance)
  )
    throw new Error("Choose system, dark or light appearance.");
  for (const key of ["autoplay", "startMuted", "reduceMotion"] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean")
      throw new Error("Choose an on or off preference.");
  }
  const next = { ...current };
  if (patch.appearance !== undefined) next.appearance = patch.appearance;
  for (const key of ["autoplay", "startMuted", "reduceMotion"] as const)
    if (patch[key] !== undefined) next[key] = patch[key];
  return next;
}
export function serializeDevicePreferences(preferences: DevicePreferences) {
  return JSON.stringify({
    version: 1,
    ...updateDevicePreferences(defaultDevicePreferences, preferences),
  });
}
