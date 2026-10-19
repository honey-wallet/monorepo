/** PUBLIC PHRASE FIXTURE ONLY. Internal key primitive is used here solely to
 * test the client against the validator; this is not an application signer. */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { decryptBunkBackup, encryptBunkBackup } from '../../src/bunk-backup.ts';
import {
  createBunkJournalSqliteStore,
  encryptedBunkJournalStore,
} from '../../src/bunk-evm-v2-store.ts';
import { deriveBunkJournalEncryptionKey } from '../../src/bunk-journal-key.ts';
import { resolveBunkRecoveryHints } from '../../src/bunk-recovery-resolve.ts';
import {
  bunkSolanaPrecompile,
  bunkSolanaPrivateKey,
  decodeBunkSolanaState,
  deriveBunkSolanaKey,
  prepareBunkSolanaExecution,
  prepareBunkSolanaInitialization,
  prepareBunkSolanaRecovery,
} from '../../src/bunk-solana.ts';
import { discoverBunkSolanaAccounts } from '../../src/bunk-solana-discovery.ts';
import {
  refreshBunkSolanaAccount,
  reserveBunkSolanaAction,
  signBunkSolanaApproval,
  startBunkSolanaRestore,
} from '../../src/bunk-solana-journal.ts';

export function prepare(request) {
  const seed = mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  try {
    const c = request.scope;
    const account = request.account && {
      ...request.account,
      data: hexToBytes(request.account.data),
    };
    if (request.kind === 'inspect') {
      const state = decodeBunkSolanaState(c, account);
      const owner = deriveBunkSolanaKey(seed, {
        ...c,
        role: 'owner',
        epoch: state.epoch,
        ownerIndex: state.ownerIndex,
      });
      const recovery = deriveBunkSolanaKey(seed, { ...c, role: 'recovery', epoch: state.epoch });
      if (state.owner !== owner.commitment || state.recovery !== recovery.commitment)
        throw new Error('Unexpected fixture phrase authority');
      return {
        ...state,
        nonce: state.nonce.toString(),
        ownerPublicKey: owner.publicKey,
        recoveryPublicKey: recovery.publicKey,
      };
    }
    let p;
    if (request.kind === 'initialize') p = prepareBunkSolanaInitialization(seed, c, request.payer);
    else if (request.kind === 'recover')
      p = prepareBunkSolanaRecovery(seed, c, account, request.payer);
    else {
      const action =
        request.kind === 'native'
          ? { kind: 'native', destination: request.destination, lamports: 1_000_000n }
          : {
              kind: 'cpi',
              program: request.tokenProgram,
              accounts: [
                { address: request.source, writable: true, signer: false },
                { address: request.mint, writable: false, signer: false },
                { address: request.destinationToken, writable: true, signer: false },
                { address: account.address, writable: false, signer: true },
              ],
              data: Uint8Array.of(12, 50, 0, 0, 0, 0, 0, 0, 0, 6),
            };
      p = prepareBunkSolanaExecution(seed, c, account, request.payer, action, {
        validAfter: 0n,
        validUntil: BigInt(request.validUntil),
      });
    }
    const privateKey = bunkSolanaPrivateKey(seed, p.key);
    try {
      const signature = ed25519.sign(hexToBytes(p.digest.slice(2)), privateKey);
      const proof = bunkSolanaPrecompile(p.signer.publicKey, p.digest, signature);
      return {
        wallet: p.wallet,
        signer: p.signer,
        digest: p.digest,
        instructions: [proof, p.instruction].map((instruction) => ({
          ...instruction,
          data: bytesToHex(instruction.data),
        })),
      };
    } finally {
      privateKey.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

/** Fixture export writes only encrypted bytes to the task-owned file. */
export async function backup(request) {
  const { randomBytes, createHash } = await import('node:crypto');
  const fs = await import('node:fs');
  const file = await encryptBunkBackup(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    {
      version: 1,
      accounts: [
        {
          family: 'solana-v1',
          genesisHash: request.release.genesisHash,
          program: request.release.program,
          accountIndex: request.accountIndex,
        },
      ],
    },
    request.password,
    randomBytes,
  );
  const bytes = `${JSON.stringify(file)}\n`;
  fs.writeFileSync(request.file, bytes, { mode: 0o600, flag: 'wx' });
  return { version: file.version, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Each call runs in a NEW Node process against a task-owned encrypted SQLite DB.
 * A deliberate exit(73) simulates death after computing but before saving a signature. */
export async function journal(request) {
  const { DatabaseSync } = await import('node:sqlite');
  const { randomBytes } = await import('node:crypto');
  if (!request.rpc.startsWith('http://127.0.0.1:')) throw new Error('Fixture RPC must be loopback');
  let seed, db, encrypted;
  try {
    let release = request.release;
    let accountIndex = request.accountIndex ?? 10;
    if (request.backupFile !== undefined) {
      const fs = await import('node:fs');
      const contents = await decryptBunkBackup(
        JSON.parse(fs.readFileSync(request.backupFile, 'utf8')),
        request.backupPassword,
      );
      if (contents.signingAuthorized || contents.inventoryComplete)
        throw new Error('Backup unexpectedly authorizes signing or complete inventory');
      // Pin comes from the harness's checked local deployment, never from the backup.
      const plan = resolveBunkRecoveryHints(
        contents.bunk,
        fs.readFileSync(request.registryFile, 'utf8'),
        request.registryPin,
      );
      const resolved = plan.accounts[0];
      if (plan.accounts.length !== 1 || resolved?.kind !== 'solana-v1')
        throw new Error('Missing trusted release for imported account');
      const { hint, entry } = resolved;
      release = entry.release;
      accountIndex = hint.accountIndex;
      seed = mnemonicToSeedSync(contents.mnemonic);
    } else {
      seed = mnemonicToSeedSync(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      );
    }
    db = new DatabaseSync(request.database);
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
    const encryptionKey = deriveBunkJournalEncryptionKey(seed);
    try {
      encrypted = encryptedBunkJournalStore(raw, encryptionKey, randomBytes);
    } finally {
      encryptionKey.fill(0);
    }
    const store = {
      read: (key) => encrypted.read(key),
      async compareAndSwap(key, revision, value) {
        const r = JSON.parse(value);
        if (request.crashOnSigned && r[request.approval]?.phase === 'signed') process.exit(73);
        return encrypted.compareAndSwap(key, revision, value);
      },
    };
    const access = {
      now: () => Math.floor(Date.now() / 1000),
      maxFinalizedAgeSeconds: 300,
      rpc: {
        async request(method, params) {
          const response = await fetch(request.rpc, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error(`Fixture RPC status ${response.status}`);
          const body = await response.json();
          if (body.error) throw new Error(JSON.stringify(body.error));
          return body.result;
        },
      },
    };
    let result;
    if (request.method === 'discover')
      result = await discoverBunkSolanaAccounts(
        seed,
        {
          release,
          startAccountIndex: accountIndex,
          count: 2,
        },
        access,
      );
    else if (request.method === 'start')
      result = await startBunkSolanaRestore(
        store,
        seed,
        release,
        accountIndex,
        request.payer,
        access,
      );
    else if (request.method === 'refresh')
      result = await refreshBunkSolanaAccount(store, request.key, seed, access);
    else if (request.method === 'reserve')
      result = await reserveBunkSolanaAction(
        store,
        request.key,
        seed,
        request.payer,
        {
          kind: 'native',
          destination: request.destination,
          lamports: BigInt(request.lamports ?? '1000000'),
        },
        { validAfter: 0n, validUntil: BigInt(request.validUntil) },
        access,
      );
    else if (request.method === 'inspect') {
      const row = await store.read(request.key),
        rawRow = await raw.read(request.key);
      const r = row && JSON.parse(row.value);
      result = {
        revision: row?.revision,
        phase: r?.phase,
        bootstrap: r?.bootstrap?.phase ?? null,
        recovery: r?.recovery?.phase ?? null,
        owner: r?.owner?.phase ?? null,
        encrypted: Boolean(rawRow && !rawRow.value.includes('honey-solana-account')),
      };
    } else if (request.method === 'sign')
      result = await signBunkSolanaApproval(
        store,
        request.key,
        seed,
        request.approval,
        request.payer,
        access,
        request.reconstruct ?? false,
      );
    else throw new Error('Unknown journal fixture method');
    if (result.instructions)
      result.instructions = result.instructions.map((i) => ({ ...i, data: bytesToHex(i.data) }));
    return JSON.parse(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (error) {
    return { error: error.name, message: error.message };
  } finally {
    encrypted?.destroy();
    seed?.fill(0);
    db?.close();
  }
}
