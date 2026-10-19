import { BUNK_MAX_INDEX, deriveBunkOwner } from './bunk';
import type { BunkBitcoinNetwork } from './bunk-bitcoin';
import { BUNK_BITCOIN_DISCOVERY_PAGE_LIMIT } from './bunk-bitcoin-discovery';
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

export const BUNK_BITCOIN_HISTORY_BLOCK_LIMIT = 2016;
export const BUNK_BITCOIN_HISTORY_EVENT_LIMIT = 4096;
export interface BunkBitcoinHistoryRequest {
  network: BunkBitcoinNetwork;
  accountIndex: number;
  startOwnerIndex: number;
  count: number;
  fromHeight: number;
  /** Maximum block count, clipped at the pinned tip. */
  blockCount: number;
  previousCheckpoint?: BunkBitcoinCheckpoint;
}
export type BunkBitcoinHistoryEvent = {
  ownerIndex: number;
  scriptPubKey: string;
  satoshis: bigint;
  location: { height: number; blockhash: string; confirmations: number } | null;
} & (
  | { type: 'receive'; txid: string; vout: number }
  | { type: 'spend'; txid: string; vin: number; prevoutTxid: string; prevoutVout: number }
);
export interface BunkBitcoinHistoryPage {
  accountIndex: number;
  startOwnerIndex: number;
  count: number;
  nextOwnerIndex: number | null;
  checkpoint: BunkBitcoinCheckpoint;
  blockTime: number;
  coverage: { fromHeight: number; toHeight: number; nextHeight: number | null };
  candidates: {
    ownerIndex: number;
    address: string;
    scriptPubKey: string;
    /** False means no activity in this window/mempool snapshot, not unused. */
    activityObserved: boolean;
  }[];
  events: BunkBitcoinHistoryEvent[];
  inventoryComplete: false;
  signingAuthorized: false;
}

const eventId = (e: BunkBitcoinHistoryEvent) =>
  `${e.type}:${e.txid}:${e.type === 'receive' ? e.vout : e.vin}`;
const snapshot = (events: BunkBitcoinHistoryEvent[]) =>
  JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Read-only Core 31 history discovery. Requires a basic block-filter index and
 * the matching blocks/undo data. The node is trusted for completeness/consensus.
 * Never treat a scan window as an unused-key proof or restore a signing journal
 * from it: never-broadcast approvals and orphaned/evicted signatures are absent.
 * Transport must bound response bytes and enforce timeouts. No shared scan abort. */
export async function discoverBunkBitcoinHistory(
  seed: Uint8Array,
  input: BunkBitcoinHistoryRequest,
  access: BunkBitcoinObservationAccess,
): Promise<BunkBitcoinHistoryPage> {
  check(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const network = input.network,
    accountIndex = integer(input.accountIndex),
    start = integer(input.startOwnerIndex),
    count = integer(input.count, BUNK_BITCOIN_DISCOVERY_PAGE_LIMIT),
    fromHeight = integer(input.fromHeight),
    blockCount = integer(input.blockCount, BUNK_BITCOIN_HISTORY_BLOCK_LIMIT),
    previous = input.previousCheckpoint && { ...input.previousCheckpoint };
  check(count > 0 && start + count - 1 <= BUNK_MAX_INDEX, 'invalid owner range');
  check(blockCount > 0, 'invalid block range');
  check(!access.signal?.aborted, 'cancelled');
  const ownedSeed = seed.slice(),
    candidates: BunkBitcoinHistoryPage['candidates'] = [];
  try {
    for (let ownerIndex = start; ownerIndex < start + count; ownerIndex++) {
      const owner = deriveBunkOwner(ownedSeed, {
        network: { family: 'bitcoin', network },
        accountIndex,
        ownerIndex,
      });
      candidates.push({
        ownerIndex,
        address: owner.ownerAddress,
        scriptPubKey: `0014${owner.commitment.slice(2)}`,
        activityObserved: false,
      });
    }
  } finally {
    ownedSeed.fill(0);
  }
  const context = await openBitcoinObservation(network, access, previous);
  const { rpc, checkpoint } = context;
  check(fromHeight <= checkpoint.height, 'history begins beyond tip');
  const toHeight = Math.min(checkpoint.height, fromHeight + blockCount - 1),
    descriptors = candidates.map((c) => `raw(${c.scriptPubKey})`);
  const scan = record(
    await rpc('scanblocks', [
      'start',
      descriptors.slice(),
      fromHeight,
      toHeight,
      'basic',
      { filter_false_positives: false },
    ]),
  );
  check(
    scan.completed === true && scan.from_height === fromHeight && scan.to_height === toHeight,
    'incomplete history scan',
  );
  check(
    Array.isArray(scan.relevant_blocks) && scan.relevant_blocks.length <= toHeight - fromHeight + 1,
    'invalid history block list',
  );
  // Snapshot all untrusted response fields before the next transport await.
  const blocks = scan.relevant_blocks.map(hash);
  check(new Set(blocks).size === blocks.length, 'duplicate history block');
  const heights = new Map<string, number>(),
    seenHeights = new Set<number>();
  for (const blockhash of blocks) {
    const header = record(await rpc('getblockheader', [blockhash, true])),
      height = integer(header.height, toHeight);
    check(header.hash === blockhash && height >= fromHeight, 'history block outside range');
    check(!seenHeights.has(height), 'duplicate history height');
    seenHeights.add(height);
    heights.set(blockhash, height);
    await context.canonical({ network, height, blockhash });
  }
  const owners = new Map(candidates.map((c) => [c.scriptPubKey, c.ownerIndex]));
  function parse(value: unknown, confirmed: boolean): BunkBitcoinHistoryEvent[] {
    const entries = record(value).activity;
    check(
      Array.isArray(entries) && entries.length <= BUNK_BITCOIN_HISTORY_EVENT_LIMIT,
      'invalid or oversized history activity',
    );
    const events = entries.map((value): BunkBitcoinHistoryEvent => {
      const entry = record(value);
      check(entry.type === 'receive' || entry.type === 'spend', 'unknown history activity');
      const script = record(entry.type === 'receive' ? entry.output_spk : entry.prevout_spk).hex;
      check(typeof script === 'string' && owners.has(script), 'foreign history script');
      const ownerIndex = owners.get(script);
      check(ownerIndex !== undefined, 'missing history owner');
      let location: BunkBitcoinHistoryEvent['location'] = null;
      if (confirmed) {
        const blockhash = hash(entry.blockhash),
          height = integer(entry.height, toHeight);
        check(heights.get(blockhash) === height, 'activity outside scanned blocks');
        location = { blockhash, height, confirmations: checkpoint.height - height + 1 };
      } else {
        check(
          entry.blockhash === undefined && entry.height === undefined,
          'confirmed mempool activity',
        );
      }
      const common = { ownerIndex, scriptPubKey: script, satoshis: amount(entry.amount), location };
      return entry.type === 'receive'
        ? {
            ...common,
            type: 'receive',
            txid: hash(entry.txid),
            vout: integer(entry.vout, 0xffffffff),
          }
        : {
            ...common,
            type: 'spend',
            txid: hash(entry.spend_txid),
            vin: integer(entry.spend_vin, 0xffffffff),
            prevoutTxid: hash(entry.prevout_txid),
            prevoutVout: integer(entry.prevout_vout, 0xffffffff),
          };
    });
    return events.sort((a, b) => eventId(a).localeCompare(eventId(b)));
  }
  const confirmed = parse(
    await rpc('getdescriptoractivity', [blocks.slice(), descriptors.slice(), false]),
    true,
  );
  const pending = parse(await rpc('getdescriptoractivity', [[], descriptors.slice(), true]), false);
  const events = [...confirmed, ...pending],
    ids = new Set<string>(),
    spent = new Set<string>(),
    received = new Map<string, BunkBitcoinHistoryEvent>();
  check(events.length <= BUNK_BITCOIN_HISTORY_EVENT_LIMIT, 'oversized history activity');
  for (const e of events) {
    const id = eventId(e);
    check(!ids.has(id), 'duplicate history activity');
    ids.add(id);
    if (e.type === 'receive') received.set(`${e.txid}:${e.vout}`, e);
    else {
      const prevout = `${e.prevoutTxid}:${e.prevoutVout}`;
      check(!spent.has(prevout), 'conflicting history spends');
      spent.add(prevout);
    }
  }
  for (const e of events) {
    if (e.type !== 'spend') continue;
    const receive = received.get(`${e.prevoutTxid}:${e.prevoutVout}`);
    if (receive) {
      check(
        receive.satoshis === e.satoshis &&
          receive.scriptPubKey === e.scriptPubKey &&
          (!e.location || (!!receive.location && receive.location.height <= e.location.height)),
        'inconsistent history prevout',
      );
    }
  }
  // Compare only relevant activity; unrelated mempool churn need not restart this
  // page. Equal observations are not an atomic mempool snapshot or reservation.
  const again = parse(await rpc('getdescriptoractivity', [[], descriptors.slice(), true]), false);
  check(snapshot(pending) === snapshot(again), 'mempool history changed');
  await context.finish();
  for (const c of candidates)
    c.activityObserved = events.some((e) => e.ownerIndex === c.ownerIndex);
  return {
    accountIndex,
    startOwnerIndex: start,
    count,
    nextOwnerIndex: start + count > BUNK_MAX_INDEX ? null : start + count,
    checkpoint,
    blockTime: context.blockTime,
    coverage: {
      fromHeight,
      toHeight,
      nextHeight: toHeight === checkpoint.height ? null : toHeight + 1,
    },
    candidates,
    events,
    inventoryComplete: false,
    signingAuthorized: false,
  };
}
