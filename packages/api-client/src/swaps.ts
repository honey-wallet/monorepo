import { address, object, revision, time, uint } from './evm-signing';
import type { SwapQuote, SwapQuoteConfiguration, SwapQuoteRequest } from './types';

const bps = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const chain = (v: unknown): v is string => uint(v, (1n << 64n) - 1n) && v !== '0';
const positive = (v: unknown): v is string => uint(v) && v !== '0';
export function isSwapQuoteConfiguration(v: unknown): v is SwapQuoteConfiguration {
  return (
    object(v) &&
    v.provider === 'uniswap' &&
    chain(v.chainId) &&
    address(v.router) &&
    address(v.permit2) &&
    v.routerVersion === '2.1.2' &&
    v.executionAvailable === false &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    Array.isArray(v.tokens) &&
    v.tokens.length >= 2 &&
    v.tokens.length <= 64 &&
    v.tokens.every(
      (t) =>
        object(t) &&
        address(t.address) &&
        typeof t.symbol === 'string' &&
        /^[A-Za-z0-9-]{1,16}$/.test(t.symbol) &&
        bps(t.decimals, 36),
    ) &&
    new Set(v.tokens.map((t) => t.address)).size === v.tokens.length &&
    Array.isArray(v.integratorFees) &&
    v.integratorFees.length <= 4 &&
    v.integratorFees.every(
      (f) => object(f) && address(f.recipient) && bps(f.bps, 500) && f.bps > 0,
    ) &&
    new Set(v.integratorFees.map((f) => f.recipient)).size === v.integratorFees.length &&
    v.integratorFees.reduce((sum, f) => sum + f.bps, 0) <= 500
  );
}
export function isSwapQuoteRequest(v: unknown): v is SwapQuoteRequest {
  return (
    object(v) &&
    address(v.tokenIn) &&
    address(v.tokenOut) &&
    v.tokenIn !== v.tokenOut &&
    positive(v.amountRaw) &&
    BigInt(v.amountRaw) < (1n << 160n) - 1n &&
    bps(v.slippageBps, 1000)
  );
}
export function isSwapQuote(v: unknown): v is SwapQuote {
  if (
    !object(v) ||
    v.provider !== 'uniswap' ||
    v.routing !== 'CLASSIC' ||
    !revision(v.quoteId) ||
    !revision(v.requestId) ||
    !chain(v.chainId) ||
    !address(v.signer) ||
    !address(v.tokenIn) ||
    !address(v.tokenOut) ||
    v.tokenIn === v.tokenOut ||
    !positive(v.amountInRaw) ||
    !positive(v.grossOutputRaw) ||
    !positive(v.netOutputRaw) ||
    !positive(v.minimumOutputRaw) ||
    !bps(v.slippageBps, 1000) ||
    !Array.isArray(v.fees) ||
    v.fees.length > 4 ||
    !uint(v.swapGasEstimateRaw) ||
    v.approvalGasIncluded !== false ||
    typeof v.permitRequired !== 'boolean' ||
    v.executionAvailable !== false ||
    !uint(v.sourceBlock, (1n << 64n) - 1n) ||
    !revision(v.registryRevision) ||
    !revision(v.feePolicyRevision) ||
    !time(v.receivedAtMs) ||
    !time(v.expiresAtMs) ||
    v.expiresAtMs - v.receivedAtMs !== 30000
  )
    return false;
  const gross = BigInt(v.grossOutputRaw),
    net = BigInt(v.netOutputRaw),
    minimum = BigInt(v.minimumOutputRaw);
  let sum = 0n,
    totalBps = 0;
  const recipients = new Set<string>();
  for (const f of v.fees) {
    if (
      !object(f) ||
      !address(f.recipient) ||
      f.recipient === v.signer ||
      recipients.has(f.recipient) ||
      !bps(f.bps, 500) ||
      f.bps === 0 ||
      !uint(f.amountRaw)
    )
      return false;
    if (BigInt(f.amountRaw) !== (gross * BigInt(f.bps)) / 10000n) return false;
    recipients.add(f.recipient);
    sum += BigInt(f.amountRaw);
    totalBps += f.bps;
  }
  return (
    totalBps <= 500 &&
    net + sum === gross &&
    minimum <= net &&
    minimum >= (net * BigInt(10000 - v.slippageBps)) / 10000n
  );
}
/** Context binding is separate from shape parsing. This does not authorize signing. */
export function validateSwapQuote(
  q: SwapQuote,
  c: SwapQuoteConfiguration,
  r: SwapQuoteRequest,
  signer: string,
  now = Date.now(),
): void {
  if (
    !isSwapQuote(q) ||
    !isSwapQuoteConfiguration(c) ||
    !isSwapQuoteRequest(r) ||
    q.signer !== signer.toLowerCase() ||
    q.chainId !== c.chainId ||
    q.tokenIn !== r.tokenIn ||
    q.tokenOut !== r.tokenOut ||
    q.amountInRaw !== r.amountRaw ||
    q.slippageBps !== r.slippageBps ||
    q.registryRevision !== c.registryRevision ||
    q.feePolicyRevision !== c.feePolicyRevision ||
    q.expiresAtMs <= now ||
    q.receivedAtMs > now + 2000 ||
    ![r.tokenIn, r.tokenOut].every((a) => c.tokens.some((t) => t.address === a)) ||
    q.fees.length !== c.integratorFees.length ||
    q.fees.some(
      (f) => !c.integratorFees.some((p) => p.recipient === f.recipient && p.bps === f.bps),
    )
  )
    throw new Error('The swap quote changed or expired. Request a fresh quote.');
}
