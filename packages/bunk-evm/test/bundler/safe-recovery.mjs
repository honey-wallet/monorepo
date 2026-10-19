// Version 2 Safe recovery acceptance probe; client/journal integration remains separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  slice,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const s = JSON.parse(fs.readFileSync('state.json'));
assert.match(s.rpc, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(process.env.BUNK_BUNDLER_RPC ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifact = (name, file = name) =>
  JSON.parse(fs.readFileSync(`${root}/out/${file}.sol/${name}.json`));
const chain = defineChain({
  id: 1337,
  name: 'Safe recovery candidate',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [s.rpc] } },
});
const client = createPublicClient({ chain, transport: http(s.rpc), pollingInterval: 300 });
const bundler = createPublicClient({ transport: http(process.env.BUNK_BUNDLER_RPC) });
const key = (n) => privateKeyToAccount(toHex(BigInt(n), { size: 32 }));
const admin = key(1),
  sponsor = key(4),
  owner = key(6),
  next = key(8);
const wallet = createWalletClient({ account: admin, chain, transport: http(s.rpc) });
const read = (name, address, functionName, args = [], file = name) =>
  client.readContract({ address, abi: artifact(name, file).abi, functionName, args });
async function deploy(name, args = [], file = name) {
  const a = artifact(name, file);
  const receipt = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({
      abi: a.abi,
      bytecode: a.bytecode.object,
      args,
      gas: 8000000n,
    }),
  });
  assert.equal(receipt.status, 'success');
  return receipt.contractAddress;
}
async function write(name, address, functionName, args = [], value = 0n) {
  const receipt = await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address,
      abi: artifact(name).abi,
      functionName,
      args,
      value,
      gas: 2000000n,
    }),
  });
  assert.equal(receipt.status, 'success');
}
const bootstrap = key(12);
const factory = await deploy('BunkRecoveryFactory', [
  s.singleton,
  s.proxyFactory,
  s.entryPoint,
  admin.address,
]);
const module = await read('BunkRecoveryFactory', factory, 'module');
const helper = await read('BunkRecoveryFactory', factory, 'helper');
const target = await deploy('Target', [], 'BunkIntegration.t');
const paymaster = await deploy('BunkPaymaster', [
  s.entryPoint,
  module,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkRecoveryFactory', factory, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'deposit', [], parseEther('1'));
await write('BunkPaymaster', paymaster, 'setBudget', [parseEther('1')]);
async function deployment(factoryAddress, commitment, accountIndex = 0) {
  const initializer = await read('BunkRecoveryFactory', factoryAddress, 'initializer');
  const proxyCreationCode = await read('SafeProxyFactory', s.proxyFactory, 'proxyCreationCode');
  const nonce = keccak256(
    encodeAbiParameters(parseAbiParameters('string,address,uint32'), [
      'HoneyBunkAccountV2',
      bootstrap.address,
      accountIndex,
    ]),
  );
  const salt = keccak256(concatHex([keccak256(initializer), nonce]));
  const initHash = keccak256(
    concatHex([proxyCreationCode, toHex(BigInt(s.singleton), { size: 32 })]),
  );
  const accountAddress = getAddress(
    slice(keccak256(concatHex(['0xff', s.proxyFactory, salt, initHash])), 12),
  );
  assert.equal(
    accountAddress,
    await read('BunkRecoveryFactory', factoryAddress, 'predictAccount', [
      bootstrap.address,
      accountIndex,
    ]),
  );
  const configHash = await read('BunkRecoveryFactory', factoryAddress, 'configHash');
  const digest = hashTypedData({
    domain: {
      name: 'HoneyBunkDeployment',
      version: '2',
      chainId: 1337,
      verifyingContract: factoryAddress,
    },
    primaryType: 'BunkDeployment',
    types: {
      BunkDeployment: [
        { name: 'identity', type: 'address' },
        { name: 'accountIndex', type: 'uint32' },
        { name: 'account', type: 'address' },
        { name: 'commitment', type: 'bytes32' },
        { name: 'configHash', type: 'bytes32' },
      ],
    },
    message: {
      identity: bootstrap.address,
      accountIndex,
      account: accountAddress,
      commitment,
      configHash,
    },
  });
  assert.equal(
    digest,
    await read('BunkRecoveryFactory', factoryAddress, 'deploymentDigest', [
      bootstrap.address,
      accountIndex,
      commitment,
    ]),
  );
  const factoryData = encodeFunctionData({
    abi: artifact('BunkRecoveryFactory').abi,
    functionName: 'deploy',
    args: [bootstrap.address, accountIndex, commitment, await bootstrap.sign({ hash: digest })],
  });
  return {
    account: accountAddress,
    initCode: concatHex([factoryAddress, factoryData]),
    configHash,
  };
}
const initial = await deployment(factory, keccak256(owner.address));
const account = initial.account;
const ownerState = () => read('BunkRecoveryModule', module, 'ownerState', [account]);
async function checkSafe() {
  assert.equal(await read('Safe', account, 'VERSION'), '1.4.1');
  assert.deepEqual(await read('Safe', account, 'getOwners'), [module]);
  assert.equal(await read('Safe', account, 'getThreshold'), 1n);
  assert.deepEqual(
    await read('Safe', account, 'getModulesPaginated', [
      '0x0000000000000000000000000000000000000001',
      2n,
    ]),
    [[module], '0x0000000000000000000000000000000000000001'],
  );
  for (const [slot, address] of [
    [0n, s.singleton],
    [0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n, module],
    [0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n, zeroAddress],
  ])
    assert.equal(
      await read('Safe', account, 'getStorageAt', [slot, 1n]),
      toHex(BigInt(address), { size: 32 }),
    );
  assert.equal(
    keccak256(await client.getCode({ address: account })),
    keccak256(artifact('SafeProxy').deployedBytecode.object),
  );
}

const certificateFields = [
  ['entryPoint', 'address'],
  ['account', 'address'],
  ['nonce', 'uint256'],
  ['callDataHash', 'bytes32'],
  ['accountGasLimits', 'bytes32'],
  ['preVerificationGas', 'uint256'],
  ['maxGasCost', 'uint128'],
  ['paymaster', 'address'],
  ['ownerIndex', 'uint32'],
  ['nextCommitment', 'bytes32'],
  ['envelopeRoot', 'bytes32'],
  ['validAfter', 'uint48'],
  ['executeUntil', 'uint48'],
];
function treeFor(base) {
  const keys = Array.from({ length: 256 }, (_, i) => key(base + i));
  const tree = new Array(511);
  for (let i = 0; i < 256; i++)
    tree[255 + i] = keccak256(
      keccak256(encodeAbiParameters(parseAbiParameters('uint8,address'), [i, keys[i].address])),
    );
  for (let i = 254; i >= 0; i--)
    tree[i] = keccak256(concatHex([tree[2 * i + 1], tree[2 * i + 2]].sort()));
  return {
    root: tree[0],
    keys,
    proof(attempt) {
      const proof = [];
      let index = 255 + attempt;
      while (index > 0) {
        proof.push(tree[index % 2 === 1 ? index + 1 : index - 1]);
        index = Math.floor((index - 1) / 2);
      }
      return proof;
    },
  };
}
const envelopeSet = treeFor(1000);
const usedEnvelopeKeys = new Set();
const envelopeAllocations = [];
const authorizationAbi = parseAbiParameters(
  `((${certificateFields.map(([name, type]) => `${type} ${name}`).join(',')}) certificate,uint8 attempt,bytes32[] proof,bytes ownerSignature,bytes envelopeSignature)`,
);
const sponsorAbi = parseAbiParameters(
  '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
);
const base = {
  sender: account,
  nonce: 0n,
  initCode: initial.initCode,
  callData: concatHex([
    toFunctionSelector(
      'executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)',
    ),
    encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'), [
      [
        {
          target,
          value: 0n,
          data: encodeFunctionData({
            abi: artifact('Target', 'BunkIntegration.t').abi,
            functionName: 'set',
            args: [42n],
          }),
        },
      ],
    ]),
  ]),
  accountGasLimits: concatHex([toHex(500000n, { size: 16 }), toHex(500000n, { size: 16 })]),
  preVerificationGas: 100000n,
  gasFees: concatHex([toHex(1000000000n, { size: 16 }), toHex(2000000000n, { size: 16 })]),
  paymasterAndData: '0x',
  signature: '0x',
};
const now = Number((await client.getBlock()).timestamp);
const certificate = {
  entryPoint: s.entryPoint,
  account,
  nonce: 0n,
  callDataHash: keccak256(base.callData),
  accountGasLimits: base.accountGasLimits,
  preVerificationGas: base.preVerificationGas,
  maxGasCost: parseEther('0.01'),
  paymaster,
  ownerIndex: 0,
  nextCommitment: keccak256(next.address),
  envelopeRoot: envelopeSet.root,
  validAfter: now - 10,
  executeUntil: now + 5,
};
let ownerSignatureCountForExpiredIntent = 0;
const ownerSignatureCounts = new Map();
async function certify(c, signer, verifyingContract = module) {
  ownerSignatureCounts.set(signer.address, (ownerSignatureCounts.get(signer.address) ?? 0) + 1);
  assert.equal(ownerSignatureCounts.get(signer.address), 1, 'owner signed two intents');
  if (signer.address === owner.address) ownerSignatureCountForExpiredIntent++;
  const digest = hashTypedData({
    domain: {
      name: 'HoneyBunkOwner',
      version: '2',
      chainId: 1337,
      verifyingContract,
    },
    types: { BunkOwnerIntent: certificateFields.map(([name, type]) => ({ name, type })) },
    primaryType: 'BunkOwnerIntent',
    message: c,
  });
  assert.equal(
    digest,
    await read('BunkRecoveryModule', verifyingContract, 'certificateDigest', [c]),
  );
  return { digest, signature: await signer.sign({ hash: digest }) };
}
// Exactly one owner authorization. The object/signature below is reused after expiry.
const approval = await certify(certificate, owner);
async function sponsored(op, nonce, validAfter, validUntil, sponsorAddress = paymaster) {
  const out = {
    ...op,
    paymasterAndData: concatHex([
      sponsorAddress,
      toHex(200000n, { size: 16 }),
      toHex(0n, { size: 16 }),
    ]),
  };
  const grant = {
    validAfter,
    validUntil,
    maxCost: parseEther('0.01'),
    nonce,
    epoch: 0n,
    signature: '0x',
  };
  const digest = await read('BunkPaymaster', sponsorAddress, 'sponsorshipDigest', [out, grant]);
  grant.signature = await sponsor.sign({ hash: digest });
  out.paymasterAndData = concatHex([
    out.paymasterAndData,
    encodeAbiParameters(sponsorAbi, [grant]),
  ]);
  return out;
}
async function wrap(op, c, ownerSignature, set = envelopeSet, attempt = 0) {
  const signer = set.keys[attempt];
  assert(!usedEnvelopeKeys.has(signer.address), 'one-time envelope key reused');
  usedEnvelopeKeys.add(signer.address);
  envelopeAllocations.push({ root: set.root, attempt, signer: signer.address });
  const hash = await read('EntryPoint', s.entryPoint, 'getUserOpHash', [op]);
  return {
    ...op,
    signature: encodeAbiParameters(authorizationAbi, [
      {
        certificate: c,
        attempt,
        proof: set.proof(attempt),
        ownerSignature,
        envelopeSignature: await signer.sign({ hash }),
      },
    ]),
  };
}
function rpcOp(op) {
  const unpack = {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    verificationGasLimit: toHex(BigInt(op.accountGasLimits.slice(0, 34))),
    callGasLimit: toHex(BigInt(`0x${op.accountGasLimits.slice(34)}`)),
    preVerificationGas: toHex(op.preVerificationGas),
    maxPriorityFeePerGas: toHex(BigInt(op.gasFees.slice(0, 34))),
    maxFeePerGas: toHex(BigInt(`0x${op.gasFees.slice(34)}`)),
    signature: op.signature,
  };
  if (op.initCode !== '0x')
    Object.assign(unpack, {
      factory: op.initCode.slice(0, 42),
      factoryData: `0x${op.initCode.slice(42)}`,
    });
  if (op.paymasterAndData !== '0x')
    Object.assign(unpack, {
      paymaster: op.paymasterAndData.slice(0, 42),
      paymasterVerificationGasLimit: toHex(200000n),
      paymasterPostOpGasLimit: '0x0',
      paymasterData: `0x${op.paymasterAndData.slice(106)}`,
    });
  return unpack;
}
async function rejected(op, pattern) {
  let failure;
  try {
    await bundler.request({ method: 'eth_sendUserOperation', params: [rpcOp(op), s.entryPoint] });
  } catch (e) {
    failure = [e.shortMessage, e.details, e.cause?.message].filter(Boolean).join(' ');
  }
  assert(failure, 'experimental invalid operation was accepted');
  assert.match(failure, pattern);
  assert.equal((await ownerState())[1], 0);
  return failure;
}
async function send(op, event) {
  const hash = await bundler.request({
    method: 'eth_sendUserOperation',
    params: [rpcOp(op), s.entryPoint],
  });
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = await bundler.request({ method: 'eth_getUserOperationReceipt', params: [hash] });
    if (receipt) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(receipt, 'experimental receipt missing');
  assert.equal(receipt.success, true);
  assert.equal(
    hash.toLowerCase(),
    (await read('EntryPoint', s.entryPoint, 'getUserOpHash', [op])).toLowerCase(),
  );
  const eventHash = keccak256(toHex(`${event}(address,bytes32)`));
  const logs = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === module.toLowerCase() &&
      l.topics[0] === eventHash &&
      l.topics[1] === toHex(BigInt(account), { size: 32 }) &&
      l.topics[2] === hash,
  );
  assert.equal(logs.length, 1, 'wrong action outcome');
  return { hash, transactionHash: receipt.receipt.transactionHash, event };
}
const unstakedFactory = await deploy('BunkRecoveryFactory', [
  s.singleton,
  s.proxyFactory,
  s.entryPoint,
  admin.address,
]);
const unstakedModule = await read('BunkRecoveryFactory', unstakedFactory, 'module');
const unstakedPaymaster = await deploy('BunkPaymaster', [
  s.entryPoint,
  unstakedModule,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkPaymaster', unstakedPaymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', unstakedPaymaster, 'deposit', [], parseEther('1'));
await write('BunkPaymaster', unstakedPaymaster, 'setBudget', [parseEther('1')]);
const unstakedInitial = await deployment(unstakedFactory, keccak256(key(16).address));
const unstakedTree = treeFor(4000);
const unstakedTime = Number((await client.getBlock()).timestamp);
const unstakedCertificate = {
  ...certificate,
  account: unstakedInitial.account,
  envelopeRoot: unstakedTree.root,
  paymaster: unstakedPaymaster,
  nextCommitment: keccak256(key(17).address),
  validAfter: unstakedTime - 10,
  executeUntil: unstakedTime + 1200,
};
const unstakedApproval = await certify(unstakedCertificate, key(16), unstakedModule);
const unstakedOp = await wrap(
  await sponsored(
    { ...base, sender: unstakedInitial.account, initCode: unstakedInitial.initCode },
    1n,
    unstakedTime - 10,
    unstakedTime + 1200,
    unstakedPaymaster,
  ),
  unstakedCertificate,
  unstakedApproval.signature,
  unstakedTree,
);
const unstakedRejection = await rejected(unstakedOp, /unstaked factory/i);
assert.equal(await client.getCode({ address: unstakedInitial.account }), undefined);
const original = await wrap(
  await sponsored(base, 1n, now, now + 5),
  certificate,
  approval.signature,
);
// Wait on actual local-chain time, not a patched timestamp or validator.
for (let i = 0; i < 30; i++) {
  if (Number((await client.getBlock()).timestamp) > certificate.executeUntil + 1) break;
  await new Promise((r) => setTimeout(r, 500));
}
const expiredRejection = await rejected(original, /expir|time|AA32/i);
const renewalTime = Number((await client.getBlock()).timestamp);
const renewed = await wrap(
  await sponsored(base, 2n, renewalTime - 10, renewalTime + 1200),
  certificate,
  approval.signature,
  envelopeSet,
  1,
);
const changedFeeRejection = await rejected(
  {
    ...renewed,
    gasFees: concatHex([toHex(1000000000n, { size: 16 }), toHex(2000000001n, { size: 16 })]),
  },
  /signature|AA24/i,
);
assert.equal(await client.getCode({ address: account }), undefined);
const deploymentGas = await client.estimateGas({
  account: admin.address,
  to: factory,
  data: `0x${initial.initCode.slice(42)}`,
});
const rotation = await send(renewed, 'ExpiredActionSkipped');
await checkSafe();
assert.equal(await client.getBalance({ address: account }), 0n);
base.initCode = '0x';
assert.equal(
  (
    await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: account, value: parseEther('1') }),
    })
  ).status,
  'success',
);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 0n);
assert.equal((await ownerState())[1], 1);
assert.equal((await ownerState())[0], keccak256(next.address));
assert.equal(await read('EntryPoint', s.entryPoint, 'getNonce', [account, 0n]), 1n);
const nextEnvelope = treeFor(2000);
const nextTime = Number((await client.getBlock()).timestamp);
const nextCertificate = {
  ...certificate,
  nonce: 1n,
  ownerIndex: 1,
  nextCommitment: keccak256(key(10).address),
  envelopeRoot: nextEnvelope.root,
  validAfter: nextTime - 10,
  executeUntil: nextTime + 1200,
  paymaster: zeroAddress,
};
const nextApproval = await certify(nextCertificate, next);
const nextOp = await wrap(
  { ...base, nonce: 1n },
  nextCertificate,
  nextApproval.signature,
  nextEnvelope,
);
const acted = await send(nextOp, 'ActionExecuted');
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 42n);
assert.equal((await ownerState())[1], 2);
const recoverySet = treeFor(3000);
const recoveryTime = Number((await client.getBlock()).timestamp);
const recoveryCertificate = {
  ...nextCertificate,
  nonce: 2n,
  ownerIndex: 2,
  nextCommitment: keccak256(key(11).address),
  envelopeRoot: recoverySet.root,
  validAfter: recoveryTime - 10,
  executeUntil: recoveryTime + 4,
};
const recoveryApproval = await certify(recoveryCertificate, key(10));
const recoveryFee = recoveryCertificate.maxGasCost / 1100000n;
const recoveryOp = await wrap(
  {
    ...base,
    nonce: 2n,
    callData: concatHex([
      base.callData.slice(0, 10),
      encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'), [[]]),
    ]),
    gasFees: concatHex([toHex(recoveryFee, { size: 16 }), toHex(recoveryFee, { size: 16 })]),
  },
  recoveryCertificate,
  recoveryApproval.signature,
  recoverySet,
  255,
);
for (let i = 0; i < 40; i++) {
  if (Number((await client.getBlock()).timestamp) > recoveryCertificate.executeUntil + 7) break;
  await new Promise((r) => setTimeout(r, 500));
}
const reserved = await send(recoveryOp, 'ExpiredActionSkipped');
assert.equal((await ownerState())[1], 3);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 42n);
const deposit = await read('EntryPoint', s.entryPoint, 'balanceOf', [account]);
assert(deposit > 0n, 'self-funded operation produced no refund to test');
const balanceBeforeWithdrawal = await client.getBalance({ address: account });
const withdrawalTree = treeFor(5000);
const withdrawalTime = Number((await client.getBlock()).timestamp);
const withdrawalCallData = concatHex([
  base.callData.slice(0, 10),
  encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'), [
    [
      {
        target: s.entryPoint,
        value: 0n,
        data: encodeFunctionData({
          abi: artifact('EntryPoint').abi,
          functionName: 'withdrawTo',
          args: [account, deposit],
        }),
      },
    ],
  ]),
]);
const withdrawalCertificate = {
  ...certificate,
  nonce: 3n,
  ownerIndex: 3,
  nextCommitment: keccak256(key(13).address),
  callDataHash: keccak256(withdrawalCallData),
  envelopeRoot: withdrawalTree.root,
  validAfter: withdrawalTime - 10,
  executeUntil: withdrawalTime + 1200,
};
const withdrawalApproval = await certify(withdrawalCertificate, key(11));
const withdrawalOp = await wrap(
  await sponsored(
    { ...base, nonce: 3n, callData: withdrawalCallData },
    3n,
    withdrawalTime - 10,
    withdrawalTime + 1200,
  ),
  withdrawalCertificate,
  withdrawalApproval.signature,
  withdrawalTree,
);
const withdrawal = await send(withdrawalOp, 'ActionExecuted');
assert.equal(await read('EntryPoint', s.entryPoint, 'balanceOf', [account]), 0n);
assert.equal(await client.getBalance({ address: account }), balanceBeforeWithdrawal + deposit);
assert.equal((await ownerState())[1], 4);
assert.equal((await ownerState())[0], keccak256(key(13).address));
assert.equal(ownerSignatureCountForExpiredIntent, 1);
fs.writeFileSync(
  'safe-recovery-results.json',
  `${JSON.stringify(
    {
      scope:
        'Version 2 real Safe/EntryPoint candidate on local Osaka; no shared-client or production certification',
      factory,
      module,
      helper,
      account,
      configHash: initial.configHash,
      deploymentGas: deploymentGas.toString(),
      unstakedRejection,
      changedFeeRejection,
      ownerSignatureCounts: Object.fromEntries(ownerSignatureCounts),
      ownerSignatureCountForExpiredIntent,
      envelopeAllocations,
      certificateHash: approval.digest,
      ownerSignatureHash: keccak256(approval.signature),
      expiredGrantRejected: expiredRejection,
      cases: [
        rotation,
        acted,
        reserved,
        { ...withdrawal, withdrawnDepositWei: deposit.toString() },
      ],
      proxyCodeHash: keccak256(await client.getCode({ address: account })),
      moduleCodeHash: keccak256(await client.getCode({ address: module })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  'Version 2 Safe recovery passed sponsored creation, tracer controls, expiry cleanup, next-owner action and gas-deposit withdrawal.',
);
