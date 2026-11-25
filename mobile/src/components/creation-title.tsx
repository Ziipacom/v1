import { InfoTip } from "./info-tip";
import { Switch, Text, View } from "react-native";
import { Field } from "./ui";
import { creationTitleLimit } from "../lib/creation-title";
import { color, styles } from "../theme";
import type { CreationAutofill } from "../lib/use-creation-autofill";

export function CreationTitle({
  value,
  onChange,
  disabled,
  autofill,
  showAutofill,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  autofill: CreationAutofill;
  showAutofill: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Field
        label="Creation title (required)"
        value={value}
        onChangeText={onChange}
        maxLength={creationTitleLimit}
        editable={!disabled}
        placeholder="Give your creation a title"
      />
      {showAutofill && (
        <View style={{ gap: 6 }}>
          <View style={[styles.between, { gap: 12 }]}>
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 2,
              }}
            >
              <Text style={[styles.small, { flexShrink: 1 }]}>
                AI autofill · title & description
              </Text>
              <InfoTip
                title="AI autofill"
                content="Suggested text is based on a small preview of your selected photo or video. It fills untouched title and description fields; review and edit the text before saving."
              />
            </View>
            <Switch
              accessibilityLabel="AI autofill title and description"
              value={autofill.enabled}
              disabled={disabled}
              onValueChange={autofill.setEnabled}
              trackColor={{ false: color.border, true: color.purple }}
            />
          </View>
          <Text style={styles.small}>
            When on, share one photo preview or video frame with Cloudflare
            Workers AI. Suggestions fill these fields automatically. Edit them
            before saving.
          </Text>
          {!!autofill.message && (
            <Text accessibilityLiveRegion="polite" style={styles.small}>
              {autofill.message}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
