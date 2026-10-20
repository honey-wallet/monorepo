import type { WaitlistResponse } from '@honey-wallet/api-client';
import { type FormEvent, useId, useState } from 'react';
import './landing.css';

type FormState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'joined' }
  | { kind: 'error'; message: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorMessage(status: number | null): string {
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  if (status === 400) return 'That email doesn’t look right.';
  return 'Something went wrong. Please try again.';
}

// Plain fetch keeps the landing bundle small; the shape matches the API client's
// `joinWaitlist` (POST /api/v1/waitlist -> WaitlistResponse).
async function joinWaitlist(baseUrl: string, email: string): Promise<WaitlistResponse> {
  const response = await fetch(`${baseUrl}/api/v1/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email, source: 'web' }),
  });
  if (!response.ok) throw response.status;
  return (await response.json()) as WaitlistResponse;
}

export default function Landing({ apiUrl = import.meta.env.VITE_API_URL }: { apiUrl?: string }) {
  const baseUrl = apiUrl?.trim().replace(/\/+$/, '') || null;
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });
  const inputId = useId();
  const noteId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!baseUrl || state.kind === 'sending') return;
    const value = email.trim();
    if (!EMAIL_SHAPE.test(value)) {
      setState({ kind: 'error', message: 'Enter a valid email address.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      await joinWaitlist(baseUrl, value);
      setState({ kind: 'joined' });
    } catch (error) {
      setState({
        kind: 'error',
        message: errorMessage(typeof error === 'number' ? error : null),
      });
    }
  }

  const closed = baseUrl === null;

  return (
    <div className="landing">
      <main className="landing-hero">
        <p className="landing-lockup">
          <img className="landing-mark" src="/honey-mark.svg" alt="" width="32" height="28" />
          Honey Wallet
        </p>
        <h1 className="landing-title">The only wallet built for a post‑quantum world.</h1>

        {state.kind === 'joined' ? (
          <p className="landing-joined" role="status">
            <span aria-hidden="true">✓</span> You’re on the list. We’ll email you when Honey is
            ready.
          </p>
        ) : (
          <form className="landing-form" onSubmit={submit} noValidate>
            <label className="landing-label" htmlFor={inputId}>
              Email address
            </label>
            <div className="landing-row">
              <input
                id={inputId}
                className="landing-input"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                placeholder="Your email"
                required
                disabled={closed}
                value={email}
                aria-invalid={state.kind === 'error'}
                aria-describedby={noteId}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (state.kind === 'error') setState({ kind: 'idle' });
                }}
              />
              <button
                className="landing-button"
                type="submit"
                disabled={closed || state.kind === 'sending'}
              >
                {state.kind === 'sending' ? 'Joining…' : 'Join the waitlist'}
              </button>
            </div>
            <p id={noteId} className="landing-note landing-error" role="alert">
              {state.kind === 'error' ? state.message : null}
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
