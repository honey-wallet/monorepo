import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import {
  BUNK_JOURNAL_MAX_BYTES,
  type BunkJournalSnapshot,
  type BunkJournalStore,
  checkBunkJournalKey,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';

/** Storage accepts separate v3 account/owner namespaces; v2 record decoders keep
 * their original strict protocol/key checks. Existing ciphertext AAD is unchanged. */
function checkStorageKey(key: string): string {
  if (
    typeof key === 'string' &&
    /^(?:bunk-v3(?:-account)?|bunk-solana-account|bunk-bitcoin-account):[0-9a-f]{64}$/.test(key)
  ) {
    if (/^(?:bunk-v3(?:-account)?|bunk-solana-account|bunk-bitcoin-account):0{64}$/.test(key))
      throw new Error('Empty Bunk storage key');
    return key;
  }
  return checkBunkJournalKey(key);
}

const MAX_STORED_BYTES = 2 * BUNK_JOURNAL_MAX_BYTES + 1024;
/** Compatible with Expo SQLite's async methods. Each INSERT/UPDATE is a single
 * SQLite atomic statement; application code must not emulate it with read/write. */
export interface BunkJournalSqlite {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string, ...parameters: (string | number)[]): Promise<T | null>;
  runAsync(sql: string, ...parameters: (string | number)[]): Promise<{ changes: number }>;
}
function stored(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_STORED_BYTES)
    throw new Error('Bunk stored record exceeds size limit');
  return value;
}
/** Use a dedicated local DB. FULL synchronization is requested; durability still
 * depends on the actual filesystem/platform. This adapter stores opaque strings. */
export async function createBunkJournalSqliteStore(
  db: BunkJournalSqlite,
): Promise<BunkJournalStore> {
  await db.execAsync(`PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS honey_bunk_journal_v1 (
  owner_key TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0 AND revision < 2147483647),
  record TEXT NOT NULL
);`);
  return {
    async read(key) {
      checkStorageKey(key);
      const row = await db.getFirstAsync<{ revision: number; record: string }>(
        'SELECT revision, record FROM honey_bunk_journal_v1 WHERE owner_key = ?',
        key,
      );
      return row === null
        ? null
        : { revision: checkBunkJournalRevision(row.revision), value: stored(row.record) };
    },
    async compareAndSwap(key, expectedRevision, value) {
      checkStorageKey(key);
      stored(value);
      if (expectedRevision !== null) checkBunkJournalRevision(expectedRevision + 1);
      const result =
        expectedRevision === null
          ? await db.runAsync(
              'INSERT INTO honey_bunk_journal_v1 (owner_key, revision, record) VALUES (?, 0, ?) ON CONFLICT(owner_key) DO NOTHING',
              key,
              value,
            )
          : await db.runAsync(
              'UPDATE honey_bunk_journal_v1 SET revision = revision + 1, record = ? WHERE owner_key = ? AND revision = ?',
              value,
              key,
              checkBunkJournalRevision(expectedRevision),
            );
      if (result.changes !== 0 && result.changes !== 1)
        throw new Error('Unexpected Bunk journal write count');
      return result.changes === 1;
    },
  };
}
/** Encrypts every record under an already-unlocked 32-byte encryption key. For new
 * phrase-restorable Bunk storage use deriveBunkJournalEncryptionKey; do not replace
 * an existing deployment's key without an explicit migration. The DB key
 * and revision are authenticated. This prevents substitution, not whole-DB rollback.
 * Pass a cryptographically secure random source. Call destroy when the vault locks. */
export function encryptedBunkJournalStore(
  raw: BunkJournalStore,
  vaultKey: Uint8Array,
  random: (length: number) => Uint8Array,
): BunkJournalStore & { destroy(): void } {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== 32)
    throw new Error('Bunk journal requires a 32-byte vault key');
  const key = vaultKey.slice();
  let destroyed = false;
  const aad = (owner: string, revision: number) => {
    if (destroyed) throw new Error('Bunk journal vault is locked');
    return utf8ToBytes(
      `honey-bunk-journal-v1:${checkStorageKey(owner)}:${checkBunkJournalRevision(revision)}`,
    );
  };
  return {
    destroy() {
      key.fill(0);
      destroyed = true;
    },
    async read(owner): Promise<BunkJournalSnapshot | null> {
      if (destroyed) throw new Error('Bunk journal vault is locked');
      const row = await raw.read(checkStorageKey(owner));
      if (destroyed) throw new Error('Bunk journal vault is locked');
      if (!row) return null;
      const additional = aad(owner, row.revision),
        encoded = stored(row.value);
      const bytes = base64.decode(encoded);
      if (
        base64.encode(bytes) !== encoded ||
        bytes.length < 40 ||
        bytes.length > BUNK_JOURNAL_MAX_BYTES + 40
      )
        throw new Error('Invalid encrypted Bunk journal');
      const plain = xchacha20poly1305(key, bytes.subarray(0, 24), additional).decrypt(
        bytes.subarray(24),
      );
      try {
        return {
          revision: row.revision,
          value: new TextDecoder('utf-8', { fatal: true }).decode(plain),
        };
      } finally {
        plain.fill(0);
      }
    },
    async compareAndSwap(owner, expectedRevision, value) {
      const revision =
        expectedRevision === null ? 0 : checkBunkJournalRevision(expectedRevision) + 1;
      const additional = aad(owner, revision);
      if (typeof value !== 'string' || value.length > BUNK_JOURNAL_MAX_BYTES)
        throw new Error('Bunk journal exceeds size limit');
      const nonce = random(24);
      if (!(nonce instanceof Uint8Array) || nonce.length !== 24)
        throw new Error('Invalid Bunk journal nonce');
      const plain = utf8ToBytes(value);
      if (plain.length > BUNK_JOURNAL_MAX_BYTES) {
        plain.fill(0);
        throw new Error('Bunk journal exceeds size limit');
      }
      let sealed: Uint8Array;
      try {
        sealed = xchacha20poly1305(key, nonce, additional).encrypt(plain);
      } finally {
        plain.fill(0);
      }
      const bytes = new Uint8Array(24 + sealed.length);
      bytes.set(nonce);
      bytes.set(sealed, 24);
      const won = await raw.compareAndSwap(owner, expectedRevision, base64.encode(bytes));
      if (destroyed)
        throw new Error('Bunk journal vault locked during write; reload after unlocking');
      return won;
    },
  };
}
