import type { PairOffer, PairPayload, PairSession } from '@honey-wallet/keyring';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { PillButton } from '@/components/onboarding/PillButton';
import { ArrivedWallets } from '@/components/pairing/ArrivedWallets';
import { CodeEntry } from '@/components/pairing/CodeEntry';
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
  | { step: 'review'; payload: PairPayload }
  | { step: 'error'; message: string };

/** Dark dots on white whatever the theme, so every phone camera reads it. */
const QR_SIZE = 200;

/**
 * Honey in a browser, paired with Honey on a phone: this screen shows a one-time QR code,
 * the phone scans it, and both work out the same six-digit code. The device the wallet
 * leaves asks you to type the code the other one shows; only then does the wallet move,
 * encrypted for the other side alone (lib/pair-phone.ts). By default the
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new code restarts the wait
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: 'scan' });
    waitForPhone(offer, controller.signal)
      .then((session) => {
        tap();
        // The device the wallet leaves checks the code: here when sending, so type it;
        // when receiving, show it and wait for the phone.
        if (toPhone) setState({ step: 'compare', session });
        else void confirm(session, controller);
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

  const confirm = async (session: PairSession, controller: AbortController) => {
    setState({ step: 'receiving', session });
    try {
      const payload = await receiveWallet(offer, session, controller.signal);
      // Nothing is added until you've checked these are yours (ArrivedWallets).
      tap();
      setState({ step: 'review', payload });
    } catch (error) {
      if (controller.signal.aborted) return;
      failure();
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  const add = async (payload: PairPayload) => {
    tap();
    try {
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
      failure();
      setState({ step: 'error', message: messageOf(error) });
    }
  };

  if (state.step === 'review') {
    return (
      <SheetScreen
        title="Add these wallets?"
        footer={
          <View style={styles.buttons}>
            <PillButton
              label="Not mine"
              variant="secondary"
              onPress={() => {
                tap();
                showToast('Nothing was added');
                router.back();
              }}
              style={styles.flex}
            />
            <PillButton label="Add" onPress={() => add(state.payload)} style={styles.flex} />
          </View>
        }
      >
        <Text style={styles.body}>
          From the phone that took your code. Only add them if your phone just said it sent them.
        </Text>
        <ArrivedWallets payload={state.payload} />
      </SheetScreen>
    );
  }

  if (state.step === 'compare') {
    return (
      <SheetScreen
        title="Enter the code"
        footer={
          <PillButton
            label="Cancel"
            variant="secondary"
            onPress={() => {
              showToast('Pairing cancelled');
              restart();
            }}
          />
        }
      >
        <Text style={styles.body}>
          Type the 6 digits your phone shows, so your wallet only goes to your phone.
        </Text>
        <CodeEntry
          code={state.session.code}
          onMatch={() => give(state.session)}
          onGiveUp={() => {
            abort.current?.abort();
            setState({
              step: 'error',
              message:
                'The codes didn’t match, so nothing was sent. Someone may be in between. Show a new code to try again.',
            });
          }}
        />
      </SheetScreen>
    );
  }

  if (state.step === 'sending') {
    return (
      <SheetScreen title="Sending to your phone">
        <Text style={styles.body}>Encrypted for your phone only…</Text>
        <ActivityIndicator style={styles.spinner} color={c.textSecondary} />
      </SheetScreen>
    );
  }

  // Receiving: what to do first (the title), the code, then what happens next.
  if (state.step === 'receiving') {
    return (
      <SheetScreen title="Enter this code on your phone">
        <Text
          style={[styles.code, styles.codeUnderTitle]}
          accessibilityLabel={`Code ${state.session.code.split('').join(' ')}`}
        >
          {`${state.session.code.slice(0, 3)} ${state.session.code.slice(3)}`}
        </Text>
        <Text style={[styles.body, styles.centered, styles.underCode]}>
          Your phone is asking for these 6 digits. Once you type them there, your wallet comes here.
        </Text>
        <ActivityIndicator style={styles.spinner} color={c.textSecondary} />
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
  centered: {
    textAlign: 'center',
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
  // Right under the title (it says what to do with it), the line after it close by.
  codeUnderTitle: {
    marginTop: 8,
  },
  underCode: {
    marginTop: 12,
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
