import { Fragment, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { failure, success } from '@/lib/haptics';
import { makeStyles, radius } from '@/theme';
import { DURATION } from '@/theme/motion';

const LENGTH = 6;
/** Wrong codes allowed (typos happen) before pairing stops. */
export const CODE_TRIES = 3;

/**
 * Pairing's check, on the device the wallet leaves: you type the six digits the other
 * device shows. Only the right code lets the wallet go; a different one means someone
 * may be in between, so after a few tries pairing stops (`onGiveUp`).
 */
export function CodeEntry({
  code: expected,
  onMatch,
  onGiveUp,
}: {
  code: string;
  onMatch: () => void;
  onGiveUp: () => void;
}) {
  const styles = useStyles();
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const { shake, style: shaken } = useErrorShake();

  const check = (typed: string) => {
    if (typed === expected) {
      success();
      onMatch();
      return;
    }
    const tries = wrong + 1;
    failure();
    shake();
    setWrong(tries);
    if (tries >= CODE_TRIES) {
      onGiveUp();
      return;
    }
    setError(
      `That’s not the code. Check the other screen. ${CODE_TRIES - tries} ${
        CODE_TRIES - tries === 1 ? 'try' : 'tries'
      } left.`,
    );
    setTimeout(() => setCode(''), 350);
  };

  return (
    <View style={styles.root}>
      <Animated.View style={shaken}>
        <Pressable
          accessibilityLabel="Code from the other device"
          style={styles.boxes}
          onPress={() => input.current?.focus()}
        >
          {Array.from({ length: LENGTH }, (_, i) => {
            const digit = code[i];
            const active = i === Math.min(code.length, LENGTH - 1);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length code slots
              <Fragment key={i}>
                {i === LENGTH / 2 && <View style={styles.dash} />}
                <View style={[styles.box, active && styles.boxActive, error && styles.boxError]}>
                  <Text style={[styles.digit, !digit && styles.placeholder]}>{digit ?? '0'}</Text>
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
        accessibilityLabel="Pairing code"
        onChangeText={(text) => {
          const next = text.replace(/\D/g, '').slice(0, LENGTH);
          setCode(next);
          setError(null);
          if (next.length === LENGTH) check(next);
        }}
        keyboardType="number-pad"
        maxLength={LENGTH}
        caretHidden
        style={styles.hiddenInput}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    alignItems: 'center',
    marginTop: 8,
  },
  boxes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  box: {
    width: 45,
    height: 54,
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
  boxError: {
    borderColor: c.error,
  },
  digit: {
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
  },
  placeholder: {
    color: c.placeholder,
  },
  dash: {
    width: 7,
    height: 2,
    borderRadius: 1,
    backgroundColor: c.divider,
  },
  error: {
    marginTop: 12,
    color: c.error,
    fontSize: 14,
    textAlign: 'center',
  },
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
}));
