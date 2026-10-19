import {
  type Addresses,
  type ChainFamily,
  clearPairOfferSecrets,
  clearPairSession,
  createMnemonic,
  isValidMnemonic,
  MIN_PASSWORD_LENGTH,
  normalizeMnemonic,
  type PairOffer,
  type PairSession,
} from '@honey-wallet/keyring';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { HyperliquidAccount } from './HyperliquidAccount';
import { Logo } from './Logo';
import {
  approveBackendSignIn,
  type BackendSignInReview,
  backendAccessToken,
  clearBackendSignIn,
  prepareBackendSignIn,
} from './lib/backend-auth';
import { receiveWallet, startPairing, waitForPhone } from './lib/pair';
import { local, session } from './lib/storage';
import { type Account, type AccountView, createVault, random } from './lib/vault';
import { QRCode } from './QRCode';

const vault = createVault(local, session);

/** A phrase waiting for a password, and where it came from. */
type Pending = { mnemonic: string; accounts: Account[]; from: 'phone' | 'import' | 'new' };

type Screen =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: 'pair' }
  | { name: 'import' }
  | { name: 'create' }
  | { name: 'password'; pending: Pending }
  | { name: 'unlock' }
  | { name: 'home'; mnemonic: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      const mnemonic = await vault.unlocked();
      if (mnemonic) setScreen({ name: 'home', mnemonic });
      else setScreen((await vault.exists()) ? { name: 'unlock' } : { name: 'welcome' });
    })();
  }, []);

  useEffect(
    () =>
      vault.onLock(() => {
        void clearBackendSignIn();
        setScreen({ name: 'unlock' });
      }),
    [],
  );

  const welcome = () => setScreen({ name: 'welcome' });
  const askPassword = (pending: Pending) => setScreen({ name: 'password', pending });

  switch (screen.name) {
    case 'loading':
      return <div className="page" />;
    case 'welcome':
      return <Welcome go={(name) => setScreen({ name } as Screen)} />;
    case 'pair':
      return <Pair onBack={welcome} onWallet={askPassword} />;
    case 'import':
      return <Import onBack={welcome} onPhrase={askPassword} />;
    case 'create':
      return <Create onBack={welcome} onPhrase={askPassword} />;
    case 'password':
      return (
        <SetPassword
          pending={screen.pending}
          onBack={welcome}
          onDone={() => setScreen({ name: 'home', mnemonic: screen.pending.mnemonic })}
        />
      );
    case 'unlock':
      return (
        <Unlock
          onUnlocked={(mnemonic) => setScreen({ name: 'home', mnemonic })}
          onReset={welcome}
        />
      );
    case 'home':
      return <Home mnemonic={screen.mnemonic} onLock={() => setScreen({ name: 'unlock' })} />;
  }
}

// Layout pieces

function Page({
  title,
  onBack,
  children,
  footer,
}: {
  title?: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="page">
      {title || onBack ? (
        <header className="bar">
          {onBack ? (
            <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M15 5l-7 7 7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <span className="icon-button" />
          )}
          <span className="bar-title">{title}</span>
          <span className="icon-button" />
        </header>
      ) : null}
      <main className="content">{children}</main>
      {footer ? <footer className="footer">{footer}</footer> : null}
    </div>
  );
}

function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'text' }) {
  return (
    <button type="button" className={`button ${variant}`} {...props}>
      {children}
    </button>
  );
}

// Screens

function Welcome({ go }: { go: (name: 'pair' | 'import' | 'create') => void }) {
  return (
    <Page
      footer={
        <>
          <Button onClick={() => go('pair')}>Pair with your phone</Button>
          <Button variant="secondary" onClick={() => go('import')}>
            Import a recovery phrase
          </Button>
          <Button variant="text" onClick={() => go('create')}>
            Create a new wallet
          </Button>
        </>
      }
    >
      <div className="hero welcome">
        <Logo height={72} />
        <h1>
          All your crypto,
          <br />
          <span className="honey">one wallet.</span>
        </h1>
        <p>Already using Honey on your phone? Pair to bring your wallet here in seconds.</p>
      </div>
    </Page>
  );
}

type PairState =
  | { step: 'scan' }
  | { step: 'compare'; session: PairSession }
  | { step: 'receiving'; session: PairSession }
  | { step: 'error'; message: string };

function Pair({ onBack, onWallet }: { onBack: () => void; onWallet: (p: Pending) => void }) {
  const [offer, setOffer] = useState<PairOffer>(() => startPairing());
  const [state, setState] = useState<PairState>({ step: 'scan' });
  const abort = useRef<AbortController | null>(null);
  const sessions = useRef(new Set<PairSession>());

  // Wait for the phone to scan this code; a new code restarts the wait.
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: 'scan' });
    waitForPhone(offer, controller.signal)
      .then((session) => {
        if (controller.signal.aborted) {
          clearPairSession(session);
          return;
        }
        sessions.current.add(session);
        setState({ step: 'compare', session });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ step: 'error', message: messageOf(error) });
      });
    return () => {
      controller.abort();
      clearPairOfferSecrets(offer);
      for (const session of sessions.current) clearPairSession(session);
      sessions.current.clear();
    };
  }, [offer]);

  const confirm = (session: PairSession) => {
    setState({ step: 'receiving', session });
    const controller = abort.current;
    if (!controller) return;
    receiveWallet(offer, session, controller.signal)
      .then((payload) =>
        onWallet({ mnemonic: payload.mnemonic, accounts: payload.accounts, from: 'phone' }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ step: 'error', message: messageOf(error) });
      })
      .finally(() => {
        clearPairSession(session);
        sessions.current.delete(session);
      });
  };

  const restart = () => {
    for (const session of sessions.current) clearPairSession(session);
    sessions.current.clear();
    clearPairOfferSecrets(offer);
    setOffer(startPairing());
  };

  if (state.step === 'compare' || state.step === 'receiving') {
    const receiving = state.step === 'receiving';
    return (
      <Page
        title="Pair with your phone"
        onBack={onBack}
        footer={
          receiving ? (
            <Button disabled>Waiting for your phone…</Button>
          ) : (
            <>
              <Button onClick={() => confirm(state.session)}>Codes match</Button>
              <Button variant="secondary" onClick={restart}>
                They don’t match
              </Button>
            </>
          )
        }
      >
        <div className="hero">
          <h2>Check the code</h2>
          <p>
            {receiving
              ? 'Now tap “Codes match” on your phone too. Your wallet comes across encrypted.'
              : 'Your phone shows a code too. They should be the same.'}
          </p>
        </div>
        <div
          className="code"
          role="img"
          aria-label={`Code ${state.session.code.split('').join(' ')}`}
        >
          {state.session.code.slice(0, 3)}
          <span className="code-gap" />
          {state.session.code.slice(3)}
        </div>
        <p className="note center">
          If they’re different, someone may be in between. Don’t continue.
        </p>
      </Page>
    );
  }

  return (
    <Page title="Pair with your phone" onBack={onBack}>
      <div className="qr-card">
        <QRCode value={offer.uri} size={200} />
      </div>
      {state.step === 'error' ? (
        <div className="center stack">
          <p className="error">{state.message}</p>
          <Button variant="secondary" onClick={restart}>
            Show a new code
          </Button>
        </div>
      ) : (
        <ol className="steps">
          <li>Open Honey on your phone</li>
          <li>Tap the scan button on Home</li>
          <li>Point your camera at this code</li>
        </ol>
      )}
      <p className="note center">
        Only your phone can read what it sends. The code expires in 5 minutes.
      </p>
    </Page>
  );
}

function Import({ onBack, onPhrase }: { onBack: () => void; onPhrase: (p: Pending) => void }) {
  const [phrase, setPhrase] = useState('');
  const words = normalizeMnemonic(phrase).split(' ').filter(Boolean);
  const complete = words.length === 12 || words.length === 24;
  const valid = complete && isValidMnemonic(phrase);
  return (
    <Page
      title="Import a wallet"
      onBack={onBack}
      footer={
        <Button
          disabled={!valid}
          onClick={() =>
            onPhrase({ mnemonic: normalizeMnemonic(phrase), accounts: [], from: 'import' })
          }
        >
          {valid ? 'Continue' : `Enter ${words.length > 12 ? 24 : 12} words`}
        </Button>
      }
    >
      <div className="hero">
        <h2>Enter your recovery phrase</h2>
        <p>12 or 24 words, in order. It stays in this browser, encrypted.</p>
      </div>
      <textarea
        className={`field phrase ${complete && !valid ? 'invalid' : ''}`}
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="word1 word2 word3 …"
        spellCheck={false}
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: the only field on the screen
        autoFocus
      />
      <p className={`note ${complete && !valid ? 'error' : ''}`}>
        {complete && !valid
          ? 'These words don’t make a valid phrase. Check the spelling and order.'
          : `${words.length} / ${words.length > 12 ? 24 : 12} words`}
      </p>
    </Page>
  );
}

function Create({ onBack, onPhrase }: { onBack: () => void; onPhrase: (p: Pending) => void }) {
  const [mnemonic] = useState(() => createMnemonic(random));
  const [written, setWritten] = useState(false);
  const words = mnemonic.split(' ');
  const half = words.length / 2;
  return (
    <Page
      title="New wallet"
      onBack={onBack}
      footer={
        <Button
          disabled={!written}
          onClick={() => onPhrase({ mnemonic, accounts: [], from: 'new' })}
        >
          Continue
        </Button>
      }
    >
      <div className="hero">
        <h2>Write down your recovery phrase</h2>
        <p>These 12 words are the key to your wallet. Keep them on paper, somewhere safe.</p>
      </div>
      <div className="words">
        {[0, half].map((start) => (
          <div key={start} className="column">
            {words.slice(start, start + half).map((word, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a phrase's order never changes
              <div key={start + i} className="word">
                <span className="index">{start + i + 1}</span>
                {word}
              </div>
            ))}
          </div>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} />
        I’ve written it down somewhere safe
      </label>
    </Page>
  );
}

function SetPassword({
  pending,
  onBack,
  onDone,
}: {
  pending: Pending;
  onBack: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_PASSWORD_LENGTH && confirm === password && !busy;

  const save = async () => {
    setBusy(true);
    await vault.save(pending.mnemonic, password, pending.accounts);
    onDone();
  };

  return (
    <Page
      title={pending.from === 'phone' ? 'Paired' : 'Set a password'}
      onBack={onBack}
      footer={
        // Submits the form below, so Enter in either field works too.
        <Button type="submit" form="set-password" disabled={!ready}>
          {busy ? 'Encrypting…' : 'Open wallet'}
        </Button>
      }
    >
      <div className="hero">
        <h2>{pending.from === 'phone' ? 'Your wallet is here' : 'Lock it with a password'}</h2>
        <p>
          You’ll use this password to unlock Honey in this browser. It never leaves this computer,
          and it’s separate from your phone.
        </p>
      </div>
      <form
        id="set-password"
        className="card fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save();
        }}
      >
        <input
          className="field"
          type="password"
          placeholder="Password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: the first field on the screen
          autoFocus
        />
        <input
          className="field"
          type="password"
          placeholder="Confirm password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </form>
      <p className={`note ${mismatch ? 'error' : ''}`}>
        {mismatch ? 'The passwords don’t match.' : `At least ${MIN_PASSWORD_LENGTH} characters.`}
      </p>
    </Page>
  );
}

function Unlock({
  onUnlocked,
  onReset,
}: {
  onUnlocked: (mnemonic: string) => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const unlock = async () => {
    setBusy(true);
    const ok = await vault.unlock(password);
    setBusy(false);
    if (!ok) {
      setWrong(true);
      return;
    }
    const mnemonic = await vault.unlocked();
    if (mnemonic) onUnlocked(mnemonic);
  };

  return (
    <Page
      footer={
        <>
          <Button disabled={!password || busy} onClick={unlock}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          {confirmReset ? (
            <Button
              variant="text"
              className="button text danger"
              onClick={async () => {
                await vault.reset();
                onReset();
              }}
            >
              Remove wallet from this browser
            </Button>
          ) : (
            <Button variant="text" onClick={() => setConfirmReset(true)}>
              Forgot password?
            </Button>
          )}
        </>
      }
    >
      <div className="hero welcome">
        <Logo height={56} />
        <h2>Welcome back</h2>
        <p>
          {confirmReset
            ? 'You can remove the wallet here and pair again with your phone, or import your phrase. Your funds stay safe.'
            : 'Enter your password to unlock.'}
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password) unlock();
        }}
      >
        <input
          className={`field solo ${wrong ? 'invalid' : ''}`}
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
          }}
          // biome-ignore lint/a11y/noAutofocus: the only field on the screen
          autoFocus
        />
      </form>
      {wrong ? <p className="note error center">Wrong password.</p> : null}
    </Page>
  );
}

const CHAINS: { family: ChainFamily; name: string; symbol: string }[] = [
  { family: 'evm', name: 'Ethereum & Base', symbol: 'ETH' },
  { family: 'bitcoin', name: 'Bitcoin', symbol: 'BTC' },
  { family: 'solana', name: 'Solana', symbol: 'SOL' },
  { family: 'tron', name: 'Tron', symbol: 'TRX' },
  { family: 'xrp', name: 'XRP Ledger', symbol: 'XRP' },
];

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Home({ mnemonic, onLock }: { mnemonic: string; onLock: () => void }) {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState<ChainFamily | null>(null);
  const [backendReview, setBackendReview] = useState<BackendSignInReview | null>(null);
  const [backendAddress, setBackendAddress] = useState<string | null>(null);
  const [backendBusy, setBackendBusy] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const backendRequestGeneration = useRef(0);

  useEffect(() => {
    vault.accounts(mnemonic).then(setAccounts);
  }, [mnemonic]);

  const account = accounts?.[active];
  const accessToken = backendAccessToken();

  const prepareSignIn = async () => {
    if (!account || backendBusy) return;
    const requestGeneration = ++backendRequestGeneration.current;
    setBackendBusy(true);
    setBackendError(null);
    setBackendReview(null);
    setBackendAddress(null);
    try {
      const extensionId = globalThis.chrome?.runtime?.id;
      if (!extensionId) throw new Error('Open Honey from the installed browser extension.');
      const review = await prepareBackendSignIn(account, `chrome-extension://${extensionId}`);
      if (requestGeneration === backendRequestGeneration.current) setBackendReview(review);
    } catch (error) {
      if (requestGeneration === backendRequestGeneration.current) setBackendError(messageOf(error));
    } finally {
      setBackendBusy(false);
    }
  };

  const approveSignIn = async () => {
    if (!backendReview || backendBusy) return;
    const requestGeneration = backendRequestGeneration.current;
    setBackendBusy(true);
    setBackendError(null);
    try {
      const address = await approveBackendSignIn(mnemonic, backendReview);
      if (requestGeneration !== backendRequestGeneration.current) {
        await clearBackendSignIn();
        return;
      }
      setBackendAddress(address);
      setBackendReview(null);
    } catch (error) {
      if (requestGeneration === backendRequestGeneration.current) setBackendError(messageOf(error));
      else if (error instanceof Error && /revocation failed/i.test(error.message))
        setBackendError(error.message);
    } finally {
      setBackendBusy(false);
    }
  };

  const copy = async (family: ChainFamily, addresses: Addresses) => {
    await navigator.clipboard.writeText(addresses[family]);
    setCopied(family);
    setTimeout(() => setCopied((c) => (c === family ? null : c)), 1500);
  };

  return (
    <Page
      footer={
        <Button
          variant="secondary"
          onClick={async () => {
            await vault.lock();
            onLock();
          }}
        >
          Lock
        </Button>
      }
    >
      <header className="home-head">
        <Logo height={28} />
        {accounts && accounts.length > 1 ? (
          <select
            className="account-select"
            value={active}
            onChange={async (e) => {
              const requestGeneration = ++backendRequestGeneration.current;
              setBackendAddress(null);
              setBackendReview(null);
              setActive(Number(e.target.value));
              const revoked = await clearBackendSignIn();
              if (requestGeneration === backendRequestGeneration.current)
                setBackendError(
                  revoked
                    ? null
                    : 'Signed out here, but server revocation failed. This session expires within 15 minutes.',
                );
            }}
            aria-label="Wallet"
          >
            {accounts.map((a, i) => (
              <option key={a.index} value={i}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="account-name">{account?.label}</span>
        )}
      </header>

      <p className="section">Your addresses</p>
      <div className="card list">
        {account
          ? CHAINS.map((chain) => (
              <div key={chain.family} className="row">
                <span className="token">{chain.symbol}</span>
                <span className="row-text">
                  <span className="row-title">{chain.name}</span>
                  <span className="row-sub">{short(account.addresses[chain.family])}</span>
                </span>
                <button
                  type="button"
                  className="pill"
                  onClick={() => copy(chain.family, account.addresses)}
                >
                  {copied === chain.family ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))
          : CHAINS.map((chain) => <div key={chain.family} className="row skeleton" />)}
      </div>
      <p className="note">
        Each network has its own address. Send only that network’s tokens to it.
      </p>
      <p className="section">Honey account</p>
      <div className="card">
        {backendAddress ? (
          <>
            <p role="status">Signed in as {short(backendAddress)} for this popup session.</p>
            {accessToken ? (
              <HyperliquidAccount
                key={backendAddress.toLowerCase()}
                token={accessToken}
                address={backendAddress}
              />
            ) : null}
            <Button
              variant="secondary"
              onClick={async () => {
                const requestGeneration = ++backendRequestGeneration.current;
                setBackendAddress(null);
                const revoked = await clearBackendSignIn();
                if (requestGeneration === backendRequestGeneration.current)
                  setBackendError(
                    revoked
                      ? null
                      : 'Signed out here, but server revocation failed. This session expires within 15 minutes.',
                  );
              }}
            >
              Sign out
            </Button>
          </>
        ) : backendReview ? (
          <>
            <p>Review this sign-in message. It grants no transaction authority.</p>
            <pre className="note" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {backendReview.challenge.message}
            </pre>
            <Button disabled={backendBusy} onClick={() => void approveSignIn()}>
              {backendBusy ? 'Signing in…' : 'Approve sign-in'}
            </Button>
            <Button
              variant="text"
              onClick={() => {
                backendRequestGeneration.current += 1;
                void clearBackendSignIn();
                setBackendReview(null);
                setBackendBusy(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <p>
              Create a short-lived Honey account session for this popup to view read-only provider
              data.
            </p>
            <Button disabled={!account || backendBusy} onClick={() => void prepareSignIn()}>
              {backendBusy ? 'Preparing sign-in…' : 'Sign in to Honey'}
            </Button>
          </>
        )}
        {backendError ? <p className="note error">{backendError}</p> : null}
      </div>
    </Page>
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
