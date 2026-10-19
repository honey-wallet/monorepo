import { afterEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ hyperliquidPerpsAccount: vi.fn() }));
vi.mock('./api', () => ({ api: apiMock }));

import { readHyperliquidAccount } from './hyperliquid';

const address = '0x0000000000000000000000000000000000000001';
const state = { account: address, venue: 'hyperliquid' } as never;

afterEach(() => vi.resetAllMocks());

it('uses the popup bearer and cancellation signal, then verifies wallet binding', async () => {
  apiMock.hyperliquidPerpsAccount.mockResolvedValue(state);
  const controller = new AbortController();
  await expect(
    readHyperliquidAccount('memory-token', address.toUpperCase(), controller.signal),
  ).resolves.toBe(state);
  expect(apiMock.hyperliquidPerpsAccount).toHaveBeenCalledWith('memory-token', {
    signal: controller.signal,
  });
});

it('rejects provider account data that does not match the signed-in wallet', async () => {
  apiMock.hyperliquidPerpsAccount.mockResolvedValue({
    account: '0x0000000000000000000000000000000000000002',
  });
  await expect(
    readHyperliquidAccount('memory-token', address, new AbortController().signal),
  ).rejects.toThrow(/did not match/i);
});
