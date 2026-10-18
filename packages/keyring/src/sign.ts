import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import type { Hex, TransactionSerializable, TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Signing for websites (the browser extension): EVM messages, typed data and
 * transactions through viem, and Solana messages and transactions with ed25519.
 * Every function takes the private key for one account (see privateKeyFor) and
 * returns what the site asked for; nothing here touches the network.
 */

const account = (key: Uint8Array) => privateKeyToAccount(`0x${bytesToHex(key)}`);

/**
 * `personal_sign`: sites send the message as hex bytes (usually UTF-8 text), and some
 * send plain text. Both are signed with the "\x19Ethereum Signed Message" prefix.
 */
export async function signEvmMessage(key: Uint8Array, message: string): Promise<Hex> {
  const raw = /^0x([0-9a-f]{2})*$/i.test(message);
  return account(key).signMessage({ message: raw ? { raw: message as Hex } : message });
}

/** `eth_signTypedData_v4` (EIP-712), from the JSON the site sent. */
export async function signEvmTypedData(key: Uint8Array, json: string): Promise<Hex> {
  return account(key).signTypedData(parseTypedData(json));
}

/** The JSON of `eth_signTypedData_v4`, checked enough to show and sign. */
export function parseTypedData(json: string): TypedDataDefinition {
  const typed = JSON.parse(json) as Partial<TypedDataDefinition> & {
    types?: Record<string, unknown>;
  };
  if (!typed || typeof typed !== 'object' || !typed.types || !typed.primaryType) {
    throw new Error('Bad typed data');
  }
  if (!(typed.primaryType in typed.types)) throw new Error('Bad typed data: unknown type');
  return {
    domain: typed.domain ?? {},
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message ?? {},
  } as TypedDataDefinition;
}

/** A filled-in EVM transaction (nonce, gas and fees set), signed and serialized. */
export async function signEvmTransaction(
  key: Uint8Array,
  tx: TransactionSerializable,
): Promise<Hex> {
  return account(key).signTransaction(tx);
}

/** The EVM address of a key, checksummed. */
export const evmAddressOfKey = (key: Uint8Array) => account(key).address;

// Solana

export const solanaAddressOfKey = (key: Uint8Array) => base58.encode(ed25519.getPublicKey(key));

/** `solana:signMessage`: a plain ed25519 signature over the bytes. */
export const signSolanaMessage = (key: Uint8Array, message: Uint8Array) =>
  ed25519.sign(message, key);

/** Solana's compact-u16 length prefix: returns the value and how many bytes it took. */
function shortVec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) throw new Error('Bad Solana transaction');
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  throw new Error('Bad Solana transaction');
}

/**
 * What a serialized transaction (legacy or v0) needs from us: where the signatures are,
 * the message they cover, who must sign it, and who pays the fee.
 */
export function readSolanaTransaction(tx: Uint8Array) {
  const [signatures, prefix] = shortVec(tx, 0);
  const messageAt = prefix + signatures * 64;
  const message = tx.subarray(messageAt);
  // A v0 message starts with 0x80 (the version, with the high bit set); legacy doesn't.
  const versioned = (message[0] ?? 0) & 0x80;
  const header = versioned ? 1 : 0;
  const required = message[header];
  if (required === undefined || required !== signatures) throw new Error('Bad Solana transaction');
  const [keyCount, keyPrefix] = shortVec(message, header + 3);
  const keysAt = header + 3 + keyPrefix;
  if (keyCount < required || message.length < keysAt + keyCount * 32) {
    throw new Error('Bad Solana transaction');
  }
  const signers = Array.from({ length: required }, (_, i) =>
    base58.encode(message.subarray(keysAt + i * 32, keysAt + (i + 1) * 32)),
  );
  return {
    message,
    signers,
    /** The first signer pays the fee. */
    feePayer: signers[0] as string,
    version: versioned ? (message[0] as number) & 0x7f : ('legacy' as const),
    signatureAt: (index: number) => prefix + index * 64,
  };
}

/**
 * `solana:signTransaction`: signs the message with our key and puts the signature in our
 * slot, leaving any other signers' slots as they were. Throws if we aren't a signer.
 */
export function signSolanaTransaction(key: Uint8Array, tx: Uint8Array): Uint8Array {
  const read = readSolanaTransaction(tx);
  const index = read.signers.indexOf(solanaAddressOfKey(key));
  if (index < 0) throw new Error('This transaction isn’t for this wallet');
  const out = tx.slice();
  out.set(ed25519.sign(read.message, key), read.signatureAt(index));
  return out;
}
