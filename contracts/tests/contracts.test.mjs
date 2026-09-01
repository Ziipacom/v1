import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JsonRpcProvider, ContractFactory, Contract, parseEther, ZeroAddress} from 'ethers';
import solc from 'solc';
const provider=new JsonRpcProvider('http://127.0.0.1:8545',undefined,{cacheTimeout:-1});
if((await provider.getNetwork()).chainId!==31337n)throw new Error('Tests may only use the local chain.');
const signer=await provider.getSigner(0), recipient=await provider.getSigner(1), curator=await provider.getSigner(2);
const artifact=name=>JSON.parse(fs.readFileSync(`artifacts/${name}.json`));
async function deploy(name) {const a=artifact(name),c=await new ContractFactory(a.abi,a.bytecode,signer).deploy();await c.waitForDeployment();return c;}
const uri='ipfs://bafkreibxziipatestmetadata0123456789';

test('collectibles retain immutable metadata and creator royalty after transfer; unauthorized transfers fail',async()=>{
  const c=await deploy('ZiipaCollectibles');await(await c.mint(uri,500)).wait();
  assert.equal(await c.ownerOf(1),await signer.getAddress());assert.equal(await c.tokenURI(1),uri);
  await assert.rejects(c.connect(recipient).transferFrom(await signer.getAddress(),await recipient.getAddress(),1));
  await assert.rejects(c.mint(uri,1001));
  await(await c.transferFrom(await signer.getAddress(),await recipient.getAddress(),1)).wait();
  assert.equal(await c.tokenOfOwnerByIndex(await recipient.getAddress(),0),1n);
  assert.equal(await c.tokenURI(1),uri);
  const royalty=await c.royaltyInfo(1,10000);assert.equal(royalty[0],await signer.getAddress());assert.equal(royalty[1],500n);
});
test('creator token supply is fixed and factory provenance is queryable',async()=>{
  const f=await deploy('ZiipaTokenFactory');
  await assert.rejects(f.createToken('Test','TEST',0,uri));
  await assert.rejects(f.createToken('Test','TEST',parseEther('1000000001'),uri));
  const receipt=await(await f.createToken('Studio community','STUD',parseEther('1000'),uri)).wait();
  const event=receipt.logs.map(l=>{try{return f.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='TokenCreated');
  const token=new Contract(event.args.token,artifact('ZiipaCreatorToken').abi,signer);
  assert.equal(await f.isCreatorToken(await token.getAddress()),true);
  assert.equal(await token.totalSupply(),parseEther('1000'));
  await(await token.transfer(await recipient.getAddress(),parseEther('10'))).wait();
  assert.equal(await token.balanceOf(await recipient.getAddress()),parseEther('10'));
  assert.equal(await token.metadataURI(),uri);
  assert.equal(token.interface.getFunction('mint'),null);
});
test('tips split exactly, reject invalid splits and retain no funds',async()=>{
  const tips=await deploy('ZiipaTips');
  const a=await recipient.getAddress(),b=await curator.getAddress();
  const beforeA=await provider.getBalance(a),beforeB=await provider.getBalance(b);
  await(await tips.tip(a,b,1250,{value:parseEther('0.8')})).wait();
  assert.equal((await provider.getBalance(a))-beforeA,parseEther('0.7'));
  assert.equal((await provider.getBalance(b))-beforeB,parseEther('0.1'));
  assert.equal(await provider.getBalance(await tips.getAddress()),0n);
  await assert.rejects(tips.tip(a,ZeroAddress,100,{value:100}));
  await assert.rejects(tips.tip(a,b,5001,{value:100}));
});
test('receiver callbacks cannot recursively mint; failed payouts revert the whole tip',async()=>{
  const src=`pragma solidity ^0.8.24; interface Mint {function mint(string calldata,uint96) external returns(uint256);}
  contract Probe {Mint target; bool attempted; constructor(address t){target=Mint(t);} function run() external {target.mint("ipfs://callback-test",0);}
  function onERC721Received(address,address,uint256,bytes calldata) external returns(bytes4){if(!attempted){attempted=true;try target.mint("ipfs://recursive-test",0){}catch{}}return this.onERC721Received.selector;}}
  contract Reject {receive() external payable {revert("No payments");}}`;
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Probe.sol':{content:src}},settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  const c=await deploy('ZiipaCollectibles'),p=out.contracts['Probe.sol'].Probe,r=out.contracts['Probe.sol'].Reject;
  const probe=await new ContractFactory(p.abi,'0x'+p.evm.bytecode.object,signer).deploy(await c.getAddress());await probe.waitForDeployment();await(await probe.run()).wait();
  assert.equal(await c.balanceOf(await probe.getAddress()),1n);
  const reject=await new ContractFactory(r.abi,'0x'+r.evm.bytecode.object,signer).deploy();await reject.waitForDeployment();
  const tips=await deploy('ZiipaTips'),a=await recipient.getAddress(),before=await provider.getBalance(a);
  await assert.rejects(tips.tip(a,await reject.getAddress(),1000,{value:1000}));
  assert.equal(await provider.getBalance(a),before);
});
