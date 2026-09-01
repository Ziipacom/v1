export async function api<T = unknown>(path: string, data?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
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
