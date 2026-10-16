import { type Href, Redirect, router } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PillButton } from '@/components/onboarding/PillButton';
import { Progress } from '@/components/wallet/ActivationCard';
import { closeSheet, SheetScreen, SheetText } from '@/components/wallet/Sheet';
import { SuccessPage } from '@/components/wallet/SuccessPage';
import { tap } from '@/lib/haptics';
import {
  completeStep,
  SETUP_REWARD_USD,
  SETUP_STEPS,
  setupComplete,
  useOnboarding,
} from '@/lib/onboarding';
import { makeStyles, useTheme } from '@/theme';

/**
 * Finish setting up: four short steps that make the wallet safe and yours, and $5
 * off network fees for doing them. Shown only once the wallet has money in it, so
 * the reward lands when there's something to spend it on.
 */
export default function SetupSheet() {
  const styles = useStyles();
  const c = useTheme();
  const state = useOnboarding();
  const total = SETUP_STEPS.length;

  // A sheet over Home only; opened on its own (a reloaded deep link), show Home.
  if (!router.canGoBack()) return <Redirect href="/home" />;

  if (setupComplete(state)) {
    return (
      <SheetScreen>
        <SuccessPage
          compact
          title={`$${SETUP_REWARD_USD} off network fees`}
          detail="Your wallet is set up. The credit comes off your next network fees automatically."
          onDone={() => {
            tap();
            closeSheet();
          }}
        />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen title="Finish setting up">
      <View style={styles.head}>
        <Progress done={state.done.length} total={total} size={48} />
        <View style={styles.flex}>
          <Text style={styles.reward}>Get ${SETUP_REWARD_USD} off network fees</Text>
          <Text style={styles.meta}>
            {state.done.length} of {total} done · about 2 minutes
          </Text>
        </View>
      </View>

      <View style={styles.steps}>
        {SETUP_STEPS.map((step) => {
          const done = state.done.includes(step.id);
          return (
            <PressableRow
              key={step.id}
              accessibilityRole="button"
              accessibilityState={{ checked: done }}
              disabled={done}
              onPress={() => {
                tap();
                // DEMO: the step counts as done once opened. With real settings it
                // completes when the backup, Face ID or notifications actually turn on.
                completeStep(step.id);
                router.push(step.href as Href);
              }}
              style={styles.step}
            >
              <View
                style={[
                  styles.check,
                  done && { backgroundColor: c.success, borderColor: c.success },
                ]}
              >
                {done ? <Icon name="check" size={13} color="#FFFFFF" /> : null}
              </View>
              <View style={styles.flex}>
                <Text style={[styles.stepTitle, done && styles.stepDone]}>{step.title}</Text>
                <Text style={styles.meta}>{step.hint}</Text>
              </View>
              {done ? null : <Icon name="chevronRight" size={12} color={c.textSecondary} />}
            </PressableRow>
          );
        })}
      </View>

      <SheetText>
        Up to ${SETUP_REWARD_USD} in network fees on Honey, applied automatically within 30 days of
        finishing. One per person.{' '}
        <Text
          style={styles.link}
          onPress={() => {
            tap();
            router.push('/disclosures');
          }}
        >
          Terms apply
        </Text>
      </SheetText>
      <PillButton label="Later" variant="secondary" onPress={closeSheet} style={styles.later} />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  reward: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  meta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  steps: {
    marginTop: 16,
    marginBottom: 12,
    padding: 4,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  step: {
    minHeight: 64,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: c.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  stepDone: {
    color: c.textSecondary,
    textDecorationLine: 'line-through',
  },
  link: {
    color: c.accentText,
    fontWeight: '600',
  },
  later: {
    marginTop: 16,
  },
}));
