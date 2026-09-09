import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";
import { Camera, Radio, Square } from "lucide-react-native";
import { Action } from "./ui";
import {
  boundedSdp,
  checkedLivepeerEdge,
  checkedWhipUrl,
  type LiveTransmitterHandle,
  type LiveTransmitterProps,
} from "../lib/live-types";
import { color, styles } from "../theme";

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
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
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else changed();
  });
}

/** Real send-only WHIP transport. This component never treats a local preview as LIVE. */
export const LiveTransmitter = forwardRef<
  LiveTransmitterHandle,
  LiveTransmitterProps
>(function LiveTransmitter(
  { enabled, canStart, busy, onStart, onStop, onTransport },
  ref,
) {
  const video = useRef<HTMLVideoElement | null>(null);
  const media = useRef<MediaStream | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopRef = useRef(onStop);
  const noticeRef = useRef(onTransport);
  stopRef.current = onStop;
  noticeRef.current = onTransport;
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined";

  function shutdown(end: boolean) {
    generation.current++;
    clearTimeout(timeout.current);
    controller.current?.abort();
    controller.current = null;
    if (peer.current) {
      peer.current.onconnectionstatechange = null;
      peer.current.close();
      peer.current = null;
    }
    media.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    media.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
    }
    const shouldEnd = attempt.current;
    attempt.current = false;
    if (mounted.current) {
      setReady(false);
      setPending(false);
      setSending(false);
    }
    if (end && shouldEnd) void stopRef.current().catch(() => {});
  }
  useImperativeHandle(ref, () => ({ stopLocal: () => shutdown(false) }));
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.visibilityState === "hidden") {
        shutdown(true);
        noticeRef.current(
          "Camera and microphone stopped because the app left the foreground.",
        );
      }
    };
    const leaving = () => shutdown(true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leaving);
    return () => {
      mounted.current = false;
      shutdown(true);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leaving);
    };
  }, []);
  useEffect(() => {
    if (!enabled) shutdown(true);
  }, [enabled]);

  async function preview() {
    if (!enabled || pending || !secure || !supported) return;
    const current = ++generation.current;
    setPending(true);
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 1280 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (
        !mounted.current ||
        current !== generation.current ||
        document.visibilityState === "hidden"
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      media.current = stream;
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          shutdown(true);
          setError(
            "Camera or microphone stopped. The broadcast connection has been closed.",
          );
        };
      });
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play();
      }
      if (mounted.current && current === generation.current) setReady(true);
    } catch {
      if (mounted.current && current === generation.current) {
        shutdown(true);
        setError(
          "Camera or microphone access failed. Check site permissions and close other apps using the camera, then retry.",
        );
      }
    } finally {
      if (mounted.current && current === generation.current) setPending(false);
    }
  }

  async function broadcast() {
    if (!canStart || !enabled || !ready || busy || pending || !media.current)
      return;
    const current = generation.current;
    const stream = media.current;
    setPending(true);
    setError("");
    attempt.current = true;
    try {
      const ingest = await onStart();
      if (!mounted.current || current !== generation.current) return;
      const endpoint = checkedWhipUrl(ingest.whip_url);
      const abort = new AbortController();
      controller.current = abort;
      timeout.current = setTimeout(() => {
        if (current === generation.current) {
          shutdown(true);
          setError(
            "Broadcast connection timed out. Local camera and microphone have stopped. Retry after checking provider status.",
          );
        }
      }, 25000);
      // Livepeer's own client resolves the regional edge with HEAD before SDP negotiation.
      // No Ziipa bearer, cookies or provider API key are sent to the media provider.
      const discovery = await fetch(endpoint, {
        method: "HEAD",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        mode: "cors",
        signal: abort.signal,
      });
      const edge = checkedLivepeerEdge(discovery.url);
      if (current !== generation.current) return;
      const connection = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:" + edge.hostname },
          {
            urls: "turn:" + edge.hostname,
            username: "livepeer",
            credential: "livepeer",
          },
        ],
      });
      peer.current = connection;
      connection.onconnectionstatechange = () => {
        if (current !== generation.current) return;
        if (connection.connectionState === "connected") {
          clearTimeout(timeout.current);
          setPending(false);
          setSending(true);
          noticeRef.current(
            "Media transport connected. Waiting for Livepeer to verify that the broadcast is live.",
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
        if (
          track.kind === "video" &&
          transceiver.setCodecPreferences &&
          typeof RTCRtpSender.getCapabilities === "function"
        ) {
          const codecs = RTCRtpSender.getCapabilities("video")?.codecs || [];
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
      if (current !== generation.current || abort.signal.aborted) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp || sdp.length > 256 * 1024)
        throw new Error("Invalid local offer.");
      const response = await fetch(edge.toString().replace("video+", ""), {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: sdp,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        mode: "cors",
        redirect: "error",
        signal: abort.signal,
      });
      const answer = await boundedSdp(response);
      if (current !== generation.current || abort.signal.aborted) return;
      await connection.setRemoteDescription({ type: "answer", sdp: answer });
    } catch {
      if (mounted.current && current === generation.current) {
        shutdown(true);
        setError(
          "Could not establish public video transport. Camera and microphone are stopped. Check the broadcast status, provider configuration and connection, then prepare a new broadcast if needed.",
        );
      }
    }
  }

  return (
    <View style={[styles.panel, { padding: 12 }]}>
      <View
        style={{
          aspectRatio: 9 / 12,
          backgroundColor: "#09070F",
          borderRadius: 20,
          overflow: "hidden",
          justifyContent: "center",
        }}
      >
        {createElement("video", {
          ref: video,
          muted: true,
          autoPlay: true,
          playsInline: true,
          "aria-label": "Private camera preview",
          style: {
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)",
          },
        })}
        {!ready && (
          <Text style={[styles.body, { padding: 24, textAlign: "center" }]}>
            Your live camera preview appears here. Nothing is transmitted until
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
      {!secure ? (
        <Text style={styles.error}>
          Browsers block cameras on HTTP Wi-Fi addresses. Open Ziipa at
          http://localhost:8082 on the development computer, or use a trusted
          HTTPS deployment. Do not disable browser security.
        </Text>
      ) : !supported ? (
        <Text style={styles.error}>
          This browser does not support camera broadcasting. Use a current
          Chrome or Safari browser.
        </Text>
      ) : null}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!ready ? (
        <Action
          title="Enable camera & microphone"
          icon={Camera}
          onPress={() => void preview()}
          disabled={!enabled || !secure || !supported || pending || busy}
          busy={pending}
        />
      ) : !sending && !attempt.current ? (
        <Action
          title="Go live with this camera"
          icon={Radio}
          onPress={() => void broadcast()}
          disabled={!canStart || busy || pending}
        />
      ) : (
        <Text style={styles.body}>
          {pending
            ? "Connecting public video transport…"
            : "The camera is transmitting. Only the verified status above confirms public playback."}
        </Text>
      )}
      {(ready || pending) && (
        <Action
          title={
            attempt.current ? "Stop camera & end broadcast" : "Turn camera off"
          }
          icon={Square}
          secondary
          onPress={() => {
            shutdown(true);
          }}
        />
      )}
    </View>
  );
});
