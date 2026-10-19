import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { keccak256 } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bunkEvmV2RecoveryCalls, bunkEvmV2RecoveryFee } from '../src/bunk-evm-v2';
import {
  BUNK_JOURNAL_MAX_BYTES,
  BunkJournalConflict,
  BunkSigningUncertain,
  bunkV2JournalKey,
  decodeBunkV2Journal,
  encodeBunkV2Journal,
  readSignedBunkV2Envelope,
  reconstructBunkV2Envelope,
  reconstructBunkV2Intent,
  reserveBunkV2Envelope,
  reserveBunkV2Intent,
  signReservedBunkV2Envelope,
  signReservedBunkV2Intent,
} from '../src/bunk-evm-v2-journal';
import * as signing from '../src/bunk-evm-v2-sign';
import { createBunkJournalSqliteStore, encryptedBunkJournalStore } from '../src/bunk-evm-v2-store';
import fixture from '../src/fixtures/bunk-evm-v2.json';
import { mnemonicToSeed } from '../src/index';

const vector = fixture.vectors[1];
if (!vector) throw new Error('Missing journal test vector');
const v = vector;
const config = { ...fixture.config, protocolVersion: 2, chainId: v.chainId };
const state = {
  protocolVersion: 2,
  deployed: true,
  account: v.account,
  accountIndex: v.accountIndex,
  ownerIndex: v.ownerIndex,
  commitment: v.owner.commitment,
  nonce: BigInt(v.ownerIndex),
};
const request = {
  config,
  state,
  callData: v.callData,
  verificationGasLimit: 500000n,
  callGasLimit: 500000n,
  preVerificationGas: 100000n,
  maximumGasCost: BigInt(v.certificate.maxGasCost),
  paymaster: v.certificate.paymaster,
  validAfter: 1000,
  executeUntil: 2000,
};
const operation = {
  ...v.operation,
  nonce: BigInt(v.operation.nonce),
  verificationGasLimit: 500000n,
  callGasLimit: 500000n,
  preVerificationGas: 100000n,
  maxPriorityFeePerGas: 1000000000n,
  maxFeePerGas: 2000000000n,
};
const observation = { hash: keccak256('0x99'), number: 100n, timestamp: 1000n };
let seed;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
const dirs = [],
  connections = [],
  cleanups = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((fn) => {
    fn();
  });
  connections.splice(0).forEach((db) => {
    db.close();
  });
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});
async function database(file) {
  const dir = file ? null : mkdtempSync(join(tmpdir(), 'honey-bunk-journal-'));
  if (dir) dirs.push(dir);
  const path = file ?? join(dir, 'journal.db');
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
  return { raw, db, path };
}
async function setup(signed = false) {
  const { raw, db, path } = await database();
  const vaultKey = randomBytes(32),
    store = encryptedBunkJournalStore(raw, vaultKey, randomBytes);
  cleanups.push(() => store.destroy());
  const key = await reserveBunkV2Intent(store, seed, structuredClone(request), observation);
  if (signed) await signReservedBunkV2Intent(store, seed, key);
  return { raw, db, path, vaultKey, store, key };
}
const envelope = (attempt = 0) => ({
  operation: { ...operation },
  attempt,
  deployed: true,
  purpose: 'action',
  now: 1100,
});
async function record(store, key) {
  const snapshot = await store.read(key);
  if (!snapshot) throw new Error('Missing stored record');
  return { snapshot, value: decodeBunkV2Journal(snapshot.value) };
}
describe('durable v2 signing journal', { timeout: 20000 }, () => {
  it('reserves before signing, persists signatures, and reconstructs exact bytes after reopening SQLite', async () => {
    const f = await setup();
    const ownerSpy = vi.spyOn(signing, 'signBunkEvmV2Intent'),
      leafSpy = vi.spyOn(signing, 'signBunkEvmV2Envelope');
    const before = await record(f.store, f.key);
    expect(before.snapshot.revision).toBe(0);
    expect(before.value.owner.phase).toBe('reserved');
    await signReservedBunkV2Intent(f.store, seed, f.key);
    await signReservedBunkV2Intent(f.store, seed, f.key);
    expect(ownerSpy).toHaveBeenCalledTimes(1);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope(254));
    const signed = await signReservedBunkV2Envelope(f.store, seed, f.key, 254, 1100);
    expect(signed.operation.signature).toBe(v.authorization);
    expect(leafSpy).toHaveBeenCalledTimes(1);
    const reopened = await database(f.path),
      second = encryptedBunkJournalStore(reopened.raw, f.vaultKey, randomBytes);
    cleanups.push(() => second.destroy());
    expect(await readSignedBunkV2Envelope(second, f.key, 254)).toEqual(signed);
    expect(await signReservedBunkV2Envelope(second, seed, f.key, 254, 1100)).toEqual(signed);
    expect(leafSpy).toHaveBeenCalledTimes(1);
    const raw = await f.raw.read(f.key);
    expect(raw?.value).not.toContain('certificate');
    expect(raw?.value).not.toContain(v.ownerSignature);
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(f.path).includes(Buffer.from(v.ownerSignature))).toBe(false);
    expect(f.db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
  });
  it('allows only one owner approval across racing SQLite connections/configurations', async () => {
    const first = await database(),
      second = await database(first.path),
      vaultKey = randomBytes(32);
    const a = encryptedBunkJournalStore(first.raw, vaultKey, randomBytes),
      b = encryptedBunkJournalStore(second.raw, vaultKey, randomBytes);
    cleanups.push(
      () => a.destroy(),
      () => b.destroy(),
    );
    const results = await Promise.allSettled([
      reserveBunkV2Intent(a, seed, request, observation),
      reserveBunkV2Intent(
        b,
        seed,
        { ...request, maximumGasCost: request.maximumGasCost + 100n },
        observation,
      ),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(
      first.db.prepare('SELECT count(*) AS count FROM honey_bunk_journal_v1').get(),
    ).toMatchObject({ count: 1 });
    const otherConfig = {
      ...config,
      factory: { ...config.factory, address: '0x9999999999999999999999999999999999999999' },
    };
    const deployment = signing.signBunkEvmV2Deployment(seed, otherConfig, state.accountIndex);
    await expect(
      reserveBunkV2Intent(
        a,
        seed,
        { ...request, config: otherConfig, state: { ...state, account: deployment.account } },
        observation,
      ),
    ).rejects.toBeInstanceOf(BunkJournalConflict);
  });
  it('allows only one signing claimant and one reservation for a leaf', async () => {
    const f = await setup();
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    const results = await Promise.allSettled([
      signReservedBunkV2Intent(f.store, seed, f.key),
      signReservedBunkV2Intent(f.store, seed, f.key),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const leaves = await Promise.allSettled([
      reserveBunkV2Envelope(f.store, seed, f.key, envelope()),
      reserveBunkV2Envelope(f.store, seed, f.key, {
        ...envelope(),
        operation: { ...operation, maxFeePerGas: 3000000000n },
      }),
    ]);
    expect(leaves.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await expect(reserveBunkV2Envelope(f.store, seed, f.key, envelope())).rejects.toBeInstanceOf(
      BunkJournalConflict,
    );
  });
  it('does not sign when persistence of the initial owner claim fails', async () => {
    const f = await setup();
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    const broken = {
      read: (key) => f.store.read(key),
      compareAndSwap: async () => {
        throw new Error('disk full');
      },
    };
    await expect(signReservedBunkV2Intent(broken, seed, f.key)).rejects.toThrow('disk full');
    expect(spy).not.toHaveBeenCalled();
    expect((await record(f.store, f.key)).value.owner.phase).toBe('reserved');
  });
  it('retains an uncertain owner claim if signature persistence fails, without returning the signature', async () => {
    const f = await setup();
    let writes = 0;
    const broken = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (...args) => {
        if (++writes === 2) throw new Error('disk full');
        return f.store.compareAndSwap(...args);
      },
    };
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    await expect(signReservedBunkV2Intent(broken, seed, f.key)).rejects.toThrow('disk full');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await record(f.store, f.key)).value.owner.phase).toBe('signing');
    await expect(signReservedBunkV2Intent(f.store, seed, f.key)).rejects.toBeInstanceOf(
      BunkSigningUncertain,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('retains an uncertain envelope after a failed signature write and refuses to reuse that leaf', async () => {
    const f = await setup(true);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope());
    let writes = 0;
    const broken = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (...args) => {
        if (++writes === 2) throw new Error('disk full');
        return f.store.compareAndSwap(...args);
      },
    };
    const spy = vi.spyOn(signing, 'signBunkEvmV2Envelope');
    await expect(signReservedBunkV2Envelope(broken, seed, f.key, 0, 1100)).rejects.toThrow(
      'disk full',
    );
    await expect(signReservedBunkV2Envelope(f.store, seed, f.key, 0, 1100)).rejects.toBeInstanceOf(
      BunkSigningUncertain,
    );
    await expect(readSignedBunkV2Envelope(f.store, f.key, 0)).rejects.toThrow('not durably');
    expect(spy).toHaveBeenCalledTimes(1);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope(1));
    expect(
      (await signReservedBunkV2Envelope(f.store, seed, f.key, 1, 1100)).operation.signature,
    ).toBeTruthy();
  });
  it('merges a completed signature without overwriting a concurrently reserved different leaf', async () => {
    const f = await setup(true);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope());
    let injected = false;
    const interleaved = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (key, revision, value) => {
        const result = await f.store.compareAndSwap(key, revision, value);
        if (result && !injected && decodeBunkV2Journal(value).envelopes[0]?.phase === 'signing') {
          injected = true;
          await reserveBunkV2Envelope(f.store, seed, f.key, envelope(1));
        }
        return result;
      },
    };
    const signed = await signReservedBunkV2Envelope(interleaved, seed, f.key, 0, 1100);
    expect(await readSignedBunkV2Envelope(f.store, f.key, 0)).toEqual(signed);
    expect((await record(f.store, f.key)).value.envelopes.map((e) => [e.attempt, e.phase])).toEqual(
      [
        [0, 'signed'],
        [1, 'reserved'],
      ],
    );
  });
  it('never signs a changed/foreign operation and retains expired reservations', async () => {
    const f = await setup(true);
    const spy = vi.spyOn(signing, 'signBunkEvmV2Envelope');
    await expect(
      reserveBunkV2Envelope(f.store, seed, f.key, {
        ...envelope(),
        operation: { ...operation, nonce: operation.nonce + 1n },
      }),
    ).rejects.toThrow();
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope());
    await expect(signReservedBunkV2Envelope(f.store, seed, f.key, 0, 2001)).rejects.toThrow('time');
    expect(spy).not.toHaveBeenCalled();
    expect((await record(f.store, f.key)).value.envelopes[0]?.phase).toBe('reserved');
    await expect(
      reserveBunkV2Envelope(f.store, seed, f.key, { ...envelope(), now: 2001, purpose: 'cleanup' }),
    ).rejects.toBeInstanceOf(BunkJournalConflict);
    const c = (await record(f.store, f.key)).value.certificate,
      fee = bunkEvmV2RecoveryFee(c);
    await reserveBunkV2Envelope(f.store, seed, f.key, {
      ...envelope(255),
      purpose: 'cleanup',
      now: 2001,
      operation: {
        ...operation,
        callData: bunkEvmV2RecoveryCalls(),
        maxFeePerGas: fee,
        maxPriorityFeePerGas: fee,
      },
    });
    expect(
      (await signReservedBunkV2Envelope(f.store, seed, f.key, 255, 2001)).operation.signature,
    ).toBeTruthy();
  });
  it('checks seed before claiming a reserved owner or leaf', async () => {
    const f = await setup();
    const wrong = new Uint8Array(64).fill(1);
    await expect(signReservedBunkV2Intent(f.store, wrong, f.key)).rejects.toThrow();
    expect((await record(f.store, f.key)).value.owner.phase).toBe('reserved');
    await signReservedBunkV2Intent(f.store, seed, f.key);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope());
    await expect(signReservedBunkV2Envelope(f.store, wrong, f.key, 0, 1100)).rejects.toThrow();
    expect((await record(f.store, f.key)).value.envelopes[0]?.phase).toBe('reserved');
  });
});
// Fail the signature save after its durable claim, without leaking returned bytes.
function failSignatureWrite(store) {
  let writes = 0;
  return {
    read: (key) => store.read(key),
    compareAndSwap: (...args) => {
      if (++writes === 2) throw new Error('signature persistence lost');
      return store.compareAndSwap(...args);
    },
  };
}
describe('explicit deterministic reconstruction', { timeout: 20000 }, () => {
  it('reconstructs the identical owner signature after a failed write and caches it', async () => {
    const f = await setup();
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    await expect(
      signReservedBunkV2Intent(failSignatureWrite(f.store), seed, f.key),
    ).rejects.toThrow('persistence lost');
    const original = spy.mock.results[0].value.intent;
    expect(original.ownerSignature).toBe(v.ownerSignature);
    await expect(signReservedBunkV2Intent(f.store, seed, f.key)).rejects.toBeInstanceOf(
      BunkSigningUncertain,
    );
    const recovered = await reconstructBunkV2Intent(f.store, seed, f.key, v.intentDigest);
    expect(recovered).toEqual(original);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await reconstructBunkV2Intent(f.store, seed, f.key, v.intentDigest)).toEqual(original);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await record(f.store, f.key)).value.owner.signature).toBe(original.ownerSignature);
    await expect(
      reserveBunkV2Intent(f.store, seed, { ...request, executeUntil: 2100 }, observation),
    ).rejects.toBeInstanceOf(BunkJournalConflict);
  });
  it('refuses unclaimed slots, wrong approval digests and wrong seeds before any signing/write', async () => {
    const f = await setup();
    await expect(reconstructBunkV2Intent(f.store, seed, f.key, v.intentDigest)).rejects.toThrow(
      'not claimed',
    );
    await expect(
      signReservedBunkV2Intent(failSignatureWrite(f.store), seed, f.key),
    ).rejects.toThrow();
    const snapshot = await f.store.read(f.key);
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    await expect(reconstructBunkV2Intent(f.store, seed, f.key, keccak256('0x98'))).rejects.toThrow(
      'digest',
    );
    await expect(
      reconstructBunkV2Intent(f.store, new Uint8Array(64).fill(1), f.key, v.intentDigest),
    ).rejects.toThrow();
    expect(await f.store.read(f.key)).toEqual(snapshot);
    expect(spy).not.toHaveBeenCalled();
  });
  it('preserves uncertainty if recovery storage fails before or after recomputation', async () => {
    const f = await setup();
    await expect(
      signReservedBunkV2Intent(failSignatureWrite(f.store), seed, f.key),
    ).rejects.toThrow();
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    const noWrite = { read: (key) => f.store.read(key), compareAndSwap: async () => false };
    await expect(
      reconstructBunkV2Intent(noWrite, seed, f.key, v.intentDigest),
    ).rejects.toBeInstanceOf(BunkJournalConflict);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      reconstructBunkV2Intent(failSignatureWrite(f.store), seed, f.key, v.intentDigest),
    ).rejects.toThrow('persistence lost');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await record(f.store, f.key)).value.owner.phase).toBe('signing');
    expect(
      (await reconstructBunkV2Intent(f.store, seed, f.key, v.intentDigest)).ownerSignature,
    ).toBe(v.ownerSignature);
  });
  it('accepts only the identical durable owner bytes when another recovery wins persistence', async () => {
    const f = await setup();
    await expect(
      signReservedBunkV2Intent(failSignatureWrite(f.store), seed, f.key),
    ).rejects.toThrow();
    const spy = vi.spyOn(signing, 'signBunkEvmV2Intent');
    let nested;
    const overlapping = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (...args) => {
        const won = await f.store.compareAndSwap(...args);
        if (won && !nested)
          nested = await reconstructBunkV2Intent(f.store, seed, f.key, v.intentDigest);
        return won;
      },
    };
    expect(await reconstructBunkV2Intent(overlapping, seed, f.key, v.intentDigest)).toEqual(nested);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.results.map((x) => x.value.intent.ownerSignature)).toEqual([
      v.ownerSignature,
      v.ownerSignature,
    ]);
  });
  it('reconstructs exact envelope bytes without releasing the leaf or overwriting another reservation', async () => {
    const f = await setup(true);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope(254));
    await expect(
      reconstructBunkV2Envelope(f.store, seed, f.key, 254, v.userOpHash, 1100),
    ).rejects.toThrow('not claimed');
    const spy = vi.spyOn(signing, 'signBunkEvmV2Envelope');
    await expect(
      signReservedBunkV2Envelope(failSignatureWrite(f.store), seed, f.key, 254, 1100),
    ).rejects.toThrow();
    const snapshot = await f.store.read(f.key);
    await expect(
      reconstructBunkV2Envelope(f.store, seed, f.key, 254, keccak256('0x98'), 1100),
    ).rejects.toThrow('hash');
    await expect(
      reconstructBunkV2Envelope(
        f.store,
        new Uint8Array(64).fill(1),
        f.key,
        254,
        v.userOpHash,
        1100,
      ),
    ).rejects.toThrow();
    await expect(
      reconstructBunkV2Envelope(f.store, seed, f.key, 254, v.userOpHash, 2001),
    ).rejects.toThrow('time');
    expect(await f.store.read(f.key)).toEqual(snapshot);
    expect(spy).toHaveBeenCalledTimes(1);
    let injected = false;
    const overlapping = {
      read: (key) => f.store.read(key),
      compareAndSwap: async (...args) => {
        const won = await f.store.compareAndSwap(...args);
        if (won && !injected) {
          injected = true;
          await reserveBunkV2Envelope(f.store, seed, f.key, envelope(1));
        }
        return won;
      },
    };
    const result = await reconstructBunkV2Envelope(
      overlapping,
      seed,
      f.key,
      254,
      v.userOpHash,
      1100,
    );
    expect(result.operation.signature).toBe(v.authorization);
    expect(spy.mock.results.map((x) => x.value.operation.signature)).toEqual([
      v.authorization,
      v.authorization,
    ]);
    expect(await reconstructBunkV2Envelope(f.store, seed, f.key, 254, v.userOpHash, 1100)).toEqual(
      result,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await record(f.store, f.key)).value.envelopes.map((x) => [x.attempt, x.phase])).toEqual(
      [
        [254, 'signed'],
        [1, 'reserved'],
      ],
    );
    await expect(
      reserveBunkV2Envelope(f.store, seed, f.key, {
        ...envelope(254),
        operation: { ...operation, maxFeePerGas: 3000000000n },
      }),
    ).rejects.toBeInstanceOf(BunkJournalConflict);
  });
  it('recovers the fixed cleanup leaf after repeated storage failure without changing its operation', async () => {
    const f = await setup(true);
    const c = (await record(f.store, f.key)).value.certificate;
    const fee = bunkEvmV2RecoveryFee(c);
    await reserveBunkV2Envelope(f.store, seed, f.key, {
      ...envelope(255),
      purpose: 'cleanup',
      now: 2001,
      operation: {
        ...operation,
        callData: bunkEvmV2RecoveryCalls(),
        maxFeePerGas: fee,
        maxPriorityFeePerGas: fee,
      },
    });
    const hash = (await record(f.store, f.key)).value.envelopes[0].userOpHash;
    const spy = vi.spyOn(signing, 'signBunkEvmV2Envelope');
    await expect(
      signReservedBunkV2Envelope(failSignatureWrite(f.store), seed, f.key, 255, 2001),
    ).rejects.toThrow();
    await expect(reconstructBunkV2Envelope(f.store, seed, f.key, 255, hash, 2000)).rejects.toThrow(
      'time',
    );
    await expect(
      reconstructBunkV2Envelope(failSignatureWrite(f.store), seed, f.key, 255, hash, 2001),
    ).rejects.toThrow('persistence lost');
    await expect(readSignedBunkV2Envelope(f.store, f.key, 255)).rejects.toThrow('not durably');
    const result = await reconstructBunkV2Envelope(f.store, seed, f.key, 255, hash, 3000);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const signed of spy.mock.results) expect(signed.value.operation).toEqual(result.operation);
    expect(await readSignedBunkV2Envelope(f.store, f.key, 255)).toEqual(result);
  });
});
describe('journal canonical encoding and encrypted storage', { timeout: 20000 }, () => {
  it('rejects unknown/duplicate fields, noncanonical integers, wrong roots, phase drift and bad signatures', async () => {
    const f = await setup(true),
      original = await record(f.store, f.key),
      text = original.snapshot.value;
    expect(encodeBunkV2Journal(decodeBunkV2Journal(text))).toBe(text);
    const mutations = [
      `${text} `,
      text.replace('"version":1', '"version":1,"version":1'),
      text.replace('"nonce":"3"', '"nonce":"03"'),
      text.replace('"version":1', '"version":1,"unknown":true'),
    ];
    for (const mutation of mutations) expect(() => decodeBunkV2Journal(mutation)).toThrow();
    for (const change of [
      (r) => {
        r.key = bunkV2JournalKey(keccak256('0xaa'));
      },
      (r) => {
        r.envelopeSigners[0] = config.factory.address;
      },
      (r) => {
        r.owner.phase = 'reserved';
      },
      (r) => {
        r.owner.signature = `0x${'11'.repeat(65)}`;
      },
    ]) {
      const r = structuredClone(original.value);
      change(r);
      expect(() => encodeBunkV2Journal(r)).toThrow();
    }
    expect(() => decodeBunkV2Journal(' '.repeat(BUNK_JOURNAL_MAX_BYTES + 1))).toThrow('size');
  });
  it('rejects duplicated leaves and signature/hash substitutions on restore', async () => {
    const f = await setup(true);
    await reserveBunkV2Envelope(f.store, seed, f.key, envelope());
    await signReservedBunkV2Envelope(f.store, seed, f.key, 0, 1100);
    const { value } = await record(f.store, f.key),
      e = value.envelopes[0];
    if (!e) throw new Error('Missing envelope');
    expect(() => encodeBunkV2Journal({ ...value, envelopes: [e, e] })).toThrow('Duplicate');
    expect(() =>
      encodeBunkV2Journal({ ...value, envelopes: [{ ...e, userOpHash: keccak256('0xab') }] }),
    ).toThrow();
    expect(() =>
      encodeBunkV2Journal({ ...value, envelopes: [{ ...e, signature: value.owner.signature }] }),
    ).toThrow();
  });
  it('authenticates owner key and revision, rejects wrong vault keys, and stops after lock', async () => {
    const f = await setup(),
      row = await f.raw.read(f.key);
    if (!row) throw new Error('Missing raw record');
    const wrong = encryptedBunkJournalStore(f.raw, randomBytes(32), randomBytes);
    cleanups.push(() => wrong.destroy());
    await expect(wrong.read(f.key)).rejects.toThrow();
    const renamed = bunkV2JournalKey(keccak256('0x22'));
    await f.raw.compareAndSwap(renamed, null, row.value);
    await expect(f.store.read(renamed)).rejects.toThrow();
    await f.raw.compareAndSwap(f.key, 0, row.value);
    await expect(f.store.read(f.key)).rejects.toThrow();
    f.store.destroy();
    await expect(f.store.read(f.key)).rejects.toThrow('locked');
    await expect(f.store.compareAndSwap(f.key, 1, '{}')).rejects.toThrow('locked');
  });
  it('permits one compare-and-swap winner across separate Node processes', async () => {
    const f = await database(),
      key = bunkV2JournalKey(keccak256('0x44'));
    await f.raw.compareAndSwap(key, null, 'initial');
    const worker = fileURLToPath(new URL('./fixtures/bunk-journal-worker.mjs', import.meta.url));
    const loader = fileURLToPath(
      new URL('../../../packages/bunk-evm/test/bundler/typescript-loader.mjs', import.meta.url),
    );
    const barrier = `${f.path}.go`,
      ready = [`${f.path}.ready-a`, `${f.path}.ready-b`];
    const run = promisify(execFile);
    const jobs = ready.map((path, i) =>
      run(
        process.execPath,
        ['--import', loader, worker, f.path, key, `writer-${i}`, path, barrier],
        { timeout: 25000 },
      ),
    );
    // Attach handlers immediately while both processes read the same revision.
    const completed = Promise.allSettled(jobs);
    for (let i = 0; !ready.every((path) => existsSync(path)); i++) {
      if (i === 1500) throw new Error('Worker readiness timeout');
      await delay(10);
    }
    writeFileSync(barrier, 'go');
    const results = await completed;
    const values = results.map((r) => {
      if (r.status !== 'fulfilled') throw r.reason;
      return JSON.parse(r.value.stdout);
    });
    expect(values.map((x) => x.observedRevision)).toEqual([0, 0]);
    expect(values.filter((x) => x.won)).toHaveLength(1);
    expect((await f.raw.read(key)).revision).toBe(1);
  });
  it('rejects stale SQLite revisions and does not let old snapshots overwrite newer entries', async () => {
    const f = await database(),
      key = bunkV2JournalKey(keccak256('0x33'));
    expect(await f.raw.compareAndSwap(key, null, 'initial')).toBe(true);
    expect(await f.raw.compareAndSwap(key, null, 'replacement')).toBe(false);
    expect(await f.raw.compareAndSwap(key, 0, 'next')).toBe(true);
    expect(await f.raw.compareAndSwap(key, 0, 'old backup')).toBe(false);
    expect(await f.raw.read(key)).toEqual({ revision: 1, value: 'next' });
    await expect(f.raw.compareAndSwap(key, -1, 'bad')).rejects.toThrow();
  });
});
