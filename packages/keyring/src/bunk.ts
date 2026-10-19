import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { getAddress } from 'viem';

/** Recovery format: never change these paths or encodings without a migration. */
export const BUNK_DERIVATION_VERSION = 1 as const;
export const BUNK_MAX_INDEX = 0x7fffffff;

export type BunkNetwork =
  | { family: 'evm'; chainId: string }
  | { family: 'solana'; genesisHash: string }
  | { family: 'bitcoin'; network: 'mainnet' | 'testnet' | 'signet' | 'regtest' };

export interface BunkOwnerRef {
  network: BunkNetwork;
  accountIndex: number;
  ownerIndex: number;
}

/** Public metadata only. ownerAddress is NOT the Safe/PDA account address. */
export interface BunkOwnerDescriptor {
  derivationVersion: typeof BUNK_DERIVATION_VERSION;
  network: BunkNetwork;
  accountIndex: number;
  ownerIndex: number;
  path: string;
  /** SEC1 compressed secp256k1 or raw 32-byte ed25519, lowercase 0x hex. */
  publicKey: `0x${string}`;
  ownerAddress: string;
  /** EVM: keccak256(address bytes); Solana: SHA256(raw public key).
   * Bitcoin: HASH160(compressed public key), the 20-byte P2WPKH witness program. */
  commitment: `0x${string}`;
}

function checkedIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > BUNK_MAX_INDEX) {
    throw new Error('Bunk index must be an integer from 0 to 2147483647');
  }
  return index;
}

function networkIdentity(network: BunkNetwork): { coin: number; id: bigint } {
  switch (network.family) {
    case 'evm': {
      // Decimal string avoids precision loss and JSON bigint ambiguity.
      if (typeof network.chainId !== 'string' || !/^[1-9][0-9]{0,77}$/.test(network.chainId)) {
        throw new Error('Bunk EVM chain ID must be canonical positive decimal');
      }
      const id = BigInt(network.chainId);
      if (id >= 1n << 256n) throw new Error('Bunk EVM chain ID exceeds uint256');
      return { coin: 60, id };
    }
    case 'solana': {
      if (
        typeof network.genesisHash !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(network.genesisHash)
      ) {
        throw new Error('Bunk Solana network needs its full base58 genesis hash');
      }
      const bytes = base58.decode(network.genesisHash);
      if (bytes.length !== 32 || base58.encode(bytes) !== network.genesisHash) {
        throw new Error('Bunk Solana genesis hash must encode exactly 32 bytes');
      }
      return { coin: 501, id: BigInt(`0x${bytesToHex(bytes)}`) };
    }
    case 'bitcoin': {
      const id = { mainnet: 0n, testnet: 1n, signet: 2n, regtest: 3n }[network.network];
      if (typeof id !== 'bigint') throw new Error('Unsupported Bunk Bitcoin network');
      return { coin: 0, id };
    }
    default:
      throw new Error('Unsupported Bunk chain family');
  }
}

/** Fixed-width, big-endian base-2^31 network ID: no hashing or truncation.
 * Nine hardened components encode the full uint256 EVM ID / Solana genesis hash.
 * Leading zero components are required and are part of the recovery format. */
function pathComponents(ref: BunkOwnerRef): number[] {
  const { coin, id } = networkIdentity(ref.network);
  const networkParts = Array.from({ length: 9 }, (_, i) =>
    Number((id >> BigInt((8 - i) * 31)) & 0x7fffffffn),
  );
  return [
    7744,
    BUNK_DERIVATION_VERSION,
    coin,
    ...networkParts,
    checkedIndex(ref.accountIndex),
    checkedIndex(ref.ownerIndex),
  ];
}

export function bunkOwnerPath(ref: BunkOwnerRef): string {
  return `m/${pathComponents(ref)
    .map((index) => `${index}'`)
    .join('/')}`;
}

/** Caller owns and must clear the returned secret after use. No state is advanced.
 * This primitive does not authorize reuse or general website-message signing. */
export function bunkPrivateKeyFor(seed: Uint8Array, ref: BunkOwnerRef): Uint8Array {
  if (!(seed instanceof Uint8Array) || seed.length !== 64) {
    throw new Error('Bunk requires a 64-byte BIP-39 seed');
  }
  const parts = pathComponents(ref);
  if (ref.network.family === 'solana') {
    let node = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
    try {
      for (const part of parts) {
        const data = new Uint8Array(37);
        try {
          data.set(node.subarray(0, 32), 1);
          new DataView(data.buffer).setUint32(33, part + 0x80000000);
          const next = hmac(sha512, node.subarray(32), data);
          node.fill(0);
          node = next;
        } finally {
          data.fill(0);
        }
      }
      return node.slice(0, 32);
    } finally {
      node.fill(0);
    }
  }
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const part of parts) {
      const next = node.deriveChild(part + 0x80000000);
      node.wipePrivateData();
      node = next;
      // BIP32 can skip an invalid child. A skip must never alias adjacent owner indices.
      if (node.index !== part + 0x80000000) throw new Error('Bunk derivation skipped a child');
    }
    const key = node.privateKey;
    if (!key) throw new Error('Bunk private key derivation failed');
    return key.slice();
  } finally {
    node.wipePrivateData();
  }
}

const hex = (bytes: Uint8Array): `0x${string}` => `0x${bytesToHex(bytes)}`;

/** Derive metadata suitable for backup/tracking; never returns a seed or private key. */
export function deriveBunkOwner(seed: Uint8Array, ref: BunkOwnerRef): BunkOwnerDescriptor {
  const key = bunkPrivateKeyFor(seed, ref);
  try {
    let publicKey: Uint8Array;
    let ownerAddress: string;
    let commitment: Uint8Array;
    if (ref.network.family === 'solana') {
      publicKey = ed25519.getPublicKey(key);
      ownerAddress = base58.encode(publicKey);
      commitment = sha256(publicKey);
    } else {
      publicKey = secp256k1.getPublicKey(key, true);
      if (ref.network.family === 'evm') {
        const addressBytes = keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).slice(-20);
        ownerAddress = getAddress(hex(addressBytes));
        commitment = keccak_256(addressBytes);
      } else {
        commitment = ripemd160(sha256(publicKey));
        const prefix =
          ref.network.network === 'mainnet'
            ? 'bc'
            : ref.network.network === 'regtest'
              ? 'bcrt'
              : 'tb';
        ownerAddress = bech32.encode(prefix, [0, ...bech32.toWords(commitment)]);
      }
    }
    return {
      derivationVersion: BUNK_DERIVATION_VERSION,
      network:
        ref.network.family === 'evm'
          ? { family: 'evm', chainId: ref.network.chainId }
          : ref.network.family === 'solana'
            ? { family: 'solana', genesisHash: ref.network.genesisHash }
            : { family: 'bitcoin', network: ref.network.network },
      accountIndex: ref.accountIndex,
      ownerIndex: ref.ownerIndex,
      path: bunkOwnerPath(ref),
      publicKey: hex(publicKey),
      ownerAddress,
      commitment: hex(commitment),
    };
  } finally {
    key.fill(0);
  }
}

/** Public current/next pair. The confirmed chain state, not this call, consumes a key. */
export function deriveBunkRotation(seed: Uint8Array, ref: BunkOwnerRef) {
  if (checkedIndex(ref.ownerIndex) === BUNK_MAX_INDEX) {
    throw new Error('Bunk owner branch exhausted; account migration is required');
  }
  return {
    current: deriveBunkOwner(seed, ref),
    next: deriveBunkOwner(seed, { ...ref, ownerIndex: ref.ownerIndex + 1 }),
  };
}
