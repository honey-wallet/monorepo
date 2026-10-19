import type { OperationPage, OperationRecovery } from './types';

export const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_I64 = '9223372036854775807';
function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function integer(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(v) &&
    (v.length < MAX_I64.length || (v.length === MAX_I64.length && v <= MAX_I64))
  );
}
function revision(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
}
function uint(v: unknown, max: bigint): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 && BigInt(v) <= max;
}
const U64 = 18446744073709551615n;
const U256 = (1n << 256n) - 1n;
const txHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
function receipts(v: unknown, hashes: string[], state: unknown, action: unknown): boolean {
  if (
    !object(v) ||
    !Number.isSafeInteger(v.checkedAtMs) ||
    (v.checkedAtMs as number) <= 0 ||
    !uint(v.headNumber, U64) ||
    !uint(v.finalizedNumber, U64) ||
    BigInt(v.finalizedNumber) > BigInt(v.headNumber) ||
    !txHash(v.headHash) ||
    !txHash(v.finalizedHash) ||
    !Array.isArray(v.transactions) ||
    v.transactions.length !== hashes.length
  )
    return false;
  let any = false;
  let reverted = false;
  let allFinal = true;
  for (let n = 0; n < hashes.length; n++) {
    const t = v.transactions[n];
    if (!object(t) || t.transactionHash !== hashes[n]) return false;
    const i = t.inclusion;
    if (i === null) {
      allFinal = false;
      continue;
    }
    if (
      !object(i) ||
      !uint(i.blockNumber, U64) ||
      BigInt(i.blockNumber) > BigInt(v.headNumber) ||
      !txHash(i.blockHash) ||
      !uint(i.transactionIndex, U64) ||
      !uint(i.gasUsed, U64) ||
      BigInt(i.gasUsed) < 21000n ||
      !uint(i.effectiveGasPrice, U256) ||
      typeof i.succeeded !== 'boolean' ||
      typeof i.finalized !== 'boolean' ||
      i.finalized !== BigInt(i.blockNumber) <= BigInt(v.finalizedNumber)
    )
      return false;
    any = true;
    reverted ||= !i.succeeded;
    allFinal &&= i.finalized;
  }
  if (action === 'bridge' && (state === 'succeeded' || state === 'bridging')) {
    const last = v.transactions.at(-1);
    return allFinal && object(last) && object(last.inclusion) && last.inclusion.succeeded === true;
  }
  if (state === 'succeeded') return allFinal && !reverted;
  if (state === 'failed') return allFinal && reverted;
  if (state === 'signed') return !any;
  if (state === 'confirming') return any && !reverted && !allFinal;
  return true;
}
export function isOperationRecovery(v: unknown): v is OperationRecovery {
  if (
    !object(v) ||
    !object(v.operation) ||
    v.executionAvailable !== false ||
    typeof v.intentAvailable !== 'boolean'
  )
    return false;
  const o = v.operation;
  if (!isOperation(o)) return false;
  const submission = v.submission;
  if (
    submission !== null &&
    (!object(submission) ||
      submission.operationId !== o.id ||
      !Array.isArray(submission.transactionHashes) ||
      submission.transactionHashes.length < 1 ||
      submission.transactionHashes.length > 8 ||
      new Set(submission.transactionHashes).size !== submission.transactionHashes.length ||
      !submission.transactionHashes.every(
        (h: unknown) => typeof h === 'string' && /^0x[0-9a-f]{64}$/.test(h),
      ) ||
      !object(v.preparation) ||
      submission.transactionHashes.length !== v.preparation.stepCount ||
      o.state === 'created' ||
      o.state === 'awaiting_permit' ||
      o.state === 'building_swap' ||
      o.state === 'awaiting_signature')
  )
    return false;
  if (o.state === 'signed' && submission === null) return false;
  if (
    o.state === 'bridging' &&
    (submission === null || v.reconciliation === null || v.preparation === null)
  )
    return false;
  if (
    v.reconciliation !== null &&
    (!object(submission) ||
      !receipts(v.reconciliation, submission.transactionHashes as string[], o.state, o.action))
  )
    return false;
  if (v.preparation === null) return true;
  const p = v.preparation;
  if (
    !v.intentAvailable ||
    ['created', 'awaiting_permit', 'building_swap'].includes(o.state) ||
    !object(p)
  )
    return false;
  const action =
    p.provider === 'native_transfer'
      ? 'transfer'
      : p.provider === 'across'
        ? 'bridge'
        : p.provider === 'uniswap'
          ? 'swap'
          : p.provider === 'aave_v3' || p.provider === 'morpho_vault_v2'
            ? 'earn'
            : null;
  return (
    action !== null &&
    action === o.action &&
    typeof p.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(p.hash) &&
    integer(p.chainId) &&
    p.chainId !== '0' &&
    typeof p.expiresAtMs === 'number' &&
    Number.isSafeInteger(p.expiresAtMs) &&
    p.expiresAtMs > 0 &&
    typeof p.expired === 'boolean' &&
    typeof p.stepCount === 'number' &&
    Number.isInteger(p.stepCount) &&
    p.stepCount >= 1 &&
    p.stepCount <= 8 &&
    revision(p.registryRevision) &&
    revision(p.feePolicyRevision)
  );
}

export function isOperation(o: unknown): o is OperationRecovery['operation'] {
  if (!object(o)) return false;
  if (
    typeof o.id !== 'string' ||
    !OPERATION_ID.test(o.id) ||
    typeof o.walletId !== 'string' ||
    !OPERATION_ID.test(o.walletId) ||
    !['transfer', 'swap', 'bridge', 'earn', 'perps', 'prediction'].includes(o.action as string) ||
    ![
      'created',
      'awaiting_permit',
      'building_swap',
      'awaiting_signature',
      'signed',
      'submitted',
      'confirming',
      'bridging',
      'succeeded',
      'failed',
      'unknown',
    ].includes(o.state as string) ||
    !integer(o.version) ||
    (o.state === 'bridging' && o.action !== 'bridge') ||
    (['awaiting_permit', 'building_swap'].includes(o.state as string) && o.action !== 'swap')
  )
    return false;
  return true;
}

export function isOperationPage(v: unknown): v is OperationPage {
  if (
    !object(v) ||
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !(
      v.nextCursor === null ||
      (typeof v.nextCursor === 'string' && OPERATION_ID.test(v.nextCursor))
    )
  )
    return false;
  const seen = new Set<string>();
  let wallet: string | undefined;
  for (const item of v.items) {
    if (
      !object(item) ||
      !isOperation(item.operation) ||
      !Number.isSafeInteger(item.createdAtMs) ||
      !Number.isSafeInteger(item.updatedAtMs) ||
      (item.createdAtMs as number) <= 0 ||
      (item.updatedAtMs as number) <= 0 ||
      seen.has(item.operation.id) ||
      (wallet !== undefined && wallet !== item.operation.walletId)
    )
      return false;
    wallet = item.operation.walletId;
    seen.add(item.operation.id);
  }
  return (
    v.nextCursor === null || (v.items.length > 0 && v.nextCursor === v.items.at(-1)?.operation.id)
  );
}
