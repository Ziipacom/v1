import fs from 'node:fs';
import {JsonRpcProvider, ContractFactory, keccak256} from 'ethers';
const provider = new JsonRpcProvider('http://127.0.0.1:8545');
if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('Local deployment only; refusing any other chain.');
const signer = await provider.getSigner(0);
const contracts = {};
for (const [key, name] of [['collectibles','ZiipaCollectibles'],['factory','ZiipaTokenFactory'],['tips','ZiipaTips']]) {
  const artifact=JSON.parse(fs.readFileSync(`artifacts/${name}.json`));
  const c=await new ContractFactory(artifact.abi,artifact.bytecode,signer).deploy();
  await c.waitForDeployment();
  const address=await c.getAddress();
  contracts[key]={address, code_hash: keccak256(await provider.getCode(address))};
}
fs.mkdirSync('../backend/.local', {recursive:true});
fs.writeFileSync('../backend/.local/web3-deployments.json',JSON.stringify({'31337':contracts},null,2));
console.log('Local contracts deployed; registry saved to backend/.local/web3-deployments.json. No public-chain transactions sent.');
