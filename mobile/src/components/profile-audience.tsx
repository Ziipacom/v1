import { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { ChevronDown, Check } from "lucide-react-native";
import { Sheet } from "./floating";
import { useDesktopLayout } from "./desktop-layout";
import {
  audienceNumber,
  type ProfileCollections,
} from "../lib/profile-collections";
import { color, font, styles } from "../theme";

export function ProfileAudience({
  profile,
  onPeople,
}: {
  profile?: ProfileCollections;
  onPeople: (kind: "followers" | "following", provider: string) => void;
}) {
  const { desktop } = useDesktopLayout();
  const { width, height } = useWindowDimensions();
  const anchor = useRef<View>(null);
  const [selected, setSelected] = useState("ziipa");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 140 });
  const sources = [
    { provider: "ziipa", name: "Ziipa", counts: profile?.audience },
    ...(profile?.network.providers || [])
      .filter(
        (account) =>
          account.status === "linked" || account.status === "connected",
      )
      .map((account) => ({
        provider: account.provider,
        name: account.name,
        counts: account.audience,
      })),
  ];
  const source =
    sources.find((value) => value.provider === selected) || sources[0];
  const count = (kind: "followers" | "following") => {
    const value = audienceNumber(source.counts?.[kind]);
    return value === null
      ? "—"
      : Intl.NumberFormat(undefined, {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(value);
  };
  const options = (
    <View style={{ gap: 4 }}>
      <Text style={[styles.small, { padding: 8 }]}>
        Choose the network for these counts
      </Text>
      <ScrollView style={{ maxHeight: 300 }}>
        {sources.map((option) => (
          <Pressable
            key={option.provider}
            accessibilityRole="button"
            accessibilityLabel={`Show ${option.name} follower counts`}
            accessibilityState={{
              selected: source.provider === option.provider,
            }}
            onPress={() => {
              setSelected(option.provider);
              setOpen(false);
            }}
            style={{
              minHeight: 44,
              padding: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Text style={[styles.body, { flex: 1, color: color.text }]}>
              {option.name}
            </Text>
            {source.provider === option.provider && (
              <Check size={16} color={color.lime} />
            )}
          </Pressable>
        ))}
      </ScrollView>
      <Text style={[styles.small, { padding: 8 }]}>
        Each network is separate. Unavailable metrics display —.
      </Text>
    </View>
  );
  const updated = source.counts?.updated_at;
  const stamp =
    updated && Number.isFinite(Date.parse(updated))
      ? new Date(updated).toLocaleString()
      : null;
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <View ref={anchor} style={{ alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Choose follower network · ${source.name}`}
          accessibilityState={{ expanded: open }}
          hitSlop={7}
          onPress={() => {
            anchor.current?.measureInWindow((x, y, w, h) =>
              setPosition({
                x: Math.max(8, Math.min(x + w / 2 - 130, width - 268)),
                y: Math.max(8, Math.min(y + h, height - 360)),
              }),
            );
            setOpen(true);
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            padding: 5,
            minHeight: 30,
          }}
        >
          <Text
            style={{ fontFamily: font.medium, fontSize: 11, color: color.text }}
          >
            {source.name}
          </Text>
          <ChevronDown size={12} color={color.muted} />
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-around",
          gap: 12,
        }}
      >
        {(["followers", "following"] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityLabel={`${source.name} ${kind}: ${count(kind)}`}
            onPress={() => onPeople(kind, source.provider)}
            style={{ alignItems: "center", minHeight: 44 }}
          >
            <Text
              style={{
                color: color.text,
                fontFamily: font.semibold,
                fontSize: 22,
              }}
            >
              {count(kind)}
            </Text>
            <Text
              style={{
                color: color.muted,
                fontFamily: font.regular,
                fontSize: 12,
              }}
            >
              {kind === "followers" && source.provider === "youtube"
                ? "Subscribers"
                : kind === "followers"
                  ? "Followers"
                  : "Following"}
            </Text>
          </Pressable>
        ))}
      </View>
      {(stamp || source.provider !== "ziipa") && (
        <Text
          numberOfLines={1}
          style={{
            color: color.muted,
            fontFamily: font.regular,
            fontSize: 9,
            textAlign: "center",
          }}
        >
          {stamp
            ? `Updated ${stamp}`
            : "Counts unavailable from this connection"}
        </Text>
      )}
      {open &&
        (desktop ? (
          <Modal
            transparent
            animationType="fade"
            onRequestClose={() => setOpen(false)}
          >
            <Pressable
              accessibilityLabel="Close network selector"
              onPress={() => setOpen(false)}
              style={{ position: "absolute", inset: 0 }}
            />
            <View
              style={{
                position: "absolute",
                left: position.x,
                top: position.y,
                width: 260,
                borderRadius: 12,
                padding: 8,
                backgroundColor: color.panel,
                borderWidth: 1,
                borderColor: color.border,
                boxShadow: "0 8px 28px #0004",
              }}
            >
              {options}
            </View>
          </Modal>
        ) : (
          <Sheet title="Audience network" onClose={() => setOpen(false)}>
            {options}
          </Sheet>
        ))}
    </View>
  );
}
