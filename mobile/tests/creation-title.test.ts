import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  initialCreationTitle,
  requiredCreationTitle,
  suggestedCreationTitle,
  createCreationCopyController,
  suggestedCreationCopy,
} from "../src/lib/creation-title.ts";

test("old camera and UUID titles need review while human titles are preserved", () => {
  for (const value of [
    "IMG_3432",
    "IMG_3432.HEIC",
    "VID_20261123_002",
    "81D1199D-4CD7-48E1-B565-5F13C54D48A3",
  ])
    assert.equal(initialCreationTitle(value), "");
  assert.equal(
    initialCreationTitle("Beneath the Eiffel Tower"),
    "Beneath the Eiffel Tower",
  );
  assert.equal(initialCreationTitle("Summer 2026"), "Summer 2026");
});

const suggestion = {
  title: "A Shepherd in Spectacles",
  description: "A German shepherd wears bright green glasses.",
};
test("AI fills actual form values and leaves existing descriptions untouched", () => {
  const controller = createCreationCopyController();
  const values = { title: "", description: "My own description" };
  assert.deepEqual(controller.apply("photo-a", values, suggestion), {
    ...values,
    title: suggestion.title,
  });
  assert.equal(
    controller.needs("photo-a", { ...values, title: suggestion.title }),
    false,
  );
});

test("typed text, including deliberate clearing, wins over an in-flight suggestion", () => {
  const controller = createCreationCopyController();
  controller.edit("title");
  assert.deepEqual(
    controller.apply("photo-a", { title: "", description: "" }, suggestion),
    { title: "", description: suggestion.description },
  );
  controller.edit("description");
  assert.deepEqual(
    controller.apply(
      "photo-b",
      { title: "Typed", description: "Changed" },
      suggestion,
    ),
    { title: "Typed", description: "Changed" },
  );
});

test("replacing media refreshes generated copy but preserves fields the author edited", () => {
  const controller = createCreationCopyController();
  const first = controller.apply(
    "photo-a",
    { title: "", description: "" },
    suggestion,
  );
  const second = {
    title: "Beneath the Eiffel Tower",
    description: "A view beneath the tower.",
  };
  assert.equal(controller.needs("photo-b", first), true);
  controller.edit("description");
  assert.deepEqual(
    controller.apply(
      "photo-b",
      { ...first, description: "My description" },
      second,
    ),
    { title: second.title, description: "My description" },
  );
});

test("the combined suggestion requires a bounded description with the title", () => {
  assert.deepEqual(suggestedCreationCopy(suggestion), suggestion);
  for (const description of [
    undefined,
    "",
    "  ",
    "x".repeat(601),
    "<b>photo</b>",
    "https://example.test",
    "a\nb",
  ])
    assert.throws(() =>
      suggestedCreationCopy({ title: "A scene", description }),
    );
});

test("titles are required for drafts as well as published creations", () => {
  for (const value of ["", " ", "\t\n", "\u00a0"])
    assert.throws(() => requiredCreationTitle(value), /required/);
  assert.equal(
    requiredCreationTitle("  Beneath the Eiffel Tower  "),
    "Beneath the Eiffel Tower",
  );
  assert.throws(() => requiredCreationTitle("a".repeat(141)), /140/);
});

test("suggestions must be a usable plain title, never a fabricated filename fallback", () => {
  assert.equal(
    suggestedCreationTitle({ title: "A Shepherd in Spectacles" }),
    "A Shepherd in Spectacles",
  );
  for (const output of [
    null,
    {},
    { title: "" },
    { title: "  " },
    { title: "a".repeat(141) },
    { title: "<a>Click</a>" },
    { title: "https://example.test" },
    { title: "Title\nexplanation" },
  ])
    assert.throws(() => suggestedCreationTitle(output));
});
