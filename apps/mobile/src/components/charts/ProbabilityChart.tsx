// A prediction market's chart, after Polymarket's: each outcome's chance over time as
// a stepped line (prices jump when a trade lands, then hold) on a fixed 0–100% scale
// with quiet dotted guides and the times along the bottom. Each line's name and chance
// sit in a column to the right of where it ends, so nothing is drawn over a line and
// the chart reads without a legend. With `stacked` it shows stacked bands instead:
// each answer's share of the whole, as Kalshi shows it. Dragging scrubs: a hairline
// follows the finger 1:1, the dots and labels take the values under it, and the time
// axis becomes the moment under the finger. Changing range or style crossfades the
// plot in (200ms); under Reduce Motion it just swaps.
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { ChartEmpty } from '@/components/charts/PriceChart';
import { tap } from '@/lib/haptics';
import { chartTime, type PredictRange } from '@/lib/predict';
import { makeStyles, type Palette, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** The column right of the plot for each line's name and chance. */
const GUTTER = 92;
/** Room along the bottom for the times. */
const TIME_AXIS = 24;
const PAD_Y = 8;
const GUIDES = [1, 0.75, 0.5, 0.25, 0];
/** A line label's height (name over chance), and the gap kept between two. */
const LABEL_H = 34;
const LABEL_GAP = 4;
/** Where the time ticks sit along the range; the last one is "Now". */
const TICKS = [0, 1 / 3, 2 / 3];

/** Each outcome's colour: honey first (our accent), then blue, violet, teal. */
export function outcomeColor(c: Palette, tone: number) {
  const tones = [c.honey, '#3B82F6', '#8B5CF6', '#14B8A6'];
  return tones[tone % tones.length];
}

/** "<1%" under one percent, as Polymarket writes it; otherwise a whole percentage. */
const pct = (v: number) => (v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

export type ChanceLine = { id: string; label: string; tone: number; data: number[] };

type Props = {
  lines: ChanceLine[];
  width: number;
  height: number;
  range: PredictRange;
  /** Each answer's share as stacked bands, instead of lines. */
  stacked?: boolean;
  /** The index being scrubbed (from `onScrub`), or null to show the latest values. */
  scrub: number | null;
  /** The index under the finger while scrubbing, then null on release. */
  onScrub?: (index: number | null) => void;
};

export function ProbabilityChart(props: Props) {
  if ((props.lines[0]?.data.length ?? 0) < 2) {
    return <ChartEmpty height={props.height} text="No trades yet" />;
  }
  return <Probabilities {...props} />;
}

function Probabilities({
  lines,
  width,
  height,
  range,
  stacked: stackedPick = false,
  scrub,
  onScrub,
}: Props) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  // Shares only mean something with several answers; a single Yes line stays a line.
  const stacked = stackedPick && lines.length > 1;
  const plot = width - GUTTER;
  const plotHeight = height - TIME_AXIS;
  const n = lines[0]?.data.length ?? 0;
  const at = scrub ?? n - 1;
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * plot : 0);
  const y = (v: number) => PAD_Y + (1 - v) * (plotHeight - PAD_Y * 2);

  // Stacked: each answer's share of the total at every point, the first answer on top.
  // `bands[k][i]` is [bottom, top] of answer k at point i, on the 0–1 scale.
  const bands = useMemo(
    () =>
      lines.map((_, k) =>
        Array.from({ length: n }, (_, i) => {
          const total = lines.reduce((sum, l) => sum + l.data[i], 0) || 1;
          const below = lines.slice(k + 1).reduce((sum, l) => sum + l.data[i], 0) / total;
          return [below, below + lines[k].data[i] / total] as const;
        }),
      ),
    [lines, n],
  );

  const paths = useMemo(() => {
    const sx = (i: number) => (n > 1 ? (i / (n - 1)) * plot : 0);
    const sy = (v: number) => PAD_Y + (1 - v) * (plotHeight - PAD_Y * 2);
    // Hold, then jump: a horizontal run to the next point, then straight up or down.
    const step = (values: number[]) => {
      let d = `M0 ${sy(values[0]).toFixed(1)}`;
      for (let i = 1; i < values.length; i++) {
        d += ` H${sx(i).toFixed(1)} V${sy(values[i]).toFixed(1)}`;
      }
      return d;
    };
    if (!stacked) return lines.map((line) => step(line.data));
    return bands.map((band) => {
      // Along the top edge, then back along the bottom edge, retracing the steps.
      let d = step(band.map((b) => b[1]));
      d += ` V${sy(band[n - 1][0]).toFixed(1)}`;
      for (let i = n - 1; i >= 1; i--) {
        d += ` V${sy(band[i - 1][0]).toFixed(1)} H${sx(i - 1).toFixed(1)}`;
      }
      return `${d} Z`;
    });
  }, [lines, bands, stacked, n, plot, plotHeight]);

  // Each label is centred on its line's value (or its band's middle) in the column to
  // the right; labels that would overlap are pushed apart, below the style button.
  const labels = lines
    .map((line, k) => {
      const mid = stacked ? (bands[k][at][0] + bands[k][at][1]) / 2 : line.data[at];
      return { line, value: line.data[at], top: y(mid) - LABEL_H / 2 };
    })
    .sort((a, b) => a.top - b.top);
  for (let i = 0; i < labels.length; i++) {
    const min = i === 0 ? 0 : labels[i - 1].top + LABEL_H + LABEL_GAP;
    labels[i].top = Math.max(labels[i].top, min);
  }
  for (let i = labels.length - 1; i >= 0; i--) {
    const max =
      i === labels.length - 1 ? plotHeight - LABEL_H : labels[i + 1].top - LABEL_H - LABEL_GAP;
    labels[i].top = Math.min(labels[i].top, max);
  }

  const scrubX = useSharedValue(-1);
  const pick = (i: number | null) => onScrub?.(i);
  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onStart((e) => {
      const x = Math.min(plot, Math.max(0, e.x));
      scrubX.value = x;
      scheduleOnRN(tap);
      scheduleOnRN(pick, Math.round((x / plot) * (n - 1)));
    })
    .onUpdate((e) => {
      const x = Math.min(plot, Math.max(0, e.x));
      const before = Math.round((scrubX.value / plot) * (n - 1));
      scrubX.value = x;
      const i = Math.round((x / plot) * (n - 1));
      if (i !== before) scheduleOnRN(pick, i);
    })
    .onFinalize(() => {
      scrubX.value = -1;
      scheduleOnRN(pick, null);
    });
  const guide = useAnimatedStyle(() => ({
    opacity: scrubX.value < 0 ? 0 : 1,
    transform: [{ translateX: Math.max(0, scrubX.value) }],
  }));

  // While scrubbing, the time axis is the moment under the finger, centred on it.
  const READOUT = 140;
  const readoutLeft = Math.min(plot - READOUT, Math.max(0, px(at) - READOUT / 2));

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={pan}>
        <View style={[styles.layer, { width: plot, height }]}>
          <Svg width={plot} height={plotHeight} style={styles.layer}>
            {GUIDES.map((g) => (
              <Line
                key={g}
                x1={0}
                x2={plot}
                y1={y(g)}
                y2={y(g)}
                stroke={c.divider}
                strokeWidth={1}
                strokeDasharray="2 5"
              />
            ))}
          </Svg>
          <Animated.View
            key={`${range}-${stacked}`}
            entering={reduceMotion ? undefined : FadeIn.duration(DURATION.fast)}
            style={styles.layer}
          >
            <Svg width={plot + 8} height={plotHeight}>
              {lines.map((line, i) => {
                const color = outcomeColor(c, line.tone);
                if (stacked) {
                  return (
                    <Path
                      key={line.id}
                      d={paths[i]}
                      fill={color}
                      fillOpacity={0.35}
                      stroke={c.canvas}
                      strokeWidth={1.5}
                    />
                  );
                }
                const cy = y(line.data[at]);
                return (
                  <G key={line.id}>
                    <Path
                      d={paths[i]}
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      fill="none"
                    />
                    <Circle cx={px(at)} cy={cy} r={7} fill={color} opacity={0.18} />
                    <Circle cx={px(at)} cy={cy} r={3.5} fill={color} />
                  </G>
                );
              })}
            </Svg>
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[styles.guide, { height: plotHeight }, guide]}
          />

          {/* When: a few times along the range, or the moment being scrubbed */}
          <View style={[styles.times, { top: plotHeight, width: plot }]}>
            {scrub === null ? (
              <>
                {TICKS.map((t, i) => (
                  <Text
                    key={t}
                    style={[
                      styles.time,
                      { left: i === 0 ? 0 : t * plot - 40, width: 80 },
                      i > 0 && styles.center,
                    ]}
                  >
                    {chartTime(range, t)}
                  </Text>
                ))}
                <Text style={[styles.time, styles.now]}>Now</Text>
              </>
            ) : (
              <Text style={[styles.time, styles.readout, { left: readoutLeft, width: READOUT }]}>
                {chartTime(range, n > 1 ? scrub / (n - 1) : 1, true)}
              </Text>
            )}
          </View>
        </View>
      </GestureDetector>

      {/* What each line is, and its chance, right of where it ends (or under the finger) */}
      {labels.map(({ line, value, top }) => (
        <View
          key={line.id}
          pointerEvents="none"
          style={[styles.label, { top, left: plot + 14, width: GUTTER - 14 }]}
        >
          <Text style={styles.labelName} numberOfLines={1}>
            {line.label}
          </Text>
          <Text style={[styles.labelValue, { color: outcomeColor(c, line.tone) }]}>
            {pct(value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  layer: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  label: {
    position: 'absolute',
    height: LABEL_H,
    justifyContent: 'center',
  },
  labelName: {
    color: c.textSecondary,
    fontSize: 12,
  },
  labelValue: {
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  guide: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 1,
    backgroundColor: c.textSecondary,
  },
  times: {
    position: 'absolute',
    left: 0,
    height: TIME_AXIS,
  },
  time: {
    position: 'absolute',
    bottom: 0,
    color: c.textSecondary,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  center: {
    textAlign: 'center',
  },
  now: {
    right: 0,
  },
  readout: {
    color: c.text,
    fontWeight: '600',
    textAlign: 'center',
  },
}));
