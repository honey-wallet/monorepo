import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/api';

describe('App', () => {
  beforeEach(() => {
    vi.spyOn(api, 'subscribeEarnCatalog').mockReturnValue(() => {});
    vi.spyOn(api, 'polymarketCatalog').mockResolvedValue({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: Date.now(),
      ageMs: 0,
      sourceTruncated: false,
      nextCursor: null,
      markets: [],
    });
    vi.spyOn(api, 'authConfiguration').mockResolvedValue({
      enabled: false,
      method: null,
      origin: null,
      chainId: null,
      sessionTtlSeconds: 900,
    });
    vi.spyOn(api, 'capabilities').mockResolvedValue({ schemaVersion: 3, features: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the server version when online', async () => {
    vi.spyOn(api, 'version').mockResolvedValue({ name: 'honey-server', version: '1.2.3' });
    render(<App />);
    expect(await screen.findByText('Connected to honey-server v1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Live wallet services are not available yet.')).toBeInTheDocument();
  });

  it('keeps the version visible when capability discovery fails closed', async () => {
    vi.spyOn(api, 'version').mockResolvedValue({ name: 'honey-server', version: '1.2.3' });
    vi.mocked(api.capabilities).mockRejectedValue(new Error('Unavailable'));
    render(<App />);
    expect(await screen.findByText('Connected to honey-server v1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Could not check live wallet services.')).toBeInTheDocument();
  });

  it('shows an error when the server is unreachable', async () => {
    vi.spyOn(api, 'version').mockRejectedValue(new Error('Failed to fetch'));
    render(<App />);
    expect(await screen.findByText(/Server unreachable/)).toBeInTheDocument();
  });

  it('distinguishes local-fork configuration from production availability', async () => {
    vi.spyOn(api, 'version').mockResolvedValue({ name: 'honey-server', version: '1.2.3' });
    vi.spyOn(api, 'capabilities').mockResolvedValue({
      schemaVersion: 3,
      features: [
        {
          id: 'earn',
          available: false,
          scope: 'local_testnet',
          reason: 'local_testnet_only',
          providers: ['aave'],
          configuredProviders: ['aave'],
        },
      ],
    });
    render(<App />);
    expect(
      await screen.findByText(
        'Local testnet integrations are configured; production transactions are unavailable.',
      ),
    ).toBeInTheDocument();
  });
});
