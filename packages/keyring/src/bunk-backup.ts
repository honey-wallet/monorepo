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
import { type BunkRecoveryHints, checkBunkRecoveryHints } from './bunk-recovery-hints';
import { isValidMnemonic, normalizeMnemonic } from './index';
import { passwordKey } from './kdf';

/** Separate version: old phrase-only readers must reject rather than drop Bunk hints. */
export type BunkBackup = Omit<Backup, 'version'> & { version: 2 };
export interface BunkBackupContents {
  mnemonic: string;
  /** Null explicitly means a legacy phrase-only file, not complete discovery. */
  bunk: BunkRecoveryHints | null;
  inventoryComplete: false;
  signingAuthorized: false;
}
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;
const PLAIN_LIMIT = 512 * 1024;
const AAD = utf8ToBytes('honey-backup-v2');

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
  if (
    !keys(value, ['app', 'version', 'kdf', 'cipher', 'data', 'createdAt']) ||
    value.app !== 'honey' ||
    value.version !== 2 ||
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
    value.data.length > Math.ceil((PLAIN_LIMIT + 16) / 3) * 4 ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return false;
  try {
    decoded(salt, 16);
    decoded(nonce, 24);
    const data = decoded(value.data);
    return data.length >= 16 && data.length <= PLAIN_LIMIT + 16;
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
  return sealPayload(payload, password, random);
}

async function sealPayload(
  payload: unknown,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<BunkBackup> {
  const salt = Uint8Array.from(random(16));
  const nonce = Uint8Array.from(random(24));
  if (salt.length !== 16 || nonce.length !== 24) throw new Error('Invalid backup randomness');
  const plain = utf8ToBytes(JSON.stringify(payload));
  if (plain.length > PLAIN_LIMIT) {
    plain.fill(0);
    throw new Error('Bunk backup exceeds size limit');
  }
  let key: Uint8Array | undefined;
  try {
    key = await passwordKey(password, salt, SCRYPT);
    return {
      app: 'honey',
      version: 2,
      kdf: { name: 'scrypt', ...SCRYPT, salt: base64.encode(salt) },
      cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
      data: base64.encode(xchacha20poly1305(key, nonce, AAD).encrypt(plain)),
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
    bunk: checkBunkRecoveryHints(withoutRetiredHints(payload.bunk)),
    inventoryComplete: false,
    signingAuthorized: false,
  };
}

/** Bitcoin was removed (2026-10-22): older files may still list `bitcoin-v1`
 * discovery hints. Drop them so the phrase and remaining hints still import. */
function withoutRetiredHints(bunk: unknown): unknown {
  if (!keys(bunk, ['version', 'accounts']) || !Array.isArray(bunk.accounts)) return bunk;
  return {
    ...bunk,
    accounts: bunk.accounts.filter(
      (hint) => (hint as { family?: unknown } | null)?.family !== 'bitcoin-v1',
    ),
  };
}

async function openPayload(input: BunkBackup, password: string): Promise<unknown> {
  // No caller-owned envelope fields are read after awaiting password derivation.
  const { N, r, p } = input.kdf;
  const salt = decoded(input.kdf.salt, 16);
  const nonce = decoded(input.cipher.nonce, 24);
  const ciphertext = decoded(input.data);
  const key = await passwordKey(password, salt, { N, r, p });
  let plain: Uint8Array | undefined;
  try {
    try {
      plain = xchacha20poly1305(key, nonce, AAD).decrypt(ciphertext);
    } catch {
      throw new WrongPasswordError();
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}
