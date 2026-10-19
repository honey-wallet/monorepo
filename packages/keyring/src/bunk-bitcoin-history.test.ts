import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX, deriveBunkOwner } from './bunk';
import { type BunkBitcoinHistoryRequest, discoverBunkBitcoinHistory } from './bunk-bitcoin-history';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const time = 1_800_000_000;
function fixture() {
  const seed = new Uint8Array(64).fill(1),
    header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, time, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse()),
    old = 'aa'.repeat(32);
  const script = (ownerIndex: number) =>
    `0014${deriveBunkOwner(seed, {
      network: { family: 'bitcoin', network: 'regtest' },
      accountIndex: 0,
      ownerIndex,
    }).commitment.slice(2)}`;
  const input: BunkBitcoinHistoryRequest = {
    network: 'regtest',
    accountIndex: 0,
    startOwnerIndex: 0,
    count: 3,
    fromHeight: 100,
    blockCount: 2,
  };
  const receive = {
    type: 'receive',
    txid: '11'.repeat(32),
    vout: 0,
    amount: 0.00001,
    output_spk: { hex: script(0) },
    height: 100,
    blockhash: old,
  };
  const spend = {
    type: 'spend',
    spend_txid: '22'.repeat(32),
    spend_vin: 0,
    prevout_txid: receive.txid,
    prevout_vout: 0,
    prevout_spk: { hex: script(0) },
    amount: 0.00001,
    height: 101,
    blockhash: tip,
  };
  const deposit = {
    type: 'receive',
    txid: '33'.repeat(32),
    vout: 1,
    amount: 0.00002,
    output_spk: { hex: script(1) },
  };
  const confirmed: Record<string, unknown>[] = [receive, spend],
    pending: Record<string, unknown>[] = [deposit];
  const scan = { completed: true, from_height: 100, to_height: 101, relevant_blocks: [old, tip] };
  const state = {
    now: time,
    mutate: (_m: string, _p: readonly unknown[], r: unknown): unknown => r,
  };
  const calls: { method: string; params: readonly unknown[] }[] = [];
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
          result = params[0] === 0 ? genesis : params[0] === 100 ? old : tip;
        else if (method === 'getblockheader')
          result =
            params[1] === false
              ? bytesToHex(header)
              : { hash: params[0], height: params[0] === old ? 100 : 101 };
        else if (method === 'scanblocks') result = structuredClone(scan);
        else if (method === 'getdescriptoractivity')
          result = { activity: structuredClone(params[2] ? pending : confirmed) };
        else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, result);
      },
    },
  };
  return {
    seed,
    tip,
    old,
    input,
    receive,
    spend,
    deposit,
    confirmed,
    pending,
    scan,
    state,
    access,
    calls,
    run: () => discoverBunkBitcoinHistory(seed, input, access),
  };
}

describe('Bitcoin history discovery', () => {
  it('finds emptied owners and incoming pending deposits without treating absent activity as unused', async () => {
    const f = fixture(),
      page = await f.run();
    expect(page.candidates.map((c) => c.activityObserved)).toEqual([true, true, false]);
    expect(page.events.map((e) => [e.type, e.ownerIndex, e.satoshis, e.location?.height])).toEqual([
      ['receive', 0, 1000n, 100],
      ['spend', 0, 1000n, 101],
      ['receive', 1, 2000n, undefined],
    ]);
    expect(page).toMatchObject({
      nextOwnerIndex: 3,
      inventoryComplete: false,
      signingAuthorized: false,
      coverage: { fromHeight: 100, toHeight: 101, nextHeight: null },
    });
    expect(f.seed).toEqual(new Uint8Array(64).fill(1));
    expect(f.calls.find((c) => c.method === 'scanblocks')?.params).toEqual([
      'start',
      page.candidates.map((c) => `raw(${c.scriptPubKey})`),
      100,
      101,
      'basic',
      { filter_false_positives: false },
    ]);
  });

  it('accepts filter false positives, explicit coverage and end-of-owner-space without wrapping', async () => {
    const f = fixture();
    f.confirmed.length = 0;
    f.pending.length = 0;
    f.input.blockCount = 1;
    f.scan.to_height = 100;
    f.scan.relevant_blocks = [f.old];
    f.input.startOwnerIndex = BUNK_MAX_INDEX;
    f.input.count = 1;
    const page = await f.run();
    expect(page.nextOwnerIndex).toBeNull();
    expect(page.coverage).toEqual({ fromHeight: 100, toHeight: 100, nextHeight: 101 });
    expect(page.events).toEqual([]);
    expect(page.candidates[0]?.activityObserved).toBe(false);
  });

  it('clips requested blocks at tip and rejects invalid bounds before transport', async () => {
    const f = fixture();
    f.input.blockCount = 2016;
    expect((await f.run()).coverage.toHeight).toBe(101);
    for (const mutation of [
      { count: 0 },
      { count: 21 },
      { startOwnerIndex: BUNK_MAX_INDEX, count: 2 },
      { fromHeight: -1 },
      { blockCount: 0 },
      { blockCount: 2017 },
      { accountIndex: 0.5 },
    ]) {
      const invalid = fixture();
      Object.assign(invalid.input, mutation);
      await expect(invalid.run()).rejects.toThrow();
      expect(invalid.calls).toHaveLength(0);
    }
    const future = fixture();
    future.input.fromHeight = 102;
    await expect(future.run()).rejects.toThrow('beyond tip');
  });

  it('rejects incomplete scans and duplicate, noncanonical or out-of-range blocks', async () => {
    for (const mutation of [
      { completed: false },
      { from_height: 99 },
      { to_height: 100 },
      { relevant_blocks: [genesis] },
      { relevant_blocks: [filler()] },
      { relevant_blocks: [genesis, genesis] },
      { relevant_blocks: Array(3).fill(genesis) },
    ]) {
      const f = fixture();
      Object.assign(f.scan, mutation);
      await expect(f.run()).rejects.toThrow();
    }
    const f = fixture();
    f.state.mutate = (m, p, r) =>
      m === 'getblockheader' && p[1] === true ? { hash: p[0], height: 99 } : r;
    await expect(f.run()).rejects.toThrow('outside range');
  });

  it('rejects malformed, foreign, duplicate and oversized activity rather than truncating', async () => {
    for (const mutation of [
      { type: 'unknown' },
      { txid: 'ff' },
      { vout: -1 },
      { amount: -1 },
      { amount: 0.000000001 },
      { output_spk: { hex: '00' } },
      { blockhash: genesis },
      { height: 99 },
    ]) {
      const f = fixture();
      Object.assign(f.receive, mutation);
      await expect(f.run()).rejects.toThrow();
    }
    for (const many of [false, true]) {
      const f = fixture();
      f.confirmed.push(...Array(many ? 4096 : 1).fill(f.receive));
      await expect(f.run()).rejects.toThrow(many ? 'oversized' : 'duplicate');
    }
    const pending = fixture();
    Object.assign(pending.deposit, { height: 101, blockhash: pending.tip });
    await expect(pending.run()).rejects.toThrow('confirmed mempool');
  });

  it('rejects inconsistent prevouts, backwards history and competing spends', async () => {
    for (const mutation of [{ amount: 0.00002 }, { height: 100, blockhash: 'aa'.repeat(32) }]) {
      const f = fixture();
      if ('height' in mutation) {
        f.receive.height = 101;
        f.receive.blockhash = f.tip;
      }
      Object.assign(f.spend, mutation);
      await expect(f.run()).rejects.toThrow('inconsistent history prevout');
    }
    const f = fixture();
    f.pending.push({ ...f.spend, height: undefined, blockhash: undefined, spend_txid: filler() });
    await expect(f.run()).rejects.toThrow('conflicting history spends');
  });

  it('retains zero values and spends whose receive happened outside the window', async () => {
    const f = fixture();
    f.confirmed.splice(0, 1);
    f.spend.amount = 0;
    expect((await f.run()).events[0]?.satoshis).toBe(0n);
  });

  it('compares normalized relevant mempool activity and rejects changes', async () => {
    const f = fixture();
    f.pending.push({ ...f.deposit, vout: 2 });
    let reads = 0;
    f.state.mutate = (m, p, r) => {
      if (m === 'getdescriptoractivity' && p[2] && ++reads === 2) {
        return { activity: structuredClone(f.pending).reverse() };
      }
      return r;
    };
    await expect(f.run()).resolves.toBeDefined();
    reads = 0;
    f.state.mutate = (m, p, r) =>
      m === 'getdescriptoractivity' && p[2] && ++reads === 2 ? { activity: [] } : r;
    await expect(f.run()).rejects.toThrow('mempool history changed');
  });

  it('rejects prior-checkpoint reorg, tip change and freshness expiry', async () => {
    const f = fixture();
    f.input.previousCheckpoint = { network: 'regtest', height: 101, blockhash: filler() };
    await expect(f.run()).rejects.toThrow('reorganized');
    for (const expires of [false, true]) {
      const f = fixture();
      let reads = 0;
      f.state.mutate = (m, _p, r) => {
        if (m === 'scanblocks' && expires) f.state.now += 3601;
        if (m === 'getblockchaininfo' && ++reads === 2 && !expires)
          return { ...(r as object), blocks: 102 };
        return r;
      };
      await expect(f.run()).rejects.toThrow(expires ? 'stale' : 'tip changed');
    }
  });

  it('propagates missing-index/pruned/busy failures and fences cancellation without global abort', async () => {
    for (const message of ['Index unavailable', 'Block pruned', 'Scan busy']) {
      const f = fixture();
      f.state.mutate = (m, _p, r) => {
        if (m === 'scanblocks') throw new Error(message);
        return r;
      };
      await expect(f.run()).rejects.toThrow(message);
      expect(f.calls.some((c) => c.params[0] === 'abort')).toBe(false);
    }
    const f = fixture(),
      controller = new AbortController();
    f.state.mutate = (m, _p, r) => {
      if (m === 'scanblocks') controller.abort();
      return r;
    };
    const run = () =>
      discoverBunkBitcoinHistory(f.seed, f.input, { ...f.access, signal: controller.signal });
    await expect(run()).rejects.toThrow('cancelled');
    expect(f.calls.at(-1)?.method).toBe('scanblocks');
    const count = f.calls.length;
    await expect(run()).rejects.toThrow('cancelled');
    expect(f.calls).toHaveLength(count);
  });

  it('snapshots seed, request and transport activity before subsequent awaits', async () => {
    const f = fixture();
    let response: { activity: Record<string, unknown>[] } | undefined;
    f.state.mutate = (m, p, r) => {
      if (m === 'getdescriptoractivity') {
        if (!p[2]) response = r as typeof response;
        else if (response) response.activity.length = 0;
      }
      return r;
    };
    const pending = f.run();
    f.seed.fill(0);
    f.input.count = 0;
    f.input.blockCount = 0;
    f.input.network = 'mainnet';
    f.access.maxTipAgeSeconds = 0;
    const page = await pending;
    expect(page.events).toHaveLength(3);
    expect(page.count).toBe(3);
  });
});

function filler() {
  return 'ff'.repeat(32);
}
