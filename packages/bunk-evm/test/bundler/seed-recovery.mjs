// Version 3 independent seed-recovery authority probe. Public scalar fixtures only; seed client/restore integration remains separate.
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
  return receipt;
}
const bootstrap = key(12);
const recoveryKey = key(18),
  recoveryNext = key(19),
  generationOwner = key(20),
  generationNext = key(21);
const factory = await deploy('BunkSeedRecoveryFactory', [
  s.singleton,
  s.proxyFactory,
  s.entryPoint,
  admin.address,
]);
const module = await read('BunkSeedRecoveryFactory', factory, 'module');
const helper = await read('BunkSeedRecoveryFactory', factory, 'helper');
const target = await deploy('Target', [], 'BunkIntegration.t');
const paymaster = await deploy('BunkPaymaster', [
  s.entryPoint,
  module,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkSeedRecoveryFactory', factory, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'deposit', [], parseEther('1'));
await write('BunkPaymaster', paymaster, 'setBudget', [parseEther('1')]);
async function deployment(factoryAddress, commitment, accountIndex = 0) {
  const recoveryCommitment = keccak256(recoveryKey.address);
  const initializer = await read('BunkSeedRecoveryFactory', factoryAddress, 'initializer');
  const proxyCreationCode = await read('SafeProxyFactory', s.proxyFactory, 'proxyCreationCode');
  const nonce = keccak256(
    encodeAbiParameters(parseAbiParameters('string,address,uint32'), [
      'HoneyBunkAccountV3',
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
    await read('BunkSeedRecoveryFactory', factoryAddress, 'predictAccount', [
      bootstrap.address,
      accountIndex,
    ]),
  );
  const configHash = await read('BunkSeedRecoveryFactory', factoryAddress, 'configHash');
  const digest = hashTypedData({
    domain: {
      name: 'HoneyBunkDeployment',
      version: '3',
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
        { name: 'recoveryCommitment', type: 'bytes32' },
        { name: 'configHash', type: 'bytes32' },
      ],
    },
    message: {
      identity: bootstrap.address,
      accountIndex,
      account: accountAddress,
      commitment,
      recoveryCommitment,
      configHash,
    },
  });
  assert.equal(
    digest,
    await read('BunkSeedRecoveryFactory', factoryAddress, 'deploymentDigest', [
      bootstrap.address,
      accountIndex,
      commitment,
      recoveryCommitment,
    ]),
  );
  const factoryData = encodeFunctionData({
    abi: artifact('BunkSeedRecoveryFactory').abi,
    functionName: 'deploy',
    args: [
      bootstrap.address,
      accountIndex,
      commitment,
      recoveryCommitment,
      await bootstrap.sign({ hash: digest }),
    ],
  });
  return {
    account: accountAddress,
    initCode: concatHex([factoryAddress, factoryData]),
    configHash,
  };
}
const initial = await deployment(factory, keccak256(owner.address));
const account = initial.account;
const ownerState = () => read('BunkSeedRecoveryModule', module, 'ownerState', [account]);
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
  executeUntil: now + 1200,
};
const ownerSignatureCounts = new Map();
async function certify(c, signer, verifyingContract = module) {
  ownerSignatureCounts.set(signer.address, (ownerSignatureCounts.get(signer.address) ?? 0) + 1);
  assert.equal(ownerSignatureCounts.get(signer.address), 1, 'owner signed two intents');
  const digest = hashTypedData({
    domain: {
      name: 'HoneyBunkOwner',
      version: '3',
      chainId: 1337,
      verifyingContract,
    },
    types: { BunkOwnerIntent: certificateFields.map(([name, type]) => ({ name, type })) },
    primaryType: 'BunkOwnerIntent',
    message: c,
  });
  assert.equal(
    digest,
    await read('BunkSeedRecoveryModule', verifyingContract, 'certificateDigest', [c]),
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
const unstakedFactory = await deploy('BunkSeedRecoveryFactory', [
  s.singleton,
  s.proxyFactory,
  s.entryPoint,
  admin.address,
]);
const unstakedModule = await read('BunkSeedRecoveryFactory', unstakedFactory, 'module');
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

const recoveryMessage = {
  entryPoint: s.entryPoint,
  account,
  epoch: 0,
  nextOwnerCommitment: keccak256(generationOwner.address),
  nextRecoveryCommitment: keccak256(recoveryNext.address),
};
const recoveryDigest = hashTypedData({
  domain: { name: 'HoneyBunkOwner', version: '3', chainId: 1337, verifyingContract: module },
  primaryType: 'BunkSeedRecovery',
  types: {
    BunkSeedRecovery: [
      { name: 'entryPoint', type: 'address' },
      { name: 'account', type: 'address' },
      { name: 'epoch', type: 'uint32' },
      { name: 'nextOwnerCommitment', type: 'bytes32' },
      { name: 'nextRecoveryCommitment', type: 'bytes32' },
    ],
  },
  message: recoveryMessage,
});
const recoveryArgs = [
  account,
  0,
  recoveryMessage.nextOwnerCommitment,
  recoveryMessage.nextRecoveryCommitment,
];
assert.equal(
  recoveryDigest,
  await read('BunkSeedRecoveryModule', module, 'seedRecoveryDigest', recoveryArgs),
);
// Fixed certificate signed before ordinary owner/nonce advancement. No lost intent
// data, owner key, fee/grant, timestamp, or EntryPoint nonce is part of this message.
const recoverySignature = await recoveryKey.sign({ hash: recoveryDigest });
const recoverRequest = {
  account: admin.address,
  address: module,
  abi: artifact('BunkSeedRecoveryModule').abi,
  functionName: 'recoverFromSeed',
  args: [...recoveryArgs, recoverySignature],
};
await assert.rejects(client.simulateContract(recoverRequest)); // No bootstrap bypass.
const original = await wrap(
  await sponsored(base, 1n, now - 10, now + 1200),
  certificate,
  approval.signature,
);
const deploymentGas = await client.estimateGas({
  account: admin.address,
  to: factory,
  data: `0x${initial.initCode.slice(42)}`,
});
const created = await send(original, 'ActionExecuted');
await checkSafe();
assert.deepEqual(await ownerState(), [keccak256(next.address), 1]);
assert.deepEqual(await read('BunkSeedRecoveryModule', module, 'recoveryState', [account]), [
  keccak256(recoveryKey.address),
  0,
]);
assert.equal(await read('EntryPoint', s.entryPoint, 'getNonce', [account, 0n]), 1n);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 42n);
base.initCode = '0x';
base.nonce = 1n;
const pendingTree = treeFor(5000);
const pendingCertificate = {
  ...certificate,
  nonce: 1n,
  ownerIndex: 1,
  nextCommitment: keccak256(key(9).address),
  envelopeRoot: pendingTree.root,
};
const pendingApproval = await certify(pendingCertificate, next);
const dropped = await wrap(
  await sponsored(base, 2n, now - 10, now + 1200),
  pendingCertificate,
  pendingApproval.signature,
  pendingTree,
);
assert.equal(
  (
    await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: account, value: parseEther('1') }),
    })
  ).status,
  'success',
);
await write('EntryPoint', s.entryPoint, 'depositTo', [account], parseEther('0.5'));
const balanceBefore = await client.getBalance({ address: account });
const depositBefore = await read('EntryPoint', s.entryPoint, 'balanceOf', [account]);
await assert.rejects(
  client.simulateContract({
    ...recoverRequest,
    args: [
      account,
      0,
      keccak256(key(22).address),
      recoveryMessage.nextRecoveryCommitment,
      recoverySignature,
    ],
  }),
);
const reset = await write('BunkSeedRecoveryModule', module, 'recoverFromSeed', recoverRequest.args);
assert.deepEqual(await ownerState(), [keccak256(generationOwner.address), 0]);
assert.deepEqual(await read('BunkSeedRecoveryModule', module, 'recoveryState', [account]), [
  keccak256(recoveryNext.address),
  1,
]);
assert.equal(await read('EntryPoint', s.entryPoint, 'getNonce', [account, 0n]), 1n);
assert.equal(await client.getBalance({ address: account }), balanceBefore);
assert.equal(await read('EntryPoint', s.entryPoint, 'balanceOf', [account]), depositBefore);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 42n);
await assert.rejects(client.simulateContract(recoverRequest)); // Consumed recovery key/certificate.
const staleRejection = await rejected(dropped, /signature|AA24/i);
const freshTree = treeFor(6000);
const freshCertificate = {
  ...certificate,
  nonce: 1n,
  ownerIndex: 0,
  nextCommitment: keccak256(generationNext.address),
  envelopeRoot: freshTree.root,
};
const freshApproval = await certify(freshCertificate, generationOwner);
const fresh = await wrap(
  await sponsored(base, 3n, now - 10, now + 1200),
  freshCertificate,
  freshApproval.signature,
  freshTree,
);
const resumed = await send(fresh, 'ActionExecuted');
await checkSafe();
assert.deepEqual(await ownerState(), [keccak256(generationNext.address), 1]);
assert.equal(await read('EntryPoint', s.entryPoint, 'getNonce', [account, 0n]), 2n);
const lastReceipt = await client.getTransactionReceipt({ hash: resumed.transactionHash });
let finalized;
for (let i = 0; i < 180; i++) {
  finalized = await client.getBlock({ blockTag: 'finalized' });
  if (finalized.number >= lastReceipt.blockNumber) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(finalized.number >= lastReceipt.blockNumber, 'missing seed recovery local finality');
const finalOwner = await client.readContract({
  address: module,
  abi: artifact('BunkSeedRecoveryModule').abi,
  functionName: 'ownerState',
  args: [account],
  blockNumber: finalized.number,
});
const finalRecovery = await client.readContract({
  address: module,
  abi: artifact('BunkSeedRecoveryModule').abi,
  functionName: 'recoveryState',
  args: [account],
  blockNumber: finalized.number,
});
assert.deepEqual(finalOwner, [keccak256(generationNext.address), 1]);
assert.deepEqual(finalRecovery, [keccak256(recoveryNext.address), 1]);
assert.equal((await client.getBlock({ blockNumber: finalized.number })).hash, finalized.hash);
fs.writeFileSync(
  'seed-recovery-results.json',
  JSON.stringify(
    {
      scope:
        'V3 Safe independent seed-recovery authority with public scalar fixtures; no seed client, app restore or production certification',
      factory,
      module,
      helper,
      account,
      deploymentGas,
      transientBootstrap: true,
      verificationGasLimit: 500000,
      unstakedRejection,
      staleRejection,
      recoverySignatureCount: 1,
      recoveryDigest,
      recoveryTransactionHash: reset.transactionHash,
      resetMovedWalletFunds: false,
      resetChangedEntryPointNonce: false,
      distinctOwnerSignatures: Object.fromEntries(ownerSignatureCounts),
      finalized: {
        number: finalized.number,
        hash: finalized.hash,
        owner: finalOwner,
        recovery: finalRecovery,
      },
      cases: [created, resumed],
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
console.log(
  'V3 Safe seed-recovery authority passed transient-bootstrap bundler creation, independent reset, stale-operation rejection and new-generation action.',
);
