import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(frontend, '../mobile');
const output = resolve(frontend, 'public/studio');
if (!existsSync(resolve(mobile, 'package-lock.json'))) throw new Error('Build from the full Ziipa repository: the shared mobile/ source is required.');
function run(command,args,cwd,env=process.env) {
  const result = spawnSync(command,args,{cwd,env,stdio:'inherit',shell:false});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status||1);
}
if(!existsSync(resolve(mobile,'node_modules/expo/bin/cli'))) {
  const npmCli = process.env.npm_execpath;
  if(!npmCli) throw new Error('Run this build using npm run build:studio.');
  run(process.execPath,[npmCli,'ci','--no-audit','--no-fund'],mobile);
}
const env={...process.env,EXPO_PUBLIC_PORTAL_MODE:'true',EXPO_PUBLIC_API_URL:'',EXPO_PUBLIC_ENABLE_DEMO:'false',EXPO_PUBLIC_ENABLE_CONCEPTS:'true',APP_VARIANT:'preview',EXPO_PUBLIC_CANONICAL_API_ORIGIN:process.env.ZIIPA_API_PROXY||process.env.ZIIPA_CANONICAL_API_ORIGIN||'https://api.ziipa.com'};
// The portal uses the site's existing same-origin /api proxy + HttpOnly cookie.
// Never bundle backend credentials or reuse a developer's native API URL.
run(process.execPath,['node_modules/expo/bin/cli','export','--platform','web','--output-dir',output,'--max-workers','2'],mobile,env);
const html=resolve(output,'index.html');
if(!readFileSync(html,'utf8').includes('/studio/_expo/')) throw new Error('Studio asset base path was not applied.');
// Public preview helper is not a production route and points at the app root.
const helper=resolve(output,'preview.html');
if(existsSync(helper)) rmSync(helper);
writeFileSync(resolve(output,'build-info.json'),JSON.stringify({sharedSource:'mobile',portal:true,builtAt:new Date().toISOString()}));
