import { useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { useZiipa } from "../provider";
import type { CalendarEvent } from "../lib/calendar-types";
import { styles } from "../theme";
import { Action, Notice } from "./ui";

type CalendarChoice = { id: string; title: string; writable: boolean };
const root = "/api/os/calendar/connections";
const hash = (text: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);

export function DeviceCalendarPanel({ events }: { events: CalendarEvent[] }) {
  const { session, api } = useZiipa();
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [selected, setSelected] = useState<CalendarChoice | null>(null);
  const [exporting, setExporting] = useState<CalendarEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const gate = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function check() {
    if (!alive.current || !session)
      throw new Error("Reopen Calendar in your signed-in account.");
  }
  async function run(work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      check();
      await work();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : "Device calendar request could not finish.",
        );
    } finally {
      gate.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function module() {
    try {
      return await import("expo-calendar");
    } catch {
      throw new Error(
        "Device calendar access needs the updated Ziipa build. Update the app and try again.",
      );
    }
  }
  async function list() {
    const calendar = await module();
    check();
    const permission = await calendar.requestCalendarPermissions(false);
    check();
    if (!permission.granted)
      throw new Error(
        "Calendar permission was not granted. You can enable it in device Settings when ready.",
      );
    const available = await calendar.getCalendars(calendar.EntityTypes.EVENT);
    check();
    setCalendars(
      available.map((item) => ({
        id: item.id,
        title: item.title,
        writable: item.allowsModifications,
      })),
    );
    if (!available.length)
      setNotice(
        "No calendars are configured on this device. Add an account in your device’s Calendar settings, then refresh.",
      );
  }
  async function sync() {
    if (!selected || !session) return;
    const calendar = await module();
    check();
    const permission = await calendar.getCalendarPermissions(false);
    check();
    if (!permission.granted)
      throw new Error("Calendar permission is no longer available.");
    const start = new Date(Date.now() - 30 * 86400000),
      end = new Date(Date.now() + 90 * 86400000);
    const remote = await calendar.listEvents([selected.id], start, end);
    check();
    if (remote.length > 500)
      throw new Error(
        "This calendar has more than 500 events in the sync window. Choose a smaller calendar; nothing was uploaded.",
      );
    const keyName = "ziipa.calendar.device." + session.user.id;
    let deviceKey = await SecureStore.getItemAsync(keyName);
    check();
    if (!deviceKey) {
      deviceKey = Crypto.randomUUID();
      await SecureStore.setItemAsync(keyName, deviceKey);
      check();
    }
    const snapshot = await Promise.all(
      remote.map(async (event) => ({
        id: await hash(deviceKey + ":" + selected.id + ":" + event.id),
        title: (event.title || "Untitled event").slice(0, 140),
        notes: (event.notes || "").slice(0, 2000),
        starts_at: new Date(event.startDate).toISOString(),
        ends_at: new Date(event.endDate).toISOString(),
        all_day: event.allDay,
      })),
    );
    check();
    await api(root + "/device/snapshot", {
      device_key: deviceKey,
      calendar_name: selected.title,
      events: snapshot,
    });
    check();
    setNotice(
      `${snapshot.length} events saved to your private Ziipa Calendar. Use Refresh calendar to see them in your agenda. Device sync runs only when you choose Sync.`,
    );
  }
  async function exportEvent() {
    if (!selected || !exporting || !session) return;
    const event = exporting;
    const occurrence = event.occurrences.find(
      (item) =>
        item.status !== "cancelled" && Date.parse(item.starts_at) > Date.now(),
    );
    if (!occurrence)
      throw new Error("There is no upcoming occurrence to export.");
    const calendar = await module();
    check();
    const available = await calendar.ExpoCalendar.get(selected.id);
    check();
    if (!available.allowsModifications)
      throw new Error("Choose a writable calendar.");
    const marker = "Ziipa occurrence: " + occurrence.id;
    const mapping =
      "ziipa.calendar.export." +
      (await hash(session.user.id + ":" + selected.id + ":" + occurrence.id));
    check();
    const saved = await SecureStore.getItemAsync(mapping);
    check();
    const start = new Date(occurrence.starts_at),
      end = new Date(start.getTime() + event.duration_minutes * 60000);
    // Find a prior create even if the app closed between the OS write and
    // saving its mapping. Existing exports stay untouched on repeat clicks.
    let previous = saved
      ? await calendar.ExpoCalendarEvent.get(saved).catch(() => null)
      : null;
    check();
    if (!previous) {
      const near = await available.listEvents(
        new Date(start.getTime() - 86400000),
        new Date(end.getTime() + 86400000),
      );
      check();
      previous = near.find((item) => item.notes?.includes(marker)) || null;
    }
    if (previous) {
      await SecureStore.setItemAsync(mapping, previous.id);
      check();
      setExporting(null);
      setNotice(
        "This occurrence already has a device-calendar copy. No duplicate was created. Edit the copy in your Calendar app, then Sync to bring those changes into Ziipa.",
      );
      return;
    }
    check();
    const added = await available.createEvent({
      title: event.title,
      startDate: start,
      endDate: end,
      notes:
        event.notes +
        "\n\n" +
        marker +
        "\nOpen in Ziipa: https://ziipa.com/studio/?view=calendar&eventId=" +
        event.id,
      ...(Platform.OS === "ios"
        ? { url: "https://ziipa.com/studio/?view=calendar&eventId=" + event.id }
        : {}),
    });
    check();
    await SecureStore.setItemAsync(mapping, added.id);
    check();
    setExporting(null);
    setNotice(
      "Calendar event added with its Ziipa link. No guests were invited and no media was published.",
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.small}>
        First allow device access, then choose one calendar. Sync saves that
        calendar’s event titles, notes and times from the last 30 and next 90
        days to your private Ziipa account. Reminders and contacts are not read.
        Device Calendar handles any iCloud/Google/Outlook account
        synchronization.
      </Text>
      <Action
        secondary
        title="Allow access and choose calendar"
        disabled={busy}
        onPress={() => void run(list)}
      />
      {calendars.map((choice) => (
        <Action
          key={choice.id}
          secondary
          title={
            (selected?.id === choice.id ? "✓ " : "") +
            choice.title +
            (choice.writable ? "" : " · read only")
          }
          disabled={busy}
          onPress={() => {
            setSelected(choice);
            setExporting(null);
          }}
        />
      ))}
      {selected && (
        <>
          <Action
            title="Sync selected calendar with Ziipa"
            disabled={busy}
            onPress={() => void run(sync)}
          />
          {selected.writable && (
            <>
              <Text style={styles.small}>
                Add a reviewed Ziipa schedule to {selected.title}
              </Text>
              {events
                .filter((item) => item.status === "active")
                .slice(0, 30)
                .map((item) => (
                  <Action
                    key={item.id}
                    secondary
                    title={item.title}
                    disabled={busy}
                    onPress={() => setExporting(item)}
                  />
                ))}
            </>
          )}
        </>
      )}
      {exporting && (
        <>
          <Text style={styles.body}>
            Add “{exporting.title}” to {selected?.title}? This creates the next
            occurrence with its Ziipa link, without guests.
          </Text>
          <Action
            title="Confirm device-calendar export"
            disabled={busy}
            onPress={() => void run(exportEvent)}
          />
          <Action
            secondary
            title="Cancel export"
            disabled={busy}
            onPress={() => setExporting(null)}
          />
        </>
      )}
      {error ? <Notice error text={error} /> : null}
      {notice ? <Notice text={notice} /> : null}
    </View>
  );
}
