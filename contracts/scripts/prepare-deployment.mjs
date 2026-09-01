// Generates reviewable unsigned deployments. Never signs, broadcasts, or reads keys.
import fs from 'node:fs';
import {keccak256} from 'ethers';
const chain=Number(process.argv[2]);
if(![84532,11155111].includes(chain))throw new Error('Choose Base Sepolia (84532) or Ethereum Sepolia (11155111). Mainnet is disabled.');
const result=['ZiipaCollectibles','ZiipaTokenFactory','ZiipaTips'].map(name=>{
  const artifact=JSON.parse(fs.readFileSync(`artifacts/${name}.json`));
  return {name,transaction:{chainId:'0x'+chain.toString(16),data:artifact.bytecode,value:'0x0'},expected_runtime_hash:keccak256(artifact.runtime)};
});
fs.mkdirSync('.local',{recursive:true});
fs.writeFileSync(`.local/deployment-${chain}.json`,JSON.stringify(result,null,2));
console.log(`Unsigned deployment plan saved to .local/deployment-${chain}.json. No transactions sent.`);
