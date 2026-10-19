// Public scalar and disposable fork/database only. Exercises the real server,
// SIWE, typed client, worker, encrypted persistence and receipt recovery.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { createApiClient } from '../../api-client/src/client.ts';
import {
  morphoIntentFromQuote,
  morphoTransactionRequests,
  validateMorphoReview,
} from '../../api-client/src/morpho.ts';
import { evmAddressOfKey, signEvmMessage, signEvmTransaction } from '../src/sign.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rpc = async (method, params = []) => {
  const response = await fetch('http://127.0.0.1:28545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  assert.equal(body.error, undefined, `RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
};
const bridge = (input) => {
  const r = spawnSync(join(root, 'target/debug/examples/aave_fork_prepare'), [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 65000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
assert.match(await rpc('web3_clientVersion'), /^anvil\//);
assert.equal(await rpc('eth_chainId'), '0x7a69');
const snapshot = await rpc('evm_snapshot');
const dir = await mkdtemp(join(tmpdir(), 'honey-morpho-http-'));
let database, server;
const key = new Uint8Array(32);
key[31] = 1;
const signer = evmAddressOfKey(key).toLowerCase();
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const aToken = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const abi = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function owner() view returns (address)',
  'function curator() view returns (address)',
  'function adapterRegistry() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function performanceFee() view returns (uint256)',
  'function managementFee() view returns (uint256)',
  'function performanceFeeRecipient() view returns (address)',
  'function managementFeeRecipient() view returns (address)',
  'function adaptersLength() view returns (uint256)',
  'function adapters(uint256) view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function maxDeposit(address) view returns (uint256)',
  'function previewDeposit(uint256) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function vaultBundlesV1Deposit(address,uint256,uint256,(uint8 kind,bytes data),uint256,address,uint256) payable',
  'function vaultBundlesV1Withdraw(address,uint256,uint256,(uint256 value,uint256 nonce,uint256 deadline,uint8 v,bytes32 r,bytes32 s),uint256,address,uint256)',
]);
const data = (functionName, args = []) => encodeFunctionData({ abi: vaultAbi, functionName, args });
const call = async (to, functionName, args = []) =>
  decodeFunctionResult({
    abi: vaultAbi,
    functionName,
    data: await rpc('eth_call', [{ to, data: data(functionName, args) }, 'latest']),
  });
const pin = async (address) => {
  address = address.toLowerCase();
  const code = await rpc('eth_getCode', [address, 'latest']);
  assert.notEqual(code, '0x');
  return { address, codeHash: keccak256(code) };
};

const vault = '0x04422053addbc9bb2759b248b574e3fca76bc145';
const bundle = '0x02912516d49de997db75b9d7858faae59209650b';
const api = createApiClient({ baseUrl: 'http://127.0.0.1:28546' });
const pause = () => new Promise((r) => setTimeout(r, 1000));
async function stop() {
  if (!server) return;
  const child = server;
  server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exit;
}
async function poll(fn, accept, limit = 120) {
  let last;
  for (let n = 0; n < limit; n++) {
    last = await fn();
    if (accept(last)) return last;
    await pause();
  }
  throw new Error(`Polling deadline: ${JSON.stringify(last)}`);
}
try {
  database = bridge({ command: 'init_database' }).database;
  await rpc('anvil_setCode', [signer, '0x']);
  await rpc('anvil_setBalance', [signer, '0xde0b6b3a7640000']);
  await rpc('anvil_setBalance', [aToken, '0xde0b6b3a7640000']);
  await rpc('anvil_impersonateAccount', [aToken]);
  try {
    await rpc('eth_sendTransaction', [
      {
        from: aToken,
        to: asset,
        gas: '0x30d40',
        data: encodeFunctionData({ abi, functionName: 'transfer', args: [signer, 10000000n] }),
      },
    ]);
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [aToken]);
  }
  const aaveSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const usdcSlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
  async function implementation(proxy, slot) {
    const word = await rpc('eth_getStorageAt', [proxy, slot, 'latest']);
    assert.match(word, /^0x0{24}[0-9a-f]{40}$/i);
    const address = `0x${word.slice(-40)}`;
    const code = await rpc('eth_getCode', [address, 'latest']);
    assert.notEqual(code, '0x');
    return { address, codeHash: keccak256(code) };
  }
  const policy = {
    mode: 'local_fork',
    rpcUrl: 'http://127.0.0.1:28545',
    chainId: '31337',
    rpcBudget: { scope: 'local-aave-fork', intervalMs: 10, simulationCost: 10 },
    pool,
    asset,
    aToken,
    decimals: 6,
    poolCodeHash: keccak256(await rpc('eth_getCode', [pool, 'latest'])),
    assetCodeHash: keccak256(await rpc('eth_getCode', [asset, 'latest'])),
    aTokenCodeHash: keccak256(await rpc('eth_getCode', [aToken, 'latest'])),
    poolImplementation: await implementation(pool, aaveSlot),
    assetImplementation: await implementation(asset, usdcSlot),
    aTokenImplementation: await implementation(aToken, aaveSlot),
    registryRevision: 'fork-http-pinned-v2',
    zeroFeePolicyRevision: 'fork-no-fees-v1',
    maximumGasPerTransaction: 1000000,
    maximumAtokenRoundingRaw: '2',
    activeKeyId: 'public-test-only',
    dataKeys: { 'public-test-only': '55'.repeat(32) },
  };
  const path = join(dir, 'execution.json');
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const implWord = await rpc('eth_getStorageAt', [
    asset,
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
    'latest',
  ]);
  assert.match(implWord, /^0x0{24}[0-9a-f]{40}$/i);
  const registry = {
    chainId: 31337,
    vault: await pin(vault),
    bundle: await pin(bundle),
    asset: await pin(asset),
    assetImplementation: await pin(`0x${implWord.slice(-40)}`),
    assetDecimals: Number(await call(asset, 'decimals')),
    shareDecimals: Number(await call(vault, 'decimals')),
    owner: await call(vault, 'owner'),
    curator: await call(vault, 'curator'),
    adapters: [],
    adapterRegistry: await call(vault, 'adapterRegistry'),
    liquidityAdapter: await call(vault, 'liquidityAdapter'),
    liquidityDataHash: keccak256(
      await rpc('eth_call', [{ to: vault, data: data('liquidityData') }, 'latest']),
    ),
    performanceFeeWad: (await call(vault, 'performanceFee')).toString(),
    managementFeePerSecondWad: (await call(vault, 'managementFee')).toString(),
    performanceFeeRecipient: await call(vault, 'performanceFeeRecipient'),
    managementFeeRecipient: await call(vault, 'managementFeeRecipient'),
    registryRevision: 'observed-fork-morpho-v1',
    zeroFeePolicyRevision: 'local-zero-referral-fees',
    maximumGasPerTransaction: 1500000,
  };
  const adaptersLength = Number(await call(vault, 'adaptersLength'));
  assert.ok(adaptersLength <= 8);
  for (let n = 0; n < adaptersLength; n++)
    registry.adapters.push(await pin(await call(vault, 'adapters', [BigInt(n)])));

  const morphoPath = join(dir, 'morpho.json');
  await writeFile(
    morphoPath,
    JSON.stringify({
      mode: 'local_fork',
      rpcUrl: policy.rpcUrl,
      rpcBudget: policy.rpcBudget,
      registry,
      activeKeyId: policy.activeKeyId,
      dataKeys: policy.dataKeys,
    }),
    { mode: 0o600 },
  );
  async function start(execution = true) {
    server = spawn(join(root, 'target/debug/honey-server'), [], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HOST: '127.0.0.1',
        PORT: '28546',
        DATABASE_URL: `postgres://honey:honey_local_only@127.0.0.1:25432/${database}`,
        REDIS_URL: 'redis://127.0.0.1:26379',
        REDIS_NAMESPACE: `honey-rpc:${database.slice('honey_aave_smoke_'.length)}`,
        AUTH_ORIGIN: 'http://localhost:5173',
        AUTH_CHAIN_ID: '31337',
        ...(execution
          ? { AAVE_EXECUTION_CONFIG_FILE: path, MORPHO_EXECUTION_CONFIG_FILE: morphoPath }
          : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', () => {});
    await poll(
      () => {
        assert.equal(server.exitCode, null, 'fixture server exited during startup');
        return api.health().catch(() => null);
      },
      (v) => v !== null,
      20,
    );
  }
  await start();
  const config = await api.morphoExecution();
  const challenge = await api.createSignInChallenge(signer, 'eip155:31337');
  const session = await api.verifySignIn(
    challenge.id,
    await signEvmMessage(key, challenge.message),
  );
  const token = session.accessToken;
  await assert.rejects(
    () =>
      api.createMorphoOperation('invalid', 'auth-denied', {
        vault,
        action: 'deposit',
        amountRaw: '1',
        minimumSharesRaw: '1',
        acknowledgeUnprotectedOutput: false,
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        maximumNetworkFeeRaw: '1000000000000000',
      }),
    (e) => e.status === 401,
  );
  const evidence = [];
  let mintedShares = 0n;
  for (const action of ['deposit', 'redeem']) {
    const beforeAsset = await call(asset, 'balanceOf', [signer]);
    const beforeShares = await call(vault, 'balanceOf', [signer]);
    const quote = await api.morphoQuote(token, {
      action,
      amountRaw: action === 'deposit' ? '1000000' : mintedShares.toString(),
    });
    const intent = morphoIntentFromQuote(quote, config, signer, {
      slippageBps: 10,
      acknowledgeUnprotectedOutput: action === 'redeem',
      maximumNetworkFeeRaw: '1000000000000000',
    });
    const idempotency = `http-fork-${action}`;
    const created = await api.createMorphoOperation(token, idempotency, intent);
    const id = created.operation.id;
    assert.equal((await api.createMorphoOperation(token, idempotency, intent)).operation.id, id);
    await assert.rejects(
      () => api.createMorphoOperation(token, idempotency, { ...intent, amountRaw: '2' }),
      (e) => e.status === 409,
    );
    const ready = await poll(
      () => api.operation(token, id),
      (v) => v.operation.state !== 'created',
    );
    assert.equal(ready.operation.state, 'awaiting_signature');
    const signing = await api.morphoSigningRequest(token, id);
    const context = {
      configuration: config,
      intent,
      signer,
      operationId: id,
      operationVersion: ready.operation.version,
      planHash: ready.preparation.hash,
    };
    validateMorphoReview(signing, context);
    await assert.rejects(
      () => api.aaveSigningRequest(token, id),
      (e) => e.status === 404,
    );
    await assert.rejects(
      () => api.aaveIntent(token, id),
      (e) => e.status === 404,
    );
    // Restart must return exactly the same persisted signing request.
    await stop();
    await start();
    assert.deepEqual(await api.morphoSigningRequest(token, id), signing);
    const discovered = await api.operations(token, { limit: 10 });
    assert.ok(discovered.items.some((i) => i.operation.id === id));
    const recoveredIntent = await api.morphoIntent(token, id);
    assert.deepEqual(recoveredIntent.intent, intent);
    assert.equal(recoveredIntent.signer, signer);
    assert.equal(recoveredIntent.registryRevision, config.registryRevision);

    const signedTransactions = [];
    for (const tx of morphoTransactionRequests(signing))
      signedTransactions.push(await signEvmTransaction(key, tx));
    const payload = {
      expectedVersion: ready.operation.version,
      planHash: signing.planHash,
      signedTransactions,
    };
    await assert.rejects(
      () => api.submitMorpho(token, id, { ...payload, planHash: '0'.repeat(64) }),
      (e) => e.status === 409,
    );
    const staged = await api.submitMorpho(token, id, payload);
    assert.deepEqual(staged.submission.transactionHashes, signedTransactions.map(keccak256));
    // Stop right after durable staging. Restarted worker owns all sends.
    await stop();
    await start();
    assert.deepEqual((await api.submitMorpho(token, id, payload)).submission, staged.submission);
    console.error(`HTTP ${action}: durable staging and restart passed; waiting for receipts`);
    const included = await poll(
      () => api.operation(token, id),
      (v) => v.reconciliation?.transactions.every((t) => t.inclusion?.succeeded),
    );
    const head = await rpc('eth_getBlockByNumber', ['latest', false]);
    const final = await rpc('eth_getBlockByNumber', ['finalized', false]);
    const lag = BigInt(head.number) - BigInt(final.number);
    assert.ok(lag >= 0n && lag <= 256n);
    await rpc('anvil_mine', [`0x${lag.toString(16)}`, '0x0']);
    const minedHead = await rpc('eth_getBlockByNumber', ['latest', false]);
    assert.equal(BigInt(minedHead.number) - BigInt(head.number), lag);
    const settled = await poll(
      () => api.operation(token, id),
      (v) => v.operation.state === 'succeeded',
    );
    const balance = BigInt(
      await rpc('eth_call', [
        { to: asset, data: encodeFunctionData({ abi, functionName: 'balanceOf', args: [signer] }) },
        'latest',
      ]),
    );
    const afterShares = await call(vault, 'balanceOf', [signer]);
    if (action === 'deposit') {
      assert.equal(beforeAsset - balance, BigInt(intent.amountRaw));
      mintedShares = afterShares - beforeShares;
      assert.ok(mintedShares >= BigInt(intent.minimumSharesRaw));
    } else {
      assert.equal(beforeShares - afterShares, BigInt(intent.amountRaw));
      assert.ok(balance > beforeAsset);
    }
    evidence.push({
      quote,
      intent,
      assetDelta: (balance - beforeAsset).toString(),
      shareDelta: (afterShares - beforeShares).toString(),
      action,
      signingRequest: signing,
      includedVersion: included.operation.version,
      recovery: settled,
      underlyingBalance: balance.toString(),
      simulatedFinalityBlocks: lag.toString(),
    });
    console.error(
      `HTTP ${action}: succeeded (${settled.submission.transactionHashes.length} transactions)`,
    );
    // Negative mutation tests intentionally consume the per-wallet fixed-window
    // budget. Start the withdrawal case in a fresh minute; never auto-retry sends.
    if (action === 'deposit')
      await new Promise((resolve) => setTimeout(resolve, 60000 - (Date.now() % 60000) + 100));
  }
  await stop();
  await start(false);
  await assert.rejects(
    () => api.aaveExecution(),
    (e) => e.status === 422,
  );
  const historyWithExecutionDisabled = await api.operations(token, { limit: 10 });
  assert.equal(historyWithExecutionDisabled.items.length, 2);
  assert.ok(historyWithExecutionDisabled.items.every((i) => i.operation.state === 'succeeded'));
  for (const item of historyWithExecutionDisabled.items)
    assert.equal((await api.operation(token, item.operation.id)).operation.state, 'succeeded');
  console.log(
    JSON.stringify(
      {
        scope:
          'local fork only; actual SIWE HTTP APIs and supervised worker; restart recovery; public fixture key; simulated finality',
        chainId: '31337',
        registry,
        rpcBudget: policy.rpcBudget,
        historyWithExecutionDisabled,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  key.fill(0);
  await stop();
  try {
    if (database) bridge({ command: 'drop_database', database, cleanupRpcBudget: true });
  } finally {
    await rpc('evm_revert', [snapshot]);
    await rm(dir, { recursive: true, force: true });
  }
}
