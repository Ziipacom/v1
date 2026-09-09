import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadApi(portalMode, response={id:7,name:'Studio member',email:'test@example.test'}, status=200) {
  const calls=[]; const messages=[];
  const exports={};
  const source=readFileSync(new URL('../../mobile/src/lib/api.web.ts', import.meta.url), 'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context={exports,require:(name)=>{assert.equal(name,'./config');return {portalMode,validateOrigin:()=> 'https://ziipa.com',authorizationHeaders:(token)=>token&&!portalMode?{Authorization:`Bearer ${token}`}:{}};},
    AbortController,setTimeout,clearTimeout,Date,window:{location:{origin:'https://ziipa.com'},parent:{postMessage:(...args)=>messages.push(args)}},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:status>=200&&status<300,status,json:async()=>response};}};
  vm.runInNewContext(compiled,context);
  return {api:exports,calls,messages};
}
test('portal restores the existing cookie session without issuing or exposing a bearer token', async()=>{
  const {api,calls}=loadApi(true);
  const session=await api.readSession();
  assert.equal(session.user.id,7);
  assert.match(session.access_token,/^ziipa-portal-cookie:7:/);
  assert.equal(calls[0].options.credentials,'include');
  assert.equal(calls[0].options.headers.Authorization,undefined);
  await api.request('/api/creator/bootstrap',session.access_token);
  assert.equal(calls[1].options.headers.Authorization,undefined);
});
test('portal logout revokes the website cookie rather than a separate mobile session', async()=>{
  const {api,calls,messages}=loadApi(true);
  await api.request('/api/mobile/auth/logout','ziipa-portal-cookie',{});
  assert.equal(calls[0].url,'https://ziipa.com/api/auth/logout');
  assert.equal(calls[0].options.credentials,'include');
  await api.clearSession();
  assert.equal(messages[0][1],'https://ziipa.com');
  assert.equal(messages[0][0].type,'signed-out');
});
test('standalone browser preview keeps bearer sessions separate from website cookies', async()=>{
  const {api,calls}=loadApi(false);
  await api.request('/api/creator/bootstrap','test-native-bearer');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-native-bearer');
  assert.equal(calls[0].options.redirect,'error');
});
test('expired portal sessions do not fall back to sample mode or cached identity', async()=>{
  const {api}=loadApi(true,{detail:'Sign in required'},401);
  assert.equal(await api.readSession(),null);
});
test('API helper rejects arbitrary URLs before credentials can leave the API', async()=>{
  const {api,calls}=loadApi(true);
  await assert.rejects(api.request('https://evil.test/api/creator/items'));
  await assert.rejects(api.request('/api/../secrets'));
  assert.equal(calls.length,0);
});
