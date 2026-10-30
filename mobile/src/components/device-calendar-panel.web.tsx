import { Text } from "react-native";
import type { CalendarEvent } from "../lib/calendar-types";
import { styles } from "../theme";

export function DeviceCalendarPanel(_props: { events: CalendarEvent[] }) {
  return (
    <Text style={styles.small}>
      Open Calendar → Connect in the updated Ziipa iOS or Android app to select
      a device calendar. iCloud calendars are accessed through Apple’s device
      permission, without giving Ziipa your Apple password. Google and Microsoft
      can also connect from this browser.
    </Text>
  );
}
