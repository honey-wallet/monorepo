import { useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

export type GuideStep = {
  title: string;
  body: string;
  /** The illustration; rendered fresh on each step so its entrance plays. */
  art: ReactNode;
  /** Small print under the body, e.g. eligibility on the last step. */
  note?: string;
};

/** Height of the illustration area, shared so every step's art lines up. */
export const GUIDE_ART_HEIGHT = 240;

/**
 * Entrance for guide illustration pieces: fade and rise 12px (a guide is seen once, so
 * it can take the rare-moment 400ms). Stagger with `delay`, most important piece first.
 */
export const riseIn = (delay = 0) =>
  FadeInDown.duration(DURATION.verySlow)
    .delay(delay)
    .easing(EASE.smoothOut)
    .withInitialValues({
      transform: [{ translateY: DISTANCE.medium }],
    });

/**
 * A short numbered how-to in a sheet: illustration, "1. Title", explanation, page
 * dots, Next / Get started. Steps crossfade with a small sideways hint, forward to
 * the left; the last button runs `onDone` (closing the sheet by default).
 */
export function Guide({
  steps,
  doneLabel = 'Get started',
  onDone = closeSheet,
}: {
  steps: GuideStep[];
  doneLabel?: string;
  /** What the last step's button does; closes the sheet by default. */
  onDone?: () => void;
}) {
  const styles = useStyles();
  // `?step=2` opens a later step, e.g. from a deep link.
  const { step: startAt } = useLocalSearchParams<{ step?: string }>();
  const [index, setIndex] = useState(
    Math.min(Math.max(Number(startAt ?? 1) - 1, 0), steps.length - 1) || 0,
  );
  const step = steps[index];
  const last = index === steps.length - 1;
  // The tallest step's text sets the text area's height, so the sheet keeps one size.
  const [heights, setHeights] = useState<number[]>([]);
  const textHeight = Math.max(0, ...heights);

  return (
    // Sized to its content, so short steps don't leave a gap above the button.
    <SheetScreen
      footer={
        <PillButton
          label={last ? doneLabel : 'Next'}
          onPress={() => {
            tap();
            if (last) onDone();
            else setIndex(index + 1);
          }}
        />
      }
    >
      <ContentSwap id={String(index)} index={index}>
        <View style={styles.art}>{step.art}</View>
        <View style={[styles.textArea, { minHeight: textHeight }]}>
          <StepText step={step} number={index + 1} />
        </View>
      </ContentSwap>
      {/* Every step's text, measured invisibly; shorter steps sit at the bottom of the
          area, so any slack goes under the art rather than above the dots. */}
      <View
        style={styles.measure}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {steps.map((s, i) => (
          <View
            key={s.title}
            style={styles.measured}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              setHeights((prev) => (prev[i] === h ? prev : Object.assign([...prev], { [i]: h })));
            }}
          >
            <StepText step={s} number={i + 1} />
          </View>
        ))}
      </View>
      <View
        style={styles.dots}
        accessible
        accessibilityLabel={`Step ${index + 1} of ${steps.length}`}
      >
        {steps.map((s, i) => (
          <Dot key={s.title} active={i === index} />
        ))}
      </View>
    </SheetScreen>
  );
}

/** A step's numbered title, explanation and optional small print. */
function StepText({ step, number }: { step: GuideStep; number: number }) {
  const styles = useStyles();
  return (
    <>
      <Text style={styles.title} accessibilityRole="header">
        {number}. {step.title}
      </Text>
      <Text style={styles.body}>{step.body}</Text>
      {step.note ? <Text style={styles.note}>{step.note}</Text> : null}
    </>
  );
}

/** A page dot that widens into a short bar when active. */
function Dot({ active }: { active: boolean }) {
  const styles = useStyles();
  const style = useAnimatedStyle(() => ({
    // The dot reshapes in place, so ease-in-out.
    width: withTiming(active ? 18 : 6, { duration: DURATION.fast, easing: EASE.inOut }),
    opacity: withTiming(active ? 1 : 0.35, { duration: DURATION.fast, easing: EASE.ease }),
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

const useStyles = makeStyles((c) => ({
  art: {
    height: GUIDE_ART_HEIGHT,
    // Pull up into the sheet's top padding; the art has its own breathing room.
    marginTop: -12,
    marginHorizontal: -20,
    marginBottom: 8,
    overflow: 'hidden',
  },
  textArea: {
    justifyContent: 'flex-end',
  },
  measure: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  measured: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  title: {
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  body: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 23,
  },
  note: {
    marginTop: 12,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    opacity: 0.8,
  },
  dots: {
    marginTop: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  dot: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.text,
  },
}));
