import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
const source = readFileSync(new URL('../lib/backend-proxy.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, URL, Headers, Response, fetch: () => { throw new Error('No network requests in unit tests'); } });
const { proxyBackend } = exports;

test('portal proxy preserves host-only cookies and OAuth redirects without forwarding credentials to the redirect', async () => {
  const calls=[];
  const result=await proxyBackend(new Request('https://ziipa.com/api/publishing/oauth/youtube/authorize?ticket=opaque', {headers:{cookie:'ziipa_session=secret', 'x-ziipa-user':'12', 'x-forwarded-host':'evil.test'}}), 'https://api.ziipa.com', async (url, init) => {
    calls.push({url,init}); return new Response(null,{status:302,headers:{location:'https://accounts.google.com/authorization', 'set-cookie':'ziipa_oauth_youtube=bind; HttpOnly; Secure; SameSite=Lax; Path=/api/publishing/oauth/youtube'}});
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].url.origin,'https://api.ziipa.com');
  assert.equal(calls[0].init.redirect,'manual');
  assert.equal(calls[0].init.headers.get('cookie'),'ziipa_session=secret');
  assert.equal(calls[0].init.headers.get('x-ziipa-user'),'12');
  assert.equal(calls[0].init.headers.get('x-forwarded-host'),null);
  assert.equal(result.status,302);
  assert.match(result.headers.get('set-cookie'),/HttpOnly/);
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.headers.get('referrer-policy'),'no-referrer');
});
test('backend cannot become an open redirect, insecure credential proxy or recursive website request', async()=>{
  for(const origin of ['http://api.ziipa.com','https://user:pass@api.ziipa.com','https://api.ziipa.com/path','https://ziipa.com','https://api.ziipa.com?target=evil']) {
    const result=await proxyBackend(new Request('https://ziipa.com/api/me'),origin,()=>{throw new Error('must not fetch');});
    assert.equal(result.status,503);
  }
  assert.equal((await proxyBackend(new Request('https://ziipa.com/other'),'https://api.ziipa.com')).status,404);
});
test('API failure is generic and cannot leak a provider URL or cookie',async()=>{
  const result=await proxyBackend(new Request('https://ziipa.com/api/me'),'https://api.ziipa.com',()=>{throw new Error('secret=123');});
  assert.equal(result.status,502); assert.doesNotMatch(await result.text(),/secret/);
});
test('edge visitor addresses require the server secret and never copy browser proxy headers', async()=>{
  const calls=[];
  await proxyBackend(new Request('https://ziipa.com/api/me',{headers:{'cf-connecting-ip':'192.0.2.10','x-ziipa-proxy-secret':'attacker','x-ziipa-client-ip':'192.0.2.99'}}),'https://api.ziipa.com',async(_,init)=>{calls.push(init);return new Response('{}');},'s'.repeat(40));
  assert.equal(calls[0].headers.get('x-ziipa-client-ip'),'192.0.2.10');
  assert.equal(calls[0].headers.get('x-ziipa-proxy-secret'),'s'.repeat(40));
});
