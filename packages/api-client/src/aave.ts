import {
  address,
  evmTransactionRequests,
  isEvmSigningRequest,
  object,
  revision,
  uint,
} from './evm-signing';
import { OPERATION_ID } from './operations';
import type {
  AaveExecutionConfiguration,
  AaveIntent,
  AaveIntentRecovery,
  AaveSigningRequest,
} from './types';

export function isAaveExecutionConfiguration(v: unknown): v is AaveExecutionConfiguration {
  return (
    object(v) &&
    v.mode === 'local_fork' &&
    v.chainId === '31337' &&
    address(v.pool) &&
    address(v.asset) &&
    address(v.aToken) &&
    typeof v.decimals === 'number' &&
    Number.isInteger(v.decimals) &&
    v.decimals >= 0 &&
    v.decimals <= 18 &&
    uint(v.maximumAtokenRoundingRaw) &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision)
  );
}
export function isAaveSigningRequest(v: unknown): v is AaveSigningRequest {
  return isEvmSigningRequest(v, 'aave_v3');
}
export interface AaveReviewContext {
  configuration: AaveExecutionConfiguration;
  intent: AaveIntent;
  signer: string;
  operationId: string;
  planHash: string;
  operationVersion: string;
}
/** Independent ABI encoding and economic checks before any wallet prompt. No RPC or signing. */
export function validateAaveReview(
  r: AaveSigningRequest,
  expected: AaveReviewContext,
  now = Date.now(),
): void {
  function bad(): never {
    throw new Error('Aave signing request does not match your reviewed operation.');
  }
  if (
    !isAaveSigningRequest(r) ||
    !isAaveExecutionConfiguration(expected.configuration) ||
    !uint(expected.intent.amountRaw) ||
    expected.intent.amountRaw === '0' ||
    !uint(expected.intent.maximumNetworkFeeRaw)
  )
    bad();
  const { configuration: c, intent: i } = expected;
  const p = r.prepared.plan;
  if (
    !['supply', 'withdraw'].includes(i.action) ||
    r.operationId !== expected.operationId ||
    r.operationVersion !== expected.operationVersion ||
    r.planHash !== expected.planHash ||
    p.signer !== expected.signer.toLowerCase() ||
    p.chainId !== c.chainId ||
    p.registryRevision !== c.registryRevision ||
    p.feePolicyRevision !== c.feePolicyRevision ||
    p.expiresAtMs <= now ||
    p.expiresAtMs > now + 900_000 ||
    p.simulation.observedAtMs > now + 2000 ||
    BigInt(p.maximumNetworkFeeRaw) > BigInt(i.maximumNetworkFeeRaw) ||
    p.maximumSpend.recipient !== p.signer
  )
    bad();
  const word = (v: string) => BigInt(v).toString(16).padStart(64, '0');
  const action = p.steps[p.steps.length - 1];
  if (!action) bad();
  const data =
    i.action === 'supply'
      ? `0x617ba037${word(c.asset)}${word(i.amountRaw)}${word(p.signer)}${word('0')}`
      : `0x69328dec${word(c.asset)}${word(i.amountRaw)}${word(p.signer)}`;
  if (action.to !== c.pool || action.data !== data) bad();
  if (i.action === 'supply') {
    if (
      p.maximumSpend.assetAddress !== c.asset ||
      p.maximumSpend.amountRaw !== i.amountRaw ||
      p.minimumReceive !== null
    )
      bad();
    for (let n = 0; n < p.steps.length - 1; n++) {
      const approval = p.steps[n];
      if (!approval) bad();
      const approved = n === p.steps.length - 2 ? i.amountRaw : '0';
      if (approval.to !== c.asset || approval.data !== `0x095ea7b3${word(c.pool)}${word(approved)}`)
        bad();
    }
  } else if (
    p.steps.length !== 1 ||
    p.maximumSpend.assetAddress !== c.aToken ||
    BigInt(p.maximumSpend.amountRaw) !== BigInt(i.amountRaw) + BigInt(c.maximumAtokenRoundingRaw) ||
    p.minimumReceive?.assetAddress !== c.asset ||
    p.minimumReceive.amountRaw !== i.amountRaw ||
    p.minimumReceive.recipient !== p.signer
  )
    bad();
}
/** Exact type-2 requests; independent economic review is required before signing. */
export function aaveTransactionRequests(r: AaveSigningRequest) {
  if (!isAaveSigningRequest(r)) throw new Error('Unsupported Aave signing terms.');
  return evmTransactionRequests(r);
}

export function isAaveIntentRecovery(v: unknown): v is AaveIntentRecovery {
  return (
    object(v) &&
    typeof v.operationId === 'string' &&
    OPERATION_ID.test(v.operationId) &&
    address(v.signer) &&
    v.chainId === '31337' &&
    address(v.asset) &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    object(v.intent) &&
    ['supply', 'withdraw'].includes(v.intent.action as string) &&
    uint(v.intent.amountRaw) &&
    v.intent.amountRaw !== '0' &&
    BigInt(v.intent.amountRaw) < (1n << 256n) - 1n &&
    uint(v.intent.maximumNetworkFeeRaw) &&
    v.intent.maximumNetworkFeeRaw !== '0'
  );
}
