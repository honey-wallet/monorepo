import { isAcrossConfiguration } from './across';
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
import type {
  AcrossDepositTerms,
  AcrossExecutionConfiguration,
  AcrossIntent,
  AcrossIntentRecovery,
  AcrossReview,
  AcrossSigningRequest,
} from './types';

const MAX = (1n << 256n) - 1n;
const positive = (v: unknown): v is string => uint(v) && v !== '0' && BigInt(v) < MAX;
const chain = (v: unknown): v is string => uint(v, BigInt(Number.MAX_SAFE_INTEGER)) && v !== '0';
const zeroAddress = `0x${'0'.repeat(40)}`;
const anyAddress = (v: unknown): v is string => v === zeroAddress || address(v);
const integrator = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{4}$/.test(v);
export function isAcrossDepositTerms(v: unknown): v is AcrossDepositTerms {
  return (
    object(v) &&
    chain(v.sourceChain) &&
    chain(v.destinationChain) &&
    v.sourceChain !== v.destinationChain &&
    address(v.depositor) &&
    address(v.recipient) &&
    address(v.inputToken) &&
    address(v.outputToken) &&
    positive(v.inputAmount) &&
    positive(v.outputAmount) &&
    BigInt(v.outputAmount) <= BigInt(v.inputAmount) &&
    anyAddress(v.exclusiveRelayer) &&
    uint(v.quoteTimestamp, 4294967295n) &&
    v.quoteTimestamp !== '0' &&
    uint(v.fillDeadline, 4294967295n) &&
    BigInt(v.fillDeadline) > BigInt(v.quoteTimestamp) &&
    uint(v.exclusivityParameter, 4294967295n) &&
    (v.exclusivityParameter === '0' || v.exclusiveRelayer !== zeroAddress) &&
    (v.swapApiIntegratorId === undefined || integrator(v.swapApiIntegratorId))
  );
}
/** Independent fixed-layout ABI decoder. Rejects dirty address padding, callbacks,
 * dynamic aliases, extra bytes, unknown selectors and mismatched attribution. */
export function decodeAcrossDeposit(
  calldata: string,
  sourceChain: string,
  integratorId?: string,
): AcrossDepositTerms {
  const bad = (): never => {
    throw new Error('Unsupported Across deposit calldata.');
  };
  if (
    typeof calldata !== 'string' ||
    !/^0x[0-9a-f]+$/.test(calldata) ||
    calldata.length !== (integratorId === undefined ? 842 : 858) ||
    !['0xad5425c6', '0x7b939232'].includes(calldata.slice(0, 10)) ||
    !chain(sourceChain)
  )
    bad();
  if (
    integratorId !== undefined &&
    (!integrator(integratorId) || calldata.slice(842) !== `1dc0de${integratorId.slice(2)}73c0de`)
  )
    bad();
  const word = (n: number) => calldata.slice(10 + n * 64, 74 + n * 64);
  const number = (n: number) => BigInt(`0x${word(n)}`).toString();
  const addr = (n: number) => {
    const value = word(n);
    if (!/^0{24}[0-9a-f]{40}$/.test(value)) bad();
    return `0x${value.slice(24)}`;
  };
  if (number(11) !== '384' || number(12) !== '0') bad();
  const terms: AcrossDepositTerms = {
    sourceChain,
    destinationChain: number(6),
    depositor: addr(0),
    recipient: addr(1),
    inputToken: addr(2),
    outputToken: addr(3),
    inputAmount: number(4),
    outputAmount: number(5),
    exclusiveRelayer: addr(7),
    quoteTimestamp: number(8),
    fillDeadline: number(9),
    exclusivityParameter: number(10),
    ...(integratorId === undefined ? {} : { swapApiIntegratorId: integratorId }),
  };
  if (!isAcrossDepositTerms(terms)) bad();
  return terms;
}
const termKeys: (keyof AcrossDepositTerms)[] = [
  'sourceChain',
  'destinationChain',
  'depositor',
  'recipient',
  'inputToken',
  'outputToken',
  'inputAmount',
  'outputAmount',
  'exclusiveRelayer',
  'quoteTimestamp',
  'fillDeadline',
  'exclusivityParameter',
  'swapApiIntegratorId',
];
export function isAcrossIntent(v: unknown): v is AcrossIntent {
  return (
    object(v) &&
    Object.keys(v).length === 7 &&
    revision(v.quoteId) &&
    revision(v.routeId) &&
    positive(v.amountRaw) &&
    positive(v.minimumOutputRaw) &&
    BigInt(v.minimumOutputRaw) <= BigInt(v.amountRaw) &&
    address(v.recipient) &&
    positive(v.maximumNetworkFeeRaw) &&
    uint(v.deadline, 4294967295n) &&
    v.deadline !== '0'
  );
}
export function isAcrossExecutionConfiguration(v: unknown): v is AcrossExecutionConfiguration {
  return (
    object(v) &&
    v.mode === 'local_fork' &&
    v.feePolicyRevision === 'across-zero-app-fee-v1' &&
    isAcrossConfiguration(v.quote) &&
    v.quote.sourceChainId === '31337' &&
    v.quote.routes.every((r) => r.destinationChainId === '31338')
  );
}
export function isAcrossIntentRecovery(v: unknown): v is AcrossIntentRecovery {
  return (
    object(v) &&
    typeof v.operationId === 'string' &&
    OPERATION_ID.test(v.operationId) &&
    address(v.signer) &&
    v.chainId === '31337' &&
    revision(v.registryRevision) &&
    isAcrossIntent(v.intent)
  );
}
export function isAcrossReview(v: unknown): v is AcrossReview {
  if (
    !object(v) ||
    !isAcrossDepositTerms(v.terms) ||
    !integrator(v.terms.swapApiIntegratorId) ||
    !address(v.sourceSpoke) ||
    typeof v.calldata !== 'string' ||
    !revision(v.quoteId) ||
    !revision(v.registryRevision) ||
    !hash(v.intentHash) ||
    !time(v.quotedAtMs) ||
    !time(v.quoteExpiresAtMs) ||
    !(v.providerExpiresAtMs === null || time(v.providerExpiresAtMs)) ||
    !time(v.executionDeadlineMs) ||
    !time(v.preparedAtMs) ||
    !time(v.expiresAtMs) ||
    v.quoteExpiresAtMs <= v.quotedAtMs ||
    v.quoteExpiresAtMs - v.quotedAtMs > 30000 ||
    (v.providerExpiresAtMs !== null && v.providerExpiresAtMs <= v.quotedAtMs) ||
    v.quoteExpiresAtMs > v.executionDeadlineMs ||
    v.preparedAtMs < v.quotedAtMs ||
    v.preparedAtMs >= v.quoteExpiresAtMs ||
    v.expiresAtMs <= v.preparedAtMs ||
    v.expiresAtMs - v.preparedAtMs > 300000 ||
    v.expiresAtMs > v.executionDeadlineMs ||
    !positive(v.maximumNetworkFeeRaw)
  )
    return false;
  try {
    const parsed = decodeAcrossDeposit(
      v.calldata,
      v.terms.sourceChain,
      v.terms.swapApiIntegratorId,
    );
    return termKeys.every((key) => parsed[key] === (v.terms as AcrossDepositTerms)[key]);
  } catch {
    return false;
  }
}
export function isAcrossSigningRequest(v: unknown): v is AcrossSigningRequest {
  return isEvmSigningRequest(v, 'across') && object(v) && isAcrossReview(v.review);
}
export interface AcrossReviewContext {
  configuration: AcrossExecutionConfiguration;
  intent: AcrossIntent;
  signer: string;
  operationId: string;
  operationVersion: string;
  planHash: string;
}
/** Hashes identify the artifact. Every spend, approval, recipient and deadline is
 * also checked independently against the user's intent and local registry view. */
export function validateAcrossSigning(
  r: AcrossSigningRequest,
  c: AcrossReviewContext,
  now = Date.now(),
): void {
  const bad = (): never => {
    throw new Error('Across signing request changed or does not match your bridge review.');
  };
  if (
    !isAcrossSigningRequest(r) ||
    !isAcrossExecutionConfiguration(c.configuration) ||
    !isAcrossIntent(c.intent) ||
    !Number.isSafeInteger(now)
  )
    bad();
  const p = r.prepared.plan,
    review = r.review,
    t = review.terms,
    config = c.configuration.quote,
    i = c.intent,
    route = config.routes.find((route) => route.id === i.routeId) ?? bad();
  const seconds = Math.floor(now / 1000),
    quotedSeconds = Math.floor(review.quotedAtMs / 1000),
    preparedSeconds = Math.floor(review.preparedAtMs / 1000),
    quoteTime = Number(t.quoteTimestamp),
    fill = Number(t.fillDeadline),
    exclusive = Number(t.exclusivityParameter);
  if (
    r.operationId !== c.operationId ||
    r.operationVersion !== c.operationVersion ||
    r.planHash !== c.planHash ||
    p.signer !== c.signer.toLowerCase() ||
    t.depositor !== p.signer ||
    t.recipient !== i.recipient ||
    t.sourceChain !== config.sourceChainId ||
    t.destinationChain !== route.destinationChainId ||
    t.inputToken !== route.inputToken.address ||
    t.outputToken !== route.outputToken.address ||
    t.inputAmount !== i.amountRaw ||
    BigInt(t.outputAmount) < BigInt(i.minimumOutputRaw) ||
    BigInt(t.inputAmount) < BigInt(route.minimumInputRaw) ||
    BigInt(t.inputAmount) > BigInt(route.maximumInputRaw) ||
    (BigInt(t.inputAmount) - BigInt(t.outputAmount)) * 10000n >
      BigInt(t.inputAmount) * BigInt(route.maximumBridgeFeeBps) ||
    t.swapApiIntegratorId !== config.integratorId ||
    review.sourceSpoke !== route.sourceSpoke ||
    review.quoteId !== i.quoteId ||
    review.registryRevision !== config.registryRevision ||
    review.maximumNetworkFeeRaw !== i.maximumNetworkFeeRaw ||
    review.quotedAtMs > now + 2000 ||
    review.preparedAtMs > now + 2000 ||
    review.expiresAtMs <= now ||
    review.expiresAtMs > review.preparedAtMs + 300000 ||
    (review.providerExpiresAtMs !== null && review.expiresAtMs > review.providerExpiresAtMs) ||
    review.expiresAtMs > Number(i.deadline) * 1000 ||
    review.executionDeadlineMs !== Number(i.deadline) * 1000 ||
    Number(i.deadline) <= seconds ||
    Number(i.deadline) > seconds + 900 ||
    quoteTime > quotedSeconds + 15 ||
    review.quoteExpiresAtMs > (quoteTime + 300) * 1000 ||
    review.quoteExpiresAtMs > (fill - 30) * 1000 ||
    (exclusive <= 31536000
      ? review.quoteExpiresAtMs > (fill - exclusive) * 1000
      : review.quoteExpiresAtMs > exclusive * 1000) ||
    quoteTime + 300 < preparedSeconds ||
    fill <= preparedSeconds + 30 ||
    fill > quotedSeconds + route.maximumFillSeconds ||
    review.expiresAtMs > (quoteTime + 300) * 1000 ||
    review.expiresAtMs > (fill - 30) * 1000 ||
    (exclusive <= 31536000
      ? exclusive > route.maximumExclusivitySeconds ||
        preparedSeconds + exclusive > fill ||
        review.expiresAtMs > (fill - exclusive) * 1000
      : exclusive > quotedSeconds + route.maximumExclusivitySeconds ||
        exclusive > fill ||
        review.expiresAtMs > exclusive * 1000)
  )
    bad();
  if (
    p.chainId !== t.sourceChain ||
    p.intentHash !== review.intentHash ||
    p.registryRevision !== review.registryRevision ||
    p.feePolicyRevision !== c.configuration.feePolicyRevision ||
    p.quoteReference !== review.quoteId ||
    p.expiresAtMs !== review.expiresAtMs ||
    p.simulation.observedAtMs !== review.preparedAtMs ||
    p.simulation.observedAtMs > now + 2000 ||
    BigInt(p.maximumNetworkFeeRaw) > BigInt(i.maximumNetworkFeeRaw) ||
    p.maximumSpend.assetAddress !== t.inputToken ||
    p.maximumSpend.amountRaw !== t.inputAmount ||
    p.maximumSpend.recipient !== route.sourceSpoke ||
    p.minimumReceive !== null ||
    p.fees.length !== 0
  )
    bad();
  const action = p.steps.at(-1);
  if (!action || action.to !== route.sourceSpoke || action.data !== review.calldata) bad();
  // Shape validation already limits this to zero, one, or two approval calls.
  const approvals = p.steps.slice(0, -1);
  for (const [n, call] of approvals.entries()) {
    const amount = approvals.length === 2 && n === 0 ? '0' : t.inputAmount;
    const data = `0x095ea7b3${route.sourceSpoke.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
    if (call.to !== t.inputToken || call.data !== data) bad();
  }
}
/** Call validateAcrossSigning against explicit user consent before using these. */
export const acrossTransactionRequests = (r: AcrossSigningRequest) => evmTransactionRequests(r);
