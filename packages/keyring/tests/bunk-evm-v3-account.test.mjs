import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { keccak256, toHex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as observer from '../src/bunk-evm-observe';
import { createBunkJournalSqliteStore, encryptedBunkJournalStore } from '../src/bunk-evm-v2-store';
import { bunkEvmV3KeyScope } from '../src/bunk-evm-v3';
import {
  BunkV3RestoreRequired,
  bunkV3AccountKey,
  decodeBunkV3Account,
  encodeBunkV3Account,
  readBunkV3Attempt,
  readBunkV3Bootstrap,
  reconstructBunkV3Approval,
  reconstructBunkV3Attempt,
  reconstructBunkV3Restore,
  refreshBunkV3Account,
  reserveBunkV3Approval,
  reserveBunkV3Attempt,
  signBunkV3Approval,
  signBunkV3Attempt,
  signBunkV3Restore,
  startBunkV3Restore,
} from '../src/bunk-evm-v3-account';
import { decodeBunkV3Journal } from '../src/bunk-evm-v3-journal';
import * as signing from '../src/bunk-evm-v3-sign';
import fixture from '../src/fixtures/bunk-evm-v3.json';
import { mnemonicToSeed } from '../src/index';

const v = fixture.vectors[2];
const config = { ...fixture.config, protocolVersion: 3, chainId: v.chainId };
const input = { config, accountIndex: v.accountIndex, proxyRuntimeCodeHash: keccak256('0x6000') };
const original = {
  protocolVersion: 3,
  deployed: true,
  account: v.account,
  accountIndex: v.accountIndex,
  ownerIndex: v.ownerIndex,
  commitment: v.owner.commitment,
  nonce: BigInt(v.nonce),
  epoch: v.epoch,
  recoveryCommitment: v.recoveryKey.commitment,
};
const approval = {
  callData: v.callData,
  verificationGasLimit: 500000n,
  callGasLimit: 500000n,
  preVerificationGas: 100000n,
  maximumGasCost: 11000000000000000n,
  paymaster: v.certificate.paymaster,
  validAfter: 1000,
  executeUntil: 2000,
};
let seed, latest;
const anchors = new Map(),
  dirs = [],
  connections = [],
  vaults = [];
const access = {
  now: () => 1100,
  maxFinalizedAgeSeconds: 200,
  rpc: async (r) => ({ hash: anchors.get(BigInt(r.params[0])) }),
};
function chain(state, number = 100n) {
  const block = { hash: keccak256(toHex(number)), number, timestamp: 1000n + number - 100n };
  anchors.set(number, block.hash);
  latest = {
    protocolVersion: 3,
    config,
    account: v.account,
    accountIndex: v.accountIndex,
    block,
    ...(state ? { status: 'deployed', state } : { status: 'undeployed' }),
  };
}
function ref(epoch, ownerIndex = 0) {
  return {
    chainId: config.chainId,
    keyScope: bunkEvmV3KeyScope(config),
    accountIndex: v.accountIndex,
    epoch,
    ownerIndex,
  };
}
function state(epoch, ownerIndex, nonce) {
  return {
    ...original,
    epoch,
    ownerIndex,
    nonce,
    commitment: signing.deriveBunkEvmV3Owner(seed, ref(epoch, ownerIndex)).commitment,
    recoveryCommitment: signing.deriveBunkEvmV3Recovery(seed, ref(epoch)).commitment,
  };
}
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
beforeEach(() => {
  anchors.clear();
  chain(original);
  vi.spyOn(observer, 'observeBunkEvmV3Account').mockImplementation(async () =>
    structuredClone(latest),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const vault of vaults.splice(0)) vault.destroy();
  for (const db of connections.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function database(path, vaultKey = randomBytes(32)) {
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), 'honey-bunk-v3-'));
    dirs.push(dir);
    path = join(dir, 'journal.db');
  }
  const db = new DatabaseSync(path);
  connections.push(db);
  const raw = await createBunkJournalSqliteStore({
    async execAsync(sql) {
      db.exec(sql);
    },
    async getFirstAsync(sql, ...params) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async runAsync(sql, ...params) {
      return { changes: Number(db.prepare(sql).run(...params).changes) };
    },
  });
  const store = encryptedBunkJournalStore(raw, vaultKey, randomBytes);
  vaults.push(store);
  return { db, raw, store, path, vaultKey };
}
async function read(f) {
  const row = await f.store.read(f.key);
  return { row, record: decodeBunkV3Account(row.value) };
}
async function setup(ready = false) {
  const f = await database();
  const restore = await startBunkV3Restore(f.store, seed, input, access);
  f.key = restore.key;
  f.restoreDigest = restore.digest;
  if (ready) {
    await signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access);
    chain(state(5, 0, 31n), 101n);
    await refreshBunkV3Account(f.store, f.key, access);
  }
  return f;
}
async function reserve(f) {
  f.ownerKey = await reserveBunkV3Approval(f.store, seed, f.key, approval, access);
  return f.ownerKey;
}
function attempt(nonce = 31n, attempt = 0) {
  return {
    operation: {
      sender: v.account,
      nonce,
      initCode: '0x',
      callData: v.callData,
      verificationGasLimit: 500000n,
      callGasLimit: 500000n,
      preVerificationGas: 100000n,
      maxPriorityFeePerGas: 1000000000n,
      maxFeePerGas: 2000000000n,
      paymasterAndData: '0x',
    },
    attempt,
    purpose: 'action',
  };
}
function failPhase(store, which) {
  return {
    read: (key) => store.read(key),
    compareAndSwap: async (key, revision, value) => {
      const r = decodeBunkV3Account(value);
      const j = r.journal ? decodeBunkV3Journal(r.journal) : null;
      if (
        which === 'recovery'
          ? r.restore?.phase === 'signed'
          : which === 'owner'
            ? j?.owner.phase === 'signed'
            : j?.envelopes.some((e) => e.phase === 'signed')
      )
        throw new Error('Injected signature persistence failure');
      return store.compareAndSwap(key, revision, value);
    },
  };
}

describe('v3 account recovery and atomic signing journal', { timeout: 20000 }, () => {
  it('requires recovery for absent history, confirms exact finalized reset, and persists ordinary signatures across SQLite reopen', async () => {
    const f = await database();
    f.key = bunkV3AccountKey(config, v.account);
    const ownerSpy = vi.spyOn(signing, 'signBunkEvmV3Intent'),
      leafSpy = vi.spyOn(signing, 'signBunkEvmV3Envelope');
    await expect(reserve(f)).rejects.toThrow(BunkV3RestoreRequired);
    const restore = await startBunkV3Restore(f.store, seed, input, access);
    f.key = restore.key;
    f.restoreDigest = restore.digest;
    await expect(reserve(f)).rejects.toThrow(BunkV3RestoreRequired);
    const reset = await signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access);
    expect(reset.digest).toBe(v.recoveryDigest);
    expect(reset.transaction.data).toBe(v.recoveryData);
    expect((await refreshBunkV3Account(f.store, f.key, access)).phase).toBe('restoring');
    expect(ownerSpy).not.toHaveBeenCalled();
    expect(leafSpy).not.toHaveBeenCalled();
    chain(state(5, 0, 31n), 101n);
    expect((await refreshBunkV3Account(f.store, f.key, access)).phase).toBe('ready');
    await reserve(f);
    await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
    await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
    await reserveBunkV3Attempt(f.store, seed, f.key, f.ownerKey, attempt(), access);
    const signed = await signBunkV3Attempt(f.store, seed, f.key, f.ownerKey, 0, access);
    const reopened = await database(f.path, f.vaultKey);
    expect(await readBunkV3Attempt(reopened.store, f.key, f.ownerKey, 0)).toEqual(signed);
    expect(await signBunkV3Attempt(reopened.store, seed, f.key, f.ownerKey, 0, access)).toEqual(
      signed,
    );
    expect(ownerSpy).toHaveBeenCalledTimes(1);
    expect(leafSpy).toHaveBeenCalledTimes(1);
    expect((await f.raw.read(f.key)).value).not.toContain('certificate');
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(f.path).includes(Buffer.from(signed.operation.signature))).toBe(false);
  });
  it('does not treat an undeployed account as unused; persists exact bootstrap then requires a generation reset', async () => {
    chain(null);
    const f = await setup();
    const tx = await readBunkV3Bootstrap(f.store, f.key);
    expect(tx.data).toBe(v.factoryData);
    expect(tx.to).toBe(config.factory.address);
    await expect(signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access)).rejects.toThrow(
      'bootstrap',
    );
    await expect(reserve(f)).rejects.toThrow(BunkV3RestoreRequired);
    chain(state(0, 0, 0n), 101n);
    await refreshBunkV3Account(f.store, f.key, access);
    await expect(reserve(f)).rejects.toThrow(BunkV3RestoreRequired);
    await signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access);
    chain(state(1, 0, 0n), 102n);
    expect((await refreshBunkV3Account(f.store, f.key, access)).phase).toBe('ready');
    await reserve(f);
    const signed = await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
    expect(
      signing.recoverBunkEvmV3Signer(
        (await read(f)).record.journal
          ? signing.prepareBunkEvmV3Intent(seed, { ...approval, config, state: state(1, 0, 0n) })
              .digest
          : '',
        signed.ownerSignature,
      ),
    ).toBe(signing.deriveBunkEvmV3Owner(seed, ref(1)).address);
    await expect(readBunkV3Bootstrap(f.store, f.key)).rejects.toThrow('not pending');
  });
  it('keeps a recovery signing tombstone after a failed save and allows only pinned deterministic reconstruction', async () => {
    const f = await setup();
    const spy = vi.spyOn(signing, 'signBunkEvmV3SeedRecovery');
    await expect(
      signBunkV3Restore(failPhase(f.store, 'recovery'), seed, f.key, f.restoreDigest, access),
    ).rejects.toThrow('Injected');
    expect((await read(f)).record.restore.phase).toBe('signing');
    await startBunkV3Restore(f.store, seed, input, access);
    await expect(signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access)).rejects.toThrow(
      'claimed',
    );
    await expect(
      reconstructBunkV3Restore(f.store, seed, f.key, keccak256('0x1234'), access),
    ).rejects.toThrow('digest');
    expect(spy).toHaveBeenCalledTimes(1);
    const result = await reconstructBunkV3Restore(f.store, seed, f.key, v.recoveryDigest, access);
    expect(result.transaction.data).toBe(v.recoveryData);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access)).toEqual(result);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('recovery signatures remain fixed while ordinary owner and nonce advance', async () => {
    const f = await setup();
    chain(state(4, 4, 32n), 101n);
    const signed = await signBunkV3Restore(f.store, seed, f.key, f.restoreDigest, access);
    expect(signed.transaction.data).toBe(v.recoveryData);
    chain(state(5, 0, 32n), 102n);
    expect((await refreshBunkV3Account(f.store, f.key, access)).state.nonce).toBe(32n);
  });
  it('cannot clear an uncertain owner by reserving a different approval', async () => {
    const f = await setup(true);
    await reserve(f);
    const spy = vi.spyOn(signing, 'signBunkEvmV3Intent');
    await expect(
      signBunkV3Approval(failPhase(f.store, 'owner'), seed, f.key, f.ownerKey, access),
    ).rejects.toThrow('Injected');
    await expect(signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access)).rejects.toThrow(
      'claimed',
    );
    await expect(
      reserveBunkV3Approval(
        f.store,
        seed,
        f.key,
        { ...approval, maximumGasCost: approval.maximumGasCost + 1n },
        access,
      ),
    ).rejects.toThrow('reserved');
    const { record: r } = await read(f),
      j = decodeBunkV3Journal(r.journal),
      digest = signing.prepareBunkEvmV3Intent(seed, { ...approval, config, state: r.state }).digest;
    expect(j.owner.phase).toBe('signing');
    await expect(
      reconstructBunkV3Approval(f.store, seed, f.key, f.ownerKey, keccak256('0x88'), access),
    ).rejects.toThrow('digest');
    await reconstructBunkV3Approval(f.store, seed, f.key, f.ownerKey, digest, access);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('preserves a claimed envelope after storage failure and reconstructs only its exact operation', async () => {
    const f = await setup(true);
    await reserve(f);
    await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
    await reserveBunkV3Attempt(f.store, seed, f.key, f.ownerKey, attempt(), access);
    const spy = vi.spyOn(signing, 'signBunkEvmV3Envelope');
    await expect(
      signBunkV3Attempt(failPhase(f.store, 'leaf'), seed, f.key, f.ownerKey, 0, access),
    ).rejects.toThrow('Injected');
    await expect(signBunkV3Attempt(f.store, seed, f.key, f.ownerKey, 0, access)).rejects.toThrow(
      'claimed',
    );
    await expect(
      reserveBunkV3Attempt(f.store, seed, f.key, f.ownerKey, attempt(), access),
    ).rejects.toThrow('reserved');
    const j = decodeBunkV3Journal((await read(f)).record.journal);
    await expect(
      reconstructBunkV3Attempt(f.store, seed, f.key, f.ownerKey, 0, keccak256('0x88'), access),
    ).rejects.toThrow('hash');
    const restored = await reconstructBunkV3Attempt(
      f.store,
      seed,
      f.key,
      f.ownerKey,
      0,
      j.envelopes[0].userOpHash,
      access,
    );
    expect(await readBunkV3Attempt(f.store, f.key, f.ownerKey, 0)).toEqual(restored);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('allows one approval across two racing encrypted SQLite connections', async () => {
    const f = await setup(true),
      b = await database(f.path, f.vaultKey);
    const results = await Promise.allSettled([
      reserve(f),
      reserveBunkV3Approval(
        b.store,
        seed,
        f.key,
        { ...approval, maximumGasCost: approval.maximumGasCost + 1n },
        access,
      ),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) AS count FROM honey_bunk_journal_v1').get().count).toBe(1);
  });
  for (const role of ['owner', 'leaf'])
    it(`fences an in-flight ${role} signature when restore claims the account`, async () => {
      const f = await setup(true);
      await reserve(f);
      if (role === 'leaf') {
        await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
        await reserveBunkV3Attempt(f.store, seed, f.key, f.ownerKey, attempt(), access);
      }
      let fenced = false;
      const racing = {
        read: (key) => f.store.read(key),
        compareAndSwap: async (key, revision, value) => {
          const r = decodeBunkV3Account(value),
            j = r.journal ? decodeBunkV3Journal(r.journal) : null;
          if (
            !fenced &&
            (role === 'owner'
              ? j?.owner.phase === 'signed'
              : j?.envelopes.some((e) => e.phase === 'signed'))
          ) {
            fenced = true;
            await startBunkV3Restore(f.store, seed, input, access);
          }
          return f.store.compareAndSwap(key, revision, value);
        },
      };
      await expect(
        role === 'owner'
          ? signBunkV3Approval(racing, seed, f.key, f.ownerKey, access)
          : signBunkV3Attempt(racing, seed, f.key, f.ownerKey, 0, access),
      ).rejects.toThrow();
      expect(fenced).toBe(true);
      expect((await read(f)).record.phase).toBe('restoring');
      expect((await read(f)).record.journal).toBeNull();
      await expect(reserve(f)).rejects.toThrow(BunkV3RestoreRequired);
    });
  it('advances the journal only to the exact consumed successor and rejects stale observations', async () => {
    const f = await setup(true);
    await reserve(f);
    await signBunkV3Approval(f.store, seed, f.key, f.ownerKey, access);
    chain(state(5, 1, 32n), 102n);
    expect((await refreshBunkV3Account(f.store, f.key, access)).state.ownerIndex).toBe(1);
    expect((await read(f)).record.journal).toBeNull();
    await reserve(f);
    chain(state(5, 0, 31n), 101n);
    await expect(refreshBunkV3Account(f.store, f.key, access)).rejects.toThrow('backwards');
  });
  it('rejects an unknown advance without silently treating the new owner as unused', async () => {
    const f = await setup(true);
    chain(state(5, 1, 32n), 102n);
    await expect(reserve(f)).rejects.toThrow('outside recorded');
    expect((await read(f)).record.state.ownerIndex).toBe(0);
    await startBunkV3Restore(f.store, seed, input, access);
    expect((await read(f)).record.restore.epoch).toBe(5);
  });
  it('rejects a changed previous finalized anchor even if the new head has a higher number', async () => {
    const f = await setup(true);
    chain(state(5, 0, 31n), 102n);
    anchors.set(101n, keccak256('0xffff'));
    await expect(refreshBunkV3Account(f.store, f.key, access)).rejects.toThrow('anchor changed');
  });
  it('requires exact reset successors, generation, owner zero and nondecreasing nonce', async () => {
    for (const changed of [
      { ...state(5, 0, 31n), commitment: keccak256('0x99') },
      state(5, 1, 32n),
      state(6, 0, 31n),
      state(5, 0, 30n),
    ]) {
      chain(original);
      const f = await setup();
      chain(changed, 101n);
      await expect(refreshBunkV3Account(f.store, f.key, access)).rejects.toThrow();
      expect((await read(f)).record.phase).toBe('restoring');
    }
  });
  it('verifies seed and scope before recovery signing or ordinary signing', async () => {
    const f = await setup();
    const bad = new Uint8Array(64).fill(1);
    const spy = vi.spyOn(signing, 'signBunkEvmV3SeedRecovery');
    await expect(signBunkV3Restore(f.store, bad, f.key, f.restoreDigest, access)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    await expect(startBunkV3Restore(f.store, bad, input, access)).rejects.toThrow();
    expect((await read(f)).record.restore.phase).toBe('reserved');
  });
  it('strictly decodes canonical records, commitments, signatures and nested journal scope', async () => {
    const f = await setup();
    const { row, record: r } = await read(f);
    expect(encodeBunkV3Account(r)).toBe(row.value);
    for (const value of [
      `${row.value} `,
      row.value.replace('"version":1', '"version":1,"version":1'),
      row.value.replace('"version":1', '"version":2'),
    ])
      expect(() => decodeBunkV3Account(value)).toThrow();
    for (const change of [
      { phase: 'ready' },
      { key: bunkV3AccountKey({ ...config, chainId: '1' }, v.account) },
      { restore: { ...r.restore, nextOwner: keccak256('0x12') } },
      {
        bootstrap: {
          owner: v.initial.commitment,
          recovery: v.firstRecovery.commitment,
          signature: `0x${'00'.repeat(65)}`,
        },
      },
    ])
      expect(() => encodeBunkV3Account({ ...r, ...change })).toThrow();
  });
  it('does not expose a signature if the account vault locks during its durable write', async () => {
    const f = await setup();
    let locked = false;
    const store = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (key, revision, value) => {
        const r = decodeBunkV3Account(value);
        const result = await f.store.compareAndSwap(key, revision, value);
        if (r.restore?.phase === 'signed') {
          locked = true;
          throw new Error('Vault locked after commit');
        }
        return result;
      },
    };
    await expect(signBunkV3Restore(store, seed, f.key, f.restoreDigest, access)).rejects.toThrow(
      'locked',
    );
    expect(locked).toBe(true);
    const reopened = await database(f.path, f.vaultKey);
    expect(
      (await signBunkV3Restore(reopened.store, seed, f.key, f.restoreDigest, access)).transaction
        .data,
    ).toBe(v.recoveryData);
  });
  it('pins the reviewed owner across advancement and another approval', async () => {
    const f = await setup(true);
    const oldOwner = await reserve(f);
    await signBunkV3Approval(f.store, seed, f.key, oldOwner, access);
    chain(state(5, 1, 32n), 102n);
    await refreshBunkV3Account(f.store, f.key, access);
    await reserve(f);
    const spy = vi.spyOn(signing, 'signBunkEvmV3Intent');
    await expect(signBunkV3Approval(f.store, seed, f.key, oldOwner, access)).rejects.toThrow(
      'no longer current',
    );
    expect(spy).not.toHaveBeenCalled();
    await expect(readBunkV3Attempt(f.store, f.key, oldOwner, 0)).rejects.toThrow(
      'no longer current',
    );
  });
  it('pins the reviewed recovery digest before using the recovery key', async () => {
    const f = await setup();
    const spy = vi.spyOn(signing, 'signBunkEvmV3SeedRecovery');
    await expect(
      signBunkV3Restore(f.store, seed, f.key, keccak256('0x21'), access),
    ).rejects.toThrow('digest');
    expect(spy).not.toHaveBeenCalled();
    expect((await read(f)).record.restore.phase).toBe('reserved');
  });
  it('snapshots reviewed approval fields before awaiting finalized RPC', async () => {
    const f = await setup(true);
    const request = { ...approval };
    const pending = reserveBunkV3Approval(f.store, seed, f.key, request, access);
    request.maximumGasCost += 1n;
    await pending;
    const j = decodeBunkV3Journal((await read(f)).record.journal);
    expect(j.certificate.maxGasCost).toBe(approval.maximumGasCost);
  });
});
