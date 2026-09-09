export type TikTokCreatorOptions = {
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
};
export type TikTokReview = {
  item_id: string;
  media_id: string;
  render_id: string | null;
  expected_media_id: string;
  target_id: string;
  source_sha256: string;
  duration_seconds: number;
  creator: TikTokCreatorOptions;
};
export type TikTokChoices = {
  privacy_level: string;
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
  content_disclosure_enabled: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
  is_aigc: boolean;
  music_usage_confirmed: boolean;
  branded_content_policy_confirmed: boolean;
};
export const blankTikTok: TikTokChoices = {
  privacy_level: "",
  disable_comment: true,
  disable_duet: true,
  disable_stitch: true,
  content_disclosure_enabled: false,
  brand_content_toggle: false,
  brand_organic_toggle: false,
  is_aigc: false,
  music_usage_confirmed: false,
  branded_content_policy_confirmed: false,
};

export function validateTikTokReview(
  review: TikTokReview,
  expected: {
    itemId: string;
    originalId: string;
    targetId: string;
    renderId: string | null;
    mediaId: string;
  },
) {
  if (
    review.item_id !== expected.itemId ||
    review.expected_media_id !== expected.originalId ||
    review.target_id !== expected.targetId ||
    review.render_id !== expected.renderId ||
    review.media_id !== expected.mediaId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      review.media_id,
    ) ||
    !/^[0-9a-f]{64}$/i.test(review.source_sha256) ||
    !Number.isFinite(review.duration_seconds) ||
    review.duration_seconds <= 0 ||
    !review.creator ||
    !Number.isFinite(review.creator.max_video_post_duration_sec) ||
    review.creator.max_video_post_duration_sec <= 0 ||
    !Array.isArray(review.creator.privacy_level_options) ||
    typeof review.creator.creator_nickname !== "string"
  )
    throw new Error(
      "The TikTok review no longer matches this source or account. Refresh the review before publishing.",
    );
  return review;
}

export function tikTokReviewComplete(
  review: TikTokReview | null,
  choice: TikTokChoices,
  title: string,
  description: string,
) {
  if (
    !review ||
    !title.trim() ||
    title.length > 100 ||
    /[<>]/.test(title) ||
    (title.trim() + (description ? "\n" + description : "")).length > 2200 ||
    review.duration_seconds > review.creator.max_video_post_duration_sec ||
    !review.creator.privacy_level_options.includes(choice.privacy_level) ||
    !choice.music_usage_confirmed ||
    (review.creator.comment_disabled && !choice.disable_comment) ||
    (review.creator.duet_disabled && !choice.disable_duet) ||
    (review.creator.stitch_disabled && !choice.disable_stitch)
  )
    return false;
  const branded = choice.brand_content_toggle || choice.brand_organic_toggle;
  if (choice.content_disclosure_enabled !== branded) return false;
  if (
    choice.brand_content_toggle &&
    (choice.privacy_level === "SELF_ONLY" ||
      !choice.branded_content_policy_confirmed)
  )
    return false;
  return true;
}
