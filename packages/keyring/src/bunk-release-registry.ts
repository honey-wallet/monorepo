import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { type Hex, keccak256, zeroHash } from 'viem';
import { bunkEvmHex } from './bunk-evm';
import { type BunkEvmV3Config, bunkEvmV3Config, bunkEvmV3KeyScope } from './bunk-evm-v3';
import { type BunkSolanaRelease, checkBunkSolanaRelease } from './bunk-solana-observe';

export type BunkReleaseEntry = {
  id: string;
  /** Restore-only entries must remain discoverable but cannot create new accounts. */
  use: 'active' | 'restore-only';
} & (
  | { family: 'evm-v3'; config: BunkEvmV3Config; proxyRuntimeCodeHash: Hex }
  | { family: 'solana-v1'; release: BunkSolanaRelease }
);

export interface BunkReleaseRegistry {
  format: 'honey-bunk-releases';
  version: 1;
  revision: number;
  entries: BunkReleaseEntry[];
}

function releaseIdentity(entry: BunkReleaseEntry): string {
  return entry.family === 'evm-v3'
    ? `${entry.family}:${entry.config.chainId}:${bunkEvmV3KeyScope(entry.config)}`
    : `${entry.family}:${entry.release.genesisHash}:${entry.release.program}`;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Bunk registry object');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  )
    throw new Error('Unknown or missing Bunk registry field');
  return record;
}

/**
 * Authenticate exact UTF-8 JSON bytes against an independently trusted app pin.
 * Never take expectedSha256 from the same server, RPC or imported backup as json.
 * This performs no RPC, signing, storage, deployment or release activation.
 */
export function loadBunkReleaseRegistry(json: string, expectedSha256: Hex): BunkReleaseRegistry {
  const maxBytes = 1024 * 1024;
  if (typeof json !== 'string' || json.length === 0 || json.length > maxBytes)
    throw new Error('Bunk registry exceeds size limit');
  const bytes = utf8ToBytes(json);
  if (bytes.length > maxBytes) throw new Error('Bunk registry exceeds size limit');
  if (
    typeof expectedSha256 !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(expectedSha256) ||
    `0x${bytesToHex(sha256(bytes))}` !== expectedSha256
  )
    throw new Error('Bunk registry does not match trusted release pin');
  const root = object(JSON.parse(json), ['format', 'version', 'revision', 'entries']);
  if (
    root.format !== 'honey-bunk-releases' ||
    root.version !== 1 ||
    typeof root.revision !== 'number' ||
    !Number.isSafeInteger(root.revision) ||
    root.revision < 1 ||
    !Array.isArray(root.entries) ||
    root.entries.length > 256
  )
    throw new Error('Invalid Bunk registry header');
  const ids = new Set<string>();
  const identities = new Set<string>();
  const entries = (root.entries as unknown[]).map((input): BunkReleaseEntry => {
    const family = (input as Record<string, unknown> | null)?.family;
    if (family !== 'evm-v3' && family !== 'solana-v1')
      throw new Error('Unsupported Bunk registry protocol');
    const entry = object(
      input,
      family === 'evm-v3'
        ? ['id', 'use', 'family', 'config', 'proxyRuntimeCodeHash']
        : ['id', 'use', 'family', 'release'],
    );
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) ||
      ids.has(entry.id) ||
      (entry.use !== 'active' && entry.use !== 'restore-only')
    )
      throw new Error('Invalid or duplicate Bunk release ID/use');
    ids.add(entry.id);
    const common: Pick<BunkReleaseEntry, 'id' | 'use'> = { id: entry.id, use: entry.use };
    let result: BunkReleaseEntry;
    if (family === 'evm-v3') {
      const configInput = object(entry.config, [
        'protocolVersion',
        'chainId',
        'factory',
        'singleton',
        'proxyFactory',
        'entryPoint',
        'module',
        'helper',
        'proxyCreationCode',
      ]);
      for (const name of ['factory', 'singleton', 'proxyFactory', 'entryPoint', 'module', 'helper'])
        object(configInput[name], ['address', 'codeHash']);
      const config = bunkEvmV3Config(configInput as unknown as BunkEvmV3Config);
      const proxyRuntimeCodeHash = bunkEvmHex(entry.proxyRuntimeCodeHash as Hex, 32);
      if (proxyRuntimeCodeHash === zeroHash || proxyRuntimeCodeHash === keccak256('0x'))
        throw new Error('Missing Bunk proxy runtime identity');
      result = { ...common, family, config, proxyRuntimeCodeHash };
    } else {
      const releaseInput = object(entry.release, [
        'genesisHash',
        'program',
        'programData',
        'codeSha256',
        'codeLength',
        'upgradeAuthority',
      ]);
      const release = checkBunkSolanaRelease(releaseInput as unknown as BunkSolanaRelease);
      result = { ...common, family, release };
    }
    const identity = releaseIdentity(result);
    if (identities.has(identity)) throw new Error('Duplicate Bunk deployment identity');
    identities.add(identity);
    return result;
  });
  return { format: 'honey-bunk-releases', version: 1, revision: root.revision, entries };
}

export interface BunkReleaseRegistryUpdate {
  registry: BunkReleaseRegistry;
  added: BunkReleaseEntry[];
  /** Includes label/use changes and in-place code/upgrade-policy changes for review. */
  changed: { previous: BunkReleaseEntry; next: BunkReleaseEntry }[];
}

/** Offline release review: authenticate both artifacts, require a newer revision
 * and retain every previously published deployment identity for recovery.
 * Both pins must be independently trusted. This neither verifies deployments nor
 * approves changed policies, publishes a manifest, changes an app pin or signs.
 * Publishers must retain their full release history; one previous artifact cannot
 * reveal identities that were already omitted before it. */
export function checkBunkReleaseRegistryUpdate(
  previousJson: string,
  previousPin: Hex,
  nextJson: string,
  nextPin: Hex,
): BunkReleaseRegistryUpdate {
  const previous = loadBunkReleaseRegistry(previousJson, previousPin);
  const registry = loadBunkReleaseRegistry(nextJson, nextPin);
  if (registry.revision <= previous.revision)
    throw new Error('Bunk registry update must increase revision');
  const oldEntries = new Map(previous.entries.map((entry) => [releaseIdentity(entry), entry]));
  const nextEntries = new Map(registry.entries.map((entry) => [releaseIdentity(entry), entry]));
  const removed = previous.entries.filter((entry) => !nextEntries.has(releaseIdentity(entry)));
  if (removed.length)
    throw new Error(
      `Bunk registry update removes recovery releases: ${removed.map((entry) => entry.id).join(', ')}`,
    );
  const added: BunkReleaseEntry[] = [];
  const changed: BunkReleaseRegistryUpdate['changed'] = [];
  for (const entry of registry.entries) {
    const old = oldEntries.get(releaseIdentity(entry));
    if (!old) added.push(entry);
    else if (JSON.stringify(old) !== JSON.stringify(entry))
      changed.push({ previous: old, next: entry });
  }
  return { registry, added, changed };
}
