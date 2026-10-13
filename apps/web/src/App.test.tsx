import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/api';

describe('App', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the server version when online', async () => {
    vi.spyOn(api, 'version').mockResolvedValue({ name: 'honey-server', version: '1.2.3' });
    render(<App />);
    expect(await screen.findByText('Connected to honey-server v1.2.3')).toBeInTheDocument();
  });

  it('shows an error when the server is unreachable', async () => {
    vi.spyOn(api, 'version').mockRejectedValue(new Error('Failed to fetch'));
    render(<App />);
    expect(await screen.findByText(/Server unreachable/)).toBeInTheDocument();
  });
});
