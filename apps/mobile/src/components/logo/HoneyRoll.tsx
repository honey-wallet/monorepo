// NOT USED FOR NOW: tried on Welcome and in the Motion gallery, both taken out.
// Kept so it can come back.
// Just for fun: the Honey mark as a honeycomb wheel that never stops making honey.
// One 3s loop on a single clock, so every part stays in step:
//   drip  – three drops swell on the bottom edge (stretching as they fill), let go and
//           fall (falling accelerates, the one place an ease-in is right: gravity),
//           landing in a small puddle that gives a little squash each time
//   roll  – the hexagon rolls one face (60°) like a wheel, lifting as it tips over a
//           corner and settling with a small overshoot
//   eyes  – they ride along with the roll, blink, and open on the new top edge (the
//           blink hides the hop; a hexagon turned 60° looks the same, so the loop never
//           shows a seam)
// Decorative only: under Reduce Motion it's the still mark.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Ellipse, Path } from 'react-native-svg';
import { EYES_PATH, MARK_VIEWBOX, RING_PATH } from '@/components/logo/paths';
import { useTheme } from '@/theme';

const EYES = '#4B2817';
const CYCLE = 3000;

// The loop's beats, in ms.
const GROW_AT = 0;
const GROW_MS = 1000;
const ROLL_AT = 1250;
const ROLL_MS = 650;
const FALL_MS = 480;
const BLINK_AT = ROLL_AT + ROLL_MS + 60;
const BLINK_MS = 180;

/** Where the drops hang along the bottom edge (fraction of width), and their offsets. */
const DROPS = [
  { x: 0.4, delay: 0, size: 1 },
  { x: 0.53, delay: 140, size: 0.8 },
  { x: 0.62, delay: 260, size: 0.65 },
];

// Easing on the clock (worklets), as plain functions of 0–1.
const clamp01 = (v: number) => {
  'worklet';
  return Math.min(1, Math.max(0, v));
};
const outCubic = (p: number) => {
  'worklet';
  return 1 - (1 - p) ** 3;
};
const inQuad = (p: number) => {
  'worklet';
  return p * p;
};
/** Ease-in-out that overshoots a touch at the end, like a wheel settling. */
const inOutBack = (p: number) => {
  'worklet';
  const c = 1.2 * 1.525;
  return p < 0.5
    ? ((2 * p) ** 2 * ((c + 1) * 2 * p - c)) / 2
    : ((2 * p - 2) ** 2 * ((c + 1) * (p * 2 - 2) + c) + 2) / 2;
};

export function HoneyRoll({ width = 180 }: { width?: number }) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const markHeight = (width * 350) / 400;
  const fall = width * 0.42;
  const height = markHeight + fall + 12;
  const t = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    t.value = 0;
    t.value = withRepeat(withTiming(CYCLE, { duration: CYCLE, easing: Easing.linear }), -1);
    return () => cancelAnimation(t);
  }, [reduceMotion, t]);

  // 0 → 1 across the roll.
  const roll = (now: number) => {
    'worklet';
    return clamp01((now - ROLL_AT) / ROLL_MS);
  };
  // Rotation in degrees; it snaps back to 0 behind the blink (invisible on a hexagon).
  const angle = (now: number) => {
    'worklet';
    if (now >= BLINK_AT + BLINK_MS / 2) return 0;
    return inOutBack(roll(now)) * 60;
  };

  const body = useAnimatedStyle(() => {
    // Tipping over a corner lifts the centre: R − apothem, about 13% of the radius.
    const lift = Math.sin(Math.PI * roll(t.value)) * width * 0.065;
    return { transform: [{ translateY: -lift }] };
  });
  const ring = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle(t.value)}deg` }] }));
  const eyesTurn = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle(t.value)}deg` }],
  }));
  const eyesBlink = useAnimatedStyle(() => {
    const p = clamp01((t.value - BLINK_AT) / BLINK_MS);
    // Closed in the middle of the blink, open either side.
    return { transform: [{ scaleY: 1 - 0.9 * Math.sin(Math.PI * p) }] };
  });

  return (
    <View style={{ width, height }} accessible accessibilityLabel="Honey">
      {/* The puddle the drops land in */}
      <Puddle t={t} width={width} top={markHeight + fall} color={c.brandYellow} />

      {DROPS.map((d) => (
        <Drop
          key={d.x}
          t={t}
          x={d.x * width}
          // Starting inside the ring, so each drop grows out of the honey, not under it.
          top={markHeight - width * 0.05}
          fall={fall}
          size={width * 0.11 * d.size}
          delay={d.delay}
          color={c.brandYellow}
        />
      ))}

      <Animated.View style={[{ width, height: markHeight }, body]}>
        <Animated.View style={[{ width, height: markHeight }, ring]}>
          <Svg width={width} height={markHeight} viewBox={MARK_VIEWBOX}>
            <Path fill={c.brandYellow} fillRule="evenodd" d={RING_PATH} />
          </Svg>
        </Animated.View>
        <Animated.View style={[styles.layer, { width, height: markHeight }, eyesTurn]}>
          <Animated.View style={[styles.eyes, eyesBlink]}>
            <Svg width={width} height={markHeight} viewBox={MARK_VIEWBOX}>
              <Path fill={EYES} d={EYES_PATH} />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** One drop: swells on the edge, lets go as the wheel starts to roll, falls, lands. */
function Drop({
  t,
  x,
  top,
  fall,
  size,
  delay,
  color,
}: {
  t: SharedValue<number>;
  x: number;
  top: number;
  fall: number;
  size: number;
  delay: number;
  color: string;
}) {
  const h = size * 1.4;
  const style = useAnimatedStyle(() => {
    const now = t.value - delay;
    const grow = outCubic(clamp01((now - GROW_AT) / GROW_MS));
    const drop = inQuad(clamp01((now - ROLL_AT) / FALL_MS));
    const landed = now >= ROLL_AT + FALL_MS;
    // Filling: narrow and long at first (still a thread of honey), rounder as it fills.
    const sx = 0.25 + 0.75 * grow;
    const sy = 0.2 + 0.95 * grow - 0.15 * drop;
    return {
      opacity: landed || now < 0 ? 0 : 1,
      transform: [{ translateY: drop * (fall - h) }, { scaleX: sx }, { scaleY: sy }],
    };
  });
  return (
    <Animated.View
      style={[
        { position: 'absolute', left: x - size / 2, top, width: size, height: h },
        { transformOrigin: ['50%', '0%', 0] },
        style,
      ]}
    >
      <Svg width={size} height={h} viewBox="0 0 20 28">
        <Path fill={color} d="M10 0C10 7 20 13 20 19A10 9 0 0 1 0 19C0 13 10 7 10 0Z" />
      </Svg>
    </Animated.View>
  );
}

/** A flat pool under the wheel that squashes a little as each drop lands. */
function Puddle({
  t,
  width,
  top,
  color,
}: {
  t: SharedValue<number>;
  width: number;
  top: number;
  color: string;
}) {
  const w = width * 0.5;
  const style = useAnimatedStyle(() => {
    let squash = 0;
    for (const d of DROPS) {
      const p = clamp01((t.value - d.delay - ROLL_AT - FALL_MS) / 260);
      squash = Math.max(squash, Math.sin(Math.PI * p) * d.size);
    }
    return { transform: [{ scaleX: 1 + squash * 0.08 }, { scaleY: 1 - squash * 0.12 }] };
  });
  return (
    <Animated.View
      style={[{ position: 'absolute', left: (width - w) / 2, top, width: w, height: 12 }, style]}
    >
      <Svg width={w} height={12}>
        <Ellipse cx={w / 2} cy={6} rx={w / 2} ry={5} fill={color} opacity={0.9} />
      </Svg>
    </Animated.View>
  );
}

const styles = {
  layer: { position: 'absolute' as const, top: 0, left: 0 },
  // The blink squashes the eyes about their own centre, about 12% down the mark.
  eyes: { transformOrigin: ['50%', '12%', 0] as [string, string, number] },
};
