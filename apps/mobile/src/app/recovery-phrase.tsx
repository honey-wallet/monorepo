import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  Keyframe,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { Checkbox } from '@/components/motion/Checkbox';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { PushedScreen, SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';

// DEMO DATA: a placeholder phrase for UI review only. It isn't tied to any real wallet;
// the real phrase will be read from the device's secure storage and never leaves it.
const WORDS = [
  'orbit',
  'velvet',
  'harbor',
  'pencil',
  'lunar',
  'copper',
  'galaxy',
  'breeze',
  'timber',
  'salmon',
  'quiz',
  'meadow',
];
const HALF = WORDS.length / 2;

// Words rise in one after another, 40ms apart. Revealing the phrase is a rare,
// first-time moment, so each word may take the longer 400ms on a strong ease-out.
// Under Reduce Motion the rise is dropped and only the fade remains (gentler, not
// zero): Reanimated would otherwise skip the entrance entirely.
const rise = (index: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(DURATION.fast)
        .delay(index * DURATION.stagger)
        .reduceMotion(ReduceMotion.Never)
    : new Keyframe({
        0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
        100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
      })
        .duration(DURATION.verySlow)
        .delay(index * DURATION.stagger);

const panelIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: 40 }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  }).duration(DURATION.medium),
);

const panelOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: 40 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

/** Shows the recovery phrase, but only after a "view this in private" warning. */
export default function RecoveryPhraseScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const [warning, setWarning] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [writtenDown, setWrittenDown] = useState(false);

  const view = () => {
    tap();
    setWarning(false);
    setRevealed(true);
  };

  const close = () => {
    tap();
    goBackOr('/settings');
  };

  const toggleHidden = () => {
    tap();
    if (revealed) setRevealed(false);
    else setWarning(true);
  };

  const reduceMotion = useReducedMotion();
  const column = (start: number) => (
    <View style={styles.column}>
      {WORDS.slice(start, start + HALF).map((word, i) => (
        <View key={word} style={styles.wordSlot}>
          {revealed ? (
            <Animated.View entering={rise(start + i, reduceMotion)} style={styles.word}>
              <Text style={styles.index}>{start + i + 1}</Text>
              <Text style={styles.wordText}>{word}</Text>
            </Animated.View>
          ) : (
            <SkeletonBar width="100%" height={12} radius={6} />
          )}
        </View>
      ))}
    </View>
  );

  return (
    <PushedScreen
      title="Recovery phrase"
      fallback="/settings"
      scroll={false}
      contentStyle={styles.content}
      // The privacy warning covers the whole screen, header included, until dismissed.
      overlay={
        warning ? (
          <>
            <Animated.View
              entering={FadeIn.duration(DURATION.fast)}
              exiting={FadeOut.duration(DURATION.fast)}
              style={styles.scrim}
            >
              <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close" />
            </Animated.View>
            <Animated.View
              entering={panelIn()}
              exiting={panelOut()}
              style={[styles.panel, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}
            >
              <View style={[styles.warnTile, { backgroundColor: `${c.error}22` }]}>
                <Icon name="warning" size={24} color={c.error} />
              </View>
              <Text style={styles.panelTitle}>View this in a private place</Text>
              <Text style={styles.panelBody}>
                Anyone who knows your recovery phrase can access your wallet and funds.
              </Text>
              <View style={styles.buttons}>
                <PillButton
                  label="Close"
                  variant="secondary"
                  onPress={close}
                  style={styles.flexButton}
                />
                <PillButton label="View" onPress={view} style={styles.flexButton} />
              </View>
            </Animated.View>
          </>
        ) : null
      }
    >
      <View style={styles.card} accessibilityLabel={revealed ? WORDS.join(' ') : 'Hidden'}>
        {column(0)}
        {column(HALF)}
      </View>

      <View style={styles.tip}>
        <Icon name="book" size={18} color={c.textSecondary} />
        <Text style={styles.tipText}>
          We suggest writing this on a piece of paper and storing it somewhere safe.
        </Text>
      </View>

      {revealed ? (
        <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.confirm}>
          <Checkbox
            label="I've written it down somewhere safe"
            checked={writtenDown}
            onChange={setWrittenDown}
          />
        </Animated.View>
      ) : null}

      {!warning ? (
        <PressableScale
          accessibilityRole="button"
          onPress={toggleHidden}
          scaleTo={0.97}
          style={styles.hide}
        >
          <IconSwap name={revealed ? 'eyeSlash' : 'eye'} size={18} color={c.text} />
          <TextSwap text={revealed ? 'Hide' : 'Show'} style={styles.hideLabel} />
        </PressableScale>
      ) : null}
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  card: {
    // A solid card on the page, like every other card (no outline).
    flexDirection: 'row',
    gap: 28,
    paddingVertical: 26,
    paddingHorizontal: 28,
    borderRadius: 24,
    backgroundColor: c.card,
  },
  column: {
    flex: 1,
  },
  confirm: {
    marginTop: 20,
  },
  wordSlot: {
    height: 32,
    justifyContent: 'center',
  },
  word: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  index: {
    width: 20,
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  wordText: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  tip: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 18,
    backgroundColor: c.raised,
  },
  tipText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  hide: {
    marginTop: 18,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: c.raised,
  },
  hideLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  fill: {
    flex: 1,
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 36,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.card,
  },
  warnTile: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelTitle: {
    marginTop: 18,
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  panelBody: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  buttons: {
    marginTop: 26,
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  flexButton: {
    flex: 1,
  },
}));
