import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
  zeroHash,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type BunkEvmConfig,
  bunkEvmConfigHash,
  bunkEvmInitializer,
  predictBunkEvmAccount,
} from './bunk-evm';
import {
  type BunkEvmRpc,
  observeBunkEvmAccount,
  observeBunkEvmV2Account,
  observeBunkEvmV3Account,
} from './bunk-evm-observe';
import { predictBunkEvmV2Account } from './bunk-evm-v2';
import { bunkEvmV3KeyScope, predictBunkEvmV3Account } from './bunk-evm-v3';
import { type BunkEvmDiscoveryRpc, discoverBunkEvmV3Accounts } from './bunk-evm-v3-discovery';
import {
  deriveBunkEvmV3DeploymentIdentity,
  deriveBunkEvmV3Owner,
  deriveBunkEvmV3Recovery,
} from './bunk-evm-v3-sign';

const address = (n: number) => toHex(n, { size: 20 });
const runtime = '0x60006000f3';
const hash = keccak256(runtime);
const commitment = keccak256('0x1234');
const encode = (types: string, values: readonly unknown[]) =>
  encodeAbiParameters(parseAbiParameters(types), values);
function fixture(deployed = true, version = 1, identity = address(10)) {
  const config: BunkEvmConfig = {
    chainId: '1',
    proxyCreationCode: runtime,
    factory: { address: address(1), codeHash: hash },
    singleton: { address: address(2), codeHash: hash },
    proxyFactory: { address: address(3), codeHash: hash },
    entryPoint: { address: address(4), codeHash: hash },
    module: { address: address(5), codeHash: hash },
    helper: { address: address(6), codeHash: hash },
  };
  const account =
    version === 3
      ? predictBunkEvmV3Account({ ...config, protocolVersion: 3 }, identity, 0)
      : version === 2
        ? predictBunkEvmV2Account({ ...config, protocolVersion: 2 }, identity, 0)
        : predictBunkEvmAccount(config, identity, 0);
  const header = { hash: keccak256('0x55'), number: '0x64', timestamp: '0x3e8' };
  const results = new Map<string, Hex>();
  const put = (to: Address, signature: string, types: string, values: readonly unknown[]) =>
    results.set(`${to.toLowerCase()}:${toFunctionSelector(signature)}`, encode(types, values));
  put(config.factory.address, 'configHash()', 'bytes32', [bunkEvmConfigHash(config)]);
  put(config.factory.address, 'initializer()', 'bytes', [bunkEvmInitializer(config)]);
  put(config.factory.address, 'predictAccount(address,uint32)', 'address', [account]);
  put(config.proxyFactory.address, 'proxyCreationCode()', 'bytes', [runtime]);
  for (const [to, signature, expected] of [
    [config.factory.address, 'singleton()', config.singleton.address],
    [config.factory.address, 'proxyFactory()', config.proxyFactory.address],
    [config.factory.address, 'module()', config.module.address],
    [config.factory.address, 'helper()', config.helper.address],
    [config.module.address, 'entryPoint()', config.entryPoint.address],
    [config.module.address, 'factory()', config.factory.address],
    [config.helper.address, 'module()', config.module.address],
  ] as const)
    put(to, signature, 'address', [expected]);
  put(config.module.address, 'ownerState(address)', 'bytes32,uint32', [
    deployed ? commitment : zeroHash,
    deployed ? 2 : 0,
  ]);
  put(config.entryPoint.address, 'getNonce(address,uint192)', 'uint256', [deployed ? 2n : 0n]);
  put(config.module.address, 'usedCommitment(address,bytes32)', 'bool', [true]);
  put(account, 'VERSION()', 'string', ['1.4.1']);
  put(account, 'getOwners()', 'address[]', [[config.module.address]]);
  put(account, 'getThreshold()', 'uint256', [1n]);
  put(account, 'getModulesPaginated(address,uint256)', 'address[],address', [
    [config.module.address],
    address(1),
  ]);
  const slots = new Map<bigint, Hex>([
    [0n, toHex(BigInt(config.singleton.address), { size: 32 })],
    [
      0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n,
      toHex(BigInt(config.module.address), { size: 32 }),
    ],
    [0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n, zeroHash],
  ]);
  const requests: Parameters<BunkEvmRpc>[0][] = [];
  const rpc: BunkEvmRpc = async (request) => {
    requests.push(request);
    const { method, params } = request;
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber') return { ...header };
    expect(params[1]).toEqual({ blockHash: header.hash, requireCanonical: true });
    if (method === 'eth_getCode') return params[0] === account && !deployed ? '0x' : runtime;
    const call = params[0] as { to: string; data: Hex };
    if (call.data.slice(0, 10) === toFunctionSelector('getStorageAt(uint256,uint256)')) {
      const [slot, length] = decodeAbiParameters(
        parseAbiParameters('uint256,uint256'),
        `0x${call.data.slice(10)}`,
      );
      expect(length).toBe(1n);
      return encode('bytes', [slots.get(slot)]);
    }
    const result = results.get(`${call.to.toLowerCase()}:${call.data.slice(0, 10)}`);
    expect(result).toBeDefined();
    return result;
  };
  const input = {
    config,
    proxyRuntimeCodeHash: hash,
    deploymentIdentity: identity,
    accountIndex: 0,
    now: () => 1010,
    maxFinalizedAgeSeconds: 30,
  };
  return { input, rpc, put, slots, requests, header, account, config };
}

describe('finalized Bunk EVM observation', () => {
  it('pins every read and returns deployed signing state after canonical recheck', async () => {
    const f = fixture();
    const result = await observeBunkEvmAccount(f.rpc, f.input);
    expect(result).toMatchObject({
      status: 'deployed',
      state: { account: f.account, accountIndex: 0, ownerIndex: 2, commitment, nonce: 2n },
    });
    expect(
      f.requests.filter((r) => r.method === 'eth_getBlockByNumber').map((r) => r.params),
    ).toEqual([
      ['finalized', false],
      ['0x64', false],
    ]);
    expect(f.requests.filter((r) => r.method === 'eth_chainId')).toHaveLength(2);
  });
  it('distinguishes undeployed state without inventing a current owner', async () => {
    const f = fixture(false);
    const result = await observeBunkEvmAccount(f.rpc, f.input);
    expect(result.status).toBe('undeployed');
    expect(result).not.toHaveProperty('state');
  });
  it.each([
    'chain',
    'reorg',
    'endpoint switch',
    'unavailable finalized',
    'noncanonical pin',
    'oversized code',
    'wrong code',
    'bad quantity',
    'trailing ABI',
  ])('rejects %s', async (failure) => {
    const f = fixture();
    let chainReads = 0;
    const rpc: BunkEvmRpc = async (r) => {
      if (r.method === 'eth_chainId') {
        chainReads++;
        if (failure === 'chain' || (failure === 'endpoint switch' && chainReads === 2))
          return '0x2';
        if (failure === 'bad quantity') return '0x01';
      }
      if (r.method === 'eth_getBlockByNumber') {
        if (failure === 'unavailable finalized') return null;
        if (failure === 'reorg' && r.params[0] !== 'finalized')
          return { ...f.header, hash: zeroHash };
      }
      if (r.method === 'eth_getCode') {
        if (failure === 'noncanonical pin') throw Error('block is not canonical');
        if (failure === 'oversized code') return `0x${'00'.repeat(24577)}`;
        if (failure === 'wrong code') return '0x';
      }
      const result = await f.rpc(r);
      return failure === 'trailing ABI' && r.method === 'eth_call' ? `${result}00` : result;
    };
    await expect(observeBunkEvmAccount(rpc, f.input)).rejects.toThrow();
  });
  it.each(['stale', 'future', 'aged during read', 'bad policy', 'bad clock'])(
    'rejects %s finality policy',
    async (failure) => {
      const f = fixture();
      if (failure === 'stale') f.input.now = () => 1031;
      if (failure === 'future') f.input.now = () => 999;
      if (failure === 'aged during read') {
        let count = 0;
        f.input.now = () => (count++ ? 1031 : 1010);
      }
      if (failure === 'bad policy') f.input.maxFinalizedAgeSeconds = 0;
      if (failure === 'bad clock') f.input.now = () => Number.NaN;
      await expect(observeBunkEvmAccount(f.rpc, f.input)).rejects.toThrow();
    },
  );
  it.each([
    'version',
    'owners',
    'threshold',
    'modules',
    'extra module',
    'singleton',
    'fallback',
    'guard',
    'commitment',
    'used',
    'index',
    'nonce',
    'configuration',
    'prediction',
    'relationship',
    'initializer',
    'proxy creation',
    'proxy runtime',
  ])('rejects incompatible %s', async (failure) => {
    const f = fixture(),
      c = f.config,
      a = f.account;
    switch (failure) {
      case 'version':
        f.put(a, 'VERSION()', 'string', ['1.3.0']);
        break;
      case 'owners':
        f.put(a, 'getOwners()', 'address[]', [[c.module.address, address(11)]]);
        break;
      case 'threshold':
        f.put(a, 'getThreshold()', 'uint256', [2n]);
        break;
      case 'modules':
        f.put(a, 'getModulesPaginated(address,uint256)', 'address[],address', [
          [address(12)],
          address(1),
        ]);
        break;
      case 'extra module':
        f.put(a, 'getModulesPaginated(address,uint256)', 'address[],address', [
          [c.module.address],
          address(12),
        ]);
        break;
      case 'singleton':
        f.slots.set(0n, zeroHash);
        break;
      case 'fallback':
        f.slots.set(0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n, zeroHash);
        break;
      case 'guard':
        f.slots.set(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n, hash);
        break;
      case 'commitment':
        f.put(c.module.address, 'ownerState(address)', 'bytes32,uint32', [zeroHash, 2]);
        break;
      case 'used':
        f.put(c.module.address, 'usedCommitment(address,bytes32)', 'bool', [false]);
        break;
      case 'index':
        f.put(c.module.address, 'ownerState(address)', 'bytes32,uint32', [commitment, 2 ** 31]);
        break;
      case 'nonce':
        f.put(c.entryPoint.address, 'getNonce(address,uint192)', 'uint256', [1n << 64n]);
        break;
      case 'configuration':
        f.put(c.factory.address, 'configHash()', 'bytes32', [zeroHash]);
        break;
      case 'prediction':
        f.put(c.factory.address, 'predictAccount(address,uint32)', 'address', [address(13)]);
        break;
      case 'relationship':
        f.put(c.module.address, 'entryPoint()', 'address', [address(13)]);
        break;
      case 'initializer':
        f.put(c.factory.address, 'initializer()', 'bytes', ['0x']);
        break;
      case 'proxy creation':
        f.put(c.proxyFactory.address, 'proxyCreationCode()', 'bytes', ['0x']);
        break;
      case 'proxy runtime':
        f.input.proxyRuntimeCodeHash = commitment;
        break;
    }
    await expect(observeBunkEvmAccount(f.rpc, f.input)).rejects.toThrow();
  });
  it.each(['owner', 'nonce'])('rejects undeployed account with %s state', async (failure) => {
    const f = fixture(false);
    if (failure === 'owner')
      f.put(f.config.module.address, 'ownerState(address)', 'bytes32,uint32', [commitment, 0]);
    else f.put(f.config.entryPoint.address, 'getNonce(address,uint192)', 'uint256', [1n]);
    await expect(observeBunkEvmAccount(f.rpc, f.input)).rejects.toThrow();
  });
  it('snapshots caller configuration before awaiting transport', async () => {
    const f = fixture();
    const promise = observeBunkEvmAccount(f.rpc, f.input);
    f.input.accountIndex = 99;
    f.input.proxyRuntimeCodeHash = zeroHash;
    const result = await promise;
    expect(result.accountIndex).toBe(0);
  });
});

describe('explicit v2 finalized observation', () => {
  it.each([true, false])(
    'checks the v2 factory salt, authorities and canonical pin (deployed=%s)',
    async (deployed) => {
      const f = fixture(deployed, 2);
      const result = await observeBunkEvmV2Account(f.rpc, {
        ...f.input,
        config: { ...f.config, protocolVersion: 2 },
      });
      expect(result.account).toBe(f.account);
      expect(result.protocolVersion).toBe(2);
      expect(result.status).toBe(deployed ? 'deployed' : 'undeployed');
      if (result.status === 'deployed')
        expect(result.state).toMatchObject({
          protocolVersion: 2,
          deployed: true,
          commitment,
          nonce: 2n,
        });
      else expect(result).not.toHaveProperty('state');
      expect(f.requests.filter((r) => r.method === 'eth_chainId')).toHaveLength(2);
    },
  );
  it('rejects v1 prediction passed as a v2 deployment', async () => {
    const f = fixture();
    await expect(
      observeBunkEvmV2Account(f.rpc, { ...f.input, config: { ...f.config, protocolVersion: 2 } }),
    ).rejects.toThrow('prediction mismatch');
  });
  it('rejects v2 prediction through the v1 observer', async () => {
    const f = fixture(true, 2);
    await expect(observeBunkEvmAccount(f.rpc, f.input)).rejects.toThrow('prediction mismatch');
  });
  it.each(['code', 'owner', 'guard', 'reorg'])('retains v2 rejection for %s', async (failure) => {
    const f = fixture(true, 2);
    if (failure === 'owner') f.put(f.account, 'getOwners()', 'address[]', [[address(12)]]);
    if (failure === 'guard')
      f.slots.set(
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n,
        toHex(12n, { size: 32 }),
      );
    const rpc: BunkEvmRpc = async (r) => {
      if (failure === 'code' && r.method === 'eth_getCode') return '0x';
      if (failure === 'reorg' && r.method === 'eth_getBlockByNumber' && r.params[0] !== 'finalized')
        return { ...f.header, hash: keccak256('0x66') };
      return f.rpc(r);
    };
    await expect(
      observeBunkEvmV2Account(rpc, { ...f.input, config: { ...f.config, protocolVersion: 2 } }),
    ).rejects.toThrow();
  });
});

describe('v3 finalized recovery observation', () => {
  function v3(deployed = true) {
    const f = fixture(deployed, 3);
    f.put(f.config.module.address, 'recoveryState(address)', 'bytes32,uint32', [
      deployed ? keccak256('0x9876') : zeroHash,
      deployed ? 3 : 0,
    ]);
    f.put(f.config.entryPoint.address, 'getNonce(address,uint192)', 'uint256', [
      deployed ? 11n : 0n,
    ]);
    return { ...f, input: { ...f.input, config: { ...f.config, protocolVersion: 3 as const } } };
  }
  it('returns independent epoch, owner index and nonce from the pinned block', async () => {
    const f = v3();
    expect(await observeBunkEvmV3Account(f.rpc, f.input)).toMatchObject({
      protocolVersion: 3,
      status: 'deployed',
      state: {
        epoch: 3,
        ownerIndex: 2,
        nonce: 11n,
        recoveryCommitment: keccak256('0x9876'),
        protocolVersion: 3,
        deployed: true,
      },
    });
    expect(
      f.requests.some(
        (r) =>
          r.method === 'eth_call' &&
          (r.params[0] as { data: Hex }).data.startsWith(
            toFunctionSelector('recoveryState(address)'),
          ),
      ),
    ).toBe(true);
  });
  it('does not invent initial recovery state for an undeployed account', async () => {
    const f = v3(false);
    const result = await observeBunkEvmV3Account(f.rpc, f.input);
    expect(result.status).toBe('undeployed');
    expect(result).not.toHaveProperty('state');
    f.put(f.config.module.address, 'recoveryState(address)', 'bytes32,uint32', [
      keccak256('0x9876'),
      0,
    ]);
    await expect(observeBunkEvmV3Account(f.rpc, f.input)).rejects.toThrow('undeployed');
  });
  it('rejects empty, aliased, malformed and out-of-range recovery state', async () => {
    for (const [root, epoch] of [
      [zeroHash, 0],
      [commitment, 0],
      [keccak256('0x9876'), 2 ** 31],
    ] as const) {
      const f = v3();
      f.put(f.config.module.address, 'recoveryState(address)', 'bytes32,uint32', [root, epoch]);
      await expect(observeBunkEvmV3Account(f.rpc, f.input)).rejects.toThrow();
    }
    const f = v3();
    f.put(f.config.module.address, 'recoveryState(address)', 'bytes32', [keccak256('0x9876')]);
    await expect(observeBunkEvmV3Account(f.rpc, f.input)).rejects.toThrow();
  });
  it('rejects v2 prediction and a changed finalized canonical block', async () => {
    const f = v3();
    f.put(f.config.factory.address, 'predictAccount(address,uint32)', 'address', [
      predictBunkEvmV2Account({ ...f.config, protocolVersion: 2 }, f.input.deploymentIdentity, 0),
    ]);
    await expect(observeBunkEvmV3Account(f.rpc, f.input)).rejects.toThrow('prediction');
    const clean = v3();
    const changed: BunkEvmRpc = async (request) =>
      request.method === 'eth_getBlockByNumber' && request.params[0] === '0x64'
        ? { ...clean.header, hash: keccak256('0x9999') }
        : clean.rpc(request);
    await expect(observeBunkEvmV3Account(changed, clean.input)).rejects.toThrow('canonical');
  });
});

describe('token discovery with the real finalized observer', () => {
  it.each([true, false])(
    'observes tokens only after verified account state (deployed=%s)',
    async (deployed) => {
      const seed = new Uint8Array(64).fill(9);
      const f = fixture(deployed, 3, deriveBunkEvmV3DeploymentIdentity(seed, 0).address);
      const config = { ...f.config, protocolVersion: 3 as const };
      const ref = {
        chainId: '1',
        keyScope: bunkEvmV3KeyScope(config),
        accountIndex: 0,
        epoch: 3,
        ownerIndex: 2,
      };
      f.put(config.module.address, 'ownerState(address)', 'bytes32,uint32', [
        deployed ? deriveBunkEvmV3Owner(seed, ref).commitment : zeroHash,
        deployed ? 2 : 0,
      ]);
      f.put(config.module.address, 'recoveryState(address)', 'bytes32,uint32', [
        deployed ? deriveBunkEvmV3Recovery(seed, ref).commitment : zeroHash,
        deployed ? 3 : 0,
      ]);
      f.put(config.entryPoint.address, 'balanceOf(address)', 'uint256', [0n]);
      const token = address(30);
      let tokenReads = 0;
      const rpc: BunkEvmDiscoveryRpc = async (r) => {
        if (r.method === 'eth_getBalance') return '0x0';
        if (r.method === 'eth_getCode' && r.params[0] === token) return runtime;
        if (r.method === 'eth_call' && (r.params[0] as { to: Address }).to === token) {
          tokenReads++;
          expect(r.params[1]).toEqual({ blockHash: f.header.hash, requireCanonical: true });
          expect(f.requests.filter((request) => request.method === 'eth_chainId')).toHaveLength(2);
          const [owner] = decodeAbiParameters(
            parseAbiParameters('address'),
            `0x${(r.params[0] as { data: Hex }).data.slice(10)}`,
          );
          expect(owner).toBe(f.account);
          return encode('uint256', [123n]);
        }
        return f.rpc(r);
      };
      const input = {
        config,
        proxyRuntimeCodeHash: hash,
        startAccountIndex: 0,
        count: 1,
        erc20Tokens: [token],
      };
      const access = { rpc, now: f.input.now, maxFinalizedAgeSeconds: 30 };
      try {
        const page = await discoverBunkEvmV3Accounts(seed, input, access);
        expect(page.candidates[0]).toMatchObject({
          observation: { status: deployed ? 'deployed' : 'undeployed', account: f.account },
          nativeBalance: 0n,
          erc20Balances: [{ token, balance: 123n }],
        });
        expect(tokenReads).toBe(1);
        // Invalid factory metadata must prevent token reads, even if token RPC works.
        f.put(config.factory.address, 'configHash()', 'bytes32', [zeroHash]);
        await expect(discoverBunkEvmV3Accounts(seed, input, access)).rejects.toThrow(
          'factory configuration',
        );
        expect(tokenReads).toBe(1);
      } finally {
        seed.fill(0);
      }
    },
  );
});
