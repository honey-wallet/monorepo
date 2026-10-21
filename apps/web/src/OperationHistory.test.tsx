import type { OperationPage, OperationRecovery } from '@honey-wallet/api-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import OperationHistory from './OperationHistory';

const id = '00000000-0000-4000-8000-000000000001';
const wallet = '00000000-0000-4000-8000-000000000002';
const item: OperationPage['items'][number] = {
  operation: { id, walletId: wallet, action: 'earn', state: 'created', version: '0' },
  createdAtMs: 1000,
  updatedAtMs: 1000,
};
afterEach(() => vi.restoreAllMocks());
it('discovers prior requests after a fresh mount and opens recovery without submitting', async () => {
  const list = vi.spyOn(api, 'operations').mockResolvedValue({ items: [item], nextCursor: null });
  const detail: OperationRecovery = {
    operation: item.operation,
    intentAvailable: true,
    executionAvailable: false,
    preparation: null,
    submission: null,
    reconciliation: null,
  };
  const read = vi.spyOn(api, 'operation').mockResolvedValue(detail);
  const submit = vi.spyOn(api, 'submitAave');
  const view = render(<OperationHistory token="session" walletId={wallet} />);
  const open = await screen.findByRole('button', { name: /earn · created/ });
  fireEvent.click(open);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(await screen.findByText(id)).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
  view.unmount();
  render(<OperationHistory token="new-session" walletId={wallet} />);
  await screen.findByRole('button', { name: /earn · created/ });
  expect(list).toHaveBeenCalledTimes(2);
});
it('uses the returned cursor and rejects foreign-wallet summaries', async () => {
  const list = vi
    .spyOn(api, 'operations')
    .mockResolvedValueOnce({ items: [item], nextCursor: id })
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  render(<OperationHistory token="session" walletId={wallet} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Older requests' }));
  await screen.findByText('No Honey requests for this wallet yet.');
  expect(list.mock.calls[1]?.[1]).toEqual({ cursor: id, limit: 10 });
  list.mockResolvedValue({
    items: [{ ...item, operation: { ...item.operation, walletId: id } }],
    nextCursor: null,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Newest requests' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your requests');
  expect(screen.queryByRole('button', { name: /earn · created/ })).not.toBeInTheDocument();
});
it('aborts pending reads and discards a late result after unmount', async () => {
  let resolve: ((p: OperationPage) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  vi.spyOn(api, 'operations').mockImplementation((_token, _options, init) => {
    signal = init?.signal;
    return new Promise((r) => {
      resolve = r;
    });
  });
  const view = render(<OperationHistory token="session" walletId={wallet} />);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve?.({ items: [item], nextCursor: null }));
  expect(screen.queryByText(id)).not.toBeInTheDocument();
});
it('keeps a bridge provider fill separate from source finality and never claims delivery', async () => {
  const bridgeItem: OperationPage['items'][number] = {
    ...item,
    operation: { ...item.operation, action: 'bridge', state: 'succeeded' },
  };
  vi.spyOn(api, 'operations').mockResolvedValue({ items: [bridgeItem], nextCursor: null });
  vi.spyOn(api, 'operation').mockResolvedValue({
    operation: bridgeItem.operation,
    intentAvailable: true,
    executionAvailable: false,
    preparation: null,
    submission: null,
    reconciliation: null,
  });
  vi.spyOn(api, 'bridgeStatus').mockResolvedValue({
    operationId: id,
    binding: {
      provider: 'relay',
      providerReference: 'test-order',
      sourceChainId: '1',
      destinationChainId: '8453',
      refundChainId: '1',
      sourceTransactionHash: `0x${'11'.repeat(32)}`,
    },
    observation: {
      provider: 'relay',
      reportedOutcome: 'fill_reported',
      sourceTransactionSeen: true,
      candidates: [
        { chainId: '8453', transactionHash: `0x${'22'.repeat(32)}`, role: 'destination_fill' },
      ],
      observedAtMs: Date.now(),
      providerUpdatedAtMs: null,
      verificationRequired: true,
      pollAfterMs: 10000,
    },
    stale: false,
    pollVersion: '1',
    nextPollAtMs: Date.now() + 10000,
    lastErrorCode: null,
  });
  render(<OperationHistory token="session" walletId={wallet} />);
  fireEvent.click(await screen.findByRole('button', { name: /bridge · check destination status/ }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Destination fill reported; confirmation is still pending.',
  );
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
  expect(screen.getByText(/Reported destination transaction/)).toHaveTextContent('chain 8453');
});
it('labels bridging as source finality while destination verification is pending', async () => {
  const bridgeItem: OperationPage['items'][number] = {
    ...item,
    operation: { ...item.operation, action: 'bridge', state: 'bridging' },
  };
  vi.spyOn(api, 'operations').mockResolvedValue({ items: [bridgeItem], nextCursor: null });
  vi.spyOn(api, 'operation').mockResolvedValue({
    operation: bridgeItem.operation,
    intentAvailable: true,
    executionAvailable: false,
    preparation: null,
    submission: null,
    reconciliation: null,
  });
  vi.spyOn(api, 'bridgeStatus').mockRejectedValue(new Error('advisory status unavailable'));
  render(<OperationHistory token="session" walletId={wallet} />);
  fireEvent.click(await screen.findByRole('button', { name: /bridge · check destination status/ }));
  expect(
    await screen.findByText('Source finalized; destination delivery pending.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Bridge outcome pending');
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
});
