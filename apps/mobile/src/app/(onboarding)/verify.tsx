import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen } from '@/components/onboarding/StepScreen';
import { failure, tap } from '@/lib/haptics';
import { IDENTITY_ENABLED } from '@/lib/identity';
import { type EmailFlow, useEmailCode } from '@/lib/identity-flows';
import { continueAfterSignIn } from '@/lib/identity-onboarding';
import { makeStyles, radius } from '@/theme';
import { DURATION } from '@/theme/motion';

const LENGTH = 6;
const RESEND_SECONDS = 30;
/** Wrong codes allowed before a new one has to be sent. */
const TRIES = 3;

/** Email sign-in, step two: the code Clerk emailed, checked by Clerk. */
export default function VerifyScreen() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  // Only reachable after the email step sent a code (and only with Clerk configured).
  if (!IDENTITY_ENABLED || (flow !== 'sign-in' && flow !== 'sign-up'))
    return <Redirect href="/welcome" />;
  return <VerifyCode flow={flow} />;
}

function VerifyCode({ flow }: { flow: EmailFlow }) {
  const { to, intent } = useLocalSearchParams<{ to?: string; intent?: string }>();
  const restore = intent === 'restore';
  const emailCode = useEmailCode();
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const [checking, setChecking] = useState(false);
  const input = useRef<TextInput>(null);
  const styles = useStyles();

  useEffect(() => {
    if (secondsLeft === 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const complete = code.length === LENGTH;
  const [wrong, setWrong] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { shake, style: shaken } = useErrorShake();
  const locked = wrong >= TRIES;

  // A wrong code shakes the boxes, turns them red and clears them; three in a row (or a
  // code Clerk won't take any more) need a new code.
  const reject = (tries: number, message: string) => {
    failure();
    shake();
    setWrong(tries);
    setError(message);
    setTimeout(() => setCode(''), 350);
  };

  const submit = async () => {
    if (!complete || locked || checking) return;
    tap();
    setChecking(true);
    try {
      const outcome = await emailCode.verify(flow, code);
      if (!outcome.ok) {
        setChecking(false);
        if (outcome.reason === 'wrong') {
          const tries = wrong + 1;
          reject(
            tries,
            tries >= TRIES
              ? 'Too many tries. Get a new code to keep going.'
              : `That code isn’t right. ${TRIES - tries} ${TRIES - tries === 1 ? 'try' : 'tries'} left.`,
          );
        } else if (outcome.reason === 'expired') {
          reject(TRIES, outcome.message);
        } else {
          failure();
          shake();
          setError(outcome.message);
        }
        return;
      }
      // Signed in. Straight into the wallet: password, name and photo are out of the flow
      // for now (the name comes from the email, the photo from Finish setting up).
      // router.push('/password')
      const next = await continueAfterSignIn('email', {
        restore,
        identity: { email: to, ...outcome.identity },
      });
      // Restoring: the account holds no keys, so back to the ways to bring them back.
      if (next === 'needs-keys') {
        router.dismissAll();
        router.push({ pathname: '/get-started', params: { mode: 'restore' } });
      }
    } catch (cause) {
      console.warn('Email sign-in failed', cause);
      setChecking(false);
      failure();
      setError('Couldn’t check the code. Check your connection and try again.');
    }
  };
  const resend = async () => {
    setSecondsLeft(RESEND_SECONDS);
    setWrong(0);
    setError(null);
    setCode('');
    input.current?.focus();
    try {
      const sent = await emailCode.resend(flow);
      if (!sent.ok) setError(sent.message);
    } catch (cause) {
      console.warn('Couldn’t resend the email code', cause);
      setError('Couldn’t send a new code. Check your connection and try again.');
    }
  };

  return (
    <StepScreen
      help="code"
      title="Enter your code"
      footer={
        <PillButton
          label={checking ? 'Checking…' : 'Continue'}
          disabled={!complete || locked || checking}
          onPress={submit}
        />
      }
    >
      <Animated.View style={shaken}>
        <Pressable style={styles.boxes} onPress={() => input.current?.focus()}>
          {Array.from({ length: LENGTH }, (_, i) => {
            const digit = code[i];
            const active = i === Math.min(code.length, LENGTH - 1);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length code slots
              <Fragment key={i}>
                {i === LENGTH / 2 && <View style={styles.dash} />}
                <View style={[styles.box, active && styles.boxActive, error && styles.boxError]}>
                  {digit ? (
                    <Text style={styles.digit}>{digit}</Text>
                  ) : (
                    <Text style={[styles.digit, styles.digitPlaceholder]}>0</Text>
                  )}
                </View>
              </Fragment>
            );
          })}
        </Pressable>
      </Animated.View>
      {error ? (
        <Animated.Text entering={FadeIn.duration(DURATION.fast)} style={styles.error}>
          {error}
        </Animated.Text>
      ) : null}

      <TextInput
        ref={input}
        autoFocus
        value={code}
        editable={!locked && !checking}
        onChangeText={(text) => {
          setCode(text.replace(/\D/g, '').slice(0, LENGTH));
          if (!locked) setError(null);
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={LENGTH}
        caretHidden
        style={styles.hiddenInput}
      />

      <Text style={styles.resend}>
        Didn’t receive a code?{' '}
        {secondsLeft > 0 && !locked ? (
          `Resend in ${secondsLeft}s`
        ) : (
          <Text style={styles.resendLink} onPress={resend}>
            Resend
          </Text>
        )}
      </Text>
      <Text style={styles.note}>
        {to ? `We sent a 6-digit code to ${to}.` : 'We sent you a 6-digit code.'}
      </Text>
    </StepScreen>
  );
}

const useStyles = makeStyles((c) => ({
  boxes: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  boxError: {
    borderColor: c.error,
  },
  error: {
    marginTop: 12,
    color: c.error,
    fontSize: 14,
  },
  box: {
    flex: 1,
    maxWidth: 45,
    aspectRatio: 45 / 54,
    ...radius(12),
    borderWidth: 1.5,
    borderColor: c.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: {
    borderWidth: 2,
    borderColor: c.accentText,
  },
  digit: {
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
  },
  digitPlaceholder: {
    color: c.placeholder,
  },
  dash: {
    width: 7,
    height: 2,
    marginHorizontal: 0,
    borderRadius: 1,
    backgroundColor: c.divider,
  },
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  resend: {
    marginTop: 24,
    color: c.textSecondary,
    fontSize: 15.5,
    fontWeight: '500',
  },
  resendLink: {
    color: c.accentText,
  },
  note: {
    marginTop: 11,
    color: c.textSecondary,
    fontSize: 11.5,
    lineHeight: 14,
    letterSpacing: 0.2,
  },
}));
