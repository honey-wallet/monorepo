import { address, object, time, uint } from './evm-signing';
import type {
  AcrossConfiguration,
  AcrossQuote,
  AcrossQuoteRequest,
  AcrossRoute,
  BridgeToken,
} from './types';

const integer = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const label = (v: unknown, max = 64): v is string =>
  typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_.-]+$/.test(v);
const chain = (v: unknown): v is string => uint(v, BigInt(Number.MAX_SAFE_INTEGER)) && v !== '0';
const positive = (v: unknown): v is string => uint(v) && v !== '0';
const integrator = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{4}$/.test(v);
const token = (v: unknown): v is BridgeToken =>
  object(v) &&
  address(v.address) &&
  label(v.assetId) &&
  label(v.symbol, 16) &&
  integer(v.decimals, 36);
function route(v: unknown): v is AcrossRoute {
  return (
    object(v) &&
    label(v.id) &&
    chain(v.destinationChainId) &&
    address(v.sourceSpoke) &&
    token(v.inputToken) &&
    token(v.outputToken) &&
    v.inputToken.assetId === v.outputToken.assetId &&
    v.inputToken.decimals === v.outputToken.decimals &&
    positive(v.minimumInputRaw) &&
    positive(v.maximumInputRaw) &&
    BigInt(v.minimumInputRaw) <= BigInt(v.maximumInputRaw) &&
    integer(v.maximumBridgeFeeBps, 1000) &&
    integer(v.maximumFillSeconds, 86400) &&
    v.maximumFillSeconds >= 60 &&
    integer(v.maximumExclusivitySeconds, v.maximumFillSeconds)
  );
}
export function isAcrossConfiguration(v: unknown): v is AcrossConfiguration {
  return (
    object(v) &&
    v.provider === 'across' &&
    chain(v.sourceChainId) &&
    integrator(v.integratorId) &&
    label(v.registryRevision) &&
    v.executionAvailable === false &&
    Array.isArray(v.routes) &&
    v.routes.length > 0 &&
    v.routes.length <= 32 &&
    v.routes.every((r) => route(r) && r.destinationChainId !== v.sourceChainId) &&
    new Set(v.routes.map((r) => r.id)).size === v.routes.length
  );
}
export function isAcrossQuoteRequest(v: unknown): v is AcrossQuoteRequest {
  return (
    object(v) &&
    Object.keys(v).length === 4 &&
    label(v.routeId) &&
    positive(v.amountRaw) &&
    positive(v.minimumOutputRaw) &&
    BigInt(v.minimumOutputRaw) <= BigInt(v.amountRaw) &&
    address(v.recipient)
  );
}
export function isAcrossQuote(v: unknown): v is AcrossQuote {
  if (
    !object(v) ||
    v.provider !== 'across' ||
    !label(v.quoteId, 128) ||
    !label(v.routeId) ||
    !label(v.registryRevision) ||
    !chain(v.sourceChainId) ||
    !chain(v.destinationChainId) ||
    v.sourceChainId === v.destinationChainId ||
    !address(v.sender) ||
    !address(v.recipient) ||
    !address(v.inputToken) ||
    !address(v.outputToken) ||
    !positive(v.inputAmountRaw) ||
    !positive(v.outputAmountRaw) ||
    v.minimumOutputRaw !== v.outputAmountRaw ||
    !uint(v.bridgeFeeRaw) ||
    v.integratorFeeRaw !== '0' ||
    !integrator(v.integratorId) ||
    !positive(v.sourceGasEstimateRaw) ||
    BigInt(v.sourceGasEstimateRaw) > 2000000n ||
    v.approvalGasIncluded !== false ||
    !integer(v.expectedFillSeconds, 86400) ||
    v.expectedFillSeconds === 0 ||
    v.refundChainId !== v.sourceChainId ||
    v.refundRecipient !== v.sender ||
    !uint(v.quoteTimestamp, 4294967295n) ||
    !uint(v.fillDeadline, 4294967295n) ||
    !uint(v.exclusivityParameter, 4294967295n) ||
    typeof v.exclusiveRelayer !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(v.exclusiveRelayer) ||
    (v.exclusivityParameter !== '0' && v.exclusiveRelayer === `0x${'0'.repeat(40)}`) ||
    !time(v.receivedAtMs) ||
    !(v.providerExpiresAtMs === null || time(v.providerExpiresAtMs)) ||
    !time(v.expiresAtMs) ||
    v.expiresAtMs <= v.receivedAtMs ||
    v.expiresAtMs - v.receivedAtMs > 30000 ||
    (v.providerExpiresAtMs !== null &&
      (v.providerExpiresAtMs <= v.receivedAtMs || v.expiresAtMs > v.providerExpiresAtMs)) ||
    v.executionAvailable !== false
  )
    return false;
  return BigInt(v.outputAmountRaw) + BigInt(v.bridgeFeeRaw) === BigInt(v.inputAmountRaw);
}
/** Binds a display quote to the session and configured route. Never authorizes signing. */
export function validateAcrossQuote(
  q: AcrossQuote,
  c: AcrossConfiguration,
  r: AcrossQuoteRequest,
  sender: string,
  now = Date.now(),
): void {
  if (!isAcrossQuote(q) || !isAcrossConfiguration(c) || !isAcrossQuoteRequest(r))
    throw new Error('Invalid bridge quote.');
  const route = c.routes.find((item) => item.id === r.routeId);
  const seconds = Math.floor(q.receivedAtMs / 1000),
    fill = Number(q.fillDeadline),
    quoteTime = Number(q.quoteTimestamp),
    exclusive = Number(q.exclusivityParameter);
  if (
    !route ||
    q.sender !== sender.toLowerCase() ||
    q.recipient !== r.recipient ||
    q.routeId !== r.routeId ||
    q.registryRevision !== c.registryRevision ||
    q.integratorId !== c.integratorId ||
    q.sourceChainId !== c.sourceChainId ||
    q.destinationChainId !== route.destinationChainId ||
    q.inputToken !== route.inputToken.address ||
    q.outputToken !== route.outputToken.address ||
    q.inputAmountRaw !== r.amountRaw ||
    BigInt(q.minimumOutputRaw) < BigInt(r.minimumOutputRaw) ||
    BigInt(r.amountRaw) < BigInt(route.minimumInputRaw) ||
    BigInt(r.amountRaw) > BigInt(route.maximumInputRaw) ||
    BigInt(q.bridgeFeeRaw) * 10000n >
      BigInt(q.inputAmountRaw) * BigInt(route.maximumBridgeFeeBps) ||
    quoteTime > seconds + 15 ||
    quoteTime + 300 < seconds ||
    fill <= seconds + 30 ||
    fill > seconds + route.maximumFillSeconds ||
    (exclusive <= 31536000
      ? exclusive > route.maximumExclusivitySeconds || seconds + exclusive > fill
      : exclusive > seconds + route.maximumExclusivitySeconds ||
        exclusive > fill ||
        q.expiresAtMs > exclusive * 1000) ||
    q.expectedFillSeconds > fill - seconds ||
    (exclusive <= 31536000
      ? q.expiresAtMs > (fill - exclusive) * 1000
      : q.expiresAtMs > exclusive * 1000) ||
    q.expiresAtMs > (quoteTime + 300) * 1000 ||
    q.expiresAtMs > (fill - 30) * 1000 ||
    (exclusive <= 31536000 && q.expiresAtMs > (fill - exclusive) * 1000) ||
    q.expiresAtMs <= now ||
    q.receivedAtMs > now + 2000
  )
    throw new Error('The bridge quote changed or expired. Request a fresh quote.');
}
