import { ApiError } from "./api";
import { authorizationHeaders, iosInternalTestflight, portalMode, validateOrigin } from "./config";
import { assertInternalBetaRequest } from "./internal-beta-policy";

/** Owner-bound mutations that need an HTTP method other than the shared POST helper. */
export async function creatorRequest<T>(
  path: string,
  token: string,
  method: "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes("..") || !token)
    throw new Error("Sign in to use this creator tool.");
  assertInternalBetaRequest(iosInternalTestflight, path, method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(validateOrigin() + path, {
      method,
      signal: controller.signal,
      redirect: "error",
      credentials: portalMode ? "include" : "omit",
      headers: {
        ...authorizationHeaders(token),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        typeof result?.detail === "string"
          ? result.detail
          : "This action could not complete. Refresh and try again.",
        response.status,
      );
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}
