// Public fixture only. Writer exits before a separate reader process opens the DB.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import {
  bunkV2JournalKey,
  decodeBunkV2Journal,
  readSignedBunkV2Envelope,
  reconstructBunkV2Envelope,
  reconstructBunkV2Intent,
  reserveBunkV2Envelope,
  reserveBunkV2Intent,
  signReservedBunkV2Envelope,
  signReservedBunkV2Intent,
} from '../src/bunk-evm-v2-journal.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../src/bunk-evm-v2-store.ts';
import { mnemonicToSeed } from '../src/index.ts';

const [mode, dbPath] = process.argv.slice(2);
if (!mode) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'honey-journal-restart-'));
  const loader = fileURLToPath(
    new URL('../../../packages/bunk-evm/test/bundler/typescript-loader.mjs', import.meta.url),
  );
  const script = fileURLToPath(import.meta.url);
  try {
    const run = (stage, name, crash = false) => {
      const child = spawnSync(
        process.execPath,
        ['--import', loader, script, stage, join(dir, `${name}.sqlite`)],
        { encoding: 'utf8', timeout: 60000 },
      );
      if (child.error) throw child.error;
      assert.equal(child.status, crash ? 77 : 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const scenarios = [];
    for (const boundary of ['saved', 'owner', 'leaf']) {
      const crashed = boundary !== 'saved';
      const written = run(crashed ? `crash-${boundary}` : 'write', boundary, crashed);
      const recovered = crashed ? run(`recover-${boundary}`, boundary) : written;
      const reopened = run('read', boundary);
      assert.notEqual(written.pid, reopened.pid);
      if (crashed) assert.notEqual(written.pid, recovered.pid);
      assert.equal(recovered.userOpHash, reopened.userOpHash);
      assert.equal(reopened.revision, crashed ? 6 : 5);
      scenarios.push({
        boundary,
        distinctProcesses: true,
        abruptExit: crashed,
        revision: reopened.revision,
        userOpHash: reopened.userOpHash,
      });
    }
    console.log(
      JSON.stringify({
        result: 'passed',
        scope: 'Public-fixture encrypted SQLite restart and abrupt-signing-crash recovery',
        scenarios,
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  assert(
    ['write', 'read', 'crash-owner', 'crash-leaf', 'recover-owner', 'recover-leaf'].includes(mode),
  );
  const v = JSON.parse(
    fs.readFileSync(new URL('../src/fixtures/bunk-evm-v2.json', import.meta.url)),
  ).vectors[1];
  const fixture = JSON.parse(
    fs.readFileSync(new URL('../src/fixtures/bunk-evm-v2.json', import.meta.url)),
  );
  const config = { ...fixture.config, chainId: v.chainId, protocolVersion: 2 };
  const key = bunkV2JournalKey(v.owner.commitment),
    db = new DatabaseSync(dbPath);
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
  // Deliberately public test-only vault key. Never use this value for user records.
  const store = encryptedBunkJournalStore(raw, new Uint8Array(32).fill(7), randomBytes);
  // Exit at the signature-save boundary without finally/close/destroy. The claim
  // was committed with FULL synchronization; the computed signature is lost.
  const signingStore = {
    read: (ownerKey) => store.read(ownerKey),
    compareAndSwap: async (ownerKey, revision, value) => {
      const r = decodeBunkV2Journal(value);
      if (
        (mode === 'crash-owner' && r.owner.phase === 'signed') ||
        (mode === 'crash-leaf' && r.envelopes.some((e) => e.phase === 'signed'))
      ) {
        fs.writeSync(1, JSON.stringify({ pid: process.pid, boundary: mode }));
        process.exit(77);
      }
      return store.compareAndSwap(ownerKey, revision, value);
    },
  };
  try {
    if (mode !== 'read') {
      const seed = await mnemonicToSeed(fixture.phrase);
      try {
        const state = {
          protocolVersion: 2,
          deployed: true,
          account: v.account,
          accountIndex: v.accountIndex,
          ownerIndex: v.ownerIndex,
          commitment: v.owner.commitment,
          nonce: BigInt(v.ownerIndex),
        };
        if (!mode.startsWith('recover-')) {
          const reserved = await reserveBunkV2Intent(
            signingStore,
            seed,
            {
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
            },
            { hash: keccak256('0x99'), number: 100n, timestamp: 1000n },
          );
          assert.equal(reserved, key);
          await signReservedBunkV2Intent(signingStore, seed, key);
        } else {
          const before = decodeBunkV2Journal((await store.read(key)).value);
          if (mode === 'recover-owner') {
            assert.equal(before.owner.phase, 'signing');
            assert.equal(before.owner.signature, null);
            const restored = await reconstructBunkV2Intent(store, seed, key, v.intentDigest);
            assert.equal(restored.ownerSignature, v.ownerSignature);
          } else {
            assert.equal(before.envelopes[0].phase, 'signing');
            assert.equal(before.envelopes[0].signature, null);
          }
        }
        const operation = { ...v.operation };
        for (const field of [
          'nonce',
          'verificationGasLimit',
          'callGasLimit',
          'preVerificationGas',
          'maxPriorityFeePerGas',
          'maxFeePerGas',
        ])
          operation[field] = BigInt(operation[field]);
        if (mode !== 'recover-leaf') {
          await reserveBunkV2Envelope(signingStore, seed, key, {
            operation,
            attempt: 254,
            deployed: true,
            purpose: 'action',
            now: 1100,
          });
          await signReservedBunkV2Envelope(signingStore, seed, key, 254, 1100);
        } else {
          await reconstructBunkV2Envelope(store, seed, key, 254, v.userOpHash, 1100);
        }
      } finally {
        seed.fill(0);
      }
    }
    const signed = await readSignedBunkV2Envelope(store, key, 254);
    assert.equal(signed.operation.signature, v.authorization);
    assert.equal(signed.userOpHash, v.userOpHash);
    const snapshot = await store.read(key);
    assert.equal(decodeBunkV2Journal(snapshot.value).envelopes[0].phase, 'signed');
    console.log(
      JSON.stringify({
        pid: process.pid,
        revision: snapshot.revision,
        userOpHash: signed.userOpHash,
      }),
    );
  } finally {
    store.destroy();
    db.close();
  }
}
