/** Independent wallet-side ABI decoder for Universal Router 2.1.2.
 * A successful decode is NOT authority to sign. Intent, payments, contract pins,
 * permits and simulation require separate verification before a signing flow exists.
 */
export type V3Hop = { tokenIn: string; tokenOut: string; fee: number };
export type V4Hop = { tokenOut: string; fee: number; tickSpacing: number };
type SwapFields = {
  recipient: string;
  amountInRaw: string;
  minimumOutRaw: string;
  payerIsUser: boolean;
  minHopPrices: string[];
};
export type UniswapCommand =
  | ({ kind: 'v2_exact_in'; path: string[] } & SwapFields)
  | ({ kind: 'v3_exact_in'; path: V3Hop[] } & SwapFields)
  | { kind: 'v4'; actions: UniswapV4Action[] }
  | {
      kind: 'permit_single';
      token: string;
      amountRaw: string;
      expiration: string;
      nonce: string;
      spender: string;
      sigDeadline: string;
      signature: string;
    }
  | { kind: 'transfer_from' | 'transfer'; token: string; recipient: string; amountRaw: string }
  | { kind: 'sweep'; token: string; recipient: string; minimumRaw: string }
  | { kind: 'pay_portion'; token: string; recipient: string; bps: string }
  | { kind: 'pay_portion_full_precision'; token: string; recipient: string; portion: string };
export type UniswapV4Action =
  | {
      kind: 'exact_in';
      tokenIn: string;
      path: V4Hop[];
      amountInRaw: string;
      minimumOutRaw: string;
      minHopPrices: string[];
    }
  | { kind: 'settle'; token: string; amountRaw: string; payerIsUser: boolean }
  | { kind: 'settle_all'; token: string; maximumRaw: string }
  | { kind: 'take'; token: string; recipient: string; amountRaw: string }
  | { kind: 'take_all'; token: string; minimumRaw: string }
  | { kind: 'take_portion'; token: string; recipient: string; bps: string };
export type UniswapRouterExecution = { deadline: string; commands: UniswapCommand[] };
const LIMIT = 65536;
function invalid(): never {
  throw new Error('Unsupported or noncanonical Universal Router 2.1.2 calldata.');
}

// Hex-based decoder, independent of the Rust byte decoder. Only canonical abi.encode
// tails are accepted: no gaps, aliases, overlapping objects, dirty padding or suffixes.
class Tuple {
  end: number;
  readonly hex: string;
  readonly words: number;
  constructor(hex: string, words: number) {
    this.hex = hex;
    this.words = words;
    this.end = words * 32;
    if (hex.length / 2 < this.end || hex.length / 2 > LIMIT) invalid();
  }
  integer(i: number, bits = 256): bigint {
    if (i < 0 || i >= this.words) invalid();
    const n = BigInt(`0x${this.hex.slice(i * 64, (i + 1) * 64)}`);
    if (n >= 1n << BigInt(bits)) invalid();
    return n;
  }
  decimal(i: number, bits = 256): string {
    return this.integer(i, bits).toString();
  }
  size(i: number): number {
    const n = this.integer(i, 32);
    if (n > BigInt(LIMIT)) invalid();
    return Number(n);
  }
  address(i: number): string {
    return `0x${this.integer(i, 160).toString(16).padStart(40, '0')}`;
  }
  bool(i: number): boolean {
    return this.integer(i, 1) === 1n;
  }
  dynamic<T>(i: number, read: (tail: string) => [T, number]): T {
    if (this.size(i) !== this.end) invalid();
    const [value, used] = read(this.hex.slice(this.end * 2));
    this.end += used;
    if (this.end > this.hex.length / 2 || this.end % 32 !== 0) invalid();
    return value;
  }
  bytes(i: number): string {
    return this.dynamic(i, (tail) => {
      const size = new Tuple(tail, 1).size(0),
        end = 32 + Math.ceil(size / 32) * 32;
      if (end * 2 > tail.length || /[^0]/.test(tail.slice(64 + size * 2, end * 2))) invalid();
      return [tail.slice(64, 64 + size * 2), end];
    });
  }
  integers(i: number, max: number): string[] {
    return this.dynamic(i, (tail) => {
      const length = new Tuple(tail, 1).size(0);
      if (length > max) invalid();
      const values = new Tuple(tail.slice(64), length);
      return [Array.from({ length }, (_, n) => values.decimal(n)), 32 + values.end];
    });
  }
  byteArray(i: number): string[] {
    return this.dynamic(i, (tail) => {
      const length = new Tuple(tail, 1).size(0);
      if (!length || length > 64) invalid();
      const values = new Tuple(tail.slice(64), length);
      const result = Array.from({ length }, (_, n) => values.bytes(n));
      return [result, 32 + values.end];
    });
  }
  finish(): void {
    if (this.end * 2 !== this.hex.length) invalid();
  }
}
function prices(values: string[], hops: number): void {
  if (!hops || hops > 8 || (values.length !== 0 && values.length !== hops)) invalid();
}
function fee(n: bigint): number {
  if (n > 1_000_000n) invalid();
  return Number(n);
}
function spacing(t: Tuple, i: number): number {
  const n = t.integer(i, 24);
  if (!n || n > 32767n) invalid();
  return Number(n);
}
function noHooks(t: Tuple, i: number, data: string): void {
  if (t.integer(i, 160) !== 0n || data !== '') invalid();
}
function paired(hex: string, words: number) {
  const tuple = new Tuple(hex, words),
    commands = tuple.bytes(0),
    inputs = tuple.byteArray(1);
  tuple.finish();
  if (!commands.length || commands.length !== inputs.length * 2) invalid();
  return {
    tuple,
    commands: Array.from({ length: inputs.length }, (_, i) =>
      Number.parseInt(commands.slice(i * 2, i * 2 + 2), 16),
    ),
    inputs,
  };
}
export function decodeUniswapRouterCall(data: string): UniswapRouterExecution {
  if (
    typeof data !== 'string' ||
    data.length > 2 + LIMIT * 2 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(data)
  )
    invalid();
  const hex = data.slice(2).toLowerCase();
  if (hex.slice(0, 8) !== '3593564c') invalid();
  const { tuple, commands, inputs } = paired(hex.slice(8), 3);
  return {
    deadline: tuple.decimal(2),
    commands: commands.map((op, i) => command(op, inputs[i] as string)),
  };
}
function command(op: number, hex: string): UniswapCommand {
  if (op === 0 || op === 8) {
    const t = new Tuple(hex, 6);
    const shared = {
      recipient: t.address(0),
      amountInRaw: t.decimal(1),
      minimumOutRaw: t.decimal(2),
      payerIsUser: t.bool(4),
    };
    let result: UniswapCommand;
    if (op === 8) {
      const path = t.dynamic(3, (tail) => {
        const length = new Tuple(tail, 1).size(0);
        if (length < 2 || length > 9) invalid();
        const array = new Tuple(tail.slice(64), length);
        return [Array.from({ length }, (_, i) => array.address(i)), 32 + array.end];
      });
      const minHopPrices = t.integers(5, 8);
      prices(minHopPrices, path.length - 1);
      result = { kind: 'v2_exact_in', ...shared, path, minHopPrices };
    } else {
      const packed = t.bytes(3),
        length = packed.length / 2;
      if (length < 43 || (length - 20) % 23 !== 0 || (length - 20) / 23 > 8) invalid();
      const path: V3Hop[] = [];
      for (let at = 0; at < packed.length - 40; at += 46) {
        path.push({
          tokenIn: `0x${packed.slice(at, at + 40)}`,
          tokenOut: `0x${packed.slice(at + 46, at + 86)}`,
          fee: fee(BigInt(`0x${packed.slice(at + 40, at + 46)}`)),
        });
      }
      const minHopPrices = t.integers(5, 8);
      prices(minHopPrices, path.length);
      result = { kind: 'v3_exact_in', ...shared, path, minHopPrices };
    }
    t.finish();
    return result;
  }
  if (op === 2 || (op >= 4 && op <= 7)) {
    const t = new Tuple(hex, 3);
    t.finish();
    const fields = { token: t.address(0), recipient: t.address(1) };
    if (op === 2) return { kind: 'transfer_from', ...fields, amountRaw: t.decimal(2, 160) };
    if (op === 4) return { kind: 'sweep', ...fields, minimumRaw: t.decimal(2, 160) };
    if (op === 5) return { kind: 'transfer', ...fields, amountRaw: t.decimal(2) };
    if (op === 6) return { kind: 'pay_portion', ...fields, bps: t.decimal(2) };
    return { kind: 'pay_portion_full_precision', ...fields, portion: t.decimal(2) };
  }
  if (op === 10) {
    const t = new Tuple(hex, 7),
      sig = t.bytes(6);
    if (sig.length !== 128 && sig.length !== 130) invalid();
    t.finish();
    return {
      kind: 'permit_single',
      token: t.address(0),
      amountRaw: t.decimal(1, 160),
      expiration: t.decimal(2, 48),
      nonce: t.decimal(3, 48),
      spender: t.address(4),
      sigDeadline: t.decimal(5),
      signature: `0x${sig}`,
    };
  }
  if (op === 16) {
    const { commands, inputs } = paired(hex, 2);
    return { kind: 'v4', actions: commands.map((action, i) => v4(action, inputs[i] as string)) };
  }
  return invalid();
}
function v4(op: number, hex: string): UniswapV4Action {
  if (op === 6 || op === 7) {
    const outer = new Tuple(hex, 1);
    const action = outer.dynamic<UniswapV4Action>(0, (tail) => {
      if (op === 6) {
        const t = new Tuple(tail, 10),
          hookData = t.bytes(9);
        noHooks(t, 4, hookData);
        const c0 = t.address(0),
          c1 = t.address(1),
          forward = t.bool(5);
        if (c0 >= c1) invalid();
        return [
          {
            kind: 'exact_in',
            tokenIn: forward ? c0 : c1,
            path: [
              {
                tokenOut: forward ? c1 : c0,
                fee: fee(t.integer(2, 24)),
                tickSpacing: spacing(t, 3),
              },
            ],
            amountInRaw: t.decimal(6, 128),
            minimumOutRaw: t.decimal(7, 128),
            minHopPrices: [t.decimal(8)],
          },
          t.end,
        ];
      }
      const t = new Tuple(tail, 5);
      const path = t.dynamic<V4Hop[]>(1, (data) => {
        const length = new Tuple(data, 1).size(0);
        if (!length || length > 8) invalid();
        const array = new Tuple(data.slice(64), length);
        const hops = Array.from({ length }, (_, i) =>
          array.dynamic<V4Hop>(i, (data) => {
            const hop = new Tuple(data, 5),
              hookData = hop.bytes(4);
            noHooks(hop, 3, hookData);
            return [
              {
                tokenOut: hop.address(0),
                fee: fee(hop.integer(1, 24)),
                tickSpacing: spacing(hop, 2),
              },
              hop.end,
            ];
          }),
        );
        return [hops, 32 + array.end];
      });
      const minHopPrices = t.integers(2, 8);
      prices(minHopPrices, path.length);
      return [
        {
          kind: 'exact_in',
          tokenIn: t.address(0),
          path,
          amountInRaw: t.decimal(3, 128),
          minimumOutRaw: t.decimal(4, 128),
          minHopPrices,
        },
        t.end,
      ];
    });
    outer.finish();
    return action;
  }
  if (op >= 11 && op <= 16 && op !== 13) {
    const t = new Tuple(hex, op === 12 || op === 15 ? 2 : 3);
    t.finish();
    const token = t.address(0);
    if (op === 11)
      return { kind: 'settle', token, amountRaw: t.decimal(1), payerIsUser: t.bool(2) };
    if (op === 12) return { kind: 'settle_all', token, maximumRaw: t.decimal(1) };
    if (op === 14) return { kind: 'take', token, recipient: t.address(1), amountRaw: t.decimal(2) };
    if (op === 15) return { kind: 'take_all', token, minimumRaw: t.decimal(1) };
    return { kind: 'take_portion', token, recipient: t.address(1), bps: t.decimal(2) };
  }
  return invalid();
}
