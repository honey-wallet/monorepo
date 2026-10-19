// Public scalar and disposable local chain only. No production registry approval.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { evmAddressOfKey, signEvmTransaction } from '../src/sign.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rpc = async (method, params = []) => {
  const response = await fetch('http://127.0.0.1:28545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const v = await response.json();
  assert.equal(v.error, undefined, `RPC ${method} failed`);
  return v.result;
};
const bridge = (value) => {
  const result = spawnSync(`${root}/target/debug/examples/morpho_fork_prepare`, [], {
    input: JSON.stringify(value),
    encoding: 'utf8',
    timeout: 65000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const abi = parseAbi([
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
const data = (functionName, args = []) => encodeFunctionData({ abi, functionName, args });
const call = async (to, functionName, args = []) =>
  decodeFunctionResult({
    abi,
    functionName,
    data: await rpc('eth_call', [{ to, data: data(functionName, args) }, 'latest']),
  });
const pin = async (address) => {
  address = address.toLowerCase();
  const code = await rpc('eth_getCode', [address, 'latest']);
  assert.notEqual(code, '0x');
  return { address, codeHash: keccak256(code) };
};
const zero = `0x${'00'.repeat(20)}`;
const zero32 = `0x${'00'.repeat(32)}`;
const vault = '0x04422053addbc9bb2759b248b574e3fca76bc145';
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const bundle = '0x02912516d49de997db75b9d7858faae59209650b';
const funder = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const key = new Uint8Array(32);
key[31] = 1;
const signer = evmAddressOfKey(key).toLowerCase();
assert.equal(await rpc('eth_chainId'), '0x7a69');
assert.match(await rpc('web3_clientVersion'), /^anvil\//);
const snapshot = await rpc('evm_snapshot');
const evidence = [];
try {
  await rpc('anvil_setCode', [signer, '0x']);
  await rpc('anvil_setBalance', [signer, '0xde0b6b3a7640000']);
  await rpc('anvil_setBalance', [funder, '0xde0b6b3a7640000']);
  await rpc('anvil_impersonateAccount', [funder]);
  try {
    await rpc('eth_sendTransaction', [
      { from: funder, to: asset, gas: '0x30d40', data: data('transfer', [signer, 10000000n]) },
    ]);
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [funder]);
  }
  const implWord = await rpc('eth_getStorageAt', [
    asset,
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
    'latest',
  ]);
  assert.match(implWord, /^0x0{24}[0-9a-f]{40}$/i);
  const policy = {
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
    policy.adapters.push(await pin(await call(vault, 'adapters', [BigInt(n)])));
  assert.equal(await call(vault, 'maxDeposit', [signer]), 0n);
  let depositedShares = 0n;
  for (const action of ['deposit', 'redeem']) {
    const amount = action === 'deposit' ? 1000000n : depositedShares;
    const minimumShares =
      action === 'deposit'
        ? ((await call(vault, 'previewDeposit', [amount])) * 999n) / 1000n
        : null;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const prepared = bridge({
      policy,
      action,
      amount: amount.toString(),
      minimumShares: minimumShares?.toString(),
      acknowledgeUnprotectedOutput: action === 'redeem',
      deadline,
    });
    assert.equal(prepared.plan.provider, 'morpho_vault_v2');
    assert.equal(prepared.plan.maximumSpend.amountRaw, amount.toString());
    assert.equal(prepared.plan.maximumSpend.assetAddress, action === 'deposit' ? asset : vault);
    const spend = action === 'deposit' ? asset : vault;
    const beforeAsset = await call(asset, 'balanceOf', [signer]);
    const beforeShares = await call(vault, 'balanceOf', [signer]);
    const actionData =
      action === 'deposit'
        ? data('vaultBundlesV1Deposit', [
            vault,
            amount,
            (amount * 10n ** 27n) / minimumShares,
            { kind: 0, data: '0x' },
            0n,
            zero,
            BigInt(deadline),
          ])
        : data('vaultBundlesV1Withdraw', [
            vault,
            0n,
            amount,
            { value: 0n, nonce: 0n, deadline: 0n, v: 0, r: zero32, s: zero32 },
            0n,
            zero,
            BigInt(deadline),
          ]);
    assert.equal(prepared.plan.steps.at(-1).data, actionData);
    assert.equal(prepared.plan.steps.at(-1).to, bundle);
    if (action === 'redeem') assert.equal(prepared.plan.minimumReceive, null);
    const signed = [];
    for (let n = 0; n < prepared.plan.steps.length; n++) {
      const step = prepared.plan.steps[n];
      if (step.purpose === 'approval') {
        assert.equal(step.to, spend);
        assert.equal(
          step.data,
          data('approve', [bundle, n === prepared.plan.steps.length - 2 ? amount : 0n]),
        );
      }
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
          value: 0n,
        }),
      );
    }
    const verified = bridge({ command: 'verify', prepared, signed });
    assert.deepEqual(verified.hashes, signed.map(keccak256));
    const receipts = [];
    for (const raw of signed) {
      const hash = await rpc('eth_sendRawTransaction', [raw]);
      let receipt;
      for (let n = 0; n < 100; n++) {
        receipt = await rpc('eth_getTransactionReceipt', [hash]);
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(receipt);
      assert.equal(receipt.status, '0x1');
      receipts.push({ hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    }
    const afterAsset = await call(asset, 'balanceOf', [signer]);
    const afterShares = await call(vault, 'balanceOf', [signer]);
    if (action === 'deposit') {
      assert.equal(beforeAsset - afterAsset, amount);
      depositedShares = afterShares - beforeShares;
      assert.ok(depositedShares >= minimumShares);
    } else {
      assert.equal(beforeShares - afterShares, amount);
      assert.ok(afterAsset > beforeAsset);
    }
    evidence.push({
      action,
      amount: amount.toString(),
      minimumShares: minimumShares?.toString() ?? null,
      prepared,
      receipts,
      assetDelta: (afterAsset - beforeAsset).toString(),
      shareDelta: (afterShares - beforeShares).toString(),
    });
    console.error(`Morpho ${action} passed (${receipts.length} local transactions)`);
  }
  console.log(
    JSON.stringify(
      {
        scope:
          'local fork only; actual deployed contracts, keyring signatures, Rust preparation/envelope verification; no API worker or production approval implied',
        policy,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  key.fill(0);
  assert.equal(await rpc('evm_revert', [snapshot]), true);
}
