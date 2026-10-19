import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { BUNK_MAX_INDEX } from './bunk';
import { BITCOIN_MAX_SATOSHIS, type BunkBitcoinNetwork } from './bunk-bitcoin';

// The v1 testnet derivation namespace means testnet3. Testnet4 needs a new namespace.
const CHAINS = {
  mainnet: ['main', '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  testnet: ['test', '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'],
  signet: ['signet', '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'],
  regtest: ['regtest', '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'],
} as const;
const SIGNET_CHALLENGE =
  '512103ad5e0edad18cb1f0fc0d28a3d4f1f3e445640337489abb10404f2d1e086be430210359ef5021964fe22d6f8e05b2463c9540ce96883fe3b278760f048f5189f2e6c452ae';
export interface BunkBitcoinCheckpoint {
  network: BunkBitcoinNetwork;
  height: number;
  blockhash: string;
}
export interface BunkBitcoinObservationAccess {
  /** Caller-trusted full node. Responses are RPC result values, not envelopes.
   * Transport must enforce timeouts. No wallet import or backend is needed. */
  rpc: { request(method: string, params: readonly unknown[]): Promise<unknown> };
  now(): number;
  maxTipAgeSeconds: number;
  minConfirmations: number;
  signal?: AbortSignal;
}
export function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Bunk Bitcoin observation: ${message}`);
}
export function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid RPC object');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, max = BUNK_MAX_INDEX): number {
  check(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max,
    'invalid integer',
  );
  return value;
}
export function hash(value: unknown): string {
  check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid hash');
  return value;
}
export function amount(value: unknown): bigint {
  // Core emits JSON numbers. Accept only values that round-trip exactly through an
  // eight-decimal representation; never truncate floating-point multiplication.
  if (typeof value === 'number') {
    check(Number.isFinite(value) && value >= 0 && value <= 21_000_000, 'invalid BTC amount');
    const decimal = value.toFixed(8);
    check(Number(decimal) === value, 'fractional satoshi');
    value = decimal;
  }
  check(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,8})?$/.test(value),
    'invalid BTC amount',
  );
  const [whole, fraction = ''] = value.split('.');
  check(whole !== undefined, 'missing whole BTC amount');
  const satoshis = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  check(satoshis <= BITCOIN_MAX_SATOSHIS, 'amount exceeds supply');
  return satoshis;
}

/** Internal shared chain anchor for discovery and known-input observation. */
export async function openBitcoinObservation(
  network: BunkBitcoinNetwork,
  access: BunkBitcoinObservationAccess,
  prior?: BunkBitcoinCheckpoint,
) {
  const previous = prior && { ...prior },
    request = access.rpc.request.bind(access.rpc),
    now = access.now,
    signal = access.signal,
    maxAge = integer(access.maxTipAgeSeconds, 604800),
    minConfirmations = integer(access.minConfirmations);
  check(Object.hasOwn(CHAINS, network), 'unknown network');
  check(maxAge > 0 && minConfirmations > 0, 'invalid observation policy');
  if (previous) {
    check(previous.network === network, 'checkpoint network mismatch');
    integer(previous.height);
    hash(previous.blockhash);
  }
  const [chainName, genesis] = CHAINS[network];
  const cancelled = () => check(!signal?.aborted, 'cancelled');
  const rpc = async (method: string, params: readonly unknown[] = []) => {
    cancelled();
    const value = await request(method, params);
    cancelled();
    return value;
  };
  const chain = (value: unknown) => {
    const info = record(value);
    check(
      info.chain === chainName && info.initialblockdownload === false,
      'wrong network or node syncing',
    );
    if (network === 'signet')
      check(info.signet_challenge === SIGNET_CHALLENGE, 'custom signet unsupported');
    return { network, height: integer(info.blocks), blockhash: hash(info.bestblockhash) };
  };
  cancelled();
  const checkpoint = chain(await rpc('getblockchaininfo'));
  check((await rpc('getblockhash', [0])) === genesis, 'genesis mismatch');
  const canonical = async (point: BunkBitcoinCheckpoint) => {
    check(
      point.height <= checkpoint.height &&
        (await rpc('getblockhash', [point.height])) === point.blockhash,
      'checkpoint reorganized',
    );
  };
  if (previous) await canonical(previous);
  await canonical(checkpoint);
  const rawHeader = await rpc('getblockheader', [checkpoint.blockhash, false]);
  check(typeof rawHeader === 'string' && /^[0-9a-f]{160}$/.test(rawHeader), 'invalid block header');
  const header = hexToBytes(rawHeader);
  check(
    bytesToHex(sha256(sha256(header)).reverse()) === checkpoint.blockhash,
    'header hash mismatch',
  );
  const blockTime = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    68,
    true,
  );
  const fresh = () => {
    const time = now();
    check(Number.isSafeInteger(time) && time >= 0, 'invalid caller clock');
    check(blockTime <= time + 7200 && time - blockTime <= maxAge, 'stale or future chain tip');
  };
  fresh();
  return {
    rpc,
    checkpoint,
    blockTime,
    minConfirmations,
    canonical,
    async finish() {
      const end = chain(await rpc('getblockchaininfo'));
      check(
        end.height === checkpoint.height && end.blockhash === checkpoint.blockhash,
        'tip changed during discovery',
      );
      check((await rpc('getblockhash', [0])) === genesis, 'genesis changed during discovery');
      if (previous) await canonical(previous);
      await canonical(checkpoint);
      fresh();
      cancelled();
    },
  };
}
