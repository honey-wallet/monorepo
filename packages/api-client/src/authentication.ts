import type {
  AuthConfiguration,
  AuthenticatedSession,
  SignInChallenge,
  WalletProfile,
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const CHAIN = /^eip155:[1-9][0-9]*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const STATEMENT = 'Sign in to Honey Wallet. This does not authorize transactions.';

/**
 * Validate the exact Honey SIWE subset before asking a wallet to sign. `origin`
 * must come from trusted app configuration (window.location.origin on web), never
 * from the challenge or discovery response. Chrome extension origins are accepted only
 * for canonical installed IDs. The UI must still obtain user consent; general-purpose
 * SIWE messages and resources are rejected.
 */
export function validateSignInChallenge(
  challenge: SignInChallenge,
  expected: { origin: string; address: string; chainId: string },
  now = Date.now(),
): void {
  validateChallenge(challenge, expected, STATEMENT, now);
}

export function validateWalletLinkChallenge(
  challenge: SignInChallenge,
  expected: { origin: string; address: string; chainId: string },
  now = Date.now(),
): void {
  validateChallenge(
    challenge,
    expected,
    'Link this wallet to my Honey Wallet account. This does not authorize transactions.',
    now,
  );
}

function validateChallenge(
  challenge: SignInChallenge,
  expected: { origin: string; address: string; chainId: string },
  statement: string,
  now: number,
): void {
  const origin = new URL(expected.origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  // Chrome extension IDs have a fixed alphabet and length. This only accepts the
  // exact installed extension origin supplied by trusted build configuration.
  const extension = origin.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(origin.hostname);
  const normalizedOrigin = extension ? `chrome-extension://${origin.hostname}` : origin.origin;
  if (
    normalizedOrigin !== expected.origin ||
    (extension &&
      ((origin.pathname !== '' && origin.pathname !== '/') ||
        origin.search !== '' ||
        origin.hash !== '' ||
        origin.port !== '')) ||
    !(origin.protocol === 'https:' || (local && origin.protocol === 'http:') || extension) ||
    !ADDRESS.test(expected.address) ||
    !CHAIN.test(expected.chainId) ||
    !UUID.test(challenge.id)
  )
    throw new Error('Invalid sign-in context');
  const lines = challenge.message.split('\n');
  const issued = lines[9]?.replace(/^Issued At: /, '') ?? '';
  const expires = lines[10]?.replace(/^Expiration Time: /, '') ?? '';
  const issuedAt = Date.parse(issued);
  const expiresAt = Date.parse(expires);
  if (
    lines.length !== 12 ||
    lines[0] !== `${origin.host} wants you to sign in with your Ethereum account:` ||
    lines[1]?.toLowerCase() !== expected.address.toLowerCase() ||
    lines[2] !== '' ||
    lines[3] !== statement ||
    lines[4] !== '' ||
    lines[5] !== `URI: ${expected.origin}` ||
    lines[6] !== 'Version: 1' ||
    lines[7] !== `Chain ID: ${expected.chainId.slice(7)}` ||
    !/^Nonce: [0-9a-f]{32}$/.test(lines[8] ?? '') ||
    lines[9] !== `Issued At: ${issued}` ||
    lines[10] !== `Expiration Time: ${expires}` ||
    lines[11] !== `Request ID: ${challenge.id}` ||
    expires !== challenge.expiresAt ||
    !TIMESTAMP.test(issued) ||
    !TIMESTAMP.test(expires) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 30_000 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 300_000
  )
    throw new Error('The sign-in request does not match this app, wallet, or session');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function isAuthConfiguration(value: unknown): value is AuthConfiguration {
  return (
    object(value) &&
    value.sessionTtlSeconds === 900 &&
    ((value.enabled === false &&
      value.method === null &&
      value.origin === null &&
      value.chainId === null) ||
      (value.enabled === true &&
        value.method === 'siwe_eoa' &&
        typeof value.origin === 'string' &&
        typeof value.chainId === 'string' &&
        CHAIN.test(value.chainId)))
  );
}

export function isChallenge(value: unknown): value is SignInChallenge {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    typeof value.message === 'string' &&
    value.message.length <= 2048 &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

export function isProfile(value: unknown): value is WalletProfile {
  return (
    object(value) &&
    typeof value.userId === 'string' &&
    UUID.test(value.userId) &&
    isWalletIdentity(value.wallet)
  );
}

export function isWalletIdentity(value: unknown): value is WalletProfile['wallet'] {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    typeof value.chainId === 'string' &&
    CHAIN.test(value.chainId) &&
    typeof value.address === 'string' &&
    ADDRESS.test(value.address) &&
    value.accountKind === 'eoa'
  );
}

export function isWalletList(value: unknown): value is WalletProfile['wallet'][] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(isWalletIdentity)
  )
    return false;
  const ids = new Set(value.map((wallet) => wallet.id));
  const addresses = new Set(
    value.map((wallet) => `${wallet.chainId}:${wallet.address.toLowerCase()}`),
  );
  return ids.size === value.length && addresses.size === value.length;
}

export function isSession(value: unknown): value is AuthenticatedSession {
  return (
    object(value) &&
    typeof value.accessToken === 'string' &&
    /^[0-9a-f]{64}$/.test(value.accessToken) &&
    value.tokenType === 'Bearer' &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    ((value.refreshToken === null && value.refreshExpiresAt === null) ||
      (typeof value.refreshToken === 'string' &&
        /^[0-9a-f]{64}$/.test(value.refreshToken) &&
        typeof value.refreshExpiresAt === 'string' &&
        Number.isFinite(Date.parse(value.refreshExpiresAt)) &&
        Date.parse(value.refreshExpiresAt) > Date.parse(value.expiresAt))) &&
    typeof value.deviceId === 'string' &&
    UUID.test(value.deviceId) &&
    isProfile(value.profile)
  );
}
