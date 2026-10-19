import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  bunkEvmConfigHash,
  bunkEvmInitializer,
  bunkEvmSponsorshipDigest,
  deriveBunkEvmDeploymentIdentity,
  deriveBunkOwner,
  encodeBunkEvmCalls,
  mnemonicToSeed,
  observeBunkEvmAccount,
  predictBunkEvmAccount,
  signBunkEvmDeployment,
  signBunkEvmOperation,
} from '../../../keyring/src/index.ts';

process.on('uncaughtException', (e) => {
  console.error(e.shortMessage || e.message, e.details || '', e.cause?.details || '');
  process.exit(1);
});
const s = JSON.parse(fs.readFileSync('state.json'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const local = (name, file = name) =>
  JSON.parse(fs.readFileSync(`${root}/out/${file}.sol/${name}.json`));
if (
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(s.rpc) ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.BUNK_BUNDLER_RPC ?? '')
)
  throw Error('local RPCs required');
const chain = defineChain({
  id: 1337,
  name: 'Bunk isolated Geth',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [s.rpc] } },
});
const client = createPublicClient({ chain, transport: http(s.rpc), pollingInterval: 300 });
const key = (n) => privateKeyToAccount(toHex(BigInt(n), { size: 32 }));
const admin = key(1),
  sponsor = key(4);
const seed = await mnemonicToSeed(`${'abandon '.repeat(11)}about`);
const owner = (accountIndex, ownerIndex) =>
  deriveBunkOwner(seed, { network: { family: 'evm', chainId: '1337' }, accountIndex, ownerIndex });
const accountIndexes = new Map();
const observationInputs = new Map();
let requiredFinalizedBlock = await client.getBlockNumber();
async function waitFinalized(number) {
  for (let i = 0; i < 100; i++) {
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    if (finalized.number >= number) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error(`local dev chain did not finalize block ${number}`);
}
async function observe(config, identity, accountIndex) {
  await waitFinalized(requiredFinalizedBlock);
  const input = {
    config,
    proxyRuntimeCodeHash: keccak256(local('SafeProxy').deployedBytecode.object),
    deploymentIdentity: identity.address,
    accountIndex,
    now: () => Math.floor(Date.now() / 1000),
    maxFinalizedAgeSeconds: 120,
  };
  const snapshot = await observeBunkEvmAccount((request) => client.request(request), input);
  observationInputs.set(snapshot.account.toLowerCase(), input);
  return snapshot;
}
const wallet = createWalletClient({ account: admin, chain, transport: http(s.rpc) });
const bundler = createPublicClient({
  transport: http(process.env.BUNK_BUNDLER_RPC),
  pollingInterval: 300,
});
const read = (name, address, functionName, args = []) =>
  client.readContract({ address, abi: local(name).abi, functionName, args });
const packed = (op) => ({
  sender: op.sender,
  nonce: op.nonce,
  initCode: op.factory ? concat([op.factory, op.factoryData]) : '0x',
  callData: op.callData,
  accountGasLimits: concat([
    toHex(op.verificationGasLimit, { size: 16 }),
    toHex(op.callGasLimit, { size: 16 }),
  ]),
  preVerificationGas: op.preVerificationGas,
  gasFees: concat([
    toHex(op.maxPriorityFeePerGas, { size: 16 }),
    toHex(op.maxFeePerGas, { size: 16 }),
  ]),
  paymasterAndData: op.paymaster
    ? concat([
        op.paymaster,
        toHex(op.paymasterVerificationGasLimit, { size: 16 }),
        toHex(op.paymasterPostOpGasLimit, { size: 16 }),
        op.paymasterData,
      ])
    : '0x',
  signature: op.signature,
});
const rpcOp = (op) =>
  Object.fromEntries(Object.entries(op).map(([k, v]) => [k, typeof v === 'bigint' ? toHex(v) : v]));
const sponsorAbi = parseAbiParameters(
  '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
);
let sponsorNonce = 1n;
async function build(
  accountIndex,
  ownerIndex,
  deploy,
  sponsored,
  fail = false,
  factory = s.factory,
  module = s.module,
  paymaster = s.paymaster,
) {
  const helper = await read('BunkFactory', factory, 'helper');
  const config = {
    chainId: '1337',
    proxyCreationCode: await read('SafeProxyFactory', s.proxyFactory, 'proxyCreationCode'),
  };
  for (const [name, address] of Object.entries({
    factory,
    singleton: s.singleton,
    proxyFactory: s.proxyFactory,
    entryPoint: s.entryPoint,
    module,
    helper,
  }))
    config[name] = { address, codeHash: keccak256(await client.getCode({ address })) };
  assert.equal(bunkEvmConfigHash(config), await read('BunkFactory', factory, 'configHash'));
  assert.equal(bunkEvmInitializer(config), await read('BunkFactory', factory, 'initializer'));
  const identity = deriveBunkEvmDeploymentIdentity(seed, accountIndex);
  const sender = predictBunkEvmAccount(config, identity.address, accountIndex);
  assert.equal(
    sender,
    await read('BunkFactory', factory, 'predictAccount', [identity.address, accountIndex]),
  );
  accountIndexes.set(sender.toLowerCase(), accountIndex);
  const observation = await observe(config, identity, accountIndex);
  assert.equal(observation.status, deploy ? 'undeployed' : 'deployed');
  const op = {
    sender,
    nonce: observation.status === 'deployed' ? observation.state.nonce : 0n,
    callData: encodeBunkEvmCalls(config, sender, [
      {
        target: s.target,
        value: 0n,
        data: encodeFunctionData({
          abi: local('Target', 'BunkIntegration.t').abi,
          functionName: fail ? 'fail' : 'set',
          args: fail ? [] : [BigInt(42 + ownerIndex)],
        }),
      },
    ]),
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
    signature: '0x',
  };
  if (deploy) {
    const certificate = signBunkEvmDeployment(seed, config, accountIndex);
    assert.equal(
      certificate.digest,
      await read('BunkFactory', factory, 'deploymentDigest', [
        identity.address,
        accountIndex,
        owner(accountIndex, 0).commitment,
      ]),
    );
    op.factory = factory;
    op.factoryData = certificate.factoryData;
  }
  const now = Number((await client.getBlock()).timestamp);
  if (sponsored) {
    Object.assign(op, {
      paymaster,
      paymasterVerificationGasLimit: 200000n,
      paymasterPostOpGasLimit: 0n,
      paymasterData: '0x',
    });
    const grant = {
      validAfter: now - 10,
      validUntil: now + 1800,
      maxCost: parseEther('0.01'),
      nonce: sponsorNonce++,
      epoch: 0n,
      signature: '0x',
    };
    const digest = await read('BunkPaymaster', paymaster, 'sponsorshipDigest', [packed(op), grant]);
    op.paymasterData = encodeAbiParameters(sponsorAbi, [
      { ...grant, signature: toHex(new Uint8Array(65)) },
    ]);
    assert.equal(
      bunkEvmSponsorshipDigest(
        config,
        { ...op, initCode: packed(op).initCode, paymasterAndData: packed(op).paymasterAndData },
        { ...grant, signature: '0x' },
      ),
      digest,
    );
    grant.signature = await sponsor.sign({ hash: digest });
    op.paymasterData = encodeAbiParameters(sponsorAbi, [grant]);
  }
  const unsigned = {
    ...op,
    initCode: packed(op).initCode,
    paymasterAndData: packed(op).paymasterAndData,
  };
  let sponsorState;
  if (sponsored) {
    const paymasterCode = await client.getCode({ address: paymaster });
    sponsorState = {
      paymaster: { address: paymaster, codeHash: keccak256(paymasterCode) },
      signer: await read('BunkPaymaster', paymaster, 'sponsorSigner'),
      epoch: await read('BunkPaymaster', paymaster, 'sponsorEpoch'),
      maxCostPerOperation: await read('BunkPaymaster', paymaster, 'maxCostPerOperation'),
    };
  }
  const [commitment, index] = deploy
    ? [owner(accountIndex, 0).commitment, 0]
    : [observation.state.commitment, observation.state.ownerIndex];
  assert.equal(index, ownerIndex);
  const signed = signBunkEvmOperation(seed, {
    config,
    state: { account: sender, accountIndex, ownerIndex, commitment, nonce: op.nonce },
    operation: unsigned,
    validity: { validAfter: now - 10, validUntil: now + 1800 },
    maximumGasCost: parseEther('0.01'),
    sponsor: sponsorState,
  });
  const hash = await read('EntryPoint', s.entryPoint, 'getUserOpHash', [packed(op)]);
  assert.equal(signed.userOpHash, hash);
  assert.equal(
    signed.digest,
    await read('BunkModule', module, 'ownerDigest', [
      hash,
      {
        ownerIndex,
        nextCommitment: owner(accountIndex, ownerIndex + 1).commitment,
        validAfter: now - 10,
        validUntil: now + 1800,
        signature: '0x',
      },
    ]),
  );
  op.signature = signed.operation.signature;

  return op;
}
async function send(op, label, expectedSuccess = true) {
  console.log('submitting', label);
  const hash = await bundler.request({
    method: 'eth_sendUserOperation',
    params: [rpcOp(op), s.entryPoint],
  });
  console.log('accepted', label, hash);
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = await bundler.request({ method: 'eth_getUserOperationReceipt', params: [hash] });
    if (receipt) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(receipt, 'receipt missing');
  assert.equal(
    hash.toLowerCase(),
    (await read('EntryPoint', s.entryPoint, 'getUserOpHash', [packed(op)])).toLowerCase(),
  );
  assert.equal(receipt.sender.toLowerCase(), op.sender.toLowerCase());
  assert.equal(receipt.entryPoint.toLowerCase(), s.entryPoint.toLowerCase());
  assert.equal(receipt.success, expectedSuccess);
  requiredFinalizedBlock = BigInt(receipt.receipt.blockNumber);
  await waitFinalized(requiredFinalizedBlock);
  const observation = await observeBunkEvmAccount(
    (request) => client.request(request),
    observationInputs.get(op.sender.toLowerCase()),
  );
  assert.equal(observation.status, 'deployed');
  const state = [observation.state.commitment, observation.state.ownerIndex];
  const nonce = observation.state.nonce;
  assert.equal(
    state[0],
    owner(accountIndexes.get(op.sender.toLowerCase()), Number(op.nonce) + 1).commitment,
  );
  assert.equal(nonce, op.nonce + 1n);
  console.log(
    'included',
    label,
    receipt.receipt.transactionHash,
    'owner index',
    state[1],
    'nonce',
    nonce.toString(),
  );
  return {
    label,
    hash,
    transactionHash: receipt.receipt.transactionHash,
    success: receipt.success,
    ownerIndex: state[1],
    nonce: nonce.toString(),
    finalizedBlock: { hash: observation.block.hash, number: observation.block.number.toString() },
  };
}
const report = [];
async function reject(op, label, pattern) {
  let rejected;
  try {
    await bundler.request({ method: 'eth_sendUserOperation', params: [rpcOp(op), s.entryPoint] });
  } catch (e) {
    rejected = e;
  }
  assert(rejected, `${label}: unexpectedly accepted`);
  const message = [rejected.shortMessage, rejected.details, rejected.cause?.message]
    .filter(Boolean)
    .join(' ');
  assert.match(message, pattern, `${label}: wrong rejection: ${message}`);
  report.push({ label, rejected: true, message });
  console.log('rejected', label, message);
}
const op = await build(0, 0, true, true);
const deploymentGas = await client.estimateGas({
  account: admin.address,
  to: op.factory,
  data: op.factoryData,
});
// Signature mutation must fail before the valid original is submitted.
await reject({ ...op, maxFeePerGas: op.maxFeePerGas + 1n }, 'changed signed gas', /signature/i);
assert.equal(await client.getCode({ address: op.sender }), undefined);
assert.equal(await read('EntryPoint', s.entryPoint, 'getNonce', [op.sender, 0n]), 0n);
// A deliberately noncompliant account proves opcode rules actually execute.
const forbidden = {
  ...op,
  sender: s.badAccount,
  nonce: 0n,
  callData: encodeFunctionData({
    abi: local('BundlerNegativeAccount').abi,
    functionName: 'execute',
  }),
  signature: '0x',
};
for (const k of [
  'factory',
  'factoryData',
  'paymaster',
  'paymasterData',
  'paymasterVerificationGasLimit',
  'paymasterPostOpGasLimit',
])
  delete forbidden[k];
await reject(forbidden, 'forbidden TIMESTAMP', /banned opcode: TIMESTAMP/i);
// Creation-time external state requires factory stake; the test must not whitelist it.
const unstaked = await build(
  1,
  0,
  true,
  true,
  false,
  s.unstakedFactory,
  s.unstakedModule,
  s.unstakedPaymaster,
);
await reject(unstaked, 'unstaked factory', /unstaked factory/i);
assert.equal(await client.getCode({ address: unstaked.sender }), undefined);
const created = await send(op, 'sponsored counterfactual creation');
assert.equal(created.ownerIndex, 1);
report.push(created);
assert.equal(await client.getBalance({ address: op.sender }), 0n);
const op2 = await build(0, 1, false, true, true);
const failed = await send(op2, 'sponsored downstream revert', false);
assert.equal(failed.ownerIndex, 2);
report.push(failed);
const op3 = await build(0, 2, false, true);
const recovered = await send(op3, 'next owner after failure');
assert.equal(recovered.ownerIndex, 3);
report.push(recovered);
// Self-funded execution traverses the Safe prefund path as well.
const direct = await build(2, 0, true, false);
const deployment = await wallet.sendTransaction({
  to: direct.factory,
  data: direct.factoryData,
  gas: 1000000n,
});
assert.equal((await client.waitForTransactionReceipt({ hash: deployment })).status, 'success');
const fundingReceipt = await client.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({ to: direct.sender, value: parseEther('1') }),
});
requiredFinalizedBlock = fundingReceipt.blockNumber;
const selfFunded = await build(2, 0, false, false);
const paid = await send(selfFunded, 'self-funded deployed account');
assert.equal(paid.ownerIndex, 1);
report.push(paid);
const codeHashes = {};
for (const name of ['entryPoint', 'singleton', 'proxyFactory', 'factory', 'module', 'paymaster'])
  codeHashes[name] = keccak256(await client.getCode({ address: s[name] }));
fs.writeFileSync(
  'results.json',
  `${JSON.stringify(
    {
      chainId: 1337,
      signingImplementation: 'packages/keyring/src/bunk-evm-sign.ts',
      observationImplementation: 'packages/keyring/src/bunk-evm-observe.ts',
      finalityScope: 'Geth dev simulated finality every 32 blocks, not production consensus proof',
      contractDigestComparisons: [
        'configHash',
        'initializer',
        'predictAccount',
        'deploymentDigest',
        'getUserOpHash',
        'ownerDigest',
        'sponsorshipDigest',
      ],
      safeMode: true,
      validationSkipped: false,
      deploymentGas: deploymentGas.toString(),
      codeHashes,
      cases: report,
    },
    null,
    2,
  )}\n`,
);
console.log('All bundler acceptance and rejection controls passed.');
