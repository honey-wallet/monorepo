// Public fixture only: missing first approval, durable restore and real process death.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decryptBunkBackup, encryptBunkBackup } from '../../../keyring/src/bunk-backup.ts';
import { bunkEvmSponsorshipDigest } from '../../../keyring/src/bunk-evm.ts';
import { observeBunkEvmV3Account } from '../../../keyring/src/bunk-evm-observe.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../../../keyring/src/bunk-evm-v2-store.ts';
import {
  bunkEvmV3KeyScope,
  encodeBunkEvmV3Calls,
  predictBunkEvmV3Account,
} from '../../../keyring/src/bunk-evm-v3.ts';
import {
  decodeBunkV3Account,
  readBunkV3Attempt,
  readBunkV3Bootstrap,
  refreshBunkV3Account,
  reserveBunkV3Approval,
  reserveBunkV3Attempt,
  signBunkV3Approval,
  signBunkV3Attempt,
} from '../../../keyring/src/bunk-evm-v3-account.ts';
import {
  deriveBunkEvmV3DeploymentIdentity,
  signBunkEvmV3Deployment,
  signBunkEvmV3Envelope,
  signBunkEvmV3Intent,
} from '../../../keyring/src/bunk-evm-v3-sign.ts';
import { deriveBunkJournalEncryptionKey } from '../../../keyring/src/bunk-journal-key.ts';
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
const accountIndex = 10000,
  deployment = signBunkEvmV3Deployment(seed, config, accountIndex),
  account = deployment.account;
const request = {
  config,
  accountIndex,
  proxyRuntimeCodeHash: keccak256(artifact('SafeProxy').deployedBytecode.object),
};
const backupFile = 'public-coordinator-backup.json';
const backupPassword = 'public fixture backup password';
const registryFile = 'local-coordinator-registry.json';
const registry = {
  format: 'honey-bunk-releases',
  version: 1,
  revision: 1,
  entries: [
    {
      id: 'local-evm-fixture',
      use: 'restore-only',
      family: 'evm-v3',
      config,
      proxyRuntimeCodeHash: request.proxyRuntimeCodeHash,
    },
  ],
};
const sha = (data) => createHash('sha256').update(data).digest('hex');
fs.writeFileSync(registryFile, `${JSON.stringify(registry)}\n`, { flag: 'wx' });
const registryPin = `0x${sha(fs.readFileSync(registryFile))}`;
const backup = await encryptBunkBackup(
  fixture.phrase,
  {
    version: 1,
    accounts: [
      {
        family: 'evm-v3',
        chainId: config.chainId,
        keyScope: bunkEvmV3KeyScope(config),
        accountIndex,
      },
    ],
  },
  backupPassword,
  randomBytes,
);
const backupJson = `${JSON.stringify(backup)}\n`;
assert.equal(backup.version, 2);
assert(!backupJson.includes(fixture.phrase));
assert(!backupJson.includes('accountIndex'));
fs.writeFileSync(backupFile, backupJson, { flag: 'wx', mode: 0o600 });
const backupHash = sha(fs.readFileSync(backupFile));
async function importedSeed() {
  const imported = await decryptBunkBackup(JSON.parse(fs.readFileSync(backupFile)), backupPassword);
  assert.equal(imported.signingAuthorized, false);
  return mnemonicToSeed(imported.mnemonic);
}
const access = {
  rpc: (r) => client.request(r),
  now: () => Math.floor(Date.now() / 1000),
  maxFinalizedAgeSeconds: 120,
};
const observe = () =>
  observeBunkEvmV3Account(access.rpc, {
    ...request,
    deploymentIdentity: deployment.identity.address,
    now: access.now,
    maxFinalizedAgeSeconds: 120,
  });
async function finalize(number) {
  for (let i = 0; i < 180; i++) {
    if ((await client.getBlock({ blockTag: 'finalized' })).number >= number) return;
    await wait(500);
  }
  throw Error('Missing local finality');
}
const vaultKey = deriveBunkJournalEncryptionKey(seed),
  databases = [],
  stores = [];
async function openStore() {
  const db = new DatabaseSync('coordinator-v3.sqlite');
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
  const store = encryptedBunkJournalStore(raw, vaultKey, randomBytes);
  stores.push(store);
  return store;
}
const store = await openStore();
let accountKey, ownerKey;
function worker(action, extra = {}) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./coordinator-v3-worker.mjs', import.meta.url)),
    ],
    {
      input: JSON.stringify({
        action,
        rpc: s.rpc,
        backupFile,
        backupPassword,
        registryFile,
        registryPin,
        database: 'coordinator-v3.sqlite',
        ...extra,
      }),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}
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
function approval(value) {
  const now = access.now();
  return {
    callData: encodeBunkEvmV3Calls(config, account, [
      {
        target,
        value: 0n,
        data: encodeFunctionData({
          abi: artifact('Target', 'BunkIntegration.t').abi,
          functionName: 'set',
          args: [value],
        }),
      },
    ]),
    verificationGasLimit: 500000n,
    callGasLimit: 500000n,
    preVerificationGas: 100000n,
    maximumGasCost: parseEther('0.011'),
    paymaster,
    validAfter: now - 10,
    executeUntil: now + 1200,
  };
}
async function operation(state, value, sponsorNonce, managed) {
  const fields = approval(value),
    now = access.now();
  let intent, raw;
  if (managed) {
    ownerKey = await reserveBunkV3Approval(store, seed, accountKey, fields, access);
    intent = await signBunkV3Approval(store, seed, accountKey, ownerKey, access);
  } else {
    raw = signBunkEvmV3Intent(seed, { ...fields, config, state });
    intent = raw.intent;
  }
  const op = {
    sender: account,
    nonce: state.nonce,
    initCode: state.deployed ? '0x' : concatHex([prior.factory, deployment.factoryData]),
    callData: fields.callData,
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
  if (managed) {
    await reserveBunkV3Attempt(
      store,
      seed,
      accountKey,
      ownerKey,
      { operation: op, attempt: 0, purpose: 'action', sponsor },
      access,
    );
    return signBunkV3Attempt(store, seed, accountKey, ownerKey, 0, access, sponsor);
  }
  return signBunkEvmV3Envelope(seed, {
    config,
    state,
    intent,
    operation: op,
    attempt: 0,
    proof: raw.envelopes.proofs[0],
    purpose: 'action',
    now,
    sponsor,
  });
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
await finalize((await client.getBlock()).number);
assert.equal((await observe()).status, 'undeployed');
// Simulate a previous device that signed creation, then lost every pending field.
const initial = {
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
const lost = await operation(initial, 999n, 0n, false);
seed.fill(0);
await receipt(await wallet.sendTransaction({ to: account, value: parseEther('1') }));
await write('EntryPoint', s.entryPoint, 'depositTo', [account], parseEther('0.5'));
await finalize((await client.getBlock()).number);
const importRejections = [];
function rejectImport(extra, pattern) {
  const rejected = worker('start', { database: 'rejected-backup.sqlite', ...extra });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, pattern);
  assert.equal(fs.existsSync('rejected-backup.sqlite'), false);
  importRejections.push(pattern.source);
}
rejectImport({ backupPassword: 'wrong password' }, /WrongPasswordError/);
fs.writeFileSync('changed-registry.json', `${fs.readFileSync(registryFile, 'utf8')}\n`);
rejectImport({ registryFile: 'changed-registry.json' }, /trusted release pin/);
const missingRegistry = `${JSON.stringify({ ...registry, entries: [] })}\n`;
fs.writeFileSync('missing-registry.json', missingRegistry);
rejectImport(
  { registryFile: 'missing-registry.json', registryPin: `0x${sha(missingRegistry)}` },
  /Missing trusted release/,
);
const beforeRestore = worker('discover', { database: 'discovery-only.sqlite' });
assert.equal(beforeRestore.status, 0, beforeRestore.stderr);
assert.equal(fs.existsSync('discovery-only.sqlite'), false);
const beforeRestoreDiscovery = JSON.parse(beforeRestore.stdout);
assert.equal(beforeRestoreDiscovery.signingAuthorized, false);
assert.equal(beforeRestoreDiscovery.inventoryComplete, false);
assert.equal(beforeRestoreDiscovery.candidates[0].observation.account, account);
assert.equal(beforeRestoreDiscovery.candidates[0].observation.status, 'undeployed');
assert.equal(beforeRestoreDiscovery.candidates[0].nativeBalance, parseEther('1').toString());
assert.equal(beforeRestoreDiscovery.candidates[0].entryPointDeposit, parseEther('0.5').toString());
const started = worker('start');
assert.equal(started.status, 0, started.stderr);
const plan = JSON.parse(started.stdout);
accountKey = plan.key;
assert.equal(plan.bootstrapRequired, true);
seed = await importedSeed();
await assert.rejects(
  reserveBunkV3Approval(store, seed, accountKey, approval(84n), access),
  /recovery/i,
);
const bootstrap = await readBunkV3Bootstrap(store, accountKey);
assert.equal(bootstrap.data, deployment.factoryData);
const balance = await client.getBalance({ address: account }),
  deposit = await read('EntryPoint', s.entryPoint, 'balanceOf', [account]);
const deployed = await receipt(await wallet.sendTransaction({ ...bootstrap, gas: 500000n }));
await finalize(deployed.blockNumber);
assert.equal((await refreshBunkV3Account(store, accountKey, access)).phase, 'restoring');
await assert.rejects(
  reserveBunkV3Approval(store, seed, accountKey, approval(84n), access),
  /recovery/i,
);
seed.fill(0);
const crashed = worker('crash', { key: accountKey, digest: plan.digest });
assert.equal(crashed.status, 73, crashed.stderr);
const uncertain = decodeBunkV3Account((await store.read(accountKey)).value);
assert.equal(uncertain.restore.phase, 'signing');
assert.equal(uncertain.restore.signature, null);
const restarted = worker('reconstruct', { key: accountKey, digest: plan.digest });
assert.equal(restarted.status, 0, restarted.stderr);
const recovery = JSON.parse(restarted.stdout);
assert.equal(recovery.digest, plan.digest);
const reset = await receipt(
  await wallet.sendTransaction({ ...recovery.transaction, value: 0n, gas: 500000n }),
);
await finalize(reset.blockNumber);
const ready = await refreshBunkV3Account(store, accountKey, access);
assert.equal(ready.phase, 'ready');
assert.equal(ready.state.epoch, 1);
assert.equal(ready.state.ownerIndex, 0);
assert.equal(ready.state.nonce, 0n);
assert.equal(await client.getBalance({ address: account }), balance);
assert.equal(await read('EntryPoint', s.entryPoint, 'balanceOf', [account]), deposit);
let oldRejection;
try {
  await bundler.request({
    method: 'eth_sendUserOperation',
    params: [rpcOp(lost.operation), s.entryPoint],
  });
} catch (e) {
  oldRejection = [e.shortMessage, e.details, e.cause?.message].filter(Boolean).join(' ');
}
assert.match(oldRejection ?? '', /AA10|already.*(constructed|deployed)/i);
seed = await importedSeed();
const signed = await operation(ready.state, 84n, 1n, true);
const reopened = await openStore();
assert.deepEqual(await readBunkV3Attempt(reopened, accountKey, ownerKey, 0), signed);
const executed = await send(signed, 'ActionExecuted');
const final = await refreshBunkV3Account(store, accountKey, access);
assert.equal(final.state.epoch, 1);
assert.equal(final.state.ownerIndex, 1);
assert.equal(final.state.nonce, 1n);
assert.equal(await read('Target', target, 'value', [], 'BunkIntegration.t'), 84n);
assert.equal(decodeBunkV3Account((await store.read(accountKey)).value).journal, null);
const revision = (await store.read(accountKey)).revision;
// A phrase-only discovery page must retain undeployed funded addresses as well as
// the recovered/rotated account. No server index or local signing journal is used.
const fundedUndeployed = predictBunkEvmV3Account(
  config,
  deriveBunkEvmV3DeploymentIdentity(seed, accountIndex + 1).address,
  accountIndex + 1,
);
await receipt(await wallet.sendTransaction({ to: fundedUndeployed, value: parseEther('0.01') }));
const discoveryDeposit = await write(
  'EntryPoint',
  s.entryPoint,
  'depositTo',
  [fundedUndeployed],
  parseEther('0.02'),
);
await finalize(discoveryDeposit.blockNumber);
const discoveredImport = worker('discover', { database: 'discovery-only.sqlite' });
assert.equal(discoveredImport.status, 0, discoveredImport.stderr);
assert.equal(fs.existsSync('discovery-only.sqlite'), false);
const discovery = JSON.parse(discoveredImport.stdout);
assert.equal(discovery.signingAuthorized, false);
assert.equal(discovery.inventoryComplete, false);
assert.equal(discovery.nextAccountIndex, accountIndex + 3);
const [discovered, prefunded, empty] = discovery.candidates;
assert.equal(discovered.observation.account, account);
assert.equal(discovered.observation.status, 'deployed');
assert.equal(discovered.observation.state.epoch, 1);
assert.equal(discovered.observation.state.ownerIndex, 1);
assert.equal(BigInt(discovered.nativeBalance), balance);
assert.equal(BigInt(discovered.entryPointDeposit), deposit);
assert.equal(prefunded.observation.account, fundedUndeployed);
assert.equal(prefunded.observation.status, 'undeployed');
assert.equal(BigInt(prefunded.nativeBalance), parseEther('0.01'));
assert.equal(BigInt(prefunded.entryPointDeposit), parseEther('0.02'));
assert.equal(empty.observation.status, 'undeployed');
assert.equal(BigInt(empty.nativeBalance), 0n);
assert.equal(BigInt(empty.entryPointDeposit), 0n);
assert.equal((await store.read(accountKey)).revision, revision);
assert.equal(sha(fs.readFileSync(backupFile)), backupHash);
assert.equal(`0x${sha(fs.readFileSync(registryFile))}`, registryPin);
seed.fill(0);
vaultKey.fill(0);
for (const store of stores) store.destroy();
for (const db of databases) db.close();
fs.writeFileSync(
  'coordinator-v3-results.json',
  JSON.stringify(
    {
      scope:
        'V3 encrypted SQLite account coordinator: lost creation approval, prefunded undeployed account, direct bootstrap, recovery signer process death/reconstruction, finalized reset and sponsored resumed action on isolated Osaka; not device/power-loss/production certification',
      account,
      accountIndex,
      accountKey,
      bootstrapTransactionHash: deployed.transactionHash,
      recoveryTransactionHash: reset.transactionHash,
      recoveryWorkerExit: crashed.status,
      reconstructedRecoveryDigest: recovery.digest,
      missingHistorySignedOldOwner: false,
      resetChangedWalletFunds: false,
      resetChangedEntryPointNonce: false,
      oldRejection,
      reopenedIdenticalOperation: true,
      finalJournalRetired: true,
      revision,
      discovery,
      backupImport: {
        version: 2,
        backupFile,
        backupHash,
        registryFile,
        registryPin,
        releaseUse: 'restore-only',
        journalKey: 'phrase-derived',
        beforeRestoreDiscovery,
        importRejections,
        rejectedImportsCreatedNoJournal: true,
        discoveryCreatedNoJournal: true,
        filesRechecked: true,
      },
      cases: [{ event: 'Recovered', ...ready }, executed, { event: 'Reconciled', ...final }],
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
console.log(
  'V3 account coordinator passed lost counterfactual approval, prefunded bootstrap, recovery-signature process death/reconstruction, finalized reset and journal-backed sponsored execution.',
);
