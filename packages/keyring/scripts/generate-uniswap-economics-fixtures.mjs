// Synthetic, independent ABI encoder. No RPC, signing or funds. Expected economic
// bounds are specified here, without importing either verifier implementation.
import { writeFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';

const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const owner = a(10),
  router = a(40),
  input = a(20),
  output = a(30),
  middle = a(25),
  fee1 = a(50),
  fee2 = a(60);
const now = 1900000000,
  deadline = `${now + 300}`,
  FULL = 1n << 255n;
const enc = (type, args) => encodeAbiParameters(parseAbiParameters(type), args);
const abi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
const call = (commands) => ({
  chainId: '1',
  from: owner,
  to: router,
  valueRaw: '0',
  data: encodeFunctionData({
    abi,
    functionName: 'execute',
    args: [
      `0x${commands.map(([op]) => op.toString(16).padStart(2, '0')).join('')}`,
      commands.map(([, data]) => data),
      BigInt(deadline),
    ],
  }),
});
const v2 = (
  amount = 1000n,
  minimum = 1900n,
  path = [input, output],
  payer = true,
  recipient = a(1),
) => [
  8,
  enc('address,uint256,uint256,address[],bool,uint256[]', [
    recipient,
    amount,
    minimum,
    path,
    payer,
    [],
  ]),
];
const v3 = (
  amount = 1000n,
  minimum = 1900n,
  path = [input, output],
  payer = true,
  recipient = a(1),
) => [
  0,
  enc('address,uint256,uint256,bytes,bool,uint256[]', [
    recipient,
    amount,
    minimum,
    `${path[0]}${path
      .slice(1)
      .map((token) => `000bb8${token.slice(2)}`)
      .join('')}`,
    payer,
    [],
  ]),
];
const pay = (op, token, recipient, amount) => [
  op,
  enc('address,address,uint256', [token, recipient, amount]),
];
const sweep = (token, minimum = 0n, recipient = a(1)) => pay(4, token, recipient, minimum);
const v4 = (actions) => [
  16,
  enc('bytes,bytes[]', [
    `0x${actions.map(([op]) => op.toString(16).padStart(2, '0')).join('')}`,
    actions.map(([, data]) => data),
  ]),
];
const swap4 = (token = input, target = output, amount = 1000n, minimum = 1900n) => [
  7,
  enc(
    '(address currencyIn,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint256[] minHopPriceX36,uint128 amountIn,uint128 amountOutMinimum)',
    [[token, [[target, 3000, 60, a(0), '0x']], [], amount, minimum]],
  ),
];
const settle = (token, amount = 0n, payer = true) => [
  11,
  enc('address,uint256,bool', [token, amount, payer]),
];
const settleAll = (token, maximum) => [12, enc('address,uint256', [token, maximum])];
const take = (token, recipient = a(1), amount = 0n) => pay(14, token, recipient, amount);
const takeAll = (token, minimum = 0n) => [15, enc('address,uint256', [token, minimum])];
const base = {
  feeBasis: 'settlement_balance',
  chainId: '1',
  owner,
  router,
  tokenIn: input,
  tokenOut: output,
  maximumInputRaw: '1000',
  minimumOutputRaw: '1900',
  deadline,
  tokens: [input, middle, output],
  fees: [],
};
const fee = (recipient = fee1, bps = '100', rounding = '0') => ({
  recipient,
  maximumBps: bps,
  maximumRoundingRaw: rounding,
});
const proof = (minimum = '1900', refundTokens = [], feeRecipients = []) => ({
  maximumDebitRaw: '1000',
  guaranteedOutputRaw: minimum,
  refundTokens: [...refundTokens].sort(),
  feeRecipients: [...feeRecipients].sort(),
});
const valid = [];
const add = (name, commands, policy = base, expected = proof()) => {
  const f = { name, policy: structuredClone(policy), call: call(commands), expected };
  valid.push(f);
  return f;
};
const direct = add('v2_direct', [v2()]);
add('v3_direct', [v3()]);
add(
  'v3_intermediate_refund',
  [v3(1000n, 1900n, [input, middle, output]), sweep(middle)],
  base,
  proof('1900', [middle]),
);
const feeRoute = [
  v2(1000n, 2000n, [input, output], true, a(2)),
  pay(6, output, fee1, 100n),
  sweep(output, 1900n),
];
const feeCase = add(
  'v2_gross_fee_net',
  feeRoute,
  { ...base, fees: [fee()] },
  proof('1980', [], [fee1]),
);
add(
  'fixed_fee',
  [v2(1000n, 2000n, [input, output], true, a(2)), pay(5, output, fee1, 20n), sweep(output, 1900n)],
  { ...base, fees: [fee()] },
  proof('1980', [], [fee1]),
);
add('prepaid_v2', [pay(2, input, a(2), 1000n), v2(1000n, 1900n, [input, output], false)], base);
add(
  'prepaid_v3_partial_fill_refund',
  [pay(2, input, a(2), 1000n), v3(FULL, 1900n, [input, output], false), sweep(input)],
  base,
  proof('1900', [input]),
);
add('v4_open_debt', [v4([swap4(), settle(input), takeAll(output, 1900n)])]);
add('v4_bounded_settle', [v4([swap4(), settleAll(input, 1000n), takeAll(output, 1900n)])]);
add(
  'v4_portion_fee',
  [
    v4([
      swap4(input, output, 1000n, 2000n),
      settle(input),
      pay(16, output, fee1, 100n),
      takeAll(output, 1900n),
    ]),
  ],
  { ...base, fees: [fee()] },
  proof('1980', [], [fee1]),
);
const split4 = (amount) =>
  v4([swap4(input, output, amount, 1000n), settle(input), take(output, a(2))]);
add(
  'split_v4_collected_router_fee',
  [split4(400n), split4(600n), pay(6, output, fee1, 100n), sweep(output, 1900n)],
  { ...base, fees: [fee()] },
  proof('1980', [], [fee1]),
);
add(
  'mixed_v2_v3_v4_with_full_balance_and_refund',
  [
    v2(400n, 700n, [input, middle], true, a(2)),
    v3(600n, 1100n, [input, middle], true, a(2)),
    v4([
      settle(middle, FULL, false),
      swap4(middle, output, 0n, 3400n),
      take(middle),
      takeAll(output, 3400n),
    ]),
  ],
  { ...base, minimumOutputRaw: '3400' },
  proof('3400', [middle]),
);
add('owner_full_portion', [
  v2(1000n, 1900n, [input, output], true, a(2)),
  pay(6, output, a(1), 10000n),
]);
const adjusted = 10101010101010101n;
const adjustedRoute = [
  v2(1000n, 100000n, [input, output], true, a(2)),
  pay(7, output, fee1, 10n ** 16n),
  pay(7, output, fee2, adjusted),
  sweep(output),
];
const adjustedPolicy = { ...base, fees: [fee(), fee(fee2, '100', '1')] };
add(
  'adjusted_second_portion_explicit_rounding_bound',
  adjustedRoute,
  adjustedPolicy,
  proof('98001', [], [fee1, fee2]),
);
const whole = (1n << 256n) - 1n;
add(
  'full_width_output_fee_arithmetic',
  [v2(1000n, whole, [input, output], true, a(2)), pay(7, output, fee1, 10n ** 16n), sweep(output)],
  { ...base, fees: [fee()] },
  proof((whole - whole / 100n).toString(), [], [fee1]),
);
const grossRates = [100n, 100n, 100n, 200n];
let previousBps = 0n;
const rates = grossRates.map((bps) => {
  const rate = (bps * 10n ** 18n) / (10000n - previousBps);
  previousBps += bps;
  return rate;
});
const feeRecipients = [fee1, fee2, a(70), a(80)];
let remaining = 100000n;
for (const rate of rates) remaining -= (remaining * rate) / 10n ** 18n;
add(
  'four_ordered_full_precision_fees',
  [
    v2(1000n, 100000n, [input, output], true, a(2)),
    ...rates.map((rate, i) => pay(7, output, feeRecipients[i], rate)),
    sweep(output),
  ],
  {
    ...base,
    fees: grossRates.map((bps, i) => fee(feeRecipients[i], bps.toString(), i === 0 ? '0' : '1')),
  },
  proof(remaining.toString(), [], feeRecipients),
);
const feeStress = {
  grossMinimum: '100000',
  netMinimum: remaining.toString(),
  rates: rates.map(String),
  grossBps: grossRates.map(String),
  rounding: ['0', '1', '1', '1'],
};
const invalid = [];
const bad = (name, commands, policy = base) =>
  invalid.push({ name, policy: structuredClone(policy), call: call(commands) });
for (const [field, value] of [
  ['from', a(70)],
  ['to', a(70)],
  ['chainId', '10'],
  ['valueRaw', '1'],
]) {
  const f = structuredClone(direct);
  delete f.expected;
  f.name = `wrong_call_${field}`;
  f.call[field] = value;
  invalid.push(f);
}
for (const [field, value] of [
  ['deadline', `${now + 301}`],
  ['maximumInputRaw', '999'],
  ['minimumOutputRaw', '1901'],
  ['tokenOut', middle],
  ['owner', a(1)],
  ['tokens', [input, output, output]],
]) {
  const f = structuredClone(direct);
  delete f.expected;
  f.name = `wrong_policy_${field}`;
  f.policy[field] = value;
  invalid.push(f);
}
bad('third_party_swap_recipient', [v2(1000n, 1900n, [input, output], true, a(70))]);
bad('double_user_input', [pay(2, input, a(2), 1000n), v2(), sweep(input)]);
bad('different_user_input_asset', [v2(1000n, 1900n, [middle, output])]);
bad('user_full_balance_has_no_fixed_cap', [v3(FULL)]);
bad('unfunded_router_payer', [v2(1000n, 1900n, [input, output], false)]);
bad('already_paid_pool_requires_separate_pair_proof', [v2(0n)]);
bad('missing_v3_intermediate_refund', [v3(1000n, 1900n, [input, middle, output])]);
bad('diverted_intermediate_refund', [
  v3(1000n, 1900n, [input, middle, output]),
  sweep(middle, 0n, a(70)),
]);
bad('missing_v3_input_refund', [
  pay(2, input, a(2), 1000n),
  v3(FULL, 1900n, [input, output], false),
]);
bad('output_left_in_router', [v2(1000n, 1900n, [input, output], true, a(2))]);
bad('no_receive_floor', [v2(1000n, 0n)]);
bad('fee_above_cap', [feeRoute[0], pay(6, output, fee1, 101n), feeRoute[2]], feeCase.policy);
bad('unexpected_fee', [...feeRoute]);
bad('missing_configured_fee', [v2()], feeCase.policy);
bad(
  'duplicate_fee',
  [...feeRoute.slice(0, 2), pay(6, output, fee1, 100n), feeRoute[2]],
  feeCase.policy,
);
bad(
  'fee_in_input_asset',
  [pay(2, input, a(2), 1000n), pay(6, input, fee1, 100n), v2(990n, 1900n, [input, output], false)],
  feeCase.policy,
);
bad(
  'fixed_fee_exceeds_rate_at_minimum',
  [v2(1000n, 1999n, [input, output], true, a(2)), pay(5, output, fee1, 20n), sweep(output)],
  feeCase.policy,
);
bad('swap_after_fee_phase', [feeRoute[0], feeRoute[1], v2(1n), feeRoute[2]], feeCase.policy);
bad('implicit_rounding_allowance', adjustedRoute, { ...adjustedPolicy, fees: [fee(), fee(fee2)] });
bad('unbounded_v4_extra_debt', [
  v4([swap4(input, output, 1001n), settle(input), takeAll(output, 1900n)]),
]);
bad('v4_wrong_payer_asset', [v4([swap4(middle), settle(middle), takeAll(output, 1900n)])]);
bad('v4_unsettled_input', [v4([swap4(), takeAll(output, 1900n)])]);
bad('v4_unclaimed_output', [v4([swap4(), settle(input)])]);
bad('v4_diverted_output', [v4([swap4(), settle(input), take(output, a(70))])]);
bad('v4_wrong_full_balance_payer', [
  v4([settle(input, FULL, true), swap4(input, output, 0n), takeAll(output, 1900n)]),
]);
bad(
  'v4_fee_cap',
  [
    v4([
      swap4(input, output, 1000n, 2000n),
      settle(input),
      pay(16, output, fee1, 101n),
      takeAll(output, 1900n),
    ]),
  ],
  feeCase.policy,
);
bad('unregistered_intermediate', [v3(1000n, 1900n, [input, a(99), output]), sweep(a(99))]);
bad('fee_policy_over_500bps', feeRoute, { ...base, fees: [fee(fee1, '501')] });
bad('rounding_requires_explicit_zero_or_one', feeRoute, { ...base, fees: [fee(fee1, '100', '2')] });
bad('output_sweep_cannot_invent_route_proceeds', [
  v2(1000n, 1n, [input, middle]),
  sweep(output, 1900n),
]);
writeFileSync(
  new URL('../../api-client/src/fixtures/uniswap-economics.json', import.meta.url),
  `${JSON.stringify({ provenance: 'Synthetic viem 2.57.2 calldata and manually derived conditional economic bounds; no provider or on-chain execution.', now, valid, invalid, feeStress }, null, 2)}\n`,
);
