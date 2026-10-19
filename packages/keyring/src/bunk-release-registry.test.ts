import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { type Hex, keccak256, zeroHash } from 'viem';
import { describe, expect, it } from 'vitest';
import { type BunkEvmV3Config, bunkEvmV3KeyScope } from './bunk-evm-v3';
import {
  type BunkReleaseRegistry,
  checkBunkReleaseRegistryUpdate,
  loadBunkReleaseRegistry,
} from './bunk-release-registry';
import evm from './fixtures/bunk-evm-v3.json';
import solana from './fixtures/bunk-solana.json';

const pin = (json: string): Hex => `0x${bytesToHex(sha256(utf8ToBytes(json)))}`;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
const solanaScope = required(solana.cases[0]).scope;
function registry(): BunkReleaseRegistry {
  return {
    format: 'honey-bunk-releases',
    version: 1,
    revision: 2,
    entries: [
      {
        id: 'local-evm-old',
        use: 'restore-only',
        family: 'evm-v3',
        config: { ...evm.config, protocolVersion: 3, chainId: '1' } as BunkEvmV3Config,
        proxyRuntimeCodeHash: keccak256('0x6000'),
      },
      {
        id: 'local-solana',
        use: 'active',
        family: 'solana-v1',
        release: {
          genesisHash: solanaScope.genesisHash,
          program: solanaScope.program,
          programData: base58.encode(new Uint8Array(32).fill(12)),
          codeSha256: pin('local fixture code'),
          codeLength: 18,
          upgradeAuthority: null,
        },
      },
    ],
  };
}
const load = (value: unknown) => {
  const json = JSON.stringify(value);
  return loadBunkReleaseRegistry(json, pin(json));
};

describe('trusted Bunk release manifest', () => {
  it('retains both active and superseded release inputs without changing derivation scope', () => {
    const input = registry();
    const result = load(input);
    expect(result).toEqual(input);
    const old = required(result.entries[0]);
    expect(old.use).toBe('restore-only');
    if (old.family !== 'evm-v3') throw new Error('Expected EVM');
    expect(bunkEvmV3KeyScope(old.config)).toBe(required(evm.vectors[0]).keyScope);
    expect(result.entries[1]).not.toBe(input.entries[1]);
  });

  it('authenticates exact bytes and rejects tampering, whitespace changes and rollback', () => {
    const current = JSON.stringify(registry());
    const trusted = pin(current);
    for (const altered of [
      `${current}\n`,
      current.replace('restore-only', 'active'),
      current.replace('"revision":2', '"revision":1'),
      current.slice(0, -1),
    ]) {
      expect(() => loadBunkReleaseRegistry(altered, trusted)).toThrow('trusted release pin');
    }
    for (const invalid of ['0x1234', trusted.toUpperCase(), zeroHash, null])
      expect(() => loadBunkReleaseRegistry(current, invalid as Hex)).toThrow('trusted release pin');
  });

  it('bounds byte size and release count, permitting an explicit empty registry', () => {
    const empty = { ...registry(), entries: [] };
    expect(load(empty).entries).toEqual([]);
    expect(() => load({ ...empty, entries: Array(257).fill(registry().entries[0]) })).toThrow();
    for (const json of ['', ' '.repeat(1024 * 1024 + 1), 'é'.repeat(600_000)])
      expect(() => loadBunkReleaseRegistry(json, pin(json))).toThrow('size limit');
  });

  it('rejects malformed JSON, unknown versions, unsafe revisions and extra fields', () => {
    expect(() => loadBunkReleaseRegistry('{', pin('{'))).toThrow();
    for (const input of [
      null,
      [],
      { ...registry(), format: 'other' },
      { ...registry(), version: 2 },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'].map((revision) => ({
        ...registry(),
        revision,
      })),
      { ...registry(), rpcUrl: 'https://untrusted.example' },
      { ...registry(), entries: {} },
    ])
      expect(() => load(input)).toThrow();
  });

  it('rejects unknown protocols, IDs and creation policy instead of silently dropping entries', () => {
    for (const change of [
      { family: 'evm-v2' },
      { id: '' },
      { id: 'a'.repeat(65) },
      { id: '../release' },
      { use: 'retired' },
      { rpcUrl: 'https://untrusted.example' },
    ]) {
      const r = registry();
      r.entries[0] = { ...r.entries[0], ...change } as never;
      expect(() => load(r)).toThrow();
    }
    expect(() => load({ ...registry(), entries: [null] })).toThrow();
  });

  it('rejects duplicate IDs and conflicting metadata for the same deployment', () => {
    const r = registry();
    required(r.entries[1]).id = required(r.entries[0]).id;
    expect(() => load(r)).toThrow('duplicate Bunk release ID');
    for (const original of registry().entries) {
      const duplicate = structuredClone(original);
      duplicate.id = 'another-label';
      duplicate.use = 'active';
      if (duplicate.family === 'evm-v3') duplicate.proxyRuntimeCodeHash = keccak256('0x6001');
      else duplicate.release.codeSha256 = pin('different code');
      expect(() => load({ ...registry(), entries: [original, duplicate] })).toThrow(
        'Duplicate Bunk deployment identity',
      );
    }
  });

  it('applies EVM code, address, protocol and chain validation to authenticated metadata', () => {
    for (const change of [
      { protocolVersion: 2 },
      { chainId: 1 },
      { proxyCreationCode: '0x' },
      { factory: { ...evm.config.factory, codeHash: zeroHash } },
      { factory: { ...evm.config.factory, extra: true } },
      { extra: true },
    ]) {
      const r = registry();
      const e = required(r.entries[0]);
      if (e.family !== 'evm-v3') throw new Error('Expected EVM');
      e.config = { ...e.config, ...change } as never;
      expect(() => load(r)).toThrow();
    }
    for (const proxyRuntimeCodeHash of [zeroHash, keccak256('0x'), '0x12']) {
      const r = registry();
      r.entries[0] = { ...r.entries[0], proxyRuntimeCodeHash } as never;
      expect(() => load(r)).toThrow();
    }
  });

  it('applies Solana network, program and code validation without accepting self-attestation', () => {
    for (const change of [
      { genesisHash: 'bad' },
      { programData: solanaScope.program },
      { codeSha256: zeroHash },
      { codeLength: 0 },
      { upgradeAuthority: 'bad' },
      { extra: true },
    ]) {
      const r = registry();
      const e = required(r.entries[1]);
      if (e.family !== 'solana-v1') throw new Error('Expected Solana');
      e.release = { ...e.release, ...change };
      expect(() => load(r)).toThrow();
    }
  });
});

describe('Bunk registry update retention', () => {
  const check = (previous: BunkReleaseRegistry, next: BunkReleaseRegistry) => {
    const oldJson = JSON.stringify(previous),
      nextJson = JSON.stringify(next);
    return checkBunkReleaseRegistryUpdate(oldJson, pin(oldJson), nextJson, pin(nextJson));
  };
  it('preserves retired deployments while reporting new networks and policy changes', () => {
    const previous = registry(),
      next = structuredClone(previous);
    next.revision++;
    required(next.entries[1]).use = 'restore-only';
    const newNetwork = structuredClone(required(next.entries[0]));
    if (newNetwork.family !== 'evm-v3') throw Error('Expected EVM');
    newNetwork.id = 'new-network';
    newNetwork.use = 'active';
    newNetwork.config.chainId = '10';
    next.entries.push(newNetwork);
    const result = check(previous, next);
    expect(result.registry).toEqual(next);
    expect(result.added).toEqual([newNetwork]);
    expect(result.changed).toEqual([{ previous: previous.entries[1], next: next.entries[1] }]);
    expect(result.registry.entries[0]?.use).toBe('restore-only');
  });
  it.each([0, 1])(
    'rejects removing old deployment %i even with independently matching pins',
    (index) => {
      const previous = registry(),
        next = structuredClone(previous);
      next.revision++;
      const removed = next.entries.splice(index, 1)[0];
      expect(() => check(previous, next)).toThrow(`removes recovery releases: ${removed?.id}`);
      expect(() => check(previous, { ...next, entries: [] })).toThrow('removes recovery releases');
    },
  );
  it('matches identities rather than labels and detects an identity replacement behind an unchanged ID', () => {
    const previous = registry(),
      next = structuredClone(previous);
    next.revision++;
    required(next.entries[0]).id = 'renamed-old-release';
    expect(check(previous, next).changed).toHaveLength(1);
    const replaced = required(next.entries[0]);
    if (replaced.family !== 'evm-v3') throw Error('Expected EVM');
    replaced.config.chainId = '10';
    expect(() => check(previous, next)).toThrow('local-evm-old');
  });
  it('reports code-policy changes and reactivation without hiding them as unchanged identities', () => {
    const previous = registry(),
      next = structuredClone(previous);
    next.revision++;
    const evmEntry = required(next.entries[0]),
      solanaEntry = required(next.entries[1]);
    if (evmEntry.family !== 'evm-v3' || solanaEntry.family !== 'solana-v1')
      throw Error('Bad fixture');
    evmEntry.use = 'active';
    evmEntry.proxyRuntimeCodeHash = keccak256('0x6001');
    solanaEntry.release.codeSha256 = pin('reviewed new code');
    solanaEntry.release.upgradeAuthority = solanaScope.program;
    const result = check(previous, next);
    expect(result.added).toEqual([]);
    expect(result.changed).toEqual(
      previous.entries.map((entry, i) => ({ previous: entry, next: next.entries[i] })),
    );
  });
  it('requires a monotonic revision and both artifact pins', () => {
    const previous = registry();
    for (const revision of [1, 2])
      expect(() => check(previous, { ...previous, revision })).toThrow('increase revision');
    const oldJson = JSON.stringify(previous),
      nextJson = JSON.stringify({ ...previous, revision: 3 });
    expect(() =>
      checkBunkReleaseRegistryUpdate(oldJson, zeroHash, nextJson, pin(nextJson)),
    ).toThrow('trusted release pin');
    expect(() => checkBunkReleaseRegistryUpdate(oldJson, pin(oldJson), nextJson, zeroHash)).toThrow(
      'trusted release pin',
    );
  });
  it('allows an empty starting registry and no-op entries in a newer revision', () => {
    const next = registry(),
      empty = { ...next, revision: 1, entries: [] };
    expect(check(empty, next).added).toEqual(next.entries);
    expect(check(next, { ...next, revision: 3 })).toMatchObject({ added: [], changed: [] });
  });
});
