// Public test phrase only: exercises the actual v2 keyring and finalized observer.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bunkEvmSponsorshipDigest } from '../../../keyring/src/bunk-evm.ts';
import { observeBunkEvmV2Account } from '../../../keyring/src/bunk-evm-observe.ts';
import {
  bunkEvmV2IntentDigest,
  bunkEvmV2RecoveryCalls,
  bunkEvmV2RecoveryFee,
  encodeBunkEvmV2Calls,
  packBunkEvmV2Operation,
} from '../../../keyring/src/bunk-evm-v2.ts';
import {
  decodeBunkV2Journal,
  readSignedBunkV2Envelope,
  reconstructBunkV2Envelope,
  reconstructBunkV2Intent,
  reserveBunkV2Envelope,
  reserveBunkV2Intent,
  signReservedBunkV2Envelope,
  signReservedBunkV2Intent,
} from '../../../keyring/src/bunk-evm-v2-journal.ts';
import {
  deriveBunkEvmV2Owner,
  signBunkEvmV2Deployment,
} from '../../../keyring/src/bunk-evm-v2-sign.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../../../keyring/src/bunk-evm-v2-store.ts';
import { mnemonicToSeed } from '../../../keyring/src/index.ts';

const s = JSON.parse(fs.readFileSync('state.json'));
const prior = JSON.parse(fs.readFileSync('safe-recovery-results.json'));
assert.match(s.rpc, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(process.env.BUNK_BUNDLER_RPC ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifact = (name, file = name) =>
  JSON.parse(fs.readFileSync(`${root}/out/${file}.sol/${name}.json`));
const chain = defineChain({
  id: 1337,
  name: 'Bunk v2 client local',
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
  protocolVersion: 2,
  chainId: '1337',
  proxyCreationCode: await read('SafeProxyFactory', s.proxyFactory, 'proxyCreationCode'),
};
const fixture = JSON.parse(
  fs.readFileSync(new URL('../../../keyring/src/fixtures/bunk-evm-v2.json', import.meta.url)),
);
const inputHashes = Object.fromEntries(
  ['packages/keyring/src/index.ts', 'packages/keyring/src/fixtures/bunk-evm-v2.json'].map(
    (path) => [
      path,
      createHash('sha256')
        .update(fs.readFileSync(new URL(`../../../../${path}`, import.meta.url)))
        .digest('hex'),
    ],
  ),
);
const seed = await mnemonicToSeed(fixture.phrase);
const journalKey = randomBytes(32);
const databases = [];
async function openJournal() {
  const db = new DatabaseSync('client-journal.sqlite');
  databases.push(db);
  const raw = await createBunkJournalSqliteStore({
    async execAsync(sql) {
      db.exec(sql);
    },
    async getFirstAsync(sql, ...params) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async runAsync(sql, ...params) {
      return { changes: Number(db.prepare(sql).run(...params).changes) };
    },
  });
  return encryptedBunkJournalStore(raw, journalKey, randomBytes);
}
const journal = await openJournal();
let reconstructedOwners = 0,
  reconstructedEnvelopes = 0;
function loseSignatureWrite() {
  let writes = 0;
  return {
    read: (key) => journal.read(key),
    compareAndSwap: (...args) => {
      if (++writes === 2) throw new Error('Injected signature persistence failure');
      return journal.compareAndSwap(...args);
    },
  };
}
async function journalIntent(request, observation) {
  const key = await reserveBunkV2Intent(journal, seed, request, observation);
  let intent;
  if (request.state.ownerIndex === 0) {
    await assert.rejects(signReservedBunkV2Intent(loseSignatureWrite(), seed, key), /Injected/);
    const uncertain = decodeBunkV2Journal((await journal.read(key)).value);
    assert.equal(uncertain.owner.phase, 'signing');
    assert.equal(uncertain.owner.signature, null);
    intent = await reconstructBunkV2Intent(
      journal,
      seed,
      key,
      bunkEvmV2IntentDigest(config, uncertain.certificate),
    );
    reconstructedOwners++;
  } else intent = await signReservedBunkV2Intent(journal, seed, key);
  return {
    key,
    intent,
    digest: bunkEvmV2IntentDigest(config, intent.certificate),
    nextOwner: deriveBunkEvmV2Owner(seed, {
      chainId: config.chainId,
      accountIndex: request.state.accountIndex,
      ownerIndex: request.state.ownerIndex + 1,
    }),
  };
}
async function journalEnvelope(key, request) {
  await reserveBunkV2Envelope(journal, seed, key, request);
  if (request.attempt === 255) {
    await assert.rejects(
      signReservedBunkV2Envelope(
        loseSignatureWrite(),
        seed,
        key,
        request.attempt,
        request.now,
        request.sponsor,
      ),
      /Injected/,
    );
    const uncertain = decodeBunkV2Journal((await journal.read(key)).value).envelopes.find(
      (e) => e.attempt === 255,
    );
    assert.equal(uncertain.phase, 'signing');
    assert.equal(uncertain.signature, null);
    const restored = await reconstructBunkV2Envelope(
      journal,
      seed,
      key,
      255,
      uncertain.userOpHash,
      request.now,
      request.sponsor,
    );
    reconstructedEnvelopes++;
    return restored;
  }
  return signReservedBunkV2Envelope(
    journal,
    seed,
    key,
    request.attempt,
    request.now,
    request.sponsor,
  );
}

const deployment = signBunkEvmV2Deployment(seed, config, 2),
  account = deployment.account;
assert.equal(
  await read('BunkRecoveryFactory', prior.factory, 'deploymentDigest', [
    deployment.identity.address,
    2,
    deployment.firstOwner.commitment,
  ]),
  deployment.digest,
);
assert.equal(
  await read('BunkRecoveryFactory', prior.factory, 'predictAccount', [
    deployment.identity.address,
    2,
  ]),
  account,
);
async function finalize(number) {
  for (let i = 0; i < 180; i++) {
    if ((await client.getBlock({ blockTag: 'finalized' })).number >= number) return;
    await wait(500);
  }
  throw Error('Missing local finality');
}
const observe = () =>
  observeBunkEvmV2Account((r) => client.request(r), {
    config,
    proxyRuntimeCodeHash: prior.proxyCodeHash,
    deploymentIdentity: deployment.identity.address,
    accountIndex: 2,
    now: () => Math.floor(Date.now() / 1000),
    maxFinalizedAgeSeconds: 120,
  });
await finalize((await client.getBlock()).number);
const before = await observe();
assert.equal(before.status, 'undeployed');
const state = {
  protocolVersion: 2,
  deployed: false,
  account,
  accountIndex: 2,
  ownerIndex: 0,
  commitment: deployment.firstOwner.commitment,
  nonce: 0n,
};
const callData = encodeBunkEvmV2Calls(config, account, [
  {
    target,
    value: 0n,
    data: encodeFunctionData({
      abi: artifact('Target', 'BunkIntegration.t').abi,
      functionName: 'set',
      args: [72n],
    }),
  },
]);
const now = Number((await client.getBlock()).timestamp);
const signed = await journalIntent(
  {
    config,
    state,
    callData,
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maximumGasCost: parseEther('0.011'),
    paymaster,
    validAfter: now - 10,
    executeUntil: now + 120,
  },
  before.block,
);
assert.equal(
  await read('BunkRecoveryModule', prior.module, 'certificateDigest', [signed.intent.certificate]),
  signed.digest,
);
const op = {
  sender: account,
  nonce: 0n,
  initCode: concatHex([prior.factory, deployment.factoryData]),
  callData,
  verificationGasLimit: 500000n,
  callGasLimit: 500000n,
  preVerificationGas: 100000n,
  maxPriorityFeePerGas: 1000000000n,
  maxFeePerGas: 2000000000n,
  paymasterAndData: '0x',
};
const sponsorAbi = parseAbiParameters(
  '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
);
const grant = {
  validAfter: now - 10,
  validUntil: now + 300,
  maxCost: parseEther('0.01'),
  nonce: 0n,
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
const sponsorDigest = bunkEvmSponsorshipDigest(config, op, grant);
assert.equal(
  await read('BunkPaymaster', paymaster, 'sponsorshipDigest', [
    { ...packBunkEvmV2Operation(op), signature: '0x' },
    grant,
  ]),
  sponsorDigest,
);
grant.signature = await sponsorKey.sign({ hash: sponsorDigest });
op.paymasterAndData = grantData();
const sponsor = {
  paymaster: {
    address: paymaster,
    codeHash: keccak256(await client.getCode({ address: paymaster })),
  },
  signer: sponsorKey.address,
  epoch: 0n,
  maxCostPerOperation: parseEther('0.1'),
};
const creation = await journalEnvelope(signed.key, {
  operation: op,
  attempt: 0,
  deployed: false,
  purpose: 'action',
  now: Number((await client.getBlock()).timestamp),
  sponsor,
});
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
const created = await send(creation, 'ActionExecuted');
const reopenedJournal = await openJournal();
assert.deepEqual(await readSignedBunkV2Envelope(reopenedJournal, signed.key, 0), creation);
assert.equal(created.observation.state.ownerIndex, 1);
assert.equal(created.observation.state.nonce, 1n);
assert.equal(created.observation.state.commitment, signed.nextOwner.commitment);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 72n);
await receipt(await wallet.sendTransaction({ to: account, value: parseEther('1') }));
const pendingTime = Number((await client.getBlock()).timestamp);
const pending = await journalIntent(
  {
    config,
    state: created.observation.state,
    callData,
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maximumGasCost: parseEther('0.011'),
    paymaster: zeroAddress,
    validAfter: pendingTime - 10,
    executeUntil: pendingTime + 5,
  },
  created.observation.block,
);
const fee = bunkEvmV2RecoveryFee(pending.intent.certificate);
for (let i = 0; i < 40; i++) {
  if (Number((await client.getBlock()).timestamp) > pending.intent.certificate.executeUntil + 7)
    break;
  await wait(500);
}
const recovery = await journalEnvelope(pending.key, {
  deployed: true,
  operation: {
    ...op,
    nonce: 1n,
    initCode: '0x',
    paymasterAndData: '0x',
    callData: bunkEvmV2RecoveryCalls(),
    maxPriorityFeePerGas: fee,
    maxFeePerGas: fee,
  },
  attempt: 255,
  purpose: 'cleanup',
  now: Number((await client.getBlock()).timestamp),
});
const recovered = await send(recovery, 'ExpiredActionSkipped');
assert.equal(recovered.observation.state.ownerIndex, 2);
assert.equal(recovered.observation.state.nonce, 2n);
assert.equal(
  recovered.observation.state.commitment,
  deriveBunkEvmV2Owner(seed, { chainId: '1337', accountIndex: 2, ownerIndex: 2 }).commitment,
);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 72n);
assert.deepEqual(await readSignedBunkV2Envelope(reopenedJournal, pending.key, 255), recovery);
const journalEvidence = {
  reconstructedOwners,
  reconstructedEnvelopes,
  encrypted: true,
  reopenedIdenticalOperations: 2,
  records: databases[0].prepare('SELECT count(*) AS count FROM honey_bunk_journal_v1').get().count,
  creationRevision: (await journal.read(signed.key)).revision,
  recoveryRevision: (await journal.read(pending.key)).revision,
};
assert.equal(journalEvidence.records, 2);
assert.equal(journalEvidence.creationRevision, 6);
assert.equal(journalEvidence.recoveryRevision, 6);
assert.equal(reconstructedOwners, 1);
assert.equal(reconstructedEnvelopes, 1);
journal.destroy();
reopenedJournal.destroy();
journalKey.fill(0);
for (const db of databases) db.close();
seed.fill(0);
fs.writeFileSync(
  'client-v2-results.json',
  JSON.stringify(
    {
      scope:
        'Actual v2 seed-derived client, encrypted SQLite journal and finalized observer on isolated Osaka; not backup/device or public provider certification',
      account,
      deploymentIdentity: deployment.identity.address,
      inputHashes,
      journal: journalEvidence,
      ownerIntentSignatures: 2,
      distinctOwnerIndices: [0, 1],
      envelopeLeaves: [0, 255],
      cases: [created, recovered],
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
console.log(
  'V2 journal-backed client passed sponsored creation and reserved recovery with finalized observations and reopened saved signatures.',
);
