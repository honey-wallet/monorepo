import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import HyperliquidAccount from './HyperliquidAccount';
import { api } from './lib/api';
import RelayQuotePreview from './RelayQuotePreview';

const profile = {
  userId: '00000000-0000-4000-8000-000000000001',
  wallet: {
    id: '00000000-0000-4000-8000-000000000002',
    address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    chainId: 'eip155:1',
    accountKind: 'eoa' as const,
  },
};

afterEach(() => vi.restoreAllMocks());

it('shows Relay steps as a preview and never offers an execution action', async () => {
  const preview = vi.spyOn(api, 'relayQuotePreview').mockResolvedValue({
    provider: 'relay',
    requestId: 'req-1',
    executionAvailable: false,
    steps: [
      {
        index: 0,
        id: 'deposit',
        kind: 'transaction',
        action: 'deposit',
        description: 'Bridge assets',
        itemCount: 1,
      },
    ],
  });
  render(<RelayQuotePreview token="secret" profile={profile} />);
  fireEvent.change(screen.getByLabelText('Amount (native token)'), { target: { value: '0.25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview with Relay' }));
  expect(await screen.findByText('deposit: Bridge assets (1 items)')).toBeInTheDocument();
  expect(screen.getByText(/cannot be signed or submitted/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sign|submit|execute/i })).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledWith(
    'secret',
    expect.objectContaining({ user: profile.wallet.address, amount: '250000000000000000' }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('clears Relay details when the request parameters change', async () => {
  vi.spyOn(api, 'relayQuotePreview').mockResolvedValue({
    provider: 'relay',
    requestId: 'req-1',
    executionAvailable: false,
    steps: [
      {
        index: 0,
        id: 'step',
        kind: 'signature',
        action: 'sign',
        description: 'Permit',
        itemCount: 1,
      },
    ],
  });
  render(<RelayQuotePreview token="secret" profile={profile} />);
  fireEvent.change(screen.getByLabelText('Amount (native token)'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview with Relay' }));
  await screen.findByText('sign: Permit (1 items)');
  fireEvent.change(screen.getByLabelText('Destination chain ID'), { target: { value: '10' } });
  expect(screen.queryByText('sign: Permit (1 items)')).not.toBeInTheDocument();
});

it('displays only the authenticated wallet account response', async () => {
  const result = {
    schemaVersion: 1 as const,
    venue: 'hyperliquid' as const,
    account: profile.wallet.address,
    fetchedAtMs: Date.now(),
    state: {
      marginSummary: {
        accountValue: '1200',
        totalNtlPos: '250',
        totalRawUsd: '0',
        totalMarginUsed: '50',
      },
      crossMarginSummary: {
        accountValue: '1200',
        totalNtlPos: '250',
        totalRawUsd: '0',
        totalMarginUsed: '50',
      },
      crossMaintenanceMarginUsed: '15',
      withdrawable: '1150',
      assetPositions: [
        {
          type: 'oneWay' as const,
          position: {
            coin: 'BTC',
            szi: '0.01',
            entryPx: '60000',
            positionValue: '600',
            unrealizedPnl: '5',
            marginUsed: '50',
            liquidationPx: '50000',
            leverage: { type: 'cross' as const, value: 5 },
          },
        },
      ],
      time: Date.now(),
    },
  };
  const read = vi.spyOn(api, 'hyperliquidPerpsAccount').mockResolvedValue(result);
  render(<HyperliquidAccount token="secret" profile={profile} />);
  fireEvent.click(screen.getByRole('button', { name: 'Load account' }));
  expect(
    await screen.findByText('BTC: 0.01 · unrealized PnL $5 · 5x cross · liquidation 50000'),
  ).toBeInTheDocument();
  expect(screen.getByText('Account value: $1200')).toBeInTheDocument();
  expect(screen.getByText(/No orders are submitted/)).toBeInTheDocument();
  expect(read).toHaveBeenCalledWith(
    'secret',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('rejects a Hyperliquid response bound to another address', async () => {
  vi.spyOn(api, 'hyperliquidPerpsAccount').mockResolvedValue({
    schemaVersion: 1,
    venue: 'hyperliquid',
    account: '0x0000000000000000000000000000000000000001',
    fetchedAtMs: Date.now(),
    state: {
      marginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMarginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '0',
      assetPositions: [],
      time: Date.now(),
    },
  });
  render(<HyperliquidAccount token="secret" profile={profile} />);
  fireEvent.click(screen.getByRole('button', { name: 'Load account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('did not match the signed-in wallet');
  expect(screen.queryByText(/Account value:/)).not.toBeInTheDocument();
});

it('aborts and clears Hyperliquid account data when the tab is hidden', async () => {
  let requestSignal: AbortSignal | undefined;
  vi.spyOn(api, 'hyperliquidPerpsAccount').mockImplementation((_token, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise(() => {});
  });
  render(<HyperliquidAccount token="secret" profile={profile} />);
  fireEvent.click(screen.getByRole('button', { name: 'Load account' }));
  expect(requestSignal?.aborted).toBe(false);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(requestSignal?.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Load account' })).toBeEnabled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(api.hyperliquidPerpsAccount).toHaveBeenCalledTimes(1);
});
