import type { Hex } from 'viem';
import { BUNK_MAX_INDEX, bunkOwnerPath } from './bunk';
import type { BunkBitcoinNetwork } from './bunk-bitcoin';
import { BUNK_SOLANA_SYSTEM, bunkSolanaAddressBytes } from './bunk-solana';

/** Discovery locations only: never a key-use counter, journal or signing authority. */
export type BunkRecoveryHint = { accountIndex: number } & (
  | { family: 'evm-v3'; chainId: string; keyScope: Hex }
  | { family: 'solana-v1'; genesisHash: string; program: string }
  | { family: 'bitcoin-v1'; network: BunkBitcoinNetwork; ownerIndices: number[] }
);
export interface BunkRecoveryHints {
  version: 1;
  accounts: BunkRecoveryHint[];
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Bunk recovery hints');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || !keys.every((key) => Object.hasOwn(r, key)))
    throw new Error('Unknown or missing Bunk recovery hint field');
  return r;
}
function index(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > BUNK_MAX_INDEX
  )
    throw new Error('Invalid Bunk recovery index');
  return value;
}

/** Validate and copy untrusted metadata before encryption or after authenticated import. */
export function checkBunkRecoveryHints(input: unknown): BunkRecoveryHints {
  const root = record(input, ['version', 'accounts']);
  if (root.version !== 1 || !Array.isArray(root.accounts) || root.accounts.length > 1024)
    throw new Error('Unsupported Bunk recovery hints');
  const seen = new Set<string>();
  let ownerCount = 0;
  const accounts = Array.from(root.accounts as unknown[], (value): BunkRecoveryHint => {
    const family = (value as Record<string, unknown> | null)?.family;
    let hint: BunkRecoveryHint;
    let identity: string;
    if (family === 'evm-v3') {
      const r = record(value, ['family', 'accountIndex', 'chainId', 'keyScope']);
      const accountIndex = index(r.accountIndex);
      const chainId = r.chainId as string;
      bunkOwnerPath({ network: { family: 'evm', chainId }, accountIndex, ownerIndex: 0 });
      if (
        typeof r.keyScope !== 'string' ||
        !/^0x[0-9a-f]{64}$/.test(r.keyScope) ||
        r.keyScope === `0x${'0'.repeat(64)}`
      )
        throw new Error('Invalid Bunk recovery key scope');
      hint = { family, accountIndex, chainId, keyScope: r.keyScope as Hex };
      identity = `${family}:${chainId}:${r.keyScope}:${accountIndex}`;
    } else if (family === 'solana-v1') {
      const r = record(value, ['family', 'accountIndex', 'genesisHash', 'program']);
      const accountIndex = index(r.accountIndex);
      const genesisHash = r.genesisHash as string;
      const program = r.program as string;
      bunkSolanaAddressBytes(genesisHash);
      bunkSolanaAddressBytes(program);
      if ([genesisHash, program].includes(BUNK_SOLANA_SYSTEM))
        throw new Error('Invalid Bunk recovery Solana identity');
      hint = { family, accountIndex, genesisHash, program };
      identity = `${family}:${genesisHash}:${program}:${accountIndex}`;
    } else if (family === 'bitcoin-v1') {
      const r = record(value, ['family', 'accountIndex', 'network', 'ownerIndices']);
      const accountIndex = index(r.accountIndex);
      const network = r.network as BunkBitcoinNetwork;
      bunkOwnerPath({ network: { family: 'bitcoin', network }, accountIndex, ownerIndex: 0 });
      if (!Array.isArray(r.ownerIndices) || r.ownerIndices.length > 4096 - ownerCount)
        throw new Error('Too many Bunk recovery owner indices');
      ownerCount += r.ownerIndices.length;
      const ownerIndices = Array.from(r.ownerIndices as unknown[], index);
      if (ownerIndices.some((n, i) => i > 0 && n <= (ownerIndices[i - 1] as number)))
        throw new Error('Bunk recovery owner indices must be sorted and unique');
      hint = { family, accountIndex, network, ownerIndices };
      identity = `${family}:${network}:${accountIndex}`;
    } else throw new Error('Unsupported Bunk recovery protocol');
    if (seen.has(identity)) throw new Error('Duplicate Bunk recovery account');
    seen.add(identity);
    return hint;
  });
  return { version: 1, accounts };
}
