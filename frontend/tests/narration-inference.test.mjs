import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/narration-inference.ts', import.meta.url), 'utf8');
function bridge(timers = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, Request, Response, ReadableStream, TextEncoder, TextDecoder, Uint8Array, DataView, crypto: webcrypto, setTimeout, clearTimeout,
      fetch() { throw new Error('HTTP fallback forbidden'); }, ...timers });
  return exports;
}
const { narrationInference, NARRATION_MODEL } = bridge();
const secret = 'synthetic-private-proxy-key-not-a-real-credential';
const now = 1792520000000;
const payload = { version: 1, text: 'This is an original narration.', voice_id: 'athena' };
const body = JSON.stringify(payload);
function signed(content = body, options = {}) {
  const path = options.path || '/internal/narration-inference';
  const timestamp = options.timestamp || String(now / 1000);
  const signature = createHmac('sha256', secret).update(`${options.domain || 'ziipa-narration-v1'}\n${timestamp}\n${createHash('sha256').update(content).digest('hex')}`).digest('hex');
  return new Request('https://ziipa.com' + path, { method: options.method || (path.endsWith('/status') ? 'GET' : 'POST'),
    headers: { 'x-ziipa-narration-timestamp': timestamp, 'x-ziipa-narration-signature': signature },
    ...(path.endsWith('/status') ? {} : { body: content }), ...(options.signal ? { signal: options.signal } : {}) });
}
function wave(samples = 120) {
  const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer), text = new TextEncoder();
  bytes.set(text.encode('RIFF')); view.setUint32(4, bytes.length - 8, true); bytes.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36); view.setUint32(40, samples * 2, true);
  for (let i = 44; i < bytes.length; i += 2) view.setInt16(i, 3000, true);
  return bytes;
}
const env = (run = async () => new Response(wave(), { headers: { 'Content-Type': 'audio/wav' } })) => ({
  ZIIPA_PROXY_SECRET: secret, ZIIPA_NARRATION_AI_FREE_ENABLED: 'true', ZIIPA_NARRATION_AI_VERIFIED: 'true', ZIIPA_MUSIC_AI: { run },
});

test('unsigned, cross-purpose, stale, future and tampered narration requests cannot consume AI quota', async () => {
  let calls = 0; const environment = env(async () => { calls++; return new Response(wave()); });
  const valid = signed();
  for (const request of [
    new Request(valid.url, { method: 'POST', body }),
    signed(body, { domain: 'ziipa-music-v1' }), signed(body, { domain: 'ziipa-caption-v1' }),
    signed(body, { timestamp: String(now / 1000 - 31) }), signed(body, { timestamp: String(now / 1000 + 31) }),
    new Request(valid.url, { method: 'POST', headers: valid.headers, body: body + ' ' }),
  ]) assert.equal((await narrationInference(request, environment, now)).status, 401);
  assert.equal(calls, 0);
});

test('narration needs its own two explicit flags and binding; status is free and never calls a model', async () => {
  let calls = 0; const environment = env(async () => { calls++; });
  for (const missing of [
    { ZIIPA_NARRATION_AI_FREE_ENABLED: undefined }, { ZIIPA_NARRATION_AI_VERIFIED: undefined },
    { ZIIPA_NARRATION_AI_FREE_ENABLED: 'TRUE' }, { ZIIPA_MUSIC_AI: undefined }, { ZIIPA_PROXY_SECRET: 'short' },
  ]) assert.equal((await narrationInference(signed(), { ...environment, ...missing, ZIIPA_MUSIC_AI_FREE_ENABLED: 'true' }, now)).status, 503);
  const result = await narrationInference(signed('', { path: '/internal/narration-inference/status' }), environment, now);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { available: true, model: '@cf/deepgram/aura-1', version: 1 });
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(calls, 0);
});

test('only fixed endpoints/methods and strict bounded preset input reach the model', async () => {
  let calls = 0; const environment = env(async () => { calls++; return new Response(wave()); });
  for (const options of [{ path: '/internal/narration-inference?x=1' }, { path: '/internal/narration-inference/extra' }, { method: 'PUT' }])
    assert.equal((await narrationInference(signed(body, options), environment, now)).status, 404);
  for (const changed of [null, [], { ...payload, version: 2 }, { ...payload, text: '' }, { ...payload, text: '   ' },
    { ...payload, text: 'a'.repeat(301) }, { ...payload, text: 'bad\u0000control' }, { ...payload, text: '\ud800' },
    { ...payload, voice_id: 'paid-or-user-voice' }, { ...payload, model: '@cf/other' }, { ...payload, reference_audio: 'https://other.test/private' },
    { ...payload, sample_rate: 48000 }, { ...payload, tools: [] },
  ]) assert.equal((await narrationInference(signed(JSON.stringify(changed)), environment, now)).status, 400);
  assert.equal((await narrationInference(signed('x'.repeat(4097)), environment, now)).status, 413);
  assert.equal(calls, 0);
});

test('all supported preset voices use the exact raw-response model parameters and return sanitized PCM WAV', async () => {
  const calls = [];
  for (const voice_id of ['athena', 'helios', 'asteria', 'orion']) {
    const result = await narrationInference(signed(JSON.stringify({ ...payload, voice_id })), env(async (...args) => {
      calls.push(JSON.parse(JSON.stringify(args))); return new Response(wave(), { headers: { 'Content-Type': 'audio/wav', 'X-Provider-Diagnostic': 'private' } });
    }), now);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'audio/wav');
    assert.equal(result.headers.get('x-provider-diagnostic'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), wave());
    assert.deepEqual(calls.at(-1), [NARRATION_MODEL, { text: payload.text, speaker: voice_id, encoding: 'linear16', container: 'wav', sample_rate: 24000 }, { returnRawResponse: true }]);
  }
  assert.equal(calls.length, 4);
});

test('stream responses remain bounded and optional WAV metadata is removed before relay', async () => {
  const original = wave(), withJunk = new Uint8Array(original.length + 12), view = new DataView(withJunk.buffer);
  withJunk.set(original.subarray(0, 36)); withJunk.set(new TextEncoder().encode('JUNK'), 36); view.setUint32(40, 4, true);
  withJunk.set([11, 22, 33, 44], 44); withJunk.set(original.subarray(36), 48); view.setUint32(4, withJunk.length - 8, true);
  const output = new ReadableStream({ start(controller) { controller.enqueue(withJunk.subarray(0, 22)); controller.enqueue(withJunk.subarray(22)); controller.close(); } });
  const result = await narrationInference(signed(), env(async () => output), now);
  assert.equal(result.status, 200); assert.deepEqual(new Uint8Array(await result.arrayBuffer()), original);
});

test('duration and header limits accept their boundary without relaying ancillary data', async () => {
  const maximum = wave(24000 * 30);
  assert.equal((await narrationInference(signed(), env(async () => new Response(maximum)), now)).status, 200);
  for (const extra of [0, 2]) {
    const original = wave(), junkSize = 65536 - 44 - 8 + extra;
    const bytes = new Uint8Array(original.length + 8 + junkSize), view = new DataView(bytes.buffer);
    bytes.set(original.subarray(0, 36)); bytes.set(new TextEncoder().encode('JUNK'), 36); view.setUint32(40, junkSize, true);
    bytes.set(original.subarray(36), 44 + junkSize); view.setUint32(4, bytes.length - 8, true);
    const result = await narrationInference(signed(), env(async () => new Response(bytes)), now);
    assert.equal(result.status, extra ? 503 : 200);
    if (!extra) assert.deepEqual(new Uint8Array(await result.arrayBuffer()), original);
  }
});

test('oversized streams and declared oversize cancel rather than buffer or expose provider diagnostics', async () => {
  for (const declared of [false, true]) {
    let canceled = 0;
    const output = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(1505581)); }, cancel() { canceled++; } });
    const result = await narrationInference(signed(), env(async () => new Response(output, { headers: declared ? { 'Content-Length': '1505581' } : {} })), now);
    assert.equal(result.status, 503); assert.equal(canceled, 1);
    assert.doesNotMatch(await result.text(), /provider|secret|diagnostic/i);
  }
});

test('malformed audio, excessive duration, bad PCM format, duplicate chunks and provider failures have no fallback', async () => {
  const badPcm = wave(); new DataView(badPcm.buffer).setUint16(22, 2, true);
  const wrongRate = wave(); new DataView(wrongRate.buffer).setUint32(24, 22050, true);
  const badRiff = wave(); new DataView(badRiff.buffer).setUint32(4, 0xffffffff, true);
  const duplicate = new Uint8Array(wave().length + 24); duplicate.set(wave()); duplicate.set(wave().subarray(12, 36), wave().length); new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true);
  const runs = [
    async () => { throw new Error('private-provider-key'); }, async () => ({ audio: 'base64-not-protocol' }),
    async () => new Response('private-provider-key', { status: 502 }), async () => new Response('not-a-wave'),
    ...[badPcm, wrongRate, badRiff, duplicate, wave(24000 * 30 + 1), wave(0), wave().subarray(0, 43)].map(value => async () => new Response(value)),
    async () => new Response(wave(), { headers: { 'Content-Length': '44' } }),
  ];
  for (const run of runs) {
    let calls = 0; const result = await narrationInference(signed(), env(async (...args) => { calls++; return run(...args); }), now);
    assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private-provider-key/); assert.equal(calls, 1);
  }
});

test('deadline cancels a stalled reader and a late binding response without an HTTP fallback', async () => {
  let expire; const timers = { setTimeout(fn, ms) { assert.equal(ms, 30000); expire = fn; return 1; }, clearTimeout() {} };
  const { narrationInference: bounded } = bridge(timers);
  let cancel = 0, signalReady;
  const started = new Promise(resolve => { signalReady = resolve; });
  const stream = new ReadableStream({ start() {}, cancel() { cancel++; } });
  const pending = bounded(signed(), env(async () => { signalReady(); return new Response(stream); }), now);
  await started; await new Promise(resolve => setTimeout(resolve, 0)); expire();
  assert.equal((await pending).status, 503); assert.equal(cancel, 1);
  let finish, bindingStarted;
  const running = new Promise(resolve => { bindingStarted = resolve; });
  const late = bounded(signed(), env(() => { bindingStarted(); return new Promise(resolve => { finish = resolve; }); }), now);
  await running; expire(); assert.equal((await late).status, 503);
  finish(new Response(new ReadableStream({ cancel() { cancel++; } })));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cancel, 2);
});

test('request abort cancels stalled audio and an already-aborted request never invokes a model', async () => {
  const abort = new AbortController(); let ready, canceled = 0;
  const running = new Promise(resolve => { ready = resolve; });
  const pending = narrationInference(signed(body, { signal: abort.signal }), env(async () => {
    ready(); return new Response(new ReadableStream({ cancel() { canceled++; } }));
  }), now);
  await running; await new Promise(resolve => setTimeout(resolve, 0)); abort.abort();
  assert.equal((await pending).status, 503); assert.equal(canceled, 1);
  let calls = 0;
  assert.equal((await narrationInference(signed(body, { signal: abort.signal }), env(async () => { calls++; }), now)).status, 503);
  assert.equal(calls, 0);
});
