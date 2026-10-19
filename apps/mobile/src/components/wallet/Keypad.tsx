import {
  Pressable,
  type StyleProp,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { keypress, tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
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

/**
 * A 3×4 number pad for amounts, as in Uniswap's swap and send. `keyHeight` is
 * smaller on screens that also show a form, such as Swap, so everything fits.
 */
export function Keypad({
  onKey,
  keyHeight: fixed,
}: {
  onKey: (key: Key) => void;
  keyHeight?: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  // Short windows (the extension's 600px popup, small phones) get shorter keys, so the
  // amount above keeps its room.
  const { height } = useWindowDimensions();
  // const keyHeight = fixed ?? (height < 700 ? 46 : 64);
  // A caller's fixed height too, or the perps order's amount slid under its price.
  const keyHeight = height < 700 ? Math.min(fixed ?? 42, 42) : (fixed ?? 64);
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
}: {
  value: string;
  prefix?: string;
  size?: number;
  placeholder?: string;
  /** Centred for standalone amounts; left inside cards, e.g. Swap's Sell field. */
  align?: 'center' | 'left';
}) {
  const styles = useStyles();
  const text = value ? prefix + value : prefix + placeholder;
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
    borderRadius: 20,
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
  amountChar: {
    color: c.text,
    fontWeight: '500',
    letterSpacing: -1,
  },
  placeholder: {
    color: c.placeholder,
  },
}));
