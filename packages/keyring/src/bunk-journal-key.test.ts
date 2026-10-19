import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import type { BunkJournalSnapshot, BunkJournalStore } from './bunk-evm-v2-journal';
import { encryptedBunkJournalStore } from './bunk-evm-v2-store';
import { deriveBunkJournalEncryptionKey } from './bunk-journal-key';
import phraseFixture from './fixtures/bunk-evm-v3.json';
import fixture from './fixtures/bunk-journal-key.json';
import { mnemonicToSeed } from './index';

describe('phrase-derived Bunk journal encryption', () => {
  for (const vector of fixture.vectors) {
    it(`matches independent Python RFC5869 vector: ${vector.label}`, () => {
      const seed = hexToBytes(vector.seed);
      expect(bytesToHex(deriveBunkJournalEncryptionKey(seed))).toBe(vector.key);
      expect(bytesToHex(seed)).toBe(vector.seed);
    });
  }

  it('derives the same key from a normalized restored public phrase', async () => {
    const seed = await mnemonicToSeed(`  ${phraseFixture.phrase.toUpperCase()}  `);
    try {
      expect(bytesToHex(deriveBunkJournalEncryptionKey(seed))).toBe(fixture.vectors[1]?.key);
    } finally {
      seed.fill(0);
    }
  });

  it('returns independent buffers and separates different seeds', () => {
    const seed = Uint8Array.from({ length: 64 }, (_, i) => i);
    const first = deriveBunkJournalEncryptionKey(seed);
    const second = deriveBunkJournalEncryptionKey(seed);
    first.fill(0);
    expect(bytesToHex(second)).toBe(fixture.vectors[0]?.key);
    seed[0] = 1;
    expect(deriveBunkJournalEncryptionKey(seed)).not.toEqual(second);
  });

  it('rejects passwords, signing keys and non-byte inputs', () => {
    for (const invalid of [
      new Uint8Array(0),
      new Uint8Array(32),
      new Uint8Array(63),
      new Uint8Array(65),
      'password',
      null,
      Array(64).fill(0),
    ]) {
      expect(() => deriveBunkJournalEncryptionKey(invalid as Uint8Array)).toThrow('64-byte');
    }
  });

  it('reopens encrypted history after key destruction and phrase rederivation', async () => {
    let row: BunkJournalSnapshot | null = null;
    const raw: BunkJournalStore = {
      async read() {
        return row;
      },
      async compareAndSwap(_key, revision, value) {
        if ((row?.revision ?? null) !== revision) return false;
        row = { revision: revision === null ? 0 : revision + 1, value };
        return true;
      },
    };
    const open = async (phrase: string) => {
      const seed = await mnemonicToSeed(phrase);
      const key = deriveBunkJournalEncryptionKey(seed);
      try {
        return encryptedBunkJournalStore(raw, key, randomBytes);
      } finally {
        seed.fill(0);
        key.fill(0);
      }
    };
    const owner = `bunk-v3-account:${'12'.repeat(32)}`;
    const original = await open(phraseFixture.phrase);
    expect(await original.compareAndSwap(owner, null, 'durable recovery plan')).toBe(true);
    expect(JSON.stringify(await raw.read(owner))).not.toContain('durable recovery plan');
    original.destroy();
    await expect(original.read(owner)).rejects.toThrow('locked');
    const restored = await open(phraseFixture.phrase);
    try {
      expect(await restored.read(owner)).toEqual({ revision: 0, value: 'durable recovery plan' });
    } finally {
      restored.destroy();
    }
    const wrong = encryptedBunkJournalStore(
      raw,
      deriveBunkJournalEncryptionKey(new Uint8Array(64).fill(7)),
      randomBytes,
    );
    try {
      await expect(wrong.read(owner)).rejects.toThrow();
    } finally {
      wrong.destroy();
    }
  });
});
