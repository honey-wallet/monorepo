import { OPERATION_ID } from './operations';
import type { EvmSigningRequest } from './types';
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const address = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && v !== `0x${'0'.repeat(40)}`;
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const revision = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
export const uint = (v: unknown, max = (1n << 256n) - 1n): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 && BigInt(v) <= max;
export const time = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const u64 = (1n << 64n) - 1n;
const amount = (v: unknown) =>
  object(v) && address(v.assetAddress) && uint(v.amountRaw) && address(v.recipient);
export function isEvmSigningRequest<P extends 'aave_v3' | 'morpho_vault_v2' | 'uniswap' | 'across'>(
  v: unknown,
  provider: P,
): v is EvmSigningRequest<P> {
  if (
    !['aave_v3', 'morpho_vault_v2', 'uniswap', 'across'].includes(provider) ||
    !object(v) ||
    typeof v.operationId !== 'string' ||
    !OPERATION_ID.test(v.operationId) ||
    !uint(v.operationVersion, (1n << 63n) - 1n) ||
    !hash(v.planHash) ||
    !object(v.prepared)
  )
    return false;
  const r = v.prepared;
  if (
    !object(r.plan) ||
    !uint(r.firstNonce, u64) ||
    !uint(r.maxFeePerGas, (1n << 128n) - 1n) ||
    !uint(r.maxPriorityFeePerGas, (1n << 128n) - 1n) ||
    BigInt(r.maxPriorityFeePerGas) > BigInt(r.maxFeePerGas) ||
    !Array.isArray(r.gasLimits)
  )
    return false;
  const p = r.plan;
  if (
    p.schemaVersion !== 1 ||
    p.provider !== provider ||
    p.chainId !== '31337' ||
    !address(p.signer) ||
    !hash(p.intentHash) ||
    !revision(p.registryRevision) ||
    !revision(p.feePolicyRevision) ||
    !(['uniswap', 'across'].includes(provider)
      ? revision(p.quoteReference)
      : p.quoteReference === null) ||
    !time(p.expiresAtMs) ||
    !uint(p.maximumNetworkFeeRaw) ||
    !amount(p.maximumSpend) ||
    !(p.minimumReceive === null || amount(p.minimumReceive)) ||
    !Array.isArray(p.fees) ||
    !(provider === 'uniswap'
      ? p.fees.length <= 4 && p.fees.every((f) => object(f) && f.kind === 'app' && amount(f.amount))
      : p.fees.length === 0) ||
    !object(p.simulation) ||
    !uint(p.simulation.blockNumber, u64) ||
    typeof p.simulation.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(p.simulation.blockHash) ||
    !hash(p.simulation.callsHash) ||
    !time(p.simulation.observedAtMs) ||
    p.simulation.observedAtMs >= p.expiresAtMs ||
    !Array.isArray(p.steps) ||
    p.steps.length < 1 ||
    p.steps.length > 3 ||
    r.gasLimits.length !== p.steps.length ||
    BigInt(r.firstNonce) + BigInt(p.steps.length) > u64
  )
    return false;
  const steps = p.steps;
  if (
    !steps.every(
      (s, n) =>
        object(s) &&
        s.purpose === (n === steps.length - 1 ? 'action' : 'approval') &&
        address(s.to) &&
        s.valueRaw === '0' &&
        typeof s.data === 'string' &&
        (provider === 'uniswap' && s.purpose === 'action'
          ? /^0x(?:[0-9a-f]{2}){4,65536}$/
          : /^0x(?:[0-9a-f]{2}){4,4096}$/
        ).test(s.data),
    )
  )
    return false;
  let gas = 0n;
  for (const g of r.gasLimits) {
    if (!uint(g, 2_000_000n) || BigInt(g) < 21000n) return false;
    gas += BigInt(g);
  }
  return gas * BigInt(r.maxFeePerGas) === BigInt(p.maximumNetworkFeeRaw);
}
/** Exact type-2 transaction requests; caller still owns confirmation and cancellation. */
export function evmTransactionRequests(
  r: EvmSigningRequest<'aave_v3' | 'morpho_vault_v2' | 'uniswap' | 'across'>,
) {
  if (
    !isEvmSigningRequest(r, r?.prepared?.plan?.provider) ||
    BigInt(r.prepared.firstNonce) + BigInt(r.prepared.plan.steps.length) >
      BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Unsupported EVM signing terms.');
  return r.prepared.plan.steps.map((s, n) => ({
    type: 'eip1559' as const,
    chainId: 31337,
    nonce: Number(BigInt(r.prepared.firstNonce) + BigInt(n)),
    gas: BigInt(r.prepared.gasLimits[n] as string),
    maxFeePerGas: BigInt(r.prepared.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(r.prepared.maxPriorityFeePerGas),
    to: s.to as `0x${string}`,
    data: s.data as `0x${string}`,
    value: 0n,
  }));
}
