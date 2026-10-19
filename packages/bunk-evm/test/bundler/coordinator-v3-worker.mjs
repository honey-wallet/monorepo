// Separate-process test helper; public encrypted backup and loopback chain only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, http } from 'viem';
import { decryptBunkBackup } from '../../../keyring/src/bunk-backup.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../../../keyring/src/bunk-evm-v2-store.ts';
import {
  decodeBunkV3Account,
  reconstructBunkV3Restore,
  signBunkV3Restore,
  startBunkV3Restore,
} from '../../../keyring/src/bunk-evm-v3-account.ts';
import { discoverBunkEvmV3Accounts } from '../../../keyring/src/bunk-evm-v3-discovery.ts';
import { deriveBunkJournalEncryptionKey } from '../../../keyring/src/bunk-journal-key.ts';
import { resolveBunkRecoveryHints } from '../../../keyring/src/bunk-recovery-resolve.ts';
import { mnemonicToSeed } from '../../../keyring/src/index.ts';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.match(input.rpc, /^http:\/\/127\.0\.0\.1:\d+$/);
let seed, vaultKey, store, db;
try {
  // Resolve import before any database creation or chain request. No fixture-phrase fallback.
  const contents = await decryptBunkBackup(
    JSON.parse(fs.readFileSync(input.backupFile, 'utf8')),
    input.backupPassword,
  );
  assert.equal(contents.signingAuthorized, false);
  assert.equal(contents.inventoryComplete, false);
  assert.equal(contents.bunk?.accounts.length, 1);
  const plan = resolveBunkRecoveryHints(
    contents.bunk,
    fs.readFileSync(input.registryFile, 'utf8'),
    input.registryPin,
  );
  const resolved = plan.accounts[0];
  assert.equal(resolved?.kind, 'evm-v3', 'Missing trusted release for imported EVM account');
  assert.equal(plan.signingAuthorized, false);
  const { hint, entry } = resolved;
  const request = {
    config: entry.config,
    accountIndex: hint.accountIndex,
    proxyRuntimeCodeHash: entry.proxyRuntimeCodeHash,
  };
  seed = await mnemonicToSeed(contents.mnemonic);
  const client = createPublicClient({ transport: http(input.rpc) });
  const access = {
    rpc: (r) => client.request(r),
    now: () => Math.floor(Date.now() / 1000),
    maxFinalizedAgeSeconds: 120,
  };
  let result;
  if (input.action === 'discover') {
    result = await discoverBunkEvmV3Accounts(
      seed,
      { ...request, startAccountIndex: hint.accountIndex, count: 3 },
      access,
    );
  } else {
    db = new DatabaseSync(input.database);
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
    vaultKey = deriveBunkJournalEncryptionKey(seed);
    store = encryptedBunkJournalStore(raw, vaultKey, randomBytes);
    if (input.action === 'start') result = await startBunkV3Restore(store, seed, request, access);
    else if (input.action === 'crash') {
      const fault = {
        read: (key) => store.read(key),
        compareAndSwap: async (key, revision, value) => {
          if (decodeBunkV3Account(value).restore?.phase === 'signed') process.exit(73);
          return store.compareAndSwap(key, revision, value);
        },
      };
      await signBunkV3Restore(fault, seed, input.key, input.digest, access);
      throw Error('Expected process death');
    } else if (input.action === 'reconstruct')
      result = await reconstructBunkV3Restore(store, seed, input.key, input.digest, access);
    else throw Error('Unknown test action');
  }
  process.stdout.write(
    JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
} finally {
  seed?.fill(0);
  vaultKey?.fill(0);
  store?.destroy();
  db?.close();
}
