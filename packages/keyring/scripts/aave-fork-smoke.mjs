// Disposable local fork ONLY. No URL/key/env arguments and no mainnet broadcasts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { isOperationRecovery } from '../../api-client/src/operations.ts';
import { evmAddressOfKey, signEvmTransaction } from '../src/sign.ts';

const endpoint = 'http://127.0.0.1:28545';
const binary = fileURLToPath(
  new URL('../../../target/debug/examples/aave_fork_prepare', import.meta.url),
);
const rpc = async (method, params = []) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(
    result.error,
    undefined,
    `local fork RPC failed: ${method} ${JSON.stringify(result.error)}`,
  );
  return result.result;
};
const bridge = (input) => {
  const result = spawnSync(binary, [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 65000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
assert.match(await rpc('web3_clientVersion'), /^anvil\//);
assert.equal(await rpc('eth_chainId'), '0x7a69');
const snapshot = await rpc('evm_snapshot');
let database;
const key = new Uint8Array(32);
key[31] = 1; // Public test scalar, never a user wallet.
const signer = evmAddressOfKey(key).toLowerCase();
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const atoken = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function supply(address,uint256,address,uint16)',
  'function withdraw(address,uint256,address) returns (uint256)',
]);
const call = async (to, functionName, args) =>
  BigInt(
    await rpc('eth_call', [
      { to, data: encodeFunctionData({ abi, functionName, args }) },
      'latest',
    ]),
  );
const receipt = async (hash) => {
  let r;
  for (let attempt = 0; attempt < 100; attempt++) {
    r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(r);
  assert.equal(r.status, '0x1');
  assert.equal(r.transactionHash, hash);
  return r;
};
try {
  database = bridge({ command: 'init_database' }).database;
  // This public scalar has EIP-7702 code on Ethereum. This fixture specifically
  // exercises an ordinary EOA; the production preparer rejects delegated code.
  await rpc('anvil_setCode', [signer, '0x']);
  await rpc('anvil_setBalance', [signer, '0xde0b6b3a7640000']);
  await rpc('anvil_setBalance', [atoken, '0xde0b6b3a7640000']);
  assert.ok((await call(asset, 'balanceOf', [atoken])) >= 10000000n);
  await rpc('anvil_impersonateAccount', [atoken]);
  try {
    await receipt(
      await rpc('eth_sendTransaction', [
        {
          from: atoken,
          to: asset,
          gas: '0x30d40',
          data: encodeFunctionData({ abi, functionName: 'transfer', args: [signer, 10000000n] }),
        },
      ]),
    );
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [atoken]);
  }
  const before = {
    underlying: await call(asset, 'balanceOf', [signer]),
    receipt: await call(atoken, 'balanceOf', [signer]),
  };
  const evidence = [];
  for (const action of ['supply', 'withdraw']) {
    const amount = action === 'supply' ? 1000000n : 900000n;
    console.error(
      `Preparing ${action}: underlying=${await call(asset, 'balanceOf', [signer])}, aToken=${await call(atoken, 'balanceOf', [signer])}`,
    );
    const receiptBefore = await call(atoken, 'balanceOf', [signer]);
    const prepared = bridge({ action, amount: amount.toString(), database });
    assert.equal(prepared.plan.chainId, '31337');
    assert.equal(prepared.plan.signer, signer);
    assert.equal(prepared.plan.provider, 'aave_v3');
    // Independent viem ABI encoding confirms the Rust-generated ordered calls.
    for (const step of prepared.plan.steps) {
      const expected =
        step.purpose === 'approval'
          ? encodeFunctionData({ abi, functionName: 'approve', args: [pool, 1000000n] })
          : encodeFunctionData({
              abi,
              functionName: action,
              args: action === 'supply' ? [asset, amount, signer, 0] : [asset, amount, signer],
            });
      assert.equal(step.data, expected);
    }
    const signed = [];
    for (let n = 0; n < prepared.plan.steps.length; n++) {
      const step = prepared.plan.steps[n];
      signed.push(
        await signEvmTransaction(key, {
          type: 'eip1559',
          chainId: 31337,
          nonce: Number(BigInt(prepared.firstNonce) + BigInt(n)),
          gas: BigInt(prepared.gasLimits[n]),
          maxFeePerGas: BigInt(prepared.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(prepared.maxPriorityFeePerGas),
          to: step.to,
          data: step.data,
          value: BigInt(step.valueRaw),
        }),
      );
    }
    const verified = bridge({
      command: 'verify',
      database,
      operation: prepared.operation,
      plan: prepared.plan,
      firstNonce: prepared.firstNonce,
      signed,
    });
    assert.deepEqual(verified.hashes, signed.map(keccak256));
    const transactions = [];
    for (let n = 0; n < signed.length; n++) {
      const dispatch = bridge({
        command: 'dispatch',
        database,
        operation: prepared.operation,
        step: n,
      });
      assert.equal(dispatch.hash, verified.hashes[n]);
      const hash = await rpc('eth_sendRawTransaction', [signed[n]]);
      assert.equal(hash, verified.hashes[n]);
      const r = await receipt(hash);
      transactions.push({
        hash,
        blockNumber: BigInt(r.blockNumber).toString(),
        gasUsed: BigInt(r.gasUsed).toString(),
        status: r.status,
      });
    }
    const underlying = await call(asset, 'balanceOf', [signer]);
    const receiptBalance = await call(atoken, 'balanceOf', [signer]);
    assert.equal(underlying, before.underlying - (action === 'supply' ? 1000000n : 100000n));
    assert.ok(receiptBalance >= before.receipt + (action === 'supply' ? 999999n : 99998n));
    assert.equal(await call(asset, 'allowance', [signer, pool]), 0n);
    if (action === 'withdraw')
      assert.ok(receiptBefore - receiptBalance <= BigInt(prepared.plan.maximumSpend.amountRaw));
    // Advance only the disposable chain, using this node's observed finality lag.
    const head = await rpc('eth_getBlockByNumber', ['latest', false]);
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
    const finalityLag = BigInt(head.number) - BigInt(finalized.number);
    assert.ok(finalityLag >= 0n && finalityLag <= 256n);
    for (let block = 0n; block < finalityLag; block++) await rpc('evm_mine');
    const settled = bridge({ command: 'reconcile', database, operation: prepared.operation });
    assert.equal(isOperationRecovery(settled), true);
    assert.equal(settled.operation.state, 'succeeded');
    assert.equal(settled.reconciliation.transactions.length, signed.length);
    evidence.push({
      operation: prepared.operation,
      state: settled.operation.state,
      emptyBlocksMinedForLocalFinality: finalityLag.toString(),
      recovery: settled,
      reconciliation: settled.reconciliation,
      action,
      preparationHash: verified.preparationHash,
      sourceBlock: prepared.plan.simulation.blockNumber,
      transactions,
      underlyingBalance: underlying.toString(),
      aTokenBalance: receiptBalance.toString(),
    });
  }
  console.log(
    JSON.stringify(
      {
        scope: 'disposable local Anvil fork and database; simulated finality; no public broadcasts',
        chainId: 31337,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  key.fill(0);
  try {
    if (database) assert.equal(bridge({ command: 'drop_database', database }).dropped, true);
  } finally {
    assert.equal(await rpc('evm_revert', [snapshot]), true);
  }
}
