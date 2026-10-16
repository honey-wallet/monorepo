// Motion: a long description shows its first few lines, the last one fading into the
// page so it reads as "there's more". Read more grows the block to its full height on
// the snappy height ease-out while the fade lifts and the chevron turns; the time
// scales with how much text appears (250–400ms), so a short reveal never drags. Under
// Reduce Motion the height changes at once and only the fade animates.
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { AccordionChevron } from '@/components/motion/Accordion';
import { TextSwap } from '@/components/motion/TextSwap';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const LINE = 24;
const FADE = { duration: DURATION.fast, easing: EASE.ease } as const;

/** A titled block of text that clamps to `lines` and opens with Read more. */
export function Description({
  title = 'Description',
  text,
  lines = 3,
  background,
}: {
  title?: string;
  text: string;
  lines?: number;
  /** The surface behind it, which the last line fades into (the page by default). */
  background?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(0);
  const clamped = lines * LINE;
  const long = full > clamped + 2;
  const height = useSharedValue(clamped);
  const fade = useSharedValue(1);

  useEffect(() => {
    if (!full) return;
    const target = open || !long ? full : clamped;
    const change = Math.abs(target - height.value);
    const duration = Math.min(DURATION.verySlow, DURATION.medium + change * 0.6);
    height.value = reduceMotion ? target : withTiming(target, { duration, easing: EASE.height });
    fade.value = withTiming(open || !long ? 0 : 1, FADE);
  }, [open, full, long, clamped, reduceMotion, height, fade]);

  const body = useAnimatedStyle(() => ({ height: height.value }));
  const veil = useAnimatedStyle(() => ({ opacity: fade.value }));
  const fadeTo = background ?? c.canvas;

  return (
    <View>
      <View style={styles.head}>
        <Icon name="text" size={18} color={c.textSecondary} />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <Animated.View style={[styles.body, body]}>
        {/* Laid out free of the clip (absolute), so iOS wraps every line and the
            measure is the full height; the block clips it while closed. */}
        <View
          style={styles.measure}
          onLayout={(e) => setFull(Math.ceil(e.nativeEvent.layout.height))}
        >
          <Text style={styles.text}>{text}</Text>
        </View>
        {long ? (
          <Animated.View pointerEvents="none" style={[styles.veil, veil]}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="descFade" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={fadeTo} stopOpacity={0} />
                  <Stop offset="1" stopColor={fadeTo} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#descFade)" />
            </Svg>
          </Animated.View>
        ) : null}
      </Animated.View>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={8}
          onPress={() => {
            tap();
            setOpen((o) => !o);
          }}
          style={styles.more}
        >
          <TextSwap text={open ? 'Read less' : 'Read more'} style={styles.moreLabel} />
          <AccordionChevron open={open} size={13} color={c.text} />
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  head: {
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
  body: {
    overflow: 'hidden',
  },
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  text: {
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: LINE,
  },
  veil: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: LINE * 1.6,
  },
  more: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  moreLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
}));
