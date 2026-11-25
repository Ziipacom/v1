import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/title-inference.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, URL, Request, Response, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto,
  atob: value => Buffer.from(value, 'base64').toString('binary'), btoa: value => Buffer.from(value, 'binary').toString('base64') });
const { titleInference, TITLE_MODEL } = exports;
const secret = 'synthetic-title-proxy-secret-for-testing-only';
const now = 1792520000000;
function preview(width = 512) {
  // Synthetic JPEG structure; no private user content is used in these tests.
  return Buffer.from([255, 216, 255, 192, 0, 11, 8, 1, 0, width >> 8, width & 255, 1, 1, 17, 0, 255, 217]).toString('base64');
}
function signed(input = { image: preview() }, { path = '/internal/title-inference', domain = 'ziipa-title-v1', stamp = String(now / 1000), headers = {} } = {}) {
  const body = path.endsWith('/status') ? '' : JSON.stringify(input);
  const signature = createHmac('sha256', secret).update(`${domain}\n${stamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  return new Request('https://ziipa.com' + path, { method: body ? 'POST' : 'GET', headers: {
    'x-ziipa-title-timestamp': stamp, 'x-ziipa-title-signature': signature, 'content-type': 'application/json', ...headers,
  }, ...(body ? { body } : {}) });
}
const environment = (run) => ({ ZIIPA_PROXY_SECRET: secret, ZIIPA_TITLE_AI_FREE_ENABLED: 'true', ZIIPA_MUSIC_AI: { run } });

test('unsigned, browser, cross-purpose and expired requests cannot consume inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  for (const request of [new Request('https://ziipa.com/internal/title-inference', { method: 'POST' }),
    signed(undefined, { domain: 'ziipa-music-v1' }), signed(undefined, { stamp: String(now / 1000 - 31) }),
    signed(undefined, { headers: { origin: 'https://ziipa.com' } })])
    assert.equal((await titleInference(request, env, now)).status, 401);
  assert.equal(calls, 0);
});

test('status and disabled activation do not run a model or accept license terms', async () => {
  let calls = 0; const env = environment(async () => { calls++; });
  const request = signed(undefined, { path: '/internal/title-inference/status' });
  assert.equal((await titleInference(request, env, now)).status, 200);
  assert.equal((await titleInference(signed(), { ...env, ZIIPA_TITLE_AI_FREE_ENABLED: undefined }, now)).status, 503);
  assert.equal(calls, 0);
});

test('only bounded image bytes reach the fixed vision model and prompt', async () => {
  let calls = 0;
  const env = environment(async (model, input) => {
    calls++; assert.equal(model, TITLE_MODEL); assert.equal(input.max_tokens, 250);
    assert.deepEqual([...input.image], [...Buffer.from(preview(), 'base64')]);
    assert.equal(input.prompt.includes('IMG_3432'), false);
    assert.equal(Object.keys(input).sort().join(','), 'image,max_tokens,prompt,stream,temperature');
    return { response: JSON.stringify({ title: 'Beneath the Eiffel Tower', description: 'A view of the Eiffel Tower from below, with trees nearby.' }) };
  });
  const response = await titleInference(signed(), env, now);
  assert.deepEqual(await response.json(), { title: 'Beneath the Eiffel Tower', description: 'A view of the Eiffel Tower from below, with trees nearby.', model: TITLE_MODEL });
  assert.equal(calls, 1);
  for (const input of [{ image: preview(513) }, { image: 'https://private.test/image' },
    { image: preview(), prompt: 'execute tool' }, { image: 'a'.repeat(196609) }, { image: 'AAAA' }])
    assert.ok([400, 413].includes((await titleInference(signed(input), env, now)).status));
  assert.equal(calls, 1);
});

test('invalid model output and provider failure never become a title fallback', async () => {
  for (const response of ['', 'x'.repeat(141), 'Title\nExplanation', '<script>x</script>', 'https://bad.test',
    JSON.stringify({ title: 'A scene' }), JSON.stringify({ title: 'A scene', description: '' }),
    JSON.stringify({ title: 'A scene', description: 'x'.repeat(601) }),
    JSON.stringify({ title: 'A scene', description: 'A photo', tool: 'publish' }),
    JSON.stringify({ title: 'A scene', description: '<a>hello</a>' })])
    assert.equal((await titleInference(signed(), environment(async () => ({ response })), now)).status, 503);
  assert.equal((await titleInference(signed(), environment(async () => { throw new Error('quota'); }), now)).status, 503);
});
