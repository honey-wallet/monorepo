import type { PairOffer, PairSession } from '@honey-wallet/keyring';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { QRCode } from '@/components/wallet/QRCode';
import { confirmOwner } from '@/lib/auth';
import { failure, success, tap } from '@/lib/haptics';
import { completeStep, finishOnboarding } from '@/lib/onboarding';
import { receiveWallet, sendWallet, startPairing, waitForPhone } from '@/lib/pair-phone';
import { isWeb } from '@/lib/platform';
import { showToast } from '@/lib/toast';
import { hasPrimaryMnemonic, importPairedWallet } from '@/lib/vault';
import { addVaultWallet, setActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type State =
  | { step: 'scan' }
  | { step: 'compare'; session: PairSession }
  | { step: 'receiving'; session: PairSession }
  | { step: 'sending'; session: PairSession }
  | { step: 'error'; message: string };

/** Dark dots on white whatever the theme, so every phone camera reads it. */
const QR_SIZE = 200;

/**
 * Honey in a browser, paired with Honey on a phone: this screen shows a one-time QR code,
 * the phone scans it, both show a six-digit code, and after "Codes match" on both the
 * wallet moves, encrypted for the other side alone (lib/pair-phone.ts). By default the
 * phone sends its wallet here; with `send=1` this browser sends its wallet to the phone,
 * after the password.
 */
export default function PairPhoneSheet() {
  // The phone is the side that scans (pair-extension.tsx).
  return isWeb ? <PairPhone /> : <Redirect href="/home" />;
}

function PairPhone() {
  const { onboarding, send } = useLocalSearchParams<{ onboarding?: string; send?: string }>();
  const toPhone = send === '1';
  const direction = toPhone ? 'toPhone' : 'toBrowser';
  const styles = useStyles();
  const c = useTheme();
  const [offer, setOffer] = useState<PairOffer>(() => startPairing(direction));
  const [state, setState] = useState<State>({ step: 'scan' });
  const abort = useRef<AbortController | null>(null);
  const [noPhrase, setNoPhrase] = useState(false);

  // Only a recovery phrase can move to the phone (Apple, Google and email wallets have none here).
  useEffect(() => {
    if (!toPhone) return;
    void hasPrimaryMnemonic().then((has) => {
      if (!has) {
        setNoPhrase(true);
        abort.current?.abort();
        setState({
          step: 'error',
          message: 'There’s no recovery phrase in this browser to send.',
        });
      }
    });
  }, [toPhone]);

  // Wait for the phone to scan this code; a new code starts the wait again.
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: 'scan' });
    waitForPhone(offer, controller.signal)
      .then((session) => {
        tap();
        setState({ step: 'compare', session });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ step: 'error', message: messageOf(error) });
      });
    return () => controller.abort();
  }, [offer]);

  const restart = () => {
    tap();
    setOffer(startPairing(direction));
  };

  /** Browser to phone: the password, then the wallet goes, encrypted for that phone. */
  const give = async (session: PairSession) => {
    tap();
    if (!(await confirmOwner('Send your wallet to your phone'))) return;
    setState({ step: 'sending', session });
    try {
      await sendWallet(offer, session);
      completeStep('phone');
      success();
      showToast('Sent to your phone');
      // Back to wherever it was opened from (Settings), not the start of the stack.
      router.back();
    } catch (error) {
      failure();
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  const confirm = async (session: PairSession) => {
    if (toPhone) return give(session);
    tap();
    const controller = abort.current;
    if (!controller) return;
    setState({ step: 'receiving', session });
    try {
      const payload = await receiveWallet(offer, session, controller.signal);
      const added = await importPairedWallet(payload);
      for (const account of added) addVaultWallet(account);
      // Open on the phone's first wallet, not whichever came across last.
      if (added[0]) setActiveWallet(added[0].id);
      success();
      if (onboarding) {
        finishOnboarding('import');
        return;
      }
      showToast(added.length ? 'Paired with your phone' : 'Already paired');
      router.dismissAll();
    } catch (error) {
      if (controller.signal.aborted) return;
      failure();
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  if (state.step === 'compare' || state.step === 'receiving' || state.step === 'sending') {
    const receiving = state.step !== 'compare';
    return (
      <SheetScreen
        title="Check the code"
        footer={
          receiving ? undefined : (
            <View style={styles.buttons}>
              <PillButton
                label="No match"
                variant="secondary"
                onPress={() => {
                  showToast('Pairing cancelled');
                  restart();
                }}
                style={styles.flex}
              />
              <PillButton
                label="Match"
                onPress={() => confirm(state.session)}
                style={styles.flex}
              />
            </View>
          )
        }
      >
        <TextsReveal
          id={state.step}
          first={
            <Text style={styles.body}>
              {state.step === 'sending'
                ? 'Sending, encrypted for your phone only…'
                : receiving
                  ? 'Now tap “Codes match” on your phone too.'
                  : 'Your phone shows a code too. They should be the same.'}
            </Text>
          }
        />
        <Text
          style={styles.code}
          accessibilityLabel={`Code ${state.session.code.split('').join(' ')}`}
        >
          {`${state.session.code.slice(0, 3)} ${state.session.code.slice(3)}`}
        </Text>
        {receiving ? (
          <ActivityIndicator style={styles.spinner} color={c.textSecondary} />
        ) : (
          <View style={styles.note}>
            <Icon name="warning" size={16} color={c.textSecondary} />
            <Text style={styles.noteText}>Different codes? Someone may be in between.</Text>
          </View>
        )}
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      title={toPhone ? 'Send to your phone' : 'Pair your phone'}
      footer={
        noPhrase ? (
          <PillButton label="Close" variant="secondary" onPress={() => router.back()} />
        ) : state.step === 'error' ? (
          <PillButton label="Show a new code" onPress={restart} />
        ) : undefined
      }
    >
      <Text style={styles.body}>In Honey on your phone, tap Scan and point it here.</Text>
      <View style={[styles.qr, state.step === 'error' && styles.expired]}>
        <QRCode
          value={offer.uri}
          size={QR_SIZE}
          color="#111111"
          center={<HoneyLogo variant="mark" height={28} />}
        />
      </View>
      {state.step === 'error' ? (
        <Text style={styles.error}>{state.message}</Text>
      ) : (
        <View style={styles.note}>
          <Icon name="lock" size={16} color={c.textSecondary} />
          <Text style={styles.noteText}>
            {toPhone
              ? 'Only your phone can read what this browser sends.'
              : 'Only this browser can read what your phone sends.'}
          </Text>
        </View>
      )}
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
    gap: 10,
  },
  body: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  qr: {
    marginTop: 20,
    alignSelf: 'center',
    padding: 16,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
  },
  expired: {
    opacity: 0.25,
  },
  code: {
    marginTop: 28,
    color: c.text,
    fontSize: 44,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  spinner: {
    marginTop: 28,
  },
  note: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  noteText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  error: {
    marginTop: 16,
    color: c.error,
    fontSize: 14,
    textAlign: 'center',
  },
}));
