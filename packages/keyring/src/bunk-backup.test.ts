import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { type Backup, decryptBackup, isBackup, WrongPasswordError } from './backup';
import { BUNK_MAX_INDEX } from './bunk';
import { type BunkBackup, decryptBunkBackup, encryptBunkBackup, isBunkBackup } from './bunk-backup';
import { type BunkRecoveryHints, checkBunkRecoveryHints } from './bunk-recovery-hints';
import evm from './fixtures/bunk-evm-v3.json';
import solana from './fixtures/bunk-solana.json';
import { passwordKey } from './kdf';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse';
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const s = solana.cases[0];
const e = evm.vectors[0];
if (!s || !e) throw new Error('Missing fixture');
const hints: BunkRecoveryHints = {
  version: 1,
  accounts: [
    { family: 'evm-v3', chainId: '1', keyScope: e.keyScope as `0x${string}`, accountIndex: 10_000 },
    {
      family: 'solana-v1',
      genesisHash: s.scope.genesisHash,
      program: s.scope.program,
      accountIndex: BUNK_MAX_INDEX,
    },
    {
      family: 'bitcoin-v1',
      network: 'regtest',
      accountIndex: 9,
      ownerIndices: [0, 87, BUNK_MAX_INDEX],
    },
  ],
};

/** Deliberately cheap, independently sealed import fixtures; exports still use full scrypt. */
async function sealed(payload: unknown, version: 1 | 2 = 2): Promise<BunkBackup | Backup> {
  const salt = new Uint8Array(16).fill(7);
  const nonce = new Uint8Array(24).fill(11);
  const kdf = { N: 16, r: 1, p: 1 };
  const key = await passwordKey(PASSWORD, salt, kdf);
  try {
    const cipher = xchacha20poly1305(key, nonce, utf8ToBytes(`honey-backup-v${version}`));
    return {
      app: 'honey',
      version,
      kdf: { name: 'scrypt', ...kdf, salt: base64.encode(salt) },
      cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
      data: base64.encode(cipher.encrypt(utf8ToBytes(JSON.stringify(payload)))),
      createdAt: '2026-10-19T00:00:00.000Z',
    };
  } finally {
    key.fill(0);
  }
}

describe('Bunk encrypted recovery backup', () => {
  it('round-trips sparse multichain hints under the production KDF without exposing them', async () => {
    const input = structuredClone(hints);
    const pending = encryptBunkBackup(`  ${PHRASE.toUpperCase()}  `, input, PASSWORD, random);
    input.accounts.length = 0;
    const backup = await pending;
    expect(backup.kdf).toMatchObject({ N: 65536, r: 8, p: 1 });
    expect(isBunkBackup(JSON.parse(JSON.stringify(backup)))).toBe(true);
    expect(isBackup(backup)).toBe(false);
    const serialized = JSON.stringify(backup);
    for (const secret of ['abandon', 'evm-v3', 'ownerIndices', s.scope.program, e.keyScope])
      expect(serialized).not.toContain(secret);
    const contents = await decryptBunkBackup(backup, PASSWORD);
    expect(contents).toEqual({
      mnemonic: PHRASE,
      bunk: hints,
      inventoryComplete: false,
      signingAuthorized: false,
    });
    await expect(decryptBackup(backup as unknown as Backup, PASSWORD)).rejects.toThrow(
      'Unsupported backup',
    );
  }, 15_000);

  it('imports a legacy backup with explicitly absent discovery hints', async () => {
    const backup = await sealed({ mnemonic: PHRASE }, 1);
    expect(isBackup(backup)).toBe(true);
    const pending = decryptBunkBackup(backup, PASSWORD);
    backup.data = 'changed after import started';
    expect(await pending).toEqual({
      mnemonic: PHRASE,
      bunk: null,
      inventoryComplete: false,
      signingAuthorized: false,
    });
  });

  it('authenticates phrase and hints, and refuses version relabelling', async () => {
    const backup = await sealed({ mnemonic: PHRASE, bunk: hints });
    await expect(decryptBunkBackup(backup, 'wrong password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    const data = base64.decode(backup.data);
    data[0] = (data[0] as number) ^ 1;
    await expect(
      decryptBunkBackup({ ...backup, data: base64.encode(data) }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(decryptBunkBackup({ ...backup, version: 1 }, PASSWORD)).rejects.toThrow();
    const legacy = await sealed({ mnemonic: PHRASE }, 1);
    await expect(decryptBunkBackup({ ...legacy, version: 2 }, PASSWORD)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('snapshots the entire v2 envelope before asynchronous password derivation', async () => {
    const backup = await sealed({ mnemonic: PHRASE, bunk: hints });
    const pending = decryptBunkBackup(backup, PASSWORD);
    backup.cipher.nonce = '';
    backup.kdf.N = 2 ** 30;
    backup.data = '';
    expect((await pending).bunk).toEqual(hints);
  });

  it('rejects malformed or unsupported authenticated payloads', async () => {
    for (const payload of [
      { mnemonic: PHRASE },
      { mnemonic: 'invalid', bunk: hints },
      { mnemonic: PHRASE, bunk: { ...hints, version: 2 } },
      { mnemonic: PHRASE, bunk: hints, signingAuthorized: true },
      { mnemonic: PHRASE, bunk: null },
    ])
      await expect(decryptBunkBackup(await sealed(payload), PASSWORD)).rejects.toThrow();
  });

  it('bounds KDF work, ciphertext and encodings before password work', async () => {
    const backup = await sealed({ mnemonic: PHRASE, bunk: hints });
    for (const invalid of [
      null,
      { ...backup, version: 3 },
      { ...backup, extra: true },
      { ...backup, createdAt: 'bad date' },
      { ...backup, data: 'A'.repeat(700_000) },
      { ...backup, data: '!' },
      { ...backup, kdf: { ...backup.kdf, salt: 'A'.repeat(24) } },
      ...[{ N: 2 ** 30 }, { N: 3 }, { N: 65536, r: 8, p: 4 }, { r: 9 }, { p: 0 }].map((change) => ({
        ...backup,
        kdf: { ...backup.kdf, ...change },
      })),
    ]) {
      expect(isBunkBackup(invalid)).toBe(false);
      await expect(decryptBunkBackup(invalid as BunkBackup, PASSWORD)).rejects.toThrow();
    }
  });

  it('rejects invalid export inputs and snapshots reused random buffers', async () => {
    await expect(encryptBunkBackup('invalid', hints, PASSWORD, random)).rejects.toThrow();
    await expect(encryptBunkBackup(PHRASE, hints, 'short', random)).rejects.toThrow();
    await expect(
      encryptBunkBackup(PHRASE, hints, PASSWORD, () => new Uint8Array(2)),
    ).rejects.toThrow('randomness');
    const reused = new Uint8Array(24);
    const exported = await encryptBunkBackup(PHRASE, hints, PASSWORD, (n) => {
      reused.fill(n);
      return reused.subarray(0, n);
    });
    expect(base64.decode(exported.kdf.salt)).toEqual(new Uint8Array(16).fill(16));
    expect(base64.decode(exported.cipher.nonce)).toEqual(new Uint8Array(24).fill(24));
  });
});

describe('Bunk recovery discovery hints', () => {
  it('accepts sparse and terminal indices, copies arrays, and preserves empty coverage', () => {
    const checked = checkBunkRecoveryHints(hints);
    expect(checked).toEqual(hints);
    expect(checked.accounts).not.toBe(hints.accounts);
    expect(checkBunkRecoveryHints({ version: 1, accounts: [] }).accounts).toEqual([]);
  });

  it('rejects duplicate accounts, unknown fields/protocols and missing array elements', () => {
    const first = hints.accounts[0];
    for (const accounts of [
      [first, first],
      Array(1),
      Array(1025).fill(first),
      [{ ...first, family: 'evm-v2' }],
      [{ ...first, ownerIndex: 1 }],
      [{ ...first, signingAuthorized: true }],
    ])
      expect(() => checkBunkRecoveryHints({ version: 1, accounts })).toThrow();
  });

  it('validates network identities, derivation scopes and account bounds', () => {
    const [evmHint, solHint, btcHint] = hints.accounts;
    for (const account of [
      { ...evmHint, accountIndex: -1 },
      { ...evmHint, accountIndex: BUNK_MAX_INDEX + 1 },
      { ...evmHint, accountIndex: 1.5 },
      { ...evmHint, chainId: '01' },
      { ...evmHint, chainId: 1 },
      { ...evmHint, keyScope: `0x${'0'.repeat(64)}` },
      { ...solHint, program: 'bad' },
      { ...solHint, genesisHash: '11111111111111111111111111111111' },
      { ...btcHint, network: 'testnet4' },
    ])
      expect(() => checkBunkRecoveryHints({ version: 1, accounts: [account] })).toThrow();
  });

  it('requires sorted unique Bitcoin owners and bounds their aggregate count', () => {
    const bitcoin = hints.accounts[2];
    for (const ownerIndices of [[1, 1], [2, 1], [-1], [BUNK_MAX_INDEX + 1], Array(1)])
      expect(() =>
        checkBunkRecoveryHints({ version: 1, accounts: [{ ...bitcoin, ownerIndices }] }),
      ).toThrow();
    const many = Array.from({ length: 4096 }, (_, i) => i);
    expect(
      checkBunkRecoveryHints({ version: 1, accounts: [{ ...bitcoin, ownerIndices: many }] })
        .accounts,
    ).toHaveLength(1);
    expect(() =>
      checkBunkRecoveryHints({
        version: 1,
        accounts: [
          { ...bitcoin, ownerIndices: many },
          { ...bitcoin, accountIndex: 10, ownerIndices: [0] },
        ],
      }),
    ).toThrow('Too many');
  });
});
