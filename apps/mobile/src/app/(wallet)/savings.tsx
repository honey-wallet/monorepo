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
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { EarningList } from '@/components/wallet/PositionsList';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { TabScreen } from '@/components/wallet/TabScreen';
import { POSITIONS } from '@/lib/collectibles';
import { tap } from '@/lib/haptics';
import { type Jar, jarProgress, usdValue, useJars } from '@/lib/jars';
import { LOADS } from '@/lib/loads';
import { EARN, formatAmount, formatUsd, VAULTS } from '@/lib/mock-wallet';
import { useSectionPrefs } from '@/lib/section-prefs';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const STABLE = new Set(['USDC', 'USDT']);
/** What a jar earns while it waits (its USDC vault's rate). */
const JAR_APY = EARN.find((e) => e.symbol === 'USDC')?.apy ?? 0;

/** A jar amount: dollars for stablecoins, else the token amount with its symbol. */
function formatJarAmount(symbol: string, amount: number) {
  if (STABLE.has(symbol)) return formatUsd(amount);
  return `${formatAmount(amount)} ${symbol}`;
}

/** The piggy bank: Honey Jars for crypto set aside for goals, and ways to earn on it. */
export default function SavingsScreen() {
  const styles = useStyles();
  const c = useTheme();
  // A brand-new wallet hasn't saved anything yet: only the jars it made itself.
  const { empty } = useWalletView();
  const jars = useJars().filter((j) => !(empty && j.demo));
  const { savingsShowEarn } = useSectionPrefs();
  const saved = jars.reduce((sum, j) => sum + usdValue(j.symbol, j.saved), 0);
  const _goal = jars.reduce((sum, j) => sum + usdValue(j.symbol, j.goal), 0);
  const ratesLoading = useFirstLoad(LOADS.earnRates);
  // What's in each jar is read with the rest of your savings positions.
  const jarsLoading = useFirstLoad(LOADS.positions);

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
      {/* Aave-style: what you've put away and what it's growing to is the one big
          number here, then your jars, then where the rest is earning. */}
      <EarningList
        large
        saved={{ usd: saved, apy: JAR_APY }}
        middle={
          <>
            <Text style={[styles.section, styles.sectionHeader]}>Your jars</Text>
            {jars.length ? (
              <SkeletonReveal
                loading={jarsLoading}
                skeleton={
                  <View style={styles.jars}>
                    {jars.map((jar) => (
                      <View key={jar.id} style={styles.card}>
                        <View style={styles.jarTop}>
                          <SkeletonBar width={40} height={40} radius={20} />
                          <View style={styles.skeletonLines}>
                            <SkeletonBar width="50%" height={15} />
                            <SkeletonBar width="65%" height={12} />
                          </View>
                          <SkeletonBar width={34} height={15} />
                        </View>
                        <View style={styles.track} />
                        {VAULTS[jar.symbol] ? (
                          <View style={styles.jarEarnSkeleton}>
                            <SkeletonBar width="55%" height={12} />
                          </View>
                        ) : null}
                      </View>
                    ))}
                  </View>
                }
              >
                <View style={styles.jars}>
                  {jars.map((jar) => (
                    <JarCard key={jar.id} jar={jar} />
                  ))}
                </View>
              </SkeletonReveal>
            ) : (
              // Create new jar sits right under this, so no second button here.
              <EmptyState
                compact
                icon="target"
                title="No jars yet"
                hint="Set crypto aside for a goal and keep it out of your everyday balance."
              />
            )}
            <PressableScale
              accessibilityRole="button"
              scaleTo={0.98}
              onPress={newJar}
              style={styles.newJar}
            >
              <View style={styles.newJarIcon}>
                <Icon name="plus" size={15} color={c.accentText} />
              </View>
              <Text style={styles.newJarLabel}>Create new jar</Text>
            </PressableScale>
          </>
        }
      />

      {savingsShowEarn && (
        <>
          <Text style={[styles.section, styles.earnHeading]}>
            {/* Already earning (a position or a jar): it's more, not a first step. */}
            {(!empty && POSITIONS.length) || saved > 0 ? 'Earn more' : 'Start earning'}
          </Text>
          <SkeletonReveal
            loading={ratesLoading}
            skeleton={
              <View style={styles.jars}>
                {EARN.map(({ symbol }) => (
                  <View key={symbol} style={[styles.card, styles.earnCard]}>
                    <SkeletonBar width={40} height={40} radius={20} />
                    <View style={styles.skeletonLines}>
                      <SkeletonBar width="55%" height={15} />
                      <SkeletonBar width="75%" height={12} />
                    </View>
                    <SkeletonBar width={72} height={15} />
                  </View>
                ))}
              </View>
            }
          >
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
          </SkeletonReveal>
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
              onPress={() => {
                tap();
                router.push({ pathname: '/jar-move', params: { id: jar.id, mode: 'add' } });
              }}
              style={styles.action}
            />
            <PillButton
              label="Withdraw"
              variant="secondary"
              onPress={() => {
                tap();
                router.push({ pathname: '/jar-move', params: { id: jar.id, mode: 'withdraw' } });
              }}
              style={styles.action}
            />
          </View>
        </Accordion>
      )}
    </View>
  );
}

/**
 * A honey bar that fills to `progress` (0–1). Savings is opened often, so the fill is
 * short (300ms, strong ease-out) and grows with a transform rather than its width, so
 * it never relayouts. Under Reduce Motion it's simply drawn at its value.
 */
function ProgressBar({ progress }: { progress: number }) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(0);
  useEffect(() => {
    fill.value = withTiming(Math.min(Math.max(progress, 0), 1), {
      duration: reduceMotion ? 0 : DURATION.slow,
      easing: EASE.smoothOut,
    });
  }, [progress, reduceMotion, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
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
  sectionHeader: {
    marginTop: 12,
    marginBottom: 8,
  },
  // The same quiet label as "Positions" below, so the page has one hierarchy.
  section: {
    color: c.textSecondary,
    fontSize: 15,
  },
  earnHeading: {
    marginTop: 28,
    marginBottom: 12,
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
  skeletonLines: {
    flex: 1,
    gap: 8,
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
  // jarEarn's 14pt line box, with its margin.
  jarEarnSkeleton: {
    marginTop: 10,
    height: 17,
    justifyContent: 'center',
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
    transformOrigin: 'left',
    backgroundColor: c.primary,
  },
  // A quiet row under the jars: a honey + and the label, on the same grey as the cards.
  newJar: {
    marginTop: 10,
    height: 56,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  newJarIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  newJarLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
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
