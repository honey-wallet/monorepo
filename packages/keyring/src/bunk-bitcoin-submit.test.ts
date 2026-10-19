import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { bunkPrivateKeyFor, deriveBunkOwner } from './bunk';
import { assembleBunkBitcoinTransaction } from './bunk-bitcoin';
import {
  allocateBunkBitcoinAddress,
  claimBunkBitcoinApproval,
  initializeBunkBitcoinJournal,
  persistBunkBitcoinSignatures,
  reserveBunkBitcoinApproval,
} from './bunk-bitcoin-journal';
import {
  BunkBitcoinSubmissionUncertain,
  observeBunkBitcoinApproval,
  submitBunkBitcoinApproval,
} from './bunk-bitcoin-submit';
import type { BunkJournalSnapshot, BunkJournalStore } from './bunk-evm-v2-journal';

const id = (n: number) => n.toString(16).padStart(64, '0'),
  time = 1_800_000_000;
async function fixture(persist = true) {
  const seed = new Uint8Array(64).fill(1),
    rows = new Map<string, BunkJournalSnapshot>();
  const store: BunkJournalStore = {
    async read(k) {
      const r = rows.get(k);
      return r ? { ...r } : null;
    },
    async compareAndSwap(k, revision, value) {
      if ((rows.get(k)?.revision ?? null) !== revision) return false;
      rows.set(k, { revision: revision === null ? 0 : revision + 1, value });
      return true;
    },
  };
  const scope = { network: 'regtest', accountIndex: 0 } as const;
  const { key } = await initializeBunkBitcoinJournal(store, seed, {
    ...scope,
    origin: 'new-wallet',
  });
  const receive = await allocateBunkBitcoinAddress(store, key, seed, {
    id: id(1),
    expectedNextOwnerIndex: 0,
    purpose: 'receive',
  });
  await allocateBunkBitcoinAddress(store, key, seed, {
    id: id(2),
    expectedNextOwnerIndex: 1,
    purpose: 'change',
  });
  const approval = await reserveBunkBitcoinApproval(store, key, seed, {
    id: id(3),
    changeAllocationId: id(2),
    spend: {
      ...scope,
      changeIndex: 1,
      utxos: [
        {
          txid: id(100),
          vout: 0,
          satoshis: 100000n,
          ownerIndex: 0,
          scriptPubKey: receive.scriptPubKey,
        },
      ],
      payments: [
        {
          address: deriveBunkOwner(new Uint8Array(64).fill(2), {
            network: { family: 'bitcoin', network: 'regtest' },
            accountIndex: 0,
            ownerIndex: 0,
          }).ownerAddress,
          satoshis: 30000n,
        },
      ],
      feeRateSatPerKvB: 1000n,
      dustRelayFeeSatPerKvB: 3000n,
      maxFeeSat: 1000n,
      lockTime: 101,
    },
  });
  const privateKey = bunkPrivateKeyFor(seed, {
    network: { family: 'bitcoin', network: 'regtest' },
    accountIndex: 0,
    ownerIndex: 0,
  });
  let signatures: string[];
  try {
    signatures = approval.prepared.signatureDigests.map((d) =>
      bytesToHex(
        secp256k1.sign(hexToBytes(d), privateKey, { prehash: false, lowS: true, format: 'der' }),
      ),
    );
  } finally {
    privateKey.fill(0);
  }
  const signed = assembleBunkBitcoinTransaction(approval.prepared.transaction, signatures);
  if (persist) {
    await claimBunkBitcoinApproval(store, key, seed, { id: approval.id, digest: approval.digest });
    await persistBunkBitcoinSignatures(store, key, seed, {
      id: approval.id,
      digest: approval.digest,
      signatures,
    });
  }
  const header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, time, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse()),
    blockhash = id(200);
  const state = {
    lookup: 'absent',
    height: 100,
    reject: false,
    lostAck: false,
    sends: 0,
    mutate: (_m: string, _p: readonly unknown[], r: unknown): unknown => r,
  };
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const access = {
    now: () => time,
    maxTipAgeSeconds: 3600,
    minConfirmations: 2,
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
              : params[0] === 100
                ? blockhash
                : tip;
        else if (method === 'getblockheader')
          result =
            params[1] === false
              ? bytesToHex(header)
              : {
                  hash: params[0],
                  height: state.height,
                  confirmations: state.lookup === 'orphaned' ? -1 : 102 - state.height,
                };
        else if (method === 'getrawtransaction') {
          if (state.lookup === 'absent')
            throw Object.assign(new Error('No transaction or missing index'), { code: -5 });
          result = {
            hex: signed.rawTransaction,
            txid: signed.txid,
            hash: signed.wtxid,
            size: signed.rawTransaction.length / 2,
            vsize: signed.vbytes,
            weight: signed.weight,
            ...(state.lookup === 'pending'
              ? {}
              : {
                  blockhash: state.height === 100 ? blockhash : tip,
                  confirmations: state.lookup === 'orphaned' ? 0 : 102 - state.height,
                }),
            ...(params.length === 3 ? { in_active_chain: state.lookup !== 'orphaned' } : {}),
          };
        } else if (method === 'testmempoolaccept')
          result = [
            {
              txid: signed.txid,
              wtxid: signed.wtxid,
              allowed: !state.reject,
              ...(state.reject
                ? { 'reject-reason': 'min relay fee not met' }
                : {
                    vsize: signed.vbytes,
                    fees: { base: Number(approval.prepared.feeSatoshis) / 1e8 },
                  }),
            },
          ];
        else if (method === 'sendrawtransaction') {
          state.sends++;
          state.lookup = 'pending';
          if (state.lostAck) throw new Error('lost response');
          result = signed.txid;
        } else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, result);
      },
    },
  };
  const input = {
    network: 'regtest' as const,
    id: approval.id,
    digest: approval.digest,
    maximumFeeRateSatPerKvB: 10000n,
  };
  return {
    seed,
    key,
    store,
    rows,
    signed,
    approval,
    state,
    access,
    input,
    calls,
    blockhash,
    tip,
    submit: () => submitBunkBitcoinApproval(store, key, seed, input, access),
    observe: () => observeBunkBitcoinApproval(store, key, seed, input, access),
  };
}

describe('Bitcoin saved-approval submission and observation', () => {
  it('preflights exact bytes/fee/size, sends with explicit caps and preserves journal', async () => {
    const f = await fixture(),
      before = [...f.rows.entries()];
    expect(await f.submit()).toMatchObject({
      outcome: 'submitted',
      txid: f.signed.txid,
      wtxid: f.signed.wtxid,
      signingAuthorized: false,
    });
    expect(f.calls.find((c) => c.method === 'testmempoolaccept')?.params).toEqual([
      [f.signed.rawTransaction],
      '0.00010000',
    ]);
    expect(f.calls.find((c) => c.method === 'sendrawtransaction')?.params).toEqual([
      f.signed.rawTransaction,
      '0.00010000',
      '0.00000000',
    ]);
    expect([...f.rows.entries()]).toEqual(before);
    expect(await f.observe()).toMatchObject({ status: 'pending', confirmations: 0 });
  });
  it('does not rebroadcast already observed pending or canonical transactions', async () => {
    for (const lookup of ['pending', 'included']) {
      const f = await fixture();
      f.state.lookup = lookup;
      const r = await f.submit();
      expect(r.outcome).toBe('already-observed');
      expect(f.state.sends).toBe(0);
      expect(f.calls.some((c) => c.method === 'testmempoolaccept')).toBe(false);
    }
  });
  it('distinguishes included threshold, confirmed, orphaned and unavailable lookups', async () => {
    const f = await fixture();
    expect((await f.observe()).status).toBe('not-observed');
    f.state.lookup = 'included';
    f.state.height = 101;
    expect((await f.observe()).status).toBe('included');
    f.state.height = 100;
    expect((await f.observe()).status).toBe('confirmed');
    f.state.lookup = 'orphaned';
    expect(
      await observeBunkBitcoinApproval(
        f.store,
        f.key,
        f.seed,
        { ...f.input, blockHint: f.blockhash },
        f.access,
      ),
    ).toMatchObject({
      status: 'orphaned',
      confirmations: 0,
      block: { height: 100, blockhash: f.blockhash },
    });
  });
  it('retains signed state after lost send acknowledgement and observes before retry', async () => {
    const f = await fixture(),
      before = [...f.rows.entries()];
    f.state.lostAck = true;
    await expect(f.submit()).rejects.toBeInstanceOf(BunkBitcoinSubmissionUncertain);
    expect([...f.rows.entries()]).toEqual(before);
    expect((await f.submit()).outcome).toBe('already-observed');
    expect(f.state.sends).toBe(1);
  });
  it('returns preflight rejection without sending and rejects altered acceptance metadata', async () => {
    const f = await fixture();
    f.state.reject = true;
    expect(await f.submit()).toMatchObject({
      outcome: 'rejected',
      reason: 'min relay fee not met',
    });
    expect(f.state.sends).toBe(0);
    for (const mutation of [
      { txid: id(999) },
      { wtxid: id(999) },
      { vsize: 999 },
      { fees: { base: 0.1 } },
      { allowed: undefined },
    ]) {
      const f = await fixture();
      f.state.mutate = (m, _p, r) =>
        m === 'testmempoolaccept' ? [{ ...(r as object[])[0], ...mutation }] : r;
      await expect(f.submit()).rejects.toThrow();
      expect(f.state.sends).toBe(0);
    }
  });
  it('rejects unsigned approvals, changed digest, wrong network and actual signed fee-rate cap', async () => {
    const unsigned = await fixture(false);
    await expect(unsigned.submit()).rejects.toThrow('saved signed');
    expect(unsigned.calls).toHaveLength(0);
    for (const mutation of [
      { digest: id(999) },
      { network: 'mainnet' },
      { maximumFeeRateSatPerKvB: 1n },
    ]) {
      const f = await fixture();
      Object.assign(f.input, mutation);
      await expect(f.submit()).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });
  it('rejects changed raw bytes, witness IDs, confirmations and canonical block hashes', async () => {
    for (const mutation of [
      { hex: '00' },
      { hash: id(999) },
      { confirmations: 7 },
      { blockhash: id(999) },
    ]) {
      const f = await fixture();
      f.state.lookup = 'included';
      f.state.mutate = (m, _p, r) =>
        m === 'getrawtransaction' ? { ...(r as object), ...mutation } : r;
      await expect(f.observe()).rejects.toThrow();
    }
  });
  it('propagates non-absence errors and rejects changing observations', async () => {
    const f = await fixture();
    f.state.lookup = 'pending';
    f.state.mutate = (m, _p, r) => {
      if (m === 'getrawtransaction') throw Object.assign(new Error('index syncing'), { code: -28 });
      return r;
    };
    await expect(f.submit()).rejects.toThrow('index syncing');
    expect(f.state.sends).toBe(0);
    const changed = await fixture();
    changed.state.lookup = 'pending';
    let reads = 0;
    changed.state.mutate = (m, _p, r) => {
      if (m === 'getrawtransaction' && ++reads === 1) changed.state.lookup = 'included';
      return r;
    };
    await expect(changed.observe()).rejects.toThrow('state changed');
  });
  it('marks post-send cancellation or a wrong acknowledgement uncertain without journal changes', async () => {
    for (const cancel of [false, true]) {
      const f = await fixture(),
        controller = new AbortController(),
        before = [...f.rows.entries()];
      f.state.mutate = (m, _p, r) => {
        if (m === 'sendrawtransaction') {
          if (cancel) controller.abort();
          else return id(999);
        }
        return r;
      };
      await expect(
        submitBunkBitcoinApproval(f.store, f.key, f.seed, f.input, {
          ...f.access,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(BunkBitcoinSubmissionUncertain);
      expect(f.state.sends).toBe(1);
      expect([...f.rows.entries()]).toEqual(before);
    }
  });
  it('snapshots caller seed/request/access and rejects obsolete checkpoints', async () => {
    const f = await fixture(),
      pending = f.submit();
    f.seed.fill(0);
    f.input.digest = id(999);
    f.input.maximumFeeRateSatPerKvB = 1n;
    f.access.maxTipAgeSeconds = 0;
    expect((await pending).outcome).toBe('submitted');
    const reorg = await fixture();
    await expect(
      observeBunkBitcoinApproval(
        reorg.store,
        reorg.key,
        reorg.seed,
        {
          ...reorg.input,
          previousCheckpoint: { network: 'regtest', height: 100, blockhash: id(999) },
        },
        reorg.access,
      ),
    ).rejects.toThrow('reorganized');
  });
});
