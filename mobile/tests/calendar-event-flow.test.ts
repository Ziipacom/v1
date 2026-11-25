import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  calendarInput,
  type CalendarDraft,
} from "../src/lib/calendar-types.ts";

const initial = (): CalendarDraft => ({
  title: "New release",
  notes: "Bring the cover art",
  kind: "reminder",
  timezone: "America/New_York",
  startsLocal: "2026-12-04T18:00",
  fold: "earlier",
  duration: "60",
  reminder: "15",
  frequency: "none",
  interval: "1",
  count: "1",
  weekdays: [],
  until: "",
  streamId: null,
  campaignId: null,
});
type Node = { type: any; props: Record<string, any> };
function harness() {
  let validation = "",
    saved = 0,
    fields: ReturnType<typeof calendarInput> | null = null;
  const state = {
    step: 0,
    busy: false,
    canSave: true,
    readOnly: false,
    existing: false,
  };
  const draft = initial();
  const jsx = (type: any, props: any) => ({ type, props });
  const code = ts.transpileModule(
    readFileSync(
      new URL("../src/components/calendar-event-flow.tsx", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports: any = {};
  new Function("exports", "require", code)(exports, (name: string) => {
    if (name === "react")
      return {
        useState: () => [
          validation,
          (next: string) => {
            validation = next;
          },
        ],
      };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native") return { Text: "Text", View: "View" };
    if (name === "lucide-react-native")
      return new Proxy({}, { get: (_, key) => key });
    if (name === "./ui")
      return { Action: "Action", IconButton: "IconButton", Notice: "Notice" };
    if (name === "./workflow-progress")
      return { WorkflowProgress: "WorkflowProgress" };
    if (name === "../theme") return { styles: {} };
    throw new Error(name);
  });
  function nodes(node: any): Node[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    return node?.props ? [node, ...nodes(node.props.children)] : [];
  }
  const render = () =>
    nodes(
      exports.CalendarEventFlow({
        ...state,
        changeStep: (step: number) => {
          state.step = step;
        },
        details: jsx("DetailsFields", {}),
        schedule: jsx("ScheduleFields", {}),
        review: jsx("ReviewSummary", {}),
        validateDetails: () => exports.validateCalendarDetails(draft),
        validateSchedule: () => {
          calendarInput(draft);
        },
        onSave: () => {
          saved++;
          fields = calendarInput(draft);
        },
      }),
    );
  return {
    state,
    draft,
    render,
    primary: () => render().find((node) => node.type === "Action")!,
    progress: () => render().find((node) => node.type === "WorkflowProgress")!,
    back: () => render().find((node) => node.type === "IconButton")!,
    error: () => render().find((node) => node.type === "Notice")?.props.text,
    result: () => ({ saved, fields }),
  };
}

test("Calendar exposes one layer and one primary action; only the final review can submit", () => {
  const h = harness();
  assert.deepEqual(
    h.progress().props.steps.map((step: any) => step.title),
    ["Details", "Schedule", "Review"],
  );
  assert.equal(h.render().filter((node) => node.type === "Action").length, 1);
  assert.ok(h.render().some((node) => node.type === "DetailsFields"));
  assert.ok(!h.render().some((node) => node.type === "ScheduleFields"));
  h.primary().props.onPress();
  assert.equal(h.state.step, 1);
  assert.equal(h.result().saved, 0);
  assert.ok(h.render().some((node) => node.type === "ScheduleFields"));
  h.primary().props.onPress();
  assert.equal(h.state.step, 2);
  assert.equal(h.result().saved, 0);
  assert.ok(h.render().some((node) => node.type === "ReviewSummary"));
  assert.equal(h.primary().props.title, "Create event");
  h.primary().props.onPress();
  assert.equal(h.result().saved, 1);
  assert.equal(h.result().fields?.starts_local, "2026-12-04T18:00:00");
  assert.equal(h.result().fields?.timezone, "America/New_York");
});

test("Details cannot advance with a missing title or oversized notes and never sends a request", () => {
  const h = harness();
  h.draft.title = " ";
  h.primary().props.onPress();
  assert.equal(h.state.step, 0);
  assert.match(h.error(), /title/);
  h.draft.title = "Valid";
  h.draft.notes = "x".repeat(2001);
  h.primary().props.onPress();
  assert.equal(h.state.step, 0);
  assert.match(h.error(), /notes/);
  assert.equal(h.result().saved, 0);
});

test("Schedule and final save retain real date, duration and recurrence validation", () => {
  const h = harness();
  h.primary().props.onPress();
  h.draft.startsLocal = "2026-02-30T18:00";
  h.primary().props.onPress();
  assert.equal(h.state.step, 1);
  assert.match(h.error(), /real calendar date/);
  h.draft.startsLocal = "2026-12-04T18:00";
  h.draft.duration = "721";
  h.primary().props.onPress();
  assert.equal(h.state.step, 1);
  assert.match(h.error(), /Duration/);
  h.draft.duration = "60";
  h.draft.frequency = "weekly";
  h.primary().props.onPress();
  assert.equal(h.state.step, 1);
  assert.match(h.error(), /weekday/);
  h.draft.weekdays = [4];
  h.primary().props.onPress();
  assert.equal(h.state.step, 2);
  h.draft.reminder = "invalid";
  h.primary().props.onPress();
  assert.match(h.error(), /Reminder/);
  assert.equal(h.result().saved, 0);
});

test("Progress permits previous steps only and preserves unsaved field input", () => {
  const h = harness();
  h.progress().props.onStepPress(2);
  assert.equal(h.state.step, 0);
  h.primary().props.onPress();
  h.draft.notes = "Keep my edit";
  h.back().props.onPress();
  assert.equal(h.state.step, 0);
  assert.equal(h.draft.notes, "Keep my edit");
  h.primary().props.onPress();
  h.primary().props.onPress();
  h.progress().props.onStepPress(0);
  assert.equal(h.state.step, 0);
  assert.equal(h.result().saved, 0);
});

test("Busy, unchanged and cancelled event states cannot submit or alter an active flow", () => {
  const h = harness();
  h.state.step = 2;
  h.state.existing = true;
  h.state.canSave = false;
  assert.equal(h.primary().props.title, "Saved");
  assert.equal(h.primary().props.disabled, true);
  h.primary().props.onPress();
  assert.equal(h.result().saved, 0);
  h.state.canSave = true;
  h.state.readOnly = true;
  h.primary().props.onPress();
  assert.equal(h.result().saved, 0);
  h.state.readOnly = false;
  h.state.busy = true;
  h.primary().props.onPress();
  h.progress().props.onStepPress(0);
  assert.equal(h.state.step, 2);
  assert.equal(h.result().saved, 0);
  h.state.busy = false;
  assert.equal(h.primary().props.title, "Save changes");
  h.primary().props.onPress();
  assert.equal(h.result().saved, 1);
});
