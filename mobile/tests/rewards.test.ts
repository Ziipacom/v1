import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyRewardDraft,
  rewardPoints,
  rewardRules,
} from "../src/lib/rewards-types.ts";

test("reward rules reject fractional, negative and over-limit economic amounts", () => {
  const draft = { ...emptyRewardDraft(), name: "Media circle" };
  assert.deepEqual(rewardRules(draft), {
    name: "Media circle",
    point_budget: 5000,
    per_user_daily_cap: 25,
    like_points: 1,
    save_points: 2,
    comment_points: 3,
  });
  for (const value of ["1.5", "-1", "1e3", "100001", ""])
    assert.throws(() => rewardRules({ ...draft, point_budget: value }));
  assert.throws(() => rewardRules({ ...draft, per_user_daily_cap: "101" }));
  assert.throws(() => rewardRules({ ...draft, comment_points: "21" }));
  assert.throws(() =>
    rewardRules({
      ...draft,
      like_points: "0",
      save_points: "0",
      comment_points: "0",
    }),
  );
});
test("points remain whole units and never turn unknown balances into a cash estimate", () => {
  assert.equal(rewardPoints(1250), "1,250");
  assert.equal(rewardPoints(0), "0");
  assert.equal(rewardPoints(1.5), "—");
  assert.equal(rewardPoints(Number.NaN), "—");
});
