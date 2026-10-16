// Motion: switching style is occasional, so the glyph just crossfades (150ms, ease-out)
// to the next one; the press is PressableScale's. Under Reduce Motion it swaps.
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

export type ChartStyle = 'line' | 'candles' | 'stacked';

const SIZE = 16;

/**
 * Switches a chart's style (line or candles, lines or stacked shares). It sits at the
 * right end of the line just above the chart, on every chart page, so it's always in
 * the same place and clear of the ranges below. `to` is the style it switches to,
 * drawn as a small glyph of that chart.
 */
export function ChartStyleButton({
  to,
  label,
  onPress,
}: {
  to: ChartStyle;
  label: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.button}
    >
      <Animated.View key={to} entering={reduceMotion ? undefined : FadeIn.duration(DURATION.quick)}>
        <Glyph style={to} />
      </Animated.View>
    </PressableScale>
  );
}

/** One glyph per style, on a 16pt grid with the same 1.75 stroke and round ends. */
function Glyph({ style }: { style: ChartStyle }) {
  const c = useTheme();
  const ink = c.textSecondary;
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16">
      {style === 'line' ? (
        <Path
          d="M1.5 11.5 L5 7.5 L8 9.5 L11 5 L14.5 3"
          stroke={ink}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : style === 'candles' ? (
        <>
          <Line
            x1={4.5}
            y1={2}
            x2={4.5}
            y2={13}
            stroke={ink}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <Rect x={2.5} y={4.5} width={4} height={6} rx={1} fill={ink} />
          <Line
            x1={11.5}
            y1={3.5}
            x2={11.5}
            y2={14}
            stroke={ink}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <Rect x={9.5} y={6} width={4} height={5.5} rx={1} fill={ink} />
        </>
      ) : (
        <>
          <Path
            d="M1.5 6 L5.5 4 L10 5.5 L14.5 3 V8 L10 9.5 L5.5 8.5 L1.5 9.5 Z"
            fill={ink}
            opacity={0.45}
          />
          <Path
            d="M1.5 11 L5.5 10 L10 11 L14.5 9.5 V13 Q14.5 14 13.5 14 H2.5 Q1.5 14 1.5 13 Z"
            fill={ink}
          />
        </>
      )}
    </Svg>
  );
}

const useStyles = makeStyles((c) => ({
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
}));
