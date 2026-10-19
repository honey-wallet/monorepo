import type {
  HyperliquidMarginSummary,
  HyperliquidPerpsAccountState,
  HyperliquidPosition,
} from './types';

const address = /^0x[0-9a-fA-F]{40}$/;
const decimal = (value: unknown, signed = false): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  (signed ? /^-?\d+(?:\.\d{1,24})?$/.test(value) : /^\d+(?:\.\d{1,24})?$/.test(value));

function isMarginSummary(value: unknown): value is HyperliquidMarginSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    decimal(row.accountValue) &&
    decimal(row.totalNtlPos) &&
    decimal(row.totalRawUsd, true) &&
    decimal(row.totalMarginUsed)
  );
}

function isPosition(value: unknown): value is HyperliquidPosition {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const position = row.position as Record<string, unknown> | undefined;
  const leverage = position?.leverage as Record<string, unknown> | undefined;
  return (
    (row.type === 'oneWay' || row.type === 'hedged') &&
    !!position &&
    typeof position.coin === 'string' &&
    position.coin.length > 0 &&
    position.coin.length <= 64 &&
    decimal(position.szi, true) &&
    (position.entryPx === null || decimal(position.entryPx)) &&
    decimal(position.positionValue) &&
    decimal(position.unrealizedPnl, true) &&
    decimal(position.marginUsed) &&
    (position.liquidationPx === null || decimal(position.liquidationPx)) &&
    !!leverage &&
    (leverage.type === 'cross' || leverage.type === 'isolated') &&
    Number.isInteger(leverage.value) &&
    (leverage.value as number) > 0
  );
}

export function isHyperliquidPerpsAccountState(
  value: unknown,
): value is HyperliquidPerpsAccountState {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const state = row.state as Record<string, unknown> | undefined;
  return (
    row.schemaVersion === 1 &&
    row.venue === 'hyperliquid' &&
    typeof row.account === 'string' &&
    address.test(row.account) &&
    Number.isSafeInteger(row.fetchedAtMs) &&
    (row.fetchedAtMs as number) > 0 &&
    !!state &&
    isMarginSummary(state.marginSummary) &&
    isMarginSummary(state.crossMarginSummary) &&
    decimal(state.crossMaintenanceMarginUsed) &&
    decimal(state.withdrawable) &&
    Array.isArray(state.assetPositions) &&
    state.assetPositions.length <= 500 &&
    state.assetPositions.every(isPosition) &&
    Number.isSafeInteger(state.time) &&
    (state.time as number) > 0 &&
    (state.time as number) <= (row.fetchedAtMs as number) + 5_000 &&
    (row.fetchedAtMs as number) - (state.time as number) <= 30_000
  );
}
