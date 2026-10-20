import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/caption-inference.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, URL, Request, Response, TextEncoder, Uint8Array, DataView, crypto: webcrypto,
  btoa: value => Buffer.from(value, 'binary').toString('base64') });
const { captionInference, CAPTION_MODEL, CAPTION_MAX_WAV_BYTES } = exports;
const secret = 'synthetic-caption-api-proxy-secret-only-40';
const now = 1792520000000;
const cues = [{ start: 0.25, end: 1.125, text: 'Actual spoken words.' }, { start: 1.5, end: 2, text: 'Second cue.' }];

function wav(seconds = 2) {
  const data = Math.round(seconds * 16000) * 2;
  const output = Buffer.alloc(44 + data);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16000, 24); output.writeUInt32LE(32000, 28); output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(data, 40);
  return output;
}

function signed(body = wav(), { path = '/internal/caption-inference', timestamp = String(now / 1000), headers = {}, domain = 'ziipa-caption-v1' } = {}) {
  const signature = createHmac('sha256', secret).update(`${domain}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  const status = path.endsWith('/status');
  return new Request('https://ziipa.com' + path, { method: status ? 'GET' : 'POST', headers: {
    'x-ziipa-caption-timestamp': timestamp, 'x-ziipa-caption-signature': signature,
    ...(!status ? { 'Content-Type': 'audio/wav' } : {}), ...headers,
  }, ...(!status ? { body } : {}) });
}
const environment = (run = async () => ({ text: 'not used as timing fallback', segments: cues })) => ({
  ZIIPA_PROXY_SECRET: secret, ZIIPA_CAPTION_AI_FREE_ENABLED: 'true', ZIIPA_MUSIC_AI: { run },
});

test('unsigned browser, cross-purpose, stale and tampered requests cannot consume inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; return { segments: cues }; });
  const requests = [
    new Request('https://ziipa.com/internal/caption-inference', { method: 'POST', body: wav() }),
    signed(wav(), { timestamp: String(now / 1000 - 31) }),
    signed(wav(), { timestamp: String(now / 1000 + 31) }),
    signed(wav(), { domain: 'ziipa-music-v1' }),
    signed(wav(), { headers: { Origin: 'https://ziipa.com' } }),
  ];
  const original = signed();
  const altered = wav(); altered[44] = 9;
  requests.push(new Request(original.url, { method: 'POST', headers: original.headers, body: altered }));
  for (const request of requests) assert.equal((await captionInference(request, env, now)).status, 401);
  assert.equal(calls, 0);
});

test('caption activation is separately default-off and status consumes no model quota', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  for (const missing of [{ ZIIPA_CAPTION_AI_FREE_ENABLED: undefined }, { ZIIPA_MUSIC_AI: undefined }, { ZIIPA_PROXY_SECRET: '' }]) {
    assert.equal((await captionInference(signed(), { ...env, ...missing, ZIIPA_MUSIC_AI_FREE_ENABLED: 'true' }, now)).status, 503);
  }
  const response = await captionInference(signed(Buffer.alloc(0), { path: '/internal/caption-inference/status' }), env, now);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true, model: CAPTION_MODEL });
  assert.equal(calls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('canonical signed WAV becomes fixed-model transcription and retains real segment timings', async () => {
  const calls = [];
  const body = wav();
  const response = await captionInference(signed(body), environment(async (model, input) => {
    calls.push({ model, input });
    return { text: 'discarded aggregate text', segments: cues.map(cue => ({ ...cue, words: [], private_metadata: 'not-returned' })) };
  }), now);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { segments: cues }, model: CAPTION_MODEL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, '@cf/openai/whisper-large-v3-turbo');
  assert.deepEqual(Object.keys(calls[0].input).sort(), ['audio', 'condition_on_previous_text', 'task', 'vad_filter']);
  assert.equal(calls[0].input.task, 'transcribe');
  assert.equal(calls[0].input.vad_filter, true);
  assert.equal(calls[0].input.condition_on_previous_text, false);
  assert.equal(Buffer.from(calls[0].input.audio, 'base64').compare(body), 0);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('only90seconds of bounded raw canonical WAV are accepted; streamed and declared overflows do not infer', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; return { segments: [] }; });
  assert.equal(CAPTION_MAX_WAV_BYTES, 2880044);
  assert.equal((await captionInference(signed(wav(90)), env, now)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await captionInference(signed(wav(90 + 1 / 16000)), env, now)).status, 413);
  assert.equal((await captionInference(signed(wav(), { headers: { 'Content-Length': String(CAPTION_MAX_WAV_BYTES + 1) } }), env, now)).status, 413);
  assert.equal((await captionInference(signed(wav(), { headers: { 'Content-Length': '1' } }), env, now)).status, 413);
  assert.equal(calls, 1);
});

test('non-WAV, codec/header changes, empty audio, trailing controls and alternate encodings are rejected', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  const bodies = [Buffer.alloc(0), Buffer.from('{"audio":"https://evil.test","model":"other"}'), wav(0)];
  for (const [offset, value, bytes] of [[20, 3, 2], [22, 2, 2], [24, 44100, 4], [28, 1, 4], [32, 4, 2], [34, 8, 2], [16, 18, 4], [40, 1, 4], [4, 1, 4]]) {
    const body = wav(); body[bytes === 4 ? 'writeUInt32LE' : 'writeUInt16LE'](value, offset); bodies.push(body);
  }
  const extra = Buffer.concat([wav(), Buffer.from('LISTprompt=ignore-rules')]);
  extra.writeUInt32LE(extra.length - 8, 4); bodies.push(extra);
  for (const body of bodies) assert.equal((await captionInference(signed(body), env, now)).status, 400);
  for (const headers of [{ 'Content-Type': 'application/json' }, { 'Content-Type': 'application/octet-stream' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await captionInference(signed(wav(), { headers }), env, now)).status, 400);
  }
  assert.equal(calls, 0);
});

test('query controls, arbitrary paths and wrong methods never reach the model', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  for (const path of ['/internal/caption-inference?model=other', '/internal/caption-inference?url=https://evil.test', '/internal/caption-inference/unknown']) {
    assert.equal((await captionInference(signed(wav(), { path }), env, now)).status, 404);
  }
  assert.equal((await captionInference(new Request('https://ziipa.com/internal/caption-inference'), env, now)).status, 404);
  assert.equal(calls, 0);
});

test('model output must have bounded finite nonoverlapping genuine timings; no text fallback', async () => {
  const bad = [
    null, { text: 'no timestamps' }, { segments: 'not-an-array' },
    { segments: [{ start: -1, end: 1, text: 'no' }] },
    { segments: [{ start: 0, end: 2.0001, text: 'outside' }] },
    { segments: [{ start: 1, end: 1, text: 'empty' }] },
    { segments: [{ start: 0, end: NaN, text: 'invalid' }] },
    { segments: [{ start: false, end: 1, text: 'not a number' }] },
    { segments: [{ start: 0, end: Infinity, text: 'invalid' }] },
    { segments: [{ start: 0, end: 1, text: 'x'.repeat(251) }] },
    { segments: [{ start: 0, end: 1, text: '   ' }] },
    { segments: [{ start: 0, end: 1, text: 'bad\u0000control' }] },
    { segments: [{ start: 0, end: 1.5, text: 'first' }, { start: 1.25, end: 2, text: 'overlap' }] },
    { segments: Array.from({ length: 101 }, (_, n) => ({ start: n / 100, end: (n + 1) / 100, text: 'too many' })) },
  ];
  for (const output of bad) {
    const response = await captionInference(signed(), environment(async () => output), now);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /no timestamps|overlap|too many/);
  }
  const silent = await captionInference(signed(), environment(async () => ({ segments: [] })), now);
  assert.deepEqual((await silent.json()).result, { segments: [] });
});

test('provider/quota failures return generic unavailable and do not retry or choose another model', async () => {
  let calls = 0;
  const response = await captionInference(signed(), environment(async () => { calls++; throw new Error('private-audio-token-and-content'); }), now);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-audio|token-and-content/);
  assert.equal(calls, 1);
});
