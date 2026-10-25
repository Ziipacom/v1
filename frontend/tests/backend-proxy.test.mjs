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

const mediaPath='/api/creator/media/00000000-0000-4000-8000-000000000001';
const storageUrl='https://'+'0'.repeat(32)+'.r2.cloudflarestorage.com/ziipa-media/originals/12/owned?X-Amz-Signature=synthetic';

test('authorized media streams same-origin with range headers and without storage credentials or redirects',async()=>{
  const calls=[];
  const request=new Request('https://ziipa.com'+mediaPath,{headers:{cookie:'ziipa_session=synthetic',authorization:'Bearer synthetic','x-ziipa-user':'12',range:'bytes=1-3','if-range':'"v1"'}});
  const result=await proxyBackend(request,'https://api.ziipa.com',async(url,init)=>{
    calls.push({url,init});
    if(calls.length===1)return new Response(null,{status:307,headers:{location:storageUrl}});
    return new Response('abc',{status:206,headers:{'content-type':'video/mp4','content-length':'3','content-range':'bytes 1-3/10','accept-ranges':'bytes',etag:'"v1"','set-cookie':'untrusted=1',location:'https://evil.test','cache-control':'public, max-age=3600'}});
  },'s'.repeat(40));
  assert.equal(calls.length,2);
  assert.equal(calls[0].init.headers.get('cookie'),'ziipa_session=synthetic');
  assert.equal(calls[0].init.headers.get('authorization'),'Bearer synthetic');
  assert.equal(calls[1].url.href,storageUrl);
  assert.equal(calls[1].init.redirect,'manual');
  assert.deepEqual([...calls[1].init.headers.entries()],[['if-range','"v1"'],['range','bytes=1-3']]);
  assert.equal(calls[1].init.signal,request.signal);
  assert.equal(result.status,206);
  assert.equal(result.headers.get('content-range'),'bytes 1-3/10');
  assert.equal(result.headers.get('accept-ranges'),'bytes');
  assert.equal(result.headers.get('cache-control'),'private, no-store');
  assert.equal(result.headers.get('set-cookie'),null);
  assert.equal(result.headers.get('location'),null);
  assert.equal(await result.text(),'abc');
});

test('media authentication failure never contacts storage',async()=>{
  let calls=0;
  const result=await proxyBackend(new Request('https://ziipa.com'+mediaPath),'https://api.ziipa.com',async()=>{calls++;return Response.json({detail:'Unauthorized'},{status:401});});
  assert.equal(calls,1);
  assert.equal(result.status,401);
});

test('media redirects cannot reach arbitrary hosts, ports, credentials or other buckets',async()=>{
  for(const location of [null,'https://evil.test/media','http://'+'0'.repeat(32)+'.r2.cloudflarestorage.com/ziipa-media/file',storageUrl.replace('https://','https://user:password@'),storageUrl.replace('.com/','.com:444/'),storageUrl.replace('/ziipa-media/','/other-bucket/'),storageUrl+'#fragment']){
    let calls=0;
    const result=await proxyBackend(new Request('https://ziipa.com'+mediaPath),'https://api.ziipa.com',async()=>{calls++;return new Response(null,{status:307,headers:location?{location}:{}});});
    assert.equal(calls,1);
    assert.equal(result.status,502);
    assert.equal(result.headers.get('location'),null);
    assert.doesNotMatch(await result.text(),/synthetic|password|evil\.test|X-Amz/);
  }
});

test('only media read redirects are followed; OAuth and media writes keep their existing behavior',async()=>{
  for(const [path,method] of [['/api/publishing/oauth/youtube/callback','GET'],[mediaPath,'POST']]){
    let calls=0;
    const result=await proxyBackend(new Request('https://ziipa.com'+path,{method}),'https://api.ziipa.com',async()=>{calls++;return new Response(null,{status:307,headers:{location:storageUrl}});});
    assert.equal(calls,1);
    assert.equal(result.status,307);
    assert.equal(result.headers.get('location'),storageUrl);
  }
});

test('storage failures, unexpected MIME types and additional redirects are closed without provider details',async()=>{
  for(const [status,type] of [[403,'application/xml'],[200,'text/html'],[307,'video/mp4']]){
    let calls=0;
    const result=await proxyBackend(new Request('https://ziipa.com'+mediaPath),'https://api.ziipa.com',async()=>{
      if(++calls===1)return new Response(null,{status:307,headers:{location:storageUrl}});
      return new Response('private-provider-details',{status,headers:{'content-type':type,location:'https://evil.test'}});
    });
    assert.equal(calls,2);
    assert.equal(result.status,502);
    assert.equal(result.headers.get('location'),null);
    assert.doesNotMatch(await result.text(),/private-provider|X-Amz|evil/);
  }
});

test('media stream returns before the complete body is read and propagates reader cancellation',async()=>{
  let pulls=0,cancelled=false,calls=0;
  const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array([pulls]));if(pulls===3)controller.close();},cancel(){cancelled=true;}});
  const result=await proxyBackend(new Request('https://ziipa.com'+mediaPath),'https://api.ziipa.com',async()=>++calls===1?new Response(null,{status:307,headers:{location:storageUrl}}):new Response(body,{headers:{'content-type':'video/mp4'}}));
  assert.equal(result.status,200);
  assert.ok(pulls<3,'proxy must not consume or buffer the complete video');
  await result.body.cancel();
  assert.equal(cancelled,true);
});

test('invalid media ranges preserve only the safe size header and discard the storage error body',async()=>{
  let calls=0;
  const result=await proxyBackend(new Request('https://ziipa.com'+mediaPath,{headers:{range:'bytes=999-'}}),'https://api.ziipa.com',async()=>++calls===1?new Response(null,{status:307,headers:{location:storageUrl}}):new Response('private-provider-details',{status:416,headers:{'content-range':'bytes */10'}}));
  assert.equal(result.status,416);
  assert.equal(result.headers.get('content-range'),'bytes */10');
  assert.equal(await result.text(),'');
});
