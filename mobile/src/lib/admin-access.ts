export const adminRoot = "/api/admin";
export type AdminRole = "member" | "moderator" | "admin" | "owner";
export type AdminIdentity = {
  user_id: number;
  role: AdminRole;
  permissions: string[];
  owner_protected: boolean;
};

/** Unknown or incomplete deployment responses never unlock privileged UI. */
export function isAdminIdentity(value: unknown): value is AdminIdentity {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.user_id) &&
    Number(row.user_id) > 0 &&
    ["member", "moderator", "admin", "owner"].includes(String(row.role)) &&
    typeof row.role === "string" &&
    typeof row.owner_protected === "boolean" &&
    Array.isArray(row.permissions) &&
    row.permissions.length <= 30 &&
    row.permissions.every(
      (item) => typeof item === "string" && /^[a-z]+\.[a-z]+$/.test(item),
    )
  );
}

/** UI hints only. Current server authorization remains mandatory for each request. */
export function canAdmin(identity: AdminIdentity | null, permission: string) {
  return (
    isAdminIdentity(identity) &&
    ["owner", "admin", "moderator"].includes(identity.role) &&
    identity.permissions.includes(permission)
  );
}

export function adminPagePath(
  resource: "users" | "content" | "reports" | "audit",
  page: number,
  filter = "",
) {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("Choose a valid dashboard page.");
  const query = `page=${page}&page_size=25`;
  const extra =
    resource === "reports"
      ? `&status=${encodeURIComponent(filter || "open")}`
      : resource === "users" || resource === "content"
        ? `&q=${encodeURIComponent(filter)}`
        : "";
  return `${adminRoot}/${resource}?${query}${extra}`;
}
