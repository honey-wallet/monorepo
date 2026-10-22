import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUNK_MAX_INDEX,
  type BunkNetwork,
  type BunkOwnerRef,
  bunkOwnerPath,
  bunkPrivateKeyFor,
  deriveBunkOwner,
  deriveBunkRotation,
} from './bunk';
import fixture from './fixtures/bunk-v1.json';
import { mnemonicToSeed, privateKeyFor } from './index';

let seed: Uint8Array;
const ref: BunkOwnerRef = {
  network: { family: 'evm', chainId: '1' },
  accountIndex: 0,
  ownerIndex: 0,
};

beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});

describe('Bunk v1 recovery vectors', () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const target = { ...vector, network: vector.network as BunkNetwork };
      expect(bunkOwnerPath(target)).toBe(vector.path);
      const key = bunkPrivateKeyFor(seed, target);
      key.fill(0);
      expect(deriveBunkOwner(seed, target)).toMatchObject({
        derivationVersion: fixture.derivationVersion,
        path: vector.path,
        publicKey: vector.publicKey,
        commitment: vector.commitment,
      });
    });
  }

  it('labels committed derivation vectors synthetic and contains no signing keys', () => {
    expect(fixture.purpose).toBe('synthetic-test-only-never-fund');
    expect(fixture.phrase).not.toBe([...Array(11).fill('abandon'), 'about'].join(' '));
    expect(fixture.vectors.every((vector) => !('privateKey' in vector))).toBe(true);
  });

  it('keeps ordinary wallet branches intact and every Bunk component hardened', () => {
    for (const family of ['evm', 'solana'] as const) {
      const target = fixture.vectors.find((v) => v.network.family === family);
      expect(target).toBeDefined();
      if (!target) throw new Error('Missing fixture');
      const owner = { ...target, network: target.network as BunkNetwork };
      expect(bunkPrivateKeyFor(seed, owner)).not.toEqual(privateKeyFor(seed, family));
      const path = bunkOwnerPath(owner).split('/');
      expect(path).toHaveLength(15);
      expect(path.slice(1).every((part) => /^\d+'$/.test(part))).toBe(true);
    }
  });

  it('separates network, account and owner without truncating large chain IDs', () => {
    const keys = [
      ref,
      { ...ref, accountIndex: 1 },
      { ...ref, ownerIndex: 1 },
      { ...ref, network: { family: 'evm', chainId: '8453' } as const },
      { ...ref, network: { family: 'evm', chainId: (1n + (1n << 255n)).toString() } as const },
    ].map((target) => bytesToHex(bunkPrivateKeyFor(seed, target)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(bunkOwnerPath(ref)).toBe("m/7744'/1'/60'/0'/0'/0'/0'/0'/0'/0'/0'/1'/0'/0'");
  });

  it('returns only public metadata and does not mutate the seed or input', () => {
    const original = seed.slice();
    const network = { family: 'evm' as const, chainId: '1', privateKey: 'do-not-copy' };
    const pair = deriveBunkRotation(seed, { ...ref, network });
    expect(seed).toEqual(original);
    expect(network).toEqual({ family: 'evm', chainId: '1', privateKey: 'do-not-copy' });
    expect(pair.current).toEqual(deriveBunkOwner(seed, ref));
    expect(pair.next).toEqual(deriveBunkOwner(seed, { ...ref, ownerIndex: 1 }));
    expect(pair.current.commitment).not.toBe(pair.next.commitment);
    expect(JSON.stringify(pair)).not.toMatch(/privateKey|do-not-copy|abandon/);
    expect(pair.current.network).toEqual(ref.network);
  });

  it('encodes the EVM commitment as keccak256 of the recovered signer address', () => {
    const owner = deriveBunkOwner(seed, ref);
    const key = bunkPrivateKeyFor(seed, ref);
    const rawAddress = keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20);
    expect(owner.ownerAddress.toLowerCase()).toBe(`0x${bytesToHex(rawAddress)}`);
    expect(owner.commitment).toBe(`0x${bytesToHex(keccak_256(rawAddress))}`);
  });

  it('uses raw ed25519 keys for Solana', () => {
    const vectors = fixture.vectors.filter((v) => v.network.family === 'solana');
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      const owner = deriveBunkOwner(seed, { ...vector, network: vector.network as BunkNetwork });
      const publicKey = hexToBytes(owner.publicKey.slice(2));
      expect(base58.decode(owner.ownerAddress)).toEqual(publicKey);
      expect(owner.commitment).toBe(`0x${bytesToHex(sha256(publicKey))}`);
    }
  });
});

describe('Bunk invalid input and exhaustion', () => {
  it.each([-1, 0.5, NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER])(
    'rejects invalid account and owner index %s',
    (index) => {
      expect(() => bunkOwnerPath({ ...ref, accountIndex: index })).toThrow('Bunk index');
      expect(() => bunkOwnerPath({ ...ref, ownerIndex: index })).toThrow('Bunk index');
    },
  );

  it.each(['0', '-1', '01', '1.0', '1e3', '0x1', ' 1', '', (1n << 256n).toString()])(
    'rejects noncanonical or out-of-range chain ID %s',
    (chainId) => {
      expect(() => bunkOwnerPath({ ...ref, network: { family: 'evm', chainId } })).toThrow();
    },
  );

  it('rejects wrong seed lengths, cluster nicknames and unsupported families/networks', () => {
    for (const length of [0, 16, 32, 63, 65]) {
      expect(() => bunkPrivateKeyFor(new Uint8Array(length), ref)).toThrow('64-byte');
    }
    for (const network of [
      { family: 'solana', genesisHash: 'mainnet-beta' },
      { family: 'solana', genesisHash: '1'.repeat(33) },
      { family: 'evm', chainId: 1 },
      { family: 'bitcoin', network: 'mainnet' },
      { family: 'tron' },
    ]) {
      expect(() => bunkOwnerPath({ ...ref, network: network as BunkNetwork })).toThrow();
    }
  });

  it('never wraps or aliases the terminal owner index', () => {
    expect(() => bunkPrivateKeyFor(seed, { ...ref, ownerIndex: BUNK_MAX_INDEX })).not.toThrow();
    expect(() => deriveBunkRotation(seed, { ...ref, ownerIndex: BUNK_MAX_INDEX })).toThrow(
      'migration',
    );
  });

  it('fails closed if BIP32 skips an invalid child', () => {
    const derive = HDKey.prototype.deriveChild;
    const mock = vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementationOnce(function (
      this: HDKey,
      index,
    ) {
      return derive.call(this, index + 1);
    });
    try {
      expect(() => bunkPrivateKeyFor(seed, ref)).toThrow('skipped a child');
    } finally {
      mock.mockRestore();
    }
  });
});
