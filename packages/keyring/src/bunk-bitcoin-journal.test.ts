import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { bunkPrivateKeyFor, deriveBunkOwner } from './bunk';
import type { BunkBitcoinSpendRequest } from './bunk-bitcoin';
import {
  allocateBunkBitcoinAddress,
  BunkBitcoinArchiveReadOnly,
  bunkBitcoinAccountJournalKey,
  cancelBunkBitcoinApproval,
  claimBunkBitcoinApproval,
  exportBunkBitcoinJournalArchive,
  initializeBunkBitcoinJournal,
  openBunkBitcoinJournalArchive,
  persistBunkBitcoinSignatures,
  readBunkBitcoinApproval,
  readBunkBitcoinJournal,
  reserveBunkBitcoinApproval,
} from './bunk-bitcoin-journal';
import {
  BunkJournalConflict,
  type BunkJournalSnapshot,
  type BunkJournalStore,
  BunkSigningUncertain,
} from './bunk-evm-v2-journal';
import { encryptedBunkJournalStore } from './bunk-evm-v2-store';
import { deriveBunkJournalEncryptionKey } from './bunk-journal-key';

const id = (n: number) => n.toString(16).padStart(64, '0');
const scope = { network: 'regtest', accountIndex: 0 } as const;
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing fixture entry');
  return value;
}
async function fixture() {
  const seed = new Uint8Array(64).fill(1),
    rows = new Map<string, BunkJournalSnapshot>();
  const raw: BunkJournalStore = {
    async read(key) {
      const r = rows.get(key);
      return r ? { ...r } : null;
    },
    async compareAndSwap(key, revision, value) {
      const current = rows.get(key);
      if ((current?.revision ?? null) !== revision) return false;
      rows.set(key, { revision: revision === null ? 0 : revision + 1, value });
      return true;
    },
  };
  const encryptionKey = deriveBunkJournalEncryptionKey(seed);
  const store = encryptedBunkJournalStore(raw, encryptionKey, (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
  );
  encryptionKey.fill(0);
  const initialized = await initializeBunkBitcoinJournal(store, seed, {
    ...scope,
    origin: 'new-wallet',
  });
  const key = initialized.key;
  const allocate = (index: number, purpose: 'receive' | 'change', allocationId = id(index + 1)) =>
    allocateBunkBitcoinAddress(store, key, seed, {
      id: allocationId,
      expectedNextOwnerIndex: index,
      purpose,
    });
  const recipient = deriveBunkOwner(new Uint8Array(64).fill(2), {
    network: { family: 'bitcoin', network: 'regtest' },
    accountIndex: 0,
    ownerIndex: 0,
  }).ownerAddress;
  const prepare = async () => {
    const received = await allocate(0, 'receive');
    await allocate(1, 'receive');
    const change = await allocate(2, 'change');
    const spend: BunkBitcoinSpendRequest = {
      ...scope,
      changeIndex: 2,
      utxos: [
        {
          txid: id(100),
          vout: 0,
          satoshis: 100000n,
          ownerIndex: 0,
          scriptPubKey: received.scriptPubKey,
        },
      ],
      payments: [{ address: recipient, satoshis: 30000n }],
      feeRateSatPerKvB: 1000n,
      dustRelayFeeSatPerKvB: 3000n,
      maxFeeSat: 1000n,
      lockTime: 101,
    };
    return { id: id(20), changeAllocationId: change.id, spend };
  };
  const reserve = (request: Awaited<ReturnType<typeof prepare>>) =>
    reserveBunkBitcoinApproval(store, key, seed, request);
  const signFixture = (
    plan: Awaited<ReturnType<typeof reserve>>,
    extraEntropy: Uint8Array | false = false,
  ) =>
    plan.prepared.selected.map((u, i) => {
      const key = bunkPrivateKeyFor(seed, {
        network: { family: 'bitcoin', network: 'regtest' },
        accountIndex: 0,
        ownerIndex: u.ownerIndex,
      });
      try {
        return bytesToHex(
          secp256k1.sign(hexToBytes(at(plan.prepared.signatureDigests, i)), key, {
            prehash: false,
            lowS: true,
            format: 'der',
            extraEntropy,
          }),
        );
      } finally {
        key.fill(0);
      }
    });
  return {
    seed,
    rows,
    raw,
    store,
    key,
    allocate,
    prepare,
    reserve,
    signFixture,
    read: () => readBunkBitcoinJournal(store, key, seed),
  };
}

describe('Bitcoin encrypted allocation and approval journal', () => {
  it('uses one account key across aliases and persists allocation before returning an address', async () => {
    const f = await fixture(),
      allocated = await f.allocate(0, 'receive');
    expect(allocated).toMatchObject({
      ownerIndex: 0,
      purpose: 'receive',
      signingAuthorized: false,
    });
    expect((await f.read()).nextOwnerIndex).toBe(1);
    expect(bunkBitcoinAccountJournalKey(f.seed.slice(), scope)).toBe(f.key);
    expect(
      (await initializeBunkBitcoinJournal(f.store, f.seed, { ...scope, origin: 'new-wallet' }))
        .nextOwnerIndex,
    ).toBe(1);
    expect(f.rows.size).toBe(1);
    expect(f.rows.get(f.key)?.value).not.toContain('honey-bitcoin-account');
    expect(f.seed).toEqual(new Uint8Array(64).fill(1));
    f.store.destroy();
    await expect(f.read()).rejects.toThrow('locked');
  });

  it('does not infer a fresh wallet from missing history', async () => {
    const f = await fixture();
    f.rows.clear();
    await expect(f.allocate(0, 'receive')).rejects.toThrow('history is missing');
    await expect(
      initializeBunkBitcoinJournal(f.store, f.seed, {
        ...scope,
        origin: 'restore' as 'new-wallet',
      }),
    ).rejects.toThrow('new-wallet');
    expect(f.rows.size).toBe(0);
  });

  it('recovers a committed allocation after acknowledgement loss without advancing twice', async () => {
    const f = await fixture(),
      request = { id: id(1), expectedNextOwnerIndex: 0, purpose: 'receive' as const };
    const lost: BunkJournalStore = {
      read: f.store.read,
      async compareAndSwap(...args) {
        await f.store.compareAndSwap(...args);
        throw new Error('Lost acknowledgement');
      },
    };
    await expect(allocateBunkBitcoinAddress(lost, f.key, f.seed, request)).rejects.toThrow(
      'Lost acknowledgement',
    );
    expect((await allocateBunkBitcoinAddress(f.store, f.key, f.seed, request)).ownerIndex).toBe(0);
    expect((await f.read()).nextOwnerIndex).toBe(1);
    await expect(f.allocate(0, 'change')).rejects.toThrow('retry changed');
    await expect(f.allocate(0, 'receive', id(2))).rejects.toThrow('Stale');
  });

  it('allows only one concurrent address allocation at a cursor', async () => {
    const f = await fixture(),
      results = await Promise.allSettled([
        f.allocate(0, 'receive', id(1)),
        f.allocate(0, 'receive', id(2)),
      ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(BunkJournalConflict);
    expect((await f.read()).nextOwnerIndex).toBe(1);
  });

  it('binds input amounts and fee policy even when the non-witness transaction ID matches', async () => {
    const f = await fixture(),
      request = await f.prepare(),
      first = await f.reserve(request);
    expect(first.signingAuthorized).toBe(false);
    expect((await f.reserve(request)).digest).toBe(first.digest);
    const changed = { ...request, spend: { ...request.spend, maxFeeSat: 999n } };
    await expect(f.reserve(changed)).rejects.toThrow('retry changed');
    const tampered = await f.store.read(f.key);
    if (!tampered) throw new Error('Missing row');
    const record = JSON.parse(tampered.value);
    record.approvals[0].spend.utxos[0].satoshis = '100001';
    await f.store.compareAndSwap(f.key, tampered.revision, JSON.stringify(record));
    await expect(f.read()).rejects.toThrow('binding mismatch');
  });

  it('reserves the whole selected owner group and rejects a competing approval', async () => {
    const f = await fixture(),
      request = await f.prepare();
    request.spend.utxos = [
      ...request.spend.utxos,
      { ...at(request.spend.utxos, 0), vout: 1, satoshis: 1000n },
    ];
    const first = await f.reserve(request);
    expect(first.prepared.selected).toHaveLength(2);
    const nextChange = await f.allocate(3, 'change');
    await expect(
      f.reserve({
        id: id(21),
        changeAllocationId: nextChange.id,
        spend: { ...request.spend, changeIndex: 3 },
      }),
    ).rejects.toThrow('owner already reserved');
    expect((await f.read()).approvals).toHaveLength(1);
  });

  it('allows cancellation only before claiming, burns change, and atomically races claim with cancellation', async () => {
    const f = await fixture(),
      request = await f.prepare(),
      approval = await f.reserve(request);
    await cancelBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    await expect(claimBunkBitcoinApproval(f.store, f.key, f.seed, approval)).rejects.toThrow(
      'not claimable',
    );
    await expect(f.reserve({ ...request, id: id(21) })).rejects.toThrow(
      'change allocation unavailable',
    );
    const fresh = await f.allocate(3, 'change');
    const next = await f.reserve({
      id: id(21),
      changeAllocationId: fresh.id,
      spend: { ...request.spend, changeIndex: 3 },
    });
    const race = await Promise.allSettled([
      claimBunkBitcoinApproval(f.store, f.key, f.seed, next),
      cancelBunkBitcoinApproval(f.store, f.key, f.seed, next),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('retains an uncertain claim and prevents cancellation or another key authorization', async () => {
    const f = await fixture(),
      approval = await f.reserve(await f.prepare());
    await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    await expect(claimBunkBitcoinApproval(f.store, f.key, f.seed, approval)).rejects.toBeInstanceOf(
      BunkSigningUncertain,
    );
    await expect(cancelBunkBitcoinApproval(f.store, f.key, f.seed, approval)).rejects.toThrow(
      'cannot be cancelled',
    );
    expect((await readBunkBitcoinApproval(f.store, f.key, f.seed, approval.id)).phase).toBe(
      'claimed',
    );
  });

  it('verifies and saves signatures before returning exact rebroadcast bytes', async () => {
    const f = await fixture(),
      approval = await f.reserve(await f.prepare()),
      signatures = f.signFixture(approval);
    await expect(
      persistBunkBitcoinSignatures(f.store, f.key, f.seed, { ...approval, signatures }),
    ).rejects.toThrow('not claimed');
    await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    await expect(
      persistBunkBitcoinSignatures(f.store, f.key, f.seed, { ...approval, signatures: ['00'] }),
    ).rejects.toThrow();
    const saved = await persistBunkBitcoinSignatures(f.store, f.key, f.seed, {
      ...approval,
      signatures,
    });
    const reopened = await readBunkBitcoinApproval(f.store, f.key, f.seed, approval.id);
    expect(reopened.signed).toEqual(saved.signed);
    expect(saved.phase).toBe('signed');
    expect(saved.signed?.txid).toBe(approval.prepared.txid);
    expect(
      (await persistBunkBitcoinSignatures(f.store, f.key, f.seed, { ...approval, signatures }))
        .signed,
    ).toEqual(saved.signed);
    const alternative = f.signFixture(approval, new Uint8Array(32).fill(3));
    expect(alternative).not.toEqual(signatures);
    await expect(
      persistBunkBitcoinSignatures(f.store, f.key, f.seed, {
        ...approval,
        signatures: alternative,
      }),
    ).rejects.toThrow('cannot be replaced');
  });

  it('retains the claim when signature storage fails, and recovers a committed but unacknowledged save', async () => {
    const f = await fixture(),
      approval = await f.reserve(await f.prepare()),
      signatures = f.signFixture(approval);
    await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    const failed: BunkJournalStore = {
      read: f.store.read,
      async compareAndSwap() {
        throw new Error('Disk full');
      },
    };
    await expect(
      persistBunkBitcoinSignatures(failed, f.key, f.seed, { ...approval, signatures }),
    ).rejects.toThrow('Disk full');
    expect((await readBunkBitcoinApproval(f.store, f.key, f.seed, approval.id)).phase).toBe(
      'claimed',
    );
    const lost: BunkJournalStore = {
      read: f.store.read,
      async compareAndSwap(...args) {
        await f.store.compareAndSwap(...args);
        throw new Error('Lost acknowledgement');
      },
    };
    await expect(
      persistBunkBitcoinSignatures(lost, f.key, f.seed, { ...approval, signatures }),
    ).rejects.toThrow('Lost acknowledgement');
    expect((await readBunkBitcoinApproval(f.store, f.key, f.seed, approval.id)).phase).toBe(
      'signed',
    );
  });

  it('rejects wrong seeds, revision/ciphertext substitution and malformed record fields', async () => {
    const f = await fixture();
    await expect(
      readBunkBitcoinJournal(f.store, f.key, new Uint8Array(64).fill(2)),
    ).rejects.toThrow('foreign');
    const row = f.rows.get(f.key);
    if (!row) throw new Error('Missing row');
    f.rows.set(f.key, { ...row, revision: row.revision + 1 });
    await expect(f.read()).rejects.toThrow();
    f.rows.set(f.key, row);
    const plain = await f.store.read(f.key);
    if (!plain) throw new Error('Missing plaintext');
    await f.store.compareAndSwap(
      f.key,
      plain.revision,
      JSON.stringify({ ...JSON.parse(plain.value), extra: true }),
    );
    await expect(f.read()).rejects.toThrow('fields');
  });

  it('snapshots caller-owned seeds and spend fields before storage awaits', async () => {
    const f = await fixture(),
      request = await f.prepare(),
      expected = { ...at(request.spend.payments, 0) };
    const pending = f.reserve(request);
    f.seed.fill(0);
    at(request.spend.payments, 0).satoshis = 999999n;
    const result = await pending;
    expect(at(result.prepared.transaction.outputs, 0).satoshis).toBe(expected.satoshis);
  });
});

const archiveRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('Bitcoin encrypted journal archives', () => {
  it('restores the exact saved signed transaction without modifying the source journal', async () => {
    const f = await fixture(),
      request = await f.prepare(),
      approval = await f.reserve(request);
    await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    const signed = await persistBunkBitcoinSignatures(f.store, f.key, f.seed, {
      ...approval,
      signatures: f.signFixture(approval),
    });
    const before = [...f.rows.entries()],
      archive = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom),
      imported = openBunkBitcoinJournalArchive(JSON.parse(JSON.stringify(archive)), f.seed);
    expect([...f.rows.entries()]).toEqual(before);
    expect(imported).toMatchObject({
      key: f.key,
      revision: (await f.read()).revision,
      scope,
      historyComplete: false,
      signingAuthorized: false,
    });
    expect(await readBunkBitcoinJournal(imported.store, imported.key, f.seed)).toEqual(
      await f.read(),
    );
    expect(
      await readBunkBitcoinApproval(imported.store, imported.key, f.seed, approval.id),
    ).toEqual(signed);
    for (const plaintext of [
      'allocations',
      'approvals',
      request.spend.payments[0]?.address,
      signed.signed?.rawTransaction,
    ]) {
      if (!plaintext) throw new Error('Missing fixture');
      expect(JSON.stringify(archive)).not.toContain(plaintext);
    }
    expect(() => openBunkBitcoinJournalArchive(archive, new Uint8Array(64).fill(99))).toThrow();
    imported.store.destroy();
    f.store.destroy();
  });

  it('retains approved and uncertain phases without allowing claims, cancellations or allocations', async () => {
    for (const phase of ['approved', 'claimed']) {
      const f = await fixture(),
        approval = await f.reserve(await f.prepare());
      if (phase === 'claimed') await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
      const imported = openBunkBitcoinJournalArchive(
        await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom),
        f.seed,
      );
      expect(
        (await readBunkBitcoinApproval(imported.store, f.key, f.seed, approval.id)).phase,
      ).toBe(phase);
      await expect(
        claimBunkBitcoinApproval(imported.store, f.key, f.seed, approval),
      ).rejects.toBeInstanceOf(
        phase === 'claimed' ? BunkSigningUncertain : BunkBitcoinArchiveReadOnly,
      );
      await expect(
        allocateBunkBitcoinAddress(imported.store, f.key, f.seed, {
          id: id(99),
          expectedNextOwnerIndex: 3,
          purpose: 'receive',
        }),
      ).rejects.toBeInstanceOf(BunkBitcoinArchiveReadOnly);
      await expect(
        cancelBunkBitcoinApproval(imported.store, f.key, f.seed, approval),
      ).rejects.toThrow();
      if (phase === 'claimed')
        await expect(
          persistBunkBitcoinSignatures(imported.store, f.key, f.seed, {
            ...approval,
            signatures: f.signFixture(approval),
          }),
        ).rejects.toBeInstanceOf(BunkBitcoinArchiveReadOnly);
      imported.store.destroy();
      f.store.destroy();
    }
  });

  it('keeps an older valid snapshot read-only while later live approvals remain intact', async () => {
    const f = await fixture(),
      approval = await f.reserve(await f.prepare()),
      old = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom);
    await claimBunkBitcoinApproval(f.store, f.key, f.seed, approval);
    const signed = await persistBunkBitcoinSignatures(f.store, f.key, f.seed, {
      ...approval,
      signatures: f.signFixture(approval),
    });
    const before = [...f.rows.entries()],
      imported = openBunkBitcoinJournalArchive(old, f.seed);
    expect((await readBunkBitcoinApproval(imported.store, f.key, f.seed, approval.id)).phase).toBe(
      'approved',
    );
    await expect(
      claimBunkBitcoinApproval(imported.store, f.key, f.seed, approval),
    ).rejects.toBeInstanceOf(BunkBitcoinArchiveReadOnly);
    expect(await readBunkBitcoinApproval(f.store, f.key, f.seed, approval.id)).toEqual(signed);
    expect([...f.rows.entries()]).toEqual(before);
    expect(imported.historyComplete).toBe(false);
    imported.store.destroy();
    f.store.destroy();
  });

  it('authenticates ciphertext, account identity and revision and rejects unsupported envelopes', async () => {
    const f = await fixture(),
      archive = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom),
      changed = base64.decode(archive.data);
    changed[24] = (changed[24] as number) ^ 1;
    for (const bad of [
      null,
      { ...archive, format: 'other' },
      { ...archive, version: 2 },
      { ...archive, extra: true },
      { ...archive, key: `bunk-bitcoin-account:${id(99)}` },
      { ...archive, revision: archive.revision + 1 },
      { ...archive, revision: -1 },
      { ...archive, data: base64.encode(changed) },
      { ...archive, data: '' },
      { ...archive, data: `${archive.data}\n` },
      { ...archive, data: 'A'.repeat(12_000_000) },
    ])
      expect(() => openBunkBitcoinJournalArchive(bad, f.seed)).toThrow();
    f.store.destroy();
  });

  it('cannot relabel local encrypted rows as archives or archives as local rows', async () => {
    const f = await fixture(),
      archive = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom),
      row = f.rows.get(f.key);
    if (!row) throw new Error('Missing row');
    expect(() => openBunkBitcoinJournalArchive({ ...archive, data: row.value }, f.seed)).toThrow();
    f.rows.set(f.key, { revision: archive.revision, value: archive.data });
    await expect(f.read()).rejects.toThrow();
    f.rows.set(f.key, row);
    expect((await f.read()).nextOwnerIndex).toBe(0);
    f.store.destroy();
  });

  it('snapshots the seed, exports fresh nonces and rejects missing or malformed source history', async () => {
    const f = await fixture(),
      originalSeed = f.seed.slice(),
      pending = exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom);
    f.seed.fill(0);
    const archive = await pending,
      imported = openBunkBitcoinJournalArchive(archive, originalSeed),
      another = await exportBunkBitcoinJournalArchive(f.store, f.key, originalSeed, archiveRandom);
    expect(archive.data).not.toBe(another.data);
    expect((await readBunkBitcoinJournal(imported.store, f.key, originalSeed)).nextOwnerIndex).toBe(
      0,
    );
    await expect(
      exportBunkBitcoinJournalArchive(f.store, f.key, originalSeed, () => new Uint8Array(23)),
    ).rejects.toThrow('nonce');
    const invalid: BunkJournalStore = {
      read: async () => ({ revision: 0, value: '{}' }),
      compareAndSwap: async () => false,
    };
    await expect(
      exportBunkBitcoinJournalArchive(invalid, f.key, originalSeed, archiveRandom),
    ).rejects.toThrow();
    f.rows.clear();
    await expect(
      exportBunkBitcoinJournalArchive(f.store, f.key, originalSeed, archiveRandom),
    ).rejects.toThrow('history is missing');
    imported.store.destroy();
    f.store.destroy();
  });

  it('returns detached snapshots and closes the imported store on vault lock', async () => {
    const f = await fixture(),
      archive = await exportBunkBitcoinJournalArchive(f.store, f.key, f.seed, archiveRandom),
      imported = openBunkBitcoinJournalArchive(archive, f.seed),
      row = await imported.store.read(f.key);
    if (!row) throw new Error('Missing imported row');
    row.value = '{}';
    row.revision = 99;
    archive.data = '';
    expect((await readBunkBitcoinJournal(imported.store, f.key, f.seed)).nextOwnerIndex).toBe(0);
    expect(await imported.store.read(`bunk-bitcoin-account:${id(99)}`)).toBeNull();
    await expect(imported.store.compareAndSwap(f.key, 0, '{}')).rejects.toBeInstanceOf(
      BunkBitcoinArchiveReadOnly,
    );
    imported.store.destroy();
    imported.store.destroy();
    await expect(imported.store.read(f.key)).rejects.toThrow('closed');
    f.store.destroy();
  });
});
