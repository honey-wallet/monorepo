import {
  type Address,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
} from 'viem';
import { BUNK_MAX_INDEX } from './bunk';
import { bunkEvmAddress, bunkEvmHex, bunkEvmIndex } from './bunk-evm';
import {
  type BunkEvmRpc,
  type BunkEvmV3Observation,
  observeBunkEvmV3Account,
} from './bunk-evm-observe';
import { type BunkEvmV3Config, bunkEvmV3Config, bunkEvmV3KeyScope } from './bunk-evm-v3';
import {
  deriveBunkEvmV3DeploymentIdentity,
  deriveBunkEvmV3Owner,
  deriveBunkEvmV3Recovery,
} from './bunk-evm-v3-sign';

export const BUNK_EVM_DISCOVERY_PAGE_LIMIT = 20;
export const BUNK_EVM_DISCOVERY_TOKEN_LIMIT = 32;
/** An application read budget; exhausting it is an error, never a zero balance. */
export const BUNK_EVM_DISCOVERY_TOKEN_GAS = 500_000n;
const balanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
/** Same trusted, bounded transport as the observer, with native balance reads. */
export type BunkEvmDiscoveryRpc = (
  request: Parameters<BunkEvmRpc>[0] | { method: 'eth_getBalance'; params: readonly unknown[] },
) => Promise<unknown>;
export interface BunkEvmV3DiscoveryRequest {
  /** Caller-trusted release metadata, never an unauthenticated backend/RPC response. */
  config: BunkEvmV3Config;
  proxyRuntimeCodeHash: Hex;
  startAccountIndex: number;
  count: number;
  /** Explicit ERC-20 catalog for this chain. Omission scans no tokens.
   * The caller must establish token identity; a balanceOf response cannot do so. */
  erc20Tokens?: readonly Address[];
}
export interface BunkEvmDiscoveryAccess {
  rpc: BunkEvmDiscoveryRpc;
  now: () => number;
  maxFinalizedAgeSeconds: number;
  signal?: AbortSignal;
}
export interface BunkEvmV3DiscoveryCandidate {
  observation: BunkEvmV3Observation;
  nativeBalance: bigint;
  entryPointDeposit: bigint;
  /** Raw amounts for exactly the requested tokens, including zero balances. */
  erc20Balances: { token: Address; balance: bigint }[];
}
export interface BunkEvmV3DiscoveryPage {
  releaseKey: string;
  startAccountIndex: number;
  count: number;
  nextAccountIndex: number | null;
  /** No gap heuristic or token inventory proves that all funds/accounts were found. */
  inventoryComplete: false;
  /** Discovery never reserves an owner or authorizes signing. */
  signingAuthorized: false;
  candidates: BunkEvmV3DiscoveryCandidate[];
}
function requireDiscovery(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Bunk discovery: ${message}`);
}
function quantity(value: unknown): bigint {
  requireDiscovery(
    typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value),
    'invalid balance quantity',
  );
  return BigInt(value as string);
}

/** Scan one explicit page in one trusted release. Undeployed and zero-balance
 * addresses are retained: they may hold tokens, old activity or lost approvals.
 * Any RPC/config/authority failure rejects the whole page, never a false empty result.
 * Callers must paginate every known release and retain sparse account-index hints.
 * Cancellation fences output; the supplied transport must also enforce timeouts. */
export async function discoverBunkEvmV3Accounts(
  seed: Uint8Array,
  input: BunkEvmV3DiscoveryRequest,
  access: BunkEvmDiscoveryAccess,
): Promise<BunkEvmV3DiscoveryPage> {
  requireDiscovery(seed instanceof Uint8Array && seed.length === 64, 'expected 64-byte seed');
  const config = bunkEvmV3Config(input.config),
    proxyHash = bunkEvmHex(input.proxyRuntimeCodeHash, 32),
    start = bunkEvmIndex(input.startAccountIndex),
    count = input.count,
    now = access.now,
    maxAge = access.maxFinalizedAgeSeconds,
    signal = access.signal,
    transport = access.rpc;
  requireDiscovery(proxyHash !== zeroHash && proxyHash !== keccak256('0x'), 'missing proxy hash');
  requireDiscovery(
    Number.isSafeInteger(count) &&
      count > 0 &&
      count <= BUNK_EVM_DISCOVERY_PAGE_LIMIT &&
      start + count - 1 <= BUNK_MAX_INDEX,
    'invalid scan range',
  );
  requireDiscovery(Number.isSafeInteger(maxAge) && maxAge > 0, 'invalid freshness policy');
  const tokenInput = input.erc20Tokens === undefined ? [] : input.erc20Tokens;
  requireDiscovery(
    Array.isArray(tokenInput) && tokenInput.length <= BUNK_EVM_DISCOVERY_TOKEN_LIMIT,
    'invalid ERC-20 token list',
  );
  // Array.from visits sparse entries too; a hole must not silently skip validation.
  const tokens = Array.from(tokenInput, bunkEvmAddress);
  requireDiscovery(new Set(tokens).size === tokens.length, 'duplicate ERC-20 token');
  const check = () => requireDiscovery(!signal?.aborted, 'cancelled');
  const rpc: BunkEvmDiscoveryRpc = async (request) => {
    check();
    const value = await transport(request);
    check();
    return value;
  };
  check();
  const keyScope = bunkEvmV3KeyScope(config),
    ownedSeed = seed.slice();
  try {
    const candidates: BunkEvmV3DiscoveryCandidate[] = [];
    for (let accountIndex = start; accountIndex < start + count; accountIndex++) {
      check();
      const identity = deriveBunkEvmV3DeploymentIdentity(ownedSeed, accountIndex).address;
      const observation = await observeBunkEvmV3Account(rpc, {
        config,
        proxyRuntimeCodeHash: proxyHash,
        deploymentIdentity: identity,
        accountIndex,
        now,
        maxFinalizedAgeSeconds: maxAge,
      });
      check();
      if (observation.status === 'deployed') {
        const ref = {
          chainId: config.chainId,
          keyScope,
          accountIndex,
          epoch: observation.state.epoch,
          ownerIndex: observation.state.ownerIndex,
        };
        requireDiscovery(
          deriveBunkEvmV3Owner(ownedSeed, ref).commitment === observation.state.commitment &&
            deriveBunkEvmV3Recovery(ownedSeed, ref).commitment ===
              observation.state.recoveryCommitment,
          'deployed authority does not match recovery seed',
        );
      }
      const pin = Object.freeze({ blockHash: observation.block.hash, requireCanonical: true });
      const balanceData = encodeFunctionData({
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [observation.account],
      });
      const nativeBalance = quantity(
        await rpc({
          method: 'eth_getBalance',
          params: [observation.account, pin],
        }),
      );
      const deposit = await rpc({
        method: 'eth_call',
        params: [
          {
            to: config.entryPoint.address,
            data: balanceData,
          },
          pin,
        ],
      });
      requireDiscovery(
        typeof deposit === 'string' && /^0x[0-9a-fA-F]{64}$/.test(deposit),
        'invalid EntryPoint deposit',
      );
      const erc20Balances: BunkEvmV3DiscoveryCandidate['erc20Balances'] = [];
      for (const token of tokens) {
        const code = await rpc({ method: 'eth_getCode', params: [token, pin] });
        requireDiscovery(
          typeof code === 'string' &&
            code.length <= 2 + 24576 * 2 &&
            /^0x(?:[0-9a-fA-F]{2})+$/.test(code),
          `missing or invalid ERC-20 code at ${token}`,
        );
        const balance = await rpc({
          method: 'eth_call',
          params: [{ to: token, data: balanceData, gas: toHex(BUNK_EVM_DISCOVERY_TOKEN_GAS) }, pin],
        });
        requireDiscovery(
          typeof balance === 'string' && /^0x[0-9a-fA-F]{64}$/.test(balance),
          `invalid ERC-20 balance at ${token}`,
        );
        erc20Balances.push({ token, balance: BigInt(balance as string) });
      }
      candidates.push({
        observation,
        nativeBalance,
        entryPointDeposit: BigInt(deposit as string),
        erc20Balances,
      });
    }
    // Earlier accounts can become stale/reorged while a later page entry is read.
    const checked = new Set<string>();
    for (const {
      observation: { block },
    } of candidates) {
      if (checked.has(block.hash)) continue;
      checked.add(block.hash);
      const canonical = await rpc({
        method: 'eth_getBlockByNumber',
        params: [toHex(block.number), false],
      });
      requireDiscovery(
        canonical !== null &&
          typeof canonical === 'object' &&
          !Array.isArray(canonical) &&
          (canonical as { hash?: unknown }).hash === block.hash,
        'scan anchor changed or unavailable',
      );
    }
    requireDiscovery(
      quantity(await rpc({ method: 'eth_chainId', params: [] })) === BigInt(config.chainId),
      'chain changed during discovery',
    );
    const time = now();
    requireDiscovery(Number.isSafeInteger(time) && time >= 0, 'invalid caller clock');
    for (const {
      observation: { block },
    } of candidates) {
      const age = BigInt(time) - block.timestamp;
      requireDiscovery(age >= 0n && age <= BigInt(maxAge), 'scan became stale');
    }
    check();
    return {
      releaseKey: `${config.chainId}:${keyScope}`,
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
