import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { parseTransaction, recoverMessageAddress, recoverTransactionAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  evmAddressOfKey,
  readSolanaTransaction,
  signEvmMessage,
  signEvmTransaction,
  signEvmTypedData,
  signSolanaMessage,
  signSolanaTransaction,
  solanaAddressOfKey,
} from './sign';

// The key from EIP-712's own example: keccak256("cow").
const COW = keccak_256(utf8ToBytes('cow'));

const MAIL = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

describe('EVM signing', () => {
  it('signs EIP-712 typed data exactly as the spec example', async () => {
    expect(evmAddressOfKey(COW)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
    expect(await signEvmTypedData(COW, JSON.stringify(MAIL))).toBe(
      '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d' +
        '07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562' +
        '1c',
    );
  });

  it('rejects typed data without a known primary type', async () => {
    await expect(
      signEvmTypedData(COW, JSON.stringify({ ...MAIL, primaryType: 'Nope' })),
    ).rejects.toThrow('Bad typed data');
    await expect(signEvmTypedData(COW, '{}')).rejects.toThrow('Bad typed data');
  });

  it('signs personal_sign messages sent as hex or as text the same way', async () => {
    const hex = await signEvmMessage(COW, '0x68656c6c6f');
    expect(await signEvmMessage(COW, 'hello')).toBe(hex);
    expect(await recoverMessageAddress({ message: 'hello', signature: hex })).toBe(
      evmAddressOfKey(COW),
    );
  });

  it('signs an EIP-1559 transaction the network can recover', async () => {
    const signed = await signEvmTransaction(COW, {
      type: 'eip1559',
      chainId: 8453,
      nonce: 7,
      to: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
      value: 10n ** 15n,
      data: '0x',
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    expect(parseTransaction(signed)).toMatchObject({ chainId: 8453, nonce: 7, value: 10n ** 15n });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(
      evmAddressOfKey(COW),
    );
  });
});

/** A minimal transaction: `signers` must sign, then `extra` read-only keys, one instruction. */
function solanaTx(signers: Uint8Array[], extra: Uint8Array[], { v0 = false } = {}) {
  const keys = [...signers, ...extra];
  const message = [
    ...(v0 ? [0x80] : []),
    signers.length,
    0,
    extra.length,
    keys.length,
    ...keys.flatMap((k) => [...k]),
    ...new Uint8Array(32), // recent blockhash
    1, // one instruction
    keys.length - 1, // program id index
    0, // no accounts
    0, // no data
    ...(v0 ? [0] : []), // no address table lookups
  ];
  return Uint8Array.from([signers.length, ...new Uint8Array(64 * signers.length), ...message]);
}

describe('Solana signing', () => {
  const ours = hexToBytes('11'.repeat(32));
  const payer = hexToBytes('22'.repeat(32));
  const program = new Uint8Array(32);
  const pub = (key: Uint8Array) => ed25519.getPublicKey(key);

  it('signs a message with ed25519', () => {
    const message = utf8ToBytes('Sign in to example.com');
    expect(ed25519.verify(signSolanaMessage(ours, message), message, pub(ours))).toBe(true);
    expect(solanaAddressOfKey(ours)).toBe(base58.encode(pub(ours)));
  });

  for (const v0 of [false, true]) {
    it(`signs our slot of a ${v0 ? 'v0' : 'legacy'} transaction and leaves the others`, () => {
      const tx = solanaTx([pub(payer), pub(ours)], [program], { v0 });
      const read = readSolanaTransaction(tx);
      expect(read.feePayer).toBe(base58.encode(pub(payer)));
      expect(read.version).toBe(v0 ? 0 : 'legacy');
      const signed = signSolanaTransaction(ours, tx);
      expect(signed.subarray(1, 65)).toEqual(new Uint8Array(64));
      expect(ed25519.verify(signed.subarray(65, 129), read.message, pub(ours))).toBe(true);
      expect(signed.subarray(129)).toEqual(tx.subarray(129));
    });
  }

  it('refuses a transaction this wallet doesn’t sign, and garbage', () => {
    expect(() => signSolanaTransaction(ours, solanaTx([pub(payer)], [program]))).toThrow(
      'isn’t for this wallet',
    );
    expect(() => readSolanaTransaction(Uint8Array.of(1, 2, 3))).toThrow('Bad Solana transaction');
  });
});
