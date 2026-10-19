// Browser-only public fixtures. This page is served by the isolated acceptance runner.
import { keccak256, size } from 'viem';
import { encryptedBunkJournalStore } from '../../src/bunk-evm-v2-store';
import { bunkV3AccountKey, reserveBunkV3Approval } from '../../src/bunk-evm-v3-account';
import {
  decodeBunkV3Journal,
  readSignedBunkV3Envelope,
  reconstructBunkV3Envelope,
  reconstructBunkV3Intent,
  reserveBunkV3Envelope,
  reserveBunkV3Intent,
  signReservedBunkV3Envelope,
  signReservedBunkV3Intent,
} from '../../src/bunk-evm-v3-journal';
import {
  BUNK_INDEXEDDB_NAME,
  createBunkJournalIndexedDbStore,
} from '../../src/bunk-indexeddb-store';
import { deriveBunkJournalEncryptionKey } from '../../src/bunk-journal-key';
import fixture from '../../src/fixtures/bunk-evm-v3.json';
import { mnemonicToSeed } from '../../src/index';

const stores = new Map();
const v = fixture.vectors[2],
  config = { ...fixture.config, protocolVersion: 3, chainId: v.chainId };
const state = {
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
const observation = { hash: keccak256('0x99'), number: 100n, timestamp: 1000n };
const operation = {
  ...v.operation,
  nonce: BigInt(v.operation.nonce),
  verificationGasLimit: 500000n,
  callGasLimit: 500000n,
  preVerificationGas: 100000n,
  maxPriorityFeePerGas: BigInt(v.operation.maxPriorityFeePerGas),
  maxFeePerGas: BigInt(v.operation.maxFeePerGas),
};
let crashReady = null;
const key = `bunk-v3:${v.owner.commitment.slice(2)}`;
function check(condition, message) {
  if (!condition) throw Error(message);
}
function current(label = 'main') {
  const s = stores.get(label);
  if (!s) throw Error('Missing test store');
  return s;
}
async function open(label = 'main') {
  const raw = await createBunkJournalIndexedDbStore();
  try {
    const sealed = await seedWork((seed) => {
      const key = deriveBunkJournalEncryptionKey(seed);
      try {
        return encryptedBunkJournalStore(raw, key, (n) =>
          crypto.getRandomValues(new Uint8Array(n)),
        );
      } finally {
        key.fill(0);
      }
    });
    stores.set(label, { raw, sealed });
  } catch (error) {
    raw.close();
    throw error;
  }
  return true;
}
function close(label = 'main') {
  const s = stores.get(label);
  if (s) {
    s.sealed.destroy();
    s.raw.close();
    stores.delete(label);
  }
}
function closeAll() {
  for (const name of [...stores.keys()]) close(name);
}
async function erased() {
  closeAll();
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(BUNK_INDEXEDDB_NAME);
    r.onsuccess = resolve;
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error('Test deletion blocked'));
  });
  return true;
}
async function nativeOpen(version = 1, upgrade) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(BUNK_INDEXEDDB_NAME, version);
    r.onupgradeneeded = () => upgrade?.(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function seedWork(fn) {
  const seed = await mnemonicToSeed(fixture.phrase);
  try {
    return await fn(seed);
  } finally {
    seed.fill(0);
  }
}
const api = {
  open,
  close,
  closeAll,
  erased,
  rawRead: (label, key) => current(label).raw.read(key),
  rawCas: (label, key, revision, value) => current(label).raw.compareAndSwap(key, revision, value),
  sealedRead: (label, key) => current(label).sealed.read(key),
  sealedCas: (label, key, revision, value) =>
    current(label).sealed.compareAndSwap(key, revision, value),
  async increment(label, key, count) {
    for (let done = 0; done < count; ) {
      const row = await current(label).raw.read(key);
      if (await current(label).raw.compareAndSwap(key, row.revision, String(row.revision + 1)))
        done++;
    }
    return count;
  },
  async abortAfterRequestSuccess(label, key) {
    const original = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    IDBObjectStore.prototype.put = function (...args) {
      const r = original.apply(this, args),
        tx = this.transaction;
      r.addEventListener('success', () => {
        requestSucceeded = true;
        tx.abort();
      });
      return r;
    };
    let rejected = false;
    try {
      await current(label).raw.compareAndSwap(key, 0, 'must-not-commit');
    } catch {
      rejected = true;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    check(requestSucceeded && rejected, 'Request success escaped an aborted transaction');
    return { requestSucceeded, rejected, row: await current(label).raw.read(key) };
  },
  async strictRequired(label, key) {
    const original = IDBDatabase.prototype.transaction;
    let strictRequested = false;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite') {
        strictRequested = args[2]?.durability === 'strict';
        Object.defineProperty(tx, 'durability', { value: 'relaxed' });
      }
      return tx;
    };
    let error;
    try {
      await current(label).raw.compareAndSwap(key, null, 'must-not-commit');
    } catch (e) {
      error = e.message;
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
    check(strictRequested && error?.includes('strict'), 'Accepted relaxed durability');
    return { strictRequested, error, row: await current(label).raw.read(key) };
  },
  async closeDuringWrite(label, key) {
    const pending = current(label).raw.compareAndSwap(key, null, 'uncertain');
    current(label).raw.close();
    let error;
    try {
      await pending;
    } catch (e) {
      error = e.message;
    }
    check(error, 'Returned success after connection closed');
    return error;
  },
  async corrupt(key, value) {
    const db = await nativeOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('journal', 'readwrite', { durability: 'strict' });
        tx.objectStore('journal').put({ key, ...value });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    return true;
  },
  async badSchema(kind) {
    await erased();
    const db = await nativeOpen(1, (d) =>
      d.createObjectStore(kind === 'store' ? 'wrong' : 'journal', {
        keyPath: kind === 'key' ? 'wrong' : 'key',
        autoIncrement: kind === 'auto',
      }),
    );
    db.close();
    let error;
    try {
      const store = await createBunkJournalIndexedDbStore();
      store.close();
    } catch (e) {
      error = e.message;
    }
    check(error?.includes('schema'), 'Accepted incompatible schema');
    return error;
  },
  async upgrade() {
    const db = await nativeOpen(2);
    db.close();
    return true;
  },
  async blockedTimeout() {
    await erased();
    const blocker = await nativeOpen();
    blocker.onversionchange = () => {};
    const deletion = indexedDB.deleteDatabase(BUNK_INDEXEDDB_NAME);
    const complete = new Promise((resolve, reject) => {
      deletion.onsuccess = resolve;
      deletion.onerror = () => reject(deletion.error);
    });
    await new Promise((resolve) => {
      deletion.onblocked = resolve;
    });
    let error;
    try {
      await createBunkJournalIndexedDbStore(indexedDB, 25);
    } catch (e) {
      error = e.message;
    }
    blocker.close();
    await complete;
    // The timed-out open may resume now; it must abort/close, never leak a blocking connection.
    const reopened = await createBunkJournalIndexedDbStore();
    reopened.close();
    check(error?.includes('timed out'), 'Blocked open did not time out');
    return error;
  },
  async missingHistory() {
    await open();
    const accountKey = bunkV3AccountKey(config, v.account);
    let error;
    try {
      await seedWork((seed) =>
        reserveBunkV3Approval(current().sealed, seed, accountKey, request, {
          rpc: async () => {
            throw Error('Unexpected RPC before checking missing history');
          },
          now: () => 1100,
          maxFinalizedAgeSeconds: 200,
        }),
      );
    } catch (e) {
      error = e.message;
    }
    check(error?.includes('history'), 'Missing history allowed ordinary signing');
    return error;
  },
  async reserveOwner() {
    return seedWork((seed) => reserveBunkV3Intent(current().sealed, seed, request, observation));
  },
  async signOwner() {
    return seedWork(async (seed) => {
      const signed = await signReservedBunkV3Intent(current().sealed, seed, key);
      check(signed.ownerSignature === v.ownerSignature, 'Owner golden mismatch');
      return true;
    });
  },
  async signCrash(role) {
    const base = current().sealed;
    const fault = {
      read: (k) => base.read(k),
      compareAndSwap: async (k, revision, value) => {
        const record = decodeBunkV3Journal(value);
        if (
          role === 'owner'
            ? record.owner.phase === 'signed'
            : record.envelopes.some((e) => e.phase === 'signed')
        ) {
          crashReady = { role, key };
          return new Promise(() => {});
        }
        return base.compareAndSwap(k, revision, value);
      },
    };
    return seedWork((seed) =>
      role === 'owner'
        ? signReservedBunkV3Intent(fault, seed, key)
        : signReservedBunkV3Envelope(fault, seed, key, 255, 2001),
    );
  },
  crashStatus: () => crashReady,
  async journal() {
    const row = await current().sealed.read(key);
    check(row, 'Missing journal');
    const r = decodeBunkV3Journal(row.value);
    return {
      revision: row.revision,
      owner: r.owner.phase,
      ownerSignature: r.owner.signature,
      envelopes: r.envelopes.map((e) => ({
        attempt: e.attempt,
        phase: e.phase,
        signature: e.signature,
      })),
    };
  },
  async reconstructOwner() {
    return seedWork(async (seed) => {
      const intent = await reconstructBunkV3Intent(current().sealed, seed, key, v.intentDigest);
      check(intent.ownerSignature === v.ownerSignature, 'Reconstructed owner differs');
      return true;
    });
  },
  async reserveLeaf() {
    return seedWork(async (seed) => {
      await reserveBunkV3Envelope(current().sealed, seed, key, {
        operation,
        attempt: 255,
        deployed: true,
        purpose: 'cleanup',
        now: 2001,
      });
      return true;
    });
  },
  async signLeaf() {
    return seedWork(async (seed) => {
      const signed = await signReservedBunkV3Envelope(current().sealed, seed, key, 255, 2001);
      check(signed.operation.signature === v.authorization, 'Envelope golden mismatch');
      return true;
    });
  },
  async reconstructLeaf() {
    return seedWork(async (seed) => {
      const signed = await reconstructBunkV3Envelope(
        current().sealed,
        seed,
        key,
        255,
        v.userOpHash,
        2001,
      );
      check(signed.operation.signature === v.authorization, 'Reconstructed envelope differs');
      return { hash: signed.userOpHash, authorizationBytes: size(signed.operation.signature) };
    });
  },
  async savedLeaf() {
    const saved = await readSignedBunkV3Envelope(current().sealed, key, 255);
    check(saved.operation.signature === v.authorization, 'Reopened envelope differs');
    return { hash: saved.userOpHash, authorizationBytes: size(saved.operation.signature) };
  },
};
globalThis.bunkProbe = api;
