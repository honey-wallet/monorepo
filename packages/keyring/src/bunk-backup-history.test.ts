import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { type Backup, isBackup, WrongPasswordError } from './backup';
import { bunkPrivateKeyFor, deriveBunkOwner } from './bunk';
import {
  type BunkBackup,
  BunkBackupHistoryMissing,
  type BunkBackupWithHistory,
  decryptBunkBackup,
  decryptBunkBackupWithHistory,
  encryptBunkBackupFromStore,
  encryptBunkBackupWithHistory,
  isBunkBackup,
  isBunkBackupWithHistory,
} from './bunk-backup';
import {
  allocateBunkBitcoinAddress,
  BunkBitcoinArchiveReadOnly,
  claimBunkBitcoinApproval,
  exportBunkBitcoinJournalArchive,
  initializeBunkBitcoinJournal,
  openBunkBitcoinJournalArchive,
  persistBunkBitcoinSignatures,
  readBunkBitcoinApproval,
  reserveBunkBitcoinApproval,
} from './bunk-bitcoin-journal';
import {
  BunkJournalConflict,
  type BunkJournalSnapshot,
  type BunkJournalStore,
} from './bunk-evm-v2-journal';
import type { BunkRecoveryHints } from './bunk-recovery-hints';
import { mnemonicToSeed } from './index';
import { passwordKey } from './kdf';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse';
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const id = (n: number) => n.toString(16).padStart(64, '0');
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
const hints: BunkRecoveryHints = {
  version: 1,
  accounts: [{ family: 'bitcoin-v1', network: 'regtest', accountIndex: 9, ownerIndices: [0, 1] }],
};
async function history() {
  const seed = await mnemonicToSeed(PHRASE),
    rows = new Map<string, BunkJournalSnapshot>();
  const store: BunkJournalStore = {
    async read(k) {
      const r = rows.get(k);
      return r ? { ...r } : null;
    },
    async compareAndSwap(k, rev, value) {
      if ((rows.get(k)?.revision ?? null) !== rev) return false;
      rows.set(k, { revision: rev === null ? 0 : rev + 1, value });
      return true;
    },
  };
  try {
    const scope = { network: 'regtest', accountIndex: 9 } as const;
    const { key } = await initializeBunkBitcoinJournal(store, seed, {
      ...scope,
      origin: 'new-wallet',
    });
    const receive = await allocateBunkBitcoinAddress(store, key, seed, {
      id: id(1),
      expectedNextOwnerIndex: 0,
      purpose: 'receive',
    });
    await allocateBunkBitcoinAddress(store, key, seed, {
      id: id(2),
      expectedNextOwnerIndex: 1,
      purpose: 'change',
    });
    const recipient = deriveBunkOwner(seed, {
      network: { family: 'bitcoin', network: 'regtest' },
      accountIndex: 10,
      ownerIndex: 0,
    });
    const approval = await reserveBunkBitcoinApproval(store, key, seed, {
      id: id(3),
      changeAllocationId: id(2),
      spend: {
        ...scope,
        changeIndex: 1,
        utxos: [
          {
            txid: id(100),
            vout: 0,
            ownerIndex: 0,
            satoshis: 100000n,
            scriptPubKey: receive.scriptPubKey,
          },
        ],
        payments: [{ address: recipient.ownerAddress, satoshis: 30000n }],
        feeRateSatPerKvB: 1000n,
        dustRelayFeeSatPerKvB: 3000n,
        maxFeeSat: 1000n,
        lockTime: 101,
      },
    });
    await claimBunkBitcoinApproval(store, key, seed, approval);
    const secret = bunkPrivateKeyFor(seed, {
      network: { family: 'bitcoin', network: 'regtest' },
      accountIndex: 9,
      ownerIndex: 0,
    });
    let signature: string;
    try {
      const digest = approval.prepared.signatureDigests[0];
      if (!digest) throw new Error('Missing digest');
      signature = bytesToHex(
        secp256k1.sign(hexToBytes(digest), secret, { prehash: false, lowS: true, format: 'der' }),
      );
    } finally {
      secret.fill(0);
    }
    const signed = await persistBunkBitcoinSignatures(store, key, seed, {
      ...approval,
      signatures: [signature],
    });
    return {
      archive: await exportBunkBitcoinJournalArchive(store, key, seed, random),
      signed,
      store,
      rows,
      key,
    };
  } finally {
    seed.fill(0);
  }
}
const fixture = await history();
const payload = () => ({
  mnemonic: PHRASE,
  bunk: structuredClone(hints),
  bitcoinJournals: [structuredClone(fixture.archive)],
});

/** Cheap independently encrypted import fixtures; exporter tests use the production KDF. */
async function sealed(
  value: unknown,
  version: 1 | 2 | 3 = 3,
): Promise<Backup | BunkBackup | BunkBackupWithHistory> {
  const salt = new Uint8Array(16).fill(7),
    nonce = new Uint8Array(24).fill(11),
    kdf = { N: 16, r: 1, p: 1 };
  const key = await passwordKey(PASSWORD, salt, kdf);
  try {
    return {
      app: 'honey',
      version,
      kdf: { name: 'scrypt', ...kdf, salt: base64.encode(salt) },
      cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
      data: base64.encode(
        xchacha20poly1305(key, nonce, utf8ToBytes(`honey-backup-v${version}`)).encrypt(
          utf8ToBytes(JSON.stringify(value)),
        ),
      ),
      createdAt: '2026-10-19T00:00:00.000Z',
    };
  } finally {
    key.fill(0);
  }
}

describe('one-file Bunk backup with Bitcoin history', () => {
  it('round-trips phrase, sparse hints and the exact saved transaction with production encryption', async () => {
    const input = payload();
    const pending = encryptBunkBackupWithHistory(
      ` ${PHRASE.toUpperCase()} `,
      input.bunk,
      input.bitcoinJournals,
      PASSWORD,
      random,
    );
    input.bunk.accounts.length = 0;
    required(input.bitcoinJournals[0]).data = '';
    const backup = await pending;
    expect(backup.kdf).toMatchObject({ N: 65536, r: 8, p: 1 });
    expect(isBunkBackupWithHistory(JSON.parse(JSON.stringify(backup)))).toBe(true);
    for (const secret of ['abandon', fixture.archive.key, fixture.archive.data, 'bitcoinJournals'])
      expect(JSON.stringify(backup)).not.toContain(secret);
    const restored = await decryptBunkBackupWithHistory(backup, PASSWORD);
    expect(restored).toEqual({
      ...payload(),
      inventoryComplete: false,
      historyComplete: false,
      signingAuthorized: false,
    });
    const seed = await mnemonicToSeed(restored.mnemonic);
    const opened = openBunkBitcoinJournalArchive(restored.bitcoinJournals?.[0], seed);
    try {
      expect(await readBunkBitcoinApproval(opened.store, opened.key, seed, id(3))).toEqual(
        fixture.signed,
      );
      await expect(
        opened.store.compareAndSwap(opened.key, opened.revision, '{}'),
      ).rejects.toBeInstanceOf(BunkBitcoinArchiveReadOnly);
    } finally {
      opened.store.destroy();
      seed.fill(0);
    }
  }, 15_000);

  it('imports legacy phrase/hint formats explicitly without archives and makes old readers reject v3', async () => {
    for (const version of [1, 2] as const) {
      const backup = await sealed(
        version === 1 ? { mnemonic: PHRASE } : { mnemonic: PHRASE, bunk: hints },
        version,
      );
      const imported = await decryptBunkBackupWithHistory(backup, PASSWORD);
      expect(imported).toMatchObject({
        mnemonic: PHRASE,
        bitcoinJournals: null,
        historyComplete: false,
        inventoryComplete: false,
        signingAuthorized: false,
      });
      expect(imported.bunk).toEqual(version === 1 ? null : hints);
    }
    const backup = await sealed(payload());
    expect(isBackup(backup)).toBe(false);
    expect(isBunkBackup(backup)).toBe(false);
    await expect(decryptBunkBackup(backup as BunkBackup, PASSWORD)).rejects.toThrow('Unsupported');
  });

  it('authenticates all contents and rejects ciphertext tampering and version relabelling', async () => {
    const backup = await sealed(payload()),
      changed = base64.decode(backup.data);
    changed[0] = (changed[0] as number) ^ 1;
    await expect(decryptBunkBackupWithHistory(backup, 'wrong password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    await expect(
      decryptBunkBackupWithHistory({ ...backup, data: base64.encode(changed) }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(
      decryptBunkBackupWithHistory({ ...backup, version: 2 }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    const older = await sealed({ mnemonic: PHRASE, bunk: hints }, 2);
    await expect(
      decryptBunkBackupWithHistory({ ...older, version: 3 }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects foreign, corrupted or unhinted archives on both export and authenticated import', async () => {
    for (const kind of ['phrase', 'hint', 'revision', 'duplicate']) {
      const p = payload();
      if (kind === 'phrase') p.mnemonic = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      if (kind === 'hint') p.bunk.accounts.length = 0;
      if (kind === 'revision') required(p.bitcoinJournals[0]).revision++;
      if (kind === 'duplicate') p.bitcoinJournals.push(fixture.archive);
      await expect(
        encryptBunkBackupWithHistory(p.mnemonic, p.bunk, p.bitcoinJournals, PASSWORD, random),
      ).rejects.toThrow();
      await expect(decryptBunkBackupWithHistory(await sealed(p), PASSWORD)).rejects.toThrow();
    }
  });

  it('bounds archive count/size, KDF work and schema before expensive work', async () => {
    for (const bitcoinJournals of [
      Array(65).fill(fixture.archive),
      Array(1),
      [{ ...fixture.archive, data: 'A'.repeat(16 * 1024 * 1024 + 1) }],
      [{ ...fixture.archive, extra: true }],
    ]) {
      await expect(
        encryptBunkBackupWithHistory(PHRASE, hints, bitcoinJournals, PASSWORD, random),
      ).rejects.toThrow();
    }
    const backup = await sealed(payload());
    for (const bad of [
      null,
      { ...backup, kdf: { ...backup.kdf, N: 2 ** 30 } },
      { ...backup, data: 'A'.repeat(Math.ceil((16 * 1024 * 1024 + 16) / 3) * 4 + 4) },
      { ...backup, extra: true },
    ]) {
      expect(isBunkBackupWithHistory(bad)).toBe(false);
      await expect(
        decryptBunkBackupWithHistory(bad as BunkBackupWithHistory, PASSWORD),
      ).rejects.toThrow();
    }
    for (const p of [
      { mnemonic: PHRASE, bunk: hints },
      { ...payload(), signingAuthorized: true },
      { ...payload(), bitcoinJournals: null },
      { ...payload(), bitcoinJournals: [fixture.archive, fixture.archive] },
    ])
      await expect(decryptBunkBackupWithHistory(await sealed(p), PASSWORD)).rejects.toThrow();
  });

  it('snapshots the encrypted envelope before awaiting the password KDF', async () => {
    const backup = await sealed(payload()),
      pending = decryptBunkBackupWithHistory(backup, PASSWORD);
    backup.version = 2;
    backup.data = '';
    backup.kdf.N = 2 ** 30;
    backup.cipher.nonce = '';
    expect(await pending).toEqual({
      ...payload(),
      inventoryComplete: false,
      historyComplete: false,
      signingAuthorized: false,
    });
  });

  it('preserves an explicitly empty archive list without implying complete restoration', async () => {
    const empty = { mnemonic: PHRASE, bunk: hints, bitcoinJournals: [] };
    expect(await decryptBunkBackupWithHistory(await sealed(empty), PASSWORD)).toEqual({
      ...empty,
      inventoryComplete: false,
      historyComplete: false,
      signingAuthorized: false,
    });
    await expect(
      encryptBunkBackupWithHistory('invalid', hints, [], PASSWORD, random),
    ).rejects.toThrow('recovery phrase');
    await expect(encryptBunkBackupWithHistory(PHRASE, hints, [], 'short', random)).rejects.toThrow(
      'at least',
    );
    await expect(
      encryptBunkBackupWithHistory(PHRASE, hints, [], PASSWORD, () => new Uint8Array(2)),
    ).rejects.toThrow('randomness');
  });
});

const evmHint = {
  family: 'evm-v3',
  chainId: '1',
  keyScope: `0x${'11'.repeat(32)}`,
  accountIndex: 10000,
} as const;

describe('known-account backup collection', () => {
  it('collects all hinted Bitcoin accounts into one file and preserves other chain hints without writes', async () => {
    const f = await history(),
      seed = await mnemonicToSeed(PHRASE);
    const allHints: BunkRecoveryHints = {
      version: 1,
      accounts: [
        ...hints.accounts,
        { family: 'bitcoin-v1', network: 'signet', accountIndex: 10000, ownerIndices: [] },
        evmHint,
      ],
    };
    try {
      const second = await initializeBunkBitcoinJournal(f.store, seed, {
        network: 'signet',
        accountIndex: 10000,
        origin: 'new-wallet',
      });
      const before = [...f.rows.entries()];
      const file = await encryptBunkBackupFromStore(PHRASE, allHints, f.store, PASSWORD, random);
      const restored = await decryptBunkBackupWithHistory(file, PASSWORD);
      expect(restored.bunk).toEqual(allHints);
      expect(restored.bitcoinJournals?.map((a) => a.key)).toEqual([f.key, second.key]);
      expect(restored).toMatchObject({
        inventoryComplete: false,
        historyComplete: false,
        signingAuthorized: false,
      });
      const imported = openBunkBitcoinJournalArchive(restored.bitcoinJournals?.[0], seed);
      try {
        expect(await readBunkBitcoinApproval(imported.store, f.key, seed, id(3))).toEqual(f.signed);
      } finally {
        imported.store.destroy();
      }
      expect([...f.rows.entries()]).toEqual(before);
    } finally {
      seed.fill(0);
    }
  }, 15_000);

  it('reports all missing known accounts without initializing them or producing a partial backup', async () => {
    const f = await history(),
      before = [...f.rows.entries()];
    const allHints: BunkRecoveryHints = {
      version: 1,
      accounts: [
        ...hints.accounts,
        { family: 'bitcoin-v1', network: 'regtest', accountIndex: 10000, ownerIndices: [] },
        { family: 'bitcoin-v1', network: 'signet', accountIndex: 0, ownerIndices: [] },
      ],
    };
    let randomness = 0;
    const failed = await encryptBunkBackupFromStore(PHRASE, allHints, f.store, PASSWORD, (n) => {
      randomness++;
      return random(n);
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(BunkBackupHistoryMissing);
    if (!(failed instanceof BunkBackupHistoryMissing)) throw new Error('Expected missing history');
    expect(failed.accounts).toEqual([
      { network: 'regtest', accountIndex: 10000 },
      { network: 'signet', accountIndex: 0 },
    ]);
    expect(randomness).toBe(0);
    expect([...f.rows.entries()]).toEqual(before);
  });

  it('rejects source revision changes, replaced bytes or deletion during collection', async () => {
    for (const change of ['revision', 'value', 'delete']) {
      const f = await history();
      let reads = 0;
      const racing: BunkJournalStore = {
        async read(k) {
          if (++reads === 2) {
            const row = required(f.rows.get(k));
            if (change === 'delete') f.rows.delete(k);
            else
              f.rows.set(
                k,
                change === 'revision'
                  ? { ...row, revision: row.revision + 1 }
                  : { ...row, value: `${row.value} ` },
              );
          }
          return f.store.read(k);
        },
        async compareAndSwap() {
          throw new Error('Unexpected write');
        },
      };
      await expect(
        encryptBunkBackupFromStore(PHRASE, hints, racing, PASSWORD, random),
      ).rejects.toBeInstanceOf(BunkJournalConflict);
      expect(reads).toBe(2);
    }
  }, 15_000);

  it('propagates corrupt history and storage failures instead of treating them as missing', async () => {
    const f = await history();
    let randomness = 0;
    for (const broken of [
      { ...f.store, read: async () => ({ revision: 0, value: '{}' }) },
      {
        ...f.store,
        read: async () => {
          throw new Error('database locked');
        },
      },
    ]) {
      const result = await encryptBunkBackupFromStore(PHRASE, hints, broken, PASSWORD, (n) => {
        randomness++;
        return random(n);
      }).catch((e: unknown) => e);
      expect(result).toBeInstanceOf(Error);
      expect(result).not.toBeInstanceOf(BunkBackupHistoryMissing);
    }
    expect(randomness).toBe(0);
  });

  it('snapshots hints and the source read method before deriving the phrase seed', async () => {
    const f = await history(),
      input = structuredClone(hints);
    const pending = encryptBunkBackupFromStore(PHRASE, input, f.store, PASSWORD, random);
    input.accounts.length = 0;
    f.store.read = async () => {
      throw new Error('replaced after invocation');
    };
    const restored = await decryptBunkBackupWithHistory(await pending, PASSWORD);
    expect(restored.bunk).toEqual(hints);
    expect(restored.bitcoinJournals).toHaveLength(1);
  }, 15_000);

  it('bounds known-account count and total captured history before archive encryption', async () => {
    let reads = 0,
      randomness = 0;
    const oversized: BunkJournalStore = {
      async read() {
        reads++;
        return { revision: 0, value: 'x'.repeat(8 * 1024 * 1024) };
      },
      async compareAndSwap() {
        throw new Error('Unexpected write');
      },
    };
    const many: BunkRecoveryHints = {
      version: 1,
      accounts: Array.from({ length: 65 }, (_, accountIndex) => ({
        family: 'bitcoin-v1',
        network: 'regtest',
        accountIndex,
        ownerIndices: [],
      })),
    };
    const rng = (n: number) => {
      randomness++;
      return random(n);
    };
    await expect(
      encryptBunkBackupFromStore(PHRASE, many, oversized, PASSWORD, rng),
    ).rejects.toThrow('Too many');
    expect(reads).toBe(0);
    await expect(
      encryptBunkBackupFromStore(
        PHRASE,
        { version: 1, accounts: many.accounts.slice(0, 2) },
        oversized,
        PASSWORD,
        rng,
      ),
    ).rejects.toThrow('size limit');
    expect(reads).toBe(2);
    expect(randomness).toBe(0);
  });

  it('exports non-Bitcoin hints without querying or creating a Bitcoin journal', async () => {
    const noBitcoin: BunkRecoveryHints = { version: 1, accounts: [evmHint] };
    const unavailable: BunkJournalStore = {
      async read() {
        throw new Error('Unexpected read');
      },
      async compareAndSwap() {
        throw new Error('Unexpected write');
      },
    };
    const restored = await decryptBunkBackupWithHistory(
      await encryptBunkBackupFromStore(PHRASE, noBitcoin, unavailable, PASSWORD, random),
      PASSWORD,
    );
    expect(restored.bunk).toEqual(noBitcoin);
    expect(restored.bitcoinJournals).toEqual([]);
    expect(restored.historyComplete).toBe(false);
  }, 15_000);
});
