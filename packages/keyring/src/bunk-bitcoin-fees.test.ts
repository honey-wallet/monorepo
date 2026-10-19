import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { observeBunkBitcoinFeePolicy, selectBunkBitcoinFee } from './bunk-bitcoin-fees';

const time = 1_800_000_000;
function fixture() {
  const header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, time, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse());
  const input: Parameters<typeof observeBunkBitcoinFeePolicy>[0] = {
    network: 'regtest',
    confirmationTarget: 6,
    mode: 'conservative',
  };
  const budget = {
    maxVbytes: 141,
    minimumRateSatPerKvB: 100n,
    maximumRateSatPerKvB: 10000n,
    maxFeeSatoshis: 2000n,
  };
  const mempool = {
    loaded: true,
    minrelaytxfee: 0.000001,
    mempoolminfee: 0.000002,
    incrementalrelayfee: 0.000001,
  };
  const estimate: Record<string, unknown> = { feerate: 0.00001234, blocks: 6 };
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const state = {
    now: time,
    mutate: (_m: string, _p: readonly unknown[], r: unknown): unknown => r,
  };
  const access = {
    now: () => state.now,
    maxTipAgeSeconds: 3600,
    minConfirmations: 1,
    rpc: {
      async request(method: string, params: readonly unknown[]) {
        calls.push({ method, params });
        let result: unknown;
        if (method === 'getblockchaininfo')
          result = {
            chain: 'regtest',
            initialblockdownload: false,
            blocks: 101,
            bestblockhash: tip,
          };
        else if (method === 'getblockhash')
          result =
            params[0] === 0
              ? '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
              : tip;
        else if (method === 'getblockheader') result = bytesToHex(header);
        else if (method === 'getmempoolinfo') result = { ...mempool };
        else if (method === 'estimatesmartfee') result = structuredClone(estimate);
        else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, result);
      },
    },
  };
  return {
    input,
    budget,
    mempool,
    estimate,
    access,
    calls,
    state,
    tip,
    run: () => observeBunkBitcoinFeePolicy(input, access),
  };
}

describe('Bitcoin fee observation and budget', () => {
  it('preserves exact units and reported target, then rounds total fee upward', async () => {
    const f = fixture();
    f.input.confirmationTarget = 1;
    f.estimate.blocks = 2;
    const observed = await f.run();
    expect(observed).toMatchObject({
      requestedBlocks: 1,
      minimumRelaySatPerKvB: 100n,
      minimumMempoolSatPerKvB: 200n,
      incrementalRelaySatPerKvB: 100n,
      estimate: { status: 'available', rateSatPerKvB: 1234n, blocks: 2 },
      signingAuthorized: false,
    });
    expect(f.calls.find((c) => c.method === 'estimatesmartfee')?.params).toEqual([
      1,
      'conservative',
    ]);
    expect(selectBunkBitcoinFee(observed, f.budget)).toEqual({
      source: 'estimate',
      feeRateSatPerKvB: 1234n,
      estimatedFeeSatoshis: 174n,
      maxVbytes: 141,
      maxFeeSatoshis: 2000n,
      signingAuthorized: false,
    });
  });

  it('honors mempool and caller floors without adding incremental relay fees to ordinary sends', async () => {
    const f = fixture();
    f.mempool.mempoolminfee = 0.00003;
    f.mempool.incrementalrelayfee = 0.0001;
    const observed = await f.run();
    expect(selectBunkBitcoinFee(observed, f.budget).feeRateSatPerKvB).toBe(3000n);
    expect(
      selectBunkBitcoinFee(observed, { ...f.budget, minimumRateSatPerKvB: 4000n }).feeRateSatPerKvB,
    ).toBe(4000n);
  });

  it('returns unavailable estimates explicitly and only permits an explicit capped fallback', async () => {
    const f = fixture();
    delete f.estimate.feerate;
    f.estimate.blocks = 0;
    f.estimate.errors = ['Insufficient data or no feerate found'];
    const observed = await f.run();
    expect(observed.estimate).toEqual({
      status: 'unavailable',
      blocks: 0,
      errors: f.estimate.errors,
    });
    expect(() => selectBunkBitcoinFee(observed, f.budget)).toThrow('explicit fallback');
    expect(
      selectBunkBitcoinFee(observed, { ...f.budget, fallbackRateSatPerKvB: 1000n }),
    ).toMatchObject({
      source: 'explicit-fallback',
      feeRateSatPerKvB: 1000n,
      estimatedFeeSatoshis: 141n,
    });
    f.mempool.mempoolminfee = 0.00003;
    expect(
      selectBunkBitcoinFee(await f.run(), { ...f.budget, fallbackRateSatPerKvB: 1000n })
        .feeRateSatPerKvB,
    ).toBe(3000n);
  });

  it('never replaces an available estimate with a lower fallback and never clips caps', async () => {
    const f = fixture(),
      observed = await f.run();
    expect(
      selectBunkBitcoinFee(observed, { ...f.budget, fallbackRateSatPerKvB: 500n }).feeRateSatPerKvB,
    ).toBe(1234n);
    expect(() =>
      selectBunkBitcoinFee(observed, { ...f.budget, maximumRateSatPerKvB: 1233n }),
    ).toThrow('rate exceeds cap');
    expect(() => selectBunkBitcoinFee(observed, { ...f.budget, maxFeeSatoshis: 173n })).toThrow(
      'fee exceeds cap',
    );
    expect(
      selectBunkBitcoinFee(observed, { ...f.budget, maxFeeSatoshis: 174n }).estimatedFeeSatoshis,
    ).toBe(174n);
  });

  it('rejects malformed or contradictory estimates instead of silently falling back', async () => {
    for (const mutation of [
      { feerate: undefined },
      { feerate: -1 },
      { feerate: 0 },
      { feerate: 0.000000001 },
      { feerate: 1.00000001 },
      { blocks: 1 },
      { blocks: 1009 },
      { errors: ['failure'] },
      { feerate: undefined, errors: [] },
      { feerate: undefined, errors: Array(9).fill('bad') },
      { feerate: undefined, errors: ['x'.repeat(513)] },
      { feerate: undefined, errors: [42] },
    ]) {
      const f = fixture();
      Object.assign(f.estimate, mutation);
      await expect(f.run()).rejects.toThrow();
    }
  });

  it('accepts exact decimal rate strings and a zero node floor with positive user floor', async () => {
    const f = fixture();
    Object.assign(f.estimate, { feerate: '0.00000001' });
    Object.assign(f.mempool, { minrelaytxfee: 0, mempoolminfee: 0, incrementalrelayfee: 0 });
    const observed = await f.run();
    expect(observed.estimate).toMatchObject({ rateSatPerKvB: 1n });
    expect(selectBunkBitcoinFee(observed, f.budget).feeRateSatPerKvB).toBe(100n);
  });

  it('rejects loading, inconsistent, malformed and changing policy', async () => {
    for (const mutation of [
      { loaded: false },
      { minrelaytxfee: 0.000003 },
      { mempoolminfee: -1 },
      { incrementalrelayfee: 'NaN' },
    ]) {
      const f = fixture();
      Object.assign(f.mempool, mutation);
      await expect(f.run()).rejects.toThrow();
    }
    const f = fixture();
    let reads = 0;
    f.state.mutate = (m, _p, r) =>
      m === 'getmempoolinfo' && ++reads === 2 ? { ...(r as object), mempoolminfee: 0.00003 } : r;
    await expect(f.run()).rejects.toThrow('policy changed');
  });

  it('rejects bad caller budgets and request ranges', async () => {
    const f = fixture(),
      observed = await f.run();
    for (const mutation of [
      { maxVbytes: 0 },
      { maxVbytes: 1_000_001 },
      { minimumRateSatPerKvB: 0n },
      { maximumRateSatPerKvB: 99n },
      { maximumRateSatPerKvB: 100_000_001n },
      { maxFeeSatoshis: 0n },
      { maxFeeSatoshis: 2_100_000_000_000_001n },
      { fallbackRateSatPerKvB: -1n },
    ]) {
      expect(() => selectBunkBitcoinFee(observed, { ...f.budget, ...mutation })).toThrow();
    }
    for (const mutation of [
      { confirmationTarget: 0 },
      { confirmationTarget: 1009 },
      { mode: 'unset' },
    ]) {
      const f = fixture();
      Object.assign(f.input, mutation);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });

  it('propagates transport errors, cancellation, reorgs and stale tips', async () => {
    const f = fixture();
    f.state.mutate = (m, _p, r) => {
      if (m === 'estimatesmartfee') throw new Error('offline');
      return r;
    };
    await expect(f.run()).rejects.toThrow('offline');
    const cancelled = fixture(),
      controller = new AbortController();
    cancelled.state.mutate = (m, _p, r) => {
      if (m === 'estimatesmartfee') controller.abort();
      return r;
    };
    await expect(
      observeBunkBitcoinFeePolicy(cancelled.input, {
        ...cancelled.access,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(cancelled.calls.at(-1)?.method).toBe('estimatesmartfee');
    const reorg = fixture();
    reorg.input.previousCheckpoint = {
      network: 'regtest',
      height: 100,
      blockhash: 'ff'.repeat(32),
    };
    await expect(reorg.run()).rejects.toThrow('reorganized');
    const stale = fixture();
    stale.state.mutate = (m, _p, r) => {
      if (m === 'estimatesmartfee') stale.state.now += 3601;
      return r;
    };
    await expect(stale.run()).rejects.toThrow('stale');
  });

  it('snapshots caller and RPC data and ignores unrelated mempool count changes', async () => {
    const f = fixture();
    let estimateResponse: Record<string, unknown> | undefined;
    f.state.mutate = (m, _p, r) => {
      if (m === 'estimatesmartfee') estimateResponse = r as Record<string, unknown>;
      if (m === 'getmempoolinfo' && estimateResponse) {
        estimateResponse.feerate = 1;
        return { ...(r as object), size: 9999 };
      }
      return r;
    };
    const pending = f.run();
    f.input.network = 'mainnet';
    f.input.confirmationTarget = 100;
    f.input.mode = 'economical';
    f.access.maxTipAgeSeconds = 0;
    expect(await pending).toMatchObject({
      requestedBlocks: 6,
      mode: 'conservative',
      estimate: { status: 'available', rateSatPerKvB: 1234n },
    });
  });
});
