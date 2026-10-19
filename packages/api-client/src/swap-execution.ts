import {
  address,
  evmTransactionRequests,
  hash,
  isEvmSigningRequest,
  object,
  revision,
  time,
  uint,
} from './evm-signing';
import { OPERATION_ID } from './operations';
import { permit2TypedData, validateEmbeddedPermit } from './permit2';
import { isSwapQuoteConfiguration } from './swaps';
import type {
  SwapExecutionConfiguration,
  SwapIntent,
  SwapIntentRecovery,
  SwapReview,
  SwapReviewRequest,
  SwapSigningRequest,
} from './types';
import { validateSwapEconomics } from './uniswap-economics';
import { decodeUniswapRouterCall } from './uniswap-router';

const positive = (v: unknown): v is string => uint(v) && v !== '0';
const id = (v: unknown): v is string => typeof v === 'string' && OPERATION_ID.test(v);
export function isSwapExecutionConfiguration(v: unknown): v is SwapExecutionConfiguration {
  return (
    object(v) &&
    v.mode === 'local_fork' &&
    isSwapQuoteConfiguration(v.quote) &&
    v.quote.chainId === '31337' &&
    ['0', '1'].includes(v.maximumFeeRoundingRaw as string)
  );
}
export function isSwapIntent(v: unknown): v is SwapIntent {
  return (
    object(v) &&
    address(v.tokenIn) &&
    address(v.tokenOut) &&
    v.tokenIn !== v.tokenOut &&
    positive(v.amountRaw) &&
    BigInt(v.amountRaw) < (1n << 160n) - 1n &&
    uint(v.slippageBps, 1000n) &&
    positive(v.minimumOutputRaw) &&
    uint(v.deadline, 9_007_199_254_740n) &&
    v.deadline !== '0' &&
    positive(v.maximumNetworkFeeRaw)
  );
}
export function isSwapIntentRecovery(v: unknown): v is SwapIntentRecovery {
  return (
    object(v) &&
    id(v.operationId) &&
    address(v.signer) &&
    v.chainId === '31337' &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    isSwapIntent(v.intent)
  );
}
export function isSwapReview(v: unknown): v is SwapReview {
  if (
    !object(v) ||
    v.schemaVersion !== 1 ||
    !hash(v.intentHash) ||
    !hash(v.providerQuoteHash) ||
    !revision(v.quoteId) ||
    !revision(v.registryRevision) ||
    !revision(v.feePolicyRevision) ||
    !address(v.permit2) ||
    !positive(v.maximumNetworkFeeRaw) ||
    !time(v.reviewedAtMs) ||
    !time(v.quoteObservedAtMs) ||
    !time(v.expiresAtMs) ||
    v.quoteObservedAtMs > v.reviewedAtMs ||
    v.reviewedAtMs - v.quoteObservedAtMs > 30000 ||
    v.expiresAtMs <= v.reviewedAtMs ||
    v.expiresAtMs > v.reviewedAtMs + 900000 ||
    v.expiresAtMs % 1000 !== 0 ||
    !object(v.authority)
  )
    return false;
  const a = v.authority;
  if (
    a.chainId !== '31337' ||
    !address(a.owner) ||
    !address(a.router) ||
    !address(a.tokenIn) ||
    !address(a.tokenOut) ||
    a.owner === a.router ||
    a.tokenIn === a.tokenOut ||
    !positive(a.maximumInputRaw) ||
    BigInt(a.maximumInputRaw) >= (1n << 160n) - 1n ||
    !positive(a.minimumOutputRaw) ||
    a.deadline !== String(v.expiresAtMs / 1000) ||
    a.feeBasis !== 'settlement_balance' ||
    !Array.isArray(a.tokens) ||
    a.tokens.length < 2 ||
    a.tokens.length > 64 ||
    !a.tokens.every(address) ||
    new Set(a.tokens).size !== a.tokens.length ||
    !a.tokens.includes(a.tokenIn) ||
    !a.tokens.includes(a.tokenOut) ||
    !Array.isArray(a.fees) ||
    a.fees.length > 4
  )
    return false;
  const recipients = new Set<string>();
  let bps = 0n;
  for (const f of a.fees) {
    if (
      !object(f) ||
      !address(f.recipient) ||
      f.recipient === a.owner ||
      f.recipient === a.router ||
      recipients.has(f.recipient) ||
      !uint(f.maximumBps, 500n) ||
      f.maximumBps === '0' ||
      !uint(f.maximumRoundingRaw, 1n)
    )
      return false;
    recipients.add(f.recipient);
    bps += BigInt(f.maximumBps);
  }
  if (bps > 500n) return false;
  if (v.permit === null) return true;
  try {
    const p = v.permit as SwapReview['permit'];
    if (!p) return false;
    permit2TypedData(p, Math.floor(v.reviewedAtMs / 1000));
    return (
      p.chainId === a.chainId &&
      p.owner === a.owner &&
      p.permit2 === v.permit2 &&
      p.spender === a.router &&
      p.token === a.tokenIn &&
      p.amountRaw === a.maximumInputRaw &&
      BigInt(p.sigDeadline) >= BigInt(a.deadline)
    );
  } catch {
    return false;
  }
}
export function isSwapReviewRequest(v: unknown): v is SwapReviewRequest {
  return (
    object(v) &&
    id(v.operationId) &&
    uint(v.operationVersion, (1n << 63n) - 1n) &&
    hash(v.reviewHash) &&
    isSwapReview(v.review)
  );
}
export function isSwapSigningRequest(v: unknown): v is SwapSigningRequest {
  return (
    isEvmSigningRequest(v, 'uniswap') && object(v) && hash(v.reviewHash) && isSwapReview(v.review)
  );
}
export interface SwapReviewContext {
  configuration: SwapExecutionConfiguration;
  intent: SwapIntent;
  signer: string;
  operationId: string;
  reviewHash: string;
}
/** Independent consent binding. Hashes identify the server artifact; they do not
 * substitute the local comparison of every spend/fee/recipient/deadline term. */
export function validateSwapReview(
  r: SwapReviewRequest,
  c: SwapReviewContext,
  now = Date.now(),
): void {
  if (
    !isSwapReviewRequest(r) ||
    !isSwapExecutionConfiguration(c.configuration) ||
    !isSwapIntent(c.intent) ||
    !Number.isSafeInteger(now) ||
    now < r.review.reviewedAtMs ||
    now >= r.review.expiresAtMs ||
    r.operationId !== c.operationId ||
    r.reviewHash !== c.reviewHash
  )
    throw new Error('Swap review changed or expired.');
  const v = r.review,
    a = v.authority,
    q = c.configuration.quote,
    i = c.intent;
  if (
    a.owner !== c.signer.toLowerCase() ||
    a.chainId !== q.chainId ||
    a.router !== q.router ||
    v.permit2 !== q.permit2 ||
    v.registryRevision !== q.registryRevision ||
    v.feePolicyRevision !== q.feePolicyRevision ||
    a.tokenIn !== i.tokenIn ||
    a.tokenOut !== i.tokenOut ||
    a.maximumInputRaw !== i.amountRaw ||
    BigInt(a.minimumOutputRaw) < BigInt(i.minimumOutputRaw) ||
    a.deadline !== i.deadline ||
    v.maximumNetworkFeeRaw !== i.maximumNetworkFeeRaw ||
    JSON.stringify(a.tokens) !== JSON.stringify(q.tokens.map((t) => t.address)) ||
    JSON.stringify(a.fees) !==
      JSON.stringify(
        q.integratorFees.map((f) => ({
          recipient: f.recipient,
          maximumBps: String(f.bps),
          maximumRoundingRaw: c.configuration.maximumFeeRoundingRaw,
        })),
      )
  )
    throw new Error('Swap authority differs from the requested trade.');
}
export function validateSwapSigning(
  r: SwapSigningRequest,
  c: SwapReviewContext,
  expectedSignature: string | null,
  now = Date.now(),
): void {
  if (!isSwapSigningRequest(r)) throw new Error('Invalid swap signing request.');
  validateSwapReview(r, c, now);
  const p = r.prepared.plan,
    v = r.review,
    a = v.authority,
    receive = p.minimumReceive;
  if (
    p.intentHash !== v.intentHash ||
    p.signer !== a.owner ||
    p.chainId !== a.chainId ||
    p.registryRevision !== v.registryRevision ||
    p.feePolicyRevision !== v.feePolicyRevision ||
    p.quoteReference !== v.quoteId ||
    p.expiresAtMs !== v.expiresAtMs ||
    p.simulation.observedAtMs < v.reviewedAtMs ||
    p.simulation.observedAtMs > now ||
    now - p.simulation.observedAtMs > 60000 ||
    BigInt(p.maximumNetworkFeeRaw) > BigInt(v.maximumNetworkFeeRaw) ||
    p.maximumSpend.assetAddress !== a.tokenIn ||
    p.maximumSpend.amountRaw !== a.maximumInputRaw ||
    p.maximumSpend.recipient !== a.owner ||
    receive?.assetAddress !== a.tokenOut ||
    receive?.amountRaw !== a.minimumOutputRaw ||
    receive?.recipient !== a.owner ||
    p.fees.length !== a.fees.length ||
    p.fees.some(
      (f, n) => f.amount.assetAddress !== a.tokenOut || f.amount.recipient !== a.fees[n]?.recipient,
    )
  )
    throw new Error('Prepared swap differs from reviewed authority.');
  const approvals = p.steps.slice(0, -1);
  for (const [index, call] of approvals.entries()) {
    const amount = approvals.length === 2 && index === 0 ? '0' : a.maximumInputRaw;
    const data = `0x095ea7b3${v.permit2.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
    if (call.to !== a.tokenIn || call.data !== data)
      throw new Error('Swap approval is not the exact reviewed allowance.');
  }
  const action = p.steps[p.steps.length - 1];
  if (!action) throw new Error('Missing swap action.');
  validateSwapEconomics(
    a,
    {
      chainId: p.chainId,
      from: p.signer,
      to: action.to,
      valueRaw: action.valueRaw,
      data: action.data,
    },
    Math.floor(now / 1000),
  );
  validateEmbeddedPermit(
    decodeUniswapRouterCall(action.data),
    v.permit,
    expectedSignature,
    Math.floor(now / 1000),
  );
}
/** Call validateSwapSigning against explicit user consent before using these. */
export const swapTransactionRequests = (r: SwapSigningRequest) => evmTransactionRequests(r);
