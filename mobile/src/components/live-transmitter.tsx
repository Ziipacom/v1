import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AppState, Linking, NativeModules, Text, View } from "react-native";
import { fetch as nativeFetch } from "expo/fetch";
import * as Clipboard from "expo-clipboard";
import {
  Camera,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal,
  Mic,
  MicOff,
  Radio,
  Square,
} from "lucide-react-native";
import type { MediaStream, RTCPeerConnection } from "react-native-webrtc";
import { Action } from "./ui";
import {
  boundedSdp,
  checkedWhipUrl,
  type LiveIngest,
  type LiveTransmitterHandle,
  type LiveTransmitterProps,
} from "../lib/live-types";
import { NativeLiveSession } from "../lib/native-live-session";
import { discoverNativeWhipEdge } from "../lib/native-live-whip";
import { color, styles } from "../theme";

// Old preview binaries and Expo Go do not have this module. Keep the screen
// usable with an explicit upgrade notice instead of crashing at module import.
const rtc: typeof import("react-native-webrtc") | null =
  NativeModules.WebRTCModule ? require("react-native-webrtc") : null;
const CameraView = rtc?.RTCView;

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      peer.onicegatheringstatechange = null;
      signal.removeEventListener("abort", cancel);
    };
    const done = () => {
      clean();
      resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const cancel = () => {
      clean();
      reject(new Error("Connection cancelled."));
    };
    const timer = setTimeout(done, 5000);
    peer.onicegatheringstatechange = changed;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else changed();
  });
}

/** Foreground, send-only native WebRTC camera transport; server status alone asserts LIVE. */
export const LiveTransmitter = forwardRef<
  LiveTransmitterHandle,
  LiveTransmitterProps
>(function LiveTransmitter(
  { enabled, canStart, busy, onStart, onStop, onTransport },
  ref,
) {
  const session = useRef(new NativeLiveSession<MediaStream>()).current;
  const mounted = useRef(true);
  const attempt = useRef(false);
  const permissionPending = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopRef = useRef(onStop);
  const noticeRef = useRef(onTransport);
  stopRef.current = onStop;
  noticeRef.current = onTransport;
  const [mode, setMode] = useState<"camera" | "encoder">("camera");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [muted, setMuted] = useState(false);
  const [front, setFront] = useState(true);
  const [flipping, setFlipping] = useState(false);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<LiveIngest | null>(null);
  const [revealed, setRevealed] = useState(false);

  function shutdown(end: boolean) {
    clearTimeout(timeout.current);
    const peer = session.peer as RTCPeerConnection | null;
    if (peer) peer.onconnectionstatechange = null;
    session.stream?.getTracks().forEach((track) => {
      track.onended = null;
    });
    session.stop();
    permissionPending.current = false;
    const shouldEnd = attempt.current;
    attempt.current = false;
    if (mounted.current) {
      setStreamUrl(null);
      setPending(false);
      setSending(false);
      setMuted(false);
      setFlipping(false);
      setCredentials(null);
      setRevealed(false);
    }
    if (end && shouldEnd) void stopRef.current().catch(() => {});
  }
  useImperativeHandle(ref, () => ({ stopLocal: () => shutdown(false) }));
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      // iOS temporarily becomes inactive while its own permission sheet is up.
      // No stream or public ingest exists yet. A real background transition
      // still cancels the request, and any late result is released by session.
      if (
        state === "inactive" &&
        permissionPending.current &&
        !session.stream &&
        !attempt.current
      )
        return;
      if (state !== "active") {
        const hadCamera = !!session.stream || attempt.current;
        shutdown(true);
        if (hadCamera)
          noticeRef.current(
            "Camera and microphone stopped because Ziipa left the foreground. Check the broadcast status before restarting.",
          );
      }
    });
    return () => {
      mounted.current = false;
      shutdown(true);
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (!enabled) shutdown(true);
  }, [enabled]);

  async function preview() {
    if (!rtc || !enabled || pending || busy || session.stream) return;
    setPending(true);
    setError("");
    permissionPending.current = true;
    // capture increments synchronously before the native permission request.
    const current = session.generation + 1;
    try {
      const stream = await session.capture(() =>
        rtc.mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode: "user",
            width: 720,
            height: 1280,
            frameRate: 30,
          },
        }),
      );
      if (!stream) return; // A late permission result has already been released.
      if (
        !mounted.current ||
        current !== session.generation ||
        AppState.currentState !== "active"
      ) {
        if (current === session.generation) shutdown(true);
        return;
      }
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (current !== session.generation) return;
          shutdown(true);
          setError(
            "Camera or microphone stopped. The broadcast connection has been closed.",
          );
        };
      });
      setFront(true);
      setMuted(false);
      setStreamUrl(stream.toURL());
    } catch {
      if (mounted.current && current === session.generation) {
        shutdown(true);
        setError(
          "Camera or microphone access failed. Allow both permissions in device settings, close other camera apps, then retry. You can mute your microphone after enabling the preview.",
        );
      }
    } finally {
      if (mounted.current && current === session.generation) {
        permissionPending.current = false;
        setPending(false);
      }
    }
  }

  async function broadcast() {
    if (
      !rtc ||
      !enabled ||
      !canStart ||
      busy ||
      pending ||
      !session.stream ||
      attempt.current
    )
      return;
    const current = session.generation;
    const stream = session.stream;
    setPending(true);
    setError("");
    attempt.current = true;
    try {
      const ingest = await onStart();
      if (!mounted.current || current !== session.generation) return;
      const endpoint = checkedWhipUrl(ingest.whip_url);
      const abort = new AbortController();
      session.abort = abort;
      timeout.current = setTimeout(() => {
        if (mounted.current && current === session.generation) {
          shutdown(true);
          setError(
            "Broadcast connection timed out. Camera and microphone are stopped. Check the provider status before retrying.",
          );
        }
      }, 25000);
      // Named Expo fetch supports bounded streamed SDP on both native platforms.
      // No Ziipa auth header, cookie, or Livepeer API key goes to this endpoint.
      const edge = await discoverNativeWhipEdge(
        endpoint,
        abort.signal,
        nativeFetch,
      );
      if (current !== session.generation) return;
      const connection = new rtc.RTCPeerConnection({
        iceServers: [
          { urls: "stun:" + edge.hostname },
          {
            urls: "turn:" + edge.hostname,
            username: "livepeer",
            credential: "livepeer",
          },
        ],
      });
      session.peer = connection;
      connection.onconnectionstatechange = () => {
        if (!mounted.current || current !== session.generation) return;
        if (connection.connectionState === "connected") {
          clearTimeout(timeout.current);
          setPending(false);
          setSending(true);
          noticeRef.current(
            "Native camera transport connected. Waiting for Livepeer to verify that the broadcast is live.",
          );
        } else if (
          ["failed", "disconnected"].includes(connection.connectionState)
        ) {
          shutdown(true);
          setError(
            "Broadcast connection was interrupted. Camera and microphone are stopped; check server status before retrying.",
          );
        }
      };
      for (const track of stream.getTracks()) {
        const transceiver = connection.addTransceiver(track, {
          direction: "sendonly",
          streams: [stream],
        });
        if (track.kind === "video") {
          const codecs =
            rtc.RTCRtpSender.getCapabilities("video")?.codecs || [];
          const preferred = codecs.filter(
            (codec) => codec.mimeType.toLowerCase() === "video/h264",
          );
          if (preferred.length)
            transceiver.setCodecPreferences([
              ...preferred,
              ...codecs.filter((codec) => !preferred.includes(codec)),
            ]);
        }
      }
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIce(connection, abort.signal);
      if (current !== session.generation || abort.signal.aborted) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp || sdp.length > 256 * 1024)
        throw new Error("Invalid local offer.");
      const response = await nativeFetch(
        edge.toString().replace("video+", ""),
        {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: sdp,
          credentials: "omit",
          redirect: "error",
          signal: abort.signal,
        },
      );
      const answer = await boundedSdp(response);
      if (current !== session.generation || abort.signal.aborted) return;
      await connection.setRemoteDescription({ type: "answer", sdp: answer });
    } catch {
      // Never render raw native/network exceptions: they may include the ingest key.
      if (mounted.current && current === session.generation) {
        shutdown(true);
        setError(
          "Could not connect public video transport. Camera and microphone are stopped. Check the provider configuration and broadcast status before preparing a new broadcast.",
        );
      }
    }
  }

  async function flip() {
    const track = session.stream?.getVideoTracks()[0];
    if (!track || flipping || pending) return;
    const current = session.generation;
    setFlipping(true);
    try {
      await track.applyConstraints({
        facingMode: front ? "environment" : "user",
        width: 720,
        height: 1280,
        frameRate: 30,
      });
      if (mounted.current && current === session.generation) setFront(!front);
    } catch {
      if (mounted.current && current === session.generation)
        setError(
          "This device could not switch cameras. Check the preview; stop and enable the camera again if video has stopped.",
        );
    } finally {
      if (mounted.current && current === session.generation) setFlipping(false);
    }
  }
  async function connectEncoder() {
    if (!enabled || !canStart || busy || pending || attempt.current) return;
    const current = session.generation;
    setPending(true);
    setError("");
    attempt.current = true;
    try {
      const value = await onStart();
      if (mounted.current && current === session.generation) {
        setCredentials(value);
        onTransport(
          "Connect your external encoder. Ziipa only marks the broadcast live after Livepeer verifies incoming media.",
        );
      }
    } catch {
      if (mounted.current && current === session.generation) shutdown(true);
    } finally {
      if (mounted.current && current === session.generation) setPending(false);
    }
  }
  async function copy(value: string) {
    try {
      await Clipboard.setStringAsync(value);
      onTransport(
        "Copied encoder setting. Keep it private and clear your clipboard after setup.",
      );
    } catch {
      onTransport(
        "Clipboard is unavailable. Reveal and enter the setting manually.",
      );
    }
  }

  return (
    <View style={[styles.panel, { padding: 12 }]}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Action
            title="Phone camera"
            icon={Camera}
            secondary={mode !== "camera"}
            disabled={pending || attempt.current}
            onPress={() => {
              shutdown(false);
              setMode("camera");
              setError("");
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Action
            title="External encoder"
            icon={Radio}
            secondary={mode !== "encoder"}
            disabled={pending || attempt.current}
            onPress={() => {
              shutdown(false);
              setMode("encoder");
              setError("");
            }}
          />
        </View>
      </View>
      {mode === "camera" ? (
        <>
          <View
            style={{
              aspectRatio: 9 / 12,
              backgroundColor: "#09070F",
              borderRadius: 20,
              overflow: "hidden",
              justifyContent: "center",
            }}
          >
            {CameraView && streamUrl ? (
              <CameraView
                streamURL={streamUrl}
                mirror={front}
                objectFit="cover"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                }}
              />
            ) : (
              <Text style={[styles.body, { padding: 24, textAlign: "center" }]}>
                Your private camera preview appears here. Nothing is sent until
                you choose Go live.
              </Text>
            )}
            <View
              style={{
                position: "absolute",
                top: 14,
                left: 14,
                backgroundColor: "#120D1FCC",
                padding: 9,
                borderRadius: 9,
              }}
            >
              <Text style={{ color: color.text }}>
                {sending
                  ? "Sending camera · check status above"
                  : "PRIVATE PREVIEW"}
              </Text>
            </View>
          </View>
          {!rtc && (
            <Text style={styles.error}>
              Install the rebuilt Ziipa native app to broadcast with your phone
              camera. Expo Go and older preview binaries do not include WebRTC.
              You can still connect an external encoder.
            </Text>
          )}
          {!streamUrl ? (
            <Action
              title="Enable camera & microphone"
              icon={Camera}
              onPress={() => void preview()}
              disabled={!rtc || !enabled || pending || busy}
              busy={pending}
            />
          ) : (
            <>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Action
                    title={flipping ? "Switching…" : "Flip camera"}
                    icon={FlipHorizontal}
                    secondary
                    onPress={() => void flip()}
                    disabled={pending || flipping}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Action
                    title={muted ? "Unmute mic" : "Mute mic"}
                    icon={muted ? MicOff : Mic}
                    secondary
                    onPress={() => {
                      session.mute(!muted);
                      setMuted(!muted);
                    }}
                  />
                </View>
              </View>
              {!attempt.current ? (
                <Action
                  title="Go live with this camera"
                  icon={Radio}
                  onPress={() => void broadcast()}
                  disabled={!canStart || busy || pending || flipping}
                />
              ) : (
                <Text style={styles.body}>
                  {pending
                    ? "Connecting public video transport…"
                    : "The camera is transmitting. Only the verified status above confirms public playback."}
                </Text>
              )}
              <Text style={styles.small}>
                {muted ? "Microphone muted." : "Microphone on."} Keep Ziipa
                open; leaving the app stops the camera and ends this broadcast.
              </Text>
            </>
          )}
        </>
      ) : (
        <>
          <Text style={styles.heading}>Connect your live encoder</Text>
          <Text style={styles.body}>
            Use OBS or another RTMP encoder to send video to Ziipa. Your phone
            camera is off in this mode. Keep this screen open while
            broadcasting.
          </Text>
          {!credentials ? (
            <Action
              title="Enable public ingest & get encoder settings"
              icon={Radio}
              onPress={() => void connectEncoder()}
              disabled={!enabled || !canStart || busy || pending}
              busy={pending}
            />
          ) : (
            <>
              <Text style={styles.label}>RTMP server</Text>
              <Text selectable style={styles.body}>
                {credentials.rtmp_server}
              </Text>
              <Action
                title="Copy server"
                icon={Copy}
                secondary
                onPress={() => void copy(credentials.rtmp_server)}
              />
              <Text style={styles.label}>Private stream key</Text>
              <Text selectable={revealed} style={styles.body}>
                {revealed ? credentials.stream_key : "••••••••••••••••••••"}
              </Text>
              <Action
                title={revealed ? "Hide stream key" : "Reveal stream key"}
                icon={revealed ? EyeOff : Eye}
                secondary
                onPress={() => setRevealed(!revealed)}
              />
              {revealed && (
                <Action
                  title="Copy private stream key"
                  icon={Copy}
                  secondary
                  onPress={() => void copy(credentials.stream_key)}
                />
              )}
              <Text style={styles.small}>
                Anyone with the key can send media. Never post it or include it
                in a screenshot.
              </Text>
            </>
          )}
        </>
      )}
      {!!error && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {mode === "camera" && (
            <Action
              title="Open device permission settings"
              secondary
              onPress={() => {
                void Linking.openSettings().catch(() =>
                  setError(
                    "Open Ziipa permissions from your device Settings app.",
                  ),
                );
              }}
            />
          )}
        </>
      )}
      {(streamUrl || pending || attempt.current) && (
        <Action
          title={
            attempt.current ? "Stop camera & end broadcast" : "Turn camera off"
          }
          icon={Square}
          secondary
          onPress={() => shutdown(true)}
        />
      )}
    </View>
  );
});
