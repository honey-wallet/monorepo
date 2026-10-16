import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  Keyframe,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { SkeletonList } from '@/components/motion/Skeleton';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { EmptyState } from '@/components/wallet/parts';
import { SHEET, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

type Stage = 'steps' | 'searching' | 'none';
const STAGES: Stage[] = ['steps', 'searching', 'none'];
const SEARCH_MS = 2000;

type Device = 'ledger' | 'keystone';

/** How each device connects: Ledger over Bluetooth, Keystone by QR code. */
const DEVICES: Record<Device, { name: string; steps: { title: string; hint: string }[] }> = {
  ledger: {
    name: 'Ledger',
    steps: [
      { title: 'Unlock your Ledger', hint: 'Enter your PIN on the device itself.' },
      { title: 'Open the Ethereum or Bitcoin app', hint: 'Pick the app for the coins you hold.' },
      { title: 'Keep Bluetooth on', hint: 'Stay close to your phone while it connects.' },
    ],
  },
  keystone: {
    name: 'Keystone',
    steps: [
      { title: 'Unlock your Keystone', hint: 'Enter your PIN on the device itself.' },
      {
        title: 'Open Connect Software Wallet',
        hint: 'Find it in the menu, then choose a generic wallet.',
      },
      { title: 'Scan its QR code', hint: 'Hold your phone up to the code on its screen.' },
    ],
  },
};

/**
 * Steps rise in one after another (40ms apart) after the headline: a rare setup flow,
 * so they get the longer 400ms on a strong ease-out. Under Reduce Motion only the fade
 * remains (Reanimated would otherwise skip it entirely).
 */
const rise = (i: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(DURATION.fast)
        .delay(DURATION.stagger * (i + 2))
        .reduceMotion(ReduceMotion.Never)
    : new Keyframe({
        0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
        100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
      })
        .duration(DURATION.verySlow)
        .delay(DURATION.stagger * (i + 2));

/**
 * Connect a hardware wallet. Ledger (`device=ledger`, the default): steps, a short
 * Bluetooth search, then the result. Keystone: steps, then the QR scanner. Demo only.
 */
export default function HardwareWalletSheet() {
  const reduceMotion = useReducedMotion();
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<{ device?: Device }>();
  const device = params.device === 'keystone' ? 'keystone' : 'ledger';
  const { name, steps } = DEVICES[device];
  const [stage, setStage] = useState<Stage>('steps');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const search = () => {
    tap();
    setStage('searching');
    clearTimeout(timer.current);
    // TODO: real Bluetooth discovery; for now every search comes back empty.
    timer.current = setTimeout(() => setStage('none'), SEARCH_MS);
  };

  const cancel = () => {
    tap();
    clearTimeout(timer.current);
    setStage('steps');
  };

  return (
    // Each stage keeps its own button so it slides in with that stage's content.
    <SheetScreen>
      <View style={styles.hero}>
        <View style={styles.tile}>
          <Icon name="hardware" size={26} color={c.accentText} />
        </View>
        <TextsReveal
          id="hardware"
          align="center"
          first={<Text style={styles.title}>Connect {name}</Text>}
          second={
            <Text style={styles.subtitle}>
              Approve every transaction on your {name}. Your keys never touch your phone.
            </Text>
          }
        />
      </View>

      <ContentSwap id={stage} index={STAGES.indexOf(stage)}>
        {stage === 'steps' && (
          <View>
            <View style={styles.steps}>
              {steps.map((step, i) => (
                <Animated.View
                  key={step.title}
                  entering={rise(i, reduceMotion)}
                  style={styles.step}
                >
                  <View style={styles.number}>
                    <Text style={styles.numberLabel}>{i + 1}</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.stepTitle}>{step.title}</Text>
                    <Text style={styles.stepHint}>{step.hint}</Text>
                  </View>
                </Animated.View>
              ))}
            </View>
            {device === 'keystone' ? (
              <PillButton
                label="Scan QR code"
                onPress={() => {
                  tap();
                  router.replace('/scan');
                }}
                style={styles.cta}
              />
            ) : (
              <PillButton label="Search for devices" onPress={search} style={styles.cta} />
            )}
          </View>
        )}

        {stage === 'searching' && (
          <View>
            <View style={styles.searching}>
              <Spinner />
              <Text style={styles.searchingLabel}>Looking for nearby devices…</Text>
            </View>
            <SkeletonList count={2} iconRadius={12} trailing={false} />
            <PillButton label="Cancel" variant="secondary" onPress={cancel} style={styles.cta} />
          </View>
        )}

        {stage === 'none' && (
          <View>
            <EmptyState
              icon="hardware"
              title={`No ${name} found`}
              hint="Check that your device is unlocked, nearby and has Bluetooth on."
            />
            <PillButton label="Try again" onPress={search} />
          </View>
        )}
      </ContentSwap>
    </SheetScreen>
  );
}

/** A honey arc turning in place while the search runs. */
function Spinner() {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    // Constant motion is linear; a quicker turn makes the search feel faster.
    turn.value = withRepeat(withTiming(360, { duration: 750, easing: Easing.linear }), -1);
    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  return <Animated.View accessibilityLabel="Searching" style={[styles.spinner, style]} />;
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  hero: {
    alignItems: 'center',
    gap: 14,
  },
  tile: {
    width: 60,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  steps: {
    marginTop: 22,
    gap: 16,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  number: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  numberLabel: {
    color: c.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  stepTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  stepHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
  searching: {
    marginTop: 24,
    marginBottom: 8,
    alignItems: 'center',
    gap: 12,
  },
  spinner: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: c.raised,
    borderTopColor: c.primary,
  },
  searchingLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
}));
