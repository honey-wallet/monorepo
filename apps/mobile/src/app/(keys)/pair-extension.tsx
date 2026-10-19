import type { PairChannel } from '@honey-wallet/api-client';
import {
  clearPairSession,
  type PairPayload,
  type PairSession,
  sealPayload,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { ArrivedWallets } from '@/components/pairing/ArrivedWallets';
import { CodeEntry } from '@/components/pairing/CodeEntry';
import { SheetScreen } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { completeStep, finishOnboarding } from '@/lib/onboarding';
import {
  offerDirection,
  phoneHandshake,
  receiveFromBrowser,
  takeScannedOffer,
} from '@/lib/pair-offer';
import { showToast } from '@/lib/toast';
import { importPairedWallet, readPrimaryWallet } from '@/lib/vault';
import { addVaultWallet, setActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type State =
  | { step: 'missing' }
  | { step: 'intro'; uri: string }
  | { step: 'connecting' }
  | { step: 'compare'; session: PairSession; pair: PairChannel }
  | { step: 'confirm'; session: PairSession; pair: PairChannel; payload: PairPayload }
  | { step: 'sending' }
  | { step: 'receiving'; code: string }
  | { step: 'review'; payload: PairPayload }
  | { step: 'done' }
  | { step: 'error'; message: string };

/**
 * Pairing Honey for Chrome. The code says which way the wallet goes: this phone's wallet
 * to the browser (the usual), or the browser's wallet to this phone (Settings › Send
 * wallet to phone, in the browser; the browser asks for its password before sending).
 *
 * Reached only from the in-app scanner (the code is handed
 * over in memory; see lib/pair-offer.ts). Nothing goes to the server until the user has
 * read what pairing means and tapped Continue. Then the handshake runs and both sides
 * work out the same six-digit code: the receiving device shows it, and the sending one
 * asks you to type it. Only the right code (and Face ID, or the browser's password) lets
 * the wallet go across, encrypted for that device alone.
 */
export default function PairExtensionSheet() {
  const styles = useStyles();
  const c = useTheme();
  // From onboarding: the wallet that comes across is this phone's wallet; open it.
  const { onboarding } = useLocalSearchParams<{ onboarding?: string }>();
  const [state, setState] = useState<State>(() => {
    const uri = takeScannedOffer();
    return uri ? { step: 'intro', uri } : { step: 'missing' };
  });
  // Fixed for this screen: the code it was opened with.
  const [toPhone] = useState(
    () => state.step === 'intro' && offerDirection(state.uri) === 'toPhone',
  );
  const abort = useRef(new AbortController());
  const sessions = useRef(new Set<PairSession>());
  useEffect(
    () => () => {
      abort.current.abort();
      for (const session of sessions.current) clearPairSession(session);
      sessions.current.clear();
    },
    [],
  );

  const start = async (uri: string) => {
    tap();
    setState({ step: 'connecting' });
    let session: PairSession | undefined;
    try {
      if (!toPhone && !(await readPrimaryWallet())) {
        throw new Error('Create or import a wallet first.');
      }
      const result = await phoneHandshake(uri, abort.current.signal);
      session = result.session;
      if (abort.current.signal.aborted) {
        clearPairSession(session);
        return;
      }
      sessions.current.add(session);
      // The device the wallet leaves checks the code: the browser here, so show it.
      if (toPhone) await receive(session, result.pair);
      else setState({ step: 'compare', session, pair: result.pair });
    } catch (error) {
      if (session) {
        clearPairSession(session);
        sessions.current.delete(session);
      }
      if (!abort.current.signal.aborted) setState({ step: 'error', message: messageOf(error) });
    }
  };

  /** Browser to phone: wait for the browser to send (after its password), then add it. */
  const receive = async (session: PairSession, pair: PairChannel) => {
    setState({ step: 'receiving', code: session.code });
    try {
      const payload = await receiveFromBrowser(pair, session, abort.current.signal);
      // Nothing is added until you've checked it's yours (ArrivedWallets).
      tap();
      setState({ step: 'review', payload });
    } catch (error) {
      if (!abort.current.signal.aborted) setState({ step: 'error', message: messageOf(error) });
    } finally {
      clearPairSession(session);
      sessions.current.delete(session);
    }
  };

  const add = async (payload: PairPayload) => {
    tap();
    try {
      const added = await importPairedWallet(payload);
      for (const account of added) addVaultWallet(account);
      if (added[0]) setActiveWallet(added[0].id);
      success();
      if (onboarding) {
        finishOnboarding('import');
        return;
      }
      setState({ step: 'done' });
    } catch (error) {
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  /** The code matched: say what leaves and that Face ID comes next, before the system asks. */
  const matched = async (session: PairSession, pair: PairChannel) => {
    try {
      const wallet = await readPrimaryWallet();
      if (!wallet) throw new Error('Create or import a wallet first.');
      success();
      setState({ step: 'confirm', session, pair, payload: { v: 1, ...wallet } });
    } catch (error) {
      clearPairSession(session);
      sessions.current.delete(session);
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  // Cancelling Face ID (or the passcode) leaves you on the confirm step to try again.
  const send = async (session: PairSession, pair: PairChannel, payload: PairPayload) => {
    tap();
    try {
      if (!(await confirmOwner('Send your wallet to this browser'))) {
        setState({ step: 'error', message: 'Pairing cancelled. Scan a new code to try again.' });
        return;
      }
      setState({ step: 'sending' });
      const data = sealPayload(session.key, payload, getRandomBytes);
      await api.pairSend(pair, 'payload', { data });
      completeStep('browser');
      success();
      setState({ step: 'done' });
    } catch (error) {
      setState({ step: 'error', message: messageOf(error) });
    } finally {
      clearPairSession(session);
      sessions.current.delete(session);
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
          title={toPhone ? 'Wallet added' : 'Paired'}
          detail={
            toPhone
              ? 'Your browser’s wallet is on this phone now, next to your others.'
              : 'Your wallet is in your browser now.'
          }
          onDone={close}
        />
      </SheetScreen>
    );
  }

  // Receiving: what to do (the title), the code right under it, then what happens next.
  // Sized to its content like the browser's, not a full sheet with an icon (review).
  if (state.step === 'receiving') {
    return (
      <SheetScreen
        title="Enter this code in the extension"
        footer={
          <PillButton
            label="Cancel"
            variant="secondary"
            onPress={() => {
              close();
              showToast('Pairing cancelled');
            }}
            style={styles.flex}
          />
        }
      >
        <Text
          style={[styles.code, styles.codeUnderTitle]}
          accessibilityLabel={`Code ${state.code.split('').join(' ')}`}
        >
          {`${state.code.slice(0, 3)} ${state.code.slice(3)}`}
        </Text>
        <Text style={styles.subtitle}>
          The extension is asking for these 6 digits. Once you type them there, the wallet comes to
          this phone.
        </Text>
        <ActivityIndicator style={styles.waiting} color={c.textSecondary} />
      </SheetScreen>
    );
  }

  // Honey's own step before the system's Face ID or passcode prompt, so it isn't a surprise.
  if (state.step === 'confirm') {
    return (
      <SheetScreen
        size="fill"
        footer={
          <View style={styles.buttons}>
            <PillButton
              label="Cancel"
              variant="secondary"
              onPress={() => {
                close();
                showToast('Nothing was sent');
              }}
              style={styles.flex}
            />
            <PillButton
              label="Send"
              onPress={() => send(state.session, state.pair, state.payload)}
              style={styles.flex}
            />
          </View>
        }
      >
        <View style={styles.hero}>
          <View style={styles.well}>
            <Icon name="faceId" size={24} color={c.accentText} />
          </View>
          <TextsReveal
            id="confirm"
            align="center"
            first={<Text style={styles.title}>Code matches</Text>}
            second={
              <Text style={styles.subtitle}>
                This wallet goes to your browser, encrypted for it alone. Next, confirm it’s you
                with Face ID or your passcode.
              </Text>
            }
          />
        </View>
        <ArrivedWallets payload={state.payload} />
      </SheetScreen>
    );
  }

  if (state.step === 'review') {
    return (
      <SheetScreen
        size="fill"
        footer={
          <View style={styles.buttons}>
            <PillButton
              label="Not mine"
              variant="secondary"
              onPress={() => {
                close();
                showToast('Nothing was added');
              }}
              style={styles.flex}
            />
            <PillButton label="Add" onPress={() => add(state.payload)} style={styles.flex} />
          </View>
        }
      >
        <View style={styles.hero}>
          <TextsReveal
            id="review"
            align="center"
            first={<Text style={styles.title}>Add this wallet?</Text>}
            second={
              <Text style={styles.subtitle}>
                From the browser that took your code. Only add it if the extension just said it sent
                it.
              </Text>
            }
          />
        </View>
        <ArrivedWallets payload={state.payload} />
      </SheetScreen>
    );
  }

  const copy: { icon: IconName; title: string; body: string } =
    state.step === 'missing'
      ? {
          icon: 'scan',
          title: 'Scan from Honey',
          body: 'To pair a browser, open Honey’s scanner and point it at the code in the browser extension.',
        }
      : state.step === 'error'
        ? { icon: 'warning', title: 'Couldn’t pair', body: state.message }
        : state.step === 'intro' && toPhone
          ? {
              icon: 'warning',
              title: 'Get a wallet from your browser?',
              body: 'The browser that showed this code sends its recovery phrase to this phone. Only add a wallet that’s yours.',
            }
          : state.step === 'intro'
            ? {
                icon: 'warning',
                title: 'Send your wallet to a browser?',
                body: 'Pairing copies your recovery phrase to the browser that showed this code. Whoever controls that browser can move your funds.',
              }
            : state.step === 'compare'
              ? {
                  icon: 'globe',
                  title: 'Enter the code',
                  body: 'Type the 6 digits the browser extension shows, so your wallet only goes to your browser.',
                }
              : {
                  icon: 'globe',
                  title: 'Pair the browser extension',
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
          <PillButton
            label="Cancel"
            variant="secondary"
            onPress={() => {
              close();
              showToast('Pairing cancelled');
            }}
            style={styles.flex}
          />
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
            toPhone
              ? 'Someone else’s wallet can look like yours. Only send money to one you made.'
              : 'Honey will never ask you to pair to fix a problem or claim a reward.',
          ].map((line) => (
            <View key={line} style={styles.rule}>
              <Icon name="check" size={16} color={c.textSecondary} />
              <Text style={styles.ruleText}>{line}</Text>
            </View>
          ))}
        </View>
      ) : state.step === 'compare' ? (
        <CodeEntry
          code={state.session.code}
          onMatch={() => matched(state.session, state.pair)}
          onGiveUp={() => {
            abort.current.abort();
            clearPairSession(state.session);
            sessions.current.delete(state.session);
            setState({
              step: 'error',
              message:
                'The codes didn’t match, so nothing was sent. Someone may be in between. Start again from the browser extension.',
            });
          }}
        />
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
  codeUnderTitle: {
    marginTop: 12,
    marginBottom: 6,
  },
  waiting: {
    marginTop: 20,
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
