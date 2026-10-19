import { describe, expect, it } from 'vitest';
import { isHyperliquidPerpsAccountState } from './hyperliquid';

const state = {
  schemaVersion: 1,
  venue: 'hyperliquid',
  account: '0x0000000000000000000000000000000000000001',
  fetchedAtMs: 1733968369395,
  state: {
    marginSummary: {
      accountValue: '29.78001',
      totalNtlPos: '0.0',
      totalRawUsd: '29.78001',
      totalMarginUsed: '0.0',
    },
    crossMarginSummary: {
      accountValue: '29.78001',
      totalNtlPos: '0.0',
      totalRawUsd: '29.78001',
      totalMarginUsed: '0.0',
    },
    crossMaintenanceMarginUsed: '0.0',
    withdrawable: '29.78001',
    assetPositions: [
      {
        type: 'oneWay',
        position: {
          coin: 'ETH',
          szi: '0.0335',
          entryPx: '2986.3',
          positionValue: '100.02765',
          unrealizedPnl: '-0.0134',
          marginUsed: '4.967826',
          liquidationPx: '2866.26936529',
          leverage: { type: 'isolated', value: 20 },
        },
      },
    ],
    time: 1733968369395,
  },
};

describe('Hyperliquid private perps state contract', () => {
  it('accepts the bounded decimal-string snapshot and negative PnL', () => {
    expect(isHyperliquidPerpsAccountState(state)).toBe(true);
  });

  it('rejects exponent amounts, invalid owner addresses and unbounded positions', () => {
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        state: { ...state.state, withdrawable: '1e4' },
      }),
    ).toBe(false);
    expect(isHyperliquidPerpsAccountState({ ...state, account: '0xnot-an-address' })).toBe(false);
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        state: { ...state.state, assetPositions: Array(501).fill(state.state.assetPositions[0]) },
      }),
    ).toBe(false);
  });

  it('rejects stale and future-dated provider snapshots', () => {
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        fetchedAtMs: state.fetchedAtMs + 30_001,
      }),
    ).toBe(false);
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        fetchedAtMs: state.fetchedAtMs - 5_001,
      }),
    ).toBe(false);
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        fetchedAtMs: state.fetchedAtMs + 30_000,
      }),
    ).toBe(true);
    expect(
      isHyperliquidPerpsAccountState({
        ...state,
        fetchedAtMs: state.fetchedAtMs - 5_000,
      }),
    ).toBe(true);
  });
});
