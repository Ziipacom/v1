import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { WebView } from "react-native-webview";
import {
  soundCloudWidgetNavigationOrigins,
  soundCloudWidgetUrl,
} from "../lib/soundcloud-links";
import { styles } from "../theme";

export function SoundCloudWidget({
  url,
  title,
}: {
  url: string;
  title: string;
}) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  const source = soundCloudWidgetUrl(url);
  if (!source || !focused || !foreground)
    return (
      <Text style={styles.small}>
        Official SoundCloud player paused or unavailable.
      </Text>
    );
  return (
    <View style={{ height: 180, borderRadius: 10, overflow: "hidden" }}>
      <WebView
        accessibilityLabel={`SoundCloud: ${title}`}
        source={{ uri: source }}
        // RN WebView otherwise auto-opens outsiders with Linking before this
        // callback. Route every navigation to our strict player-only validator.
        originWhitelist={[...soundCloudWidgetNavigationOrigins]}
        onShouldStartLoadWithRequest={(request) =>
          !!soundCloudWidgetUrl(request.url)
        }
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        geolocationEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction
        allowsInlineMediaPlayback
        mixedContentMode="never"
      />
    </View>
  );
}
