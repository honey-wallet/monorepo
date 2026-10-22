import type { Hex } from 'viem';
import { bunkEvmV3KeyScope } from './bunk-evm-v3';
import { type BunkRecoveryHint, checkBunkRecoveryHints } from './bunk-recovery-hints';
import {
  type BunkReleaseEntry,
  type BunkReleaseRegistry,
  loadBunkReleaseRegistry,
} from './bunk-release-registry';

type Hint<F extends BunkRecoveryHint['family']> = Extract<BunkRecoveryHint, { family: F }>;
type Entry<F extends BunkReleaseEntry['family']> = Extract<BunkReleaseEntry, { family: F }>;

export type BunkRecoveryResolution =
  | { kind: 'evm-v3'; hint: Hint<'evm-v3'>; entry: Entry<'evm-v3'> }
  | { kind: 'solana-v1'; hint: Hint<'solana-v1'>; entry: Entry<'solana-v1'> }
  | {
      kind: 'missing-release';
      hint: Hint<'evm-v3'> | Hint<'solana-v1'>;
    };

export interface BunkRecoveryPlan {
  /** False for a legacy phrase-only import; empty v2 hints still set this true. */
  hintsPresent: boolean;
  /** All trusted releases, including ones absent from the hints, remain discoverable. */
  registry: BunkReleaseRegistry;
  /** One result per hint, in input order. Missing releases must remain visible. */
  accounts: BunkRecoveryResolution[];
  inventoryComplete: false;
  signingAuthorized: false;
}

/**
 * Connect decrypted discovery hints to independently pinned release metadata.
 * Pass decryptBunkBackup(...).bunk as input; null means a legacy phrase-only file.
 * The expected pin must come from the app's trust store, never from the backup.
 * A match supplies observer inputs, not proof of deployment or phrase ownership.
 * This performs no network requests, key derivation, journal writes or signing.
 */
export function resolveBunkRecoveryHints(
  input: unknown,
  registryJson: string,
  expectedSha256: Hex,
): BunkRecoveryPlan {
  const hints = input === null ? null : checkBunkRecoveryHints(input);
  const registry = loadBunkReleaseRegistry(registryJson, expectedSha256);
  const evm = new Map<string, Entry<'evm-v3'>>();
  const solana = new Map<string, Entry<'solana-v1'>>();
  for (const entry of registry.entries) {
    if (entry.family === 'evm-v3') {
      evm.set(`${entry.config.chainId}:${bunkEvmV3KeyScope(entry.config)}`, entry);
    } else {
      solana.set(`${entry.release.genesisHash}:${entry.release.program}`, entry);
    }
  }
  const accounts = (hints?.accounts ?? []).map((hint): BunkRecoveryResolution => {
    if (hint.family === 'evm-v3') {
      const entry = evm.get(`${hint.chainId}:${hint.keyScope}`);
      return entry ? { kind: 'evm-v3', hint, entry } : { kind: 'missing-release', hint };
    }
    const entry = solana.get(`${hint.genesisHash}:${hint.program}`);
    return entry ? { kind: 'solana-v1', hint, entry } : { kind: 'missing-release', hint };
  });
  return {
    hintsPresent: hints !== null,
    registry,
    accounts,
    inventoryComplete: false,
    signingAuthorized: false,
  };
}
