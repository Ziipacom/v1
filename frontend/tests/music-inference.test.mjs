import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/music-inference.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, URL, Request, Response, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto });
const { musicInference, MUSIC_MODEL } = exports;
const secret = 'synthetic-private-api-proxy-secret-only-40';
const now = 1792520000000;
const score = { title: 'Original', tracks: [{ instrument: 'piano', notes: [[0, 1, 60, 0.6]] }] };
const body = JSON.stringify({ request_id: '00000000-0000-4000-8000-000000000001', messages: [{ role: 'system', content: 'Compose music.' }, { role: 'user', content: 'Calm.' }], format: { type: 'object', properties: { title: { type: 'string' }, tracks: { type: 'array' } } } });
function signed(content = body, path = '/internal/music-inference', timestamp = String(now / 1000)) {
  const signature = createHmac('sha256', secret).update(`ziipa-music-v1\n${timestamp}\n${createHash('sha256').update(content).digest('hex')}`).digest('hex');
  return new Request('https://ziipa.com' + path, { method: path.endsWith('/status') ? 'GET' : 'POST', headers: { 'x-ziipa-music-timestamp': timestamp, 'x-ziipa-music-signature': signature }, ...(path.endsWith('/status') ? {} : { body: content }) });
}
const environment = (run = async () => ({ response: score })) => ({ ZIIPA_PROXY_SECRET: secret, ZIIPA_MUSIC_AI_FREE_ENABLED: 'true', ZIIPA_MUSIC_AI: { run } });

test('unsigned browser calls, stale signatures and tampered bodies cannot spend AI allowance', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; return { response: score }; });
  assert.equal((await musicInference(new Request('https://ziipa.com/internal/music-inference', { method: 'POST', body }), env, now)).status, 401);
  assert.equal((await musicInference(signed(body, undefined, String(now / 1000 - 31)), env, now)).status, 401);
  const request = signed();
  const altered = new Request(request.url, { method: 'POST', headers: request.headers, body: body + ' ' });
  assert.equal((await musicInference(altered, env, now)).status, 401);
  assert.equal(calls, 0);
});
test('activation is off by default and status consumes no inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  assert.equal((await musicInference(signed(), { ...env, ZIIPA_MUSIC_AI_FREE_ENABLED: undefined }, now)).status, 503);
  assert.equal((await musicInference(signed(), { ...env, ZIIPA_MUSIC_AI: undefined }, now)).status, 503);
  const result = await musicInference(signed('', '/internal/music-inference/status'), env, now);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { available: true, model: MUSIC_MODEL });
  assert.equal(calls, 0);
});
test('valid composition is fixed-model, JSON-only, bounded, nonstreaming and never a tool call', async () => {
  const calls = [];
  const result = await musicInference(signed(), environment(async (model, input) => { calls.push({ model, input }); return { response: JSON.stringify(score) }; }), now);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { result: score, model: MUSIC_MODEL });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(calls[0].input.max_tokens, 650);
  assert.equal(calls[0].input.stream, false);
  assert.equal(calls[0].input.tools, undefined);
  assert.equal(calls[0].input.gateway, undefined);
  assert.equal(calls[0].input.response_format.type, 'json_schema');
});
test('oversized bodies, extra controls and remote schema references fail before inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  assert.equal((await musicInference(signed('x'.repeat(8193)), env, now)).status, 413);
  for (const changed of [
    { ...JSON.parse(body), model: 'paid-model' },
    { ...JSON.parse(body), format: { type: 'object', $ref: 'https://evil.test' } },
    { ...JSON.parse(body), messages: [{ role: 'system', content: 'x'.repeat(4501) }, { role: 'user', content: 'music' }] },
  ]) assert.equal((await musicInference(signed(JSON.stringify(changed)), env, now)).status, 400);
  assert.equal(calls, 0);
});
test('bounded examples allow the exact four-message score protocol without arbitrary histories', async () => {
  const messages = [{ role: 'system', content: 'Compose music.' }, { role: 'user', content: 'Example.' }, { role: 'assistant', content: '{}' }, { role: 'user', content: 'Calm.' }];
  const payload = { ...JSON.parse(body), messages };
  assert.equal((await musicInference(signed(JSON.stringify(payload)), environment(), now)).status, 200);
  payload.messages[2].role = 'tool';
  assert.equal((await musicInference(signed(JSON.stringify(payload)), environment(), now)).status, 400);
});
test('provider errors/invalid results expose no private provider diagnostics and have no fallback', async () => {
  for (const run of [async () => { throw new Error('private-api-key'); }, async () => ({ response: 'not-json' })]) {
    const result = await musicInference(signed(), environment(run), now);
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /private-api-key/);
  }
});
