import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AccessibilityInfo } from "react-native";
import {
  defaultDevicePreferences,
  devicePreferencesKey,
  parseDevicePreferences,
  serializeDevicePreferences,
  updateDevicePreferences,
  type DevicePreferences,
} from "../lib/device-preferences";

type Value = {
  preferences: DevicePreferences;
  ready: boolean;
  reducedMotion: boolean;
  error: string;
  update: (patch: Partial<DevicePreferences>) => Promise<void>;
};
const Context = createContext<Value | null>(null);
export function DevicePreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<DevicePreferences>({
    ...defaultDevicePreferences,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [systemReducedMotion, setSystemReducedMotion] = useState(true);
  const current = useRef(preferences);
  const mounted = useRef(true);
  const loaded = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    void AsyncStorage.getItem(devicePreferencesKey)
      .then((raw) => {
        if (!mounted.current) return;
        current.current = parseDevicePreferences(raw);
        setPreferences(current.current);
      })
      .catch(() => {
        if (mounted.current)
          setError(
            "Device preferences could not load. Ziipa is using its safe defaults.",
          );
      })
      .finally(() => {
        if (mounted.current) {
          loaded.current = true;
          setReady(true);
        }
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setSystemReducedMotion(value);
      })
      .catch(() => {});
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setSystemReducedMotion,
    );
    return () => {
      active = false;
      listener.remove();
    };
  }, []);
  const update = useCallback((patch: Partial<DevicePreferences>) => {
    if (!loaded.current)
      return Promise.reject(new Error("Wait for device preferences to load."));
    // Serialize changes so rapid switches cannot overwrite a newer preference.
    const operation = queue.current
      .catch(() => {})
      .then(async () => {
        const next = updateDevicePreferences(current.current, patch);
        await AsyncStorage.setItem(
          devicePreferencesKey,
          serializeDevicePreferences(next),
        );
        current.current = next;
        if (mounted.current) {
          setPreferences(next);
          setError("");
        }
      });
    queue.current = operation;
    return operation;
  }, []);
  return (
    <Context.Provider
      value={{
        preferences,
        ready,
        reducedMotion: systemReducedMotion || preferences.reduceMotion,
        error,
        update,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useDevicePreferences() {
  const value = useContext(Context);
  if (!value) throw new Error("DevicePreferencesProvider is missing.");
  return value;
}
