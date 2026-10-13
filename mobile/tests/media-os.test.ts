import assert from "node:assert/strict";
import { test } from "node:test";
import {
  economicTotals,
  goalStepsFromText,
  isoInstant,
  parseMinorAmount,
  type RevenueEntry,
} from "../src/lib/media-os-types.ts";

test("scheduled instants require a timezone and reject impossible calendar dates", () => {
  assert.equal(
    isoInstant("2026-10-20T18:00:00-04:00"),
    "2026-10-20T22:00:00.000Z",
  );
  assert.equal(isoInstant(""), null);
  assert.equal(isoInstant("2028-02-29T00:00:00Z"), "2028-02-29T00:00:00.000Z");
  for (const invalid of [
    "2026-10-20T18:00",
    "2026-02-30T00:00:00Z",
    "2026-10-20T24:00:00Z",
    "2026-10-20T10:60:00Z",
  ])
    assert.throws(() => isoInstant(invalid));
  assert.throws(() => isoInstant("", true));
});
test("ledger amounts preserve minor units and reject fractional or unsafe input", () => {
  assert.equal(parseMinorAmount("1250"), 1250);
  for (const invalid of ["12.50", "-100", "0", "1e9", "99999999999999999", ""])
    assert.throws(() => parseMinorAmount(invalid));
});
test("economics keep currencies and expected payments separate from realized income", () => {
  const entry = (
    amount_minor: number,
    currency: string,
    type: RevenueEntry["type"],
    status: RevenueEntry["status"],
  ): RevenueEntry => ({
    id: "id",
    amount_minor,
    currency,
    type,
    status,
    category: "creator",
    note: "",
    occurred_at: "2026-10-20T00:00:00Z",
    item_id: null,
  });
  assert.deepEqual(
    economicTotals([
      entry(1000, "USD", "income", "received"),
      entry(250, "USD", "expense", "received"),
      entry(50000, "USD", "income", "expected"),
      entry(200, "JPY", "expense", "expected"),
    ]),
    {
      USD: {
        received: 1000,
        spent: 250,
        expectedIncome: 50000,
        expectedExpense: 0,
      },
      JPY: { received: 0, spent: 0, expectedIncome: 0, expectedExpense: 200 },
    },
  );
});
test("repeated goal step titles preserve distinct identity and progress", () => {
  assert.deepEqual(
    goalStepsFromText(
      "Record\nRecord\nPublish",
      [
        { id: "first", title: "Record", completed: true },
        { id: "second", title: "Record", completed: false },
      ],
      "new",
    ),
    [
      { id: "first", title: "Record", completed: true },
      { id: "second", title: "Record", completed: false },
      { id: "new-2", title: "Publish", completed: false },
    ],
  );
  assert.throws(() => goalStepsFromText("a".repeat(141)));
});
