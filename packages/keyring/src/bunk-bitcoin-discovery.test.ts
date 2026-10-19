import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX, deriveBunkOwner } from './bunk';
import {
  type BunkBitcoinDiscoveryRequest,
  discoverBunkBitcoinUtxos,
} from './bunk-bitcoin-discovery';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const timestamp = 1_800_000_000;
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing fixture entry');
  return value;
}
function fixture() {
  const seed = new Uint8Array(64).fill(1);
  const input: BunkBitcoinDiscoveryRequest = {
    network: 'regtest',
    accountIndex: 0,
    startOwnerIndex: 0,
    count: 3,
  };
  const header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, timestamp, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse());
  const script = (ownerIndex: number) =>
    `0014${deriveBunkOwner(seed, { network: { family: 'bitcoin', network: 'regtest' }, accountIndex: 0, ownerIndex }).commitment.slice(2)}`;
  const coins = [0, 0, 1].map((owner, vout) => ({
    txid: '11'.repeat(32),
    vout,
    scriptPubKey: script(owner),
    amount: 0.00001,
    coinbase: false,
    height: 101,
    blockhash: tip,
    confirmations: 1,
  }));
  const chain = { chain: 'regtest', initialblockdownload: false, blocks: 101, bestblockhash: tip };
  const scan = {
    success: true,
    height: 101,
    bestblock: tip,
    unspents: coins,
    total_amount: 0.00003,
  };
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const state = {
    pending: new Set<number>(),
    time: timestamp,
    header: bytesToHex(header),
    genesis,
    mutate: (_method: string, _params: readonly unknown[], result: unknown): unknown => result,
  };
  const access = {
    now: () => state.time,
    maxTipAgeSeconds: 3600,
    minConfirmations: 1,
    rpc: {
      async request(method: string, params: readonly unknown[]) {
        calls.push({ method, params });
        let result: unknown;
        if (method === 'getblockchaininfo') result = { ...chain };
        else if (method === 'getblockheader') result = state.header;
        else if (method === 'getblockhash') result = params[0] === 0 ? state.genesis : tip;
        else if (method === 'scantxoutset') result = structuredClone(scan);
        else if (method === 'gettxout') {
          const c = coins.find((c) => c.txid === params[0] && c.vout === params[1]);
          if (!c) throw new Error('Unknown fixture coin');
          result = state.pending.has(c.vout)
            ? null
            : {
                bestblock: tip,
                confirmations: c.confirmations,
                coinbase: c.coinbase,
                scriptPubKey: { hex: c.scriptPubKey },
                value: c.amount,
              };
        } else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, result);
      },
    },
  };
  return {
    seed,
    input,
    access,
    state,
    calls,
    chain,
    scan,
    coins,
    tip,
    run: () => discoverBunkBitcoinUtxos(seed, input, access),
  };
}

describe('Bitcoin confirmed UTXO discovery', () => {
  it('retains repeated deposits and empty candidates without authorizing signing', async () => {
    const f = fixture(),
      page = await f.run();
    expect(page.candidates.map((c) => [c.coins.length, c.confirmedSatoshis, c.available])).toEqual([
      [2, 2000n, true],
      [1, 1000n, true],
      [0, 0n, false],
    ]);
    expect(page).toMatchObject({
      nextOwnerIndex: 3,
      inventoryComplete: false,
      signingAuthorized: false,
      checkpoint: { network: 'regtest', height: 101, blockhash: f.tip },
    });
    expect(f.seed).toEqual(new Uint8Array(64).fill(1));
    expect(f.calls.find((c) => c.method === 'scantxoutset')?.params).toEqual([
      'start',
      page.candidates.map((c) => ({ desc: `raw(${c.scriptPubKey})` })),
    ]);
    expect(f.calls.filter((c) => c.method === 'gettxout').every((c) => c.params[2] === true)).toBe(
      true,
    );
  });

  it('keeps pending-spent coins and makes the entire owner group unavailable', async () => {
    const f = fixture();
    f.state.pending.add(0);
    const page = await f.run();
    expect(at(page.candidates, 0)).toMatchObject({ available: false, confirmedSatoshis: 2000n });
    expect(at(page.candidates, 0).coins.map((c) => c.status)).toEqual([
      'mempool-spent',
      'available',
    ]);
    expect(at(page.candidates, 1).available).toBe(true);
  });

  it('retains immature and underconfirmed balances, including the maturity boundary', async () => {
    const f = fixture();
    at(f.coins, 0).coinbase = true;
    f.access.minConfirmations = 2;
    let page = await f.run();
    expect(at(page.candidates, 0).coins.map((c) => c.status)).toEqual([
      'immature',
      'underconfirmed',
    ]);
    expect(at(page.candidates, 1).available).toBe(false);
    f.coins.forEach((c) => {
      c.height = 2;
      c.confirmations = 100;
    });
    page = await f.run();
    expect(at(page.candidates, 0).available).toBe(true);
  });

  it('rejects wrong chains, genesis, custom signet, syncing and changed endpoints', async () => {
    for (const mutation of [
      (f: ReturnType<typeof fixture>) => {
        f.chain.chain = 'testnet4';
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.genesis = '22'.repeat(32);
      },
      (f: ReturnType<typeof fixture>) => {
        f.chain.initialblockdownload = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.network = 'signet';
        f.chain.chain = 'signet';
      },
      (f: ReturnType<typeof fixture>) => {
        let n = 0;
        f.state.mutate = (m, _p, r) => (m === 'getblockhash' && ++n > 3 ? '22'.repeat(32) : r);
      },
    ]) {
      const f = fixture();
      mutation(f);
      await expect(f.run()).rejects.toThrow();
    }
  });

  it('rejects partial scans, foreign/duplicate coins, excess precision and inconsistent metadata', async () => {
    const mutations = [
      { success: false },
      { height: 100 },
      { total_amount: 0.00003001 },
      { unspents: Array(257).fill({}) },
    ];
    for (const mutation of mutations) {
      const f = fixture();
      Object.assign(f.scan, mutation);
      await expect(f.run()).rejects.toThrow();
    }
    for (const mutation of [
      { scriptPubKey: `0014${'22'.repeat(20)}` },
      { vout: 1 },
      { amount: 0.000010001 },
      { amount: -1 },
      { amount: Number.NaN },
      { amount: 21_000_001 },
      { amount: '1e-5' },
      { confirmations: 2 },
      { coinbase: 'false' },
      { height: 102 },
      { blockhash: 'ff'.repeat(32) },
    ]) {
      const f = fixture();
      Object.assign(at(f.coins, 0), mutation);
      await expect(f.run()).rejects.toThrow();
    }
  });

  it('accepts exact decimal strings and single-satoshi JSON numbers', async () => {
    const f = fixture();
    f.coins.forEach((c) => {
      c.amount = 0.00000001;
    });
    Object.assign(at(f.coins, 0), { amount: '0.00000001' });
    Object.assign(f.scan, { total_amount: '0.00000003' });
    expect(at((await f.run()).candidates, 0).confirmedSatoshis).toBe(2n);
  });

  it('rejects mismatched live output fields and propagates RPC failures', async () => {
    for (const mutation of [
      { value: 0.00002 },
      { bestblock: genesis },
      { confirmations: 0 },
      { coinbase: true },
      { scriptPubKey: { hex: '00' } },
    ]) {
      const f = fixture();
      f.state.mutate = (m, _p, r) => (m === 'gettxout' ? { ...(r as object), ...mutation } : r);
      await expect(f.run()).rejects.toThrow('inconsistent');
    }
    const f = fixture();
    f.state.mutate = (m, _p, r) => {
      if (m === 'scantxoutset') throw new Error('Scan busy');
      return r;
    };
    await expect(f.run()).rejects.toThrow('Scan busy');
    expect(f.calls.some((c) => c.params[0] === 'abort')).toBe(false);
  });

  it('rejects altered headers and tips that are stale, future or age during a scan', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.state.header = '00'.repeat(80);
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.time += 3601;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.time -= 7201;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.time = Number.NaN;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.mutate = (m, _p, r) => {
          if (m === 'scantxoutset') f.state.time += 3601;
          return r;
        };
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(f.run()).rejects.toThrow();
    }
  });

  it('rejects reorganized checkpoints and tip changes during the scan', async () => {
    const f = fixture();
    f.input.previousCheckpoint = { network: 'regtest', height: 100, blockhash: '22'.repeat(32) };
    await expect(f.run()).rejects.toThrow('reorganized');
    f.input.previousCheckpoint.blockhash = f.tip;
    let reads = 0;
    f.state.mutate = (m, _p, r) =>
      m === 'getblockchaininfo' && ++reads === 2 ? { ...f.chain, blocks: 102 } : r;
    await expect(f.run()).rejects.toThrow('tip changed');
  });

  it('fences cancellation before and after transport without aborting a shared scan', async () => {
    const f = fixture(),
      controller = new AbortController();
    f.state.mutate = (m, _p, r) => {
      if (m === 'scantxoutset') controller.abort();
      return r;
    };
    await expect(
      discoverBunkBitcoinUtxos(f.seed, f.input, { ...f.access, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(f.calls.at(-1)?.method).toBe('scantxoutset');
    const n = f.calls.length;
    await expect(
      discoverBunkBitcoinUtxos(f.seed, f.input, { ...f.access, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(f.calls).toHaveLength(n);
  });

  it('snapshots caller data before await and caps index pages without wrapping', async () => {
    const f = fixture(),
      pending = f.run();
    f.seed.fill(0);
    f.input.count = 0;
    f.input.network = 'mainnet';
    f.access.minConfirmations = 1000;
    const page = await pending;
    expect(page.count).toBe(3);
    expect(at(page.candidates, 0).available).toBe(true);
    for (const mutation of [
      { count: 0 },
      { count: 21 },
      { startOwnerIndex: -1 },
      { startOwnerIndex: BUNK_MAX_INDEX, count: 2 },
    ]) {
      const invalid = fixture();
      Object.assign(invalid.input, mutation);
      await expect(invalid.run()).rejects.toThrow();
      expect(invalid.calls).toHaveLength(0);
    }
    const end = fixture();
    end.input.startOwnerIndex = BUNK_MAX_INDEX;
    end.input.count = 1;
    end.scan.unspents = [];
    end.scan.total_amount = 0;
    expect((await end.run()).nextOwnerIndex).toBeNull();
  });
});
