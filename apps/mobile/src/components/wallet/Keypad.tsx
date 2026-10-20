import { useEffect, useRef } from 'react';
import {
  Pressable,
  type StyleProp,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { keypress, tap } from '@/lib/haptics';
import { isWeb } from '@/lib/platform';
import { makeStyles, radius, useTheme } from '@/theme';
import { PRESS_SCALE } from '@/theme/motion';

export type Key = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | '0' | 'back';
const KEYS: Key[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

/** "7.0800" → "7.08": a number for the keypad, without trailing zeros. */
export function trimNumber(n: number, decimals: number) {
  const s = n.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

const SHARES = [
  ['25%', 0.25],
  ['50%', 0.5],
  ['75%', 0.75],
  ['Max', 1],
] as const;

type ShareLabel = (typeof SHARES)[number][0];

/**
 * 25% / 50% / 75% / Max chips above a keypad. Each fills that share of `balance`,
 * as a keypad string with at most `decimals` decimals.
 */
export function PercentChips({
  balance,
  onPick,
  decimals = 8,
  only,
  style,
}: {
  balance: number;
  onPick: (amount: string) => void;
  decimals?: number;
  /** A subset of the chips, e.g. ['25%', '50%', 'Max']. */
  only?: ShareLabel[];
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  // With nothing to take a share of, the chips stay put but can't be pressed.
  const empty = !(balance > 0);
  return (
    <View style={[styles.chips, style]}>
      {SHARES.filter(([label]) => !only || only.includes(label)).map(([label, share]) => (
        <PressableScale
          key={label}
          accessibilityRole="button"
          accessibilityState={{ disabled: empty }}
          disabled={empty}
          scaleTo={PRESS_SCALE}
          onPress={() => {
            tap();
            onPick(trimNumber(balance * share, decimals));
          }}
          style={[styles.chip, empty && styles.chipOff]}
        >
          <Text style={styles.chipLabel}>{label}</Text>
        </PressableScale>
      ))}
    </View>
  );
}

/** Applies a key press to a decimal amount string, e.g. "12.5" + "back" → "12.". */
export function applyKey(value: string, key: Key, maxDecimals = 8): string {
  if (key === 'back') return value.slice(0, -1);
  if (key === '.') return value.includes('.') ? value : `${value || '0'}.`;
  const [, decimals] = value.split('.');
  if (decimals !== undefined && decimals.length >= maxDecimals) return value;
  if (value === '0') return key;
  return value + key;
}

/** Typed or pasted text → a clean amount string, by the same rules as the keypad. */
export function sanitizeAmount(text: string, maxDecimals = 8): string {
  let out = '';
  for (const ch of text.replace(/,/g, '.')) {
    if (/^[0-9]$/.test(ch) || ch === '.') out = applyKey(out, ch as Key, maxDecimals);
  }
  return out;
}

/**
 * A 3×4 number pad for amounts, as in Uniswap's swap and send. `keyHeight` is
 * smaller on screens that also show a form, such as Swap, so everything fits.
 */
export function Keypad({
  onKey,
  keyHeight: fixed,
  input,
}: {
  onKey: (key: Key) => void;
  keyHeight?: number;
  /** In the browser, a real text field on the screen takes the typing: render nothing. */
  input?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  // Short windows (the extension's 600px popup, small phones) get shorter keys, so the
  // amount above keeps its room.
  const { height } = useWindowDimensions();
  // const keyHeight = fixed ?? (height < 700 ? 46 : 64);
  // A caller's fixed height too, or the perps order's amount slid under its price.
  const keyHeight = height < 700 ? Math.min(fixed ?? 42, 42) : (fixed ?? 64);
  useComputerKeys(onKey, !(isWeb && input));
  if (isWeb && input) return null;
  // The browser has a real keyboard: no on-screen keys, just a line saying to type, so
  // the form's button stays in view in the popup (review: Review swap was off-screen).
  if (isWeb) return <Text style={styles.typeHint}>Type an amount</Text>;
  return (
    <View style={styles.pad}>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={key === 'back' ? 'Delete' : key}
          onPress={() => {
            keypress();
            onKey(key);
          }}
          style={({ pressed }) => [styles.key, { height: keyHeight }, pressed && styles.keyDown]}
        >
          {key === 'back' ? (
            <Icon name="backspace" size={22} color={c.text} />
          ) : key === '.' ? (
            // A drawn dot, centred like the digits (a "." glyph sits on the baseline).
            <View style={styles.dot} />
          ) : (
            <Text style={styles.keyLabel}>{key}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

/** Keypads on screen, newest last: only the newest (the screen in front) takes typing. */
const typing: object[] = [];

/** Digits, a point and Backspace from the computer's keyboard, in the browser only. */
function useComputerKeys(onKey: (key: Key) => void, enabled = true) {
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!isWeb || !enabled) return;
    const me = {};
    typing.push(me);
    const onDown = (e: KeyboardEvent) => {
      if (typing[typing.length - 1] !== me) return;
      // Not while a text field has focus (a search, an address), or with a shortcut.
      const field = (e.target as HTMLElement | null)?.closest?.(
        'input, textarea, [contenteditable]',
      );
      if (field || e.metaKey || e.ctrlKey || e.altKey) return;
      const key: Key | null = /^[0-9]$/.test(e.key)
        ? (e.key as Key)
        : e.key === '.' || e.key === ','
          ? '.'
          : e.key === 'Backspace'
            ? 'back'
            : null;
      if (!key) return;
      e.preventDefault();
      latest.current(key);
    };
    window.addEventListener('keydown', onDown);
    return () => {
      window.removeEventListener('keydown', onDown);
      typing.splice(typing.indexOf(me), 1);
    };
  }, [enabled]);
}

/**
 * A typed amount. Typing is keyboard-like input done constantly, so new characters
 * appear instantly with no animation (it would make typing feel slow). Shows
 * `placeholder` dimmed when empty.
 */
export function TypedAmount({
  value,
  prefix = '',
  size = 56,
  placeholder = '0',
  align = 'center',
  onChangeText,
  maxDecimals = 8,
}: {
  value: string;
  /** Browser only: render a real decimal text field that reports cleaned amounts. */
  onChangeText?: (value: string) => void;
  maxDecimals?: number;
  prefix?: string;
  size?: number;
  placeholder?: string;
  /** Centred for standalone amounts; left inside cards, e.g. Swap's Sell field. */
  align?: 'center' | 'left';
}) {
  const styles = useStyles();
  const c = useTheme();
  const text = value ? prefix + value : prefix + placeholder;
  if (isWeb && onChangeText) {
    return (
      <View style={[styles.amount, align === 'left' && styles.amountLeft]}>
        {prefix ? (
          <Text style={[styles.amountChar, { fontSize: size }, !value && styles.placeholder]}>
            {prefix}
          </Text>
        ) : null}
        <TextInput
          value={value}
          onChangeText={(t) => onChangeText(sanitizeAmount(t, maxDecimals))}
          placeholder={placeholder}
          placeholderTextColor={c.placeholder}
          inputMode="decimal"
          autoFocus
          selectionColor={c.primary}
          accessibilityLabel="Amount"
          style={[styles.amountChar, styles.amountInput, { fontSize: size }]}
        />
      </View>
    );
  }
  return (
    <View style={[styles.amount, align === 'left' && styles.amountLeft]}>
      <Text
        accessibilityLabel={text}
        style={[styles.amountChar, { fontSize: size }, !value && styles.placeholder]}
      >
        {text}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  typeHint: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  chips: {
    flexDirection: 'row',
    gap: 8,
  },
  // Filled like the header buttons, so the row reads as buttons, not outlines.
  chip: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: c.raised,
  },
  chipOff: {
    opacity: 0.4,
  },
  chipLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  pad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  key: {
    width: '33.333%',
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    ...radius(20),
  },
  keyDown: {
    backgroundColor: c.raised,
  },
  keyLabel: {
    color: c.text,
    fontSize: 30,
    fontWeight: '500',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: c.text,
  },
  amount: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  amountLeft: {
    justifyContent: 'flex-start',
  },
  amountInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    // The amount is the focus; a browser focus ring around it reads as a form field.
    ...(isWeb ? ({ outlineStyle: 'none' } as object) : null),
  },
  amountChar: {
    color: c.text,
    fontWeight: '500',
    letterSpacing: -1,
  },
  placeholder: {
    color: c.placeholder,
  },
}));
