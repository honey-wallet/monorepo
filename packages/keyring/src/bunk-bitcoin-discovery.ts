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

export type { BunkBitcoinCheckpoint } from './bunk-bitcoin-rpc';
export type BunkBitcoinDiscoveryAccess = BunkBitcoinObservationAccess;

export const BUNK_BITCOIN_DISCOVERY_PAGE_LIMIT = 20;
export interface BunkBitcoinDiscoveryRequest {
  network: BunkBitcoinNetwork;
  accountIndex: number;
  startOwnerIndex: number;
  count: number;
  previousCheckpoint?: BunkBitcoinCheckpoint;
}
export interface BunkBitcoinObservedCoin extends BunkBitcoinUtxo {
  height: number;
  blockhash: string;
  confirmations: number;
  coinbase: boolean;
  status: 'available' | 'mempool-spent' | 'immature' | 'underconfirmed';
}
export interface BunkBitcoinDiscoveredOwner {
  ownerIndex: number;
  address: string;
  scriptPubKey: string;
  coins: BunkBitcoinObservedCoin[];
  confirmedSatoshis: bigint;
  /** All known confirmed coins in this owner group passed the observation policy.
   * This does not prove there are no incoming mempool coins or prior approvals. */
  available: boolean;
}
export interface BunkBitcoinDiscoveryPage {
  accountIndex: number;
  startOwnerIndex: number;
  count: number;
  nextOwnerIndex: number | null;
  checkpoint: BunkBitcoinCheckpoint;
  blockTime: number;
  candidates: BunkBitcoinDiscoveredOwner[];
  inventoryComplete: false;
  signingAuthorized: false;
}
/** Confirmed-UTXO discovery using Core 31's scantxoutset and mempool-aware gettxout.
 * The node is trusted for consensus and completeness; this is not an SPV proof.
 * Each page must fit one stable tip. Cancellation never aborts another node scan.
 * Empty addresses do not establish unused keys. Reobserve before authorization. */
export async function discoverBunkBitcoinUtxos(
  seed: Uint8Array,
  input: BunkBitcoinDiscoveryRequest,
  access: BunkBitcoinDiscoveryAccess,
): Promise<BunkBitcoinDiscoveryPage> {
  check(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const network = input.network,
    accountIndex = integer(input.accountIndex),
    start = integer(input.startOwnerIndex),
    count = integer(input.count, BUNK_BITCOIN_DISCOVERY_PAGE_LIMIT),
    previous = input.previousCheckpoint && { ...input.previousCheckpoint };
  check(count > 0 && start + count - 1 <= BUNK_MAX_INDEX, 'invalid scan range');
  check(!access.signal?.aborted, 'cancelled');
  // Derive public scan targets synchronously, before the first await. No seed is
  // retained across transport calls, and callers may wipe their buffer immediately.
  const ownedSeed = seed.slice();
  const candidates: BunkBitcoinDiscoveredOwner[] = [];
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
        coins: [],
        confirmedSatoshis: 0n,
        available: false,
      });
    }
  } finally {
    ownedSeed.fill(0);
  }
  const context = await openBitcoinObservation(network, access, previous);
  const { rpc, checkpoint, blockTime, minConfirmations, canonical } = context;
  const scan = record(
    await rpc('scantxoutset', [
      'start',
      candidates.map((c) => ({ desc: `raw(${c.scriptPubKey})` })),
    ]),
  );
  check(
    scan.success === true &&
      scan.height === checkpoint.height &&
      scan.bestblock === checkpoint.blockhash,
    'incomplete scan or tip changed',
  );
  check(
    Array.isArray(scan.unspents) && scan.unspents.length <= 256,
    'invalid or oversized UTXO page',
  );
  const owners = new Map(candidates.map((c) => [c.scriptPubKey, c]));
  const seen = new Set<string>(),
    blocks = new Map<number, string>();
  let total = 0n;
  // Snapshot every response field before further awaits; caller transports may
  // retain/mutate their response objects while subsequent RPCs are outstanding.
  for (const value of scan.unspents) {
    const coin = record(value),
      txid = hash(coin.txid),
      vout = integer(coin.vout, 0xffffffff),
      height = integer(coin.height, checkpoint.height),
      blockhash = hash(coin.blockhash),
      confirmations = integer(coin.confirmations),
      satoshis = amount(coin.amount);
    check(typeof coin.scriptPubKey === 'string', 'invalid coin script');
    const owner = owners.get(coin.scriptPubKey);
    check(!!owner, 'foreign coin script');
    check(
      typeof coin.coinbase === 'boolean' && confirmations === checkpoint.height - height + 1,
      'inconsistent coin metadata',
    );
    const id = `${txid}:${vout}`;
    check(!seen.has(id), 'duplicate outpoint');
    seen.add(id);
    check(!blocks.has(height) || blocks.get(height) === blockhash, 'inconsistent block hashes');
    blocks.set(height, blockhash);
    total += satoshis;
    check(total <= BITCOIN_MAX_SATOSHIS, 'balance exceeds supply');
    owner.confirmedSatoshis += satoshis;
    owner.coins.push({
      txid,
      vout,
      satoshis,
      ownerIndex: owner.ownerIndex,
      scriptPubKey: owner.scriptPubKey,
      height,
      blockhash,
      confirmations,
      coinbase: coin.coinbase,
      status: 'available',
    });
  }
  check(total === amount(scan.total_amount), 'scan total mismatch');
  for (const [height, blockhash] of blocks) await canonical({ network, height, blockhash });
  for (const owner of candidates) {
    owner.coins.sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
    for (const coin of owner.coins) {
      const value = await rpc('gettxout', [coin.txid, coin.vout, true]);
      if (value === null) coin.status = 'mempool-spent';
      else {
        const live = record(value);
        check(
          live.bestblock === checkpoint.blockhash &&
            live.confirmations === coin.confirmations &&
            live.coinbase === coin.coinbase &&
            record(live.scriptPubKey).hex === coin.scriptPubKey &&
            amount(live.value) === coin.satoshis,
          'coin changed or inconsistent',
        );
        if (coin.coinbase && coin.confirmations < 100) coin.status = 'immature';
        else if (coin.confirmations < minConfirmations) coin.status = 'underconfirmed';
      }
    }
    owner.available = owner.coins.length > 0 && owner.coins.every((c) => c.status === 'available');
  }
  await context.finish();
  return {
    accountIndex,
    startOwnerIndex: start,
    count,
    nextOwnerIndex: start + count > BUNK_MAX_INDEX ? null : start + count,
    checkpoint,
    blockTime,
    candidates,
    inventoryComplete: false,
    signingAuthorized: false,
  };
}
