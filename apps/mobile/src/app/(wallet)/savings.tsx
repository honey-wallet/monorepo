import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { TabScreen } from '@/components/wallet/TabScreen';
import { tap } from '@/lib/haptics';
import { type Jar, jarProgress, usdValue, useJars } from '@/lib/jars';
import { EARN, formatAmount, formatUsd, VAULTS } from '@/lib/mock-wallet';
import { useSectionPrefs } from '@/lib/section-prefs';
import { showDemoToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const STABLE = new Set(['USDC', 'USDT']);

/** A jar amount: dollars for stablecoins, else the token amount with its symbol. */
function formatJarAmount(symbol: string, amount: number) {
  if (STABLE.has(symbol)) return formatUsd(amount);
  return `${formatAmount(amount)} ${symbol}`;
}

/** The piggy bank: Honey Jars for crypto set aside for goals, and ways to earn on it. */
export default function SavingsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const jars = useJars();
  const { savingsShowEarn } = useSectionPrefs();
  const saved = jars.reduce((sum, j) => sum + usdValue(j.symbol, j.saved), 0);
  const goal = jars.reduce((sum, j) => sum + usdValue(j.symbol, j.goal), 0);

  const newJar = () => {
    tap();
    router.push('/jar-new');
  };

  return (
    <TabScreen
      title="Savings"
      right={
        <HeaderActions
          settingsLabel="Savings settings"
          onSettings={() =>
            router.push({ pathname: '/section-settings', params: { section: 'savings' } })
          }
        />
      }
    >
      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <View style={styles.flex}>
            <Text style={styles.summaryLabel}>Total saved</Text>
            <Text style={styles.summaryValue}>{formatUsd(saved)}</Text>
            <Text style={styles.summaryHint}>
              {jars.length
                ? `of ${formatUsd(goal)} across ${jars.length} ${jars.length === 1 ? 'jar' : 'jars'}`
                : 'Start a jar to save toward a goal'}
            </Text>
          </View>
          <HoneyLogo variant="mark" height={44} />
        </View>
        {jars.length ? <ProgressBar progress={goal ? saved / goal : 0} /> : null}
        <PillButton label="New jar" onPress={newJar} style={styles.newJar} />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.section}>Your jars</Text>
        {jars.length ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="New jar"
            hitSlop={10}
            scaleTo={0.9}
            onPress={newJar}
            style={styles.add}
          >
            <Icon name="plus" size={14} color={c.accentText} />
          </PressableScale>
        ) : null}
      </View>
      {jars.length ? (
        <View style={styles.jars}>
          {jars.map((jar) => (
            <JarCard key={jar.id} jar={jar} />
          ))}
        </View>
      ) : (
        <EmptyState
          icon="target"
          title="No jars yet"
          hint="Set crypto aside for a goal and keep it out of your everyday balance."
        />
      )}

      {savingsShowEarn && (
        <>
          <Text style={[styles.section, styles.earnHeading]}>Start earning</Text>
          <View style={styles.jars}>
            {EARN.map(({ symbol, apy }) => (
              <PressableScale
                key={symbol}
                accessibilityRole="button"
                accessibilityLabel={`Earn ${apy.toFixed(2)}% APY with ${symbol}`}
                scaleTo={0.98}
                onPress={() => {
                  tap();
                  router.push({ pathname: '/earn/[symbol]', params: { symbol } });
                }}
                style={[styles.card, styles.earnCard]}
              >
                <TokenIcon symbol={symbol} size={40} />
                <View style={styles.flex}>
                  <Text style={styles.cardTitle}>Earn with {symbol}</Text>
                  <Text style={styles.cardHint}>No lockup, withdraw anytime</Text>
                </View>
                <Text style={styles.apy}>{apy.toFixed(2)}% APY</Text>
                <Icon name="chevronRight" size={13} color={c.textSecondary} />
              </PressableScale>
            ))}
          </View>
        </>
      )}
    </TabScreen>
  );
}

function JarCard({ jar }: { jar: Jar }) {
  const styles = useStyles();
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const vault = VAULTS[jar.symbol];
  const progress = jarProgress(jar);

  const press = () => {
    tap();
    if (vault) router.push({ pathname: '/earn/[symbol]', params: { symbol: jar.symbol } });
    else setOpen((v) => !v);
  };

  return (
    <View style={styles.card}>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={vault ? undefined : { expanded: open }}
        scaleTo={0.98}
        onPress={press}
      >
        <View style={styles.jarTop}>
          <TokenIcon symbol={jar.symbol} size={40} />
          <View style={styles.flex}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {jar.name}
            </Text>
            <Text style={styles.cardHint}>
              {formatJarAmount(jar.symbol, jar.saved)} of {formatJarAmount(jar.symbol, jar.goal)}
            </Text>
          </View>
          <Text style={styles.percent}>{Math.round(progress * 100)}%</Text>
          {vault ? (
            <Icon name="chevronRight" size={13} color={c.textSecondary} />
          ) : (
            <AccordionChevron open={open} size={12} color={c.textSecondary} />
          )}
        </View>
        <ProgressBar progress={progress} />
        {vault ? (
          <Text style={styles.jarEarn}>
            Earn <Text style={styles.apy}>{vault.apy.toFixed(2)}% APY</Text> on this jar
          </Text>
        ) : null}
      </PressableScale>
      {vault ? null : (
        <Accordion open={open}>
          <View style={styles.actions}>
            <PillButton
              label="Add funds"
              onPress={() => showDemoToast('nothing was added')}
              style={styles.action}
            />
            <PillButton
              label="Withdraw"
              variant="secondary"
              onPress={() => showDemoToast('nothing was withdrawn')}
              style={styles.action}
            />
          </View>
        </Accordion>
      )}
    </View>
  );
}

/** A honey bar that fills to `progress` (0–1) on the smooth ease-out curve. */
function ProgressBar({ progress }: { progress: number }) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(0);
  useEffect(() => {
    fill.value = withTiming(Math.min(Math.max(progress, 0), 1), {
      duration: reduceMotion ? 0 : DURATION.verySlow * 2,
      easing: EASE.smoothOut,
    });
  }, [progress, reduceMotion, fill]);
  const style = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, style]} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  summary: {
    padding: 20,
    borderRadius: 24,
    backgroundColor: c.accentSurface,
  },
  summaryTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  summaryLabel: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '500',
  },
  summaryValue: {
    marginTop: 4,
    color: c.text,
    fontSize: 36,
    fontWeight: '600',
    letterSpacing: -0.8,
  },
  summaryHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  newJar: {
    marginTop: 16,
  },
  sectionHeader: {
    marginTop: 28,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  section: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  earnHeading: {
    marginTop: 28,
    marginBottom: 12,
  },
  add: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  jars: {
    gap: 10,
  },
  card: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  earnCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  jarTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  cardHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  percent: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  apy: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  jarEarn: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 14,
  },
  track: {
    marginTop: 14,
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: c.raised,
  },
  fill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: c.primary,
  },
  actions: {
    paddingTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  action: {
    flex: 1,
    height: 44,
  },
}));
