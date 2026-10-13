import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {AbiCoder, ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, concat, id, keccak256, parseEther} from 'ethers';

const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, {cacheTimeout: -1});
if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('Rewards tests may only use the local chain.');
const creator = await provider.getSigner(0);
const otherCreator = await provider.getSigner(1);
const alice = await provider.getSigner(2);
const bob = await provider.getSigner(3);
const creatorAddress = await creator.getAddress();
const otherAddress = await otherCreator.getAddress();
const aliceAddress = await alice.getAddress();
const bobAddress = await bob.getAddress();
const abi = AbiCoder.defaultAbiCoder();
const batch = label => creatorAddress.toLowerCase() + id(label).slice(2, 26);
const artifact = name => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, 'utf8'));
const leaf = (batchId, recipient, amount) => keccak256(keccak256(abi.encode(['bytes32', 'address', 'uint256'], [batchId, recipient, amount])));
const pair = (a, b) => keccak256(concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));

async function deploy(name, args = [], signer = creator) {
  const data = artifact(name);
  const contract = await new ContractFactory(data.abi, data.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}
async function setup() {
  const rewards = await deploy('ZiipaMediaRewards');
  const token = await deploy('ZiipaCreatorToken', ['Ziipa media reward', 'ZMR', parseEther('1000'), 'ipfs://rewards-test-token', creatorAddress]);
  return {rewards, token, target: await rewards.getAddress(), tokenAddress: await token.getAddress()};
}
async function fund(rewards, token, amount, signer = creator) {
  await (await token.connect(signer).approve(await rewards.getAddress(), amount)).wait();
  return (await rewards.connect(signer).deposit(await token.getAddress(), amount)).wait();
}

test('rewards deposits are wallet-approved, exactly funded and bounded; native funds and invalid tokens fail', async () => {
  const {rewards, token, target, tokenAddress} = await setup();
  await assert.rejects(rewards.deposit(ZeroAddress, 1));
  await assert.rejects(rewards.deposit(aliceAddress, 1));
  await assert.rejects(rewards.deposit(tokenAddress, 0));
  await assert.rejects(rewards.deposit(tokenAddress, (await rewards.MAX_DEPOSIT()) + 1n));
  await assert.rejects(rewards.deposit(tokenAddress, 100)); // No allowance.
  assert.equal(await rewards.poolCredits(creatorAddress, tokenAddress), 0n);
  await assert.rejects(creator.sendTransaction({to: target, value: 1}));
  await fund(rewards, token, 100n);
  assert.equal(await rewards.poolCredits(creatorAddress, tokenAddress), 100n);
  assert.equal(await rewards.totalAccounted(tokenAddress), 100n);
  assert.equal(await token.balanceOf(target), 100n);
  // Sending unsolicited tokens does not give any caller credit or let them withdraw donations.
  await (await token.transfer(target, 11n)).wait();
  await assert.rejects(rewards.connect(otherCreator).withdraw(tokenAddress, 11n));
  assert.equal(await rewards.totalAccounted(tokenAddress), 100n);
  assert.equal(await token.balanceOf(target), 111n);
});

test('creator pools isolate tokens, owners and permanent reservations; withdrawal never consumes promised rewards', async () => {
  const {rewards, token, target, tokenAddress} = await setup();
  const secondToken = await deploy('ZiipaCreatorToken', ['Second', 'TWO', 1000n, 'ipfs://second-rewards-token', otherAddress], otherCreator);
  const secondAddress = await secondToken.getAddress();
  await (await token.transfer(otherAddress, 200n)).wait();
  await fund(rewards, token, 100n);
  await fund(rewards, token, 40n, otherCreator);
  await fund(rewards, secondToken, 70n, otherCreator);
  const batchId = batch('isolated-pool');
  await (await rewards.publishBatch(batchId, tokenAddress, leaf(batchId, aliceAddress, 60n), 60n)).wait();
  assert.equal(await rewards.poolCredits(creatorAddress, tokenAddress), 40n);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 60n);
  await assert.rejects(rewards.withdraw(tokenAddress, 41n));
  await assert.rejects(rewards.connect(otherCreator).publishBatch(otherAddress.toLowerCase() + id('steal-pool').slice(2, 26), tokenAddress, leaf(batchId, bobAddress, 41n), 41n));
  await assert.rejects(rewards.withdraw(secondAddress, 1n));
  const before = await token.balanceOf(creatorAddress);
  await (await rewards.withdraw(tokenAddress, 40n)).wait();
  assert.equal(await token.balanceOf(creatorAddress), before + 40n);
  assert.equal(await token.balanceOf(target), 100n);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 60n);
  assert.equal(await rewards.poolCredits(otherAddress, tokenAddress), 40n);
  assert.equal(await rewards.poolCredits(otherAddress, secondAddress), 70n);
  await (await rewards.connect(otherCreator).withdraw(secondAddress, 70n)).wait();
  assert.equal(await secondToken.balanceOf(otherAddress), 1000n);
});

test('published roots and totals cannot be replaced, cancelled or double reserved, including by another owner', async () => {
  const {rewards, token, tokenAddress} = await setup();
  await fund(rewards, token, 100n);
  const batchId = batch('immutable-batch');
  const root = leaf(batchId, aliceAddress, 60n);
  await assert.rejects(rewards.publishBatch(ZeroHash, tokenAddress, root, 60n));
  await assert.rejects(rewards.publishBatch(batchId, tokenAddress, ZeroHash, 60n));
  await assert.rejects(rewards.publishBatch(batchId, tokenAddress, root, 0n));
  await assert.rejects(rewards.publishBatch(batchId, tokenAddress, root, 101n));
  await (await rewards.publishBatch(batchId, tokenAddress, root, 60n)).wait();
  await assert.rejects(rewards.publishBatch(batchId, tokenAddress, leaf(batchId, bobAddress, 5n), 5n));
  await assert.rejects(rewards.connect(otherCreator).publishBatch(batchId, tokenAddress, root, 1n));
  const storedBatch = await rewards.batches(batchId);
  assert.equal(storedBatch.owner, creatorAddress);
  assert.equal(storedBatch.token, tokenAddress);
  assert.equal(storedBatch.root, root);
  assert.equal(storedBatch.totalAmount, 60n);
  assert.equal(storedBatch.remainingAmount, 60n);
  assert.equal(rewards.interface.getFunction('cancelBatch'), null);
  assert.equal(rewards.interface.getFunction('setRoot'), null);
});

test('a funded creator cannot front-run another creator wallet’s batch domain', async () => {
  const {rewards, token, tokenAddress} = await setup();
  await (await token.transfer(otherAddress, 100n)).wait();
  await fund(rewards, token, 50n);
  await fund(rewards, token, 50n, otherCreator);
  const batchId = batch('observed-mempool-root'), root = leaf(batchId, aliceAddress, 30n);
  await assert.rejects(rewards.connect(otherCreator).publishBatch(batchId, tokenAddress, root, 30n));
  assert.equal(await rewards.poolCredits(otherAddress, tokenAddress), 50n);
  await (await rewards.publishBatch(batchId, tokenAddress, root, 30n)).wait();
  assert.equal((await rewards.batches(batchId)).owner, creatorAddress);
});

test('claims use exact double-hashed batch/recipient/amount proofs and transfer only to the signing recipient', async () => {
  const {rewards, token, target, tokenAddress} = await setup();
  const batchId = batch('two-recipients');
  const aliceLeaf = leaf(batchId, aliceAddress, 30n), bobLeaf = leaf(batchId, bobAddress, 70n);
  const root = pair(aliceLeaf, bobLeaf);
  assert.equal(await rewards.leafHash(batchId, aliceAddress, 30n), aliceLeaf);
  await fund(rewards, token, 100n);
  await (await rewards.publishBatch(batchId, tokenAddress, root, 100n)).wait();
  await assert.rejects(rewards.connect(bob).claim(batchId, 30n, [bobLeaf])); // Cannot steal Alice's proof.
  await assert.rejects(rewards.connect(alice).claim(batchId, 31n, [bobLeaf]));
  await assert.rejects(rewards.connect(alice).claim(batchId, 30n, []));
  await assert.rejects(rewards.connect(alice).claim(id('unpublished'), 30n, [bobLeaf]));
  await (await rewards.connect(alice).claim(batchId, 30n, [bobLeaf])).wait();
  assert.equal(await token.balanceOf(aliceAddress), 30n);
  assert.equal(await rewards.claimed(batchId, aliceAddress), true);
  assert.equal((await rewards.batches(batchId)).remainingAmount, 70n);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 70n);
  await assert.rejects(rewards.connect(alice).claim(batchId, 30n, [bobLeaf]));
  await (await rewards.connect(bob).claim(batchId, 70n, [aliceLeaf])).wait();
  assert.equal(await token.balanceOf(bobAddress), 70n);
  assert.equal(await token.balanceOf(target), 0n);
  assert.equal(await rewards.totalAccounted(tokenAddress), 0n);
  assert.equal((await rewards.batches(batchId)).remainingAmount, 0n);
});

test('claim replay is bound to batch ID; duplicate recipient leaves and understated totals cannot drain another batch', async () => {
  const {rewards, token, tokenAddress} = await setup();
  await fund(rewards, token, 100n);
  const first = batch('first-domain'), second = batch('second-domain');
  const firstLeaf = leaf(first, aliceAddress, 10n), duplicate = leaf(first, aliceAddress, 20n);
  await (await rewards.publishBatch(first, tokenAddress, pair(firstLeaf, duplicate), 30n)).wait();
  await (await rewards.publishBatch(second, tokenAddress, leaf(second, aliceAddress, 40n), 40n)).wait();
  await (await rewards.connect(alice).claim(first, 10n, [duplicate])).wait();
  await assert.rejects(rewards.connect(alice).claim(first, 20n, [firstLeaf]));
  await assert.rejects(rewards.connect(alice).claim(second, 10n, [duplicate]));
  await (await rewards.connect(alice).claim(second, 40n, [])).wait();
  assert.equal(await token.balanceOf(aliceAddress), 50n);
  assert.equal((await rewards.batches(first)).remainingAmount, 20n);
  const short = batch('understated-total');
  await (await rewards.publishBatch(short, tokenAddress, leaf(short, bobAddress, 25n), 5n)).wait();
  await assert.rejects(rewards.connect(bob).claim(short, 25n, []));
  assert.equal(await rewards.claimed(short, bobAddress), false);
  assert.equal((await rewards.batches(first)).remainingAmount, 20n);
  assert.equal((await rewards.batches(short)).remainingAmount, 5n);
});

const probes = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface Rewards {function claim(bytes32,uint256,bytes32[] calldata) external;}
interface Callback {function onRewardTransfer() external;}
contract FeeProbe is ERC20 {
    bool public fee; constructor() ERC20("Probe", "PRB") {_mint(msg.sender,1000 ether);}
    function setFee(bool value) external {fee=value;}
    function burn(address who,uint256 amount) external {_burn(who,amount);}
    function _update(address from,address to,uint256 amount) internal override {
        if(fee && from!=address(0) && to!=address(0)) {super._update(from,address(0),1);super._update(from,to,amount-1);}
        else super._update(from,to,amount);
    }
}
contract CallbackProbe is ERC20 {
    constructor() ERC20("Callback", "CBK") {_mint(msg.sender,1000 ether);}
    function _update(address from,address to,uint256 amount) internal override {
        super._update(from,to,amount);
        if(from!=address(0) && to.code.length>0) {try Callback(to).onRewardTransfer() {} catch {}}
    }
}
contract RecipientProbe {
    Rewards public rewards; bytes32 public batch; uint256 public amount; bool public reentrySucceeded;
    constructor(address rewards_) {rewards=Rewards(rewards_);}
    function run(bytes32 batch_,uint256 amount_) external {batch=batch_;amount=amount_;bytes32[] memory proof=new bytes32[](0);rewards.claim(batch,amount,proof);}
    function onRewardTransfer() external {bytes32[] memory proof=new bytes32[](0);try rewards.claim(batch,amount,proof) {reentrySucceeded=true;}catch {}}
}`;
const probeOutput = JSON.parse(solc.compile(JSON.stringify({language: 'Solidity', sources: {'Probes.sol': {content: probes}}, settings: {evmVersion: 'cancun', outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object']}}}}), {import: name => ({contents: fs.readFileSync(path.resolve('node_modules', name), 'utf8')})}));
for (const error of probeOutput.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
async function deployProbe(name, args = []) {
  const data = probeOutput.contracts['Probes.sol'][name];
  const contract = await new ContractFactory(data.abi, '0x' + data.evm.bytecode.object, creator).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

test('fee-on-transfer and depleted token balances revert atomically rather than underfund rewards', async () => {
  const rewards = await deploy('ZiipaMediaRewards'), token = await deployProbe('FeeProbe');
  const target = await rewards.getAddress(), tokenAddress = await token.getAddress();
  await (await token.approve(target, 100n)).wait();
  await (await token.setFee(true)).wait();
  await assert.rejects(rewards.deposit(tokenAddress, 100n));
  assert.equal(await rewards.poolCredits(creatorAddress, tokenAddress), 0n);
  assert.equal(await token.balanceOf(target), 0n);
  await (await token.setFee(false)).wait();
  await fund(rewards, token, 100n);
  const batchId = batch('fee-outgoing');
  await (await rewards.publishBatch(batchId, tokenAddress, leaf(batchId, aliceAddress, 60n), 60n)).wait();
  await (await token.setFee(true)).wait();
  await assert.rejects(rewards.connect(alice).claim(batchId, 60n, []));
  await assert.rejects(rewards.withdraw(tokenAddress, 40n));
  assert.equal(await rewards.claimed(batchId, aliceAddress), false);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 60n);
  assert.equal(await rewards.poolCredits(creatorAddress, tokenAddress), 40n);
  assert.equal(await rewards.totalAccounted(tokenAddress), 100n);
  assert.equal(await token.balanceOf(target), 100n);
  await (await token.setFee(false)).wait();
  await (await token.burn(target, 1n)).wait();
  await assert.rejects(rewards.publishBatch(batch('insolvent'), tokenAddress, leaf(batchId, bobAddress, 1n), 1n));
  await assert.rejects(rewards.withdraw(tokenAddress, 1n));
  await assert.rejects(rewards.connect(alice).claim(batchId, 60n, []));
  assert.equal(await rewards.totalAccounted(tokenAddress), 100n);
});

test('malicious token callbacks cannot recursively claim or duplicate a reservation payout', async () => {
  const rewards = await deploy('ZiipaMediaRewards'), token = await deployProbe('CallbackProbe');
  const recipient = await deployProbe('RecipientProbe', [await rewards.getAddress()]);
  const target = await rewards.getAddress(), tokenAddress = await token.getAddress(), recipientAddress = await recipient.getAddress();
  await fund(rewards, token, 100n);
  const batchId = batch('reentrant-claim');
  await (await rewards.publishBatch(batchId, tokenAddress, leaf(batchId, recipientAddress, 60n), 60n)).wait();
  await (await recipient.run(batchId, 60n)).wait();
  assert.equal(await recipient.reentrySucceeded(), false);
  assert.equal(await rewards.claimed(batchId, recipientAddress), true);
  assert.equal(await token.balanceOf(recipientAddress), 60n);
  assert.equal(await token.balanceOf(target), 40n);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 0n);
  assert.equal(await rewards.totalAccounted(tokenAddress), 40n);
});

test('simultaneous recipient submissions settle exact funded amounts once and emit verifiable receipts', async () => {
  const {rewards, token, tokenAddress} = await setup();
  const batchId = batch('parallel-recipients');
  const a = leaf(batchId, aliceAddress, 25n), b = leaf(batchId, bobAddress, 75n);
  const fundingReceipt = await fund(rewards, token, 100n);
  const publishReceipt = await (await rewards.publishBatch(batchId, tokenAddress, pair(a, b), 100n)).wait();
  const [first, second] = await Promise.all([
    rewards.connect(alice).claim(batchId, 25n, [b]).then(tx => tx.wait()),
    rewards.connect(bob).claim(batchId, 75n, [a]).then(tx => tx.wait()),
  ]);
  const event = (receipt, name) => receipt.logs.map(log => {try {return rewards.interface.parseLog(log);} catch {return null;}}).find(log => log?.name === name);
  assert.equal(event(fundingReceipt, 'Deposited').args.owner, creatorAddress);
  assert.equal(event(fundingReceipt, 'Deposited').args.amount, 100n);
  assert.equal(event(publishReceipt, 'BatchPublished').args.batchId, batchId);
  assert.equal(event(publishReceipt, 'BatchPublished').args.totalAmount, 100n);
  assert.equal(event(first, 'Claimed').args.recipient, aliceAddress);
  assert.equal(event(second, 'Claimed').args.recipient, bobAddress);
  assert.equal(await token.balanceOf(aliceAddress), 25n);
  assert.equal(await token.balanceOf(bobAddress), 75n);
  assert.equal(await rewards.totalAccounted(tokenAddress), 0n);
  assert.equal(await rewards.reservedCredits(creatorAddress, tokenAddress), 0n);
});
