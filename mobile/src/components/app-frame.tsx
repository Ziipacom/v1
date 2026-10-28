import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaFrame,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { iosLimitedTestflight } from "../lib/config";
import { color, useTheme } from "../theme";

/** Keep the beta notice below the notch, outside the navigation content frame. */
export function AppFrame({
  notice,
  children,
}: {
  notice: ReactNode;
  children: ReactNode;
}) {
  useTheme();
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const contentMetrics = useMemo(
    () => ({ frame, insets: { ...insets, top: 0 } }),
    [frame, insets],
  );

  return (
    <View style={{ flex: 1 }}>
      <View
        style={
          iosLimitedTestflight
            ? {
                backgroundColor: color.panel,
                paddingTop: insets.top,
                paddingLeft: insets.left,
                paddingRight: insets.right,
              }
            : undefined
        }
      >
        {notice}
      </View>
      {iosLimitedTestflight ? (
        // Native SafeAreaView reads its closest native provider, not only the
        // JS insets context. This stable provider measures the remaining frame
        // below the notice; its initial top is already consumed above. It stays
        // mounted when the operator notice changes, preserving navigation/drafts.
        <SafeAreaProvider style={{ flex: 1 }} initialMetrics={contentMetrics}>
          {children}
        </SafeAreaProvider>
      ) : (
        children
      )}
    </View>
  );
}
