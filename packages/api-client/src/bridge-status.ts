import { address, object, time, uint } from './evm-signing';
import { OPERATION_ID } from './operations';
import type { BridgeReportedOutcome, BridgeStatusRecovery } from './types';

const chain = (v: unknown): v is string => uint(v, BigInt(Number.MAX_SAFE_INTEGER)) && v !== '0';
const tx = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && v !== `0x${'0'.repeat(64)}`;
const outcomes: readonly BridgeReportedOutcome[] = [
  'not_indexed',
  'pending',
  'fill_reported',
  'refund_pending',
  'refund_reported',
  'recovery_required',
];
export function isBridgeStatusRecovery(v: unknown): v is BridgeStatusRecovery {
  if (
    !object(v) ||
    typeof v.operationId !== 'string' ||
    !OPERATION_ID.test(v.operationId) ||
    !object(v.binding) ||
    !Object.hasOwn(v, 'verifiedDelivery') ||
    typeof v.stale !== 'boolean' ||
    !uint(v.pollVersion, (1n << 63n) - 1n) ||
    !time(v.nextPollAtMs) ||
    !(
      v.lastErrorCode === null ||
      [
        'invalid',
        'busy',
        'cooldown',
        'unavailable',
        'rejected',
        'invalid_response',
        'ambiguous',
        'unsupported_route',
      ].includes(v.lastErrorCode as string)
    )
  )
    return false;
  const b = v.binding;
  if (
    !['relay', 'across'].includes(b.provider as string) ||
    !chain(b.sourceChainId) ||
    !chain(b.destinationChainId) ||
    b.sourceChainId === b.destinationChainId ||
    ![b.sourceChainId, b.destinationChainId].includes(b.refundChainId as string) ||
    !tx(b.sourceTransactionHash) ||
    typeof b.providerReference !== 'string'
  )
    return false;
  if (
    b.provider === 'relay'
      ? !/^[A-Za-z0-9_-]{1,128}$/.test(b.providerReference) || b.refundChainId !== b.sourceChainId
      : !uint(b.providerReference, (1n << 256n) - 1n)
  )
    return false;
  const delivery = v.verifiedDelivery;
  if (delivery !== null) {
    const anchor = (a: unknown) =>
      object(a) &&
      uint(a.blockNumber, (1n << 64n) - 1n) &&
      tx(a.blockHash) &&
      uint(a.finalizedNumber, (1n << 64n) - 1n) &&
      BigInt(a.blockNumber) <= BigInt(a.finalizedNumber) &&
      tx(a.finalizedHash);
    if (
      b.provider !== 'across' ||
      !object(delivery) ||
      delivery.evidenceVersion !== '1' ||
      !uint(delivery.operationVersion, (1n << 63n) - 1n) ||
      delivery.sourceChainId !== b.sourceChainId ||
      delivery.destinationChainId !== b.destinationChainId ||
      delivery.sourceTransactionHash !== b.sourceTransactionHash ||
      !tx(delivery.destinationTransactionHash) ||
      !address(delivery.recipient) ||
      !address(delivery.outputToken) ||
      !uint(delivery.deliveredAmountRaw) ||
      delivery.deliveredAmountRaw === '0' ||
      !anchor(delivery.source) ||
      !anchor(delivery.destination) ||
      !time(delivery.verifiedAtMs)
    )
      return false;
  }
  const o = v.observation;
  if (o === null) return v.stale === true;
  if (
    !object(o) ||
    o.provider !== b.provider ||
    !outcomes.includes(o.reportedOutcome as BridgeReportedOutcome) ||
    typeof o.sourceTransactionSeen !== 'boolean' ||
    o.verificationRequired !== true ||
    !time(o.observedAtMs) ||
    !(
      o.providerUpdatedAtMs === null ||
      (time(o.providerUpdatedAtMs) && o.providerUpdatedAtMs <= o.observedAtMs + 30000)
    ) ||
    !Array.isArray(o.candidates) ||
    o.candidates.length > 8
  )
    return false;
  const refund = ['refund_pending', 'refund_reported', 'recovery_required'].includes(
    o.reportedOutcome as string,
  );
  if (o.pollAfterMs !== (refund ? 60000 : 10000)) return false;
  const expectedRole =
    o.reportedOutcome === 'fill_reported'
      ? 'destination_fill'
      : o.reportedOutcome === 'refund_reported'
        ? 'refund'
        : null;
  if (
    expectedRole === null
      ? o.candidates.length !== 0
      : !o.sourceTransactionSeen || o.candidates.length === 0
  )
    return false;
  const unique = new Set<string>();
  for (const candidate of o.candidates) {
    if (
      !object(candidate) ||
      candidate.role !== expectedRole ||
      candidate.chainId !== (expectedRole === 'refund' ? b.refundChainId : b.destinationChainId) ||
      !tx(candidate.transactionHash) ||
      unique.has(candidate.transactionHash)
    )
      return false;
    unique.add(candidate.transactionHash);
  }
  return true;
}
/** Only independently verified delivery can supersede advisory provider hints. */
export function bridgeStatusMessage(value: BridgeStatusRecovery): string {
  if (value.verifiedDelivery) return 'Destination delivery verified.';
  if (value.stale) return 'Bridge status is delayed. Your deposit must not be sent again.';
  switch (value.observation?.reportedOutcome) {
    case 'fill_reported':
      return 'Destination fill reported; confirmation is still pending.';
    case 'refund_reported':
      return 'Refund reported; return of funds is not yet confirmed.';
    case 'refund_pending':
      return 'Refund pending. Funds have not been confirmed returned.';
    case 'recovery_required':
      return 'The bridge needs recovery. Check its status before taking further action.';
    case 'pending':
      return 'Bridge processing. Destination delivery is not yet confirmed.';
    default:
      return 'Waiting for the bridge provider to index your deposit.';
  }
}
