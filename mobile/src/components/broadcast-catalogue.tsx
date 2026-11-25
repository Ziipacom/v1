import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CalendarClock, Radio, Video } from "lucide-react-native";
import { useZiipa } from "../provider";
import { color, font, styles } from "../theme";
import { LibraryGrid } from "./personal-library";
import { Action, Notice } from "./ui";
import {
  checkedLivePlayback,
  verifiedLive,
  type LiveConfig,
  type PublicLiveBroadcast,
} from "../lib/live-types";
import { calendarRoot, type CalendarList } from "../lib/calendar-types";
import { upcomingBroadcastEvents } from "../lib/broadcast-events";

export function BroadcastTile({
  title,
  detail,
  status,
  children,
  onPress,
  label,
}: {
  title: string;
  detail: string;
  status: string;
  children?: ReactNode;
  onPress: () => void;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label || title}
      onPress={onPress}
      style={{
        borderRadius: 14,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: color.border,
        backgroundColor: color.panel,
      }}
    >
      <View
        style={{
          aspectRatio: 1.35,
          width: "100%",
          backgroundColor: color.raised,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children || <Video size={30} color={color.muted} />}
        <View
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            backgroundColor: color.bg,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 7,
          }}
        >
          <Text style={styles.small}>{status}</Text>
        </View>
      </View>
      <View style={{ padding: 12, gap: 5 }}>
        <Text
          numberOfLines={2}
          style={{ color: color.text, fontFamily: font.semibold, fontSize: 16 }}
        >
          {title}
        </Text>
        <Text numberOfLines={2} style={styles.small}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

export function LiveCatalogue({
  active,
  open,
  prepare,
}: {
  active: boolean;
  open: (id: string) => void;
  prepare: () => void;
}) {
  const { api } = useZiipa();
  const [feed, setFeed] = useState<PublicLiveBroadcast[]>([]);
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [configuration, rows] = await Promise.all([
          api<LiveConfig>("/api/live/config"),
          api<PublicLiveBroadcast[]>("/api/live/public"),
        ]);
        if (current) {
          setConfig(configuration);
          setFeed(rows);
          setClock(Date.now());
          setError("");
        }
      } catch {
        if (current) {
          setFeed([]);
          setError("Live feeds could not load. Please try refreshing.");
        }
      } finally {
        if (current) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    };
    void load();
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      current = false;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [api, active]);
  const live = active
    ? feed.filter(
        (item) =>
          verifiedLive(item, clock) && checkedLivePlayback(item.playback_url),
      )
    : [];
  return (
    <View style={{ gap: 16 }}>
      {loading ? (
        <ActivityIndicator
          color={color.purple}
          accessibilityLabel="Loading live feeds"
        />
      ) : null}
      {error ? <Notice error text={error} /> : null}
      {!loading && !error && !live.length ? (
        <View
          style={[styles.panel, { alignItems: "center", paddingVertical: 32 }]}
        >
          <Radio size={32} color={color.muted} />
          <Text style={styles.heading}>No live broadcasts right now</Text>
          <Text style={[styles.small, { textAlign: "center" }]}>
            {config?.configured
              ? "Start a broadcast or return when a creator is live."
              : "Live broadcasting is awaiting service setup."}
          </Text>
          <Action secondary title="Broadcast studio" onPress={prepare} />
        </View>
      ) : null}
      <LibraryGrid>
        {live.map((item) => (
          <BroadcastTile
            key={item.id}
            title={item.title}
            detail={item.description || "Watch this broadcast"}
            status="Live"
            label={`Watch ${item.title}`}
            onPress={() => open(item.id)}
          >
            <Radio size={34} color={color.lime} />
          </BroadcastTile>
        ))}
      </LibraryGrid>
    </View>
  );
}

export function BroadcastEvents({
  active,
  open,
  create,
}: {
  active: boolean;
  open: (id: string) => void;
  create: () => void;
}) {
  const { api } = useZiipa();
  const [events, setEvents] = useState<CalendarList["events"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError("");
    void api<CalendarList>(`${calendarRoot}/events`)
      .then((value) => {
        if (current) setEvents(value.events);
      })
      .catch(() => {
        if (current) setError("Your scheduled events could not load.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, active, attempt]);
  const upcoming = upcomingBroadcastEvents(active ? events : []);
  return (
    <View style={{ gap: 16 }}>
      <Action title="Schedule event" icon={CalendarClock} onPress={create} />
      {loading ? (
        <ActivityIndicator
          color={color.purple}
          accessibilityLabel="Loading scheduled events"
        />
      ) : null}
      {error ? (
        <>
          <Notice error text={error} />
          <Action
            secondary
            title="Retry"
            onPress={() => setAttempt((value) => value + 1)}
          />
        </>
      ) : null}
      {!loading && !error && !upcoming.length ? (
        <Text style={styles.body}>
          No upcoming live events. Schedule your next broadcast to see it here.
        </Text>
      ) : null}
      <LibraryGrid>
        {upcoming.map(({ event, occurrence }) => (
          <BroadcastTile
            key={`${event.id}:${occurrence.id}`}
            title={event.title}
            status="Upcoming"
            detail={`${new Date(occurrence.starts_at).toLocaleString(undefined, { timeZone: event.timezone, dateStyle: "medium", timeStyle: "short" })} · ${event.timezone}`}
            onPress={() => open(event.id)}
          >
            <CalendarClock size={32} color={color.muted} />
          </BroadcastTile>
        ))}
      </LibraryGrid>
      <Text style={styles.small}>
        Events are private plans. Open Broadcast studio when you are ready to
        start.
      </Text>
    </View>
  );
}
