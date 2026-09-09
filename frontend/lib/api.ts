// Both the website and embedded Studio use the same host-only login cookie.
// Backend routing is configured on the server, never by browser API origins.
export const API_ORIGIN = '';
export const apiUrl = (path: string) => `${API_ORIGIN}/api${path}`;

export async function api<T = unknown>(path: string, data?: unknown, expectedUser?: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: data === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(expectedUser ? { 'X-Ziipa-User': String(expectedUser) } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Unable to reach Ziipa. Please try again in a moment.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('The service is unavailable. Please try again.'); }
  if (!response.ok) {
    const detail = result && typeof result === 'object' && 'detail' in result && typeof result.detail === 'string' ? result.detail : 'Please check your details and try again.';
    const error = Object.assign(new Error(detail), { status: response.status });
    throw error;
  }
  return result as T;
}
