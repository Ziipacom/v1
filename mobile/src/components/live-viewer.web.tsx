import { createElement, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import Hls from "hls.js";
import { checkedLivePlayback } from "../lib/live-types";
import { styles } from "../theme";

export function LiveViewer({ url }: { url: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = video.current;
    if (!element || !checkedLivePlayback(url)) {
      setError("This stream has no approved playback source.");
      return;
    }
    let player: Hls | undefined;
    let active = true;
    setError("");
    const fail = () => {
      if (active)
        setError(
          "Live playback is unavailable. Refresh the stream or try another broadcast.",
        );
    };
    element.addEventListener("error", fail);
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = url;
      void element.play().catch(() => {});
    } else if (Hls.isSupported()) {
      player = new Hls({
        maxBufferLength: 15,
        maxMaxBufferLength: 30,
        backBufferLength: 0,
        xhrSetup(xhr, requestUrl) {
          const parsed = new URL(requestUrl);
          const allowed =
            [
              "playback.livepeer.studio",
              "livepeercdn.studio",
              "livepeercdn.com",
              "lp-playback.studio",
            ].includes(parsed.hostname) ||
            parsed.hostname.endsWith(".livepeercdn.studio") ||
            parsed.hostname.endsWith(".lp-playback.studio");
          if (
            !allowed ||
            parsed.protocol !== "https:" ||
            parsed.username ||
            parsed.password ||
            parsed.port
          )
            throw new Error("Unapproved media source.");
          xhr.withCredentials = false;
        },
      });
      player.on(Hls.Events.MANIFEST_PARSED, () => {
        if (active) void element.play().catch(() => {});
      });
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          fail();
          player?.destroy();
        }
      });
      player.loadSource(url);
      player.attachMedia(element);
    } else
      setError(
        "This browser does not support live HLS video. Try an updated Chrome or Safari browser.",
      );
    return () => {
      active = false;
      player?.destroy();
      element.removeEventListener("error", fail);
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  return (
    <View style={{ gap: 10 }}>
      {createElement("video", {
        ref: video,
        controls: true,
        muted: true,
        autoPlay: true,
        playsInline: true,
        crossOrigin: "anonymous",
        "aria-label": "Ziipa public live broadcast",
        style: {
          display: "block",
          width: "100%",
          aspectRatio: "9 / 12",
          background: "black",
          borderRadius: 18,
          objectFit: "contain",
        },
      })}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}
