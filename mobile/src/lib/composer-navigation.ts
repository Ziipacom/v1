import type { RootStack } from "./types";

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
