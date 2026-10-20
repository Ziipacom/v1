import { createElement, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { soundCloudWidgetUrl } from "../lib/soundcloud-links";
import { styles } from "../theme";

export function SoundCloudWidget({
  url,
  title,
}: {
  url: string;
  title: string;
}) {
  const focused = useIsFocused();
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const source = soundCloudWidgetUrl(url);
  if (!source || !focused || !visible)
    return (
      <Text style={styles.small}>
        Official SoundCloud player paused or unavailable.
      </Text>
    );
  return (
    <View style={{ height: 180, borderRadius: 10, overflow: "hidden" }}>
      {createElement("iframe", {
        src: source,
        title: `SoundCloud: ${title}`,
        style: { width: "100%", height: "100%", border: 0 },
        sandbox: "allow-scripts allow-same-origin",
        allow: "encrypted-media",
        referrerPolicy: "no-referrer",
        loading: "lazy",
      })}
    </View>
  );
}
