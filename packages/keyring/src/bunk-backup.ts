import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import {
  type Backup,
  decryptBackup,
  isBackup,
  MIN_PASSWORD_LENGTH,
  WrongPasswordError,
} from './backup';
import {
  type BunkBitcoinJournalArchive,
  type BunkBitcoinJournalScope,
  bunkBitcoinAccountJournalKey,
  checkBunkBitcoinJournalArchive,
  exportBunkBitcoinJournalArchive,
  openBunkBitcoinJournalArchive,
} from './bunk-bitcoin-journal';
import {
  BUNK_JOURNAL_MAX_BYTES,
  BunkJournalConflict,
  type BunkJournalSnapshot,
  type BunkJournalStore,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';
import { type BunkRecoveryHints, checkBunkRecoveryHints } from './bunk-recovery-hints';
import { isValidMnemonic, normalizeMnemonic, withMnemonicSeed } from './index';
import { passwordKey } from './kdf';

/** Separate version: old phrase-only readers must reject rather than drop Bunk hints. */
export type BunkBackup = Omit<Backup, 'version'> & { version: 2 };
/** Version 3 authenticates the phrase, hints and supplied Bitcoin archives together. */
export type BunkBackupWithHistory = Omit<Backup, 'version'> & { version: 3 };
export interface BunkBackupContents {
  mnemonic: string;
  /** Null explicitly means a legacy phrase-only file, not complete discovery. */
  bunk: BunkRecoveryHints | null;
  inventoryComplete: false;
  signingAuthorized: false;
}
export interface BunkBackupWithHistoryContents extends BunkBackupContents {
  /** Null for legacy v1/v2 files; an empty v3 list explicitly contains no archives. */
  bitcoinJournals: BunkBitcoinJournalArchive[] | null;
  historyComplete: false;
}
export class BunkBackupHistoryMissing extends Error {
  readonly accounts: readonly BunkBitcoinJournalScope[];
  constructor(accounts: readonly BunkBitcoinJournalScope[]) {
    super('Bitcoin history is missing for known backup accounts');
    this.name = 'BunkBackupHistoryMissing';
    this.accounts = accounts.map((account) => ({ ...account }));
  }
}
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;
const plainLimit = (version: 2 | 3) => (version === 2 ? 512 * 1024 : 16 * 1024 * 1024);
const aad = (version: 2 | 3) => utf8ToBytes(`honey-backup-v${version}`);

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function decoded(value: string, length?: number): Uint8Array {
  const bytes = base64.decode(value);
  if (base64.encode(bytes) !== value || (length !== undefined && bytes.length !== length))
    throw new Error('Unsupported Bunk backup');
  return bytes;
}

/** Bounded envelope/KDF validation before asking the device to derive a password key. */
export function isBunkBackup(value: unknown): value is BunkBackup {
  return isEnvelope(value, 2);
}
export function isBunkBackupWithHistory(value: unknown): value is BunkBackupWithHistory {
  return isEnvelope(value, 3);
}
function isEnvelope(value: unknown, version: 2 | 3): boolean {
  if (
    !keys(value, ['app', 'version', 'kdf', 'cipher', 'data', 'createdAt']) ||
    value.app !== 'honey' ||
    value.version !== version ||
    !keys(value.kdf, ['name', 'N', 'r', 'p', 'salt']) ||
    !keys(value.cipher, ['name', 'nonce'])
  )
    return false;
  const { N, r, p, salt } = value.kdf;
  const { nonce } = value.cipher;
  if (
    value.kdf.name !== 'scrypt' ||
    value.cipher.name !== 'xchacha20-poly1305' ||
    typeof N !== 'number' ||
    typeof r !== 'number' ||
    typeof p !== 'number' ||
    ![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) ||
    N < 2 ||
    N > 2 ** 16 ||
    (N & (N - 1)) !== 0 ||
    r > 8 ||
    p > 4 ||
    N * r * p > 2 ** 19 ||
    128 * r * (N + p + 1) > 72 * 1024 * 1024 ||
    typeof salt !== 'string' ||
    salt.length !== 24 ||
    typeof nonce !== 'string' ||
    nonce.length !== 32 ||
    typeof value.data !== 'string' ||
    value.data.length < 24 ||
    value.data.length > Math.ceil((plainLimit(version) + 16) / 3) * 4 ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return false;
  try {
    decoded(salt, 16);
    decoded(nonce, 24);
    const data = decoded(value.data);
    return data.length >= 16 && data.length <= plainLimit(version) + 16;
  } catch {
    return false;
  }
}

export async function encryptBunkBackup(
  phrase: string,
  hints: BunkRecoveryHints,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<BunkBackup> {
  if (!isValidMnemonic(phrase)) throw new Error('Not a valid recovery phrase');
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  // Snapshot metadata before randomness callbacks or asynchronous password work.
  const payload = { mnemonic: normalizeMnemonic(phrase), bunk: checkBunkRecoveryHints(hints) };
  return sealPayload(2, payload, password, random);
}

async function sealPayload<V extends 2 | 3>(
  version: V,
  payload: unknown,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<Omit<Backup, 'version'> & { version: V }> {
  const salt = Uint8Array.from(random(16));
  const nonce = Uint8Array.from(random(24));
  if (salt.length !== 16 || nonce.length !== 24) throw new Error('Invalid backup randomness');
  const plain = utf8ToBytes(JSON.stringify(payload));
  if (plain.length > plainLimit(version)) {
    plain.fill(0);
    throw new Error('Bunk backup exceeds size limit');
  }
  let key: Uint8Array | undefined;
  try {
    key = await passwordKey(password, salt, SCRYPT);
    return {
      app: 'honey',
      version,
      kdf: { name: 'scrypt', ...SCRYPT, salt: base64.encode(salt) },
      cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
      data: base64.encode(xchacha20poly1305(key, nonce, aad(version)).encrypt(plain)),
      createdAt: new Date().toISOString(),
    };
  } finally {
    key?.fill(0);
    plain.fill(0);
  }
}

/** Opens v1 phrases or v2 discovery hints; neither is sufficient signing history. */
export async function decryptBunkBackup(
  input: BunkBackup | Backup,
  password: string,
): Promise<BunkBackupContents> {
  if (input?.version === 1) {
    if (!isBackup(input)) throw new Error('Unsupported backup');
    const legacy = { ...input, kdf: { ...input.kdf }, cipher: { ...input.cipher } };
    return {
      mnemonic: await decryptBackup(legacy, password),
      bunk: null,
      inventoryComplete: false,
      signingAuthorized: false,
    };
  }
  if (!isBunkBackup(input)) throw new Error('Unsupported Bunk backup');
  const payload = await openPayload(input, password);
  if (
    !keys(payload, ['mnemonic', 'bunk']) ||
    typeof payload.mnemonic !== 'string' ||
    !isValidMnemonic(payload.mnemonic)
  )
    throw new Error('Bunk backup is damaged');
  return {
    mnemonic: normalizeMnemonic(payload.mnemonic),
    bunk: checkBunkRecoveryHints(payload.bunk),
    inventoryComplete: false,
    signingAuthorized: false,
  };
}

async function openPayload(
  input: BunkBackup | BunkBackupWithHistory,
  password: string,
): Promise<unknown> {
  // No caller-owned envelope fields are read after awaiting password derivation.
  const { N, r, p } = input.kdf;
  const salt = decoded(input.kdf.salt, 16);
  const nonce = decoded(input.cipher.nonce, 24);
  const ciphertext = decoded(input.data);
  const additional = aad(input.version);
  const key = await passwordKey(password, salt, { N, r, p });
  let plain: Uint8Array | undefined;
  try {
    try {
      plain = xchacha20poly1305(key, nonce, additional).decrypt(ciphertext);
    } catch {
      throw new WrongPasswordError();
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

function archiveCopies(input: unknown): BunkBitcoinJournalArchive[] {
  if (!Array.isArray(input) || input.length > 64)
    throw new Error('Too many Bitcoin backup archives');
  let size = 0;
  const seen = new Set<string>();
  return Array.from(input as unknown[], (value) => {
    const data = (value as { data?: unknown } | null)?.data;
    if (typeof data !== 'string') throw new Error('Invalid Bitcoin backup archive');
    size += data.length;
    if (size > plainLimit(3)) throw new Error('Bitcoin backup archives exceed size limit');
    const archive = checkBunkBitcoinJournalArchive(value);
    if (seen.has(archive.key)) throw new Error('Duplicate Bitcoin backup archive');
    seen.add(archive.key);
    return archive;
  });
}

async function validateArchives(
  mnemonic: string,
  hints: BunkRecoveryHints,
  archives: readonly BunkBitcoinJournalArchive[],
) {
  if (archives.length === 0) return;
  const accounts = new Set(
    hints.accounts.flatMap((h) =>
      h.family === 'bitcoin-v1' ? [`${h.network}:${h.accountIndex}`] : [],
    ),
  );
  await withMnemonicSeed(mnemonic, (seed) => {
    for (const archive of archives) {
      const opened = openBunkBitcoinJournalArchive(archive, seed);
      try {
        if (!accounts.has(`${opened.scope.network}:${opened.scope.accountIndex}`))
          throw new Error('Bitcoin archive is missing its discovery hint');
      } finally {
        opened.store.destroy();
      }
    }
  });
}

/** One password-encrypted file for the phrase, discovery hints and known history.
 * Caller must collect all intended archives; neither snapshots nor an empty list
 * prove complete history. Archive imports remain read-only. Never embed registry pins. */
export async function encryptBunkBackupWithHistory(
  phrase: string,
  hints: BunkRecoveryHints,
  bitcoinJournals: readonly BunkBitcoinJournalArchive[],
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<BunkBackupWithHistory> {
  if (!isValidMnemonic(phrase)) throw new Error('Not a valid recovery phrase');
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  const payload = {
    mnemonic: normalizeMnemonic(phrase),
    bunk: checkBunkRecoveryHints(hints),
    bitcoinJournals: archiveCopies(bitcoinJournals),
  };
  await validateArchives(payload.mnemonic, payload.bunk, payload.bitcoinJournals);
  return sealPayload(3, payload, password, random);
}

/** Collect every hinted Bitcoin account from the unlocked journal store, then
 * produce one version-3 backup. Missing records are reported together, never
 * initialized or silently omitted. Recheck captured rows after encryption and
 * reject concurrent changes. This cannot find accounts absent from the supplied
 * hints or prove freshness after return, and never writes to the source store. */
export async function encryptBunkBackupFromStore(
  phrase: string,
  hints: BunkRecoveryHints,
  store: BunkJournalStore,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<BunkBackupWithHistory> {
  if (!isValidMnemonic(phrase)) throw new Error('Not a valid recovery phrase');
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  const mnemonic = normalizeMnemonic(phrase),
    bunk = checkBunkRecoveryHints(hints),
    accounts = bunk.accounts.filter((hint) => hint.family === 'bitcoin-v1'),
    sourceRead = store.read.bind(store);
  if (accounts.length > 64) throw new Error('Too many Bitcoin backup archives');
  return withMnemonicSeed(mnemonic, async (seed) => {
    const snapshots = new Map<string, BunkJournalSnapshot>();
    const missing: BunkBitcoinJournalScope[] = [];
    let archiveChars = 0;
    try {
      for (const account of accounts) {
        const key = bunkBitcoinAccountJournalKey(seed, account),
          row = await sourceRead(key);
        if (!row) {
          missing.push({ network: account.network, accountIndex: account.accountIndex });
          continue;
        }
        const revision = checkBunkJournalRevision(row.revision),
          value = row.value;
        if (typeof value !== 'string' || value.length > BUNK_JOURNAL_MAX_BYTES)
          throw new Error('Bitcoin backup source exceeds size limit');
        const plain = utf8ToBytes(value);
        try {
          if (plain.length > BUNK_JOURNAL_MAX_BYTES)
            throw new Error('Bitcoin backup source exceeds size limit');
          archiveChars += Math.ceil((plain.length + 40) / 3) * 4;
          if (archiveChars > plainLimit(3))
            throw new Error('Bitcoin backup archives exceed size limit');
        } finally {
          plain.fill(0);
        }
        snapshots.set(key, { revision, value });
      }
      if (missing.length > 0) throw new BunkBackupHistoryMissing(missing);
      const captured: BunkJournalStore = {
        async read(key) {
          const row = snapshots.get(key);
          return row ? { ...row } : null;
        },
        async compareAndSwap() {
          throw new Error('Backup collection cannot write journal history');
        },
      };
      const bitcoinJournals: BunkBitcoinJournalArchive[] = [];
      for (const key of snapshots.keys())
        bitcoinJournals.push(await exportBunkBitcoinJournalArchive(captured, key, seed, random));
      // Derived keys and archive export validate the phrase/account binding for
      // every record. No caller-supplied archive can enter this collection path.
      const file = await sealPayload(3, { mnemonic, bunk, bitcoinJournals }, password, random);
      for (const [key, expected] of snapshots) {
        const current = await sourceRead(key);
        if (!current || current.revision !== expected.revision || current.value !== expected.value)
          throw new BunkJournalConflict('Bitcoin history changed during backup; retry collection');
      }
      return file;
    } finally {
      snapshots.clear();
    }
  });
}

/** Opens all three versions without dropping history or implying it is current.
 * Returned archives are encrypted snapshots: open selected ones with the read-only
 * archive API. No live database writes, RPC, signing or release activation occur. */
export async function decryptBunkBackupWithHistory(
  input: Backup | BunkBackup | BunkBackupWithHistory,
  password: string,
): Promise<BunkBackupWithHistoryContents> {
  if (input?.version === 1 || input?.version === 2) {
    return {
      ...(await decryptBunkBackup(input, password)),
      bitcoinJournals: null,
      historyComplete: false,
    };
  }
  if (!isBunkBackupWithHistory(input)) throw new Error('Unsupported Bunk history backup');
  const payload = await openPayload(input, password);
  if (
    !keys(payload, ['mnemonic', 'bunk', 'bitcoinJournals']) ||
    typeof payload.mnemonic !== 'string' ||
    !isValidMnemonic(payload.mnemonic)
  )
    throw new Error('Bunk history backup is damaged');
  const mnemonic = normalizeMnemonic(payload.mnemonic),
    bunk = checkBunkRecoveryHints(payload.bunk),
    bitcoinJournals = archiveCopies(payload.bitcoinJournals);
  await validateArchives(mnemonic, bunk, bitcoinJournals);
  return {
    mnemonic,
    bunk,
    bitcoinJournals,
    inventoryComplete: false,
    historyComplete: false,
    signingAuthorized: false,
  };
}
