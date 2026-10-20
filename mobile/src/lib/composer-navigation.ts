import type { Item, RootStack } from "./types";

/** Route identity preserves each editor's mounted form and removal guards.
 * It is not an ownership check; source access remains server-authoritative. */
export function composerRouteId({
  params,
}: {
  params?: RootStack["Composer"];
}): string {
  if (params?.item?.id) return `draft:${params.item.id}`;
  if (params?.upload?.id) return `upload:${params.upload.id}`;
  if (params?.remix?.id) return `remix:${params.remix.id}`;
  return "new";
}

/** Replace seeds after persistence without replacing the mounted route itself. */
export function savedComposerParams(item: Item): { item: Item } {
  return { item };
}
