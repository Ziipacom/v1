import { Text, View } from "react-native";
import { deviceCalendarAppLink } from "../lib/calendar-connections";
import type { CalendarEvent } from "../lib/calendar-types";
import { styles } from "../theme";
import { Action } from "./ui";

export function DeviceCalendarPanel(_props: { events: CalendarEvent[] }) {
  const appleMobile =
    typeof navigator !== "undefined" &&
    (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (/^Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1));
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.small}>
        Device calendars are available in the installed Ziipa app. Safari and
        home-screen web apps cannot read them.
      </Text>
      {appleMobile && (
        <Action
          title="Open Ziipa app"
          secondary
          onPress={() => window.location.assign(deviceCalendarAppLink)}
        />
      )}
      <Text style={styles.small}>
        In Ziipa, go to Calendar → Connect → iOS / device calendars. Google
        and Microsoft can also connect from this browser.
      </Text>
    </View>
  );
}
