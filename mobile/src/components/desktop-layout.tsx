import {
  createContext,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Platform, useWindowDimensions } from "react-native";
import { isDesktopPortal } from "../lib/desktop-navigation";
import { portalMode } from "../lib/config";

type DesktopLayout = {
  desktop: boolean;
  contentWidth: number;
  measureContent: (width: number) => void;
};
const Context = createContext<DesktopLayout>({
  desktop: false,
  contentWidth: 0,
  measureContent: () => {},
});

/** Native devices and compact web always retain the original Figma layout. */
export function DesktopLayoutProvider({ children }: PropsWithChildren) {
  const { width } = useWindowDimensions();
  const desktop = portalMode && isDesktopPortal(Platform.OS, width);
  const [measured, setMeasured] = useState(0);
  const value = useMemo(
    () => ({
      desktop,
      contentWidth: desktop ? measured || Math.max(0, width - 240) : width,
      measureContent: (next: number) => {
        if (Number.isFinite(next) && next > 0) setMeasured(Math.round(next));
      },
    }),
    [desktop, measured, width],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDesktopLayout() {
  return useContext(Context);
}
