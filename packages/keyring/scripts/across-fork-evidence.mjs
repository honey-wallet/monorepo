// Actual-contract evidence on fixed disposable localhost Ethereum/Base forks.
// No provider API, configurable endpoint, production chain or real funds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
} from 'viem';

assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--swap-api-tag'),
  'only --swap-api-tag accepted; RPC endpoints are fixed localhost',
);
const tagged = process.argv[2] === '--swap-api-tag';
// Public, synthetic test attribution. This is not a registered production integrator.
const integratorId = '0xabcd';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const rpc =
  (port) =>
  async (method, params = []) => {
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
    }).catch((cause) => {
      throw new Error(`Local RPC ${port} ${method} failed`, { cause });
    });
    assert.equal(r.status, 200);
    const v = await r.json();
    assert.equal(v.error, undefined, `RPC ${method}: ${JSON.stringify(v.error)}`);
    return v.result;
  };
const source = {
  rpc: rpc(29545),
  chain: 31337,
  block: 26220316,
  spoke: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5',
  token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
};
const destination = {
  rpc: rpc(29546),
  chain: 31338,
  block: 52773813,
  spoke: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64',
  token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const abi = parseAbi([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
  'function wrappedNativeToken() view returns(address)',
  'function deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
  'function fillRelay((bytes32 depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 originChainId,uint256 depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message),uint256,bytes32)',
  'event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)',
]);
const call = async (c, to, name, args = []) =>
  decodeFunctionResult({
    abi,
    functionName: name,
    data: await c.rpc('eth_call', [
      { to, data: encodeFunctionData({ abi, functionName: name, args }) },
      'latest',
    ]),
  });
const send = async (c, from, to, name, args, suffix = '') => {
  console.error(`Local chain ${c.chain}: ${name}`);
  const hash = await c.rpc('eth_sendTransaction', [
    {
      from,
      to,
      data: `${encodeFunctionData({ abi, functionName: name, args })}${suffix}`,
      value: '0x0',
      gas: '0x1e8480',
    },
  ]);
  // Finish local mining before querying a new hash. Anvil can otherwise forward
  // a still-pending receipt lookup to the public fork source, where it cannot exist.
  await c.rpc('evm_mine');
  let receipt;
  for (let attempt = 0; attempt < 100; attempt++) {
    receipt = await c.rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(receipt, `receipt timeout: ${name}`);
  assert.equal(receipt.status, '0x1', `failed ${name}`);
  return receipt;
};
const pin = async (c, address) => {
  const code = await c.rpc('eth_getCode', [address, 'latest']);
  assert.notEqual(code, '0x');
  return { address, codeHash: keccak256(code) };
};
const policy = async (c) => {
  const implementation = async (address, slot) =>
    `0x${(await c.rpc('eth_getStorageAt', [address, slot, 'latest'])).slice(-40)}`;
  return {
    spoke: await pin(c, c.spoke),
    spokeImplementation: await pin(
      c,
      await implementation(
        c.spoke,
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
      ),
    ),
    token: await pin(c, c.token),
    tokenImplementation: await pin(
      c,
      await implementation(
        c.token,
        '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
      ),
    ),
    wrappedNative: await call(c, c.spoke, 'wrappedNativeToken'),
  };
};
const verify = (input) =>
  spawnSync(`${root}target/debug/examples/across_fork_evidence`, [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 65000,
  });
for (const c of [source, destination]) {
  assert.match(await c.rpc('web3_clientVersion'), /^anvil\//);
  assert.equal(BigInt(await c.rpc('eth_chainId')), BigInt(c.chain));
  c.head = await c.rpc('eth_getBlockByNumber', ['latest', false]);
  assert.equal(BigInt(c.head.number), BigInt(c.block), 'fresh pinned fork required');
}
const snapshots = [];
let originalError;
let cleanupFailures = [];
let completedEvidence;
try {
  for (const c of [source, destination]) snapshots.push([c, await c.rpc('evm_snapshot')]);
  const accounts = await source.rpc('eth_accounts');
  assert.equal(accounts[0].toLowerCase(), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  assert.deepEqual(await destination.rpc('eth_accounts'), accounts);
  const [owner, relayer, recipient] = accounts;
  const inputAmount = 1000000n,
    outputAmount = 990000n;
  for (const [c, who, amount] of [
    [source, owner, inputAmount],
    [destination, relayer, outputAmount],
  ]) {
    assert.ok(
      (await call(c, c.token, 'balanceOf', [c.spoke])) >= amount,
      'fork pool has test tokens',
    );
    await c.rpc('anvil_setBalance', [c.spoke, '0x56bc75e2d63100000']);
    await c.rpc('anvil_impersonateAccount', [c.spoke]);
    try {
      await send(c, c.spoke, c.token, 'transfer', [who, amount]);
    } finally {
      await c.rpc('anvil_stopImpersonatingAccount', [c.spoke]);
    }
    await send(c, who, c.token, 'approve', [c.spoke, amount]);
  }
  const sourcePolicy = await policy(source),
    destinationPolicy = await policy(destination);
  const beforeSource = await call(source, source.token, 'balanceOf', [owner]);
  const beforeDestination = await call(destination, destination.token, 'balanceOf', [recipient]);
  const beforeRelayer = await call(destination, destination.token, 'balanceOf', [relayer]);
  const block = await source.rpc('eth_getBlockByNumber', ['latest', false]);
  const timestamp = Number(BigInt(block.timestamp));
  const deadline = timestamp + 3600;
  const zero = pad('0x00');
  const terms = {
    sourceChain: '31337',
    destinationChain: '31338',
    depositor: owner,
    recipient,
    inputToken: source.token,
    outputToken: destination.token,
    inputAmount: inputAmount.toString(),
    outputAmount: outputAmount.toString(),
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    quoteTimestamp: String(timestamp),
    fillDeadline: String(deadline),
    exclusivityParameter: '0',
    ...(tagged ? { swapApiIntegratorId: integratorId } : {}),
  };
  const deposit = await send(
    source,
    owner,
    source.spoke,
    'deposit',
    [
      pad(owner),
      pad(recipient),
      pad(source.token),
      pad(destination.token),
      inputAmount,
      outputAmount,
      31338n,
      zero,
      timestamp,
      deadline,
      0,
      '0x',
    ],
    tagged ? `1dc0de${integratorId.slice(2)}73c0de` : '',
  );
  const depositTransaction = await source.rpc('eth_getTransactionByHash', [
    deposit.transactionHash,
  ]);
  assert.equal((depositTransaction.input.length - 2) / 2, tagged ? 428 : 420);
  if (tagged) assert.ok(depositTransaction.input.endsWith('1dc0deabcd73c0de'));
  const events = deposit.logs.flatMap((log) => {
    try {
      return [
        decodeEventLog({ abi, eventName: 'FundsDeposited', data: log.data, topics: log.topics }),
      ];
    } catch {
      return [];
    }
  });
  assert.equal(events.length, 1);
  const event = events[0].args;
  const relay = {
    depositor: pad(owner),
    recipient: pad(recipient),
    exclusiveRelayer: zero,
    inputToken: pad(source.token),
    outputToken: pad(destination.token),
    inputAmount,
    outputAmount,
    originChainId: 31337n,
    depositId: event.depositId,
    fillDeadline: deadline,
    exclusivityDeadline: 0,
    message: '0x',
  };
  const fill = await send(destination, relayer, destination.spoke, 'fillRelay', [
    relay,
    31337n,
    pad(relayer),
  ]);
  const request = {
    terms,
    sourcePolicy,
    destinationPolicy,
    sourceHash: deposit.transactionHash,
    fillHash: fill.transactionHash,
  };
  const early = verify(request);
  assert.notEqual(early.status, 0, 'unfinalized receipt must not prove delivery');
  assert.match(early.stderr, /not finalized/);
  for (const c of [source, destination]) await c.rpc('anvil_mine', ['0x40', '0x1']);
  const checked = verify(request);
  assert.equal(checked.status, 0, checked.stderr);
  const proof = JSON.parse(checked.stdout);
  assert.equal(proof.deposit.depositId, event.depositId.toString());
  assert.equal(
    beforeSource - (await call(source, source.token, 'balanceOf', [owner])),
    inputAmount,
  );
  assert.equal(
    (await call(destination, destination.token, 'balanceOf', [recipient])) - beforeDestination,
    outputAmount,
  );
  assert.equal(
    beforeRelayer - (await call(destination, destination.token, 'balanceOf', [relayer])),
    outputAmount,
  );
  assert.equal(await call(source, source.token, 'allowance', [owner, source.spoke]), 0n);
  assert.equal(
    await call(destination, destination.token, 'allowance', [relayer, destination.spoke]),
    0n,
  );
  const tampered = verify({ ...request, terms: { ...terms, recipient: relayer } });
  assert.notEqual(tampered.status, 0, 'changed recipient must fail');
  if (tagged) {
    for (const swapApiIntegratorId of ['0xabce', undefined]) {
      const wrongAttribution = verify({ ...request, terms: { ...terms, swapApiIntegratorId } });
      assert.notEqual(wrongAttribution.status, 0, 'changed or omitted integrator must fail');
      assert.match(wrongAttribution.stderr, /invalid or unsupported Across evidence/);
    }
  }
  const evidence = {
    date: '2026-10-18',
    scope:
      'Actual Across/USDC contracts on two isolated forks; manual local relayer, no provider API or application execution worker.',
    sourceFork: { chain: 1, block: source.block, hash: source.head.hash },
    destinationFork: { chain: 8453, block: destination.block, hash: destination.head.hash },
    localChains: [31337, 31338],
    inputAmountRaw: inputAmount.toString(),
    deliveredAmountRaw: outputAmount.toString(),
    inputAllowanceAfter: '0',
    relayerAllowanceAfter: '0',
    unfinalizedRejected: true,
    changedRecipientRejected: true,
    ...(tagged
      ? {
          attribution: {
            integratorId,
            registered: false,
            calldataBytes: 428,
            suffix: '0x1dc0deabcd73c0de',
            changedOrOmittedIntegratorRejected: true,
          },
          sdkSource:
            'https://github.com/across-protocol/toolkit/blob/2edb9f61335071bc5b1d9778306f815e9354bd3d/packages/sdk/src/utils/hex.ts',
        }
      : {}),
    sourcePolicy,
    destinationPolicy,
    proof,
  };
  const path = `${root}docs/backend/evidence/across-direct-${tagged ? 'tagged-' : ''}local-fork-2026-10-18.json`;
  completedEvidence = { path, evidence };
} catch (error) {
  originalError = error;
} finally {
  const cleanup = await Promise.allSettled(
    snapshots.map(async ([c, snapshot]) => {
      assert.equal(await c.rpc('evm_revert', [snapshot]), true, 'restore owned fork');
    }),
  );
  cleanupFailures = cleanup.filter((r) => r.status === 'rejected').map((r) => r.reason);
}
if (originalError || cleanupFailures.length)
  throw new AggregateError(
    [...(originalError ? [originalError] : []), ...cleanupFailures],
    'Across fork acceptance or cleanup failed',
  );
assert.ok(completedEvidence);
await writeFile(
  completedEvidence.path,
  `${JSON.stringify({ ...completedEvidence.evidence, snapshotsRestored: true }, null, 2)}\n`,
);
console.log(`Across direct deposit/fill evidence passed: ${completedEvidence.path}`);
