import type { BunkBitcoinNetwork } from './bunk-bitcoin';
import { readBunkBitcoinApproval, readBunkBitcoinJournal } from './bunk-bitcoin-journal';
import {
  amount,
  type BunkBitcoinCheckpoint,
  type BunkBitcoinObservationAccess,
  check,
  hash,
  integer,
  openBitcoinObservation,
  record,
} from './bunk-bitcoin-rpc';
import type { BunkJournalStore } from './bunk-evm-v2-journal';

export interface BunkBitcoinSavedApprovalRequest {
  network: BunkBitcoinNetwork;
  id: string;
  digest: string;
  previousCheckpoint?: BunkBitcoinCheckpoint;
}
export type BunkBitcoinTransactionState =
  | { status: 'not-observed'; confirmations: 0; block: null }
  | { status: 'pending'; confirmations: 0; block: null }
  | { status: 'orphaned'; confirmations: 0; block: { height: number; blockhash: string } }
  | {
      status: 'included' | 'confirmed';
      confirmations: number;
      block: { height: number; blockhash: string };
    };

/** Sending may have succeeded even if the transport/cancellation/response failed.
 * Retain the signed journal; observe/retry identical bytes, never sign a replacement. */
export class BunkBitcoinSubmissionUncertain extends Error {
  readonly txid: string;
  readonly wtxid: string;
  constructor(txid: string, wtxid: string, cause: unknown) {
    super(
      'Bitcoin submission outcome uncertain; retain the saved transaction and observe before retrying',
      { cause },
    );
    this.name = 'BunkBitcoinSubmissionUncertain';
    this.txid = txid;
    this.wtxid = wtxid;
  }
}
function requestSnapshot(input: BunkBitcoinSavedApprovalRequest) {
  return {
    network: input.network,
    id: hash(input.id),
    digest: hash(input.digest),
    previousCheckpoint: input.previousCheckpoint && { ...input.previousCheckpoint },
  };
}
function accessSnapshot(a: BunkBitcoinObservationAccess): BunkBitcoinObservationAccess {
  return {
    rpc: { request: a.rpc.request.bind(a.rpc) },
    now: a.now,
    maxTipAgeSeconds: a.maxTipAgeSeconds,
    minConfirmations: a.minConfirmations,
    signal: a.signal,
  };
}
async function load(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  r: BunkBitcoinSavedApprovalRequest,
) {
  check(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const owned = seed.slice();
  try {
    const journal = await readBunkBitcoinJournal(store, key, owned);
    check(journal.scope.network === r.network, 'submission network mismatch');
    const approval = await readBunkBitcoinApproval(store, key, owned, r.id);
    check(
      approval.digest === r.digest && approval.phase === 'signed' && !!approval.signed,
      'saved signed approval required',
    );
    return { ...approval.signed, feeSatoshis: approval.prepared.feeSatoshis };
  } finally {
    owned.fill(0);
  }
}
type Saved = Awaited<ReturnType<typeof load>>;
type Context = Awaited<ReturnType<typeof openBitcoinObservation>>;
function absent(error: unknown) {
  // Core -5 also covers unavailable indexes/block data. It is never proof of
  // non-broadcast or failure. Adapters must preserve numeric RPC error codes.
  return error !== null && typeof error === 'object' && 'code' in error && error.code === -5;
}
async function state(
  saved: Saved,
  c: Context,
  blockHint?: string,
): Promise<BunkBitcoinTransactionState> {
  let value: unknown;
  try {
    value = await c.rpc(
      'getrawtransaction',
      blockHint ? [saved.txid, 1, blockHint] : [saved.txid, 1],
    );
  } catch (error) {
    if (absent(error)) return { status: 'not-observed', confirmations: 0, block: null };
    throw error;
  }
  const raw = record(value);
  check(
    raw.hex === saved.rawTransaction &&
      raw.txid === saved.txid &&
      raw.hash === saved.wtxid &&
      raw.vsize === saved.vbytes &&
      raw.weight === saved.weight &&
      raw.size === saved.rawTransaction.length / 2,
    'observed transaction differs from saved bytes',
  );
  const blockhash = raw.blockhash === undefined ? undefined : hash(raw.blockhash),
    confirmations = raw.confirmations,
    active = raw.in_active_chain;
  if (!blockhash) {
    check(
      !blockHint && (confirmations === undefined || confirmations === 0) && active === undefined,
      'inconsistent pending transaction',
    );
    return { status: 'pending', confirmations: 0, block: null };
  }
  check(!blockHint || blockHint === blockhash, 'transaction block hint mismatch');
  const header = record(await c.rpc('getblockheader', [blockhash, true])),
    height = integer(header.height);
  check(header.hash === blockhash, 'transaction block header mismatch');
  if (header.confirmations === -1) {
    check(
      confirmations === 0 && (!blockHint || active === false),
      'inconsistent orphaned transaction',
    );
    return { status: 'orphaned', confirmations: 0, block: { height, blockhash } };
  }
  const count = integer(confirmations);
  check(
    count > 0 &&
      count === c.checkpoint.height - height + 1 &&
      header.confirmations === count &&
      (!blockHint || active === true),
    'inconsistent transaction confirmations',
  );
  await c.canonical({ network: c.checkpoint.network, height, blockhash });
  return {
    status: count >= c.minConfirmations ? 'confirmed' : 'included',
    confirmations: count,
    block: { height, blockhash },
  };
}
async function observed(saved: Saved, context: Context, hint?: string) {
  const first = await state(saved, context, hint),
    second = await state(saved, context, hint);
  check(
    JSON.stringify(first) === JSON.stringify(second),
    'transaction state changed during observation',
  );
  await context.finish();
  return {
    ...second,
    txid: saved.txid,
    wtxid: saved.wtxid,
    checkpoint: context.checkpoint,
    signingAuthorized: false as const,
  };
}

/** Observe only the exact saved witness/transaction. A fully synced txindex (or a
 * known block hint) is needed to find mined transactions beyond the mempool.
 * Not-observed includes missing index/data, dropped or never-seen transactions.
 * Confirmed means caller confirmation threshold at this checkpoint, not finality. */
export async function observeBunkBitcoinApproval(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  input: BunkBitcoinSavedApprovalRequest & { blockHint?: string },
  access: BunkBitcoinObservationAccess,
) {
  const r = requestSnapshot(input),
    hint = input.blockHint === undefined ? undefined : hash(input.blockHint),
    a = accessSnapshot(access);
  const saved = await load(store, key, seed, r);
  return observed(saved, await openBitcoinObservation(r.network, a, r.previousCheckpoint), hint);
}

/** Submit only a persisted signed approval, after explicit user submission intent.
 * Does not mutate the journal, sign, replace fees, or release any owner claim.
 * Already observed pending/canonical transactions aren't rebroadcast. Acceptance
 * and send acknowledgement are separate from mined inclusion. Adapters must retain
 * numeric RPC error codes; unknown errors propagate, never imply absence. */
export async function submitBunkBitcoinApproval(
  store: BunkJournalStore,
  key: string,
  seed: Uint8Array,
  input: BunkBitcoinSavedApprovalRequest & { maximumFeeRateSatPerKvB: bigint },
  access: BunkBitcoinObservationAccess,
) {
  const r = requestSnapshot(input),
    a = accessSnapshot(access),
    maximum = input.maximumFeeRateSatPerKvB;
  check(
    typeof maximum === 'bigint' && maximum > 0n && maximum <= 100_000_000n,
    'invalid submission fee-rate cap',
  );
  const saved = await load(store, key, seed, r);
  check(
    saved.feeSatoshis * 1000n <= maximum * BigInt(saved.vbytes),
    'saved transaction fee rate exceeds cap',
  );
  const context = await openBitcoinObservation(r.network, a, r.previousCheckpoint);
  const before = await observed(saved, context);
  if (before.status === 'pending' || before.status === 'included' || before.status === 'confirmed')
    return {
      outcome: 'already-observed' as const,
      observation: before,
      txid: saved.txid,
      wtxid: saved.wtxid,
      signingAuthorized: false as const,
    };
  const decimal = `${maximum / 100_000_000n}.${(maximum % 100_000_000n).toString().padStart(8, '0')}`;
  const response = await context.rpc('testmempoolaccept', [[saved.rawTransaction], decimal]);
  check(Array.isArray(response) && response.length === 1, 'invalid acceptance result');
  const acceptance = record(response[0]);
  check(
    acceptance.txid === saved.txid &&
      acceptance.wtxid === saved.wtxid &&
      typeof acceptance.allowed === 'boolean',
    'acceptance identity/result mismatch',
  );
  if (!acceptance.allowed) {
    const reason = acceptance['reject-reason'];
    check(
      typeof reason === 'string' && reason.length > 0 && reason.length <= 512,
      'invalid rejection reason',
    );
    await context.finish();
    return {
      outcome: 'rejected' as const,
      reason,
      txid: saved.txid,
      wtxid: saved.wtxid,
      signingAuthorized: false as const,
    };
  }
  check(
    acceptance.vsize === saved.vbytes && amount(record(acceptance.fees).base) === saved.feeSatoshis,
    'acceptance amount/size mismatch',
  );
  await context.finish();
  // From this point a transport failure, cancellation or bad acknowledgement may
  // follow a successful external write. The saved signed journal stays intact.
  try {
    const result = await context.rpc('sendrawtransaction', [
      saved.rawTransaction,
      decimal,
      '0.00000000',
    ]);
    check(result === saved.txid, 'submission acknowledgement mismatch');
    return {
      outcome: 'submitted' as const,
      txid: saved.txid,
      wtxid: saved.wtxid,
      preflightCheckpoint: context.checkpoint,
      signingAuthorized: false as const,
    };
  } catch (error) {
    throw new BunkBitcoinSubmissionUncertain(saved.txid, saved.wtxid, error);
  }
}
