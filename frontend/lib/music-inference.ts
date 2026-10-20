/** Private Render-to-Cloudflare composition bridge. Never a browser AI proxy. */
export const MUSIC_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
type Binding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
export type MusicEnvironment = {
  ZIIPA_MUSIC_AI?: Binding;
  ZIIPA_PROXY_SECRET?: string;
  /** Set manually only after confirming Workers Free; never enable on Paid. */
  ZIIPA_MUSIC_AI_FREE_ENABLED?: string;
};
const encoder = new TextEncoder();
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');

async function boundedBody(request: Request): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new Error('size'); }
    chunks.push(next.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

export async function musicInference(request: Request, env: MusicEnvironment, now = Date.now()) {
  const url = new URL(request.url);
  const isStatus = request.method === 'GET' && url.pathname === '/internal/music-inference/status';
  const isCompose = request.method === 'POST' && url.pathname === '/internal/music-inference';
  if ((!isStatus && !isCompose) || url.search) return reply({ detail: 'Not found.' }, 404);
  const secret = env.ZIIPA_PROXY_SECRET || '';
  if (secret.length < 32 || !env.ZIIPA_MUSIC_AI || env.ZIIPA_MUSIC_AI_FREE_ENABLED !== 'true') {
    return reply({ detail: 'Free music inference is not enabled.' }, 503);
  }
  const stamp = request.headers.get('x-ziipa-music-timestamp') || '';
  const signature = request.headers.get('x-ziipa-music-signature') || '';
  // Reject browser-supplied requests before reading or parsing their body.
  if (!/^\d{10}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > 30 || !/^[a-f0-9]{64}$/.test(signature)) {
    return reply({ detail: 'Not authorized.' }, 401);
  }
  let body: ArrayBuffer;
  try { body = await boundedBody(request); } catch { return reply({ detail: 'Request too large.' }, 413); }
  const digest = hex(await crypto.subtle.digest('SHA-256', body));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const supplied = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
  if (!await crypto.subtle.verify('HMAC', key, supplied, encoder.encode(`ziipa-music-v1\n${stamp}\n${digest}`))) {
    return reply({ detail: 'Not authorized.' }, 401);
  }
  if (isStatus) {
    if (body.byteLength) return reply({ detail: 'Invalid request.' }, 400);
    // Presence/activation readiness; production acceptance separately runs one
    // real composition. This status call consumes no model inference quota.
    return reply({ available: true, model: MUSIC_MODEL });
  }
  let payload: { messages: { role: string; content: string }[]; format: Record<string, unknown>; request_id: string };
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    const fields = Object.keys(payload).sort().join(',');
    if (fields !== 'format,messages,request_id' || !/^[a-f0-9-]{36}$/.test(payload.request_id) ||
        !Array.isArray(payload.messages) || ![2, 4].includes(payload.messages.length) ||
        !['system,user', 'system,user,assistant,user'].includes(payload.messages.map(m => m.role).join(',')) ||
        payload.messages.some(m => Object.keys(m).sort().join(',') !== 'content,role' || typeof m.content !== 'string') ||
        payload.messages.reduce((n, m) => n + m.content.length, 0) > 4500 ||
        !payload.format || Array.isArray(payload.format) || payload.format.type !== 'object' ||
        JSON.stringify(payload.format).length > 3500 || /"\$(?:ref|dynamicRef|id)"/.test(JSON.stringify(payload.format))) throw new Error('shape');
  } catch { return reply({ detail: 'Invalid composition request.' }, 400); }
  try {
    // Fixed model, fixed budget, no tools, no retrieval, no gateway logging,
    // no paid/provider fallback. API enforces global Redis quotas before this.
    const output = await env.ZIIPA_MUSIC_AI.run(MUSIC_MODEL, {
      messages: payload.messages,
      response_format: { type: 'json_schema', json_schema: payload.format },
      max_tokens: 650,
      temperature: 0.65,
      stream: false,
    });
    const response = output as { response?: unknown };
    const result = typeof response?.response === 'string' ? JSON.parse(response.response) : response?.response;
    if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 12000) throw new Error('shape');
    // The API validates all notes, voices, timing and polyphony before returning
    // any arrangement to clients. No model output executes in this Worker.
    return reply({ result, model: MUSIC_MODEL });
  } catch {
    return reply({ detail: 'Free music inference is unavailable or its allowance is exhausted.' }, 503);
  }
}
