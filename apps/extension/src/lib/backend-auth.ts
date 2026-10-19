import {
  type AuthenticatedSession,
  type SignInChallenge,
  validateSignInChallenge,
  type WalletProfile,
} from '@honey-wallet/api-client';
import {
  evmAddressOfKey,
  privateKeyFor,
  signEvmMessage,
  withMnemonicSeed,
} from '@honey-wallet/keyring';
import { api } from './api';
import type { AccountView } from './vault';

export type BackendSignInReview = {
  accountIndex: number;
  address: string;
  origin: string;
  chainId: string;
  challenge: SignInChallenge;
};

// Access tokens remain in this popup's module memory only. Refresh credentials are
// deliberately discarded; closing the popup ends local use, while the server session
// remains revocable until its short access-token expiry.
let accessToken: string | null = null;
let generation = 0;

export async function prepareBackendSignIn(
  account: AccountView,
  origin: string,
): Promise<BackendSignInReview> {
  const requestGeneration = generation;
  const configuration = await api.authConfiguration();
  if (requestGeneration !== generation) throw new Error('Sign-in was cancelled.');
  if (
    !configuration.enabled ||
    configuration.method !== 'siwe_eoa' ||
    !configuration.origin ||
    !configuration.chainId ||
    configuration.origin !== origin
  )
    throw new Error('Backend sign-in is not configured for this extension.');
  const challenge = await api.createSignInChallenge(account.addresses.evm, configuration.chainId);
  if (requestGeneration !== generation) throw new Error('Sign-in was cancelled.');
  const review = {
    accountIndex: account.index,
    address: account.addresses.evm,
    origin,
    chainId: configuration.chainId,
    challenge,
  };
  validateSignInChallenge(challenge, review);
  return review;
}

export async function approveBackendSignIn(
  mnemonic: string,
  review: BackendSignInReview,
): Promise<string> {
  const requestGeneration = generation;
  validateSignInChallenge(review.challenge, review);
  const signature = await withMnemonicSeed(mnemonic, async (seed) => {
    const key = privateKeyFor(seed, 'evm', review.accountIndex);
    try {
      if (evmAddressOfKey(key).toLowerCase() !== review.address.toLowerCase())
        throw new Error('Wallet account changed. Prepare sign-in again.');
      return await signEvmMessage(key, review.challenge.message);
    } finally {
      key.fill(0);
    }
  });
  if (requestGeneration !== generation) throw new Error('Sign-in was cancelled.');
  const session: AuthenticatedSession = await api.verifySignIn(review.challenge.id, signature);
  if (requestGeneration !== generation) {
    const revoked = await api.signOut(session.accessToken).then(
      () => true,
      () => false,
    );
    if (!revoked)
      throw new Error(
        'Sign-in was cancelled, but server revocation failed. The session expires within 15 minutes.',
      );
    throw new Error('Sign-in was cancelled.');
  }
  if (
    session.profile.wallet.address.toLowerCase() !== review.address.toLowerCase() ||
    session.profile.wallet.chainId !== review.chainId
  ) {
    await api.signOut(session.accessToken).catch(() => undefined);
    throw new Error('Backend returned a different wallet identity.');
  }
  let profile: WalletProfile;
  try {
    profile = await api.profile(session.accessToken);
  } catch (error) {
    await api.signOut(session.accessToken).catch(() => undefined);
    throw error;
  }
  if (requestGeneration !== generation) {
    await api.signOut(session.accessToken).catch(() => undefined);
    throw new Error('Sign-in was cancelled.');
  }
  if (
    profile.wallet.address.toLowerCase() !== review.address.toLowerCase() ||
    profile.wallet.chainId !== review.chainId
  ) {
    await api.signOut(session.accessToken).catch(() => undefined);
    throw new Error('Authenticated profile does not match the signed wallet.');
  }
  accessToken = session.accessToken;
  return session.profile.wallet.address;
}

export function backendAccessToken() {
  return accessToken;
}

export async function clearBackendSignIn() {
  generation += 1;
  const token = accessToken;
  accessToken = null;
  if (!token) return true;
  try {
    await api.signOut(token);
    return true;
  } catch {
    return false;
  }
}
