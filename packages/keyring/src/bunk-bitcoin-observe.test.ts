import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { deriveBunkOwner } from './bunk';
import {
  type BunkBitcoinInputObservationRequest,
  estimateBunkBitcoinChildFee,
  observeBunkBitcoinInputs,
} from './bunk-bitcoin-observe';

const A = '11'.repeat(32),
  B = '22'.repeat(32),
  C = '33'.repeat(32),
  now = 1_800_000_000;
const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing fixture entry');
  return value;
}
function fixture() {
  const seed = new Uint8Array(64).fill(1),
    header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, now, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse());
  const inputs = [0, 1].map((ownerIndex) => ({
    txid: A,
    vout: ownerIndex,
    ownerIndex,
    satoshis: 1000n,
    scriptPubKey: `0014${deriveBunkOwner(seed, { network: { family: 'bitcoin', network: 'regtest' }, accountIndex: 0, ownerIndex }).commitment.slice(2)}`,
  }));
  const input: BunkBitcoinInputObservationRequest = { network: 'regtest', accountIndex: 0, inputs };
  const tx = (depends: string[] = []) => ({
    wtxid: C,
    vsize: 141,
    weight: 564,
    depends,
    fees: { base: 0.000001, modified: 1, ancestor: 2 },
  });
  const entries: Record<string, ReturnType<typeof tx>> = { [A]: tx(), [B]: tx([A]) };
  const state = {
    confirmations: 0,
    coinbase: false,
    missing: new Set<number>(),
    ancestors: {} as Record<string, ReturnType<typeof tx>>,
    mutate: (_method: string, _params: readonly unknown[], value: unknown): unknown => value,
  };
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const access = {
    now: () => now,
    maxTipAgeSeconds: 3600,
    minConfirmations: 1,
    rpc: {
      async request(method: string, params: readonly unknown[]) {
        calls.push({ method, params });
        let value: unknown;
        if (method === 'getblockchaininfo')
          value = {
            chain: 'regtest',
            initialblockdownload: false,
            blocks: 101,
            bestblockhash: tip,
          };
        else if (method === 'getblockhash') value = params[0] === 0 ? genesis : tip;
        else if (method === 'getblockheader') value = bytesToHex(header);
        else if (method === 'gettxout') {
          const coin = inputs.find((c) => c.txid === params[0] && c.vout === params[1]);
          if (!coin) throw new Error('Unknown fixture coin');
          value = state.missing.has(coin.vout)
            ? null
            : {
                bestblock: tip,
                value: 0.00001,
                scriptPubKey: { hex: coin.scriptPubKey },
                confirmations: state.confirmations,
                coinbase: state.coinbase,
              };
        } else if (method === 'getmempoolentry') {
          const entry = entries[String(params[0])];
          if (!entry) throw new Error('Transaction not in mempool');
          value = structuredClone(entry);
        } else if (method === 'getmempoolancestors') value = structuredClone(state.ancestors);
        else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, value);
      },
    },
  };
  return {
    seed,
    input,
    inputs,
    entries,
    state,
    access,
    calls,
    tip,
    tx,
    run: () => observeBunkBitcoinInputs(seed, input, access),
  };
}

describe('Bitcoin known-input observation', () => {
  it('checks pending outputs and counts a shared parent once using base fees', async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.inputs.map((c) => c.status)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(result).toMatchObject({
      ancestorVbytes: 141,
      ancestorFeeSatoshis: 100n,
      inventoryComplete: false,
      signingAuthorized: false,
    });
    expect(result.unconfirmedTransactions).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === 'getmempoolancestors')).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === 'gettxout')).toHaveLength(4);
    expect(f.seed).toEqual(new Uint8Array(64).fill(1));
  });

  it('deduplicates overlapping ancestor packages for distinct pending inputs', async () => {
    const f = fixture();
    at(f.inputs, 1).txid = B;
    f.state.mutate = (m, p, value) =>
      m === 'getmempoolancestors' && p[0] === B ? { [A]: f.tx() } : value;
    const result = await f.run();
    expect(result.unconfirmedTransactions.map((tx) => tx.txid)).toEqual([A, B]);
    expect(result.ancestorVbytes).toBe(282);
    expect(result.ancestorFeeSatoshis).toBe(200n);
  });

  it('retains unavailable outputs without treating absence as a new signing permission', async () => {
    const f = fixture();
    f.state.missing.add(0);
    const result = await f.run();
    expect(at(result.inputs, 0)).toMatchObject({
      status: 'unavailable',
      confirmations: null,
      coinbase: null,
    });
    expect(result.signingAuthorized).toBe(false);
    f.state.missing.add(1);
    expect((await f.run()).unconfirmedTransactions).toEqual([]);
  });

  it('handles confirmed, immature and underconfirmed known outputs without mempool queries', async () => {
    const f = fixture();
    f.state.confirmations = 1;
    expect((await f.run()).inputs.every((c) => c.status === 'confirmed')).toBe(true);
    f.access.minConfirmations = 2;
    expect((await f.run()).inputs.every((c) => c.status === 'underconfirmed')).toBe(true);
    f.state.coinbase = true;
    expect((await f.run()).inputs.every((c) => c.status === 'immature')).toBe(true);
    f.state.confirmations = 100;
    expect((await f.run()).inputs.every((c) => c.status === 'confirmed')).toBe(true);
    expect(f.calls.some((c) => c.method.startsWith('getmempool'))).toBe(false);
  });

  it('rejects inconsistent outputs, wrong ownership, duplicated requests and wrong networks', async () => {
    for (const change of [
      { value: 0.00001001 },
      { confirmations: 103 },
      { coinbase: true },
      { bestblock: genesis },
      { scriptPubKey: { hex: '00' } },
    ]) {
      const f = fixture();
      f.state.mutate = (m, _p, value) =>
        m === 'gettxout' ? { ...(value as object), ...change } : value;
      await expect(f.run()).rejects.toThrow();
    }
    const foreign = fixture();
    at(foreign.inputs, 0).ownerIndex = 2;
    await expect(foreign.run()).rejects.toThrow('foreign');
    expect(foreign.calls).toHaveLength(0);
    const duplicate = fixture();
    duplicate.input.inputs = [at(duplicate.inputs, 0), at(duplicate.inputs, 0)];
    await expect(duplicate.run()).rejects.toThrow('duplicate');
    const wrong = fixture();
    wrong.input.network = 'mainnet';
    await expect(wrong.run()).rejects.toThrow();
  });

  it('rejects incomplete, cyclic, unrelated and oversized ancestor graphs', async () => {
    const missing = fixture();
    missing.entries[A] = missing.tx([B]);
    await expect(missing.run()).rejects.toThrow('missing ancestor');
    const cyclic = fixture();
    cyclic.entries[A] = cyclic.tx([B]);
    cyclic.state.ancestors = { [B]: cyclic.tx([A]) };
    await expect(cyclic.run()).rejects.toThrow('cyclic');
    const unrelated = fixture();
    unrelated.state.ancestors = { [B]: unrelated.tx() };
    await expect(unrelated.run()).rejects.toThrow('unrelated');
    const excessive = fixture();
    excessive.state.ancestors = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [i.toString(16).padStart(64, '0'), excessive.tx()]),
    );
    await expect(excessive.run()).rejects.toThrow('ancestor count');
    for (const mutation of [
      { depends: [B, B] },
      { depends: [A] },
      { vsize: 140 },
      { weight: 0 },
      { fees: { base: 0.000000001 } },
      { wtxid: 'BAD' },
    ]) {
      const f = fixture();
      Object.assign(f.entries[A] ?? {}, mutation);
      await expect(f.run()).rejects.toThrow();
    }
  });

  it('rejects parent eviction, changed economics and a newly spent pending output', async () => {
    const evicted = fixture();
    evicted.state.mutate = (m, _p, value) => {
      if (m === 'getmempoolancestors') throw new Error('Evicted');
      return value;
    };
    await expect(evicted.run()).rejects.toThrow('Evicted');
    const changed = fixture();
    let entryReads = 0;
    changed.state.mutate = (m, _p, value) =>
      m === 'getmempoolentry' && ++entryReads === 2 ? { ...(value as object), vsize: 142 } : value;
    await expect(changed.run()).rejects.toThrow('ancestor changed');
    const spent = fixture();
    let reads = 0;
    spent.state.mutate = (m, _p, value) => (m === 'gettxout' && ++reads === 3 ? null : value);
    await expect(spent.run()).rejects.toThrow('availability changed');
  });

  it('rejects stale/reorganized anchors and cancellation after the transport returns', async () => {
    const stale = fixture();
    stale.access.now = () => now + 3601;
    await expect(stale.run()).rejects.toThrow('stale');
    const reorg = fixture();
    reorg.input.previousCheckpoint = { network: 'regtest', height: 100, blockhash: B };
    await expect(reorg.run()).rejects.toThrow('reorganized');
    const f = fixture(),
      controller = new AbortController();
    f.state.mutate = (m, _p, value) => {
      if (m === 'gettxout') controller.abort();
      return value;
    };
    await expect(
      observeBunkBitcoinInputs(f.seed, f.input, { ...f.access, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(f.calls.at(-1)?.method).toBe('gettxout');
  });

  it('snapshots expected inputs, seed and policy before the first await', async () => {
    const f = fixture(),
      promise = f.run();
    f.input.inputs = [];
    f.input.network = 'mainnet';
    f.seed.fill(0);
    f.access.minConfirmations = 100;
    expect((await promise).inputs).toHaveLength(2);
    const empty = fixture();
    empty.input.inputs = [];
    await expect(empty.run()).rejects.toThrow('input count');
    expect(empty.calls).toHaveLength(0);
  });
});

describe('Bitcoin child package fee budget', () => {
  const parent = { txid: A, wtxid: B, vbytes: 288, weight: 1152, feeSatoshis: 290n, parents: [] };
  const input = () => ({
    ancestors: [parent],
    childMaxVbytes: 142,
    targetRateSatPerKvB: 5000n,
    minimumChildRateSatPerKvB: 1000n,
    maxFeeSatoshis: 2000n,
  });
  it('covers the complete package target and includes builder rate rounding in the cap', () => {
    const result = estimateBunkBitcoinChildFee(input());
    expect(result).toMatchObject({
      feeRateSatPerKvB: 13099n,
      feeSatoshis: 1861n,
      packageMaxVbytes: 430,
      packageFeeSatoshis: 2151n,
      signingAuthorized: false,
    });
    expect(() => estimateBunkBitcoinChildFee({ ...input(), maxFeeSatoshis: 1860n })).toThrow('cap');
  });
  it('keeps the minimum child relay fee even when ancestors overpay and supports fractional rates', () => {
    expect(
      estimateBunkBitcoinChildFee({ ...input(), ancestors: [{ ...parent, feeSatoshis: 10000n }] })
        .feeSatoshis,
    ).toBe(142n);
    expect(
      estimateBunkBitcoinChildFee({
        ...input(),
        ancestors: [],
        targetRateSatPerKvB: 100n,
        minimumChildRateSatPerKvB: 100n,
      }).feeSatoshis,
    ).toBe(16n);
  });
  it('rejects duplicate ancestors, invalid units, zero sizes and unrepresentable child rates', () => {
    for (const mutation of [
      { ancestors: [parent, parent] },
      { childMaxVbytes: 0 },
      { targetRateSatPerKvB: -1n },
      { minimumChildRateSatPerKvB: 0n },
      { maxFeeSatoshis: -1n },
      { ancestors: [{ ...parent, feeSatoshis: 2_100_000_000_000_000n }] },
      {
        ancestors: [{ ...parent, vbytes: 1_000_000 }],
        childMaxVbytes: 1,
        targetRateSatPerKvB: 100_000_000n,
      },
    ])
      expect(() => estimateBunkBitcoinChildFee({ ...input(), ...mutation })).toThrow();
  });
});
