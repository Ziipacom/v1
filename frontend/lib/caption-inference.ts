/** Private API-to-Workers-AI caption bridge. No URLs, prompts or audio storage. */
export const CAPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const CAPTION_MAX_WAV_BYTES = 44 + 90 * 16000 * 2;
type Binding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
export type CaptionEnvironment = {
  ZIIPA_MUSIC_AI?: Binding;
  ZIIPA_PROXY_SECRET?: string;
  /** Enable manually only after verifying Workers Free; never enable on Paid. */
  ZIIPA_CAPTION_AI_FREE_ENABLED?: string;
};
type Cue = { start: number; end: number; text: string };
const encoder = new TextEncoder();
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');

async function boundedBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > CAPTION_MAX_WAV_BYTES)) throw new Error('size');
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > CAPTION_MAX_WAV_BYTES) { await reader.cancel(); throw new Error('size'); }
    chunks.push(next.value);
  }
  if (declared !== null && Number(declared) !== size) throw new Error('size');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

function wavDuration(body: ArrayBuffer): number {
  if (body.byteLength < 46 || body.byteLength > CAPTION_MAX_WAV_BYTES) throw new Error('wave');
  const view = new DataView(body);
  // Only a canonical44-byte RIFF header, one PCM fmt chunk and one data chunk.
  // Reject extra LIST/prompt/control chunks, compressed codecs and trailing data.
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(body, offset, 4));
  const bytes = view.getUint32(40, true);
  if (tag(0) !== 'RIFF' || view.getUint32(4, true) !== body.byteLength - 8 || tag(8) !== 'WAVE' ||
      tag(12) !== 'fmt ' || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 ||
      view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 ||
      view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      tag(36) !== 'data' || bytes !== body.byteLength - 44 || bytes < 2 || bytes % 2 !== 0) throw new Error('wave');
  return bytes / 32000;
}

function audioBase64(body: ArrayBuffer): string {
  const bytes = new Uint8Array(body);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
}

function validatedCues(output: unknown, duration: number): Cue[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('shape');
  const segments = (output as { segments?: unknown }).segments;
  if (!Array.isArray(segments) || segments.length > 100) throw new Error('shape');
  let previousEnd = 0;
  return segments.map(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw new Error('cue');
    const { start, end, text } = segment;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < previousEnd || start < 0 || end <= start || end > duration || typeof text !== 'string' ||
        !text.trim() || text.length > 250 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('cue');
    previousEnd = end;
    // Preserve model timings exactly. Never guess, stretch, split or manufacture
    // cues from a text-only response. Provider metadata is not returned.
    return { start, end, text: text.trim() };
  });
}

export async function captionInference(request: Request, env: CaptionEnvironment, now = Date.now()) {
  const url = new URL(request.url);
  const isStatus = request.method === 'GET' && url.pathname === '/internal/caption-inference/status';
  const isTranscription = request.method === 'POST' && url.pathname === '/internal/caption-inference';
  if ((!isStatus && !isTranscription) || url.search) return reply({ detail: 'Not found.' }, 404);
  const secret = env.ZIIPA_PROXY_SECRET || '';
  if (secret.length < 32 || !env.ZIIPA_MUSIC_AI || env.ZIIPA_CAPTION_AI_FREE_ENABLED !== 'true') {
    return reply({ detail: 'Free caption inference is not enabled.' }, 503);
  }
  const stamp = request.headers.get('x-ziipa-caption-timestamp') || '';
  const signature = request.headers.get('x-ziipa-caption-signature') || '';
  if (request.headers.has('origin') || !/^\d{10}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > 30 || !/^[a-f0-9]{64}$/.test(signature)) {
    return reply({ detail: 'Not authorized.' }, 401);
  }
  let body: ArrayBuffer;
  try { body = await boundedBody(request); } catch { return reply({ detail: 'Request too large or incomplete.' }, 413); }
  const digest = hex(await crypto.subtle.digest('SHA-256', body));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const supplied = Uint8Array.from(signature.match(/../g)!, value => parseInt(value, 16));
  if (!await crypto.subtle.verify('HMAC', key, supplied, encoder.encode(`ziipa-caption-v1\n${stamp}\n${digest}`))) {
    return reply({ detail: 'Not authorized.' }, 401);
  }
  if (isStatus) {
    if (body.byteLength) return reply({ detail: 'Invalid request.' }, 400);
    return reply({ available: true, model: CAPTION_MODEL }); // No inference quota consumed.
  }
  let duration: number;
  try {
    if (request.headers.get('content-type')?.toLowerCase() !== 'audio/wav' || request.headers.has('content-encoding')) throw new Error('type');
    duration = wavDuration(body);
  } catch { return reply({ detail: 'A bounded mono16kHz16-bit PCM WAV is required.' }, 400); }
  try {
    // Official binding accepts base64 audio. Omit language for automatic
    // detection; fixed task/VAD/context controls, no prompts, gateway or tools.
    // https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
    const output = await env.ZIIPA_MUSIC_AI.run(CAPTION_MODEL, {
      audio: audioBase64(body), task: 'transcribe', vad_filter: true, condition_on_previous_text: false,
    });
    return reply({ result: { segments: validatedCues(output, duration) }, model: CAPTION_MODEL });
  } catch {
    return reply({ detail: 'Free caption inference is unavailable or its allowance is exhausted.' }, 503);
  }
}
