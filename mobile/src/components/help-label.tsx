import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { styles } from "../theme";
import { fieldHelp } from "../lib/field-help";
import { InfoTip } from "./info-tip";

export function HelpLabel({
  label,
  help = fieldHelp[label],
  style = styles.label,
}: {
  label: string;
  help?: string;
  style?: StyleProp<TextStyle>;
}) {
  if (!help) return <Text style={style}>{label}</Text>;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        marginBottom: StyleSheet.flatten(style)?.marginBottom || 0,
      }}
    >
      <Text style={[style, { marginBottom: 0, flexShrink: 1 }]}>{label}</Text>
      <InfoTip title={label} content={help} />
    </View>
  );
}
