import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function headers(portal) {
  const exports={};
  const previewExports={};
  const previewSource=readFileSync(new URL('../../mobile/src/lib/preview-origin.ts',import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(previewSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:previewExports,URL});
  const source=readFileSync(new URL('../../mobile/src/lib/config.ts',import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process:{env:{EXPO_PUBLIC_PORTAL_MODE:portal?'true':'false'}},__DEV__:false,
    require:(name)=>{
      if(name==='react-native') return {Platform:{OS:'web'}};
      if(name==='./preview-origin') return previewExports;
      throw new Error('Unexpected config dependency: '+name);
    },location:{origin:'https://ziipa.com',hostname:'ziipa.com'},URL,
  });
  return exports.authorizationHeaders;
}
test('portal account markers only restrict identity and never become bearer credentials',()=>{
  const auth=headers(true);
  assert.equal(auth('ziipa-portal-cookie:12:123456')['X-Ziipa-User'],'12');
  assert.equal(auth('ziipa-portal-cookie:12:123456').Authorization,undefined);
  for(const value of [undefined,'real-bearer-secret','ziipa-portal-cookie:-1:123','ziipa-portal-cookie:12:bad']) assert.equal(Object.keys(auth(value)).length,0);
  assert.equal(headers(false)('native-token').Authorization,'Bearer native-token');
});
