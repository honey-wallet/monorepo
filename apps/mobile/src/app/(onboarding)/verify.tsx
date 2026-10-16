import { useLocalSearchParams } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { popIn } from '@/components/motion/NumberPopIn';
import { PillButton } from '@/components/onboarding/PillButton';
import { StepScreen } from '@/components/onboarding/StepScreen';
import { finishOnboarding } from '@/lib/onboarding';
import { makeStyles } from '@/theme';

const LENGTH = 6;
const RESEND_SECONDS = 30;

export default function VerifyScreen() {
  const { to, intent } = useLocalSearchParams<{ to?: string; intent?: string }>();
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const input = useRef<TextInput>(null);
  const styles = useStyles();

  useEffect(() => {
    if (secondsLeft === 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const complete = code.length === LENGTH;

  return (
    <StepScreen
      help="code"
      title="Enter your code"
      footer={
        <PillButton
          label="Continue"
          disabled={!complete}
          onPress={() =>
            // Straight into the wallet: password, name and photo are out of the flow
            // for now (fewer steps before the wallet exists; the name comes from the
            // email, the photo from Finish setting up).
            // router.push('/password')
            finishOnboarding('email', { restored: intent === 'restore', email: to })
          }
        />
      }
    >
      <Pressable style={styles.boxes} onPress={() => input.current?.focus()}>
        {Array.from({ length: LENGTH }, (_, i) => {
          const digit = code[i];
          const active = i === Math.min(code.length, LENGTH - 1);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length code slots
            <Fragment key={i}>
              {i === LENGTH / 2 && <View style={styles.dash} />}
              <View style={[styles.box, active && styles.boxActive]}>
                {digit ? (
                  <Animated.Text key={digit} entering={popIn()} style={styles.digit}>
                    {digit}
                  </Animated.Text>
                ) : (
                  <Text style={[styles.digit, styles.digitPlaceholder]}>0</Text>
                )}
              </View>
            </Fragment>
          );
        })}
      </Pressable>

      <TextInput
        ref={input}
        autoFocus
        value={code}
        onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, LENGTH))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={LENGTH}
        caretHidden
        style={styles.hiddenInput}
      />

      <Text style={styles.resend}>
        Didn’t receive a code?{' '}
        {secondsLeft > 0 ? (
          `Resend in ${secondsLeft}s`
        ) : (
          <Text style={styles.resendLink} onPress={() => setSecondsLeft(RESEND_SECONDS)}>
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
  box: {
    flex: 1,
    maxWidth: 45,
    aspectRatio: 45 / 54,
    borderRadius: 12,
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
