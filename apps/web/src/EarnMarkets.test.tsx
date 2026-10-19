import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import EarnMarkets from './EarnMarkets';
import { api } from './lib/api';

afterEach(() => vi.restoreAllMocks());
it('renders explicit unavailable state and stops polling on hide and unmount', () => {
  const cancel = vi.fn();
  const subscribe = vi.spyOn(api, 'subscribeEarnCatalog').mockImplementation((options) => {
    options.onCatalog({
      schemaVersion: 1,
      status: 'not_configured',
      maxAgeMs: 120000,
      products: [],
    });
    options.onState('ready');
    return cancel;
  });
  const view = render(<EarnMarkets />);
  expect(screen.getByText('Earn markets are not available yet.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /deposit/i })).not.toBeInTheDocument();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Market updates paused.')).toBeInTheDocument();
  view.unmount();
  expect(subscribe).toHaveBeenCalledTimes(1);
});
