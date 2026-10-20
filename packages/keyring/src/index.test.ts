import { describe, expect, it } from 'vitest';
import {
  createMnemonic,
  deriveAddresses,
  evmAddressFromPrivateKey,
  isValidMnemonic,
  mnemonicToSeed,
  privateKeyFor,
  withMnemonicSeed,
} from './index';

// The standard BIP-39 test phrase. Its addresses are published by each chain's
// reference wallets, so a wrong path or encoding shows up as a mismatch here.
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveAddresses', () => {
  it('matches the reference wallets for account 0', async () => {
    const seed = await mnemonicToSeed(PHRASE);
    expect(deriveAddresses(seed)).toEqual({
      evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      near: '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412',
      tron: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
      xrp: 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3',
    });
  });

  it('gives each account its own addresses', async () => {
    const seed = await mnemonicToSeed(PHRASE);
    const [a, b] = [deriveAddresses(seed, 0), deriveAddresses(seed, 1)];
    for (const chain of Object.keys(a) as (keyof typeof a)[]) expect(a[chain]).not.toBe(b[chain]);
    expect(b.evm).toBe('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
  });

  it('clears temporary private keys without mutating the caller-owned seed', async () => {
    const seed = await mnemonicToSeed(PHRASE);
    const before = seed.slice();
    expect(deriveAddresses(seed)).toEqual({
      evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      near: '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412',
      tron: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
      xrp: 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3',
    });
    expect(seed).toEqual(before);
  });

  it('accepts a pasted phrase with stray spaces and capitals', async () => {
    const messy = `  ${PHRASE.toUpperCase().replaceAll(' ', '   ')}\n`;
    expect(deriveAddresses(await mnemonicToSeed(messy))).toEqual(
      deriveAddresses(await mnemonicToSeed(PHRASE)),
    );
  });
});

describe('mnemonics', () => {
  it('creates valid 12-word phrases from the given entropy', () => {
    const phrase = createMnemonic((n) => new Uint8Array(n));
    expect(phrase).toBe(PHRASE);
    expect(isValidMnemonic(createMnemonic((n) => crypto.getRandomValues(new Uint8Array(n))))).toBe(
      true,
    );
  });

  it('rejects a short random source', () => {
    expect(() => createMnemonic(() => new Uint8Array(8))).toThrow();
  });

  it('rejects bad checksums and wrong lengths', () => {
    expect(isValidMnemonic(PHRASE.replace('about', 'abandon'))).toBe(false);
    expect(isValidMnemonic('abandon abandon about')).toBe(false);
    expect(isValidMnemonic(` ${PHRASE.toUpperCase()} `)).toBe(true);
  });
});

describe('temporary mnemonic seed lifecycle', () => {
  it('clears the seed after successful derivation', async () => {
    let observed: Uint8Array | undefined;
    const address = await withMnemonicSeed(PHRASE, (seed) => {
      observed = seed;
      return deriveAddresses(seed).evm;
    });
    expect(address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(observed).toBeDefined();
    expect(observed?.every((byte) => byte === 0)).toBe(true);
  });

  it('clears the seed when the derivation callback fails', async () => {
    let observed: Uint8Array | undefined;
    await expect(
      withMnemonicSeed(PHRASE, (seed) => {
        observed = seed;
        throw new Error('derivation failed');
      }),
    ).rejects.toThrow('derivation failed');
    expect(observed?.every((byte) => byte === 0)).toBe(true);
  });
});

describe('private keys', () => {
  it('round-trips an EVM key to its address', async () => {
    const seed = await mnemonicToSeed(PHRASE);
    const key = privateKeyFor(seed, 'evm');
    const hex = Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(evmAddressFromPrivateKey(`0x${hex}`)).toBe(deriveAddresses(seed).evm);
  });

  it('rejects an out-of-range key', () => {
    expect(() => evmAddressFromPrivateKey('0'.repeat(64))).toThrow();
  });
});
