import { BITCOIN_MAX_SATOSHIS, type BunkBitcoinNetwork } from './bunk-bitcoin';
import {
  amount,
  type BunkBitcoinCheckpoint,
  type BunkBitcoinObservationAccess,
  check,
  integer,
  openBitcoinObservation,
  record,
} from './bunk-bitcoin-rpc';

export type BunkBitcoinFeeEstimate =
  | { status: 'available'; rateSatPerKvB: bigint; blocks: number }
  | { status: 'unavailable'; blocks: number; errors: string[] };
export interface BunkBitcoinFeePolicy {
  checkpoint: BunkBitcoinCheckpoint;
  blockTime: number;
  requestedBlocks: number;
  mode: 'economical' | 'conservative';
  minimumRelaySatPerKvB: bigint;
  minimumMempoolSatPerKvB: bigint;
  incrementalRelaySatPerKvB: bigint;
  estimate: BunkBitcoinFeeEstimate;
  signingAuthorized: false;
}

function rate(value: unknown, positive = false): bigint {
  check(
    typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= 100_000_000n,
    'invalid fee rate',
  );
  return value;
}
function policy(value: unknown) {
  const data = record(value);
  check(data.loaded === true, 'mempool not loaded');
  const minimumRelaySatPerKvB = rate(amount(data.minrelaytxfee)),
    minimumMempoolSatPerKvB = rate(amount(data.mempoolminfee)),
    incrementalRelaySatPerKvB = rate(amount(data.incrementalrelayfee));
  check(minimumMempoolSatPerKvB >= minimumRelaySatPerKvB, 'inconsistent mempool minimum');
  return { minimumRelaySatPerKvB, minimumMempoolSatPerKvB, incrementalRelaySatPerKvB };
}
function estimate(value: unknown): BunkBitcoinFeeEstimate {
  const data = record(value),
    blocks = data.blocks;
  check(
    typeof blocks === 'number' && Number.isSafeInteger(blocks) && blocks >= -1 && blocks <= 1008,
    'invalid estimate target',
  );
  if (data.feerate !== undefined) {
    check(data.errors === undefined && blocks >= 2, 'inconsistent fee estimate');
    return { status: 'available', rateSatPerKvB: rate(amount(data.feerate), true), blocks };
  }
  check(
    Array.isArray(data.errors) &&
      data.errors.length > 0 &&
      data.errors.length <= 8 &&
      data.errors.every((e) => typeof e === 'string' && e.length > 0 && e.length <= 512),
    'invalid unavailable estimate',
  );
  return { status: 'unavailable', blocks, errors: [...data.errors] as string[] };
}

/** Trusted Core fee observation, without keys or wallet imports. Rates are integer
 * satoshis per 1,000 virtual bytes. The estimate's returned block target may differ
 * from the requested one. Policy is rechecked, but this is not a relay/mining promise.
 * Dust policy is not exposed by these RPCs: supply it separately to the builder. */
export async function observeBunkBitcoinFeePolicy(
  input: {
    network: BunkBitcoinNetwork;
    confirmationTarget: number;
    mode: 'economical' | 'conservative';
    previousCheckpoint?: BunkBitcoinCheckpoint;
  },
  access: BunkBitcoinObservationAccess,
): Promise<BunkBitcoinFeePolicy> {
  const network = input.network,
    requestedBlocks = integer(input.confirmationTarget, 1008),
    mode = input.mode,
    previous = input.previousCheckpoint && { ...input.previousCheckpoint };
  check(
    requestedBlocks > 0 && (mode === 'economical' || mode === 'conservative'),
    'invalid fee request',
  );
  const context = await openBitcoinObservation(network, access, previous);
  const initial = policy(await context.rpc('getmempoolinfo'));
  const result = estimate(await context.rpc('estimatesmartfee', [requestedBlocks, mode]));
  const final = policy(await context.rpc('getmempoolinfo'));
  check(
    initial.minimumRelaySatPerKvB === final.minimumRelaySatPerKvB &&
      initial.minimumMempoolSatPerKvB === final.minimumMempoolSatPerKvB &&
      initial.incrementalRelaySatPerKvB === final.incrementalRelaySatPerKvB,
    'fee policy changed during observation',
  );
  await context.finish();
  return {
    checkpoint: context.checkpoint,
    blockTime: context.blockTime,
    requestedBlocks,
    mode,
    ...final,
    estimate: result,
    signingAuthorized: false,
  };
}

/** Choose a bounded construction rate. An unavailable estimate requires explicit
 * fallback consent from the caller; transport/malformed-data errors never fall back.
 * Recompute when transaction shape changes. Pass maxFeeSatoshis to the builder too:
 * discarded dust change can increase its final fee above estimatedFeeSatoshis.
 * For pending parents, additionally calculate the ancestor package/child budget. */
export function selectBunkBitcoinFee(
  observed: BunkBitcoinFeePolicy,
  request: {
    maxVbytes: number;
    minimumRateSatPerKvB: bigint;
    maximumRateSatPerKvB: bigint;
    maxFeeSatoshis: bigint;
    fallbackRateSatPerKvB?: bigint;
  },
) {
  const size = integer(request.maxVbytes, 1_000_000),
    minimum = rate(request.minimumRateSatPerKvB, true),
    maximum = rate(request.maximumRateSatPerKvB, true),
    cap = request.maxFeeSatoshis,
    fallback = request.fallbackRateSatPerKvB;
  check(size > 0 && maximum >= minimum, 'invalid fee budget');
  check(typeof cap === 'bigint' && cap > 0n && cap <= BITCOIN_MAX_SATOSHIS, 'invalid fee cap');
  if (fallback !== undefined) rate(fallback, true);
  const relay = rate(observed.minimumRelaySatPerKvB),
    mempool = rate(observed.minimumMempoolSatPerKvB);
  check(mempool >= relay, 'inconsistent mempool minimum');
  check(
    observed.estimate.status === 'available' || observed.estimate.status === 'unavailable',
    'invalid estimate status',
  );
  check(
    observed.estimate.status === 'available' || fallback !== undefined,
    'fee estimate unavailable; explicit fallback required',
  );
  const selected =
    observed.estimate.status === 'available'
      ? rate(observed.estimate.rateSatPerKvB, true)
      : rate(fallback, true);
  const feeRateSatPerKvB = [minimum, relay, mempool, selected].reduce((a, b) => (a > b ? a : b));
  check(feeRateSatPerKvB <= maximum, 'fee rate exceeds cap');
  const estimatedFeeSatoshis = (BigInt(size) * feeRateSatPerKvB + 999n) / 1000n;
  check(estimatedFeeSatoshis <= cap, 'estimated fee exceeds cap');
  return {
    source:
      observed.estimate.status === 'available'
        ? ('estimate' as const)
        : ('explicit-fallback' as const),
    feeRateSatPerKvB,
    estimatedFeeSatoshis,
    maxVbytes: size,
    maxFeeSatoshis: cap,
    signingAuthorized: false as const,
  };
}
