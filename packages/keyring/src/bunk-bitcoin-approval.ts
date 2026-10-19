import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bunkPrivateKeyFor } from './bunk';
import {
  type BunkBitcoinSpendRequest,
  type BunkBitcoinUtxo,
  prepareBunkBitcoinSpend,
} from './bunk-bitcoin';
import { discoverBunkBitcoinUtxos } from './bunk-bitcoin-discovery';
import { observeBunkBitcoinFeePolicy, selectBunkBitcoinFee } from './bunk-bitcoin-fees';
import { discoverBunkBitcoinHistory } from './bunk-bitcoin-history';
import {
  claimBunkBitcoinApproval,
  persistBunkBitcoinSignatures,
  readBunkBitcoinApproval,
  readBunkBitcoinJournal,
  reserveBunkBitcoinApproval,
} from './bunk-bitcoin-journal';
import { estimateBunkBitcoinChildFee, observeBunkBitcoinInputs } from './bunk-bitcoin-observe';
import {
  type BunkBitcoinObservationAccess,
  check,
  hash,
  openBitcoinObservation,
} from './bunk-bitcoin-rpc';
import { type BunkJournalStore, BunkSigningUncertain } from './bunk-evm-v2-journal';

export interface BunkBitcoinApprovalRequest {
  id: string;
  changeAllocationId: string;
  spend: BunkBitcoinSpendRequest;
  feePolicy: {
    confirmationTarget: number;
    mode: 'economical' | 'conservative';
    minimumRateSatPerKvB: bigint;
    maximumRateSatPerKvB: bigint;
    fallbackRateSatPerKvB?: bigint;
  };
  allowUnconfirmed: boolean;
}
const json = (v: unknown) =>
  JSON.stringify(v, (_k, value) => (typeof value === 'bigint' ? value.toString() : value));
const coinsKey = (coins: readonly BunkBitcoinUtxo[]) =>
  json(
    coins
      .map((u) => [u.txid, u.vout, u.ownerIndex, u.satoshis, u.scriptPubKey])
      .sort((a, b) => json(a).localeCompare(json(b))),
  );

function snapshot(input: BunkBitcoinApprovalRequest): BunkBitcoinApprovalRequest {
  check(
    hash(input.id) !== '0'.repeat(64) && hash(input.changeAllocationId) !== '0'.repeat(64),
    'empty approval ID',
  );
  check(typeof input.allowUnconfirmed === 'boolean', 'pending-input policy required');
  const s = input.spend,
    f = input.feePolicy;
  return {
    id: input.id,
    changeAllocationId: input.changeAllocationId,
    allowUnconfirmed: input.allowUnconfirmed,
    spend: {
      network: s.network,
      accountIndex: s.accountIndex,
      changeIndex: s.changeIndex,
      utxos: s.utxos.map((u) => ({ ...u })),
      payments: s.payments.map((p) => ({ ...p })),
      feeRateSatPerKvB: s.feeRateSatPerKvB,
      dustRelayFeeSatPerKvB: s.dustRelayFeeSatPerKvB,
      maxFeeSat: s.maxFeeSat,
      lockTime: s.lockTime,
    },
    feePolicy: {
      confirmationTarget: f.confirmationTarget,
      mode: f.mode,
      minimumRateSatPerKvB: f.minimumRateSatPerKvB,
      maximumRateSatPerKvB: f.maximumRateSatPerKvB,
      fallbackRateSatPerKvB: f.fallbackRateSatPerKvB,
    },
  };
}
function preparation(seed: Uint8Array, key: string, request: BunkBitcoinApprovalRequest) {
  const prepared = prepareBunkBitcoinSpend(seed, request.spend);
  // Canonical selected plan, exact bytes AND previous-output signature digests.
  // Unselected candidates do not change the review identity.
  const reviewDigest = bytesToHex(
    sha256(
      utf8ToBytes(
        json([
          'HoneyBitcoinReviewedApprovalV1',
          key,
          request.id,
          request.changeAllocationId,
          { ...request.spend, utxos: prepared.selected },
          request.feePolicy,
          request.allowUnconfirmed,
          prepared.unsignedTransaction,
          prepared.signatureDigests,
        ]),
      ),
    ),
  );
  return { prepared, reviewDigest };
}
function accessSnapshot(access: BunkBitcoinObservationAccess): BunkBitcoinObservationAccess {
  return {
    rpc: { request: access.rpc.request.bind(access.rpc) },
    now: access.now,
    maxTipAgeSeconds: access.maxTipAgeSeconds,
    minConfirmations: access.minConfirmations,
    signal: access.signal,
  };
}
async function withSeed<T>(seed: Uint8Array, run: (owned: Uint8Array) => Promise<T>): Promise<T> {
  check(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const owned = seed.slice();
  try {
    return await run(owned);
  } finally {
    owned.fill(0);
  }
}

async function review(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  request: BunkBitcoinApprovalRequest,
  access: BunkBitcoinObservationAccess,
) {
  const { prepared, reviewDigest } = preparation(seed, key, request),
    s = request.spend;
  const journal = await readBunkBitcoinJournal(store, key, seed);
  check(
    journal.scope.network === s.network && journal.scope.accountIndex === s.accountIndex,
    'approval scope mismatch',
  );
  const change = journal.allocations.find((a) => a.id === request.changeAllocationId);
  check(
    !!change && change.purpose === 'change' && change.ownerIndex === s.changeIndex,
    'change allocation unavailable',
  );
  check(
    prepared.selected.every((u) => u.ownerIndex < journal.nextOwnerIndex),
    'unallocated input owner',
  );
  const context = await openBitcoinObservation(s.network, access),
    checkpoint = context.checkpoint;
  const sameTip = (point: typeof checkpoint) =>
    check(json(point) === json(checkpoint), 'tip changed during approval review');
  check(s.lockTime <= checkpoint.height, 'future transaction locktime');
  const fees = await observeBunkBitcoinFeePolicy(
    {
      network: s.network,
      confirmationTarget: request.feePolicy.confirmationTarget,
      mode: request.feePolicy.mode,
      previousCheckpoint: checkpoint,
    },
    access,
  );
  sameTip(fees.checkpoint);
  const budget = selectBunkBitcoinFee(fees, {
    ...request.feePolicy,
    maxVbytes: prepared.maxVbytes,
    maxFeeSatoshis: s.maxFeeSat,
  });
  check(
    s.feeRateSatPerKvB >= budget.feeRateSatPerKvB &&
      s.feeRateSatPerKvB <= request.feePolicy.maximumRateSatPerKvB,
    'approved fee rate no longer meets policy',
  );

  // Scan exactly the selected owner groups plus change. Contiguous ranges share
  // bounded pages; sparse indices never force a scan of intervening addresses.
  const indices = [...new Set([...prepared.selected.map((u) => u.ownerIndex), s.changeIndex])].sort(
    (a, b) => a - b,
  );
  const inventory: BunkBitcoinUtxo[] = [];
  for (let offset = 0; offset < indices.length; ) {
    const start = indices[offset];
    check(start !== undefined, 'missing owner');
    let count = 1;
    while (count < 20 && indices[offset + count] === start + count) count++;
    offset += count;
    const range = {
      network: s.network,
      accountIndex: s.accountIndex,
      startOwnerIndex: start,
      count,
      previousCheckpoint: checkpoint,
    };
    const confirmed = await discoverBunkBitcoinUtxos(seed, range, access);
    sameTip(confirmed.checkpoint);
    const history = await discoverBunkBitcoinHistory(
      seed,
      { ...range, fromHeight: checkpoint.height, blockCount: 1 },
      access,
    );
    sameTip(history.checkpoint);
    for (const owner of confirmed.candidates) {
      check(
        owner.ownerIndex !== s.changeIndex || owner.coins.length === 0,
        'change address already funded',
      );
      check(
        owner.coins.every((u) => u.status === 'available'),
        'owner group has unavailable confirmed coins',
      );
      inventory.push(...owner.coins);
    }
    for (const event of history.events) {
      check(event.ownerIndex !== s.changeIndex, 'change address has observed activity');
      if (event.location !== null) continue;
      check(event.type === 'receive', 'owner group has a pending spend');
      inventory.push({
        txid: event.txid,
        vout: event.vout,
        satoshis: event.satoshis,
        ownerIndex: event.ownerIndex,
        scriptPubKey: event.scriptPubKey,
      });
    }
  }
  check(
    coinsKey(inventory) === coinsKey(prepared.selected),
    'selected owner group changed or incomplete',
  );
  const inputs = await observeBunkBitcoinInputs(
    seed,
    {
      network: s.network,
      accountIndex: s.accountIndex,
      inputs: prepared.selected,
      previousCheckpoint: checkpoint,
    },
    access,
  );
  sameTip(inputs.checkpoint);
  check(
    inputs.inputs.every(
      (u) => u.status === 'confirmed' || (request.allowUnconfirmed && u.status === 'unconfirmed'),
    ),
    'input unavailable or unconfirmed consent missing',
  );
  const packageBudget =
    inputs.unconfirmedTransactions.length > 0
      ? estimateBunkBitcoinChildFee({
          ancestors: inputs.unconfirmedTransactions,
          childMaxVbytes: prepared.maxVbytes,
          targetRateSatPerKvB: budget.feeRateSatPerKvB,
          minimumChildRateSatPerKvB: budget.feeRateSatPerKvB,
          maxFeeSatoshis: s.maxFeeSat,
        })
      : null;
  check(
    !packageBudget || prepared.feeSatoshis >= packageBudget.feeSatoshis,
    'approved fee insufficient for ancestor package',
  );
  await context.finish();
  return {
    reviewDigest,
    prepared,
    checkpoint,
    fees,
    inputs,
    packageBudget,
    signingAuthorized: false as const,
  };
}

/** Read-only review of an already constructed plan. Uses Core31 filter history
 * for incoming pending deposits as well as confirmed UTXOs. Requires a preserved
 * journal and allocated change; does not allocate, approve, sign or reserve.
 * Observations are not atomic with each other/the later CAS. The native signer
 * must observe again around claiming. Missing-history restore is a separate path. */
export async function reviewBunkBitcoinApproval(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  input: BunkBitcoinApprovalRequest,
  access: BunkBitcoinObservationAccess,
) {
  const request = snapshot(input),
    transport = accessSnapshot(access);
  return withSeed(seed, (owned) => review(store, key, owned, request, transport));
}

/** Call only after the user approves this exact reviewDigest. Rechecks observations
 * without repricing or replacing any approved bytes. Existing IDs recover the
 * original durable approval without RPC or fresh authorization, including lost
 * commit acknowledgements. A resumed result carries no current-chain observation. */
export async function reserveObservedBunkBitcoinApproval(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  input: BunkBitcoinApprovalRequest & { approvedReviewDigest: string },
  access: BunkBitcoinObservationAccess,
) {
  const request = snapshot(input),
    approved = hash(input.approvedReviewDigest),
    transport = accessSnapshot(access);
  return withSeed(seed, async (owned) => {
    check(preparation(owned, key, request).reviewDigest === approved, 'reviewed approval changed');
    const journal = await readBunkBitcoinJournal(store, key, owned);
    const resumed = journal.approvals.some((a) => a.id === request.id);
    const observation = resumed ? null : await review(store, key, owned, request, transport);
    check(!transport.signal?.aborted, 'cancelled');
    const approval = await reserveBunkBitcoinApproval(store, key, owned, request);
    return { approval, observation, resumed, signingAuthorized: false as const };
  });
}

/**
 * Sign an existing durable approval under the strict one-digest-per-owner policy.
 * The caller must carry the exact user-approved review digest and stored approval
 * digest. Observe before AND after the durable claim; persist verified signatures
 * before returning bytes. No input substitution, repricing or broadcast occurs.
 * A claimed/uncertain approval cannot be signed again. Retry a saved signed result
 * returns its exact bytes without RPC or another signature computation.
 * Multiple inputs belonging to one owner reject pending an explicit policy decision.
 */
export async function signObservedBunkBitcoinApproval(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  input: BunkBitcoinApprovalRequest & {
    approvedReviewDigest: string;
    approvalDigest: string;
  },
  access: BunkBitcoinObservationAccess,
) {
  const request = snapshot(input),
    approvedReviewDigest = hash(input.approvedReviewDigest),
    approvalDigest = hash(input.approvalDigest),
    transport = accessSnapshot(access);
  return withSeed(seed, async (owned) => {
    const plan = preparation(owned, key, request);
    check(plan.reviewDigest === approvedReviewDigest, 'reviewed approval changed');
    const saved = await readBunkBitcoinApproval(store, key, owned, request.id);
    check(saved.digest === approvalDigest, 'approval digest changed');
    // Read above requires an existing approval; this idempotent call verifies the
    // full stored plan, including fee caps and change-allocation identity.
    const approval = await reserveBunkBitcoinApproval(store, key, owned, request);
    check(approval.digest === approvalDigest, 'approval digest changed');
    check(
      new Set(approval.prepared.selected.map((u) => u.ownerIndex)).size ===
        approval.prepared.selected.length,
      'multiple inputs per owner require a signing-policy decision',
    );
    check(!transport.signal?.aborted, 'cancelled');
    if (approval.phase === 'signed')
      return { approval, observation: null, resumed: true, signingAuthorized: false as const };
    if (approval.phase === 'claimed') throw new BunkSigningUncertain();
    check(approval.phase === 'approved', 'approval is not claimable');
    await review(store, key, owned, request, transport);
    check(!transport.signal?.aborted, 'cancelled');
    const claimed = await claimBunkBitcoinApproval(store, key, owned, {
      id: request.id,
      digest: approvalDigest,
    });
    // Failure/cancellation from here leaves the claim intact, including when no
    // signature was computed. Never infer a reusable key from an error response.
    const observation = await review(store, key, owned, request, transport);
    check(!transport.signal?.aborted, 'cancelled');
    const signatures = claimed.prepared.selected.map((coin, index) => {
      const signatureDigest = claimed.prepared.signatureDigests[index];
      check(signatureDigest !== undefined, 'missing approved signature digest');
      const secret = bunkPrivateKeyFor(owned, {
        network: { family: 'bitcoin', network: request.spend.network },
        accountIndex: request.spend.accountIndex,
        ownerIndex: coin.ownerIndex,
      });
      try {
        return bytesToHex(
          secp256k1.sign(hexToBytes(signatureDigest), secret, {
            prehash: false,
            lowS: true,
            format: 'der',
            extraEntropy: false,
          }),
        );
      } finally {
        secret.fill(0);
      }
    });
    // Do not abandon signatures on a late cancellation: finish persistence so an
    // exact-byte retry can recover a committed write whose acknowledgement is lost.
    const signed = await persistBunkBitcoinSignatures(store, key, owned, {
      id: request.id,
      digest: approvalDigest,
      signatures,
    });
    return {
      approval: signed,
      observation,
      resumed: false,
      signingAuthorized: false as const,
    };
  });
}
