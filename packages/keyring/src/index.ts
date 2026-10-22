import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base58xrp, createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeed as seedOf, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * One recovery phrase, one address per chain. Every chain derives from the same
 * BIP-39 seed along the path the popular wallet for that chain uses, so a phrase
 * imported from MetaMask, Phantom, Trust or a Ledger shows the same addresses here.
 *
 * Shared by the mobile app and the extension: both must derive identical addresses,
 * so this is the only place that knows the paths.
 */

export type ChainFamily = 'evm' | 'solana' | 'near' | 'tron' | 'xrp';

export type Addresses = Record<ChainFamily, string>;

/** The derivation path for account `index` on each chain. */
export const PATHS: Record<ChainFamily, (index: number) => string> = {
  // MetaMask, Rabby, Ledger Live: one address for every EVM chain (Ethereum, Base, …).
  evm: (i) => `m/44'/60'/0'/0/${i}`,
  // Phantom and Solflare. ed25519 only supports hardened steps (SLIP-10).
  solana: (i) => `m/44'/501'/${i}'/0'`,
  // NEAR seed phrase / near-cli default, with one hardened account per index.
  near: (i) => `m/44'/397'/${i}'`,
  tron: (i) => `m/44'/195'/0'/0/${i}`,
  xrp: (i) => `m/44'/144'/0'/0/${i}`,
};

/**
 * A new 12-word phrase. `random` must be a cryptographically secure source
 * (expo-crypto's getRandomBytes on mobile, crypto.getRandomValues in the extension);
 * it's passed in so this package never depends on a platform's RNG.
 */
export function createMnemonic(random: (bytes: number) => Uint8Array): string {
  const entropy = random(16);
  if (entropy.length !== 16) throw new Error('random() must return 16 bytes');
  return entropyToMnemonic(entropy, wordlist);
}

/** Lowercases and collapses whitespace, so a pasted phrase checks out like a typed one. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

/** True for a 12 or 24 word English phrase with a valid checksum. */
export function isValidMnemonic(phrase: string): boolean {
  const words = normalizeMnemonic(phrase).split(' ');
  return (
    (words.length === 12 || words.length === 24) && validateMnemonic(words.join(' '), wordlist)
  );
}

/** The 64-byte seed behind every address. Slow by design (2048 rounds of PBKDF2). */
export function mnemonicToSeed(phrase: string): Promise<Uint8Array> {
  return seedOf(normalizeMnemonic(phrase));
}

/** Derives from a mnemonic and always clears its temporary seed buffer afterward. */
export async function withMnemonicSeed<T>(
  phrase: string,
  derive: (seed: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const seed = await mnemonicToSeed(phrase);
  try {
    return await derive(seed);
  } finally {
    seed.fill(0);
  }
}

/** The private key for account `index` on one chain. */
export function privateKeyFor(seed: Uint8Array, chain: ChainFamily, index = 0): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000)
    throw new Error('Invalid account index');
  const path = PATHS[chain](index);
  if (chain === 'solana' || chain === 'near') return slip10Ed25519(seed, path);
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error(`No private key at ${path}`);
  return key;
}

/** Account `index`'s address on every chain. */
export function deriveAddresses(seed: Uint8Array, index = 0): Addresses {
  const evmPublicKey = (chain: ChainFamily) => {
    const privateKey = privateKeyFor(seed, chain, index);
    try {
      return secp256k1.getPublicKey(privateKey);
    } finally {
      privateKey.fill(0);
    }
  };
  const solanaPrivateKey = privateKeyFor(seed, 'solana', index);
  let solanaPublicKey: Uint8Array;
  try {
    solanaPublicKey = ed25519.getPublicKey(solanaPrivateKey);
  } finally {
    solanaPrivateKey.fill(0);
  }
  const nearPrivateKey = privateKeyFor(seed, 'near', index);
  let nearPublicKey: Uint8Array;
  try {
    nearPublicKey = ed25519.getPublicKey(nearPrivateKey);
  } finally {
    nearPrivateKey.fill(0);
  }
  return {
    evm: evmAddress(evmPublicKey('evm')),
    solana: base58.encode(solanaPublicKey),
    near: bytesToHex(nearPublicKey),
    tron: tronAddress(evmPublicKey('tron')),
    xrp: xrpAddress(evmPublicKey('xrp')),
  };
}

/** The EVM address for a raw private key (64 hex characters, 0x optional). */
export function evmAddressFromPrivateKey(hex: string): string {
  const key = hexToBytes(hex.trim().replace(/^0x/i, ''));
  if (!secp256k1.utils.isValidSecretKey(key)) throw new Error('Invalid private key');
  return evmAddress(secp256k1.getPublicKey(key));
}

// Addresses

const hash160 = (bytes: Uint8Array) => ripemd160(sha256(bytes));

/** keccak256 of the uncompressed public key (without its 0x04 prefix), last 20 bytes. */
function keccakId(compressed: Uint8Array) {
  const full = secp256k1.Point.fromBytes(compressed).toBytes(false);
  return keccak_256(full.subarray(1)).subarray(-20);
}

/** EIP-55 mixed-case checksum address. */
function evmAddress(pub: Uint8Array) {
  const hex = bytesToHex(keccakId(pub));
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? hex[i]?.toUpperCase() : hex[i];
  }
  return out;
}

const base58check = createBase58check(sha256);

/** 0x41 plus the same 20 bytes an EVM address uses, in base58check (T…). */
function tronAddress(pub: Uint8Array) {
  return base58check.encode(concat(Uint8Array.of(0x41), keccakId(pub)));
}

/** Account ID 0x00 plus hash160(pubkey), base58check in Ripple's alphabet (r…). */
function xrpAddress(pub: Uint8Array) {
  const payload = concat(Uint8Array.of(0x00), hash160(pub));
  return base58xrp.encode(concat(payload, sha256(sha256(payload)).subarray(0, 4)));
}

// SLIP-10 for ed25519: every step is hardened, and the key is the left half of an
// HMAC-SHA512 chain seeded with "ed25519 seed".

function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let node = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  for (const step of path.split('/').slice(1)) {
    if (!step.endsWith("'")) throw new Error(`ed25519 needs hardened steps: ${path}`);
    const index = (Number.parseInt(step, 10) + 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data.set(node.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, index);
    node = hmac(sha512, node.subarray(32), data);
  }
  return node.subarray(0, 32);
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export * from './backup';
export * from './bunk';
export * from './bunk-backup';
export * from './bunk-evm';
export * from './bunk-evm-observe';
export * from './bunk-evm-sign';
export * from './bunk-evm-v2';
export * from './bunk-evm-v2-journal';
export * from './bunk-evm-v2-sign';
export * from './bunk-evm-v2-store';
export * from './bunk-evm-v3';
export * from './bunk-evm-v3-account';
export * from './bunk-evm-v3-discovery';
export * from './bunk-evm-v3-sign';
export * from './bunk-indexeddb-store';
export * from './bunk-journal-key';
export * from './bunk-recovery-hints';
export * from './bunk-recovery-resolve';
export * from './bunk-release-registry';
export {
  BUNK_SOLANA_DERIVATION_VERSION,
  BUNK_SOLANA_ED25519,
  BUNK_SOLANA_INSTRUCTIONS,
  BUNK_SOLANA_SYSTEM,
  type BunkSolanaAccount,
  type BunkSolanaAction,
  type BunkSolanaHash,
  type BunkSolanaInstruction,
  type BunkSolanaKey,
  type BunkSolanaKeyRef,
  type BunkSolanaMeta,
  type BunkSolanaPrepared,
  type BunkSolanaScope,
  type BunkSolanaState,
  bunkSolanaAddressBytes,
  bunkSolanaDigest,
  bunkSolanaKeyPath,
  bunkSolanaPrecompile,
  bunkSolanaSpent,
  bunkSolanaWallet,
  decodeBunkSolanaState,
  deriveBunkSolanaKey,
  prepareBunkSolanaExecution,
  prepareBunkSolanaInitialization,
  prepareBunkSolanaRecovery,
} from './bunk-solana';
export * from './bunk-solana-discovery';
export * from './bunk-solana-journal';
export * from './bunk-solana-observe';
export * from './local-vault';
export * from './near';
export * from './networks';
export * from './pairing';
export * from './sign';
