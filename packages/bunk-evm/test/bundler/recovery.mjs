// TEST-ONLY recovery protocol probe, separate from the current Safe/client protocol.
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
  hashTypedData,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
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
  name: 'recovery experiment',
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
const account = await deploy('RecoveryIntentAccount', [s.entryPoint, keccak256(owner.address)]);
const target = await deploy('Target', [], 'BunkIntegration.t');
const paymaster = await deploy('BunkPaymaster', [
  s.entryPoint,
  account,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkPaymaster', paymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'deposit', [], parseEther('1'));
await write('BunkPaymaster', paymaster, 'setBudget', [parseEther('1')]);
assert.equal(
  (
    await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: account, value: parseEther('1') }),
    })
  ).status,
  'success',
);

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
  initCode: '0x',
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
async function certify(c, signer) {
  if (signer.address === owner.address) ownerSignatureCountForExpiredIntent++;
  const digest = hashTypedData({
    domain: {
      name: 'HoneyBunkRecoveryExperiment',
      version: '0',
      chainId: 1337,
      verifyingContract: account,
    },
    types: { RecoveryCertificate: certificateFields.map(([name, type]) => ({ name, type })) },
    primaryType: 'RecoveryCertificate',
    message: c,
  });
  assert.equal(digest, await read('RecoveryIntentAccount', account, 'certificateDigest', [c]));
  return { digest, signature: await signer.sign({ hash: digest }) };
}
// Exactly one owner authorization. The object/signature below is reused after expiry.
const approval = await certify(certificate, owner);
async function sponsored(op, nonce, validAfter, validUntil) {
  const out = {
    ...op,
    paymasterAndData: concatHex([paymaster, toHex(200000n, { size: 16 }), toHex(0n, { size: 16 })]),
  };
  const grant = {
    validAfter,
    validUntil,
    maxCost: parseEther('0.01'),
    nonce,
    epoch: 0n,
    signature: '0x',
  };
  const digest = await read('BunkPaymaster', paymaster, 'sponsorshipDigest', [out, grant]);
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
  if (op.paymasterAndData !== '0x')
    Object.assign(unpack, {
      paymaster,
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
  assert.equal(await read('RecoveryIntentAccount', account, 'ownerIndex'), 0);
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
  const eventHash = keccak256(toHex(`${event}(bytes32)`));
  const logs = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === account.toLowerCase() &&
      l.topics[0] === eventHash &&
      l.topics[1] === hash,
  );
  assert.equal(logs.length, 1, 'wrong action outcome');
  return { hash, transactionHash: receipt.receipt.transactionHash, event };
}
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
const rotation = await send(renewed, 'ExpiredActionSkipped');
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 0n);
assert.equal(await read('RecoveryIntentAccount', account, 'ownerIndex'), 1);
assert.equal(await read('RecoveryIntentAccount', account, 'commitment'), keccak256(next.address));
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
assert.equal(await read('RecoveryIntentAccount', account, 'ownerIndex'), 2);
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
assert.equal(await read('RecoveryIntentAccount', account, 'ownerIndex'), 3);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 42n);
assert.equal(ownerSignatureCountForExpiredIntent, 1);
fs.writeFileSync(
  'recovery-results.json',
  `${JSON.stringify(
    {
      scope: 'Test-only standalone account, not Safe integration or production acceptance',
      ownerSignatureCountForExpiredIntent,
      envelopeAllocations,
      certificateHash: approval.digest,
      ownerSignatureHash: keccak256(approval.signature),
      expiredGrantRejected: expiredRejection,
      cases: [rotation, acted, reserved],
      codeHash: keccak256(await client.getCode({ address: account })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  'Experimental scoped recovery passed real bundler admission, expiry cleanup and next-owner action.',
);
