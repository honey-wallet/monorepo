import {
  type AuthConfiguration,
  type SignInChallenge,
  validateSignInChallenge,
  type WalletProfile,
} from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import HyperliquidAccount from './HyperliquidAccount';
import { api } from './lib/api';
import OperationHistory from './OperationHistory';
import RelayQuotePreview from './RelayQuotePreview';
import SwapQuotes from './SwapQuotes';

export interface EthereumProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

type Review = { challenge: SignInChallenge; address: string; chainId: string };

function injectedProvider(): EthereumProvider | null {
  const provider = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  return provider &&
    typeof provider.request === 'function' &&
    typeof provider.on === 'function' &&
    typeof provider.removeListener === 'function'
    ? provider
    : null;
}

function firstAccount(value: unknown): string {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(value[0])
  ) {
    throw new Error('Choose an EVM account in your browser wallet.');
  }
  return value[0];
}

function chainId(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value) || value.length > 18) {
    throw new Error('Your wallet returned an unsupported network.');
  }
  return `eip155:${BigInt(value)}`;
}

/** Working EOA identity slice; it does not enable transaction/signing features. */
export default function WalletSignIn() {
  const [configuration, setConfiguration] = useState<AuthConfiguration | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const generation = useRef(0);
  const provider = useRef<EthereumProvider | null>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .authConfiguration({ signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setConfiguration(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not check wallet sign-in availability.');
      });
    return () => {
      controller.abort();
      generation.current++;
      detach.current?.();
      const current = token.current;
      token.current = null;
      if (current) void api.signOut(current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => {
        token.current = null;
        setProfile(null);
        setExpiresAt(null);
        setError('Your session expired. Sign in again to continue.');
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  function observe(wallet: EthereumProvider) {
    detach.current?.();
    provider.current = wallet;
    const reset = () => {
      generation.current++;
      const current = token.current;
      token.current = null;
      setReview(null);
      setProfile(null);
      setExpiresAt(null);
      setBusy(false);
      setError('Your wallet or network changed. Sign in again to continue.');
      if (current) void api.signOut(current).catch(() => {});
    };
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) wallet.on(event, reset);
    detach.current = () => {
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect'])
        wallet.removeListener(event, reset);
    };
  }

  async function connect() {
    if (
      !configuration?.enabled ||
      !configuration.chainId ||
      configuration.origin !== window.location.origin
    ) {
      setError('Wallet sign-in is not configured for this website.');
      return;
    }
    const wallet = injectedProvider();
    if (!wallet) {
      setError('Open this page with an EVM browser wallet to sign in.');
      return;
    }
    const attempt = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      // A connect prompt can emit accountsChanged, so install our new listener only
      // after this initial selection. Existing listeners are removed first.
      detach.current?.();
      const address = firstAccount(await wallet.request({ method: 'eth_requestAccounts' }));
      const chain = chainId(await wallet.request({ method: 'eth_chainId' }));
      if (generation.current !== attempt) return;
      if (chain !== configuration.chainId) {
        setError(`Select network ${configuration.chainId} in your wallet, then try again.`);
        return;
      }
      observe(wallet);
      const challenge = await api.createSignInChallenge(address, chain);
      validateSignInChallenge(challenge, {
        origin: window.location.origin,
        address,
        chainId: chain,
      });
      if (generation.current === attempt) setReview({ challenge, address, chainId: chain });
    } catch {
      if (generation.current === attempt)
        setError('Could not start sign-in. Check your wallet and try again.');
    } finally {
      if (generation.current === attempt) setBusy(false);
    }
  }

  async function signIn() {
    if (!review || !provider.current) return;
    const wallet = provider.current;
    const attempt = ++generation.current;
    setBusy(true);
    setError(null);
    let issuedToken: string | null = null;
    try {
      validateSignInChallenge(review.challenge, { origin: window.location.origin, ...review });
      const assertSelection = async () => {
        const [accounts, chain] = await Promise.all([
          wallet.request({ method: 'eth_accounts' }),
          wallet.request({ method: 'eth_chainId' }),
        ]);
        if (
          generation.current !== attempt ||
          firstAccount(accounts).toLowerCase() !== review.address.toLowerCase() ||
          chainId(chain) !== review.chainId
        ) {
          throw new Error('Wallet selection changed');
        }
      };
      await assertSelection();
      const messageHex = Array.from(new TextEncoder().encode(review.challenge.message), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const signature = await wallet.request({
        method: 'personal_sign',
        params: [`0x${messageHex}`, review.address],
      });
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature))
        throw new Error('Invalid signature');
      await assertSelection();
      const session = await api.verifySignIn(review.challenge.id, signature);
      issuedToken = session.accessToken;
      // Browser-origin sessions must remain access-only. The server enforces this
      // based on Origin; reject and revoke if a deployment ever returns a refresh
      // credential to this JavaScript client.
      if (session.refreshToken !== null || session.refreshExpiresAt !== null)
        throw new Error('Unexpected persistent browser session');
      // Read the protected resource too; don't infer access from a signing prompt.
      const authenticated = await api.profile(session.accessToken);
      await assertSelection();
      if (
        authenticated.userId !== session.profile.userId ||
        authenticated.wallet.id !== session.profile.wallet.id ||
        authenticated.wallet.address.toLowerCase() !== review.address.toLowerCase() ||
        authenticated.wallet.chainId !== review.chainId ||
        Date.parse(session.expiresAt) <= Date.now() ||
        Date.parse(session.expiresAt) > Date.now() + 930_000
      )
        throw new Error('Invalid session');
      token.current = session.accessToken;
      issuedToken = null;
      setProfile(authenticated);
      setExpiresAt(session.expiresAt);
      setReview(null);
    } catch {
      if (generation.current === attempt) {
        setReview(null);
        setError('Sign-in did not complete. Connect again to create a fresh request.');
      }
    } finally {
      if (issuedToken) void api.signOut(issuedToken).catch(() => {});
      if (generation.current === attempt) setBusy(false);
    }
  }

  async function signOut() {
    generation.current++;
    const current = token.current;
    token.current = null;
    setProfile(null);
    setExpiresAt(null);
    setError(null);
    if (current) {
      try {
        await api.signOut(current);
      } catch {
        setError(
          'Signed out here. Server revocation could not be confirmed; the session expires within 15 minutes.',
        );
      }
    }
  }

  return (
    <section aria-label="Wallet sign-in">
      {error && <p role="alert">{error}</p>}
      {configuration?.enabled === false && <p>Wallet sign-in is not available yet.</p>}
      {configuration?.enabled && !profile && !review && (
        <button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect wallet to sign in'}
        </button>
      )}
      {review && (
        <>
          <p>Review this sign-in request. Your wallet will ask you to confirm.</p>
          <pre className="sign-in-message">{review.challenge.message}</pre>
          <button type="button" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Signing in…' : 'Sign in with this wallet'}
          </button>
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            Cancel
          </button>
        </>
      )}
      {profile && (
        <>
          <p>Signed in as {profile.wallet.address}</p>
          {token.current ? (
            <SwapQuotes
              key={`quotes-${profile.wallet.id}`}
              token={token.current}
              profile={profile}
            />
          ) : null}
          {token.current ? (
            <RelayQuotePreview
              key={`relay-${profile.wallet.id}-${token.current}`}
              token={token.current}
              profile={profile}
            />
          ) : null}
          {token.current ? (
            <HyperliquidAccount
              key={`hyperliquid-${profile.wallet.id}-${token.current}`}
              token={token.current}
              profile={profile}
            />
          ) : null}
          {token.current ? (
            <OperationHistory
              key={profile.wallet.id}
              token={token.current}
              walletId={profile.wallet.id}
            />
          ) : null}
          <p>
            Network {profile.wallet.chainId}. Session expires{' '}
            {expiresAt ? new Date(expiresAt).toLocaleTimeString() : ''}.
          </p>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      )}
    </section>
  );
}
