import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { swapFixture } from '../../../packages/api-client/src/fixtures/swaps';
import { api } from './lib/api';
import SwapQuotes from './SwapQuotes';

const fixture = swapFixture();
const profile = {
  userId: '00000000-0000-4000-8000-000000000001',
  wallet: {
    id: '00000000-0000-4000-8000-000000000002',
    address: fixture.quote.signer,
    chainId: 'eip155:1',
    accountKind: 'eoa' as const,
  },
};
afterEach(() => vi.restoreAllMocks());
it('shows net token output and fee without acquiring signatures or implying execution', async () => {
  vi.spyOn(api, 'swapConfiguration').mockResolvedValue(fixture.configuration);
  const quoted = vi.spyOn(api, 'swapQuote').mockImplementation(async () => swapFixture().quote);
  render(<SwapQuotes token="test-token" profile={profile} />);
  fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  expect(await screen.findByText('Estimated receive: 0.00000000000198 OUT')).toBeInTheDocument();
  expect(screen.getByText(/Integrator fee: 0.00000000000002 OUT/)).toBeInTheDocument();
  expect(screen.getByText(/Swap signing is not enabled/)).toBeInTheDocument();
  expect(quoted).toHaveBeenCalledWith(
    'test-token',
    fixture.request,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it('aborts and ignores the previous session response', async () => {
  vi.spyOn(api, 'swapConfiguration').mockResolvedValue(fixture.configuration);
  let resolve: (v: typeof fixture.quote) => void = () => {};
  const quoted = vi.spyOn(api, 'swapQuote').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<SwapQuotes token="old" profile={profile} />);
  fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  await waitFor(() => expect(quoted).toHaveBeenCalledOnce());
  const signal = quoted.mock.calls[0]?.[2]?.signal;
  view.rerender(<SwapQuotes token="new" profile={profile} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(swapFixture().quote));
  expect(screen.queryByText(/Estimated receive/)).not.toBeInTheDocument();
});
