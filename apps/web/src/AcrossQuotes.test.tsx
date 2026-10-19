import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { acrossFixture } from '../../../packages/api-client/src/fixtures/across';
import AcrossQuotes from './AcrossQuotes';
import { api } from './lib/api';

const fixture = acrossFixture();
const profile = {
  userId: '00000000-0000-4000-8000-000000000001',
  wallet: {
    id: '00000000-0000-4000-8000-000000000002',
    address: fixture.quote.sender,
    chainId: 'eip155:1',
    accountKind: 'eoa' as const,
  },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function submit() {
  fireEvent.change(await screen.findByLabelText('Bridge amount'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Minimum to receive'), { target: { value: '0.98' } });
  fireEvent.click(screen.getByRole('button', { name: 'Get bridge quote' }));
}
it('shows exact minimum, fees, gas units, refund and quote-only availability', async () => {
  vi.spyOn(api, 'acrossConfiguration').mockResolvedValue(fixture.configuration);
  const quoted = vi.spyOn(api, 'acrossQuote').mockImplementation(async () => acrossFixture().quote);
  render(<AcrossQuotes token="secret" profile={profile} />);
  await submit();
  expect(await screen.findByText('Quoted minimum: 0.99 USDC on chain 8453')).toBeInTheDocument();
  expect(screen.getByText(/Bridge fee: 0.01 USDC. Integrator fee: 0/)).toBeInTheDocument();
  expect(screen.getByText(/120000 gas units/)).toBeInTheDocument();
  expect(screen.getByText(/Refund destination if applicable/)).toHaveTextContent(
    fixture.quote.sender,
  );
  expect(screen.getByText(/Bridge signing is not enabled/)).toBeInTheDocument();
  expect(quoted).toHaveBeenCalledWith(
    'secret',
    fixture.request,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.change(screen.getByLabelText('Minimum to receive'), { target: { value: '0.99' } });
  expect(screen.queryByText(/Quoted minimum/)).not.toBeInTheDocument();
});
it('aborts and ignores a stale session response, including the same wallet signing in again', async () => {
  vi.spyOn(api, 'acrossConfiguration').mockResolvedValue(fixture.configuration);
  let resolve: (q: typeof fixture.quote) => void = () => {};
  const quoted = vi.spyOn(api, 'acrossQuote').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<AcrossQuotes token="old" profile={profile} />);
  await submit();
  await waitFor(() => expect(quoted).toHaveBeenCalledOnce());
  const signal = quoted.mock.calls[0]?.[2]?.signal;
  view.rerender(<AcrossQuotes token="new" profile={profile} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(acrossFixture().quote));
  expect(screen.queryByText(/Quoted minimum/)).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Get bridge quote' })).toBeEnabled();
});
it('clears quote details at the actual expiry and on page backgrounding', async () => {
  vi.spyOn(api, 'acrossConfiguration').mockResolvedValue(fixture.configuration);
  vi.spyOn(api, 'acrossQuote').mockImplementation(async () => {
    const q = acrossFixture().quote;
    return { ...q, expiresAtMs: q.receivedAtMs + 500 };
  });
  render(<AcrossQuotes token="secret" profile={profile} />);
  await submit();
  await screen.findByText(/Quoted minimum/);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Quote expired'), {
    timeout: 2000,
  });
  expect(screen.queryByText(/Quoted minimum/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Get bridge quote' }));
  await screen.findByText(/Quoted minimum/);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(screen.queryByText(/Quoted minimum/)).not.toBeInTheDocument();
});
