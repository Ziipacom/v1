import assert from "node:assert/strict";
import test from "node:test";
import { apiFailureMessage } from "../src/lib/api-feedback.ts";

test("API feedback keeps technical failures out of customer-facing screens", () => {
  assert.equal(
    apiFailureMessage(
      { detail: "No synthetic GET fixture for this endpoint." },
      404,
    ),
    "This is unavailable.",
  );
  assert.equal(
    apiFailureMessage({ detail: "Database error: private table" }, 503),
    "Ziipa couldn’t complete this request.",
  );
  assert.equal(
    apiFailureMessage(
      { detail: [{ loc: ["body", "event_id"], msg: "Invalid input" }] },
      422,
    ),
    "Check your entries and try again.",
  );
});

test("API feedback preserves actionable conflict copy", () => {
  const detail = "This event changed. Refresh it before saving.";
  assert.equal(apiFailureMessage({ detail }, 409), detail);
});
