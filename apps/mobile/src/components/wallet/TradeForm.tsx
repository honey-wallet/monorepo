import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatPrice } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const CHIP_PAD = 3;
const SLIDE = { duration: DURATION.fast, easing: EASE.inOut };

/**
 * Shared pieces of the trade order forms (Perps, Futures, Options, Predict), on the
 * Trade tab and in the order sheets.
 *
 * `surface` picks the card colour: `card` on the canvas (Trade tab), `raised` inside
 * a sheet, whose background is already the card colour.
 */
type Surface = 'card' | 'raised';

export type Side = 'Long' | 'Short' | 'Call' | 'Put' | 'Yes' | 'No' | 'Up' | 'Down';

/** Grey label above a group of chips, e.g. "Leverage". */
export function FieldLabel({ children }: { children: string }) {
  const styles = useStyles();
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

/** The market being traded, e.g. "BTC-PERP $81,208". `leading` overrides the coin logo. */
export function MarketPill({
  symbol,
  label,
  price,
  leading,
  surface = 'card',
  chevron = true,
}: {
  symbol: string;
  label: string;
  price: number;
  leading?: ReactNode;
  surface?: Surface;
  chevron?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.market, { backgroundColor: c[surface] }]}>
      {leading ?? <TokenIcon symbol={symbol} size={32} />}
      <View style={styles.flex}>
        <Text style={styles.marketLabel}>{label}</Text>
        <Text style={styles.meta}>{formatPrice(price)}</Text>
      </View>
      {chevron && <Icon name="chevronDown" size={13} color={c.textSecondary} />}
    </View>
  );
}

/** Two big buttons: Long/Short, Call/Put, Yes/No. The first is "up" (green), the second "down". */
export function SideToggle<T extends Side>({
  options,
  value,
  onChange,
}: {
  options: [T, T];
  value: T;
  onChange: (side: T) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.sides}>
      {options.map((option, i) => {
        const active = option === value;
        const color = i === 0 ? c.success : c.error;
        return (
          <PressableScale
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => {
              tap();
              onChange(option);
            }}
            style={[styles.side, active && { backgroundColor: `${color}26`, borderColor: color }]}
          >
            <Text style={[styles.sideLabel, active && { color }]}>{option}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

/**
 * One choice from a few, e.g. leverage or expiry: a segmented track where a soft
 * honey pill glides to the selected option in 200ms on ease-in-out (an on-screen
 * move), from wherever it is so quick taps never jump; it snaps on first paint and
 * under Reduce Motion.
 */
export function OptionChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const segment = width ? (width - CHIP_PAD * 2) / options.length : 0;
  const index = Math.max(options.indexOf(value), 0);
  const x = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    if (!segment) return;
    const to = index * segment;
    x.value = placed.current && !reduceMotion ? withTiming(to, SLIDE) : to;
    placed.current = true;
  }, [index, segment, reduceMotion, x]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      accessibilityRole="radiogroup"
      style={styles.chips}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {segment > 0 && <Animated.View style={[styles.chipPill, { width: segment }, pillStyle]} />}
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) return;
              tap();
              onChange(option);
            }}
            style={styles.chip}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[styles.chipLabel, active && styles.chipLabelActive]}
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A typed amount with its unit, e.g. Margin … USDC. */
export function AmountCard({
  label,
  unit,
  value,
  onChange,
  surface = 'card',
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  surface?: Surface;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: c[surface] }]}>
      <Text style={styles.cardLabel}>{label}</Text>
      <View style={styles.cardRow}>
        <TextInput
          value={value}
          onChangeText={(text) => onChange(text.replace(',', '.').replace(/[^0-9.]/g, ''))}
          placeholder="0"
          placeholderTextColor={c.placeholder}
          keyboardType="decimal-pad"
          selectionColor={c.primary}
          accessibilityLabel={`${label} in ${unit}`}
          style={styles.amount}
        />
        <Text style={styles.unit}>{unit}</Text>
      </View>
    </View>
  );
}

/** "Label ........ value" lines under a form; values cross-fade as they change. */
export function Summary({ rows }: { rows: [string, string][] }) {
  const styles = useStyles();
  return (
    <View style={styles.summary}>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.summaryRow}>
          <Text style={styles.meta}>{label}</Text>
          <TextSwap text={value} style={styles.summaryValue} />
        </View>
      ))}
    </View>
  );
}

/** One-line risk note under the order button. */
export function Risk({ text }: { text: string }) {
  const styles = useStyles();
  return <Text style={styles.note}>{text}</Text>;
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  fieldLabel: {
    marginTop: 16,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  market: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 16,
  },
  marketLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  sides: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  side: {
    flex: 1,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.divider,
  },
  sideLabel: {
    color: c.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  chips: {
    flexDirection: 'row',
    padding: CHIP_PAD,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  chipPill: {
    position: 'absolute',
    top: CHIP_PAD,
    bottom: CHIP_PAD,
    left: CHIP_PAD,
    borderRadius: 11,
    backgroundColor: c.accentSurface,
  },
  chip: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  chipLabel: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
  chipLabelActive: {
    color: c.accentText,
    fontWeight: '600',
  },
  card: {
    marginTop: 12,
    padding: 16,
    gap: 10,
    borderRadius: 20,
  },
  cardLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amount: {
    flex: 1,
    padding: 0,
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
  },
  unit: {
    color: c.textSecondary,
    fontSize: 17,
    fontWeight: '500',
  },
  summary: {
    marginTop: 16,
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryValue: {
    color: c.text,
    fontSize: 14,
  },
  note: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
