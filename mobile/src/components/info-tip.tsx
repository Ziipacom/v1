import { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Info, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, font, styles, useTheme } from "../theme";

export type InfoTipProps = { title: string; content: string };

/** The glyph is 12px; the invisible button and hit slop stay easy to tap. */
export function InfoTip({ title, content }: InfoTipProps) {
  useTheme();
  const anchor = useRef<View>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [panelHeight, setPanelHeight] = useState(190);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = Math.min(300, window.width - 32);
  const open = () =>
    anchor.current?.measureInWindow((x, y, _width, height) =>
      setPosition({ x, y: y + height }),
    );
  return (
    <>
      <View ref={anchor} collapsable={false} style={{ width: 24, height: 24 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`About ${title}`}
          accessibilityHint="Opens a short explanation"
          accessibilityState={{ expanded: !!position }}
          hitSlop={8}
          onPress={open}
          style={{
            width: 24,
            height: 24,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Info size={12} strokeWidth={1.6} color={color.muted} />
        </Pressable>
      </View>
      {position ? (
        <Modal
          transparent
          animationType="fade"
          onRequestClose={() => setPosition(null)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss help"
            onPress={() => setPosition(null)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <View
            accessibilityViewIsModal
            onLayout={(event) =>
              setPanelHeight(event.nativeEvent.layout.height)
            }
            style={{
              position: "absolute",
              left: Math.max(
                16,
                Math.min(position.x, window.width - width - 16),
              ),
              top: Math.max(
                insets.top + 8,
                Math.min(
                  position.y + 6,
                  window.height - insets.bottom - panelHeight - 8,
                ),
              ),
              width,
              maxHeight: window.height - insets.top - insets.bottom - 24,
              padding: 14,
              gap: 8,
              borderRadius: 12,
              backgroundColor: color.panel,
              borderWidth: 1,
              borderColor: color.border,
              elevation: 8,
              shadowColor: "#000",
              shadowOpacity: 0.18,
              shadowRadius: 12,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                accessibilityRole="header"
                style={{
                  fontFamily: font.semibold,
                  fontSize: 14,
                  color: color.text,
                  flex: 1,
                }}
              >
                {title}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close help"
                onPress={() => setPosition(null)}
                hitSlop={8}
                style={{
                  width: 28,
                  height: 28,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={14} color={color.muted} />
              </Pressable>
            </View>
            <ScrollView style={{ flexGrow: 0, flexShrink: 1 }}>
              <Text style={[styles.small, { fontSize: 13, lineHeight: 19 }]}>
                {content}
              </Text>
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
