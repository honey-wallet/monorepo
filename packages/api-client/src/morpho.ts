import {
  address,
  evmTransactionRequests,
  isEvmSigningRequest,
  object,
  revision,
  time,
  uint,
} from './evm-signing';
import { OPERATION_ID } from './operations';
import type {
  MorphoExecutionConfiguration,
  MorphoIntent,
  MorphoIntentRecovery,
  MorphoQuote,
  MorphoSigningRequest,
} from './types';

const MAX = (1n << 256n) - 1n;
const positive = (v: unknown): v is string => uint(v) && BigInt(v) > 0n && BigInt(v) < MAX;
export function isMorphoExecutionConfiguration(v: unknown): v is MorphoExecutionConfiguration {
  return (
    object(v) &&
    v.mode === 'local_fork' &&
    v.chainId === '31337' &&
    address(v.vault) &&
    address(v.bundle) &&
    address(v.asset) &&
    typeof v.assetDecimals === 'number' &&
    Number.isInteger(v.assetDecimals) &&
    v.assetDecimals >= 0 &&
    v.assetDecimals <= 18 &&
    typeof v.shareDecimals === 'number' &&
    Number.isInteger(v.shareDecimals) &&
    v.shareDecimals >= 0 &&
    v.shareDecimals <= 36 &&
    uint(v.performanceFeeWad, 500_000_000_000_000_000n) &&
    uint(v.managementFeePerSecondWad, 50_000_000_000_000_000n / 31_536_000n) &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    v.redemptionOutputProtection === 'none'
  );
}
export function isMorphoIntent(v: unknown): v is MorphoIntent {
  return (
    object(v) &&
    address(v.vault) &&
    positive(v.amountRaw) &&
    positive(v.maximumNetworkFeeRaw) &&
    uint(v.deadline, 9_007_199_254_740n) &&
    v.deadline !== '0' &&
    ((v.action === 'deposit' &&
      positive(v.minimumSharesRaw) &&
      v.acknowledgeUnprotectedOutput === false) ||
      (v.action === 'redeem' &&
        v.minimumSharesRaw === null &&
        v.acknowledgeUnprotectedOutput === true))
  );
}
export function isMorphoIntentRecovery(v: unknown): v is MorphoIntentRecovery {
  return (
    object(v) &&
    typeof v.operationId === 'string' &&
    OPERATION_ID.test(v.operationId) &&
    address(v.signer) &&
    v.chainId === '31337' &&
    address(v.asset) &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    isMorphoIntent(v.intent)
  );
}
export function isMorphoSigningRequest(v: unknown): v is MorphoSigningRequest {
  return isEvmSigningRequest(v, 'morpho_vault_v2');
}
export function isMorphoQuote(v: unknown): v is MorphoQuote {
  return (
    object(v) &&
    ['deposit', 'redeem'].includes(v.action as string) &&
    positive(v.amountRaw) &&
    address(v.signer) &&
    v.chainId === '31337' &&
    address(v.vault) &&
    address(v.asset) &&
    uint(v.assetBalanceRaw) &&
    uint(v.shareBalanceRaw) &&
    positive(v.previewAssetsRaw) &&
    positive(v.previewSharesRaw) &&
    revision(v.registryRevision) &&
    revision(v.feePolicyRevision) &&
    uint(v.blockNumber, (1n << 64n) - 1n) &&
    typeof v.blockHash === 'string' &&
    /^0x[0-9a-f]{64}$/.test(v.blockHash) &&
    time(v.observedAtMs) &&
    time(v.expiresAtMs) &&
    v.expiresAtMs - v.observedAtMs === 30000 &&
    (v.action === 'deposit'
      ? v.previewAssetsRaw === v.amountRaw
      : v.previewSharesRaw === v.amountRaw)
  );
}
/** Pure sizing from a fresh, identity-bound quote. No signing or execution permission. */
export function morphoIntentFromQuote(
  q: MorphoQuote,
  c: MorphoExecutionConfiguration,
  signer: string,
  options: {
    slippageBps: number;
    acknowledgeUnprotectedOutput: boolean;
    maximumNetworkFeeRaw: string;
  },
  now = Date.now(),
): MorphoIntent {
  if (
    !isMorphoQuote(q) ||
    !isMorphoExecutionConfiguration(c) ||
    q.signer !== signer.toLowerCase() ||
    q.vault !== c.vault ||
    q.asset !== c.asset ||
    q.registryRevision !== c.registryRevision ||
    q.feePolicyRevision !== c.feePolicyRevision ||
    q.expiresAtMs <= now ||
    q.observedAtMs > now + 2000 ||
    !Number.isInteger(options.slippageBps) ||
    options.slippageBps < 0 ||
    options.slippageBps > 1000
  )
    throw new Error('Refresh the Morpho quote before reviewing.');
  const minimum =
    q.action === 'deposit'
      ? ((BigInt(q.previewSharesRaw) * BigInt(10000 - options.slippageBps)) / 10000n).toString()
      : null;
  const i: MorphoIntent = {
    vault: c.vault,
    action: q.action,
    amountRaw: q.amountRaw,
    minimumSharesRaw: minimum,
    acknowledgeUnprotectedOutput: options.acknowledgeUnprotectedOutput,
    deadline: String(Math.floor(now / 1000) + 600),
    maximumNetworkFeeRaw: options.maximumNetworkFeeRaw,
  };
  if (!isMorphoIntent(i)) throw new Error('Invalid Morpho amount or withdrawal acknowledgment.');
  return i;
}
export interface MorphoReviewContext {
  configuration: MorphoExecutionConfiguration;
  intent: MorphoIntent;
  signer: string;
  operationId: string;
  operationVersion: string;
  planHash: string;
}
/** Independent exact ABI/economics validation, including zero fees and no permits. */
export function validateMorphoReview(
  r: MorphoSigningRequest,
  e: MorphoReviewContext,
  now = Date.now(),
): void {
  const bad = (): never => {
    throw new Error('Morpho signing request does not match your reviewed operation.');
  };
  if (
    !isMorphoSigningRequest(r) ||
    !isMorphoExecutionConfiguration(e.configuration) ||
    !isMorphoIntent(e.intent)
  )
    bad();
  const p = r.prepared.plan,
    c = e.configuration,
    i = e.intent;
  if (
    r.operationId !== e.operationId ||
    r.operationVersion !== e.operationVersion ||
    r.planHash !== e.planHash ||
    p.signer !== e.signer.toLowerCase() ||
    p.chainId !== c.chainId ||
    i.vault !== c.vault ||
    p.registryRevision !== c.registryRevision ||
    p.feePolicyRevision !== c.feePolicyRevision ||
    p.expiresAtMs <= now ||
    p.expiresAtMs > now + 900_000 ||
    p.expiresAtMs > Number(i.deadline) * 1000 ||
    Number(i.deadline) * 1000 <= now ||
    Number(i.deadline) * 1000 > now + 900_000 ||
    p.simulation.observedAtMs > now + 2000 ||
    BigInt(p.maximumNetworkFeeRaw) > BigInt(i.maximumNetworkFeeRaw) ||
    p.maximumSpend.recipient !== p.signer ||
    p.maximumSpend.amountRaw !== i.amountRaw
  )
    bad();
  const word = (v: string | number | bigint) => BigInt(v).toString(16).padStart(64, '0');
  let expectedData: string;
  const deposit = i.action === 'deposit';
  if (deposit) {
    const numerator = BigInt(i.amountRaw) * 10n ** 27n;
    if (numerator > MAX || i.minimumSharesRaw === null) bad();
    const price = numerator / BigInt(i.minimumSharesRaw ?? bad());
    if (price === 0n) bad();
    expectedData = `0x6bbba4e0${[c.vault, i.amountRaw, price, 224, 0, 0, i.deadline, 0, 64, 0].map(word).join('')}`;
    if (
      p.maximumSpend.assetAddress !== c.asset ||
      p.minimumReceive?.assetAddress !== c.vault ||
      p.minimumReceive.amountRaw !== i.minimumSharesRaw ||
      p.minimumReceive.recipient !== p.signer
    )
      bad();
  } else {
    expectedData = `0x932084a8${[c.vault, 0, i.amountRaw, 0, 0, 0, 0, 0, 0, 0, 0, i.deadline].map(word).join('')}`;
    if (p.maximumSpend.assetAddress !== c.vault || p.minimumReceive !== null) bad();
  }
  const action = p.steps.at(-1);
  if (!action || action.to !== c.bundle || action.data !== expectedData) bad();
  for (let n = 0; n < p.steps.length - 1; n++) {
    const step = p.steps[n];
    const approved = n === p.steps.length - 2 ? i.amountRaw : '0';
    if (
      !step ||
      step.to !== (deposit ? c.asset : c.vault) ||
      step.data !== `0x095ea7b3${word(c.bundle)}${word(approved)}`
    )
      bad();
  }
}
export function morphoTransactionRequests(r: MorphoSigningRequest) {
  if (!isMorphoSigningRequest(r)) throw new Error('Unsupported Morpho signing terms.');
  return evmTransactionRequests(r);
}
