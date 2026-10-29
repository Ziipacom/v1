import type { Item, ProfileImages } from "./types";
import type { NetworkHub } from "./network-hub";

export type ProfileCollection = "creations" | "saved" | "tagged";
export type ProfileCollections = {
  creator: { id: number; name: string };
  profile: ProfileImages;
  items: Item[];
  tagged: (Item & { profile_tag_revision: number })[];
  pending_tags: { item: Item; revision: number }[];
  network: NetworkHub;
  sharing: { providers: string[]; revision: number } | null;
  saved_private: true;
  access: "allowed" | "followers_only";
  privacy: { visibility: "public" | "members" | "private"; revision: number };
  audience: AudienceCounts | null;
  relationship: {
    status: "none" | "pending" | "accepted" | "cancelled" | "declined";
    revision: number;
    self: boolean;
  };
};

export type AudienceCounts = {
  provider?: string;
  name?: string;
  followers?: number | null;
  following?: number | null;
  updated_at?: string | null;
};

export function audienceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** A display name is never used as an account identifier. */
export function creatorProfileParams(item: Pick<Item, "creator_id" | "demo">) {
  return !item.demo &&
    Number.isSafeInteger(item.creator_id) &&
    (item.creator_id || 0) > 0
    ? { creatorId: item.creator_id as number }
    : null;
}
