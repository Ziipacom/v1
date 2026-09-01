import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
const input = {language: 'Solidity', sources: {'Ziipa.sol': {content: fs.readFileSync('src/Ziipa.sol', 'utf8')}}, settings: {optimizer: {enabled:true, runs:200}, evmVersion:'cancun', outputSelection: {'*': {'*': ['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output = JSON.parse(solc.compile(JSON.stringify(input), {import: name => {
  const file = path.resolve('node_modules', name);
  if (!file.startsWith(path.resolve('node_modules') + path.sep)) return {error:'Invalid import'};
  return {contents: fs.readFileSync(file,'utf8')};
}}));
for (const error of output.errors ?? []) { if(error.severity === 'error') throw new Error(error.formattedMessage); }
fs.mkdirSync('artifacts', {recursive:true});
fs.mkdirSync('../backend/abi', {recursive:true});
for (const [name, c] of Object.entries(output.contracts['Ziipa.sol'])) {
  fs.writeFileSync(`artifacts/${name}.json`, JSON.stringify({abi:c.abi, bytecode:'0x'+c.evm.bytecode.object, runtime:'0x'+c.evm.deployedBytecode.object}, null, 2));
  fs.writeFileSync(`../backend/abi/${name}.json`, JSON.stringify(c.abi, null, 2));
}
console.log('Compiled Ziipa collectibles, creator tokens, factory and tips.');
