import { object, time, uint } from './evm-signing';
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
    b.provider !== 'relay' ||
    !chain(b.sourceChainId) ||
    !chain(b.destinationChainId) ||
    b.sourceChainId === b.destinationChainId ||
    b.refundChainId !== b.sourceChainId ||
    !tx(b.sourceTransactionHash) ||
    typeof b.providerReference !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(b.providerReference)
  )
    return false;
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
/** Provider hints are advisory; none of these messages claims verified delivery. */
export function bridgeStatusMessage(value: BridgeStatusRecovery): string {
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
