/** PUBLIC FIXTURE ONLY. Real SQLite/process durability; no network or user keys. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bunkPrivateKeyFor, deriveBunkOwner } from '../src/bunk.ts';
import {
  allocateBunkBitcoinAddress,
  bunkBitcoinAccountJournalKey,
  cancelBunkBitcoinApproval,
  claimBunkBitcoinApproval,
  initializeBunkBitcoinJournal,
  persistBunkBitcoinSignatures,
  readBunkBitcoinApproval,
  readBunkBitcoinJournal,
  reserveBunkBitcoinApproval,
} from '../src/bunk-bitcoin-journal.ts';
import { BunkJournalConflict, BunkSigningUncertain } from '../src/bunk-evm-v2-journal.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../src/bunk-evm-v2-store.ts';
import { deriveBunkJournalEncryptionKey } from '../src/bunk-journal-key.ts';

const [mode = 'run', dbPath, role] = process.argv.slice(2);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const loader = path.join(repo, 'packages/bunk-evm/test/bundler/typescript-loader.mjs');
const id = (n) => n.toString(16).padStart(64, '0');
const scope = { network: 'regtest', accountIndex: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'run') {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'honey-bitcoin-journal-'));
  const output = dbPath ?? path.join(work, 'evidence.json');
  const sources = fs
    .readdirSync(path.join(repo, 'packages/keyring/src'))
    .filter((p) => p.endsWith('.ts'))
    .map((p) => `packages/keyring/src/${p}`)
    .concat([
      'packages/keyring/scripts/bunk-bitcoin-journal-restart.mjs',
      'packages/bunk-evm/test/bundler/typescript-loader.mjs',
      'packages/keyring/package.json',
      'pnpm-lock.yaml',
    ])
    .sort();
  const hashes = () =>
    Object.fromEntries(
      sources.map((p) => [
        p,
        createHash('sha256')
          .update(fs.readFileSync(path.join(repo, p)))
          .digest('hex'),
      ]),
    );
  const before = hashes();
  const run = (stage, name, status = 0, extra) => {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        loader,
        script,
        stage,
        path.join(work, `${name}.sqlite`),
        ...(extra ? [extra] : []),
      ],
      { encoding: 'utf8', timeout: 60000 },
    );
    if (child.error) throw child.error;
    assert.equal(child.status, status, child.stderr);
    return JSON.parse(child.stdout);
  };
  const race = async (stage, name) => {
    const database = path.join(work, `${name}.sqlite`),
      children = [];
    try {
      for (const participant of ['a', 'b']) {
        const child = spawn(
          process.execPath,
          ['--import', loader, script, stage, database, participant],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        const result = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code !== 0) reject(new Error(stderr));
            else {
              try {
                resolve(JSON.parse(stdout));
              } catch (e) {
                reject(e);
              }
            }
          });
        });
        // The result is observed immediately even while waiting for the barrier.
        result.catch(() => {});
        children.push({ child, result });
      }
      const deadline = Date.now() + 30000;
      while (!['a', 'b'].every((p) => fs.existsSync(`${database}.${stage}.${p}.ready`))) {
        assert(Date.now() < deadline, 'Race barrier timeout');
        assert(
          children.every(({ child }) => child.exitCode === null),
          'Race participant exited before barrier',
        );
        await sleep(10);
      }
      fs.writeFileSync(`${database}.${stage}.go`, 'go');
      const results = await Promise.all(children.map((c) => c.result));
      assert.equal(results.filter((r) => r.won).length, 1);
      assert.equal(results.filter((r) => r.conflict).length, 1);
      return results;
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
    }
  };
  const initialized = run('initialize', 'normal');
  const crash = run('claim-crash', 'normal', 73);
  const uncertain = run('uncertain', 'normal');
  const recovered = run('recover', 'normal');
  const reopened = run('read', 'normal');
  assert.notEqual(crash.pid, recovered.pid);
  assert.notEqual(recovered.pid, reopened.pid);
  assert.deepEqual(recovered.signed, reopened.signed);
  const allocationRace = await race('allocate-race', 'normal');
  run('allocation-ack-crash', 'normal', 74);
  const allocationRetry = run('allocation-retry', 'normal');
  assert.equal(allocationRetry.ownerIndex, 4);
  assert.equal(allocationRetry.nextOwnerIndex, 5);
  run('initialize-only', 'approval-race');
  const approvalRace = await race('approval-race', 'approval-race');
  run('initialize', 'signature-ack');
  run('claim-crash', 'signature-ack', 73);
  run('signature-ack-crash', 'signature-ack', 75);
  const acknowledged = run('read', 'signature-ack');
  assert.deepEqual(acknowledged.signed, recovered.signed);
  const missing = run('missing', 'missing');
  const db = new DatabaseSync(path.join(work, 'normal.sqlite'));
  const row = db.prepare('SELECT revision, record FROM honey_bunk_journal_v1').get();
  assert(
    row &&
      !row.record.includes('honey-bitcoin-account') &&
      !row.record.includes(reopened.signed.rawTransaction),
  );
  db.close();
  assert.deepEqual(hashes(), before, 'Sources changed during acceptance');
  const report = {
    result: 'passed',
    scope:
      'Public-fixture encrypted SQLite allocation/approval races, abrupt claim/signature-write crashes and exact signed-byte recovery; no production signing policy or chain acceptance',
    initialized,
    crash,
    uncertain,
    recovered,
    reopened,
    allocationRace,
    allocationRetry,
    approvalRace,
    signatureAcknowledgementLoss: acknowledged,
    missingHistory: missing,
    ciphertextAtRest: true,
    sourcesSha256: before,
    sourcesRechecked: true,
    workDirectory: work,
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bitcoin journal restart/race acceptance passed; evidence ${output}`);
} else {
  // Fixed publicly disclosed fixture seed. This is not a production signer.
  const seed = new Uint8Array(64).fill(1),
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
  const encryptionKey = deriveBunkJournalEncryptionKey(seed),
    store = encryptedBunkJournalStore(raw, encryptionKey, randomBytes);
  encryptionKey.fill(0);
  const key = bunkBitcoinAccountJournalKey(seed, scope);
  const allocate = (index, purpose, allocationId = id(index + 1), target = store) =>
    allocateBunkBitcoinAddress(target, key, seed, {
      id: allocationId,
      expectedNextOwnerIndex: index,
      purpose,
    });
  const request = (approvalId = id(20), changeIndex = 1) => {
    const owner = deriveBunkOwner(seed, {
      network: { family: 'bitcoin', network: 'regtest' },
      accountIndex: 0,
      ownerIndex: 0,
    });
    const recipient = deriveBunkOwner(new Uint8Array(64).fill(2), {
      network: { family: 'bitcoin', network: 'regtest' },
      accountIndex: 0,
      ownerIndex: 0,
    });
    return {
      id: approvalId,
      changeAllocationId: id(changeIndex + 1),
      spend: {
        ...scope,
        changeIndex,
        utxos: [
          {
            txid: id(100),
            vout: 0,
            satoshis: 100000n,
            ownerIndex: 0,
            scriptPubKey: `0014${owner.commitment.slice(2)}`,
          },
        ],
        payments: [{ address: recipient.ownerAddress, satoshis: 30000n }],
        feeRateSatPerKvB: 1000n,
        dustRelayFeeSatPerKvB: 3000n,
        maxFeeSat: 1000n,
        lockTime: 101,
      },
    };
  };
  const fixtureSignatures = (approval) =>
    approval.prepared.selected.map((coin, index) => {
      const privateKey = bunkPrivateKeyFor(seed, {
        network: { family: 'bitcoin', network: 'regtest' },
        accountIndex: 0,
        ownerIndex: coin.ownerIndex,
      });
      try {
        return bytesToHex(
          secp256k1.sign(hexToBytes(approval.prepared.signatureDigests[index]), privateKey, {
            prehash: false,
            lowS: true,
            format: 'der',
          }),
        );
      } finally {
        privateKey.fill(0);
      }
    });
  const print = (result) => console.log(JSON.stringify({ pid: process.pid, ...result }));
  try {
    if (mode === 'initialize' || mode === 'initialize-only') {
      await initializeBunkBitcoinJournal(store, seed, { ...scope, origin: 'new-wallet' });
      await allocate(0, 'receive');
      await allocate(1, 'change');
      await allocate(2, 'change');
      const approval =
        mode === 'initialize'
          ? await reserveBunkBitcoinApproval(store, key, seed, request())
          : null;
      print({ key, digest: approval?.digest, nextOwnerIndex: 3 });
    } else if (mode === 'claim-crash') {
      const approval = await readBunkBitcoinApproval(store, key, seed, id(20));
      await claimBunkBitcoinApproval(store, key, seed, approval);
      fixtureSignatures(approval);
      fs.writeSync(1, JSON.stringify({ pid: process.pid, phase: 'claimed', exit: 73 }));
      process.exit(73);
    } else if (mode === 'uncertain') {
      const approval = await readBunkBitcoinApproval(store, key, seed, id(20));
      assert.equal(approval.phase, 'claimed');
      assert.equal(approval.signed, null);
      await assert.rejects(
        claimBunkBitcoinApproval(store, key, seed, approval),
        BunkSigningUncertain,
      );
      await assert.rejects(
        cancelBunkBitcoinApproval(store, key, seed, approval),
        /cannot be cancelled/,
      );
      print({ retainedClaim: true, ordinaryRetryRejected: true });
    } else if (mode === 'recover' || mode === 'signature-ack-crash') {
      const approval = await readBunkBitcoinApproval(store, key, seed, id(20));
      assert.equal(approval.phase, 'claimed');
      const target =
        mode === 'recover'
          ? store
          : {
              read: store.read,
              async compareAndSwap(...args) {
                const won = await store.compareAndSwap(...args);
                assert.equal(won, true);
                fs.writeSync(
                  1,
                  JSON.stringify({ pid: process.pid, committedSignature: true, exit: 75 }),
                );
                process.exit(75);
              },
            };
      const signed = await persistBunkBitcoinSignatures(target, key, seed, {
        ...approval,
        signatures: fixtureSignatures(approval),
      });
      print({ digest: signed.digest, signed: signed.signed });
    } else if (mode === 'read') {
      const approval = await readBunkBitcoinApproval(store, key, seed, id(20));
      assert.equal(approval.phase, 'signed');
      assert.equal(approval.signingAuthorized, false);
      print({ digest: approval.digest, signed: approval.signed });
    } else if (mode === 'allocate-race' || mode === 'approval-race') {
      assert(['a', 'b'].includes(role));
      let held = false;
      const target = {
        compareAndSwap: store.compareAndSwap,
        async read(k) {
          const row = await store.read(k);
          if (!held) {
            held = true;
            fs.writeFileSync(`${dbPath}.${mode}.${role}.ready`, 'ready');
            const deadline = Date.now() + 30000;
            while (!fs.existsSync(`${dbPath}.${mode}.go`)) {
              assert(Date.now() < deadline, 'Barrier expired');
              await sleep(10);
            }
          }
          return row;
        },
      };
      try {
        const result =
          mode === 'allocate-race'
            ? await allocate(3, 'receive', id(role === 'a' ? 30 : 31), target)
            : await reserveBunkBitcoinApproval(
                target,
                key,
                seed,
                request(id(role === 'a' ? 21 : 22), role === 'a' ? 1 : 2),
              );
        print({ won: true, id: result.id });
      } catch (error) {
        assert(error instanceof BunkJournalConflict);
        print({ won: false, conflict: true });
      }
    } else if (mode === 'allocation-ack-crash') {
      const target = {
        read: store.read,
        async compareAndSwap(...args) {
          const won = await store.compareAndSwap(...args);
          assert.equal(won, true);
          fs.writeSync(
            1,
            JSON.stringify({ pid: process.pid, committedAllocation: true, exit: 74 }),
          );
          process.exit(74);
        },
      };
      await allocate(4, 'receive', id(40), target);
      assert.fail('Expected abrupt exit');
    } else if (mode === 'allocation-retry') {
      const result = await allocate(4, 'receive', id(40));
      print({
        ownerIndex: result.ownerIndex,
        nextOwnerIndex: (await readBunkBitcoinJournal(store, key, seed)).nextOwnerIndex,
      });
    } else if (mode === 'missing') {
      await assert.rejects(readBunkBitcoinJournal(store, key, seed), /history is missing/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM honey_bunk_journal_v1').get().n, 0);
      print({ missingHistoryRejectedWithoutCreatingAccount: true });
    } else throw new Error('Unknown public fixture mode');
  } finally {
    store.destroy();
    seed.fill(0);
    db.close();
  }
}
