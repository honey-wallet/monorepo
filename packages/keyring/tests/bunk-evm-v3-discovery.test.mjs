import { decodeFunctionData, getAddress, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as observer from '../src/bunk-evm-observe';
import { bunkEvmV3KeyScope, predictBunkEvmV3Account } from '../src/bunk-evm-v3';
import {
  BUNK_EVM_DISCOVERY_TOKEN_GAS,
  BUNK_EVM_DISCOVERY_TOKEN_LIMIT,
  discoverBunkEvmV3Accounts,
} from '../src/bunk-evm-v3-discovery';
import { deriveBunkEvmV3Owner, deriveBunkEvmV3Recovery } from '../src/bunk-evm-v3-sign';
import fixture from '../src/fixtures/bunk-evm-v3.json';
import { mnemonicToSeed } from '../src/index';

let seed;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
afterEach(() => vi.restoreAllMocks());
const hash = keccak256('0x1234');
function setup() {
  const config = { ...structuredClone(fixture.config), protocolVersion: 3, chainId: '1' };
  const input = {
    config,
    proxyRuntimeCodeHash: keccak256('0x6000'),
    startAccountIndex: 6,
    count: 3,
  };
  const seen = [],
    requests = [];
  const observe = vi
    .spyOn(observer, 'observeBunkEvmV3Account')
    .mockImplementation(async (_rpc, r) => {
      seen.push(r.accountIndex);
      const account = predictBunkEvmV3Account(r.config, r.deploymentIdentity, r.accountIndex);
      const base = {
        protocolVersion: 3,
        config: r.config,
        account,
        accountIndex: r.accountIndex,
        block: { hash, number: 10n, timestamp: 1000n },
      };
      if (r.accountIndex !== 7) return { ...base, status: 'undeployed' };
      const ref = {
        chainId: r.config.chainId,
        keyScope: bunkEvmV3KeyScope(r.config),
        accountIndex: 7,
        epoch: 4,
        ownerIndex: 3,
      };
      return {
        ...base,
        status: 'deployed',
        state: {
          protocolVersion: 3,
          deployed: true,
          account,
          accountIndex: 7,
          epoch: 4,
          ownerIndex: 3,
          nonce: 31n,
          commitment: deriveBunkEvmV3Owner(seed, ref).commitment,
          recoveryCommitment: deriveBunkEvmV3Recovery(seed, ref).commitment,
        },
      };
    });
  const access = {
    now: () => 1010,
    maxFinalizedAgeSeconds: 60,
    rpc: vi.fn(async (r) => {
      requests.push(r);
      if (r.method === 'eth_chainId') return '0x1';
      if (r.method === 'eth_getBlockByNumber') return { hash };
      expect(r.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
      if (r.method === 'eth_getBalance') return '0x2a';
      expect(r.params[0].to).toBe(config.entryPoint.address);
      const call = decodeFunctionData({
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        data: r.params[0].data,
      });
      expect(call.functionName).toBe('balanceOf');
      return toHex(99n, { size: 32 });
    }),
  };
  return { input, access, seen, requests, observe };
}
describe('v3 phrase account discovery pages', () => {
  it('keeps undeployed addresses across gaps, checks a sparse deployed account and pinned balances', async () => {
    const f = setup();
    const result = await discoverBunkEvmV3Accounts(seed, f.input, f.access);
    expect(f.seen).toEqual([6, 7, 8]);
    expect(result.nextAccountIndex).toBe(9);
    expect(result.inventoryComplete).toBe(false);
    expect(result.signingAuthorized).toBe(false);
    expect(result.releaseKey).toBe(`1:${bunkEvmV3KeyScope(f.input.config)}`);
    expect(result.candidates.map((c) => c.observation.status)).toEqual([
      'undeployed',
      'deployed',
      'undeployed',
    ]);
    expect(
      result.candidates.every((c) => c.nativeBalance === 42n && c.entryPointDeposit === 99n),
    ).toBe(true);
    expect(f.requests.filter((r) => r.method === 'eth_getBlockByNumber')).toHaveLength(1);
    expect(result.candidates.every((c) => c.erc20Balances.length === 0)).toBe(true);
  });
  it('does not infer empty history from zero balances', async () => {
    const f = setup(),
      original = f.access.rpc;
    f.access.rpc = (r) => (r.method === 'eth_getBalance' ? Promise.resolve('0x0') : original(r));
    const page = await discoverBunkEvmV3Accounts(seed, { ...f.input, count: 1 }, f.access);
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0].nativeBalance).toBe(0n);
    expect(page.inventoryComplete).toBe(false);
  });
  it('rejects invalid ranges before any RPC or observation', async () => {
    const f = setup();
    for (const patch of [
      { count: 0 },
      { count: 21 },
      { count: 1.5 },
      { startAccountIndex: -1 },
      { startAccountIndex: 2147483647, count: 2 },
    ]) {
      await expect(
        discoverBunkEvmV3Accounts(seed, { ...f.input, ...patch }, f.access),
      ).rejects.toThrow();
    }
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.access.rpc).not.toHaveBeenCalled();
  });
  it('returns a terminal cursor without wrapping or claiming global completeness', async () => {
    const f = setup();
    const page = await discoverBunkEvmV3Accounts(
      seed,
      { ...f.input, startAccountIndex: 2147483647, count: 1 },
      f.access,
    );
    expect(page.nextAccountIndex).toBe(null);
    expect(page.inventoryComplete).toBe(false);
  });
  for (const field of ['commitment', 'recoveryCommitment']) {
    it(`rejects a foreign deployed ${field}`, async () => {
      const f = setup(),
        original = f.observe.getMockImplementation();
      f.observe.mockImplementation(async (...args) => {
        const r = await original(...args);
        if (r.status === 'deployed') r.state[field] = keccak256('0x9999');
        return r;
      });
      await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('authority');
      expect(f.seen).toEqual([6, 7]);
    });
  }
  it('does not swallow an observer failure as an unused account', async () => {
    const f = setup();
    f.observe.mockRejectedValueOnce(Error('bad module code'));
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow(
      'bad module code',
    );
    expect(f.access.rpc).not.toHaveBeenCalled();
  });
  for (const bad of ['0x00', '-1', '0x', `0x${'1'.repeat(65)}`, 1]) {
    it(`rejects malformed balance ${String(bad)}`, async () => {
      const f = setup();
      f.access.rpc.mockResolvedValue(bad);
      await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow(
        'balance quantity',
      );
    });
  }
  it('rejects noncanonical deposit data instead of decoding partial bytes', async () => {
    const f = setup(),
      rpc = f.access.rpc;
    f.access.rpc = (r) => (r.method === 'eth_call' ? Promise.resolve('0x01') : rpc(r));
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('deposit');
  });
  it('rechecks earlier anchors and rejects a changed or unavailable one', async () => {
    const f = setup(),
      rpc = f.access.rpc;
    f.access.rpc = (r) => (r.method === 'eth_getBlockByNumber' ? Promise.resolve(null) : rpc(r));
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('anchor');
  });
  it('rejects a chain switch after all candidates were scanned', async () => {
    const f = setup(),
      rpc = f.access.rpc;
    f.access.rpc = (r) => (r.method === 'eth_chainId' ? Promise.resolve('0x2') : rpc(r));
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow(
      'chain changed',
    );
  });
  it('rejects a page that became stale before return', async () => {
    const f = setup();
    f.access.now = () => 1061;
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('stale');
  });
  it('fences cancellation before RPC and during an awaited result', async () => {
    const f = setup(),
      controller = new AbortController(),
      rpc = f.access.rpc;
    f.access.signal = controller.signal;
    f.access.rpc = async (r) => {
      const value = await rpc(r);
      controller.abort();
      return value;
    };
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('cancelled');
    expect(f.observe).toHaveBeenCalledTimes(1);
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('cancelled');
    expect(f.observe).toHaveBeenCalledTimes(1);
  });
  it('snapshots seed, range, config and callbacks before the first await', async () => {
    const f = setup(),
      callerSeed = seed.slice(),
      original = f.observe.getMockImplementation();
    f.observe.mockImplementation(async (...args) => {
      callerSeed.fill(0);
      f.input.count = 1;
      f.input.config.chainId = '2';
      f.input.config.factory.address = toHex(9n, { size: 20 });
      f.access.now = () => 0;
      f.access.rpc = async () => {
        throw Error('replacement');
      };
      return original(...args);
    });
    const page = await discoverBunkEvmV3Accounts(callerSeed, f.input, f.access);
    expect(page.count).toBe(3);
    expect(page.releaseKey.startsWith('1:')).toBe(true);
    expect(f.seen).toEqual([6, 7, 8]);
  });
  it('leaves caller seed untouched and rejects invalid seeds/proxy identities', async () => {
    const f = setup(),
      before = seed.slice();
    await discoverBunkEvmV3Accounts(seed, f.input, f.access);
    expect(seed).toEqual(before);
    await expect(discoverBunkEvmV3Accounts(new Uint8Array(32), f.input, f.access)).rejects.toThrow(
      'seed',
    );
    await expect(
      discoverBunkEvmV3Accounts(
        seed,
        { ...f.input, proxyRuntimeCodeHash: keccak256('0x') },
        f.access,
      ),
    ).rejects.toThrow('proxy');
  });
});

describe('ERC-20 balances during v3 discovery', () => {
  const tokens = [getAddress(toHex(0xabcdn, { size: 20 })), toHex(0x1234n, { size: 20 })];
  const maxBalance = (1n << 256n) - 1n;
  function withTokens() {
    const f = setup(),
      original = f.access.rpc;
    f.input.erc20Tokens = [...tokens];
    const reads = [];
    f.access.rpc = vi.fn(async (r) => {
      const token = r.method === 'eth_getCode' ? r.params[0] : r.params[0]?.to;
      if (!tokens.includes(token)) return original(r);
      reads.push(r);
      expect(r.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
      if (r.method === 'eth_getCode') return '0x6000';
      expect(r.method).toBe('eth_call');
      expect(r.params[0].gas).toBe(toHex(BUNK_EVM_DISCOVERY_TOKEN_GAS));
      const call = decodeFunctionData({
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        data: r.params[0].data,
      });
      expect(call.functionName).toBe('balanceOf');
      return toHex(token === tokens[0] ? 0n : maxBalance, { size: 32 });
    });
    return { ...f, reads };
  }
  it('retains zero and full uint256 amounts for deployed and undeployed accounts at their anchor', async () => {
    const f = withTokens();
    const page = await discoverBunkEvmV3Accounts(seed, f.input, f.access);
    for (const candidate of page.candidates) {
      expect(candidate.erc20Balances).toEqual([
        { token: tokens[0], balance: 0n },
        { token: tokens[1], balance: maxBalance },
      ]);
    }
    expect(page.inventoryComplete).toBe(false);
    expect(page.signingAuthorized).toBe(false);
    expect(f.reads).toHaveLength(12);
    const owners = f.reads
      .filter((r) => r.method === 'eth_call')
      .map(
        (r) =>
          decodeFunctionData({
            abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
            data: r.params[0].data,
          }).args[0],
      );
    expect(owners).toEqual(
      page.candidates.flatMap((c) => [c.observation.account, c.observation.account]),
    );
  });
  it('validates the entire token list before observing or calling RPC', async () => {
    const f = withTokens();
    for (const invalid of [
      null,
      {},
      '0x1234',
      [zeroAddress],
      ['0x12'],
      [123],
      Array(1),
      [tokens[0], tokens[0].toLowerCase()],
      Array.from({ length: BUNK_EVM_DISCOVERY_TOKEN_LIMIT + 1 }, (_, i) =>
        toHex(i + 1, { size: 20 }),
      ),
    ]) {
      await expect(
        discoverBunkEvmV3Accounts(seed, { ...f.input, erc20Tokens: invalid }, f.access),
      ).rejects.toThrow();
    }
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.access.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['empty code', 'eth_getCode', '0x'],
    ['odd code', 'eth_getCode', '0x0'],
    ['oversized code', 'eth_getCode', `0x${'00'.repeat(24577)}`],
    ['missing balance', 'eth_call', null],
    ['short balance', 'eth_call', '0x01'],
    ['trailing balance data', 'eth_call', `${toHex(1n, { size: 32 })}00`],
    ['nonhex balance', 'eth_call', `0x${'gg'.repeat(32)}`],
  ])('rejects %s instead of reporting a zero balance', async (_name, method, value) => {
    const f = withTokens(),
      rpc = f.access.rpc;
    f.access.rpc = (r) =>
      r.method === method && (r.params[0] === tokens[0] || r.params[0]?.to === tokens[0])
        ? Promise.resolve(value)
        : rpc(r);
    await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow('ERC-20');
  });
  it.each(['revert', 'cancel', 'reorg', 'chain', 'stale'])(
    'rejects the entire page after a token read encounters %s',
    async (failure) => {
      const f = withTokens(),
        rpc = f.access.rpc,
        controller = new AbortController();
      f.access.signal = controller.signal;
      let tokenRead = false;
      f.access.now = () => (failure === 'stale' && tokenRead ? 1061 : 1010);
      f.access.rpc = async (r) => {
        if (r.method === 'eth_call' && r.params[0].to === tokens[1]) {
          tokenRead = true;
          if (failure === 'revert') throw Error('token reverted');
          if (failure === 'cancel') controller.abort();
        }
        if (tokenRead && failure === 'reorg' && r.method === 'eth_getBlockByNumber') return null;
        if (tokenRead && failure === 'chain' && r.method === 'eth_chainId') return '0x2';
        return rpc(r);
      };
      await expect(discoverBunkEvmV3Accounts(seed, f.input, f.access)).rejects.toThrow(
        {
          revert: 'token reverted',
          cancel: 'cancelled',
          reorg: 'anchor',
          chain: 'chain changed',
          stale: 'stale',
        }[failure],
      );
      expect(tokenRead).toBe(true);
    },
  );
  it('snapshots the requested token addresses before awaiting account observation', async () => {
    const f = withTokens(),
      observe = f.observe.getMockImplementation();
    f.observe.mockImplementation(async (...args) => {
      f.input.erc20Tokens.splice(0, 2, zeroAddress);
      return observe(...args);
    });
    const page = await discoverBunkEvmV3Accounts(seed, f.input, f.access);
    expect(
      page.candidates.every((c) => c.erc20Balances.map((b) => b.token).join() === tokens.join()),
    ).toBe(true);
  });
});
