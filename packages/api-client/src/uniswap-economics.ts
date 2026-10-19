/** Independent conditional-on-success proof. No key access, RPC, signatures or
 * execution admission. The service must also verify contract identity, permit
 * nonce/signature, simulation and immutable intent before requesting any signature.
 */
import { address, object, uint } from './evm-signing';
import { validateSwapQuote } from './swaps';
import type {
  SwapAuthority,
  SwapEconomicProof,
  SwapQuote,
  SwapQuoteConfiguration,
  SwapRouterCall,
} from './types';
import { decodeUniswapRouterCall, type UniswapV4Action } from './uniswap-router';

const MAX = (1n << 256n) - 1n,
  FULL = 1n << 255n,
  MAX_INPUT = (1n << 160n) - 1n;
const SENDER = '0x0000000000000000000000000000000000000001',
  ROUTER = '0x0000000000000000000000000000000000000002';

/** Convert a fresh reviewed quote into immutable public authority. The caller must
 * obtain explicit review of any nonzero rounding allowance; no allowance is inferred.
 * This prepares public terms only and neither signs nor enables an execution route.
 */
export function swapAuthorityFromQuote(
  quote: SwapQuote,
  configuration: SwapQuoteConfiguration,
  signer: string,
  options: { deadline: string; maximumFeeRoundingRaw: '0' | '1' },
  nowMs = Date.now(),
): SwapAuthority {
  validateSwapQuote(
    quote,
    configuration,
    {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountRaw: quote.amountInRaw,
      slippageBps: quote.slippageBps,
    },
    signer,
    nowMs,
  );
  const now = Math.floor(nowMs / 1000),
    deadline = n(options.deadline);
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    now > Number.MAX_SAFE_INTEGER - 1800 ||
    deadline <= BigInt(now) ||
    deadline > BigInt(now + 1800) ||
    !['0', '1'].includes(options.maximumFeeRoundingRaw)
  )
    fail('policy');
  return {
    chainId: quote.chainId,
    owner: signer.toLowerCase(),
    router: configuration.router,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    maximumInputRaw: quote.amountInRaw,
    minimumOutputRaw: quote.minimumOutputRaw,
    deadline: options.deadline,
    feeBasis: 'settlement_balance',
    tokens: configuration.tokens.map((t) => t.address),
    fees: configuration.integratorFees.map((f) => ({
      recipient: f.recipient,
      maximumBps: String(f.bps),
      maximumRoundingRaw: options.maximumFeeRoundingRaw,
    })),
  };
}
type Kind =
  | 'policy'
  | 'encoding'
  | 'deadline'
  | 'recipient'
  | 'spend'
  | 'flow'
  | 'fees'
  | 'minimum'
  | 'refund';
function fail(kind: Kind): never {
  throw new Error(`Uniswap economic validation failed: ${kind}.`);
}
function n(s: unknown): bigint {
  if (!uint(s)) fail('policy');
  return BigInt(s);
}
function add(a: bigint, b: bigint): bigint {
  const v = a + b;
  if (v > MAX) fail('flow');
  return v;
}
function mul(a: bigint, b: bigint): bigint {
  const v = a * b;
  if (v > MAX) fail('fees');
  return v;
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const sub = (a: bigint, b: bigint) => max(0n, a - b);
function fraction(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n || numerator > denominator) fail('fees');
  return add(
    mul(value / denominator, numerator),
    mul(value % denominator, numerator) / denominator,
  );
}
function realAddress(v: unknown): v is string {
  return address(v) && BigInt(v) > 2n;
}
type Balance = { low: bigint; high: bigint | null };
const exact = (v: bigint): Balance => ({ low: v, high: v });
const unknown = (v: bigint): Balance => ({ low: v, high: null });
const possible = (v: Balance) => v.high !== 0n;
type Delta = { debt: bigint; credit: bigint; owned: boolean };
const deltaClear = (v: Delta) => {
  v.debt = 0n;
  v.credit = 0n;
  v.owned = false;
};
function deltaAdd(v: Delta, amount: bigint): void {
  const cancel = min(amount, v.debt);
  v.debt -= cancel;
  v.credit = add(v.credit, amount - cancel);
  v.owned = true;
}
function deltaSpend(v: Delta, amount: bigint): void {
  const cancel = min(amount, v.credit);
  v.credit -= cancel;
  v.debt = add(v.debt, amount - cancel);
}
class Proof {
  readonly policy: SwapAuthority;
  debit = 0n;
  output = 0n;
  readonly balances = new Map<string, Balance>();
  readonly refunds = new Set<string>();
  readonly paid = new Set<string>();
  feeSource: string | null = null;
  ratio = 1n;
  error = 0n;
  denominator = 1n;
  swaps = 0;
  constructor(policy: SwapAuthority) {
    this.policy = policy;
  }
  token(token: string): void {
    if (!this.policy.tokens.includes(token)) fail('flow');
  }
  recipient(v: string): string {
    return v === SENDER ? this.policy.owner : v === ROUTER ? this.policy.router : v;
  }
  userDebit(token: string, amount: bigint): void {
    if (token !== this.policy.tokenIn || amount >= MAX_INPUT) fail('spend');
    this.debit = add(this.debit, amount);
    if (this.debit > n(this.policy.maximumInputRaw)) fail('spend');
  }
  incoming(token: string, value: Balance): void {
    this.token(token);
    if (token === this.policy.tokenOut && this.feeSource === 'router') fail('fees');
    const old = this.balances.get(token) ?? exact(0n);
    this.balances.set(token, {
      low: add(old.low, value.low),
      high: old.high !== null && value.high !== null ? add(old.high, value.high) : null,
    });
  }
  consume(token: string, amount: bigint, partial: boolean): Balance {
    this.token(token);
    const value = this.balances.get(token);
    if (!value || !possible(value)) fail('flow');
    if (amount === FULL) {
      const taken = { ...value };
      this.balances.set(token, partial ? { low: 0n, high: value.high } : exact(0n));
      return taken;
    }
    if (value.high !== null && amount > value.high) fail('flow');
    value.low = sub(value.low, amount);
    if (!partial && value.high !== null) value.high -= amount;
    return exact(amount);
  }
  receive(token: string, value: Balance, target: string): void {
    this.token(token);
    const recipient = this.recipient(target);
    if (recipient === this.policy.router) {
      this.incoming(token, value);
      return;
    }
    if (recipient !== this.policy.owner) fail('recipient');
    if (token === this.policy.tokenOut) this.output = add(this.output, value.low);
    else this.refunds.add(token);
  }
  swap(
    path: string[],
    amount: bigint,
    minimum: bigint,
    payer: boolean,
    recipient: string,
    v3: boolean,
  ): void {
    const first = path[0],
      last = path[path.length - 1];
    if (
      this.feeSource !== null ||
      path.length < 2 ||
      path.length > 9 ||
      !first ||
      !last ||
      first === last ||
      amount === 0n
    )
      fail('flow');
    for (const token of path) this.token(token);
    if (path.some((token, i) => i > 0 && token === path[i - 1])) fail('flow');
    if (++this.swaps > 64) fail('flow');
    if (payer) this.userDebit(first, amount);
    else this.consume(first, amount, v3);
    if (v3) for (const token of path.slice(1, -1)) this.incoming(token, unknown(0n));
    this.receive(last, unknown(minimum), recipient);
  }
  charge(
    location: string,
    token: string,
    recipient: string,
    low: bigint,
    rate: [bigint, bigint] | null,
    fixed: bigint,
  ): void {
    if (
      token !== this.policy.tokenOut ||
      (this.feeSource !== null && this.feeSource !== location) ||
      this.paid.has(recipient)
    )
      fail('fees');
    const fee = this.policy.fees.find((f) => f.recipient === recipient);
    if (!fee) fail('recipient');
    const bps = n(fee.maximumBps),
      rounding = n(fee.maximumRoundingRaw);
    if (rate === null) {
      if (fixed > add(fraction(low, bps, 10000n), rounding)) fail('fees');
    } else {
      const [num, den] = rate;
      if (num === 0n || num > den) fail('fees');
      const nextDen = mul(this.denominator, den),
        feeRatio = mul(this.ratio, num),
        error = mul(this.error, num);
      if (mul(feeRatio, 10000n) > mul(bps, nextDen)) fail('fees');
      if (mul(num, 10000n) > mul(bps, den)) {
        const ceiling = error / nextDen + (error % nextDen !== 0n ? 1n : 0n);
        if (ceiling > rounding) fail('fees');
      }
      this.ratio = mul(this.ratio, den - num);
      this.error = add(mul(this.error, den - num), nextDen);
      this.denominator = nextDen;
    }
    this.feeSource = location;
    this.paid.add(recipient);
  }
  routerPayment(
    token: string,
    target: string,
    amount: bigint,
    rate: [bigint, bigint] | null,
    sweep: boolean,
  ): void {
    this.token(token);
    const recipient = this.recipient(target);
    if (recipient === this.policy.router) fail('recipient');
    const balance = this.balances.get(token) ?? exact(0n);
    if (recipient !== this.policy.owner) {
      if (!possible(balance) || sweep || amount === FULL) fail('fees');
      this.charge('router', token, recipient, balance.low, rate, amount);
    }
    if (rate) {
      const [num, den] = rate,
        paid = fraction(balance.low, num, den);
      this.balances.set(
        token,
        num === den
          ? exact(0n)
          : {
              low: balance.low - paid,
              high: balance.high === null ? null : balance.high - fraction(balance.high, num, den),
            },
      );
      if (recipient === this.policy.owner) this.receive(token, unknown(paid), recipient);
    } else if (sweep || amount === FULL) {
      if (!possible(balance) && amount !== 0n && amount !== FULL) fail('flow');
      this.balances.set(token, exact(0n));
      this.receive(token, unknown(sweep ? max(balance.low, amount) : balance.low), recipient);
    } else {
      this.consume(token, amount, false);
      if (recipient === this.policy.owner) this.receive(token, exact(amount), recipient);
    }
  }
  v4(actions: UniswapV4Action[], index: number): void {
    const location = `pool:${index}`,
      deltas = new Map<string, Delta>();
    const get = (token: string): Delta => {
      let d = deltas.get(token);
      if (!d) {
        d = { debt: 0n, credit: 0n, owned: false };
        deltas.set(token, d);
      }
      return d;
    };
    for (const action of actions) {
      if (action.kind === 'exact_in') {
        if (this.feeSource !== null || !action.path.length) fail('flow');
        this.token(action.tokenIn);
        let previous = action.tokenIn;
        for (const hop of action.path) {
          this.token(hop.tokenOut);
          if (previous === hop.tokenOut) fail('flow');
          previous = hop.tokenOut;
        }
        if (previous === action.tokenIn || ++this.swaps > 64) fail('flow');
        const amount = n(action.amountInRaw),
          input = get(action.tokenIn);
        if (amount === 0n) {
          if (!input.owned || input.debt !== 0n) fail('flow');
          input.credit = 0n;
        } else deltaSpend(input, amount);
        deltaAdd(get(previous), n(action.minimumOutRaw));
        for (const hop of action.path.slice(0, -1)) get(hop.tokenOut).owned = true;
      } else {
        this.token(action.token);
        const delta = get(action.token);
        if (action.kind === 'settle') {
          const amount = n(action.amountRaw);
          if (amount === 0n) {
            if (delta.credit !== 0n) fail('flow');
            if (action.payerIsUser) this.userDebit(action.token, delta.debt);
            else if (delta.debt !== 0n) this.consume(action.token, delta.debt, true);
            deltaClear(delta);
          } else {
            if (action.token === this.policy.tokenOut && this.feeSource === location) fail('fees');
            let credit: bigint;
            if (action.payerIsUser) {
              this.userDebit(action.token, amount);
              credit = amount;
            } else credit = this.consume(action.token, amount, false).low;
            deltaAdd(delta, credit);
          }
        } else if (action.kind === 'settle_all') {
          if (delta.credit !== 0n) fail('flow');
          this.userDebit(action.token, min(delta.debt, n(action.maximumRaw)));
          deltaClear(delta);
        } else if (action.kind === 'take_all') {
          if (!delta.owned || delta.debt !== 0n) fail('flow');
          const low = max(delta.credit, n(action.minimumRaw));
          deltaClear(delta);
          this.receive(action.token, unknown(low), this.policy.owner);
        } else if (action.kind === 'take') {
          if (!delta.owned || delta.debt !== 0n) fail('flow');
          const recipient = this.recipient(action.recipient),
            amount = n(action.amountRaw);
          if (amount === 0n) {
            if (recipient !== this.policy.owner && recipient !== this.policy.router)
              fail('recipient');
            const low = delta.credit;
            deltaClear(delta);
            this.receive(action.token, unknown(low), recipient);
          } else {
            if (amount > delta.credit) fail('flow');
            if (recipient !== this.policy.owner && recipient !== this.policy.router)
              this.charge(location, action.token, recipient, delta.credit, null, amount);
            deltaSpend(delta, amount);
            if (recipient === this.policy.owner || recipient === this.policy.router)
              this.receive(action.token, exact(amount), recipient);
          }
        } else {
          if (!delta.owned || delta.debt !== 0n) fail('flow');
          const recipient = this.recipient(action.recipient),
            rate = n(action.bps),
            paid = fraction(delta.credit, rate, 10000n);
          if (recipient !== this.policy.owner && recipient !== this.policy.router)
            this.charge(location, action.token, recipient, delta.credit, [rate, 10000n], 0n);
          delta.credit -= paid;
          if (recipient === this.policy.owner || recipient === this.policy.router)
            this.receive(action.token, unknown(paid), recipient);
        }
      }
    }
    if ([...deltas.values()].some((d) => d.credit !== 0n || d.debt !== 0n)) fail('flow');
  }
}

export function validateSwapEconomics(
  policy: SwapAuthority,
  call: SwapRouterCall,
  now = Math.floor(Date.now() / 1000),
): SwapEconomicProof {
  if (
    !object(policy) ||
    policy.feeBasis !== 'settlement_balance' ||
    !object(call) ||
    ![policy.owner, policy.router, policy.tokenIn, policy.tokenOut].every(realAddress) ||
    n(policy.chainId) === 0n ||
    n(policy.chainId) > BigInt(Number.MAX_SAFE_INTEGER) ||
    policy.owner === policy.router ||
    policy.tokenIn === policy.tokenOut ||
    call.from !== policy.owner ||
    call.to !== policy.router ||
    call.chainId !== policy.chainId ||
    call.valueRaw !== '0' ||
    !Array.isArray(policy.tokens) ||
    policy.tokens.length < 2 ||
    policy.tokens.length > 64 ||
    !policy.tokens.every(realAddress) ||
    new Set(policy.tokens).size !== policy.tokens.length ||
    !policy.tokens.includes(policy.tokenIn) ||
    !policy.tokens.includes(policy.tokenOut) ||
    !Array.isArray(policy.fees) ||
    policy.fees.length > 4 ||
    n(policy.maximumInputRaw) === 0n ||
    n(policy.maximumInputRaw) >= MAX_INPUT ||
    n(policy.minimumOutputRaw) === 0n
  )
    fail('policy');
  let total = 0n;
  const recipients = new Set<string>();
  for (const fee of policy.fees) {
    if (
      !object(fee) ||
      !realAddress(fee.recipient) ||
      fee.recipient === policy.owner ||
      fee.recipient === policy.router ||
      recipients.has(fee.recipient) ||
      n(fee.maximumBps) === 0n ||
      n(fee.maximumBps) > 500n ||
      n(fee.maximumRoundingRaw) > 1n
    )
      fail('policy');
    recipients.add(fee.recipient);
    total += n(fee.maximumBps);
  }
  if (total > 500n) fail('policy');
  let execution: ReturnType<typeof decodeUniswapRouterCall>;
  try {
    execution = decodeUniswapRouterCall(call.data);
  } catch {
    return fail('encoding');
  }
  const deadline = n(policy.deadline);
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    now > Number.MAX_SAFE_INTEGER - 1800 ||
    execution.deadline !== policy.deadline ||
    deadline <= BigInt(now) ||
    deadline > BigInt(now + 1800)
  )
    fail('deadline');
  const proof = new Proof(policy);
  for (const [index, command] of execution.commands.entries()) {
    switch (command.kind) {
      case 'permit_single':
        if (
          index !== 0 ||
          command.token !== policy.tokenIn ||
          command.amountRaw !== policy.maximumInputRaw ||
          command.spender !== policy.router ||
          n(command.expiration) < deadline ||
          n(command.sigDeadline) < deadline
        )
          fail('policy');
        break;
      case 'transfer_from': {
        if (proof.recipient(command.recipient) !== policy.router) fail('recipient');
        const amount = n(command.amountRaw);
        proof.userDebit(command.token, amount);
        proof.incoming(command.token, exact(amount));
        break;
      }
      case 'v2_exact_in':
        proof.swap(
          command.path,
          n(command.amountInRaw),
          n(command.minimumOutRaw),
          command.payerIsUser,
          command.recipient,
          false,
        );
        break;
      case 'v3_exact_in': {
        const first = command.path[0];
        if (!first) fail('flow');
        const path = [first.tokenIn];
        for (const hop of command.path) {
          if (path[path.length - 1] !== hop.tokenIn) fail('flow');
          path.push(hop.tokenOut);
        }
        proof.swap(
          path,
          n(command.amountInRaw),
          n(command.minimumOutRaw),
          command.payerIsUser,
          command.recipient,
          true,
        );
        break;
      }
      case 'v4':
        proof.v4(command.actions, index);
        break;
      case 'sweep':
        proof.routerPayment(command.token, command.recipient, n(command.minimumRaw), null, true);
        break;
      case 'transfer':
        proof.routerPayment(command.token, command.recipient, n(command.amountRaw), null, false);
        break;
      case 'pay_portion':
        proof.routerPayment(command.token, command.recipient, 0n, [n(command.bps), 10000n], false);
        break;
      case 'pay_portion_full_precision':
        proof.routerPayment(
          command.token,
          command.recipient,
          0n,
          [n(command.portion), 10n ** 18n],
          false,
        );
        break;
    }
  }
  if (!proof.swaps || proof.debit !== n(policy.maximumInputRaw)) fail('spend');
  if (proof.output < n(policy.minimumOutputRaw)) fail('minimum');
  if (proof.paid.size !== policy.fees.length) fail('fees');
  if ([...proof.balances.values()].some(possible)) fail('refund');
  return {
    maximumDebitRaw: proof.debit.toString(),
    guaranteedOutputRaw: proof.output.toString(),
    refundTokens: [...proof.refunds].sort(),
    feeRecipients: [...proof.paid].sort(),
  };
}
