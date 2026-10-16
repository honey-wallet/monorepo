import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { RESIZE } from '@/components/motion/resize';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { TextSoftSwap } from '@/components/motion/TextSoftSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { ActionFooter } from '@/components/wallet/ActionFooter';
import { DonutChart } from '@/components/wallet/DonutChart';
import { PriceChart } from '@/components/wallet/PriceChart';
import { PushedScreen } from '@/components/wallet/parts';
import {
  BALANCE,
  BALANCE_CHANGE,
  type Chain,
  chainSymbol,
  formatUsd,
  HOLDINGS,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
  TOKEN_INFO,
  TOKENS,
} from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

const CHART_HEIGHT = 190;
type Scope = 'all' | 'month' | 'week';
type Grouping = 'Tokens' | 'Networks';

/** Each held token's colour, matching its logo; a network takes its native token's. */
const SEGMENT_COLOR: Record<string, string> = {
  ETH: '#627EEA',
  BTC: '#F7931A',
  USDC: '#2775CA',
  SOL: '#9945FF',
  TRX: '#EB0029',
  XRP: '#8C96A3',
};
/** One segment per token you hold, largest first; a network maps onto its native token. */
const SEGMENT_IDS = TOKENS.filter((t) => !t.hidden && t.usd > 0)
  .sort((a, b) => b.usd - a.usd)
  .map((t) => t.symbol);
const CHAIN_OF: Record<string, Chain> = Object.fromEntries(
  HOLDINGS.map((h) => [chainSymbol(h.chain), h.chain]),
);

/** Your balance split by token or by network, as `{ id, label, value }` per segment. */
function allocation(grouping: Grouping) {
  return SEGMENT_IDS.map((id) => {
    if (grouping === 'Tokens') {
      return { id, label: id, value: TOKENS.find((t) => t.symbol === id)?.usd ?? 0 };
    }
    const chain = CHAIN_OF[id];
    const value = HOLDINGS.filter((h) => h.chain === chain).reduce((s, h) => s + h.usd, 0);
    return { id, label: chain ?? id, value: chain ? value : 0 };
  });
}

/** Portfolio value over time, after Uniswap's: scrub the chart, switch ranges. */
export default function PortfolioScreen() {
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [grouping, setGrouping] = useState<Grouping>('Tokens');
  const shares = allocation(grouping);
  const sharesTotal = shares.reduce((s, x) => s + x.value, 0) || 1;

  const todayPct = (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;
  const data = series('portfolio', range, BALANCE, range === '1D' ? todayPct : undefined);
  const value = scrub === null ? BALANCE : data[scrub];
  const delta = value - data[0];
  const pct = (delta / data[0]) * 100;
  const color = delta < 0 ? c.error : c.success;

  // Placeholder performance, scaled by the chosen window.
  const factor = scope === 'all' ? 1 : scope === 'month' ? 0.4 : 0.15;
  const unrealized =
    Object.values(TOKEN_INFO).reduce((s, t) => s + t.performance.unrealized, 0) * factor;
  const realized =
    Object.values(TOKEN_INFO).reduce((s, t) => s + t.performance.realized, 0) * factor;

  const sharePortfolio = () => router.push({ pathname: '/share-portfolio', params: { range } });

  return (
    <PushedScreen
      footer={
        <ActionFooter
          actions={[
            { label: 'Share', tone: 'primary', onPress: sharePortfolio },
            { label: 'Deposit', tone: 'secondary', onPress: () => router.push('/balance') },
          ]}
        />
      }
      title={
        <>
          <Avatar name={profile.name} size={30} uri={profile.photo} seed={profile.avatarSeed} />
          <Text style={styles.name}>{profile.name}</Text>
        </>
      }
      right={
        <ActionMenu
          actions={[
            {
              label: 'Share portfolio',
              icon: 'link',
              onPress: sharePortfolio,
            },
            {
              label: 'Balances and activity',
              icon: 'chart',
              onPress: () => router.push('/settings-balances'),
            },
            {
              label: 'Refresh prices',
              icon: 'history',
              onPress: () => showToast('Prices refreshed'),
            },
          ]}
        />
      }
    >
      <View style={styles.gutter}>
        {scrub === null ? (
          <NumberPopIn
            value={formatUsd(value)}
            style={styles.balance}
            fractionStyle={styles.cents}
          />
        ) : (
          <Text style={styles.balance}>{formatUsd(value)}</Text>
        )}
        <View style={styles.changeRow}>
          <Icon name={delta < 0 ? 'down' : 'up'} size={9} color={color} />
          {/* Soft cross-fade when the range changes; plain while scrubbing. */}
          {scrub === null ? (
            <TextSoftSwap
              text={`${formatUsd(Math.abs(delta))} (${Math.abs(pct).toFixed(2)}%)`}
              style={styles.changeAmount}
            />
          ) : (
            <Text style={styles.changeAmount}>
              {formatUsd(Math.abs(delta))} ({Math.abs(pct).toFixed(2)}%)
            </Text>
          )}
          <TextSwap text={scrub === null ? RANGE_LABEL[range] : ''} style={styles.changeLabel} />
        </View>
      </View>

      <View style={styles.chart}>
        <PriceChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
      </View>
      <View style={styles.ranges}>
        <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
      </View>

      <View style={[styles.section, styles.gutter]}>
        <View style={styles.sectionHeader}>
          <Text style={styles.heading}>Performance</Text>
          <MenuDropdown<Scope>
            options={[
              { value: 'all', label: 'All time', icon: 'history' },
              { value: 'month', label: 'Past month', icon: 'chart' },
              { value: 'week', label: 'Past week', icon: 'trendUp' },
            ]}
            value={scope}
            onChange={setScope}
            triggerLabel={scope === 'all' ? 'All' : scope === 'month' ? 'Month' : 'Week'}
          />
        </View>
        {/* One row, so Allocation fits on screen without scrolling. */}
        <Animated.View layout={RESIZE} style={[styles.perfCard, styles.perfRow]}>
          <View style={styles.flex}>
            <Text style={styles.perfLabel}>Total return</Text>
            <Signed value={unrealized + realized} strong />
          </View>
          <View style={styles.perfDivider} />
          <View style={styles.flex}>
            <Text style={styles.perfLabel}>Unrealized</Text>
            <Signed value={unrealized} />
          </View>
          <View style={styles.perfDivider} />
          <View style={styles.flex}>
            <Text style={styles.perfLabel}>Realized</Text>
            <Signed value={realized} />
          </View>
        </Animated.View>

        {/* Allocation: switching the grouping morphs every segment to its new share. */}
        <View style={[styles.sectionHeader, styles.allocationHeader]}>
          <Text style={styles.heading}>Allocation</Text>
          <SegmentedTabs<Grouping>
            options={['Tokens', 'Networks']}
            value={grouping}
            onChange={setGrouping}
          />
        </View>
        <Animated.View layout={RESIZE} style={[styles.perfCard, styles.allocation]}>
          <DonutChart
            size={124}
            segments={shares.map((x) => ({
              id: x.id,
              value: x.value,
              color: SEGMENT_COLOR[x.id] ?? c.textSecondary,
            }))}
          >
            <Text style={styles.donutTotal}>{formatUsd(BALANCE)}</Text>
            <Text style={styles.donutLabel}>Total</Text>
          </DonutChart>
          <View style={styles.legend}>
            {shares
              .filter((x) => x.value > 0)
              .map((x) => (
                <Animated.View
                  key={x.id}
                  // Exits are shorter than entries: the change has already happened.
                  entering={FadeIn.duration(DURATION.fast)}
                  exiting={FadeOut.duration(DURATION.quick)}
                  layout={RESIZE}
                  style={styles.legendRow}
                >
                  <View style={[styles.legendDot, { backgroundColor: SEGMENT_COLOR[x.id] }]} />
                  <View style={styles.flex}>
                    <TextSoftSwap text={x.label} style={styles.legendLabel} />
                  </View>
                  <TextSoftSwap
                    text={`${((x.value / sharesTotal) * 100).toFixed(0)}%`}
                    style={styles.legendValue}
                    align="end"
                  />
                </Animated.View>
              ))}
          </View>
        </Animated.View>
      </View>
    </PushedScreen>
  );
}

/** A dollar amount with its up/down triangle; `strong` for the total. */
function Signed({ value, strong }: { value: number; strong?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.signed}>
      {Math.abs(value) >= 0.005 && (
        <Icon name={value < 0 ? 'down' : 'up'} size={9} color={value < 0 ? c.error : c.success} />
      )}
      <TextSoftSwap
        text={formatUsd(Math.abs(value))}
        style={[styles.value, strong && styles.valueStrong]}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  gutter: {
    paddingHorizontal: 20,
  },
  name: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  balance: {
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
  },
  cents: {
    color: c.textSecondary,
  },
  changeRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  changeAmount: {
    // 85% text, as a colour: an opacity here would fight the soft swap's fade.
    color: `${c.text}D9`,
    fontSize: 15,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  chart: {
    marginTop: 16,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: c.divider,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: {
    color: c.textSecondary,
    fontSize: 17,
  },
  flex: {
    flex: 1,
  },
  perfCard: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  perfLabel: {
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 14,
  },
  perfRow: {
    flexDirection: 'row',
    gap: 12,
  },
  perfDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  valueStrong: {
    fontWeight: '600',
  },
  signed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  value: {
    color: c.text,
    fontSize: 16,
  },
  allocationHeader: {
    marginTop: 14,
  },
  allocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  donutTotal: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  donutLabel: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 12,
  },
  legend: {
    flex: 1,
    gap: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    color: c.text,
    fontSize: 14,
  },
  legendValue: {
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
}));
