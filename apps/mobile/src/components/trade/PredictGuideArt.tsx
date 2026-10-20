// Illustrations for the Predict guide, seen once while learning the feature, so they
// can carry a little delight. Each piece rises into place on a strong ease-out, the
// most important (front) card first and the background and back cards a beat later,
// so the scene builds by importance. Step 3 adds falling honey confetti (decorative,
// about a second); under Reduce Motion it stays still.
import { useEffect, useMemo } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { Gauge } from '@/components/trade/PredictFeed';
import { GUIDE_ART_HEIGHT, riseIn } from '@/components/wallet/Guide';
import { PREDICT_MARKETS, predictMarket, yesPrice } from '@/lib/predict';
import { formatShare, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/** The live market every step uses as its worked example, and the sample stake. */
const EXAMPLE_ID = 'btc-100k';
const STAKE = 100;

const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Live numbers for the example, priced per the Predict setting (51¢ or 51%). */
function useExample() {
  const { predictPrice } = useTradePrefs();
  const market = predictMarket(EXAMPLE_ID) ?? PREDICT_MARKETS[0];
  const yes = yesPrice(market);
  return {
    question: market.question,
    yes,
    price: formatShare(yes, predictPrice),
    winYes: dollars(STAKE / yes),
    winNo: dollars(STAKE / (1 - yes)),
  };
}

/** Step 1: one market card in focus, over a faded grid of other markets. */
export function PickMarketArt() {
  const styles = useStyles();
  const c = useTheme();
  const example = useExample();
  return (
    <View style={styles.scene}>
      <Animated.View entering={FadeIn.duration(DURATION.slow)} style={styles.grid}>
        {['Who wins the league?', 'Rate cut in March?', 'Next big launch?', 'Box office #1?'].map(
          (q) => (
            <View key={q} style={[styles.card, styles.ghost]}>
              <Text style={styles.ghostText} numberOfLines={2}>
                {q}
              </Text>
              <View style={styles.row}>
                <View style={[styles.ghostButton, styles.flex]} />
                <View style={[styles.ghostButton, styles.flex]} />
              </View>
            </View>
          ),
        )}
      </Animated.View>
      <Animated.View entering={riseIn(120)} style={[styles.card, styles.focus, styles.tiltLeft]}>
        <View style={styles.row}>
          <Text style={[styles.question, styles.flex]}>{example.question}</Text>
          <Gauge value={example.yes} label="Yes" track={c.divider} />
        </View>
        <View style={[styles.row, styles.buttons]}>
          <View style={[styles.button, styles.yes]}>
            <Text style={styles.buttonText}>Yes</Text>
          </View>
          <View style={[styles.button, styles.no]}>
            <Text style={[styles.buttonText, styles.muted]}>No</Text>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

/** Step 2: two trade tickets, Buy Yes in front of Buy No. */
export function PlaceTradeArt() {
  const styles = useStyles();
  const example = useExample();
  return (
    <View style={styles.scene}>
      <Animated.View entering={riseIn(160)} style={[styles.ticket, styles.back, styles.tiltRight]}>
        <Ticket amount={dollars(STAKE)} win={example.winNo} side="No" />
      </Animated.View>
      <Animated.View entering={riseIn(40)} style={[styles.ticket, styles.front, styles.tiltLeft]}>
        <Ticket amount={dollars(STAKE)} win={example.winYes} side="Yes" />
      </Animated.View>
    </View>
  );
}

function Ticket({ amount, win, side }: { amount: string; win: string; side: 'Yes' | 'No' }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <>
      <View style={styles.stepper}>
        <View style={styles.stepButton}>
          <Icon name="minusCircle" size={14} color={c.textSecondary} />
        </View>
        <Text style={styles.amount}>{amount}</Text>
        <View style={styles.stepButton}>
          <Icon name="buy" size={14} color={c.textSecondary} />
        </View>
      </View>
      <Text style={styles.toWin}>
        To win <Text style={styles.win}>{win}</Text>
      </Text>
      <View style={[styles.button, side === 'Yes' ? styles.yes : styles.noSolid]}>
        <Text style={styles.buttonText}>Buy {side}</Text>
      </View>
    </>
  );
}

/** Step 3: a winning receipt with a cash-out button, under falling confetti. */
export function GetPaidArt() {
  const styles = useStyles();
  const c = useTheme();
  const example = useExample();
  return (
    <View style={styles.scene}>
      <Confetti />
      <Animated.View entering={riseIn(60)} style={styles.receipt}>
        <View style={styles.row}>
          <Text style={[styles.question, styles.flex]}>{example.question}</Text>
          <Svg width={34} height={20}>
            <Path
              d="M1 18 L9 10 L15 14 L24 4 L33 8"
              stroke={c.success}
              strokeWidth={2}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </View>
        <View style={styles.rule} />
        {[
          ['Price', example.price],
          ['Amount', dollars(STAKE)],
        ].map(([label, value]) => (
          <View key={label} style={[styles.row, styles.line]}>
            <Text style={[styles.lineLabel, styles.flex]}>{label}</Text>
            <Text style={styles.lineValue}>{value}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.line]}>
          <Text style={[styles.lineLabel, styles.flex]}>To win</Text>
          <Text style={styles.payout}>{example.winYes}</Text>
        </View>
        <View style={[styles.button, styles.cashOut]}>
          <Text style={[styles.buttonText, styles.onPrimary]}>Cash out</Text>
        </View>
        <Zigzag color={c.raised} />
      </Animated.View>
    </View>
  );
}

/** A torn-paper edge along the bottom of the receipt. */
function Zigzag({ color }: { color: string }) {
  const teeth = 18;
  const w = 240;
  const step = w / teeth;
  let d = `M0 0 `;
  for (let i = 0; i < teeth; i++) d += `L${(i + 0.5) * step} 7 L${(i + 1) * step} 0 `;
  return (
    <Svg width={w} height={8} style={{ position: 'absolute', bottom: -7, left: 0 }}>
      <Path d={`${d}Z`} fill={color} />
    </Svg>
  );
}

const PIECES = 28;

/** Honey, green and cream confetti drifting down once. */
function Confetti() {
  const c = useTheme();
  const colors = [c.primary, c.success, c.text, c.accentText];
  // Fixed scatter (no randomness), so the burst looks the same each time.
  const pieces = useMemo(
    () =>
      Array.from({ length: PIECES }, (_, i) => ({
        x: (i * 37) % 100,
        delay: (i * 53) % 600,
        spin: ((i * 71) % 360) - 180,
        drift: ((i * 29) % 40) - 20,
        wide: i % 3 === 0,
      })),
    [],
  );
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {pieces.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional.
        <Piece key={i} {...p} color={colors[i % colors.length]} />
      ))}
    </View>
  );
}

function Piece({
  x,
  delay,
  spin,
  drift,
  color,
  wide,
}: {
  x: number;
  delay: number;
  spin: number;
  drift: number;
  color: string;
  wide: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const fall = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) return;
    fall.value = withDelay(delay, withTiming(1, { duration: 1000, easing: EASE.smoothOut }));
  }, [delay, fall, reduceMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.8 : 1 - Math.max(fall.value - 0.75, 0) * 4,
    transform: [
      { translateY: -20 + fall.value * (GUIDE_ART_HEIGHT * 0.9) },
      { translateX: fall.value * drift },
      { rotate: `${fall.value * spin}deg` },
    ],
  }));
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: `${x}%`,
          top: 0,
          width: wide ? 8 : 5,
          height: wide ? 4 : 7,
          ...radius(1),
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  scene: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  grid: {
    position: 'absolute',
    top: -10,
    left: -40,
    right: -40,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 14,
    opacity: 0.35,
    transform: [{ rotate: '-8deg' }],
  },
  card: {
    padding: 14,
    ...radius(18),
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.divider,
  },
  ghost: {
    width: 190,
    height: 110,
    justifyContent: 'space-between',
  },
  ghostText: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  ghostButton: {
    height: 26,
    ...radius(8),
    backgroundColor: c.divider,
  },
  focus: {
    width: 290,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  tiltLeft: {
    transform: [{ rotate: '-4deg' }],
  },
  tiltRight: {
    transform: [{ rotate: '4deg' }],
  },
  question: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 21,
  },
  buttons: {
    marginTop: 14,
  },
  button: {
    flex: 1,
    height: 40,
    ...radius(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  yes: {
    backgroundColor: c.success,
  },
  no: {
    backgroundColor: c.divider,
  },
  noSolid: {
    backgroundColor: c.error,
  },
  cashOut: {
    flex: 0,
    marginTop: 14,
    backgroundColor: c.primary,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  muted: {
    color: c.textSecondary,
  },
  onPrimary: {
    color: c.onPrimary,
  },
  ticket: {
    position: 'absolute',
    width: 230,
    padding: 16,
    gap: 8,
    borderRadius: 18,
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.divider,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  back: {
    top: 20,
    right: 30,
  },
  front: {
    top: 150,
    left: 26,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepButton: {
    width: 26,
    height: 26,
    ...radius(8),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.divider,
  },
  amount: {
    color: c.text,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
  },
  toWin: {
    textAlign: 'center',
    color: c.textSecondary,
    fontSize: 15,
  },
  win: {
    color: c.success,
    fontWeight: '600',
  },
  receipt: {
    width: 240,
    padding: 16,
    paddingBottom: 18,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    backgroundColor: c.raised,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  rule: {
    height: 1,
    marginVertical: 10,
    backgroundColor: c.divider,
  },
  line: {
    minHeight: 30,
  },
  lineLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  lineValue: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  payout: {
    color: c.success,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
}));
