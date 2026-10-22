/** Private API-to-Worker preset narration bridge. No browser proxy or voice cloning. */
export const NARRATION_MODEL = '@cf/deepgram/aura-1';
const MAX_INPUT_BYTES = 4096;
const MAX_PCM_BYTES = 24000 * 2 * 30;
const MAX_HEADER_BYTES = 65536;
const MAX_WAV_BYTES = MAX_PCM_BYTES + 44 + MAX_HEADER_BYTES;
const DEADLINE_MS = 30000;
const voices = new Set(['athena', 'helios', 'asteria', 'orion']);
type Binding = { run(model: string, input: Record<string, unknown>, options: { returnRawResponse: true }): Promise<unknown> };
export type NarrationEnvironment = {
  ZIIPA_MUSIC_AI?: Binding;
  ZIIPA_PROXY_SECRET?: string;
  /** Enable only after confirming the free account and a real bounded WAV acceptance. */
  ZIIPA_NARRATION_AI_FREE_ENABLED?: string;
  ZIIPA_NARRATION_AI_VERIFIED?: string;
};
const encoder = new TextEncoder();
const safeHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: safeHeaders });
const unavailable = () => reply({ detail: 'Free narration inference is unavailable or its allowance is exhausted.' }, 503);
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');

/** Accept only fixed PCM, then remove ancillary chunks rather than relay provider metadata. */
function canonicalWav(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 44 || bytes.length > MAX_WAV_BYTES || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) throw new Error('wav');
  let offset = 12, overhead = 12, format = false, data: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) throw new Error('chunk');
    overhead += 8 + (kind === 'data' ? 0 : size + size % 2);
    if (overhead > MAX_HEADER_BYTES) throw new Error('header');
    if (kind === 'fmt ') {
      if (format || ![16, 18].includes(size) || (size === 18 && view.getUint16(start + 16, true) !== 0) ||
        view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== 24000 ||
        view.getUint32(start + 8, true) !== 48000 || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw new Error('pcm');
      format = true;
    } else if (kind === 'data') {
      if (data || !size || size % 2 || size > MAX_PCM_BYTES) throw new Error('data');
      data = bytes.subarray(start, end);
    }
    offset = end + size % 2;
  }
  if (!format || !data || offset !== bytes.length || bytes.length - data.length > MAX_HEADER_BYTES) throw new Error('shape');
  const result = new Uint8Array(44 + data.length), output = new DataView(result.buffer);
  result.set(encoder.encode('RIFF'), 0); output.setUint32(4, result.length - 8, true); result.set(encoder.encode('WAVEfmt '), 8);
  output.setUint32(16, 16, true); output.setUint16(20, 1, true); output.setUint16(22, 1, true); output.setUint32(24, 24000, true);
  output.setUint32(28, 48000, true); output.setUint16(32, 2, true); output.setUint16(34, 16, true);
  result.set(encoder.encode('data'), 36); output.setUint32(40, data.length, true); result.set(data, 44);
  return result;
}

export async function narrationInference(request: Request, env: NarrationEnvironment, now = Date.now()) {
  const url = new URL(request.url);
  const isStatus = request.method === 'GET' && url.pathname === '/internal/narration-inference/status';
  const isGenerate = request.method === 'POST' && url.pathname === '/internal/narration-inference';
  if ((!isStatus && !isGenerate) || url.search) return reply({ detail: 'Not found.' }, 404);
  const secret = env.ZIIPA_PROXY_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || !env.ZIIPA_MUSIC_AI || typeof env.ZIIPA_MUSIC_AI.run !== 'function' ||
    env.ZIIPA_NARRATION_AI_FREE_ENABLED !== 'true' || env.ZIIPA_NARRATION_AI_VERIFIED !== 'true') return unavailable();
  const stamp = request.headers.get('x-ziipa-narration-timestamp') || '';
  const signature = request.headers.get('x-ziipa-narration-signature') || '';
  if (!/^\d{10}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > 30 || !/^[a-f0-9]{64}$/.test(signature)) return reply({ detail: 'Not authorized.' }, 401);
  let stopped = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stop!: (cause: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { stop = reject; });
  void interrupted.catch(() => {}); // An already-aborted request may stop before the first race.
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    void reader?.cancel().catch(() => {});
    stop(new Error('stopped'));
  };
  const timer = setTimeout(cancel, DEADLINE_MS);
  request.signal.addEventListener('abort', cancel, { once: true });
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, interrupted]);
  const read = async (stream: ReadableStream<Uint8Array> | null, limit: number) => {
    if (stopped || request.signal.aborted) throw new Error('stopped');
    if (!stream) return new Uint8Array(0);
    reader = stream.getReader();
    const chunks: Uint8Array[] = []; let size = 0, complete = false;
    try {
      for (;;) {
        const next = await wait(reader.read());
        if (stopped) throw new Error('stopped');
        if (next.done) { complete = true; break; }
        if (!(next.value instanceof Uint8Array)) throw new Error('binary');
        size += next.value.byteLength;
        if (size > limit) throw new Error('size');
        chunks.push(next.value);
      }
    } finally { if (!complete) void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} reader = undefined; }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  };
  try {
    if (request.signal.aborted) cancel();
    let body: Uint8Array<ArrayBuffer>;
    try { body = await read(request.body, MAX_INPUT_BYTES); }
    catch (cause) { return cause instanceof Error && cause.message === 'size' ? reply({ detail: 'Request too large.' }, 413) : unavailable(); }
    const digest = hex(await wait(crypto.subtle.digest('SHA-256', body)));
    const key = await wait(crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']));
    const supplied = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
    if (!await wait(crypto.subtle.verify('HMAC', key, supplied, encoder.encode(`ziipa-narration-v1\n${stamp}\n${digest}`)))) return reply({ detail: 'Not authorized.' }, 401);
    if (isStatus) {
      if (body.byteLength) return reply({ detail: 'Invalid request.' }, 400);
      // Binding/activation readiness only; status never invokes the model.
      return reply({ available: true, model: NARRATION_MODEL, version: 1 });
    }
    let payload: { version: 1; text: string; voice_id: string };
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!payload || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'text,version,voice_id' || payload.version !== 1 ||
        typeof payload.text !== 'string' || !payload.text.trim() || Array.from(payload.text).length > 300 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.text) ||
        Array.from(payload.text).some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; }) ||
        !voices.has(payload.voice_id)) throw new Error('input');
    } catch { return reply({ detail: 'Invalid narration request.' }, 400); }
    // Fixed preset model/parameters. No HTTP, cloning, paid or alternative fallback.
    const output = await wait(env.ZIIPA_MUSIC_AI.run(NARRATION_MODEL, {
      text: payload.text, speaker: payload.voice_id, encoding: 'linear16', container: 'wav', sample_rate: 24000,
    }, { returnRawResponse: true }).then(value => {
      if (stopped) {
        const stream = value instanceof Response ? value.body : value instanceof ReadableStream ? value : null;
        void stream?.cancel().catch(() => {});
      }
      return value;
    }));
    const response = output instanceof Response ? output : null;
    if (response && (!response.ok || response.redirected || !response.body)) { void response.body?.cancel().catch(() => {}); throw new Error('response'); }
    const length = response?.headers.get('content-length');
    if (length != null && (!/^\d+$/.test(length) || Number(length) < 44 || Number(length) > MAX_WAV_BYTES)) { void response?.body?.cancel().catch(() => {}); throw new Error('length'); }
    const stream = response?.body || (output instanceof ReadableStream ? output : null);
    if (!stream) throw new Error('response');
    const bytes = await read(stream, MAX_WAV_BYTES);
    if (length != null && Number(length) !== bytes.length) throw new Error('length');
    const audio = canonicalWav(bytes);
    return new Response(audio, { headers: { ...safeHeaders, 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length) } });
  } catch { return unavailable(); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); }
}
