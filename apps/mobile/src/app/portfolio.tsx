import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { TextSwap } from '@/components/motion/TextSwap';
import { ActionFooter } from '@/components/wallet/ActionFooter';
import { PriceChart } from '@/components/wallet/PriceChart';
import { PushedScreen } from '@/components/wallet/parts';
import {
  BALANCE,
  BALANCE_CHANGE,
  formatUsd,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
  TOKEN_INFO,
} from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const CHART_HEIGHT = 230;
type Scope = 'all' | 'month' | 'week';

/** Portfolio value over time, after Uniswap's: scrub the chart, switch ranges. */
export default function PortfolioScreen() {
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>('all');

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
          <Text style={styles.changeAmount}>
            {formatUsd(Math.abs(delta))} ({Math.abs(pct).toFixed(2)}%)
          </Text>
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
        <View style={styles.perfCard}>
          <Text style={styles.perfLabel}>Total return</Text>
          <Signed value={unrealized + realized} large />
          <View style={styles.perfSplit}>
            <View style={styles.flex}>
              <Text style={styles.perfLabel}>Unrealized</Text>
              <Signed value={unrealized} />
            </View>
            <View style={styles.perfDivider} />
            <View style={styles.flex}>
              <Text style={styles.perfLabel}>Realized</Text>
              <Signed value={realized} />
            </View>
          </View>
        </View>
      </View>
    </PushedScreen>
  );
}

/** A dollar amount with its up/down triangle; `large` for the headline figure. */
function Signed({ value, large }: { value: number; large?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.signed}>
      {Math.abs(value) >= 0.005 && (
        <Icon
          name={value < 0 ? 'down' : 'up'}
          size={large ? 12 : 9}
          color={value < 0 ? c.error : c.success}
        />
      )}
      <Text style={[styles.value, large && styles.valueLarge]}>{formatUsd(Math.abs(value))}</Text>
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
    color: c.text,
    opacity: 0.85,
    fontSize: 15,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  chart: {
    marginTop: 22,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 26,
    paddingTop: 18,
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
  perfSplit: {
    marginTop: 14,
    paddingTop: 14,
    flexDirection: 'row',
    gap: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.divider,
  },
  perfDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  valueLarge: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: -0.5,
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
}));
