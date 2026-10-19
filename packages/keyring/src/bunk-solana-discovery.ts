import { BUNK_MAX_INDEX } from './bunk';
import { deriveBunkSolanaKey } from './bunk-solana';
import {
  type BunkSolanaAccess,
  type BunkSolanaObservation,
  type BunkSolanaRelease,
  checkBunkSolanaRelease,
  observeBunkSolanaAccount,
} from './bunk-solana-observe';
import { type BunkSolanaTokenSnapshot, readBunkSolanaTokenSnapshots } from './bunk-solana-tokens';

export type {
  BunkSolanaMint,
  BunkSolanaMintSnapshot,
  BunkSolanaTokenAccount,
  BunkSolanaTokenSnapshot,
} from './bunk-solana-tokens';
export { BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT, BUNK_SOLANA_TOKEN_PROGRAMS } from './bunk-solana-tokens';

export const BUNK_SOLANA_DISCOVERY_PAGE_LIMIT = 20;
export interface BunkSolanaDiscoveryRequest {
  /** Caller-trusted release metadata; do not discover this from an untrusted RPC. */
  release: BunkSolanaRelease;
  startAccountIndex: number;
  count: number;
  /** Query both SPL Token programs; each result carries its own finalized checkpoint. */
  includeTokenAccounts?: boolean;
}
export interface BunkSolanaDiscoveryCandidate extends BunkSolanaObservation {
  /** null means not requested; an empty accounts array means a successful empty read. */
  tokenAccounts: BunkSolanaTokenSnapshot[] | null;
}
export interface BunkSolanaDiscoveryPage {
  releaseKey: string;
  startAccountIndex: number;
  count: number;
  nextAccountIndex: number | null;
  inventoryComplete: false;
  signingAuthorized: false;
  candidates: BunkSolanaDiscoveryCandidate[];
}
function requireDiscovery(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Bunk Solana discovery: ${message}`);
}

/** Scan an explicit account-index page without a backend or journal. Empty and
 * prefunded undeployed addresses are retained; neither proves absence of tokens
 * or past approvals. Restore through the journal before signing. RPC failures
 * reject the whole page. Transport implementations must impose their own timeout. */
export async function discoverBunkSolanaAccounts(
  seed: Uint8Array,
  input: BunkSolanaDiscoveryRequest,
  access: BunkSolanaAccess & { signal?: AbortSignal },
): Promise<BunkSolanaDiscoveryPage> {
  requireDiscovery(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const release = checkBunkSolanaRelease(input.release),
    start = input.startAccountIndex,
    count = input.count,
    now = access.now,
    maxAge = access.maxFinalizedAgeSeconds,
    signal = access.signal,
    request = access.rpc.request.bind(access.rpc),
    includeTokens = input.includeTokenAccounts === undefined ? false : input.includeTokenAccounts;
  requireDiscovery(typeof includeTokens === 'boolean', 'invalid token discovery option');
  requireDiscovery(
    Number.isSafeInteger(start) &&
      start >= 0 &&
      start <= BUNK_MAX_INDEX &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      count <= BUNK_SOLANA_DISCOVERY_PAGE_LIMIT &&
      start + count - 1 <= BUNK_MAX_INDEX,
    'invalid scan range',
  );
  requireDiscovery(
    Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 3600,
    'invalid freshness policy',
  );
  const check = () => requireDiscovery(!signal?.aborted, 'cancelled');
  const rpc = {
    async request(method: string, params: readonly unknown[]) {
      check();
      const value = await request(method, params);
      check();
      return value;
    },
  };
  check();
  const ownedSeed = seed.slice();
  try {
    const candidates: BunkSolanaDiscoveryCandidate[] = [];
    for (let accountIndex = start; accountIndex < start + count; accountIndex++) {
      check();
      const scope = { genesisHash: release.genesisHash, program: release.program, accountIndex };
      const identity = deriveBunkSolanaKey(ownedSeed, { ...scope, role: 'deployment' }).publicKey;
      const observation = await observeBunkSolanaAccount(release, identity, accountIndex, {
        rpc,
        now,
        maxFinalizedAgeSeconds: maxAge,
      });
      if (observation.state) {
        const { epoch, ownerIndex, owner, recovery } = observation.state;
        requireDiscovery(
          deriveBunkSolanaKey(ownedSeed, { ...scope, role: 'owner', epoch, ownerIndex })
            .commitment === owner &&
            deriveBunkSolanaKey(ownedSeed, { ...scope, role: 'recovery', epoch }).commitment ===
              recovery,
          'deployed authority does not match recovery seed',
        );
      }
      const tokenAccounts = includeTokens
        ? await readBunkSolanaTokenSnapshots(observation.wallet, observation.checkpoint.slot, rpc)
        : null;
      candidates.push({ ...observation, tokenAccounts });
    }
    // A later account read must not hide an earlier anchor changing or aging out.
    const checked = new Map<number, string>();
    const checkpoints = candidates.flatMap((candidate) => [
      candidate.checkpoint,
      ...(candidate.tokenAccounts ?? []).flatMap((snapshot) => [
        snapshot.checkpoint,
        ...snapshot.mintSnapshots.map((mint) => mint.checkpoint),
      ]),
    ]);
    for (const checkpoint of checkpoints) {
      const fingerprint = `${checkpoint.blockhash}:${checkpoint.blockTime}`;
      if (checked.has(checkpoint.slot)) {
        requireDiscovery(checked.get(checkpoint.slot) === fingerprint, 'inconsistent scan anchor');
        continue;
      }
      const block = await rpc.request('getBlock', [
        checkpoint.slot,
        {
          commitment: 'finalized',
          transactionDetails: 'none',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      requireDiscovery(
        block !== null &&
          typeof block === 'object' &&
          !Array.isArray(block) &&
          (block as { blockhash?: unknown }).blockhash === checkpoint.blockhash &&
          (block as { blockTime?: unknown }).blockTime === checkpoint.blockTime,
        'scan anchor changed or unavailable',
      );
      checked.set(checkpoint.slot, fingerprint);
    }
    requireDiscovery(
      (await rpc.request('getGenesisHash', [])) === release.genesisHash,
      'chain changed during discovery',
    );
    const time = now();
    requireDiscovery(Number.isSafeInteger(time) && time >= 0, 'invalid caller clock');
    for (const checkpoint of checkpoints)
      requireDiscovery(
        checkpoint.blockTime <= time + 5 && time - checkpoint.blockTime <= maxAge,
        'scan became stale',
      );
    check();
    return {
      releaseKey: `${release.genesisHash}:${release.program}`,
      startAccountIndex: start,
      count,
      nextAccountIndex: start + count > BUNK_MAX_INDEX ? null : start + count,
      inventoryComplete: false,
      signingAuthorized: false,
      candidates,
    };
  } finally {
    ownedSeed.fill(0);
  }
}
