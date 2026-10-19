import { BUNK_MAX_INDEX, deriveBunkOwner } from './bunk';
import {
  BITCOIN_MAX_SATOSHIS,
  type BunkBitcoinNetwork,
  type BunkBitcoinUtxo,
} from './bunk-bitcoin';
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

export type { BunkBitcoinObservationAccess } from './bunk-bitcoin-rpc';
export interface BunkBitcoinInputObservationRequest {
  network: BunkBitcoinNetwork;
  accountIndex: number;
  /** Known expected outputs, normally from discovery or the durable transaction journal.
   * Observing these does not discover other deposits to their owner addresses. */
  inputs: readonly BunkBitcoinUtxo[];
  previousCheckpoint?: BunkBitcoinCheckpoint;
}
export interface BunkBitcoinObservedInput extends BunkBitcoinUtxo {
  status: 'confirmed' | 'unconfirmed' | 'immature' | 'underconfirmed' | 'unavailable';
  confirmations: number | null;
  coinbase: boolean | null;
}
export interface BunkBitcoinMempoolTransaction {
  txid: string;
  wtxid: string;
  vbytes: number;
  weight: number;
  /** Actual base fee, excluding local mining-priority deltas. */
  feeSatoshis: bigint;
  parents: string[];
}
export interface BunkBitcoinInputObservation {
  network: BunkBitcoinNetwork;
  accountIndex: number;
  checkpoint: BunkBitcoinCheckpoint;
  blockTime: number;
  inputs: BunkBitcoinObservedInput[];
  /** Union of unconfirmed input transactions and all their unconfirmed ancestors. */
  unconfirmedTransactions: BunkBitcoinMempoolTransaction[];
  ancestorVbytes: number;
  ancestorFeeSatoshis: bigint;
  inventoryComplete: false;
  signingAuthorized: false;
}
const MAX_PACKAGE_TRANSACTIONS = 256;
function money(value: bigint): bigint {
  check(
    typeof value === 'bigint' && value >= 0n && value <= BITCOIN_MAX_SATOSHIS,
    'invalid satoshi amount',
  );
  return value;
}
function entry(txid: string, value: unknown): BunkBitcoinMempoolTransaction {
  const e = record(value),
    vbytes = integer(e.vsize, 1_000_000),
    weight = integer(e.weight, 4_000_000);
  check(weight > 0 && vbytes >= Math.ceil(weight / 4), 'inconsistent transaction size');
  check(
    Array.isArray(e.depends) && e.depends.length < MAX_PACKAGE_TRANSACTIONS,
    'invalid parent list',
  );
  const parents = e.depends.map(hash).sort();
  check(
    new Set(parents).size === parents.length && !parents.includes(txid),
    'duplicate or self parent',
  );
  return {
    txid: hash(txid),
    wtxid: hash(e.wtxid),
    vbytes,
    weight,
    feeSatoshis: amount(record(e.fees).base),
    parents,
  };
}
const fingerprint = (tx: BunkBitcoinMempoolTransaction) =>
  JSON.stringify([tx.txid, tx.wtxid, tx.vbytes, tx.weight, tx.feeSatoshis.toString(), tx.parents]);
function completeAncestors(root: string, transactions: Map<string, BunkBitcoinMempoolTransaction>) {
  const seen = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    check(!visiting.has(id), 'cyclic ancestor graph');
    if (seen.has(id)) return;
    const tx = transactions.get(id);
    check(!!tx, 'missing ancestor');
    visiting.add(id);
    tx.parents.forEach(visit);
    visiting.delete(id);
    seen.add(id);
  };
  visit(root);
  check(seen.size === transactions.size, 'unrelated ancestor');
}

/** Observe explicit outpoints against a caller-trusted Core node. Includes pending
 * change and its full ancestor fee/size union. Missing outputs stay unavailable;
 * absence does not prove a transaction failed or permit another signature. Mempool
 * observations are rechecked, not atomic or reservations. Reobserve before use. */
export async function observeBunkBitcoinInputs(
  seed: Uint8Array,
  input: BunkBitcoinInputObservationRequest,
  access: BunkBitcoinObservationAccess,
): Promise<BunkBitcoinInputObservation> {
  check(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const network = input.network,
    accountIndex = integer(input.accountIndex),
    previous = input.previousCheckpoint && { ...input.previousCheckpoint };
  check(
    Array.isArray(input.inputs) && input.inputs.length > 0 && input.inputs.length <= 100,
    'invalid input count',
  );
  check(!access.signal?.aborted, 'cancelled');
  const seen = new Set<string>(),
    owners = new Map<number, string>(),
    ownedSeed = seed.slice();
  let inputs: BunkBitcoinUtxo[];
  try {
    inputs = input.inputs.map((coin) => {
      const txid = hash(coin.txid),
        vout = integer(coin.vout, 0xffffffff),
        ownerIndex = integer(coin.ownerIndex, BUNK_MAX_INDEX),
        satoshis = money(coin.satoshis),
        id = `${txid}:${vout}`;
      check(!seen.has(id), 'duplicate outpoint');
      seen.add(id);
      let scriptPubKey = owners.get(ownerIndex);
      if (!scriptPubKey) {
        scriptPubKey = `0014${deriveBunkOwner(ownedSeed, { network: { family: 'bitcoin', network }, accountIndex, ownerIndex }).commitment.slice(2)}`;
        owners.set(ownerIndex, scriptPubKey);
      }
      check(coin.scriptPubKey === scriptPubKey, 'foreign owner script');
      return { txid, vout, ownerIndex, satoshis, scriptPubKey };
    });
  } finally {
    ownedSeed.fill(0);
  }
  const context = await openBitcoinObservation(network, access, previous);
  const { rpc, checkpoint, minConfirmations } = context;
  const read = async (coin: BunkBitcoinUtxo): Promise<BunkBitcoinObservedInput> => {
    const value = await rpc('gettxout', [coin.txid, coin.vout, true]);
    if (value === null)
      return { ...coin, status: 'unavailable', confirmations: null, coinbase: null };
    const live = record(value),
      confirmations = integer(live.confirmations, checkpoint.height + 1);
    check(
      live.bestblock === checkpoint.blockhash &&
        typeof live.coinbase === 'boolean' &&
        record(live.scriptPubKey).hex === coin.scriptPubKey &&
        amount(live.value) === coin.satoshis,
      'coin changed or inconsistent',
    );
    check(confirmations > 0 || live.coinbase === false, 'unconfirmed coinbase');
    const status =
      confirmations === 0
        ? 'unconfirmed'
        : live.coinbase && confirmations < 100
          ? 'immature'
          : confirmations < minConfirmations
            ? 'underconfirmed'
            : 'confirmed';
    return { ...coin, confirmations, coinbase: live.coinbase, status };
  };
  const observations: BunkBitcoinObservedInput[] = [];
  const transactions = new Map<string, BunkBitcoinMempoolTransaction>(),
    roots = new Set<string>();
  for (const coin of inputs) {
    const observed = await read(coin);
    observations.push(observed);
    if (observed.status !== 'unconfirmed' || roots.has(coin.txid)) continue;
    roots.add(coin.txid);
    const own = entry(coin.txid, await rpc('getmempoolentry', [coin.txid]));
    const ancestors = record(await rpc('getmempoolancestors', [coin.txid, true]));
    const ids = Object.keys(ancestors);
    check(
      ids.length < MAX_PACKAGE_TRANSACTIONS && !Object.hasOwn(ancestors, coin.txid),
      'invalid ancestor count',
    );
    const local = new Map([[coin.txid, own]]);
    for (const id of ids) local.set(hash(id), entry(id, ancestors[id]));
    completeAncestors(coin.txid, local);
    for (const [id, tx] of local) {
      const before = transactions.get(id);
      check(!before || fingerprint(before) === fingerprint(tx), 'ancestor changed between inputs');
      transactions.set(id, tx);
    }
    check(transactions.size <= MAX_PACKAGE_TRANSACTIONS, 'oversized ancestor package');
  }
  // Recheck the exact relevant graph and outputs rather than requiring an otherwise
  // busy node's entire mempool to stop changing. Never claim a global atomic view.
  for (const [id, tx] of transactions)
    check(
      fingerprint(entry(id, await rpc('getmempoolentry', [id]))) === fingerprint(tx),
      'ancestor changed during observation',
    );
  for (const observed of observations) {
    const latest = await read(observed);
    check(
      latest.status === observed.status &&
        latest.confirmations === observed.confirmations &&
        latest.coinbase === observed.coinbase,
      'output availability changed',
    );
  }
  await context.finish();
  const unconfirmedTransactions = [...transactions.values()].sort((a, b) =>
    a.txid.localeCompare(b.txid),
  );
  const ancestorFeeSatoshis = money(
    unconfirmedTransactions.reduce((sum, tx) => sum + tx.feeSatoshis, 0n),
  );
  return {
    network,
    accountIndex,
    checkpoint,
    blockTime: context.blockTime,
    inputs: observations,
    unconfirmedTransactions,
    ancestorVbytes: unconfirmedTransactions.reduce((sum, tx) => sum + tx.vbytes, 0),
    ancestorFeeSatoshis,
    inventoryComplete: false,
    signingAuthorized: false,
  };
}

/** Budget a child using actual ancestor fees and conservative child vbytes. The
 * returned rate fits prepareBunkBitcoinSpend; its upward integer-rate rounding is
 * included in feeSatoshis and the cap. Call again if selected inputs/output shape
 * change. This is arithmetic, not relay/mining acceptance or signing approval. */
export function estimateBunkBitcoinChildFee(request: {
  ancestors: readonly BunkBitcoinMempoolTransaction[];
  childMaxVbytes: number;
  targetRateSatPerKvB: bigint;
  minimumChildRateSatPerKvB: bigint;
  maxFeeSatoshis: bigint;
}) {
  const child = integer(request.childMaxVbytes, 1_000_000);
  check(child > 0, 'invalid child size');
  check(
    Array.isArray(request.ancestors) && request.ancestors.length <= MAX_PACKAGE_TRANSACTIONS,
    'invalid ancestor package',
  );
  const target = request.targetRateSatPerKvB,
    minimum = request.minimumChildRateSatPerKvB,
    cap = money(request.maxFeeSatoshis),
    ids = new Set<string>();
  for (const rate of [target, minimum])
    check(typeof rate === 'bigint' && rate > 0n && rate <= 100_000_000n, 'invalid fee rate');
  let ancestorVbytes = 0,
    ancestorFeeSatoshis = 0n;
  for (const tx of request.ancestors) {
    const id = hash(tx.txid),
      size = integer(tx.vbytes, 1_000_000);
    check(!ids.has(id) && size > 0, 'duplicate ancestor or invalid size');
    ids.add(id);
    ancestorVbytes += size;
    ancestorFeeSatoshis += money(tx.feeSatoshis);
  }
  money(ancestorFeeSatoshis);
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const targetPackageFee = ceil(BigInt(ancestorVbytes + child) * target, 1000n);
  const minimumChildFee = ceil(BigInt(child) * minimum, 1000n);
  const required = targetPackageFee - ancestorFeeSatoshis;
  const feeRateSatPerKvB = ceil(
    (required > minimumChildFee ? required : minimumChildFee) * 1000n,
    BigInt(child),
  );
  check(feeRateSatPerKvB <= 100_000_000n, 'required child fee rate exceeds builder limit');
  const feeSatoshis = money(ceil(feeRateSatPerKvB * BigInt(child), 1000n));
  check(feeSatoshis <= cap, 'child fee exceeds cap');
  return {
    feeSatoshis,
    feeRateSatPerKvB,
    childMaxVbytes: child,
    ancestorVbytes,
    ancestorFeeSatoshis,
    packageMaxVbytes: ancestorVbytes + child,
    packageFeeSatoshis: money(ancestorFeeSatoshis + feeSatoshis),
    signingAuthorized: false as const,
  };
}
