// Independent viem ABI encoding for Rust/TypeScript decoder parity. Synthetic public
// addresses/signatures only; these are NOT Trading API or on-chain execution evidence.
import { writeFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';

const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const input = a(20),
  output = a(30),
  middle = a(25),
  user = a(10),
  router = a(40),
  receiver = a(50);
const deadline = '1900000300',
  signature = `0x${'11'.repeat(65)}`;
const abi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const call = (commands, inputs) =>
  encodeFunctionData({ abi, functionName: 'execute', args: [commands, inputs, BigInt(deadline)] });
const pair = (commands, inputs) => enc('bytes, bytes[]', [commands, inputs]);
const v2 = (payer = true) =>
  enc('address, uint256, uint256, address[], bool, uint256[]', [
    a(2),
    1000n,
    1900n,
    [input, output],
    payer,
    [10n ** 36n],
  ]);
const v2Expected = (payerIsUser = true) => ({
  kind: 'v2_exact_in',
  recipient: a(2),
  amountInRaw: '1000',
  minimumOutRaw: '1900',
  path: [input, output],
  payerIsUser,
  minHopPrices: [(10n ** 36n).toString()],
});
const payment = (token, recipient, value) =>
  enc('address, address, uint256', [token, recipient, value]);
const permit = enc(
  '((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes',
  [[[input, 1000n, 1900000400, 7], router, BigInt(deadline)], signature],
);
const sweep = payment(output, a(1), 1880n);
const sweepExpected = { kind: 'sweep', token: output, recipient: a(1), minimumRaw: '1880' };
const valid = [];
function add(name, commands, inputs, decoded) {
  valid.push({ name, data: call(commands, inputs), expected: { deadline, commands: decoded } });
}
add(
  'permit_v2_portion_sweep',
  '0x0a080604',
  [permit, v2(), payment(output, receiver, 100n), sweep],
  [
    {
      kind: 'permit_single',
      token: input,
      amountRaw: '1000',
      expiration: '1900000400',
      nonce: '7',
      spender: router,
      sigDeadline: deadline,
      signature,
    },
    v2Expected(),
    { kind: 'pay_portion', token: output, recipient: receiver, bps: '100' },
    sweepExpected,
  ],
);
const v3Path = `${input}000bb8${middle.slice(2)}0001f4${output.slice(2)}`;
const v3 = enc('address,uint256,uint256,bytes,bool,uint256[]', [
  a(2),
  1000n,
  1900n,
  v3Path,
  true,
  [],
]);
add(
  'v3_multihop_full_precision_fee',
  '0x000704',
  [v3, payment(output, receiver, 10n ** 16n), sweep],
  [
    {
      kind: 'v3_exact_in',
      recipient: a(2),
      amountInRaw: '1000',
      minimumOutRaw: '1900',
      path: [
        { tokenIn: input, tokenOut: middle, fee: 3000 },
        { tokenIn: middle, tokenOut: output, fee: 500 },
      ],
      payerIsUser: true,
      minHopPrices: [],
    },
    {
      kind: 'pay_portion_full_precision',
      token: output,
      recipient: receiver,
      portion: (10n ** 16n).toString(),
    },
    sweepExpected,
  ],
);
add(
  'prepay_router_v2_fixed_transfer',
  '0x02080504',
  [payment(input, a(2), 1000n), v2(false), payment(output, receiver, 20n), sweep],
  [
    { kind: 'transfer_from', token: input, recipient: a(2), amountRaw: '1000' },
    v2Expected(false),
    { kind: 'transfer', token: output, recipient: receiver, amountRaw: '20' },
    sweepExpected,
  ],
);
const singleType =
  '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)';
const single = (hooks = a(0), spacing = 60) =>
  enc(singleType, [[[input, output, 3000, spacing, hooks], true, 1000n, 1900n, 0n, '0x']]);
const all = (token, amount) => enc('address,uint256', [token, amount]);
add(
  'v4_single_settle_take_all',
  '0x10',
  [pair('0x060c0f', [single(), all(input, 1000n), all(output, 1900n)])],
  [
    {
      kind: 'v4',
      actions: [
        {
          kind: 'exact_in',
          tokenIn: input,
          path: [{ tokenOut: output, fee: 3000, tickSpacing: 60 }],
          amountInRaw: '1000',
          minimumOutRaw: '1900',
          minHopPrices: ['0'],
        },
        { kind: 'settle_all', token: input, maximumRaw: '1000' },
        { kind: 'take_all', token: output, minimumRaw: '1900' },
      ],
    },
  ],
);
const multi = enc(
  '(address currencyIn,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint256[] minHopPriceX36,uint128 amountIn,uint128 amountOutMinimum)',
  [
    [
      input,
      [
        [middle, 500, 10, a(0), '0x'],
        [output, 3000, 60, a(0), '0x'],
      ],
      [0n, 0n],
      1000n,
      1900n,
    ],
  ],
);
add(
  'v4_multihop_settle_portion_take',
  '0x10',
  [
    pair('0x070b100e', [
      multi,
      enc('address,uint256,bool', [input, 0n, true]),
      payment(output, receiver, 100n),
      payment(output, a(1), 0n),
    ]),
  ],
  [
    {
      kind: 'v4',
      actions: [
        {
          kind: 'exact_in',
          tokenIn: input,
          path: [
            { tokenOut: middle, fee: 500, tickSpacing: 10 },
            { tokenOut: output, fee: 3000, tickSpacing: 60 },
          ],
          amountInRaw: '1000',
          minimumOutRaw: '1900',
          minHopPrices: ['0', '0'],
        },
        { kind: 'settle', token: input, amountRaw: '0', payerIsUser: true },
        { kind: 'take_portion', token: output, recipient: receiver, bps: '100' },
        { kind: 'take', token: output, recipient: a(1), amountRaw: '0' },
      ],
    },
  ],
);
const word = (data, i, value) =>
  `${data.slice(0, 2 + 64 * i)}${BigInt(value).toString(16).padStart(64, '0')}${data.slice(2 + 64 * (i + 1))}`;
const invalid = [];
const bad = (name, commands, inputs) => invalid.push({ name, data: call(commands, inputs) });
for (const op of ['88', '48', '09', '21', '40', '0b', '03'])
  bad(`unsupported_opcode_${op}`, `0x${op}`, [v2()]);
bad('legacy_five_field_v2', '0x08', [
  enc('address,uint256,uint256,address[],bool', [user, 1000n, 1900n, [input, output], true]),
]);
const paddingAt = 2 + (192 + 32 + 66) * 2;
bad('dirty_dynamic_padding', '0x00', [`${v3.slice(0, paddingAt)}01${v3.slice(paddingAt + 2)}`]);
bad('boolean_two', '0x08', [word(v2(), 4, 2)]);
bad('dirty_address', '0x08', [word(v2(), 0, 1n << 160n)]);
bad('aliased_dynamic_tail', '0x08', [word(v2(), 5, 192)]);
bad('unaligned_offset', '0x08', [word(v2(), 3, 193)]);
bad('trailing_input_word', '0x08', [`${v2()}${'00'.repeat(32)}`]);
bad('wrong_hop_prices_length', '0x08', [
  enc('address,uint256,uint256,address[],bool,uint256[]', [
    user,
    1n,
    1n,
    [input, output],
    true,
    [0n, 0n],
  ]),
]);
bad('v4_hooked_pool', '0x10', [pair('0x06', [single(receiver)])]);
bad('v4_negative_spacing', '0x10', [pair('0x06', [single(a(0), -1)])]);
bad('v4_zero_spacing', '0x10', [pair('0x06', [single(a(0), 0)])]);
bad('v4_exact_output', '0x10', [pair('0x08', [single()])]);
bad('v4_uint128_overflow', '0x10', [pair('0x06', [word(single(), 7, 1n << 128n)])]);
bad('v4_nested_offset_alias', '0x10', [pair('0x07', [word(multi, 2, 0)])]);
bad('permit_nonce_overflow', '0x0a', [word(permit, 3, 1n << 48n)]);
bad('permit_amount_overflow', '0x0a', [word(permit, 1, 1n << 160n)]);
bad('sweep_uint160_overflow', '0x04', [payment(output, user, 1n << 160n)]);
invalid.push({ name: 'different_entrypoint', data: `0x24856bc3${valid[0].data.slice(10)}` });
invalid.push({
  name: 'outer_alias',
  data: word(
    valid[0].data.slice(0, 10) === '0x3593564c' ? `0x${valid[0].data.slice(10)}` : '',
    1,
    96,
  ),
});
invalid[invalid.length - 1].data = `0x3593564c${invalid[invalid.length - 1].data.slice(2)}`;
invalid.push({ name: 'outer_suffix', data: `${valid[0].data}${'00'.repeat(32)}` });
bad('command_input_count', '0x0808', [v2()]);
const artifact = {
  sourceCommit: '802fe4c18f47300e0f183e2a42e9146ec2ea9fc3',
  encoder: 'viem 2.57.2',
  provenance:
    'Synthetic ABI encodings; signatures are invalid public placeholders. No provider/on-chain acceptance.',
  valid,
  invalid,
};
writeFileSync(
  new URL('../../api-client/src/fixtures/uniswap-router.json', import.meta.url),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
