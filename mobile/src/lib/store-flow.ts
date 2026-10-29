import type { ListingDraft, Suggestion } from "./commerce";

/** AI prepares copy; seller-controlled price, ownership and delivery stay intact. */
export function applyListingSuggestion(
  draft: ListingDraft,
  suggestion: Suggestion,
): ListingDraft {
  return {
    ...draft,
    title: suggestion.title,
    description: suggestion.description,
    descriptor: suggestion.descriptor,
    overlay: "editorial",
  };
}

export const sellSteps = [
  { id: "create", title: "Create" },
  { id: "review", title: "Review" },
  { id: "publish", title: "Publish" },
] as const;
export type SellStep = (typeof sellSteps)[number]["id"];
