// Explicit testnet deployment. The key is read from the environment and never written or logged.
import fs from 'node:fs';
import {ContractFactory, JsonRpcProvider, Wallet, keccak256} from 'ethers';

const chainId = Number(process.env.CHAIN_ID || 84532);
if (chainId !== 84532) throw new Error('This command only deploys to Base Sepolia (84532).');
const rpcUrl = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || '')) throw new Error('Set DEPLOYER_PRIVATE_KEY for a funded Base Sepolia deployment wallet.');
const provider = new JsonRpcProvider(rpcUrl, chainId, {staticNetwork: true});
if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('RPC chain mismatch.');
const signer = new Wallet(privateKey, provider);
const balance = await provider.getBalance(signer.address);
if (balance === 0n) throw new Error('The deployment wallet needs Base Sepolia ETH.');
const names = [['collectibles','ZiipaCollectibles'], ['factory','ZiipaTokenFactory'], ['tips','ZiipaTips']];
const registry = {[chainId]: {}};
for (const [key, name] of names) {
  const artifact = JSON.parse(fs.readFileSync(`artifacts/${name}.json`, 'utf8'));
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait(2);
  const code = await provider.getCode(address);
  registry[chainId][key] = {address, code_hash: keccak256(code), transaction_hash: receipt.hash};
  console.log(`${name}: ${address}`);
}
fs.mkdirSync('.local', {recursive: true});
fs.writeFileSync('.local/web3-deployments.json', JSON.stringify(registry, null, 2));
console.log('Registry saved to contracts/.local/web3-deployments.json');
