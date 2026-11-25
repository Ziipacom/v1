import { Pressable, Text, View } from "react-native";
import { Check, type LucideIcon } from "lucide-react-native";
import { color, font, useTheme } from "../theme";

export function WorkflowProgress({
  steps,
  activeStep,
  onStepPress,
}: {
  steps: readonly { title: string; icon?: LucideIcon }[];
  activeStep: number;
  onStepPress?: (index: number) => void;
}) {
  useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 7 }}>
      {steps.map(({ title, icon }, index) => {
        const complete = index < activeStep;
        const active = index === activeStep;
        const Icon = complete ? Check : icon;
        const tint = active ? color.text : color.muted;
        const content = (
          <>
            <View
              style={{
                height: 3,
                borderRadius: 2,
                alignSelf: "stretch",
                backgroundColor: active
                  ? color.lime
                  : complete
                    ? color.purple
                    : color.border,
              }}
            />
            <View style={{ alignItems: "center", gap: 3, paddingVertical: 5 }}>
              {Icon && <Icon size={14} color={active ? color.lime : tint} />}
              <Text
                style={{
                  fontFamily: active ? font.semibold : font.medium,
                  fontSize: 12,
                  color: tint,
                  textAlign: "center",
                }}
              >
                {title}
              </Text>
            </View>
          </>
        );
        const label = `Step ${index + 1} of ${steps.length}, ${title}${active ? ", current" : complete ? ", completed" : ""}`;
        return complete && onStepPress ? (
          <Pressable
            key={title}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => onStepPress(index)}
          >
            {content}
          </Pressable>
        ) : (
          <View
            key={title}
            accessible
            accessibilityLabel={label}
            style={{ flex: 1, minWidth: 0 }}
          >
            {content}
          </View>
        );
      })}
    </View>
  );
}
