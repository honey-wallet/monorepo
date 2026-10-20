import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Landing from './Landing';

function respond(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function join(email: string) {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }));
}

describe('Landing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays closed without an API URL instead of faking success', () => {
    render(<Landing apiUrl="" />);
    expect(screen.getByRole('button', { name: 'Join the waitlist' })).toBeDisabled();
    expect(screen.getByLabelText('Email address')).toBeDisabled();
  });

  it('posts the email and shows the success state', async () => {
    const fetch = respond(200, { status: 'joined' });
    render(<Landing apiUrl="https://api.test/" />);
    join('ada@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('You’re on the list');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/api/v1/waitlist');
  });

  it('rejects malformed email locally and shows server errors', async () => {
    const fetch = respond(429, { error: { code: 'too_many_requests', message: 'slow down' } });
    render(<Landing apiUrl="https://api.test" />);
    join('nope');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(fetch).not.toHaveBeenCalled();
    join('ada@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries');
  });
});
