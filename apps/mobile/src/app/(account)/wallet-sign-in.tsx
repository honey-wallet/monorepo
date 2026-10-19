import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { PushedScreen } from '@/components/wallet/parts';
import {
  approveBackendSignIn,
  approveWalletLink,
  backendSession,
  clearBackendSession,
  clearWalletLinkReview,
  forgetSavedBackendSession,
  prepareBackendSignIn,
  prepareWalletLink,
  refreshLinkedWallets,
  resumeBackendSession,
  walletLinks,
} from '@/lib/backend-session';
import { loadAccounts, type VaultAccount } from '@/lib/vault';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

const EXTENSION_TARGET = process.env.EXPO_PUBLIC_TARGET === 'extension';

export default function WalletSignInScreen() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const state = backendSession.useValue();
  const linkState = walletLinks.useValue();
  const [localAccounts, setLocalAccounts] = useState<VaultAccount[]>([]);
  useEffect(
    () => () => {
      if (backendSession.get().review) clearBackendSession();
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    if (!state.profile?.userId) {
      setLocalAccounts([]);
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([loadAccounts(), refreshLinkedWallets()])
      .then(([accounts]) => {
        if (!cancelled) setLocalAccounts(accounts);
      })
      .catch(() => {
        if (!cancelled) setLocalAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.profile?.userId]);
  const eligible = !wallet.demo && !wallet.watchOnly && wallet.kind === 'wallet';
  return (
    <PushedScreen title="Wallet sign-in">
      <View style={styles.content}>
        <Text style={styles.body}>
          Sign in with this wallet to access your Honey account. This signature does not approve a
          transaction or a token allowance.
        </Text>
        {EXTENSION_TARGET ? (
          <Text style={styles.body}>
            The backend must allow this exact Chrome extension origin in AUTH_ADDITIONAL_ORIGINS and
            CORS_ALLOWED_ORIGINS. Extension sessions are access-only, expire after 15 minutes, and
            require a new sign-in after expiry or when the popup is backgrounded. Your browser
            password confirms the sign-in.
          </Text>
        ) : null}
        <Text selectable style={styles.body}>
          {wallet.address}
        </Text>
        {state.profile ? (
          <>
            <Text style={styles.body}>Signed in · {state.profile.wallet.chainId}</Text>
            <Text style={styles.body}>
              {EXTENSION_TARGET
                ? 'This extension session is access-only and expires after 15 minutes. Backgrounding or locking ends access; sign in again to resume.'
                : 'Honey refreshes access while open. Backgrounding or locking hides the access token; resume requires local owner confirmation.'}
            </Text>
            <Text style={styles.body}>Wallets linked to this Honey account</Text>
            {linkState.wallets.map((linked) => (
              <Text key={linked.id} selectable style={styles.body}>
                {linked.chainId} · {linked.address}
              </Text>
            ))}
            {linkState.review ? (
              <>
                <Text style={styles.body}>Review wallet-link message</Text>
                <Text selectable style={styles.message}>
                  {linkState.review.challenge.message}
                </Text>
                <PillButton
                  label={linkState.busy ? 'Linking…' : 'Approve wallet link'}
                  disabled={linkState.busy}
                  onPress={() => void approveWalletLink()}
                />
                <PillButton
                  label="Cancel"
                  variant="secondary"
                  disabled={linkState.busy}
                  onPress={clearWalletLinkReview}
                />
              </>
            ) : (
              localAccounts
                .filter(
                  (account) =>
                    !linkState.wallets.some(
                      (linked) =>
                        linked.address.toLowerCase() === account.addresses.evm.toLowerCase(),
                    ),
                )
                .filter(
                  (account) =>
                    account.addresses.evm.toLowerCase() !==
                    state.profile?.wallet.address.toLowerCase(),
                )
                .map((account) => (
                  <PillButton
                    key={account.id}
                    label={linkState.busy ? 'Preparing link…' : `Link ${account.label}`}
                    disabled={linkState.busy}
                    onPress={() => void prepareWalletLink(account)}
                  />
                ))
            )}
            {linkState.error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {linkState.error}
              </Text>
            ) : null}
            <PillButton
              label="Sign out of Honey account"
              onPress={() => void forgetSavedBackendSession()}
            />
          </>
        ) : state.review ? (
          <>
            <Text style={styles.body}>Review your sign-in message</Text>
            <Text selectable style={styles.message}>
              {state.review.challenge.message}
            </Text>
            <PillButton
              label={state.busy ? 'Signing in…' : 'Sign in'}
              disabled={state.busy}
              onPress={() => void approveBackendSignIn()}
            />
            <PillButton label="Cancel" variant="secondary" onPress={() => clearBackendSession()} />
          </>
        ) : (
          <>
            {state.resumeAvailable ? (
              <>
                <PillButton
                  label={state.busy ? 'Resuming…' : 'Resume Honey session'}
                  disabled={state.busy || !eligible}
                  onPress={() => void resumeBackendSession()}
                />
                <PillButton
                  label="Forget saved Honey session"
                  variant="secondary"
                  disabled={state.busy}
                  onPress={() => void forgetSavedBackendSession()}
                />
              </>
            ) : null}
            <PillButton
              label={state.busy ? 'Preparing…' : 'Review sign-in'}
              disabled={state.busy || !eligible}
              onPress={() => void prepareBackendSignIn()}
            />
          </>
        )}
        {!eligible ? (
          <Text style={styles.body}>Choose a wallet with keys on this device.</Text>
        ) : null}
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
      </View>
    </PushedScreen>
  );
}
const useStyles = makeStyles((c) => ({
  content: { padding: 20, gap: 20 },
  body: { color: c.textSecondary, fontSize: 15, lineHeight: 22 },
  message: {
    color: c.text,
    fontSize: 13,
    lineHeight: 20,
    backgroundColor: c.card,
    borderRadius: 20,
    padding: 16,
  },
  error: { color: c.error, fontSize: 15 },
}));
