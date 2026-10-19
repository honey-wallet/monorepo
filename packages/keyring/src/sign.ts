import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import {
  type Hex,
  type TransactionSerializable,
  type TypedDataDefinition,
  verifyTypedData,
} from 'viem';
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

/** Offline EOA verification for recovery of an already admitted typed signature.
 * No RPC, key access or signing. Contract-wallet signatures are not supported. */
export async function verifyEvmTypedDataSignature(
  address: string,
  json: string,
  signature: string,
): Promise<boolean> {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)
  )
    return false;
  return verifyTypedData({
    ...parseTypedData(json),
    address: address as Hex,
    signature: signature as Hex,
  });
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
  if (signatures > 255) throw new Error('Bad Solana transaction');
  const messageAt = prefix + signatures * 64;
  if (messageAt >= tx.length) throw new Error('Bad Solana transaction');
  const message = tx.subarray(messageAt);
  // A v0 message starts with 0x80 (the version, with the high bit set); legacy doesn't.
  const versioned = (message[0] ?? 0) & 0x80;
  const header = versioned ? 1 : 0;
  if (versioned && ((message[0] as number) & 0x7f) !== 0) {
    throw new Error('Unsupported Solana transaction version');
  }
  const required = message[header];
  const readonlySigned = message[header + 1];
  const readonlyUnsigned = message[header + 2];
  if (
    required === undefined ||
    readonlySigned === undefined ||
    readonlyUnsigned === undefined ||
    required !== signatures ||
    readonlySigned > required
  ) {
    throw new Error('Bad Solana transaction');
  }
  let at = header + 3;
  const [keyCount, keyPrefix] = shortVec(message, at);
  at += keyPrefix;
  if (
    keyCount < required ||
    keyCount > 256 ||
    readonlyUnsigned > keyCount - required ||
    message.length < at + keyCount * 32 + 32
  ) {
    throw new Error('Bad Solana transaction');
  }
  const keys = Array.from({ length: keyCount }, (_, i) =>
    base58.encode(message.subarray(at + i * 32, at + (i + 1) * 32)),
  );
  at += keyCount * 32 + 32; // account keys and recent blockhash
  const [instructionCount, instructionPrefix] = shortVec(message, at);
  at += instructionPrefix;
  if (instructionCount > 256) throw new Error('Bad Solana transaction');
  const instructions: {
    programIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
  }[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIndex = message[at++];
    if (programIndex === undefined) throw new Error('Bad Solana transaction');
    const [accountCount, accountPrefix] = shortVec(message, at);
    at += accountPrefix;
    if (accountCount > 256 || at + accountCount > message.length) {
      throw new Error('Bad Solana transaction');
    }
    const accountIndexes = Array.from(message.subarray(at, at + accountCount));
    at += accountCount;
    const [dataLength, dataPrefix] = shortVec(message, at);
    at += dataPrefix;
    if (dataLength > message.length - at) throw new Error('Bad Solana transaction');
    const data = message.slice(at, at + dataLength);
    at += dataLength;
    instructions.push({ programIndex, accountIndexes, data });
  }
  let lookupCount = 0;
  if (versioned) {
    const [count, countPrefix] = shortVec(message, at);
    at += countPrefix;
    lookupCount = count;
    if (lookupCount > 256) throw new Error('Bad Solana transaction');
    for (let i = 0; i < lookupCount; i++) {
      if (message.length < at + 32) throw new Error('Bad Solana transaction');
      at += 32; // lookup table address
      const [writableCount, writablePrefix] = shortVec(message, at);
      at += writablePrefix;
      if (writableCount > 256 || message.length < at + writableCount) {
        throw new Error('Bad Solana transaction');
      }
      at += writableCount;
      const [readonlyCount, readonlyPrefix] = shortVec(message, at);
      at += readonlyPrefix;
      if (readonlyCount > 256 || message.length < at + readonlyCount) {
        throw new Error('Bad Solana transaction');
      }
      at += readonlyCount;
    }
  }
  if (at !== message.length) throw new Error('Bad Solana transaction');
  const signers = keys.slice(0, required);
  return {
    message,
    signers,
    keys,
    instructions,
    lookupCount,
    /** The first signer pays the fee. */
    feePayer: signers[0] as string,
    version: versioned ? (message[0] as number) & 0x7f : ('legacy' as const),
    signatureAt: (index: number) => prefix + index * 64,
  };
}

export type SolanaReviewedInstruction =
  | { kind: 'solTransfer'; from: string; to: string; lamports: bigint }
  | { kind: 'computeUnitLimit'; units: number }
  | { kind: 'computeUnitPrice'; microLamports: bigint }
  | { kind: 'unknown'; program: string | null; data: Uint8Array };

/**
 * A deliberately small dApp review allowlist. Only ordinary System Program SOL
 * transfers and the two common compute-budget settings are understood. Address-table
 * lookups and every other program instruction remain opaque and must not be signed by
 * a dApp approval flow until Honey can explain their effects.
 */
export function reviewSolanaTransaction(tx: Uint8Array) {
  const read = readSolanaTransaction(tx);
  const systemProgram = '11111111111111111111111111111111';
  const computeBudgetProgram = 'ComputeBudget111111111111111111111111111111';
  const instructions: SolanaReviewedInstruction[] = read.instructions.map((instruction) => {
    const program = read.keys[instruction.programIndex] ?? null;
    const accounts = instruction.accountIndexes.map((index) => read.keys[index] ?? null);
    if (
      program === systemProgram &&
      instruction.data.length === 12 &&
      new DataView(instruction.data.buffer, instruction.data.byteOffset, 4).getUint32(0, true) ===
        2 &&
      accounts.length === 2 &&
      accounts[0] &&
      accounts[1]
    ) {
      return {
        kind: 'solTransfer',
        from: accounts[0],
        to: accounts[1],
        lamports: new DataView(
          instruction.data.buffer,
          instruction.data.byteOffset + 4,
          8,
        ).getBigUint64(0, true),
      };
    }
    if (program === computeBudgetProgram && accounts.length === 0) {
      const view = new DataView(
        instruction.data.buffer,
        instruction.data.byteOffset,
        instruction.data.byteLength,
      );
      if (instruction.data.length === 5 && instruction.data[0] === 2) {
        return { kind: 'computeUnitLimit', units: view.getUint32(1, true) };
      }
      if (instruction.data.length === 9 && instruction.data[0] === 3) {
        return { kind: 'computeUnitPrice', microLamports: view.getBigUint64(1, true) };
      }
    }
    return { kind: 'unknown', program, data: instruction.data };
  });
  return {
    ...read,
    reviewedInstructions: instructions,
    reviewable:
      read.lookupCount === 0 && instructions.every((instruction) => instruction.kind !== 'unknown'),
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
