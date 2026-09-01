export type Category = 'video'|'music'|'games'|'live'|'nft'|'store';
export type Caption = {start:number; end:number; text:string};
export type Item = {
  id:string; title:string; description:string; category:Category; creator:string; creator_id?:number; tags:string[]; city:string;
  cover:string; media_url:string|null; content_type?:string; media_id?:string|null; label:string; demo:boolean;
  visibility?:'draft'|'published'|'hidden'; trim_start?:number; trim_end?:number|null; captions?:Caption[]; price_cents?:number|null; remix_of?:string|null;
};
export type Preferences = {saved:string[];liked:string[];muted_words:string[];blocked_creators:string[];blocked_user_ids?:number[];show_demos:boolean};
export type Feed = {id:string;name:string;category:string;tag:string;city:string;creator:string;shared?:boolean;owner_name?:string};
export type Bootstrap = {items:Item[];drafts:Item[];preferences:Preferences;feeds:Feed[];community_feeds:Feed[]};
export type Member = {name:string;email:string;joined:string;membership:string};
export const matchesFeed = (item:Item, feed:Omit<Feed,'id'>) =>
  (feed.category==='all'||item.category===feed.category) &&
  (!feed.tag.trim()||item.tags.some(t=>t.toLowerCase()===feed.tag.replace(/^#/,'').trim().toLowerCase())) &&
  (!feed.city||item.city.toLowerCase().includes(feed.city.toLowerCase())) &&
  (!feed.creator||item.creator.toLowerCase().includes(feed.creator.toLowerCase()));
