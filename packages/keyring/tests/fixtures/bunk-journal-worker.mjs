// Child-process fixture. Paths point only to the test's disposable directory.
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createBunkJournalSqliteStore } from '../../src/bunk-evm-v2-store.ts';

const [path, key, value, ready, barrier] = process.argv.slice(2);
const db = new DatabaseSync(path);
try {
  const store = await createBunkJournalSqliteStore({
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
  const before = await store.read(key);
  if (!before) throw new Error('Missing race fixture');
  writeFileSync(ready, 'ready');
  for (let i = 0; !existsSync(barrier); i++) {
    if (i === 1500) throw new Error('Test barrier timeout');
    await delay(10);
  }
  const won = await store.compareAndSwap(key, before.revision, value);
  process.stdout.write(JSON.stringify({ won, observedRevision: before.revision }));
} finally {
  db.close();
}
