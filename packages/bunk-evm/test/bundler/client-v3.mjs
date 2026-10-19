// Public phrase fixtures only. Test harness, not an application signing coordinator.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  concatHex,
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
import { bunkEvmSponsorshipDigest } from '../../../keyring/src/bunk-evm.ts';
import { observeBunkEvmV3Account } from '../../../keyring/src/bunk-evm-observe.ts';
import { bunkEvmV3KeyScope, encodeBunkEvmV3Calls } from '../../../keyring/src/bunk-evm-v3.ts';
import {
  prepareBunkEvmV3Envelope,
  prepareBunkEvmV3Intent,
  signBunkEvmV3Deployment,
  signBunkEvmV3Envelope,
  signBunkEvmV3Intent,
} from '../../../keyring/src/bunk-evm-v3-sign.ts';
import { mnemonicToSeed } from '../../../keyring/src/index.ts';

const s = JSON.parse(fs.readFileSync('state.json'));
const prior = JSON.parse(fs.readFileSync('seed-recovery-results.json'));
assert.match(s.rpc, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(process.env.BUNK_BUNDLER_RPC ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifact = (name, file = name) =>
  JSON.parse(fs.readFileSync(`${root}/out/${file}.sol/${name}.json`));
const chain = defineChain({
  id: 1337,
  name: 'Bunk v3 client local',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [s.rpc] } },
});
const client = createPublicClient({ chain, transport: http(s.rpc), pollingInterval: 300 });
const bundler = createPublicClient({ transport: http(process.env.BUNK_BUNDLER_RPC) });
const admin = privateKeyToAccount(toHex(1n, { size: 32 })),
  sponsorKey = privateKeyToAccount(toHex(4n, { size: 32 }));
const wallet = createWalletClient({ account: admin, chain, transport: http(s.rpc) });
const read = (name, address, functionName, args = [], file = name) =>
  client.readContract({ address, abi: artifact(name, file).abi, functionName, args });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function receipt(hash) {
  const r = await client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
}
async function deploy(name, args = [], file = name) {
  const a = artifact(name, file);
  return (
    await receipt(
      await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 8000000n }),
    )
  ).contractAddress;
}
async function write(name, address, functionName, args, value = 0n) {
  return receipt(
    await wallet.writeContract({
      address,
      abi: artifact(name).abi,
      functionName,
      args,
      value,
      gas: 2000000n,
    }),
  );
}
const target = await deploy('Target', [], 'BunkIntegration.t');
const paymaster = await deploy('BunkPaymaster', [
  s.entryPoint,
  prior.module,
  sponsorKey.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkPaymaster', paymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'deposit', [], parseEther('1'));
await write('BunkPaymaster', paymaster, 'setBudget', [parseEther('1')]);
const identities = {};
for (const [name, address] of Object.entries({
  factory: prior.factory,
  singleton: s.singleton,
  proxyFactory: s.proxyFactory,
  entryPoint: s.entryPoint,
  module: prior.module,
  helper: prior.helper,
}))
  identities[name] = { address, codeHash: keccak256(await client.getCode({ address })) };
const config = {
  ...identities,
  protocolVersion: 3,
  chainId: '1337',
  proxyCreationCode: await read('SafeProxyFactory', s.proxyFactory, 'proxyCreationCode'),
};
const fixture = JSON.parse(
  fs.readFileSync(new URL('../../../keyring/src/fixtures/bunk-evm-v3.json', import.meta.url)),
);
let seed = await mnemonicToSeed(fixture.phrase);
const accountIndex = 3;
const deployment = signBunkEvmV3Deployment(seed, config, accountIndex);
const account = deployment.account;
assert.equal(
  await read('BunkSeedRecoveryFactory', prior.factory, 'deploymentDigest', [
    deployment.identity.address,
    accountIndex,
    deployment.firstOwner.commitment,
    deployment.firstRecovery.commitment,
  ]),
  deployment.digest,
);
assert.equal(
  await read('BunkSeedRecoveryFactory', prior.factory, 'predictAccount', [
    deployment.identity.address,
    accountIndex,
  ]),
  account,
);
const observationRequest = {
  config,
  proxyRuntimeCodeHash: keccak256(artifact('SafeProxy').deployedBytecode.object),
  deploymentIdentity: deployment.identity.address,
  accountIndex,
  maxFinalizedAgeSeconds: 120,
};
const observe = () =>
  observeBunkEvmV3Account((r) => client.request(r), {
    ...observationRequest,
    now: () => Math.floor(Date.now() / 1000),
  });
async function finalize(number) {
  for (let i = 0; i < 180; i++) {
    if ((await client.getBlock({ blockTag: 'finalized' })).number >= number) return;
    await wait(500);
  }
  throw Error('Missing local finality');
}
await finalize((await client.getBlock()).number);
assert.equal((await observe()).status, 'undeployed');
const initialState = {
  protocolVersion: 3,
  deployed: false,
  account,
  accountIndex,
  ownerIndex: 0,
  commitment: deployment.firstOwner.commitment,
  nonce: 0n,
  epoch: 0,
  recoveryCommitment: deployment.firstRecovery.commitment,
};
const sponsor = {
  paymaster: {
    address: paymaster,
    codeHash: keccak256(await client.getCode({ address: paymaster })),
  },
  signer: sponsorKey.address,
  epoch: 0n,
  maxCostPerOperation: parseEther('0.1'),
};
const sponsorAbi = parseAbiParameters(
  '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
);
const signedPaths = new Set();
// Small test-only write-ahead fixture. Duplicate paths fail before signing.
// Application restore/journal coordination is deliberately outside this probe.
function reserve(path, digest) {
  assert(!signedPaths.has(path), 'Test reused a signing key');
  const fd = fs.openSync('client-v3-reservations.jsonl', 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify({ path, digest })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  signedPaths.add(path);
}
async function operation(state, value, sponsorNonce) {
  const now = Number((await client.getBlock()).timestamp);
  const callData = encodeBunkEvmV3Calls(config, account, [
    {
      target,
      value: 0n,
      data: encodeFunctionData({
        abi: artifact('Target', 'BunkIntegration.t').abi,
        functionName: 'set',
        args: [value],
      }),
    },
  ]);
  const request = {
    config,
    state,
    callData,
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maximumGasCost: parseEther('0.011'),
    paymaster,
    validAfter: now - 10,
    executeUntil: now + 1200,
  };
  const prepared = prepareBunkEvmV3Intent(seed, request);
  reserve(prepared.currentOwner.path, prepared.digest);
  const signed = signBunkEvmV3Intent(seed, request);
  assert.equal(
    await read('BunkSeedRecoveryModule', prior.module, 'certificateDigest', [signed.certificate]),
    signed.digest,
  );
  const op = {
    sender: account,
    nonce: state.nonce,
    initCode: state.deployed ? '0x' : concatHex([prior.factory, deployment.factoryData]),
    callData,
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maxPriorityFeePerGas: 1000000000n,
    maxFeePerGas: 2000000000n,
    paymasterAndData: '0x',
  };
  const grant = {
    validAfter: now - 10,
    validUntil: now + 1200,
    maxCost: parseEther('0.01'),
    nonce: sponsorNonce,
    epoch: 0n,
    signature: toHex(new Uint8Array(65)),
  };
  const grantData = () =>
    concatHex([
      paymaster,
      toHex(200000n, { size: 16 }),
      toHex(0n, { size: 16 }),
      encodeAbiParameters(sponsorAbi, [grant]),
    ]);
  op.paymasterAndData = grantData();
  grant.signature = await sponsorKey.sign({ hash: bunkEvmSponsorshipDigest(config, op, grant) });
  op.paymasterAndData = grantData();
  const envelope = {
    config,
    state,
    intent: signed.intent,
    operation: op,
    attempt: 0,
    proof: signed.envelopes.proofs[0],
    purpose: 'action',
    now,
    sponsor,
  };
  const preparedEnvelope = prepareBunkEvmV3Envelope(seed, envelope);
  reserve(preparedEnvelope.envelopePath, preparedEnvelope.userOpHash);
  return signBunkEvmV3Envelope(seed, envelope);
}
function rpcOp(p) {
  const out = {
    sender: p.sender,
    nonce: toHex(p.nonce),
    callData: p.callData,
    verificationGasLimit: toHex(BigInt(p.accountGasLimits.slice(0, 34))),
    callGasLimit: toHex(BigInt(`0x${p.accountGasLimits.slice(34)}`)),
    preVerificationGas: toHex(p.preVerificationGas),
    maxPriorityFeePerGas: toHex(BigInt(p.gasFees.slice(0, 34))),
    maxFeePerGas: toHex(BigInt(`0x${p.gasFees.slice(34)}`)),
    signature: p.signature,
  };
  if (p.initCode !== '0x')
    Object.assign(out, {
      factory: p.initCode.slice(0, 42),
      factoryData: `0x${p.initCode.slice(42)}`,
    });
  if (p.paymasterAndData !== '0x')
    Object.assign(out, {
      paymaster: p.paymasterAndData.slice(0, 42),
      paymasterVerificationGasLimit: '0x30d40',
      paymasterPostOpGasLimit: '0x0',
      paymasterData: `0x${p.paymasterAndData.slice(106)}`,
    });
  return out;
}
async function send(signedOp, event) {
  assert.equal(
    await read('EntryPoint', s.entryPoint, 'getUserOpHash', [signedOp.operation]),
    signedOp.userOpHash,
  );
  const hash = await bundler.request({
    method: 'eth_sendUserOperation',
    params: [rpcOp(signedOp.operation), s.entryPoint],
  });
  assert.equal(hash, signedOp.userOpHash);
  let r;
  for (let i = 0; i < 100; i++) {
    r = await bundler.request({ method: 'eth_getUserOperationReceipt', params: [hash] });
    if (r) break;
    await wait(500);
  }
  assert(r);
  assert.equal(r.success, true);
  assert.equal(
    r.logs.filter(
      (l) =>
        l.address.toLowerCase() === prior.module.toLowerCase() &&
        l.topics[0] === keccak256(toHex(`${event}(address,bytes32)`)) &&
        l.topics[1] === toHex(BigInt(account), { size: 32 }) &&
        l.topics[2] === hash,
    ).length,
    1,
  );
  await finalize(BigInt(r.receipt.blockNumber));
  const observation = await observe();
  assert.equal(observation.status, 'deployed');
  return { hash, transactionHash: r.receipt.transactionHash, event, observation };
}
const created = await send(await operation(initialState, 81n, 0n), 'ActionExecuted');
assert.equal(created.observation.state.epoch, 0);
assert.equal(created.observation.state.ownerIndex, 1);
assert.equal(created.observation.state.nonce, 1n);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 81n);
// This complete but unsubmitted approval is deliberately absent from restore inputs.
const dropped = await operation(created.observation.state, 999n, 1n);
seed.fill(0);
await receipt(await wallet.sendTransaction({ to: account, value: parseEther('1') }));
await write('EntryPoint', s.entryPoint, 'depositTo', [account], parseEther('0.5'));
const balanceBefore = await client.getBalance({ address: account });
const depositBefore = await read('EntryPoint', s.entryPoint, 'balanceOf', [account]);
await finalize((await client.getBlock()).number);
const child = spawnSync(
  process.execPath,
  [
    '--import',
    fileURLToPath(new URL('./typescript-loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./restore-v3.mjs', import.meta.url)),
  ],
  {
    input: JSON.stringify({ rpc: s.rpc, request: observationRequest }),
    encoding: 'utf8',
    timeout: 30000,
  },
);
assert.equal(child.status, 0, child.stderr);
const recovered = JSON.parse(child.stdout);
assert.equal(recovered.observation.state.epoch, 0);
assert.equal(recovered.recovery.epoch, 0);
assert.equal(recovered.transaction.to, prior.module);
assert.equal(recovered.transaction.value, '0');
assert.equal(
  await read('BunkSeedRecoveryModule', prior.module, 'seedRecoveryDigest', [
    account,
    0,
    recovered.nextOwner.commitment,
    recovered.nextRecovery.commitment,
  ]),
  recovered.digest,
);
const reset = await receipt(
  await wallet.sendTransaction({ ...recovered.transaction, value: 0n, gas: 500000n }),
);
await finalize(reset.blockNumber);
const after = await observe();
assert.equal(after.status, 'deployed');
assert.equal(after.state.epoch, 1);
assert.equal(after.state.ownerIndex, 0);
assert.equal(after.state.nonce, 1n);
assert.equal(after.state.commitment, recovered.nextOwner.commitment);
assert.equal(after.state.recoveryCommitment, recovered.nextRecovery.commitment);
assert.equal(await client.getBalance({ address: account }), balanceBefore);
assert.equal(await read('EntryPoint', s.entryPoint, 'balanceOf', [account]), depositBefore);
let staleRejection;
try {
  await bundler.request({
    method: 'eth_sendUserOperation',
    params: [rpcOp(dropped.operation), s.entryPoint],
  });
} catch (e) {
  staleRejection = [e.shortMessage, e.details, e.cause?.message].filter(Boolean).join(' ');
}
assert.match(staleRejection ?? '', /signature|AA24/i);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 81n);
seed = await mnemonicToSeed(fixture.phrase);
const resumed = await send(await operation(after.state, 82n, 2n), 'ActionExecuted');
assert.equal(resumed.observation.state.epoch, 1);
assert.equal(resumed.observation.state.ownerIndex, 1);
assert.equal(resumed.observation.state.nonce, 2n);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 82n);
seed.fill(0);
assert.equal(signedPaths.size, 6); // Three owners, three envelope keys across two generations.
fs.writeFileSync(
  'client-v3-results.json',
  JSON.stringify(
    {
      scope:
        'Actual v3 phrase client and fresh-process recovery using finalized chain state without pending approval/journal; isolated Osaka, not app restore or production certification',
      account,
      accountIndex,
      deploymentIdentity: deployment.identity.address,
      keyScope: bunkEvmV3KeyScope(config),
      recoveryProcessInputs: [
        'public RPC',
        'verified local configuration',
        'deployment identity/account index',
        'public test phrase fixture',
      ],
      recoveryReceivedPendingApproval: false,
      recoveryReceivedJournal: false,
      resetChangedWalletFunds: false,
      resetChangedEntryPointNonce: false,
      ownerAndEnvelopeKeysUsed: signedPaths.size,
      recoveryDigest: recovered.digest,
      recoveryTransactionHash: reset.transactionHash,
      staleRejection,
      cases: [created, { event: 'SeedRecovery', observation: after }, resumed],
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
console.log(
  'V3 phrase client passed sponsored creation, independent fresh-process recovery without pending approval, finalized generation reset, stale-operation rejection and resumed signing.',
);
