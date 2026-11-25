const diagnostic =
  /(?:\bsynthetic\b.*\bfixture\b|\btraceback\b|\bstack trace\b|\b(?:sqlalchemy|psycopg|internal server error)\b|\b(?:GET|POST|PATCH|DELETE|PUT)\s+\/api\/)/i;

export function apiFailureMessage(body: unknown, status: number): string {
  if (status >= 500) return "Ziipa couldn’t complete this request.";

  const detail =
    body && typeof body === "object" && "detail" in body ? body.detail : null;
  if (typeof detail === "string") {
    const message = detail.trim();
    if (message && message.length <= 300 && !diagnostic.test(message))
      return message;
  }

  if (status === 401) return "Sign in to continue.";
  if (status === 403) return "You don’t have access to this.";
  if (status === 404) return "This is unavailable.";
  if (status === 422) return "Check your entries and try again.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  return "Ziipa couldn’t complete this request.";
}
