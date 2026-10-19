import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { type Hex, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX } from './bunk';
import { decryptBunkBackup, encryptBunkBackup } from './bunk-backup';
import type { BunkEvmV3Config } from './bunk-evm-v3';
import type { BunkRecoveryHints } from './bunk-recovery-hints';
import { resolveBunkRecoveryHints } from './bunk-recovery-resolve';
import type { BunkReleaseRegistry } from './bunk-release-registry';
import evm from './fixtures/bunk-evm-v3.json';
import solana from './fixtures/bunk-solana.json';

const pin = (json: string): Hex => `0x${bytesToHex(sha256(utf8ToBytes(json)))}`;
const scope = solana.cases[0]?.scope;
const keyScope = evm.vectors[0]?.keyScope as Hex;
if (!scope || !keyScope) throw new Error('Missing fixtures');
const registry: BunkReleaseRegistry = {
  format: 'honey-bunk-releases',
  version: 1,
  revision: 2,
  entries: [
    {
      id: 'old-evm',
      use: 'restore-only',
      family: 'evm-v3',
      config: { ...evm.config, protocolVersion: 3, chainId: '1' } as BunkEvmV3Config,
      proxyRuntimeCodeHash: keccak256('0x6000'),
    },
    {
      id: 'current-solana',
      use: 'active',
      family: 'solana-v1',
      release: {
        genesisHash: scope.genesisHash,
        program: scope.program,
        programData: base58.encode(new Uint8Array(32).fill(12)),
        codeSha256: pin('local fixture code'),
        codeLength: 18,
        upgradeAuthority: null,
      },
    },
  ],
};
const json = JSON.stringify(registry);
const trustedPin = pin(json);
const hints: BunkRecoveryHints = {
  version: 1,
  accounts: [
    { family: 'evm-v3', accountIndex: 10_000, chainId: '1', keyScope },
    {
      family: 'solana-v1',
      accountIndex: BUNK_MAX_INDEX,
      genesisHash: scope.genesisHash,
      program: scope.program,
    },
    {
      family: 'bitcoin-v1',
      accountIndex: 9,
      network: 'regtest',
      ownerIndices: [0, 87, BUNK_MAX_INDEX],
    },
  ],
};
const resolve = (input: unknown) => resolveBunkRecoveryHints(input, json, trustedPin);

describe('backup hint to trusted release resolution', () => {
  it('resolves both release uses, preserves sparse indices and grants no signing authority', () => {
    const plan = resolve(hints);
    expect(plan.hintsPresent).toBe(true);
    expect(plan.accounts.map((a) => a.kind)).toEqual(['evm-v3', 'solana-v1', 'bitcoin-v1']);
    expect(plan.accounts.map((a) => a.hint)).toEqual(hints.accounts);
    expect(plan.accounts[0]).toMatchObject({ entry: registry.entries[0] });
    expect(plan.accounts[1]).toMatchObject({ entry: registry.entries[1] });
    expect(plan.inventoryComplete).toBe(false);
    expect(plan.signingAuthorized).toBe(false);
  });

  it('keeps every unmatched network and deployment visible without defaulting to another release', () => {
    const unmatched = {
      version: 1,
      accounts: [
        { ...hints.accounts[0], chainId: '10' },
        { ...hints.accounts[0], keyScope: keccak256('0x1234') },
        { ...hints.accounts[1], genesisHash: base58.encode(new Uint8Array(32).fill(17)) },
        { ...hints.accounts[1], program: base58.encode(new Uint8Array(32).fill(18)) },
      ],
    };
    expect(resolve(unmatched).accounts).toEqual(
      unmatched.accounts.map((hint) => ({ kind: 'missing-release', hint })),
    );
    const empty = JSON.stringify({ ...registry, entries: [] });
    expect(resolveBunkRecoveryHints(hints, empty, pin(empty)).accounts.map((a) => a.kind)).toEqual([
      'missing-release',
      'missing-release',
      'bitcoin-v1',
    ]);
  });

  it('distinguishes absent legacy hints from empty metadata and retains every trusted release', () => {
    for (const input of [null, { version: 1, accounts: [] }]) {
      const plan = resolve(input);
      expect(plan.hintsPresent).toBe(input !== null);
      expect(plan.accounts).toEqual([]);
      expect(plan.registry).toEqual(registry);
      expect(plan.inventoryComplete).toBe(false);
      expect(plan.signingAuthorized).toBe(false);
    }
    expect(() => resolve(undefined)).toThrow();
  });

  it('requires the independent exact pin even with absent hints or Bitcoin-only hints', () => {
    for (const input of [hints, null, { version: 1, accounts: [hints.accounts[2]] }]) {
      expect(() => resolveBunkRecoveryHints(input, `${json}\n`, trustedPin)).toThrow(
        'trusted release pin',
      );
      const rollback = json.replace('"revision":2', '"revision":1');
      expect(() => resolveBunkRecoveryHints(input, rollback, trustedPin)).toThrow(
        'trusted release pin',
      );
    }
  });

  it('rejects invalid hints and ambiguous trusted deployments rather than picking the first', () => {
    expect(() => resolve({ ...hints, accounts: [hints.accounts[0], hints.accounts[0]] })).toThrow(
      'Duplicate',
    );
    expect(() => resolve({ ...hints, signingAuthorized: true })).toThrow();
    const duplicate = JSON.stringify({
      ...registry,
      entries: [registry.entries[0], { ...registry.entries[0], id: 'different-name' }],
    });
    expect(() => resolveBunkRecoveryHints(hints, duplicate, pin(duplicate))).toThrow(
      'Duplicate Bunk deployment identity',
    );
  });

  it('does not alias caller-owned hint arrays or a previous resolution', () => {
    const input = structuredClone(hints);
    const bitcoinInput = input.accounts[2];
    const plan = resolve(input);
    input.accounts.length = 0;
    const bitcoin = plan.accounts[2];
    if (bitcoin?.kind !== 'bitcoin-v1') throw new Error('Expected Bitcoin');
    bitcoin.hint.ownerIndices.length = 0;
    expect(bitcoinInput).toEqual(hints.accounts[2]);
    plan.registry.entries.length = 0;
    expect(plan.accounts).toHaveLength(3);
    expect(resolve(hints).accounts[2]).toEqual({ kind: 'bitcoin-v1', hint: hints.accounts[2] });
    expect(resolve(hints).registry).toEqual(registry);
  });

  it('connects an actual encrypted file import to release resolution without RPC or a journal', async () => {
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const backup = await encryptBunkBackup(phrase, hints, 'correct horse', (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const contents = await decryptBunkBackup(JSON.parse(JSON.stringify(backup)), 'correct horse');
    const plan = resolve(contents.bunk);
    expect(contents.mnemonic).toBe(phrase);
    expect(plan.accounts.map((a) => a.hint)).toEqual(hints.accounts);
    expect(plan.accounts[0]).toMatchObject({ kind: 'evm-v3', entry: { use: 'restore-only' } });
    expect(plan.signingAuthorized).toBe(false);
    expect(plan.inventoryComplete).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(phrase);
  }, 15_000);
});
