// Motion: each digit is a clipped reel of 0-9 cells. The total shows up still (this
// screen opens tens of times a day, so it must not perform every time); only when the
// value changes does each changed digit roll forward to its new value (200ms,
// ease-in-out, no overshoot), with at most two 40ms stagger steps. Under Reduce
// Motion the new value fades in instead. Do not use for values ticking every second.
import { useEffect, useRef, useState } from 'react';
import { type StyleProp, Text, type TextStyle, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { DURATION, EASE } from '@/theme/motion';
import { fadeIn } from './reducedFade';
import { useHasMounted } from './useHasMounted';

const ROLL = { duration: DURATION.fast, easing: EASE.inOut } as const;
/** Two 0-9 sets, so a digit can roll forward past 9 (e.g. 8 → 2). */
const CELLS = Array.from({ length: 20 }, (_, i) => String(i % 10));

/**
 * A number whose digits roll to their new values when it changes, e.g. "Total saved".
 * Digits use tabular figures so every reel is one width.
 */
export function SpinningCounter({ value, style }: { value: string; style?: StyleProp<TextStyle> }) {
  const [cell, setCell] = useState(0);
  const reduceMotion = useReducedMotion();
  const mounted = useHasMounted();
  if (reduceMotion) {
    return (
      <Animated.Text key={value} entering={mounted ? fadeIn() : undefined} style={[style, TABULAR]}>
        {value}
      </Animated.Text>
    );
  }
  // Count digit columns from the right, so the stagger reads left to right and a
  // longer number keeps its last digits' reels.
  let digitIndex = 0;
  const digits = [...value].filter((ch) => /\d/.test(ch)).length;
  return (
    <View accessible accessibilityLabel={value} style={{ flexDirection: 'row' }}>
      {[...value].map((ch, i) => {
        if (!/\d/.test(ch)) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: characters have no other identity.
            <Text key={i} style={[style, TABULAR]}>
              {ch}
            </Text>
          );
        }
        const column = digitIndex++;
        return (
          <Reel
            key={`d${digits - column}`}
            digit={Number(ch)}
            column={column}
            cell={cell}
            onCell={setCell}
            style={style}
          />
        );
      })}
    </View>
  );
}

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

function Reel({
  digit,
  column,
  cell,
  onCell,
  style,
}: {
  digit: number;
  column: number;
  cell: number;
  onCell: (height: number) => void;
  style?: StyleProp<TextStyle>;
}) {
  const offset = useSharedValue(digit);
  const placed = useRef(false);

  useEffect(() => {
    if (!cell) return;
    // The first value just sits there; only later changes roll.
    if (!placed.current) {
      placed.current = true;
      offset.value = digit;
      return;
    }
    // Roll forward from the digit showing now, wrapping past 9 if needed.
    const from = offset.value % 10;
    if (from === digit) return;
    offset.value = from;
    offset.value = withDelay(
      Math.min(column, 2) * DURATION.stagger,
      withTiming(digit > from ? digit : digit + 10, ROLL),
    );
  }, [digit, cell, column, offset]);

  const strip = useAnimatedStyle(() => ({ transform: [{ translateY: -offset.value * cell }] }));

  return (
    <View style={{ height: cell || undefined, overflow: 'hidden' }}>
      {/* Sizes the column: one digit wide, one line tall. */}
      <Text
        style={[style, TABULAR, { opacity: 0 }]}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h && h !== cell) onCell(h);
        }}
      >
        {digit}
      </Text>
      {cell > 0 && (
        <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0 }, strip]}>
          {CELLS.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: reel cells repeat 0-9.
            <Text key={i} style={[style, TABULAR, { height: cell, textAlign: 'center' }]}>
              {d}
            </Text>
          ))}
        </Animated.View>
      )}
    </View>
  );
}
