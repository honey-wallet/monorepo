import {
  createPairAnswer,
  encodeKey,
  type PairSession,
  pairSession,
  parsePairUri,
  sealPayload,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/wallet/Sheet';
import { SuccessPage } from '@/components/wallet/SuccessPage';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { readPrimaryWallet } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';

type State =
  | { step: 'connecting' }
  | { step: 'compare'; session: PairSession; channel: string }
  | { step: 'sending' }
  | { step: 'done' }
  | { step: 'error'; message: string };

/**
 * Opened by scanning the extension's pairing code. Says hello through the server's
 * mailbox, shows the six-digit code to compare with the browser, and only after the
 * user confirms (and passes Face ID) sends the wallet, encrypted for that browser alone.
 */
export default function PairExtensionSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { uri = '' } = useLocalSearchParams<{ uri?: string }>();
  const [state, setState] = useState<State>({ step: 'connecting' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const offer = parsePairUri(uri);
      if (!offer) throw new Error('That isn’t a Honey pairing code');
      if (!(await readPrimaryWallet())) throw new Error('Create or import a wallet first');
      const answer = createPairAnswer(getRandomBytes);
      await api.pairSend(offer.channel, 'hello', { data: encodeKey(answer.publicKey) });
      const session = pairSession(
        answer.secretKey,
        offer.publicKey,
        offer.channel,
        offer.publicKey,
        answer.publicKey,
      );
      if (!cancelled) setState({ step: 'compare', session, channel: offer.channel });
    })().catch((error: unknown) => {
      if (!cancelled) setState({ step: 'error', message: messageOf(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const send = async (session: PairSession, channel: string) => {
    tap();
    if (!(await confirmOwner('Pair Honey for Chrome'))) return;
    setState({ step: 'sending' });
    try {
      const wallet = await readPrimaryWallet();
      if (!wallet) throw new Error('Create or import a wallet first');
      const data = sealPayload(session.key, { v: 1, ...wallet }, getRandomBytes);
      await api.pairSend(channel, 'payload', { data });
      success();
      setState({ step: 'done' });
    } catch (error) {
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  const close = () => {
    tap();
    router.dismissAll();
  };

  if (state.step === 'done') {
    return (
      <SheetScreen size="fill">
        <SuccessPage
          title="Paired"
          detail="Your wallet is on your computer now. Set a password there to finish."
          onDone={close}
        />
      </SheetScreen>
    );
  }

  const comparing = state.step === 'compare';
  return (
    <SheetScreen
      size="fill"
      footer={
        comparing ? (
          <View style={styles.buttons}>
            <PillButton
              label="They don’t match"
              variant="secondary"
              onPress={() => {
                close();
                showToast('Pairing cancelled');
              }}
              style={styles.flex}
            />
            <PillButton
              label="Codes match"
              onPress={() => send(state.session, state.channel)}
              style={styles.flex}
            />
          </View>
        ) : state.step === 'error' ? (
          <PillButton label="Close" variant="secondary" onPress={close} style={styles.flex} />
        ) : undefined
      }
    >
      <View style={styles.hero}>
        <View style={styles.well}>
          <Icon
            name={state.step === 'error' ? 'warning' : 'globe'}
            size={24}
            color={state.step === 'error' ? c.error : c.accentText}
          />
        </View>
        <TextsReveal
          id={state.step}
          align="center"
          first={
            <Text style={styles.title}>
              {state.step === 'error' ? 'Couldn’t pair' : 'Pair Honey for Chrome'}
            </Text>
          }
          second={
            <Text style={styles.subtitle}>
              {state.step === 'error'
                ? state.message
                : comparing
                  ? 'Check this code matches the one in your browser, then confirm on both.'
                  : state.step === 'sending'
                    ? 'Sending your wallet, encrypted for that browser only…'
                    : 'Connecting to your browser…'}
            </Text>
          }
        />
      </View>

      {comparing ? (
        <Text
          style={styles.code}
          accessibilityLabel={`Code ${state.session.code.split('').join(' ')}`}
        >
          {`${state.session.code.slice(0, 3)} ${state.session.code.slice(3)}`}
        </Text>
      ) : state.step === 'error' ? null : (
        <ActivityIndicator style={styles.spinner} color={c.textSecondary} />
      )}

      {comparing ? (
        <View style={styles.note}>
          <Icon name="warning" size={16} color={c.textSecondary} />
          <Text style={styles.noteText}>
            Different codes mean someone may be in between. Tap “They don’t match”.
          </Text>
        </View>
      ) : null}
    </SheetScreen>
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  buttons: {
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  hero: {
    marginTop: 24,
    alignItems: 'center',
  },
  well: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    paddingHorizontal: 16,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  code: {
    marginTop: 40,
    color: c.text,
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  spinner: {
    marginTop: 48,
  },
  note: {
    marginTop: 32,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  noteText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
}));
