export type Category = "video" | "music" | "games" | "live" | "nft" | "store";
export type Caption = { start: number; end: number; text: string };
export type Overlay = {
  id: string;
  text: string;
  position: "top" | "center" | "bottom";
  theme: "light" | "dark" | "purple" | "lime";
};
export type Soundtrack = {
  media_id: string | null;
  name: string;
  volume: number;
  start: number;
};
export type SocialProvider =
  "bluesky" | "facebook" | "instagram" | "tiktok" | "twitch" | "youtube";
export type SocialConnection = {
  provider: SocialProvider;
  name: string;
  capability: string;
  status: "connected" | "disconnected" | "action_required";
  handle: string;
  configured: boolean;
};
export type Distribution = {
  id: string;
  item_id: string;
  provider: SocialProvider;
  status:
    | "connection_required"
    | "provider_setup_required"
    | "unsupported_media"
    | "queued"
    | "published"
    | "failed";
  detail: string;
  external_url: string;
  updated_at: string;
};
export type Item = {
  id: string;
  title: string;
  description: string;
  category: Category;
  creator: string;
  creator_id?: number;
  tags: string[];
  city: string;
  cover: string;
  media_url: string | null;
  media_id?: string | null;
  content_type?: string | null;
  demo: boolean;
  label: string;
  visibility?: "draft" | "published" | "hidden";
  trim_start?: number;
  trim_end?: number | null;
  captions?: Caption[];
  price_cents?: number | null;
  remix_of?: string | null;
  overlays?: Overlay[];
  soundtrack?: Soundtrack | null;
  distribution_targets?: SocialProvider[];
  distribution?: Distribution[];
  created_at?: string;
};
export type ItemInput = Pick<
  Item,
  "title" | "description" | "category" | "tags" | "city"
> & {
  visibility: "draft" | "published";
  media_id: string | null;
  trim_start: number;
  trim_end: number | null;
  captions: Caption[];
  price_cents: number | null;
  remix_of: string | null;
  overlays: Overlay[];
  soundtrack: Soundtrack | null;
  distribution_targets: SocialProvider[];
};
export type Preferences = {
  saved: string[];
  liked: string[];
  muted_words: string[];
  blocked_creators: string[];
  blocked_user_ids: number[];
  show_demos: boolean;
};
export type FeedInput = {
  name: string;
  category: Category | "all";
  tag: string;
  city: string;
  creator: string;
  shared: boolean;
};
export type Feed = FeedInput & { id: string; owner_name?: string };
export type Bootstrap = {
  items: Item[];
  drafts: Item[];
  preferences: Preferences;
  feeds: Feed[];
  community_feeds: Feed[];
  connections: SocialConnection[];
  distributions: Distribution[];
};
export type User = {
  id: number;
  name: string;
  email: string;
  joined?: string;
  is_moderator?: boolean;
};
export type Session = { access_token: string; expires_at: string; user: User };
export type Comment = {
  id: string;
  body: string;
  creator: string;
  creator_id: number;
};
export type RootStack = {
  Welcome: undefined;
  Login: { register?: boolean } | undefined;
  Main: { category?: Category } | undefined;
  Watch: { itemId?: string; category?: Category } | undefined;
  Studio: { category?: Category; edit?: boolean } | undefined;
  Profile: undefined;
  Feeds: undefined;
  Utility: { kind: "wallet" | "promote" | "inbox"; item?: Item };
  Post: { item: Item };
  Composer: { item?: Item; remix?: Item; category?: Category } | undefined;
  Connections: undefined;
  Settings: undefined;
  Legal: { kind: "privacy" | "terms" | "community" };
  Moderation: undefined;
};

export const emptyPreferences: Preferences = {
  saved: [],
  liked: [],
  muted_words: [],
  blocked_creators: [],
  blocked_user_ids: [],
  show_demos: true,
};
