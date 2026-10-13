import fs from 'node:fs';
import { JsonRpcProvider, ContractFactory, keccak256 } from 'ethers';

// Add only the new module; preserve existing local tokens, NFTs and receipts.
const provider = new JsonRpcProvider('http://127.0.0.1:8545');
if ((await provider.getNetwork()).chainId !== 31337n)
  throw new Error('Refusing deployment outside the disposable local test chain.');
const file = '../backend/.local/web3-deployments.json';
const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!registry['31337']?.factory)
  throw new Error('Existing local Ziipa deployment registry is required.');
const existing = registry['31337'].rewards;
if (existing && keccak256(await provider.getCode(existing.address)) === existing.code_hash) {
  console.log('Existing local rewards deployment verified; nothing changed.');
} else {
  const artifact = JSON.parse(fs.readFileSync('artifacts/ZiipaMediaRewards.json', 'utf8'));
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, await provider.getSigner(0)).deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  registry['31337'].rewards = { address, code_hash: keccak256(await provider.getCode(address)) };
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  console.log('Local rewards module added. Existing registry entries preserved; no public transaction sent.');
}
