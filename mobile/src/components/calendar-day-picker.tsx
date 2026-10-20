import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import {
  calendarMonthGrid,
  calendarWeekdays,
  shiftCalendarMonth,
} from "../lib/calendar-types";
import { color, styles, useTheme } from "../theme";

export function CalendarDayPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (date: string) => void;
  disabled?: boolean;
}) {
  useTheme();
  const selectedMonth = /^(20\d{2}|2100)-(0[1-9]|1[0-2])-\d{2}$/.test(value)
    ? value.slice(0, 7)
    : null;
  const [month, setMonth] = useState(
    selectedMonth || new Date().toISOString().slice(0, 7),
  );
  useEffect(() => {
    if (selectedMonth) setMonth(selectedMonth);
  }, [selectedMonth]);
  const title = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));
  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: color.border,
        borderRadius: 15,
      }}
    >
      <View style={styles.between}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          disabled={disabled || month === "2000-01"}
          onPress={() => setMonth(shiftCalendarMonth(month, -1))}
          style={{ padding: 10 }}
        >
          <ChevronLeft color={color.text} size={22} />
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={styles.label}>
          {title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          disabled={disabled || month === "2100-12"}
          onPress={() => setMonth(shiftCalendarMonth(month, 1))}
          style={{ padding: 10 }}
        >
          <ChevronRight color={color.text} size={22} />
        </Pressable>
      </View>
      <View style={{ flexDirection: "row" }}>
        {calendarWeekdays.map((day) => (
          <Text
            key={day}
            style={[styles.small, { width: "14.2857%", textAlign: "center" }]}
          >
            {day}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {calendarMonthGrid(month).map((cell) => (
          <View key={cell.date} style={{ width: "14.2857%", padding: 2 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cell.date}
              accessibilityState={{
                selected: value === cell.date,
                disabled: disabled || !cell.supported,
              }}
              disabled={disabled || !cell.supported}
              onPress={() => onChange(cell.date)}
              style={{
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                backgroundColor:
                  value === cell.date ? color.purple : "transparent",
                borderWidth: 1,
                borderColor: value === cell.date ? color.lime : "transparent",
                opacity: cell.inMonth ? 1 : 0.4,
              }}
            >
              <Text style={[styles.body, { color: value === cell.date ? color.onAccent : color.text }]}>
                {cell.day}
              </Text>
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}
