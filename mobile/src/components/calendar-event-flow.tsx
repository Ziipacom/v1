import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Pencil,
} from "lucide-react-native";
import { Action, IconButton, Notice } from "./ui";
import { WorkflowProgress } from "./workflow-progress";
import type { CalendarDraft } from "../lib/calendar-types";
import { styles } from "../theme";

export type CalendarEditorStep = 0 | 1 | 2;
const steps = [
  { title: "Details", icon: Pencil },
  { title: "Schedule", icon: CalendarClock },
  { title: "Review", icon: CheckCircle2 },
] as const;

export function validateCalendarDetails(draft: CalendarDraft) {
  if (!draft.title.trim() || draft.title.trim().length > 140)
    throw new Error("Give the event a title of 1–140 characters.");
  if (draft.notes.length > 2000)
    throw new Error("Use up to 2,000 characters of notes.");
}

export function CalendarEventFlow({
  step,
  changeStep,
  details,
  schedule,
  review,
  validateDetails,
  validateSchedule,
  onSave,
  busy,
  canSave,
  readOnly,
  existing,
  error,
}: {
  step: CalendarEditorStep;
  changeStep: (step: CalendarEditorStep) => void;
  details: ReactNode;
  schedule: ReactNode;
  review: ReactNode;
  validateDetails: () => void;
  validateSchedule: () => void;
  onSave: () => void;
  busy: boolean;
  canSave: boolean;
  readOnly: boolean;
  existing: boolean;
  error?: string;
}) {
  const [validation, setValidation] = useState("");
  function back(target: number) {
    if (busy || target < 0 || target >= step) return;
    setValidation("");
    changeStep(target as CalendarEditorStep);
  }
  function advance() {
    if (busy || (step === 2 && (!canSave || readOnly))) return;
    setValidation("");
    try {
      validateDetails();
      if (step > 0) validateSchedule();
      if (step < 2) changeStep((step + 1) as CalendarEditorStep);
      else onSave();
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Check your event details.",
      );
    }
  }
  return (
    <View style={{ gap: 18 }}>
      <WorkflowProgress steps={steps} activeStep={step} onStepPress={back} />
      <View style={{ gap: 14 }}>
        {step === 0 ? details : step === 1 ? schedule : review}
      </View>
      {!!(validation || error) && <Notice error text={validation || error!} />}
      {readOnly && (
        <Text style={styles.small}>
          This event is cancelled. Its saved schedule is read only.
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        {step > 0 && (
          <IconButton
            icon={ArrowLeft}
            label={`Back to ${steps[step - 1].title.toLowerCase()}`}
            disabled={busy}
            onPress={() => back(step - 1)}
          />
        )}
        <View style={{ flex: 1 }}>
          <Action
            title={
              step === 0
                ? "Continue to schedule"
                : step === 1
                  ? "Review event"
                  : existing
                    ? canSave
                      ? "Save changes"
                      : "Saved"
                    : "Create event"
            }
            icon={step === 2 ? CheckCircle2 : CalendarClock}
            busy={busy}
            disabled={busy || (step === 2 && (!canSave || readOnly))}
            onPress={advance}
          />
        </View>
      </View>
    </View>
  );
}
