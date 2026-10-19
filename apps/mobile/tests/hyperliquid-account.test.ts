import { expect, it } from 'vitest';
import { hyperliquidAccountMatchesWallet } from '../src/lib/hyperliquid-account';

const account = {
  schemaVersion: 1 as const,
  venue: 'hyperliquid' as const,
  account: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  fetchedAtMs: 1_800_000_000_000,
  state: {
    marginSummary: {
      accountValue: '100',
      totalNtlPos: '20',
      totalRawUsd: '0',
      totalMarginUsed: '5',
    },
    crossMarginSummary: {
      accountValue: '100',
      totalNtlPos: '20',
      totalRawUsd: '0',
      totalMarginUsed: '5',
    },
    crossMaintenanceMarginUsed: '2',
    withdrawable: '95',
    assetPositions: [],
    time: 1_800_000_000_000,
  },
};

it('matches the returned venue account to the selected wallet case-insensitively', () => {
  expect(hyperliquidAccountMatchesWallet(account, account.account.toLowerCase())).toBe(true);
  expect(
    hyperliquidAccountMatchesWallet(account, '0x0000000000000000000000000000000000000001'),
  ).toBe(false);
});
