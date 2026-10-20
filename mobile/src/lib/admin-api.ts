import { ApiError } from "./api";
import { authorizationHeaders, portalMode, validateOrigin } from "./config";
import { adminRoot, type AdminRole } from "./admin-access";
export {
  adminRoot,
  canAdmin,
  isAdminIdentity,
  adminPagePath,
} from "./admin-access";
export type { AdminRole, AdminIdentity } from "./admin-access";
export type AdminPage<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};
export type AdminUser = {
  id: number;
  name: string;
  email: string;
  role: AdminRole;
  status: "active" | "suspended";
  version: number;
  created_at: string;
};
export type AdminContent = {
  id: string;
  title: string;
  category: string;
  owner_id: number;
  owner_name: string;
  visibility: string;
  hidden: boolean;
  version: number;
  created_at: string;
};
export type AdminComment = {
  id: string;
  item_id: string;
  owner_id: number;
  body: string;
  hidden: boolean;
  version: number;
  created_at: string;
};
export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";
export type AdminReport = {
  id: string;
  item_id: string | null;
  comment_id: string | null;
  target_owner_id: number | null;
  reporter_id: number;
  reason: string;
  details: string;
  status: ReportStatus;
  version: number;
  created_at: string;
};
export type AdminSettings = {
  maintenance_mode: boolean;
  signup_paused: boolean;
  banner: string;
  version: number;
};
export type AdminOverview = {
  users: number | null;
  active_users: number | null;
  suspended_users: number | null;
  published_content: number;
  hidden_content: number;
  open_reports: number;
  role: AdminRole;
};
export type AdminAudit = {
  id: number;
  actor_id: number;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  created_at: string;
};

/** PATCH/PUT preserve the same portal-cookie/native-bearer rules as creator tools. */
export async function adminMutation<T>(
  path: string,
  token: string,
  method: "PATCH" | "PUT",
  body: Record<string, unknown>,
): Promise<T> {
  if (!path.startsWith(`${adminRoot}/`) || path.includes("..") || !token)
    throw new Error("Sign in to manage Ziipa.");
  if (
    !Number.isSafeInteger(body.expected_version) ||
    Number(body.expected_version) < 0 ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 5 ||
    body.reason.length > 500 ||
    /[\x00-\x1f\x7f]/.test(body.reason)
  )
    throw new Error(
      "Refresh this record and enter a plain-text reason of 5 to 500 characters on one line.",
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(validateOrigin() + path, {
      method,
      signal: controller.signal,
      credentials: portalMode ? "include" : "omit",
      redirect: "error",
      headers: {
        ...authorizationHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        typeof result?.detail === "string"
          ? result.detail
          : "This administrative action could not complete. Refresh before trying again.",
        response.status,
      );
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(
      "The result could not be confirmed. Refresh the record and audit history before trying again.",
    );
  } finally {
    clearTimeout(timer);
  }
}
