import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroHash,
} from 'viem';
import {
  type BunkEvmConfig,
  bunkEvmAddress,
  bunkEvmConfig,
  bunkEvmConfigHash,
  bunkEvmHex,
  bunkEvmIndex,
  bunkEvmInitializer,
  bunkEvmUint,
  predictBunkEvmAccount,
} from './bunk-evm';
import type { BunkEvmSigningState } from './bunk-evm-sign';
import { type BunkEvmV2Config, bunkEvmV2Config, predictBunkEvmV2Account } from './bunk-evm-v2';
import type { BunkEvmV2SigningState } from './bunk-evm-v2-sign';
import { type BunkEvmV3Config, bunkEvmV3Config, predictBunkEvmV3Account } from './bunk-evm-v3';
import type { BunkEvmV3SigningState } from './bunk-evm-v3-sign';

/** Transport must enforce its own timeout/response-size limits and trusted RPC policy. */
export type BunkEvmRpc = (request: {
  method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getCode' | 'eth_call';
  params: readonly unknown[];
}) => Promise<unknown>;
export interface BunkEvmObservationRequest {
  config: BunkEvmConfig;
  /** Release-pinned SafeProxy runtime hash, not a hash learned from this RPC. */
  proxyRuntimeCodeHash: Hex;
  deploymentIdentity: Address;
  accountIndex: number;
  /** Caller clock in Unix seconds; used at completion as well as before reading. */
  now: () => number;
  maxFinalizedAgeSeconds: number;
}
export interface BunkEvmObservedBlock {
  hash: Hex;
  number: bigint;
  timestamp: bigint;
}
export type BunkEvmObservation = {
  config: BunkEvmConfig;
  block: BunkEvmObservedBlock;
  account: Address;
  accountIndex: number;
} & ({ status: 'undeployed' } | { status: 'deployed'; state: BunkEvmSigningState });

const SENTINEL = '0x0000000000000000000000000000000000000001';
const FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n;
const GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n;
function requireState(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`Bunk observation: ${detail}`);
}
function data(value: unknown, maxBytes: number): Hex {
  requireState(typeof value === 'string' && value.length <= 2 + maxBytes * 2, 'invalid RPC data');
  return bunkEvmHex(value as Hex);
}
function quantity(value: unknown): bigint {
  requireState(
    typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value),
    'invalid RPC quantity',
  );
  return BigInt(value);
}
function block(value: unknown): BunkEvmObservedBlock {
  requireState(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'missing finalized block',
  );
  const b = value as Record<string, unknown>;
  const hash = bunkEvmHex(data(b.hash, 32), 32);
  requireState(hash !== zeroHash, 'missing block hash');
  return { hash, number: quantity(b.number), timestamp: quantity(b.timestamp) };
}
function equal(a: unknown, b: unknown, detail: string) {
  requireState(
    typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(),
    detail,
  );
}

/**
 * Fail-closed finalized snapshot. No latest/safe fallback. EIP-1898 pins every state read.
 * This authenticates consistency against a caller-trusted registry and RPC, not consensus.
 * It does not reserve an owner key or rule out operations newer than the finalized block.
 */
export async function observeBunkEvmAccount(
  rpc: BunkEvmRpc,
  input: BunkEvmObservationRequest,
): Promise<BunkEvmObservation> {
  return observeAccount(rpc, input, 1);
}

export interface BunkEvmV2ObservationRequest extends BunkEvmObservationRequest {
  config: BunkEvmV2Config;
}
export type BunkEvmV2Observation = Omit<BunkEvmObservation, 'config' | 'status' | 'state'> & {
  protocolVersion: 2;
  config: BunkEvmV2Config;
} & ({ status: 'undeployed' } | { status: 'deployed'; state: BunkEvmV2SigningState });
/** The same finalized/code/authority checks, with explicit v2 prediction and tagged state. */
export async function observeBunkEvmV2Account(
  rpc: BunkEvmRpc,
  input: BunkEvmV2ObservationRequest,
): Promise<BunkEvmV2Observation> {
  const config = bunkEvmV2Config(input.config);
  const result = await observeAccount(rpc, { ...input, config }, 2);
  const common = {
    config,
    protocolVersion: 2 as const,
    block: result.block,
    account: result.account,
    accountIndex: result.accountIndex,
  };
  return result.status === 'undeployed'
    ? { ...common, status: 'undeployed' }
    : {
        ...common,
        status: 'deployed',
        state: { ...result.state, protocolVersion: 2, deployed: true },
      };
}

export interface BunkEvmV3ObservationRequest extends BunkEvmObservationRequest {
  config: BunkEvmV3Config;
}
export type BunkEvmV3Observation = Omit<BunkEvmObservation, 'config' | 'status' | 'state'> & {
  protocolVersion: 3;
  config: BunkEvmV3Config;
} & ({ status: 'undeployed' } | { status: 'deployed'; state: BunkEvmV3SigningState });
/** Owner and recovery state are read at the SAME finalized canonical hash. Epoch,
 * ordinary index and EntryPoint nonce are independent; none is inferred from another. */
export async function observeBunkEvmV3Account(
  rpc: BunkEvmRpc,
  input: BunkEvmV3ObservationRequest,
): Promise<BunkEvmV3Observation> {
  const config = bunkEvmV3Config(input.config);
  const result = await observeAccount(rpc, { ...input, config }, 3);
  const common = {
    config,
    protocolVersion: 3 as const,
    block: result.block,
    account: result.account,
    accountIndex: result.accountIndex,
  };
  if (result.status === 'undeployed') return { ...common, status: 'undeployed' };
  requireState(result.recovery !== undefined, 'missing recovery state');
  return {
    ...common,
    status: 'deployed',
    state: { ...result.state, ...result.recovery, protocolVersion: 3, deployed: true },
  };
}
type InternalObservation = BunkEvmObservation & {
  recovery?: { epoch: number; recoveryCommitment: Hex };
};

async function observeAccount(
  rpc: BunkEvmRpc,
  input: BunkEvmObservationRequest,
  version: 1 | 2 | 3,
): Promise<InternalObservation> {
  // Copy all caller inputs before the first await.
  const config =
    version === 3
      ? bunkEvmV3Config(input.config as BunkEvmV3Config)
      : version === 2
        ? bunkEvmV2Config(input.config as BunkEvmV2Config)
        : bunkEvmConfig(input.config);
  const proxyHash = bunkEvmHex(input.proxyRuntimeCodeHash, 32);
  requireState(
    proxyHash !== zeroHash && proxyHash !== keccak256('0x'),
    'missing proxy code identity',
  );
  const identity = bunkEvmAddress(input.deploymentIdentity);
  const accountIndex = bunkEvmIndex(input.accountIndex);
  const account =
    version === 3
      ? predictBunkEvmV3Account(config as BunkEvmV3Config, identity, accountIndex)
      : version === 2
        ? predictBunkEvmV2Account(config as BunkEvmV2Config, identity, accountIndex)
        : predictBunkEvmAccount(config, identity, accountIndex);
  const maxAge = input.maxFinalizedAgeSeconds,
    now = input.now;
  requireState(Number.isSafeInteger(maxAge) && maxAge > 0, 'invalid freshness policy');
  const fresh = (b: BunkEvmObservedBlock) => {
    const time = now();
    requireState(Number.isSafeInteger(time) && time >= 0, 'invalid caller clock');
    const age = BigInt(time) - b.timestamp;
    requireState(age >= 0n && age <= BigInt(maxAge), 'stale or future finalized block');
  };
  const chain = async () =>
    requireState(
      quantity(await rpc({ method: 'eth_chainId', params: [] })) === BigInt(config.chainId),
      'wrong chain',
    );
  await chain();
  const at = block(await rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] }));
  fresh(at);
  const pin = Object.freeze({ blockHash: at.hash, requireCanonical: true });
  const code = async (address: Address) =>
    data(await rpc({ method: 'eth_getCode', params: [address, pin] }), 24576);
  // Code identity precedes getter interpretation. Caller must independently trust these hashes.
  const dependencies = [
    config.factory,
    config.singleton,
    config.proxyFactory,
    config.entryPoint,
    config.module,
    config.helper,
  ];
  await Promise.all(
    dependencies.map(async (d) =>
      equal(keccak256(await code(d.address)), d.codeHash, 'dependency code mismatch'),
    ),
  );
  const call = async (
    address: Address,
    signature: string,
    outputs: string,
    args: readonly unknown[] = [],
  ) => {
    const signatures: string[] = [`function ${signature}`];
    const abi = parseAbi(signatures);
    const functionName = signature.slice(0, signature.indexOf('('));
    const encoded = encodeFunctionData({ abi, functionName, args });
    const result = data(
      await rpc({ method: 'eth_call', params: [{ to: address, data: encoded }, pin] }),
      32768,
    );
    const outputAbi = parseAbiParameters(outputs);
    const decoded = decodeAbiParameters(outputAbi, result);
    equal(encodeAbiParameters(outputAbi, decoded), result, 'noncanonical ABI result');
    return decoded;
  };
  const single = async (
    address: Address,
    signature: string,
    outputs: string,
    args: readonly unknown[] = [],
  ) => (await call(address, signature, outputs, args))[0];
  await Promise.all([
    (async () =>
      equal(
        await single(config.factory.address, 'configHash()', 'bytes32'),
        bunkEvmConfigHash(config),
        'factory configuration mismatch',
      ))(),
    (async () =>
      equal(
        await single(config.factory.address, 'initializer()', 'bytes'),
        bunkEvmInitializer(config),
        'initializer mismatch',
      ))(),
    (async () =>
      equal(
        await single(config.factory.address, 'predictAccount(address,uint32)', 'address', [
          identity,
          accountIndex,
        ]),
        account,
        'account prediction mismatch',
      ))(),
    (async () =>
      equal(
        await single(config.proxyFactory.address, 'proxyCreationCode()', 'bytes'),
        config.proxyCreationCode,
        'proxy creation code mismatch',
      ))(),
    ...(
      [
        [config.factory.address, 'singleton()', config.singleton.address],
        [config.factory.address, 'proxyFactory()', config.proxyFactory.address],
        [config.factory.address, 'module()', config.module.address],
        [config.factory.address, 'helper()', config.helper.address],
        [config.module.address, 'entryPoint()', config.entryPoint.address],
        [config.module.address, 'factory()', config.factory.address],
        [config.helper.address, 'module()', config.module.address],
      ] as const
    ).map(async ([address, signature, expected]) =>
      equal(
        await single(address, signature, 'address'),
        expected,
        'dependency relationship mismatch',
      ),
    ),
  ]);
  const [runtime, owner, nonceValue, recoveryValue] = await Promise.all([
    code(account),
    call(config.module.address, 'ownerState(address)', 'bytes32,uint32', [account]),
    single(config.entryPoint.address, 'getNonce(address,uint192)', 'uint256', [account, 0n]),
    version === 3
      ? call(config.module.address, 'recoveryState(address)', 'bytes32,uint32', [account])
      : undefined,
  ]);
  const commitment = bunkEvmHex(owner[0] as Hex, 32);
  const ownerIndex = bunkEvmIndex(owner[1] as number);
  const nonce = bunkEvmUint(nonceValue as bigint, 64);
  const recovery = recoveryValue
    ? {
        recoveryCommitment: bunkEvmHex(recoveryValue[0] as Hex, 32),
        epoch: bunkEvmIndex(recoveryValue[1] as number),
      }
    : undefined;
  let result: InternalObservation;
  const common = { config, block: at, account, accountIndex, ...(recovery ? { recovery } : {}) };
  if (runtime === '0x') {
    requireState(
      commitment === zeroHash && ownerIndex === 0 && nonce === 0n,
      'undeployed account has state',
    );
    if (recovery)
      requireState(
        recovery.recoveryCommitment === zeroHash && recovery.epoch === 0,
        'undeployed account has recovery state',
      );
    result = { ...common, status: 'undeployed' };
  } else {
    equal(keccak256(runtime), proxyHash, 'account proxy code mismatch');
    requireState(commitment !== zeroHash, 'missing owner commitment');
    if (recovery)
      requireState(
        recovery.recoveryCommitment !== zeroHash && recovery.recoveryCommitment !== commitment,
        'invalid recovery commitment',
      );
    const [version, owners, threshold, modules, singleton, fallback, guard, used] =
      await Promise.all([
        single(account, 'VERSION()', 'string'),
        single(account, 'getOwners()', 'address[]'),
        single(account, 'getThreshold()', 'uint256'),
        call(account, 'getModulesPaginated(address,uint256)', 'address[],address', [SENTINEL, 2n]),
        single(account, 'getStorageAt(uint256,uint256)', 'bytes', [0n, 1n]),
        single(account, 'getStorageAt(uint256,uint256)', 'bytes', [FALLBACK_SLOT, 1n]),
        single(account, 'getStorageAt(uint256,uint256)', 'bytes', [GUARD_SLOT, 1n]),
        single(config.module.address, 'usedCommitment(address,bytes32)', 'bool', [
          account,
          commitment,
        ]),
      ]);
    equal(version, '1.4.1', 'unsupported Safe version');
    requireState(Array.isArray(owners) && owners.length === 1, 'unexpected Safe owners');
    equal(owners[0], config.module.address, 'unexpected Safe owner');
    requireState(threshold === 1n, 'unexpected Safe threshold');
    requireState(Array.isArray(modules[0]) && modules[0].length === 1, 'unexpected Safe modules');
    equal(modules[0][0], config.module.address, 'unexpected Safe module');
    equal(modules[1], SENTINEL, 'extra Safe module');
    equal(
      singleton,
      toHex(BigInt(config.singleton.address), { size: 32 }),
      'Safe singleton mismatch',
    );
    equal(fallback, toHex(BigInt(config.module.address), { size: 32 }), 'Safe fallback mismatch');
    equal(guard, zeroHash, 'unexpected Safe guard');
    requireState(used === true, 'owner commitment not registered');
    result = {
      ...common,
      status: 'deployed',
      state: { account, accountIndex, ownerIndex, commitment, nonce },
    };
  }
  // Detect a changed canonical mapping or endpoint switch during the read. No automatic retry.
  const [canonical] = await Promise.all([
    rpc({ method: 'eth_getBlockByNumber', params: [toHex(at.number), false] }),
    chain(),
  ]);
  const end = block(canonical);
  requireState(
    end.hash === at.hash && end.number === at.number && end.timestamp === at.timestamp,
    'canonical block changed',
  );
  fresh(at);
  return result;
}
