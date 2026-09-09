import { useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Camera,
  Check,
  Link2,
  Mic,
  Radio,
  RotateCcw,
  SwitchCamera,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { UploadFile } from "../lib/api";
import { color, font, styles } from "../theme";
import { Action, Notice } from "./ui";
import { recordingSeconds, recordingTime } from "./recorder-utils";

export type RecorderProps = {
  mode: "record" | "live";
  onClose: () => void;
  onCapture: (file: UploadFile) => void;
  onNetworks: () => void;
};

export function RecorderLayout({
  mode,
  enabled,
  ready,
  busy,
  recording,
  seconds,
  clip,
  error,
  children,
  onEnable,
  onFlip,
  onRecord,
  onStop,
  onRetake,
  onUse,
  onClose,
  onNetworks,
  unavailable,
  recovery,
}: {
  mode: RecorderProps["mode"];
  enabled: boolean;
  ready: boolean;
  busy: boolean;
  recording: boolean;
  seconds: number;
  clip: UploadFile | null;
  error: string;
  children?: ReactNode;
  unavailable?: string;
  recovery?: ReactNode;
  onEnable: () => void;
  onFlip: () => void;
  onRecord: () => void;
  onStop: () => void;
  onRetake: () => void;
  onUse: () => void;
  onClose: () => void;
  onNetworks: () => void;
}) {
  const [discard, setDiscard] = useState(false);
  const insets = useSafeAreaInsets();
  function close() {
    if (recording || clip || busy) setDiscard(true);
    else onClose();
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={close}
    >
      <View
        style={[
          r.screen,
          {
            paddingTop: Math.max(14, insets.top),
            paddingBottom: Math.max(16, insets.bottom),
          },
        ]}
      >
        <View style={r.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close camera"
            onPress={close}
            style={r.round}
          >
            <X size={23} color="white" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={r.title}>
              {clip
                ? "Review your clip"
                : mode === "live"
                  ? "Live studio"
                  : "Record in Ziipa"}
            </Text>
            <Text style={r.small}>
              {recording
                ? "Recording on this device"
                : clip
                  ? "Private preview · nothing posted"
                  : "Your camera. Your next creation."}
            </Text>
          </View>
          <View style={[r.badge, recording && { backgroundColor: "#AE1934" }]}>
            <Text style={r.badgeText}>
              {recording ? `● ${recordingTime(seconds)}` : "PRIVATE"}
            </Text>
          </View>
        </View>
        <View style={r.stage}>
          {children}
          {!enabled && !clip && (
            <ScrollView
              contentContainerStyle={r.permission}
              showsVerticalScrollIndicator={false}
            >
              <View style={r.cameraMark}>
                <Camera size={38} color={color.lime} />
              </View>
              <Text style={r.permissionTitle}>
                Create with your live camera
              </Text>
              <Text style={r.explain}>
                {unavailable ||
                  "Enable your camera and microphone for a live preview. Tap Record when you’re ready, then review your clip before sharing."}
              </Text>
              <View style={[styles.row, { justifyContent: "center" }]}>
                <Mic size={16} color={color.lime} />
                <Text style={r.small}>
                  Camera + microphone · only while this screen is open
                </Text>
              </View>
              {!unavailable && (
                <Action
                  title="Enable camera & mic"
                  icon={Camera}
                  busy={busy}
                  onPress={onEnable}
                />
              )}
              {recovery}
            </ScrollView>
          )}
          {enabled && !clip && (
            <>
              <View pointerEvents="none" style={r.cameraLabel}>
                <View style={r.dot} />
                <Text style={r.cameraLabelText}>
                  {recording
                    ? "RECORDING"
                    : ready
                      ? "LIVE CAMERA PREVIEW"
                      : "STARTING CAMERA…"}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Flip camera"
                accessibilityState={{ disabled: recording || busy }}
                disabled={recording || busy}
                onPress={onFlip}
                style={[
                  r.round,
                  r.flip,
                  (recording || busy) && { opacity: 0.4 },
                ]}
              >
                <SwitchCamera size={25} color="white" />
              </Pressable>
            </>
          )}
        </View>
        <View style={r.bottom}>
          {!!error && <Notice error text={error} />}
          {discard ? (
            <>
              <Text style={r.explain}>
                Discard this recording and close the camera? It has not been
                uploaded.
              </Text>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Action
                    title="Keep editing"
                    secondary
                    onPress={() => setDiscard(false)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Action title="Discard" danger onPress={onClose} />
                </View>
              </View>
            </>
          ) : clip ? (
            <>
              <Text style={r.explain}>
                {recordingTime(seconds)} ·{" "}
                {(clip.size / 1024 / 1024).toFixed(1)} MB · Add overlays and
                music next
              </Text>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Action
                    title="Retake"
                    secondary
                    icon={RotateCcw}
                    onPress={onRetake}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Action title="Use clip" icon={Check} onPress={onUse} />
                </View>
              </View>
            </>
          ) : (
            <>
              {enabled && (
                <View style={{ alignItems: "center", gap: 7 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      recording ? "Stop recording" : "Start recording"
                    }
                    accessibilityState={{ disabled: !ready || busy }}
                    disabled={!ready || busy}
                    onPress={recording ? onStop : onRecord}
                    style={[r.record, (!ready || busy) && { opacity: 0.5 }]}
                  >
                    <View style={[r.recordInner, recording && r.stopInner]} />
                  </Pressable>
                  <Text style={r.small}>
                    {busy
                      ? "Preparing clip…"
                      : recording
                        ? `Tap to stop · ${recordingTime(recordingSeconds - seconds)} remaining`
                        : "Record a clip · up to 2 minutes / 100 MB"}
                  </Text>
                </View>
              )}
              {mode === "live" && (
                <View style={r.liveNotice}>
                  <View style={styles.row}>
                    <Radio size={18} color="#FF8797" />
                    <Text style={r.title}>Broadcast setup required</Text>
                  </View>
                  <Text style={r.small}>
                    This is a private camera preview, not a public stream.
                    Connect a supported live network and configure streaming
                    delivery before broadcasting. You can record a clip now.
                  </Text>
                  {!recording && (
                    <Action
                      title="Connect live networks"
                      secondary
                      icon={Link2}
                      onPress={onNetworks}
                    />
                  )}
                </View>
              )}
              <Text style={[r.small, { textAlign: "center" }]}>
                  Recordings stay on this device until you save them to Ziipa.
                  Nothing is posted automatically.
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const r = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.bg,
    paddingTop: 14,
    paddingBottom: 16,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16 },
  title: { color: "white", fontSize: 17, fontFamily: font.semibold },
  small: {
    color: "#C8BFD6",
    fontSize: 12,
    lineHeight: 17,
    fontFamily: font.regular,
  },
  badge: {
    backgroundColor: "#2D213B",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 9,
  },
  badgeText: {
    color: "white",
    fontSize: 10,
    fontFamily: font.semibold,
    letterSpacing: 0.6,
  },
  stage: {
    flex: 1,
    minHeight: 200,
    overflow: "hidden",
    marginHorizontal: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#443053",
    backgroundColor: "#08060D",
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#171020CC",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#766384",
  },
  flip: { position: "absolute", right: 15, top: 15 },
  cameraLabel: {
    position: "absolute",
    top: 20,
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#0C0814B8",
    padding: 8,
    borderRadius: 20,
  },
  cameraLabelText: {
    color: "white",
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 0.7,
  },
  dot: { width: 7, height: 7, backgroundColor: color.lime, borderRadius: 4 },
  permission: { flexGrow: 1, justifyContent: "center", padding: 23, gap: 18 },
  cameraMark: {
    backgroundColor: "#2D1749",
    width: 82,
    height: 82,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 41,
  },
  permissionTitle: {
    color: "white",
    fontFamily: font.bold,
    fontSize: 25,
    textAlign: "center",
  },
  explain: {
    color: "#C8BFD6",
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  bottom: { paddingHorizontal: 18, paddingTop: 16, gap: 12 },
  record: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: "white",
    padding: 5,
    justifyContent: "center",
    alignItems: "center",
  },
  recordInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#FF405B",
  },
  stopInner: { width: 28, height: 28, borderRadius: 6 },
  liveNotice: {
    padding: 13,
    gap: 8,
    borderRadius: 18,
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.border,
  },
});
