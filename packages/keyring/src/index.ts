import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base58xrp, bech32, createBase58check } from '@scure/base';
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

export type ChainFamily = 'evm' | 'bitcoin' | 'solana' | 'tron' | 'xrp';

export type Addresses = Record<ChainFamily, string>;

/** The derivation path for account `index` on each chain. */
export const PATHS: Record<ChainFamily, (index: number) => string> = {
  // MetaMask, Rabby, Ledger Live: one address for every EVM chain (Ethereum, Base, …).
  evm: (i) => `m/44'/60'/0'/0/${i}`,
  // Native SegWit (bc1q…), BIP-84.
  bitcoin: (i) => `m/84'/0'/0'/0/${i}`,
  // Phantom and Solflare. ed25519 only supports hardened steps (SLIP-10).
  solana: (i) => `m/44'/501'/${i}'/0'`,
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

/** The private key for account `index` on one chain. */
export function privateKeyFor(seed: Uint8Array, chain: ChainFamily, index = 0): Uint8Array {
  const path = PATHS[chain](index);
  if (chain === 'solana') return slip10Ed25519(seed, path);
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error(`No private key at ${path}`);
  return key;
}

/** Account `index`'s address on every chain. */
export function deriveAddresses(seed: Uint8Array, index = 0): Addresses {
  const pub = (chain: ChainFamily) => secp256k1.getPublicKey(privateKeyFor(seed, chain, index));
  return {
    evm: evmAddress(pub('evm')),
    bitcoin: bitcoinAddress(pub('bitcoin')),
    solana: base58.encode(ed25519.getPublicKey(privateKeyFor(seed, 'solana', index))),
    tron: tronAddress(pub('tron')),
    xrp: xrpAddress(pub('xrp')),
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

/** P2WPKH: bech32 of witness version 0 plus hash160(pubkey). */
function bitcoinAddress(pub: Uint8Array) {
  return bech32.encode('bc', [0, ...bech32.toWords(hash160(pub))]);
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
export * from './local-vault';
export * from './networks';
export * from './pairing';
export * from './sign';
