import type { Category, SocialProvider } from "./types";

export const socialProviders: {
  id: SocialProvider;
  short: string;
  color: string;
  formats: string;
  supports: Array<Category | "photo" | "audio">;
}[] = [
  {
    id: "bluesky",
    short: "BS",
    color: "#1884FF",
    formats: "Posts · video · AT Protocol identity",
    supports: ["video", "music", "games", "live", "nft", "store", "photo"],
  },
  {
    id: "instagram",
    short: "IG",
    color: "#D74684",
    formats: "Reels · posts · photos",
    supports: ["video", "music", "store", "photo"],
  },
  {
    id: "tiktok",
    short: "TT",
    color: "#19151F",
    formats: "Videos · photo posts",
    supports: ["video", "music", "games", "photo"],
  },
  {
    id: "facebook",
    short: "f",
    color: "#1877F2",
    formats: "Pages · Reels · video",
    supports: ["video", "music", "games", "live", "store", "photo"],
  },
  {
    id: "youtube",
    short: "YT",
    color: "#E62117",
    formats: "Videos · Shorts · live",
    supports: ["video", "music", "games", "live"],
  },
  {
    id: "twitch",
    short: "TV",
    color: "#6441A5",
    formats: "Live stream · channel library",
    supports: ["games", "live"],
  },
];

export const socialProvider = (id: SocialProvider) =>
  socialProviders.find((provider) => provider.id === id)!;

export function providerSupports(
  id: SocialProvider,
  category: Category,
  mimeType?: string | null,
) {
  const format = mimeType?.startsWith("image/") ? "photo" : category;
  return socialProvider(id).supports.includes(format);
}
