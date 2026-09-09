import assert from "node:assert/strict";
import test from "node:test";
import {
  blankTikTok,
  validateTikTokReview,
  tikTokReviewComplete,
  type TikTokReview,
} from "../src/lib/tiktok-review.ts";
const original = "12345678-1234-4123-8123-123456789012";
const rendered = "12345678-1234-4123-8123-123456789013";
const expected = {
  itemId: "creation",
  originalId: original,
  targetId: "creator",
  renderId: "render-job",
  mediaId: rendered,
};
const review: TikTokReview = {
  item_id: "creation",
  expected_media_id: original,
  target_id: "creator",
  render_id: "render-job",
  media_id: rendered,
  source_sha256: "a".repeat(64),
  duration_seconds: 15,
  creator: {
    creator_nickname: "Test creator",
    privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
    comment_disabled: true,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 60,
  },
};
test("TikTok review binds exact target, original, rendered bytes and probe metadata", () => {
  assert.equal(validateTikTokReview(review, expected), review);
  for (const altered of [
    { ...review, target_id: "other" },
    { ...review, expected_media_id: rendered },
    { ...review, media_id: original },
    { ...review, render_id: null },
    { ...review, source_sha256: "" },
    { ...review, duration_seconds: NaN },
  ])
    assert.throws(() => validateTikTokReview(altered, expected));
});
test("TikTok has no default audience or permission; locked interactions and probed limits block posting", () => {
  assert.equal(tikTokReviewComplete(review, blankTikTok, "Title", ""), false);
  const consent = {
    ...blankTikTok,
    privacy_level: "SELF_ONLY",
    music_usage_confirmed: true,
  };
  assert.equal(tikTokReviewComplete(review, consent, "Title", ""), true);
  assert.equal(
    tikTokReviewComplete(
      review,
      { ...consent, disable_comment: false },
      "Title",
      "",
    ),
    false,
  );
  assert.equal(
    tikTokReviewComplete(
      { ...review, duration_seconds: 61 },
      consent,
      "Title",
      "",
    ),
    false,
  );
  assert.equal(tikTokReviewComplete(null, consent, "Title", ""), false);
});
test("TikTok commercial content needs an explicit classification and appropriate policy consent", () => {
  const consent = {
    ...blankTikTok,
    privacy_level: "SELF_ONLY",
    music_usage_confirmed: true,
    content_disclosure_enabled: true,
  };
  assert.equal(tikTokReviewComplete(review, consent, "Title", ""), false);
  assert.equal(
    tikTokReviewComplete(
      review,
      { ...consent, brand_organic_toggle: true },
      "Title",
      "",
    ),
    true,
  );
  assert.equal(
    tikTokReviewComplete(
      review,
      {
        ...consent,
        brand_content_toggle: true,
        branded_content_policy_confirmed: true,
      },
      "Title",
      "",
    ),
    false,
  );
  const branded = {
    ...consent,
    privacy_level: "PUBLIC_TO_EVERYONE",
    brand_content_toggle: true,
  };
  assert.equal(tikTokReviewComplete(review, branded, "Title", ""), false);
  assert.equal(
    tikTokReviewComplete(
      review,
      { ...branded, branded_content_policy_confirmed: true },
      "Title",
      "",
    ),
    true,
  );
  assert.equal(
    tikTokReviewComplete(
      review,
      {
        ...branded,
        content_disclosure_enabled: false,
        branded_content_policy_confirmed: true,
      },
      "Title",
      "",
    ),
    false,
  );
});
