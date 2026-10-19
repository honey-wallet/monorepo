// Actual-contract acceptance on an independently started disposable Anvil fork.
// No URL/key/env arguments. All writes go ONLY to literal localhost, chain 31337.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { permit2TypedData, validateEmbeddedPermit } from '../../api-client/src/permit2.ts';
import { validateSwapEconomics } from '../../api-client/src/uniswap-economics.ts';
import { decodeUniswapRouterCall } from '../../api-client/src/uniswap-router.ts';
import { evmAddressOfKey, signEvmTransaction, signEvmTypedData } from '../src/sign.ts';

const binary = fileURLToPath(
  new URL('../../../target/debug/examples/uniswap_fork_verify', import.meta.url),
);
const rpcResult = async (method, params = []) => {
  const response = await fetch('http://127.0.0.1:28545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(45000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  return response.json();
};
const rpc = async (method, params = []) => {
  const r = await rpcResult(method, params);
  assert.equal(r.error, undefined, `RPC ${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const bridge = (input, accepted = true) => {
  const r = spawnSync(binary, [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(r.error, undefined);
  if (!accepted) {
    assert.notEqual(r.status, 0, 'server must reject mutation');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const tokenIn = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const tokenOut = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const funder = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const router = '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85';
const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const quoters = {
  v2: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  v3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  v4: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
};
const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);
const permitAbi = parseAbi([
  'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
  'function permit(address,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes)',
]);
const v2Abi = parseAbi(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
const v3Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)',
]);
const v4Abi = parseAbi([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256,uint256)',
]);
const read = async (to, contractAbi, functionName, args) =>
  decodeFunctionResult({
    abi: contractAbi,
    functionName,
    data: await rpc('eth_call', [
      { to, data: encodeFunctionData({ abi: contractAbi, functionName, args }) },
      'latest',
    ]),
  });
const balance = (token, owner) => read(token, abi, 'balanceOf', [owner]);
const enc = (types, args) => encodeAbiParameters(parseAbiParameters(types), args);
const payment = (op, token, recipient, amount) => [
  op,
  enc('address,address,uint256', [token, recipient, amount]),
];
const amount = 1000000n;
const key = new Uint8Array(32);
key[31] = 1; // Public fixture scalar, never a user wallet.
const owner = evmAddressOfKey(key).toLowerCase();
const receipt = async (hash) => {
  let r;
  for (let attempt = 0; attempt < 100; attempt++) {
    r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(r, 'Anvil automine receipt missing');
  assert.equal(r.status, '0x1');
  assert.equal(r.transactionHash, hash);
  return r;
};
const send = async (to, data) => {
  assert.equal(await rpc('eth_chainId'), '0x7a69');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const raw = await signEvmTransaction(key, {
    type: 'eip1559',
    chainId: 31337,
    nonce: Number(BigInt(await rpc('eth_getTransactionCount', [owner, 'pending']))),
    gas: 1500000n,
    maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    to,
    data,
    value: 0n,
  });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  assert.equal(hash, keccak256(raw));
  return receipt(hash);
};
assert.match(await rpc('web3_clientVersion'), /^anvil\//);
assert.equal(await rpc('eth_chainId'), '0x7a69');
const forkBlock = await rpc('eth_getBlockByNumber', ['latest', false]);
assert.equal(BigInt(forkBlock.number), 26218343n, 'start a fresh fork at the documented block');
const snapshot = await rpc('evm_snapshot');
const evidence = [];
try {
  const codeHashes = {};
  for (const address of [router, permit2, tokenIn, tokenOut, ...Object.values(quoters)]) {
    const code = await rpc('eth_getCode', [address, 'latest']);
    assert.ok(code.length > 2, `missing contract ${address}`);
    codeHashes[address] = keccak256(code);
  }
  // Public scalar has delegated code on mainnet; this fixture models an ordinary EOA.
  await rpc('anvil_setCode', [owner, '0x']);
  await rpc('anvil_setBalance', [owner, '0xde0b6b3a7640000']);
  await rpc('anvil_setBalance', [funder, '0xde0b6b3a7640000']);
  await rpc('anvil_impersonateAccount', [funder]);
  try {
    await receipt(
      await rpc('eth_sendTransaction', [
        {
          from: funder,
          to: tokenIn,
          gas: '0x30d40',
          data: encodeFunctionData({ abi, functionName: 'transfer', args: [owner, amount * 10n] }),
        },
      ]),
    );
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [funder]);
  }
  for (const scenario of [
    'v2_direct',
    'v3_direct',
    'v4_direct',
    'v3_two_fees',
    'v4_fee',
    'v3_prepaid_refund',
    'mixed_split_fees',
  ]) {
    console.error(`Actual router acceptance: ${scenario}`);
    const caseSnapshot = await rpc('evm_snapshot');
    try {
      await send(
        tokenIn,
        encodeFunctionData({ abi, functionName: 'approve', args: [permit2, amount] }),
      );
      const mixed = scenario === 'mixed_split_fees';
      const protocol = scenario.slice(0, 2);
      const quote = async (protocol, input) =>
        protocol === 'v2'
          ? (await read(quoters.v2, v2Abi, 'getAmountsOut', [input, [tokenIn, tokenOut]]))[1]
          : protocol === 'v3'
            ? (
                await read(quoters.v3, v3Abi, 'quoteExactInputSingle', [
                  [tokenIn, tokenOut, input, 3000, 0n],
                ])
              )[0]
            : (
                await read(quoters.v4, v4Abi, 'quoteExactInputSingle', [
                  [[tokenIn, tokenOut, 500, 10, a(0)], true, input, '0x'],
                ])
              )[0];
      const allocations = mixed ? [300000n, 300000n, 400000n] : [amount];
      const quotes = [];
      for (let i = 0; i < allocations.length; i++)
        quotes.push(await quote(mixed ? `v${i + 2}` : protocol, allocations[i]));
      const quoted = quotes.reduce((a, b) => a + b, 0n);
      assert.ok(quoted > 100n);
      const grossMinimum = quotes.reduce((a, b) => a + (b * 99n) / 100n, 0n);
      const feeCount = scenario === 'v3_two_fees' || mixed ? 2 : scenario === 'v4_fee' ? 1 : 0;
      const minimum = (grossMinimum * BigInt(100 - feeCount)) / 100n;
      const now = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
      const deadline = `${now + 600}`;
      const priorAllowance = await read(permit2, permitAbi, 'allowance', [owner, tokenIn, router]);
      const terms = {
        chainId: '31337',
        permit2,
        owner,
        token: tokenIn,
        amountRaw: amount.toString(),
        spender: router,
        nonce: priorAllowance[2].toString(),
        expiration: deadline,
        sigDeadline: deadline,
      };
      const typed = permit2TypedData(terms, now);
      const signature = await signEvmTypedData(key, typed);
      const permitCommand = [
        10,
        enc('((address,uint160,uint48,uint48),address,uint256),bytes', [
          [[tokenIn, amount, Number(deadline), Number(terms.nonce)], router, BigInt(deadline)],
          signature,
        ]),
      ];
      const prepaid = scenario === 'v3_prepaid_refund';
      const route = [permitCommand];
      if (prepaid) route.push([2, enc('address,address,uint160', [tokenIn, a(2), amount])]);
      for (let i = 0; i < allocations.length; i++) {
        const part = mixed ? `v${i + 2}` : protocol;
        const input = allocations[i];
        const outputFloor = (quotes[i] * 99n) / 100n;
        if (part === 'v4') {
          const actions = [
            [
              7,
              enc('(address,(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128)', [
                [tokenIn, [[tokenOut, 500, 10, a(0), '0x']], [], input, outputFloor],
              ]),
            ],
            [12, enc('address,uint256', [tokenIn, input])],
          ];
          if (mixed) actions.push(payment(14, tokenOut, a(2), 0n));
          else {
            if (feeCount) actions.push(payment(16, tokenOut, a(50), 100n));
            actions.push([15, enc('address,uint256', [tokenOut, minimum])]);
          }
          route.push([
            16,
            enc('bytes,bytes[]', [
              `0x${actions.map(([op]) => op.toString(16).padStart(2, '0')).join('')}`,
              actions.map(([, data]) => data),
            ]),
          ]);
        } else {
          route.push([
            part === 'v2' ? 8 : 0,
            enc(
              part === 'v2'
                ? 'address,uint256,uint256,address[],bool,uint256[]'
                : 'address,uint256,uint256,bytes,bool,uint256[]',
              [
                feeCount ? a(2) : a(1),
                input,
                outputFloor,
                part === 'v2' ? [tokenIn, tokenOut] : `${tokenIn}000bb8${tokenOut.slice(2)}`,
                !prepaid,
                [],
              ],
            ),
          ]);
        }
      }
      if (feeCount && protocol !== 'v4') {
        route.push(payment(6, tokenOut, a(50), 100n));
        route.push(payment(7, tokenOut, a(60), 1000000000000000000n / 99n));
        route.push(payment(4, tokenOut, a(1), minimum));
      }
      if (prepaid) route.push(payment(4, tokenIn, a(1), 0n));
      const encodeRoute = (commands, expiry = deadline) =>
        encodeFunctionData({
          abi,
          functionName: 'execute',
          args: [
            `0x${commands.map(([op]) => op.toString(16).padStart(2, '0')).join('')}`,
            commands.map(([, data]) => data),
            BigInt(expiry),
          ],
        });
      const call = {
        chainId: '31337',
        from: owner,
        to: router,
        valueRaw: '0',
        data: encodeRoute(route),
      };
      const policy = {
        feeBasis: 'settlement_balance',
        chainId: '31337',
        owner,
        router,
        tokenIn,
        tokenOut,
        maximumInputRaw: amount.toString(),
        minimumOutputRaw: minimum.toString(),
        deadline,
        tokens: [tokenIn, tokenOut],
        fees: Array.from({ length: feeCount }, (_, i) => ({
          recipient: a(i ? 60 : 50),
          maximumBps: '100',
          maximumRoundingRaw: i ? '1' : '0',
        })),
      };
      const input = { policy, call, terms, now };
      const clientProof = validateSwapEconomics(policy, call, now);
      validateEmbeddedPermit(decodeUniswapRouterCall(call.data), terms, signature, now);
      const server = bridge(input);
      assert.deepEqual(server.proof, clientProof);
      assert.equal(server.permitDigest, hashTypedData(JSON.parse(typed)));
      // Mutated review authority must never validate the same encoded transaction.
      for (const altered of [
        { ...policy, maximumInputRaw: (amount - 1n).toString() },
        { ...policy, minimumOutputRaw: (quoted * 2n).toString() },
        { ...policy, owner: a(77) },
      ]) {
        assert.throws(() => validateSwapEconomics(altered, call, now));
        bridge({ ...input, policy: altered }, false);
      }
      const before = {
        input: await balance(tokenIn, owner),
        output: await balance(tokenOut, owner),
        fees: await Promise.all(policy.fees.map((f) => balance(tokenOut, f.recipient))),
      };
      // Do not count incidental router assets as swap proceeds in this fixture.
      assert.equal(await balance(tokenIn, router), 0n);
      assert.equal(await balance(tokenOut, router), 0n);
      const transaction = { from: owner, to: router, data: call.data, value: '0x0' };
      const expectedRevert = async (data) => {
        const result = await rpcResult('eth_call', [{ ...transaction, data }, 'latest']);
        assert.ok(
          result.error && result.error.code === 3,
          'expected contract revert, not transport failure',
        );
      };
      const expired = { ...call, data: encodeRoute(route, `${now - 1}`) };
      assert.throws(() => validateSwapEconomics(policy, expired, now));
      bridge({ ...input, call: expired }, false);
      await expectedRevert(expired.data);
      const corruptPermit = [
        10,
        enc('((address,uint160,uint48,uint48),address,uint256),bytes', [
          [[tokenIn, amount, Number(deadline), Number(terms.nonce)], router, BigInt(deadline)],
          `${signature.slice(0, -2)}00`,
        ]),
      ];
      const corrupt = { ...call, data: encodeRoute([corruptPermit, ...route.slice(1)]) };
      // Economic proof alone cannot establish signature authority.
      validateSwapEconomics(policy, corrupt, now);
      assert.throws(() =>
        validateEmbeddedPermit(decodeUniswapRouterCall(corrupt.data), terms, signature, now),
      );
      bridge({ ...input, call: corrupt }, false);
      await expectedRevert(corrupt.data);
      if (scenario === 'v3_direct') {
        const impossibleMinimum = quoted * 2n;
        const impossible = {
          ...call,
          data: encodeRoute([
            permitCommand,
            [
              0,
              enc('address,uint256,uint256,bytes,bool,uint256[]', [
                a(1),
                amount,
                impossibleMinimum,
                `${tokenIn}000bb8${tokenOut.slice(2)}`,
                true,
                [],
              ]),
            ],
          ]),
        };
        const stronger = { ...policy, minimumOutputRaw: impossibleMinimum.toString() };
        // Correctly bounded terms can still be unfillable: simulation is mandatory.
        validateSwapEconomics(stronger, impossible, now);
        bridge({ ...input, policy: stronger, call: impossible });
        await expectedRevert(impossible.data);
      }
      assert.deepEqual(
        await read(permit2, permitAbi, 'allowance', [owner, tokenIn, router]),
        priorAllowance,
      );
      assert.equal(await balance(tokenIn, owner), before.input);
      assert.equal(await balance(tokenOut, owner), before.output);
      await rpc('eth_call', [transaction, 'latest']);
      const r = await send(router, call.data);
      const spent = before.input - (await balance(tokenIn, owner));
      const received = (await balance(tokenOut, owner)) - before.output;
      const fees = await Promise.all(
        policy.fees.map(async (f, i) => (await balance(tokenOut, f.recipient)) - before.fees[i]),
      );
      assert.equal(spent, amount);
      assert.ok(received >= BigInt(clientProof.guaranteedOutputRaw));
      assert.equal(received + fees.reduce((a, b) => a + b, 0n), quoted);
      fees.forEach((fee, i) => {
        assert.ok(fee <= quoted / 100n + BigInt(policy.fees[i].maximumRoundingRaw));
      });
      assert.equal(await balance(tokenIn, router), 0n);
      assert.equal(await balance(tokenOut, router), 0n);
      const afterAllowance = await read(permit2, permitAbi, 'allowance', [owner, tokenIn, router]);
      assert.equal(afterAllowance[0], 0n);
      assert.equal(afterAllowance[2], priorAllowance[2] + 1);
      assert.equal(await read(tokenIn, abi, 'allowance', [owner, permit2]), 0n);
      // Reusing the same valid permit must fail after its nonce is consumed.
      const replay = await rpcResult('eth_call', [transaction, 'latest']);
      assert.ok(replay.error && replay.error.code === 3, 'expected EVM replay revert');
      // Isolate Permit2 nonce rejection from the router's now-empty token allowance.
      const permitReplay = await rpcResult('eth_call', [
        {
          from: owner,
          to: permit2,
          data: encodeFunctionData({
            abi: permitAbi,
            functionName: 'permit',
            args: [
              owner,
              [[tokenIn, amount, Number(deadline), Number(terms.nonce)], router, BigInt(deadline)],
              signature,
            ],
          }),
        },
        'latest',
      ]);
      assert.equal(permitReplay.error?.code, 3);
      assert.equal(
        permitReplay.error.data,
        keccak256(new TextEncoder().encode('InvalidNonce()')).slice(0, 10),
      );
      evidence.push({
        scenario,
        quoteSource: 'on-chain quoter eth_call; not Trading API',
        quotedRaw: quoted.toString(),
        spentRaw: spent.toString(),
        receivedRaw: received.toString(),
        feeAmountsRaw: fees.map(String),
        proof: clientProof,
        permitDigest: server.permitDigest,
        calldataHash: keccak256(call.data),
        transactionHash: r.transactionHash,
        gasUsed: BigInt(r.gasUsed).toString(),
        permitNonceConsumed: true,
        replayReverted: true,
        permitReplayInvalidNonce: true,
        routerResidualsRaw: ['0', '0'],
        erc20ApprovalRemainingRaw: '0',
        permitAllowanceRemainingRaw: '0',
        authorityMutationsRejected: 3,
        expiredDeadlineReverted: true,
        corruptPermitReverted: true,
        unfillableMinimumReverted: scenario === 'v3_direct' ? true : null,
      });
    } finally {
      assert.equal(await rpc('evm_revert', [caseSnapshot]), true);
    }
  }
  console.log(
    JSON.stringify(
      {
        scope:
          'Local fork only; actual contracts, independent wallet/server validators. No provider HTTP, durable execution or production approval.',
        forkBlock: { number: BigInt(forkBlock.number).toString(), hash: forkBlock.hash },
        chainId: '31337',
        routerVersion: '2.1.2',
        codeHashes,
        scenarios: evidence,
      },
      null,
      2,
    ),
  );
} finally {
  key.fill(0);
  assert.equal(await rpc('evm_revert', [snapshot]), true);
  console.error('Owned fork state reverted; public fixture key buffer wiped.');
}
