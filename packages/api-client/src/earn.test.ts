import { afterEach, describe, expect, it, vi } from 'vitest';
import captured from '../../../docs/backend/results/earn-catalog-smoke-2026-10-18.json';
import { createApiClient } from './client';
import { ageEarnCatalog, formatEarnApy, isEarnCatalog, observeEarnCatalog } from './earn';
import type { EarnCatalog } from './types';

function first(v: EarnCatalog) {
  const p = v.products[0];
  if (!p?.observation) throw new Error('Expected fixture observation');
  return { product: p, observation: p.observation };
}

const address = `0x${'1'.repeat(40)}`;
const asset = `0x${'2'.repeat(40)}`;
function catalog(): EarnCatalog {
  return {
    schemaVersion: 1,
    status: 'ready',
    maxAgeMs: 120000,
    products: [
      {
        id: 'a'.repeat(64),
        label: 'Aave USDC',
        protocol: 'aave_v3',
        chainId: '1',
        contractAddress: address,
        assetAddress: asset,
        status: 'fresh',
        ageMs: 0,
        observation: {
          schemaVersion: 1,
          protocol: 'aave_v3',
          chainId: '1',
          contractAddress: address,
          asset: { address: asset, decimals: 6, symbol: 'USDC' },
          positionAsset: { address: `0x${'3'.repeat(40)}`, decimals: 6, symbol: 'aUSDC' },
          totalSuppliedRaw: '9007199254740993',
          availableLiquidityRaw: '1000000',
          supplyCapRaw: null,
          supplyApy: {
            fraction: '0.038313795766101947560963736',
            basis: 'current_supply',
            rewardsIncluded: false,
          },
          restrictions: { paused: false, frozen: false, supplyCapReached: false, gated: null },
          vaultFees: null,
          sourceBlocks: [],
          fetchedAtMs: Date.now(),
          executionAvailable: false,
        },
      },
    ],
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('Earn cached contract', () => {
  it('accepts both actual provider observations served by the two-replica smoke', async () => {
    const client = createApiClient({
      baseUrl: 'https://wallet.example',
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(captured.catalog))),
    });
    const result = await client.earnCatalog();
    expect(result.products.map((product) => product.protocol).sort()).toEqual([
      'aave_v3',
      'morpho_vault_v2',
    ]);
    expect(result).toEqual(captured.catalog);
  });
  it('preserves exact amounts and rejects identity substitution or executable claims', () => {
    expect(isEarnCatalog(catalog())).toBe(true);
    for (const mutate of [
      (v: EarnCatalog) => {
        first(v).observation.asset.address = address;
      },
      (v: EarnCatalog) => {
        Object.assign(first(v).observation, { executionAvailable: true });
      },
      (v: EarnCatalog) => {
        Object.assign(first(v).observation, { totalSuppliedRaw: 42 });
      },
      (v: EarnCatalog) => {
        first(v).observation.positionAsset.decimals = 18;
      },
      (v: EarnCatalog) => {
        v.products.push(first(v).product);
      },
    ]) {
      const v = catalog();
      mutate(v);
      expect(isEarnCatalog(v)).toBe(false);
    }
  });
  it('ages locally, expires old samples, and marks future-clock samples stale', () => {
    const v = catalog();
    expect(ageEarnCatalog(v, 120001).products[0]?.status).toBe('stale');
    expect(ageEarnCatalog(v, 600001).products[0]?.observation).toBeNull();
    first(v).observation.fetchedAtMs += 10000;
    expect(ageEarnCatalog(v, 0).products[0]?.status).toBe('stale');
    expect(formatEarnApy('0.038313795766101947560963736')).toBe('3.83%');
    expect(formatEarnApy('-0.01')).toBe('-1.00%');
  });
  it('uses the production client route and validates responses', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog())));
    const client = createApiClient({ baseUrl: 'https://wallet.example', fetch });
    expect(first(await client.earnCatalog()).observation.totalSuppliedRaw).toBe('9007199254740993');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://wallet.example/api/v1/earn/catalog');
    fetch.mockResolvedValue(new Response('{}'));
    await expect(client.earnCatalog()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('cancels in-flight work and ignores late completions after screen cleanup', async () => {
    vi.useFakeTimers();
    let resolve!: (value: EarnCatalog) => void;
    const load = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<EarnCatalog>((r) => {
          resolve = r;
        }),
    );
    const onCatalog = vi.fn();
    const onState = vi.fn();
    const stop = observeEarnCatalog(load, { onCatalog, onState });
    stop();
    resolve(catalog());
    await vi.advanceTimersByTimeAsync(60000);
    expect(load.mock.calls[0]?.[0].aborted).toBe(true);
    expect(onCatalog).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('deadlines abort reads without unbounded retries', async () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    const load = vi.fn((_signal: AbortSignal) => new Promise<EarnCatalog>(() => {}));
    const stop = observeEarnCatalog(load, { onCatalog: vi.fn(), onState });
    await vi.advanceTimersByTimeAsync(6000);
    expect(onState).toHaveBeenLastCalledWith('error');
    expect(load.mock.calls[0]?.[0].aborted).toBe(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
