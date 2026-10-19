import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { deriveBunkOwner } from './bunk';
import {
  type BunkBitcoinApprovalRequest,
  reserveObservedBunkBitcoinApproval,
  reviewBunkBitcoinApproval,
  signObservedBunkBitcoinApproval,
} from './bunk-bitcoin-approval';
import {
  allocateBunkBitcoinAddress,
  cancelBunkBitcoinApproval,
  exportBunkBitcoinJournalArchive,
  initializeBunkBitcoinJournal,
  openBunkBitcoinJournalArchive,
  readBunkBitcoinApproval,
  readBunkBitcoinJournal,
} from './bunk-bitcoin-journal';
import type { BunkBitcoinObservationAccess } from './bunk-bitcoin-rpc';
import { submitBunkBitcoinApproval } from './bunk-bitcoin-submit';
import {
  type BunkJournalSnapshot,
  type BunkJournalStore,
  BunkSigningUncertain,
} from './bunk-evm-v2-journal';

const id = (n: number) => n.toString(16).padStart(64, '0'),
  time = 1_800_000_000;
async function fixture(singleInputPerOwner = false) {
  const seed = new Uint8Array(64).fill(1),
    rows = new Map<string, BunkJournalSnapshot>();
  const state = {
    lostAck: false,
    offline: false,
    pending: false,
    spent: false,
    fee: 0.00001,
    ancestorFee: 0.000001,
    now: time,
    mutate: (_m: string, _p: readonly unknown[], r: unknown): unknown => r,
  };
  const store: BunkJournalStore = {
    async read(k) {
      const r = rows.get(k);
      return r ? { ...r } : null;
    },
    async compareAndSwap(k, revision, value) {
      if ((rows.get(k)?.revision ?? null) !== revision) return false;
      rows.set(k, { revision: revision === null ? 0 : revision + 1, value });
      if (state.lostAck) {
        state.lostAck = false;
        throw new Error('lost acknowledgement');
      }
      return true;
    },
  };
  const scope = { network: 'regtest', accountIndex: 0 } as const;
  const { key } = await initializeBunkBitcoinJournal(store, seed, {
    ...scope,
    origin: 'new-wallet',
  });
  const allocations: Awaited<ReturnType<typeof allocateBunkBitcoinAddress>>[] = [];
  for (let i = 0; i < 3; i++)
    allocations.push(
      await allocateBunkBitcoinAddress(store, key, seed, {
        id: id(i + 1),
        expectedNextOwnerIndex: i,
        purpose: i === 2 ? 'change' : 'receive',
      }),
    );
  const script = (i: number) => {
    const a = allocations[i];
    if (!a) throw new Error('missing allocation');
    return a.scriptPubKey;
  };
  const coins = [100000n, 10000n, 30000n].map((satoshis, vout) => ({
    txid: id(100),
    vout,
    satoshis,
    ownerIndex: vout === 2 ? 1 : 0,
    scriptPubKey: script(vout === 2 ? 1 : 0),
  }));
  if (singleInputPerOwner) coins.splice(1, 1);
  const input: BunkBitcoinApprovalRequest = {
    id: id(10),
    changeAllocationId: id(3),
    allowUnconfirmed: false,
    feePolicy: {
      confirmationTarget: 6,
      mode: 'conservative',
      minimumRateSatPerKvB: 100n,
      maximumRateSatPerKvB: 10000n,
    },
    spend: {
      ...scope,
      changeIndex: 2,
      utxos: coins.map((c) => ({ ...c })),
      payments: [
        {
          address: deriveBunkOwner(new Uint8Array(64).fill(2), {
            network: { family: 'bitcoin', network: 'regtest' },
            accountIndex: 0,
            ownerIndex: 0,
          }).ownerAddress,
          satoshis: singleInputPerOwner ? 120000n : 30000n,
        },
      ],
      feeRateSatPerKvB: 1000n,
      dustRelayFeeSatPerKvB: 3000n,
      maxFeeSat: 1000n,
      lockTime: 101,
    },
  };
  const header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, time, true);
  const tip = bytesToHex(sha256(sha256(header)).reverse()),
    old = id(200);
  const incoming: Record<string, unknown>[] = [];
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const access = {
    now: () => state.now,
    maxTipAgeSeconds: 3600,
    minConfirmations: 1,
    rpc: {
      async request(method: string, params: readonly unknown[]) {
        if (state.offline) throw new Error('offline');
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
                ? old
                : tip;
        else if (method === 'getblockheader') result = bytesToHex(header);
        else if (method === 'getmempoolinfo')
          result = {
            loaded: true,
            minrelaytxfee: 0.000001,
            mempoolminfee: 0.000001,
            incrementalrelayfee: 0.000001,
          };
        else if (method === 'estimatesmartfee') result = { feerate: state.fee, blocks: 6 };
        else if (method === 'scantxoutset') {
          const descriptors = params[1] as { desc: string }[];
          const unspents = (state.pending ? [] : coins)
            .filter((c) => descriptors.some((d) => d.desc === `raw(${c.scriptPubKey})`))
            .map((c) => ({
              txid: c.txid,
              vout: c.vout,
              scriptPubKey: c.scriptPubKey,
              amount: Number(c.satoshis) / 1e8,
              height: 100,
              blockhash: old,
              confirmations: 2,
              coinbase: false,
            }));
          result = {
            success: true,
            height: 101,
            bestblock: tip,
            unspents,
            total_amount: (
              unspents.reduce((s, c) => s + Math.round(c.amount * 1e8), 0) / 1e8
            ).toFixed(8),
          };
        } else if (method === 'scanblocks')
          result = { completed: true, from_height: 101, to_height: 101, relevant_blocks: [] };
        else if (method === 'getdescriptoractivity') {
          const descriptors = params[1] as string[];
          const events = [
            ...incoming,
            ...(state.pending
              ? coins.map((c) => ({
                  type: 'receive',
                  txid: c.txid,
                  vout: c.vout,
                  amount: Number(c.satoshis) / 1e8,
                  output_spk: { hex: c.scriptPubKey },
                }))
              : []),
          ];
          result = {
            activity: params[2]
              ? events.filter((e) =>
                  descriptors.includes(`raw(${(e.output_spk as { hex: string }).hex})`),
                )
              : [],
          };
        } else if (method === 'gettxout') {
          const c = coins.find((c) => c.txid === params[0] && c.vout === params[1]);
          if (!c) throw new Error('unknown coin');
          result = state.spent
            ? null
            : {
                bestblock: tip,
                confirmations: state.pending ? 0 : 2,
                coinbase: false,
                scriptPubKey: { hex: c.scriptPubKey },
                value: Number(c.satoshis) / 1e8,
              };
        } else if (method === 'getmempoolentry')
          result = {
            vsize: 100,
            weight: 400,
            wtxid: id(101),
            fees: { base: state.ancestorFee },
            depends: [],
          };
        else if (method === 'getmempoolancestors') result = {};
        else throw new Error(`Unexpected RPC ${method}`);
        return state.mutate(method, params, result);
      },
    },
  };
  return {
    seed,
    key,
    store,
    rows,
    state,
    input,
    coins,
    incoming,
    access,
    calls,
    script,
    review: () => reviewBunkBitcoinApproval(store, key, seed, input, access),
    reserve: (digest: string) =>
      reserveObservedBunkBitcoinApproval(
        store,
        key,
        seed,
        { ...input, approvedReviewDigest: digest },
        access,
      ),
  };
}

describe('Bitcoin observed approval reservation', () => {
  it('reviews without writes, then rechecks and reserves exactly the reviewed plan', async () => {
    const f = await fixture(),
      before = [...f.rows.entries()],
      reviewed = await f.review();
    expect([...f.rows.entries()]).toEqual(before);
    expect(reviewed.prepared.selected.map((u) => u.vout)).toEqual([0, 1]);
    expect(reviewed.signingAuthorized).toBe(false);
    const reserved = await f.reserve(reviewed.reviewDigest);
    expect(reserved).toMatchObject({
      resumed: false,
      approval: { phase: 'approved' },
      signingAuthorized: false,
    });
    expect(reserved.approval.prepared).toEqual(reviewed.prepared);
    expect(reserved.observation?.reviewDigest).toBe(reviewed.reviewDigest);
    expect((await readBunkBitcoinJournal(f.store, f.key, f.seed)).approvals).toHaveLength(1);
  });

  it('rejects changed recipient amounts, fee caps and pending consent before RPC or writes', async () => {
    for (const change of ['amount', 'cap', 'pending']) {
      const f = await fixture(),
        reviewed = await f.review(),
        count = f.calls.length,
        before = [...f.rows.entries()];
      if (change === 'amount')
        f.input.spend.payments = f.input.spend.payments.map((p) => ({
          ...p,
          satoshis: p.satoshis + 1n,
        }));
      if (change === 'cap') f.input.spend.maxFeeSat += 1n;
      if (change === 'pending') f.input.allowUnconfirmed = true;
      await expect(f.reserve(reviewed.reviewDigest)).rejects.toThrow('reviewed approval changed');
      expect(f.calls).toHaveLength(count);
      expect([...f.rows.entries()]).toEqual(before);
    }
  });

  it('rejects omitted and newly arrived confirmed or pending deposits to selected owners', async () => {
    for (const kind of ['omitted', 'confirmed', 'pending']) {
      const f = await fixture(),
        reviewed = await f.review();
      const first = f.coins[0];
      if (!first) throw new Error('missing coin');
      if (kind === 'omitted') f.input.spend.utxos = [first];
      else if (kind === 'confirmed') f.coins.push({ ...first, txid: id(999), satoshis: 1000n });
      else
        f.incoming.push({
          type: 'receive',
          txid: id(999),
          vout: 0,
          amount: 0.00001,
          output_spk: { hex: first.scriptPubKey },
        });
      await expect(
        kind === 'omitted' ? f.review() : f.reserve(reviewed.reviewDigest),
      ).rejects.toThrow('group changed or incomplete');
      expect((await readBunkBitcoinJournal(f.store, f.key, f.seed)).approvals).toHaveLength(0);
    }
  });

  it('rejects spent inputs, funded change and higher estimates without repricing', async () => {
    for (const kind of ['spent', 'change', 'fees']) {
      const f = await fixture(),
        reviewed = await f.review();
      if (kind === 'spent') f.state.spent = true;
      if (kind === 'change')
        f.incoming.push({
          type: 'receive',
          txid: id(999),
          vout: 0,
          amount: 0.00001,
          output_spk: { hex: f.script(2) },
        });
      if (kind === 'fees') f.state.fee = 0.00002;
      await expect(f.reserve(reviewed.reviewDigest)).rejects.toThrow();
      expect((await readBunkBitcoinJournal(f.store, f.key, f.seed)).approvals).toHaveLength(0);
    }
  });

  it('requires pending-input consent and enough fee for the entire ancestor package', async () => {
    const f = await fixture();
    f.state.pending = true;
    await expect(f.review()).rejects.toThrow('unconfirmed consent');
    f.input.allowUnconfirmed = true;
    expect((await f.review()).packageBudget?.ancestorVbytes).toBe(100);
    f.state.ancestorFee = 0;
    await expect(f.review()).rejects.toThrow('insufficient for ancestor package');
    f.input.spend.feeRateSatPerKvB = 2000n;
    expect((await f.review()).packageBudget).not.toBeNull();
  });

  it('recovers a lost CAS acknowledgement offline without renewing authorization', async () => {
    const f = await fixture(),
      reviewed = await f.review();
    f.state.lostAck = true;
    await expect(f.reserve(reviewed.reviewDigest)).rejects.toThrow('lost acknowledgement');
    f.state.offline = true;
    const retried = await f.reserve(reviewed.reviewDigest);
    expect(retried).toMatchObject({
      resumed: true,
      observation: null,
      approval: { phase: 'approved' },
      signingAuthorized: false,
    });
    expect(retried.approval.prepared).toEqual(reviewed.prepared);
  });

  it('lets only one competing approval reserve the same owner/change', async () => {
    const f = await fixture(),
      other = { ...f.input, id: id(11) };
    const a = await f.review(),
      b = await reviewBunkBitcoinApproval(f.store, f.key, f.seed, other, f.access);
    const results = await Promise.allSettled([
      f.reserve(a.reviewDigest),
      reserveObservedBunkBitcoinApproval(
        f.store,
        f.key,
        f.seed,
        { ...other, approvedReviewDigest: b.reviewDigest },
        f.access,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readBunkBitcoinJournal(f.store, f.key, f.seed)).approvals).toHaveLength(1);
  });

  it('fences cancellation, changing tips and missing journal history', async () => {
    const f = await fixture(),
      controller = new AbortController();
    f.state.mutate = (m, _p, r) => {
      if (m === 'scanblocks') controller.abort();
      return r;
    };
    await expect(
      reviewBunkBitcoinApproval(f.store, f.key, f.seed, f.input, {
        ...f.access,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    const changed = await fixture();
    let reads = 0;
    changed.state.mutate = (m, _p, r) =>
      m === 'getblockchaininfo' && ++reads > 1 ? { ...(r as object), blocks: 102 } : r;
    await expect(changed.review()).rejects.toThrow();
    const missing = await fixture();
    missing.rows.clear();
    await expect(missing.review()).rejects.toThrow('history is missing');
    expect(missing.rows.size).toBe(0);
  });

  it('snapshots seed, request and policy before asynchronous work', async () => {
    const f = await fixture(),
      reviewed = await f.review();
    const pending = f.reserve(reviewed.reviewDigest);
    const originalSeed = f.seed.slice();
    f.seed.fill(0);
    f.input.spend.payments = [];
    f.input.feePolicy.maximumRateSatPerKvB = 1n;
    f.access.maxTipAgeSeconds = 0;
    const result = await pending;
    expect(result.approval.prepared).toEqual(reviewed.prepared);
    expect((await readBunkBitcoinApproval(f.store, f.key, originalSeed, id(10))).prepared).toEqual(
      reviewed.prepared,
    );
  });
});

async function signingFixture(singleInputPerOwner = true) {
  const f = await fixture(singleInputPerOwner);
  const reviewed = await f.review();
  const reserved = await f.reserve(reviewed.reviewDigest);
  const request = {
    ...f.input,
    approvedReviewDigest: reviewed.reviewDigest,
    approvalDigest: reserved.approval.digest,
  };
  return {
    ...f,
    request,
    sign: (store: BunkJournalStore = f.store, access: BunkBitcoinObservationAccess = f.access) =>
      signObservedBunkBitcoinApproval(store, f.key, f.seed, request, access),
    read: () => readBunkBitcoinApproval(f.store, f.key, f.seed, f.input.id),
  };
}

describe('Bitcoin observed signing coordinator', () => {
  it('restores an encrypted archive and submits its exact saved transaction without journal changes', async () => {
    const f = await signingFixture(),
      result = await f.sign(),
      saved = result.approval.signed;
    if (!saved) throw new Error('Missing signed transaction');
    const archive = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const imported = openBunkBitcoinJournalArchive(archive, f.seed);
    const before = [...f.rows.entries()],
      sent: unknown[] = [];
    const transport: BunkBitcoinObservationAccess = {
      ...f.access,
      rpc: {
        async request(method, params) {
          if (method === 'getrawtransaction')
            throw Object.assign(new Error('absent'), { code: -5 });
          if (method === 'testmempoolaccept') {
            expect(params[0]).toEqual([saved.rawTransaction]);
            return [
              {
                txid: saved.txid,
                wtxid: saved.wtxid,
                allowed: true,
                vsize: saved.vbytes,
                fees: { base: Number(result.approval.prepared.feeSatoshis) / 1e8 },
              },
            ];
          }
          if (method === 'sendrawtransaction') {
            sent.push(...params);
            return saved.txid;
          }
          return f.access.rpc.request(method, params);
        },
      },
    };
    const submitted = await submitBunkBitcoinApproval(
      imported.store,
      imported.key,
      f.seed,
      {
        network: 'regtest',
        id: f.request.id,
        digest: f.request.approvalDigest,
        maximumFeeRateSatPerKvB: 10000n,
      },
      transport,
    );
    expect(submitted).toMatchObject({ outcome: 'submitted', txid: saved.txid, wtxid: saved.wtxid });
    expect(sent).toEqual([saved.rawTransaction, '0.00010000', '0.00000000']);
    expect([...f.rows.entries()]).toEqual(before);
    imported.store.destroy();
  });

  it('signs distinct owners only after a durable claim, saves valid bytes and retries offline', async () => {
    const f = await signingFixture(),
      originalSeed = f.seed.slice(),
      phases: string[] = [];
    f.state.mutate = (method, _params, result) => {
      if (method === 'scantxoutset') {
        const row = f.rows.get(f.key);
        if (!row) throw new Error('Missing journal');
        phases.push(JSON.parse(row.value).approvals[0].phase);
      }
      return result;
    };
    const signed = await f.sign();
    expect(signed.resumed).toBe(false);
    expect(signed.approval.phase).toBe('signed');
    expect(signed.approval.prepared.selected.map((u) => u.ownerIndex)).toEqual([0, 1]);
    expect(signed.approval.signed?.txid).toBe(signed.approval.prepared.txid);
    expect(signed.approval.signed?.rawTransaction).toBeTruthy();
    expect(phases).toEqual(['approved', 'claimed']);
    expect((await f.read()).signed).toEqual(signed.approval.signed);
    expect(f.seed).toEqual(originalSeed);
    const before = [...f.rows.entries()],
      rpcCount = f.calls.length;
    f.state.offline = true;
    const retried = await f.sign();
    expect(retried).toMatchObject({ resumed: true, observation: null, signingAuthorized: false });
    expect(retried.approval.signed).toEqual(signed.approval.signed);
    expect([...f.rows.entries()]).toEqual(before);
    expect(f.calls).toHaveLength(rpcCount);
  });

  it('rejects multiple inputs from one owner before RPC or claiming', async () => {
    const f = await signingFixture(false),
      before = [...f.rows.entries()],
      rpcCount = f.calls.length;
    await expect(f.sign()).rejects.toThrow('signing-policy decision');
    expect([...f.rows.entries()]).toEqual(before);
    expect(f.calls).toHaveLength(rpcCount);
    expect((await f.read()).phase).toBe('approved');
  });

  it('rejects altered review, stored digest, consent and cancelled approvals before RPC', async () => {
    for (const change of ['review', 'stored', 'consent', 'cancelled']) {
      const f = await signingFixture();
      if (change === 'review') f.request.approvedReviewDigest = id(99);
      if (change === 'stored') f.request.approvalDigest = id(99);
      if (change === 'consent') f.request.allowUnconfirmed = true;
      if (change === 'cancelled')
        await cancelBunkBitcoinApproval(f.store, f.key, f.seed, {
          id: f.request.id,
          digest: f.request.approvalDigest,
        });
      const before = [...f.rows.entries()],
        rpcCount = f.calls.length;
      await expect(f.sign()).rejects.toThrow();
      expect([...f.rows.entries()]).toEqual(before);
      expect(f.calls).toHaveLength(rpcCount);
    }
  });

  it('retains the claim if inputs become spent after it, and refuses another signing attempt', async () => {
    const f = await signingFixture();
    const changed: BunkJournalStore = {
      read: f.store.read,
      async compareAndSwap(...args) {
        const result = await f.store.compareAndSwap(...args);
        f.state.spent = true;
        return result;
      },
    };
    await expect(f.sign(changed)).rejects.toThrow();
    expect((await f.read()).phase).toBe('claimed');
    f.state.spent = false;
    const rpcCount = f.calls.length;
    await expect(f.sign()).rejects.toBeInstanceOf(BunkSigningUncertain);
    expect(f.calls).toHaveLength(rpcCount);
  });

  it('rejects changed funds or fees before claiming an otherwise approved transaction', async () => {
    for (const change of ['spent', 'incoming', 'fees']) {
      const f = await signingFixture(),
        before = [...f.rows.entries()];
      if (change === 'spent') f.state.spent = true;
      if (change === 'fees') f.state.fee = 0.00002;
      if (change === 'incoming')
        f.incoming.push({
          type: 'receive',
          txid: id(999),
          vout: 0,
          amount: 0.00001,
          output_spk: { hex: f.script(0) },
        });
      await expect(f.sign()).rejects.toThrow();
      expect([...f.rows.entries()]).toEqual(before);
      expect((await f.read()).phase).toBe('approved');
    }
  });

  it('handles failed and lost-acknowledgement claim writes without returning a signature', async () => {
    for (const committed of [false, true]) {
      const f = await signingFixture();
      const failed: BunkJournalStore = {
        read: f.store.read,
        async compareAndSwap(...args) {
          if (committed) await f.store.compareAndSwap(...args);
          throw new Error('claim write failed');
        },
      };
      await expect(f.sign(failed)).rejects.toThrow('claim write failed');
      const saved = await f.read();
      expect(saved.phase).toBe(committed ? 'claimed' : 'approved');
      expect(saved.signed).toBeNull();
      if (committed) await expect(f.sign()).rejects.toBeInstanceOf(BunkSigningUncertain);
      else expect((await f.sign()).approval.phase).toBe('signed');
    }
  });

  it('never resigns after signature persistence fails and recovers a committed lost response', async () => {
    for (const committed of [false, true]) {
      const f = await signingFixture();
      const failed: BunkJournalStore = {
        read: f.store.read,
        async compareAndSwap(...args) {
          if (JSON.parse(args[2]).approvals[0].phase !== 'signed')
            return f.store.compareAndSwap(...args);
          if (committed) await f.store.compareAndSwap(...args);
          throw new Error('signature write failed');
        },
      };
      await expect(f.sign(failed)).rejects.toThrow('signature write failed');
      const saved = await f.read();
      expect(saved.phase).toBe(committed ? 'signed' : 'claimed');
      f.state.offline = true;
      if (committed) expect((await f.sign()).approval.signed).toEqual(saved.signed);
      else await expect(f.sign()).rejects.toBeInstanceOf(BunkSigningUncertain);
    }
  });

  it('allows only one concurrent signing claim for the same approval', async () => {
    const f = await signingFixture(),
      before = f.rows.get(f.key)?.revision;
    if (before === undefined) throw new Error('Missing journal');
    const results = await Promise.allSettled([f.sign(), f.sign()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.read()).phase).toBe('signed');
    expect(f.rows.get(f.key)?.revision).toBe(before + 2);
  });

  it('snapshots the approved request, transport and seed across asynchronous work', async () => {
    const f = await signingFixture(),
      original = f.seed.slice(),
      pending = f.sign();
    f.seed.fill(0);
    f.request.spend.payments = [];
    f.request.feePolicy.maximumRateSatPerKvB = 1n;
    f.access.maxTipAgeSeconds = 0;
    const signed = await pending;
    expect(signed.approval.phase).toBe('signed');
    expect((await readBunkBitcoinApproval(f.store, f.key, original, f.input.id)).signed).toEqual(
      signed.approval.signed,
    );
  });

  it('fences cancellation before claiming and retains uncertainty after claiming', async () => {
    for (const afterClaim of [false, true]) {
      const f = await signingFixture(),
        controller = new AbortController();
      if (!afterClaim) controller.abort();
      const interrupted: BunkJournalStore = {
        read: f.store.read,
        async compareAndSwap(...args) {
          const result = await f.store.compareAndSwap(...args);
          controller.abort();
          return result;
        },
      };
      await expect(f.sign(interrupted, { ...f.access, signal: controller.signal })).rejects.toThrow(
        'cancelled',
      );
      expect((await f.read()).phase).toBe(afterClaim ? 'claimed' : 'approved');
    }
  });
});
