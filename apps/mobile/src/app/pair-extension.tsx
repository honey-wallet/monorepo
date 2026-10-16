import type { PairChannel } from '@honey-wallet/api-client';
import { type PairSession, sealPayload } from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/wallet/Sheet';
import { SuccessPage } from '@/components/wallet/SuccessPage';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { phoneHandshake, takeScannedOffer } from '@/lib/pair-offer';
import { showToast } from '@/lib/toast';
import { readPrimaryWallet } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';

type State =
  | { step: 'missing' }
  | { step: 'intro'; uri: string }
  | { step: 'connecting' }
  | { step: 'compare'; session: PairSession; pair: PairChannel }
  | { step: 'sending' }
  | { step: 'done' }
  | { step: 'error'; message: string };

/**
 * Pairing Honey for Chrome, reached only from the in-app scanner (the code is handed
 * over in memory; see lib/pair-offer.ts). Nothing goes to the server until the user has
 * read what pairing means and tapped Continue. Then the handshake runs, both screens show
 * a six-digit code, and only after "Codes match" and Face ID does the wallet go across,
 * encrypted for that browser alone.
 */
export default function PairExtensionSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [state, setState] = useState<State>(() => {
    const uri = takeScannedOffer();
    return uri ? { step: 'intro', uri } : { step: 'missing' };
  });
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);

  const start = async (uri: string) => {
    tap();
    setState({ step: 'connecting' });
    try {
      if (!(await readPrimaryWallet())) throw new Error('Create or import a wallet first.');
      const { pair, session } = await phoneHandshake(uri, abort.current.signal);
      setState({ step: 'compare', session, pair });
    } catch (error) {
      if (!abort.current.signal.aborted) setState({ step: 'error', message: messageOf(error) });
    }
  };

  const send = async (session: PairSession, pair: PairChannel) => {
    tap();
    if (!(await confirmOwner('Send your wallet to this browser'))) return;
    setState({ step: 'sending' });
    try {
      const wallet = await readPrimaryWallet();
      if (!wallet) throw new Error('Create or import a wallet first.');
      const data = sealPayload(session.key, { v: 1, ...wallet }, getRandomBytes);
      await api.pairSend(pair, 'payload', { data });
      success();
      setState({ step: 'done' });
    } catch (error) {
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  const close = () => {
    tap();
    abort.current.abort();
    router.dismissAll();
  };

  if (state.step === 'done') {
    return (
      <SheetScreen size="fill">
        <SuccessPage
          title="Paired"
          detail="Your wallet is in your browser now. Set a password there to finish."
          onDone={close}
        />
      </SheetScreen>
    );
  }

  const copy: { icon: IconName; title: string; body: string } =
    state.step === 'missing'
      ? {
          icon: 'scan',
          title: 'Scan from Honey',
          body: 'To pair a browser, open Honey’s scanner and point it at the code in Honey for Chrome.',
        }
      : state.step === 'error'
        ? { icon: 'warning', title: 'Couldn’t pair', body: state.message }
        : state.step === 'intro'
          ? {
              icon: 'warning',
              title: 'Send your wallet to a browser?',
              body: 'Pairing copies your recovery phrase to the browser that showed this code. Whoever controls that browser can move your funds.',
            }
          : state.step === 'compare'
            ? {
                icon: 'globe',
                title: 'Check the code',
                body: 'It should match the code in your browser exactly. Confirm on both.',
              }
            : {
                icon: 'globe',
                title: 'Pair Honey for Chrome',
                body:
                  state.step === 'sending'
                    ? 'Sending your wallet, encrypted for that browser only…'
                    : 'Connecting to your browser…',
              };
  const danger = state.step === 'intro' || state.step === 'error';

  return (
    <SheetScreen
      size="fill"
      footer={
        state.step === 'intro' ? (
          <View style={styles.buttons}>
            <PillButton label="Cancel" variant="secondary" onPress={close} style={styles.flex} />
            <PillButton label="Continue" onPress={() => start(state.uri)} style={styles.flex} />
          </View>
        ) : state.step === 'compare' ? (
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
              onPress={() => send(state.session, state.pair)}
              style={styles.flex}
            />
          </View>
        ) : state.step === 'error' || state.step === 'missing' ? (
          <PillButton label="Close" variant="secondary" onPress={close} style={styles.flex} />
        ) : undefined
      }
    >
      <View style={styles.hero}>
        <View style={[styles.well, danger && { backgroundColor: `${c.error}22` }]}>
          <Icon name={copy.icon} size={24} color={danger ? c.error : c.accentText} />
        </View>
        <TextsReveal
          id={state.step}
          align="center"
          first={<Text style={styles.title}>{copy.title}</Text>}
          second={<Text style={styles.subtitle}>{copy.body}</Text>}
        />
      </View>

      {state.step === 'intro' ? (
        <View style={styles.card}>
          {[
            'Only pair a browser on your own computer, open in front of you.',
            'Never scan a pairing code that a website, message or another person sent you.',
            'Honey will never ask you to pair to fix a problem or claim a reward.',
          ].map((line) => (
            <View key={line} style={styles.rule}>
              <Icon name="check" size={16} color={c.textSecondary} />
              <Text style={styles.ruleText}>{line}</Text>
            </View>
          ))}
        </View>
      ) : state.step === 'compare' ? (
        <>
          <Text
            style={styles.code}
            accessibilityLabel={`Code ${state.session.code.split('').join(' ')}`}
          >
            {`${state.session.code.slice(0, 3)} ${state.session.code.slice(3)}`}
          </Text>
          <View style={styles.note}>
            <Icon name="warning" size={16} color={c.textSecondary} />
            <Text style={styles.noteText}>
              Different codes mean someone may be in between. Tap “They don’t match”.
            </Text>
          </View>
        </>
      ) : state.step === 'connecting' || state.step === 'sending' ? (
        <ActivityIndicator style={styles.spinner} color={c.textSecondary} />
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
  card: {
    marginTop: 28,
    gap: 14,
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  rule: {
    flexDirection: 'row',
    gap: 10,
  },
  ruleText: {
    flex: 1,
    color: c.text,
    fontSize: 15,
    lineHeight: 21,
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
