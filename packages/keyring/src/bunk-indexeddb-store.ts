import {
  BUNK_JOURNAL_MAX_BYTES,
  type BunkJournalSnapshot,
  type BunkJournalStore,
  checkBunkJournalKey,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';

/** One database for every wallet alias in the extension origin. Do not partition
 * this namespace by UI label: the same signing authority must share its journal. */
export const BUNK_INDEXEDDB_NAME = 'honey-bunk-journal-v1';
const STORE = 'journal';
const MAX_STORED_BYTES = 2 * BUNK_JOURNAL_MAX_BYTES + 1024;
function storageKey(key: string): string {
  if (
    typeof key === 'string' &&
    /^(?:bunk-v3(?:-account)?|bunk-solana-account):[0-9a-f]{64}$/.test(key)
  ) {
    if (/^(?:bunk-v3(?:-account)?|bunk-solana-account):0{64}$/.test(key))
      throw new Error('Empty Bunk storage key');
    return key;
  }
  return checkBunkJournalKey(key);
}
function stored(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_STORED_BYTES)
    throw new Error('Bunk stored record exceeds size limit');
  return value;
}
function row(value: unknown, key: string): BunkJournalSnapshot | null {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(' ') !== 'key revision value'
  )
    throw new Error('Invalid Bunk IndexedDB row');
  const r = value as { key: unknown; revision: unknown; value: unknown };
  if (r.key !== key) throw new Error('Foreign Bunk IndexedDB row');
  return { revision: checkBunkJournalRevision(r.revision as number), value: stored(r.value) };
}
/** Opaque storage: wrap with encryptedBunkJournalStore before storing approvals.
 * Every CAS reads and conditionally writes inside ONE readwrite transaction, without
 * awaiting crypto/network work inside it. Resolve only on transaction completion.
 * Strict durability is required; no relaxed fallback or automatic database deletion.
 * Browser eviction, profile rollback and physical power loss remain platform concerns. */
export async function createBunkJournalIndexedDbStore(
  factory: IDBFactory = globalThis.indexedDB,
  openTimeoutMs = 10000,
): Promise<BunkJournalStore & { close(): void }> {
  if (!factory || typeof factory.open !== 'function') throw new Error('IndexedDB is unavailable');
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1 || openTimeoutMs > 60000)
    throw new Error('Invalid Bunk database open timeout');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(BUNK_INDEXEDDB_NAME, 1);
    let finished = false;
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        request.transaction?.abort();
      } catch {
        /* Already committed/aborted. */
      }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Bunk database open timed out')), openTimeoutMs);
    request.onblocked = () => fail(new Error('Bunk database open is blocked'));
    request.onerror = () => fail(request.error ?? new Error('Bunk database open failed'));
    request.onupgradeneeded = (event) => {
      if (finished || event.oldVersion !== 0) {
        try {
          request.transaction?.abort();
        } catch {
          /* Already aborted. */
        }
        if (!finished) fail(new Error('Unsupported Bunk database schema'));
        return;
      }
      request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const connection = request.result;
      if (finished) {
        connection.close();
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(connection);
    };
  });
  let closed = false;
  const transactions = new Set<IDBTransaction>();
  const closedError = () =>
    new Error('Bunk database connection is closed; reopen before proceeding');
  const close = () => {
    closed = true;
    for (const tx of transactions) {
      try {
        tx.abort();
      } catch {
        /* Commit may already have started; completion still rejects. */
      }
    }
    db.close();
  };
  db.onversionchange = close;
  db.onclose = close;
  try {
    if (
      db.version !== 1 ||
      db.objectStoreNames.length !== 1 ||
      !db.objectStoreNames.contains(STORE)
    )
      throw new Error('Unsupported Bunk database schema');
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    if (store.keyPath !== 'key' || store.autoIncrement || store.indexNames.length !== 0)
      throw new Error('Unsupported Bunk database schema');
  } catch (error) {
    close();
    throw error;
  }

  function transaction<T>(
    mode: IDBTransactionMode,
    body: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(closedError());
        return;
      }
      let tx: IDBTransaction;
      try {
        tx =
          mode === 'readwrite'
            ? db.transaction(STORE, mode, { durability: 'strict' })
            : db.transaction(STORE, mode);
      } catch (error) {
        reject(error);
        return;
      }
      transactions.add(tx);
      let value: T,
        hasValue = false,
        failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          transactions.delete(tx);
          reject(error);
        }
      };
      tx.onabort = () => {
        transactions.delete(tx);
        reject(failure ?? tx.error ?? new Error('Bunk database transaction aborted'));
      };
      // Request errors retain their default action, which aborts the transaction.
      tx.onerror = () => {
        failure ??= tx.error ?? new Error('Bunk database request failed');
      };
      tx.oncomplete = () => {
        transactions.delete(tx);
        if (closed) reject(closedError());
        else if (!hasValue) reject(new Error('Bunk database transaction produced no result'));
        else resolve(value);
      };
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        fail(new Error('Bunk requires strict IndexedDB durability'));
        return;
      }
      try {
        body(
          tx.objectStore(STORE),
          (v) => {
            value = v;
            hasValue = true;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  return {
    close,
    async read(key) {
      storageKey(key);
      return transaction<BunkJournalSnapshot | null>('readonly', (store, result, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            result(row(request.result, key));
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    async compareAndSwap(key, expectedRevision, value) {
      storageKey(key);
      stored(value);
      const nextRevision =
        expectedRevision === null ? 0 : checkBunkJournalRevision(expectedRevision + 1);
      if (expectedRevision !== null) checkBunkJournalRevision(expectedRevision);
      return transaction<boolean>('readwrite', (store, result, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const current = row(request.result, key);
            if (
              expectedRevision === null ? current !== null : current?.revision !== expectedRevision
            ) {
              result(false);
              return;
            }
            const entry = { key, revision: nextRevision, value };
            const write = expectedRevision === null ? store.add(entry) : store.put(entry);
            write.onsuccess = () => result(true);
          } catch (error) {
            fail(error);
          }
        };
      });
    },
  };
}
