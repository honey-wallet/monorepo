import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { EmptyState, Sparkline } from '@/components/wallet/parts';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  BALANCE,
  BALANCE_CHANGE,
  formatUsd,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
} from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { showErrorToast } from '@/lib/toast';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';

const CARD_WIDTH = 320;

/**
 * Share your portfolio's performance as an image card. Amounts are hidden by
 * default, so only the percentage change leaves the phone unless you choose otherwise.
 */
export default function SharePortfolioSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const params = useLocalSearchParams<{ range?: Range }>();
  const range = params.range && RANGES.includes(params.range) ? params.range : '1D';
  const [showAmounts, setShowAmounts] = useState(false);
  const [sharing, setSharing] = useState(false);
  const card = useRef<View>(null);
  // The card is drawn from the balance history behind Portfolio's chart.
  const view = useWalletView();
  const loading = useFirstLoad(LOADS.history(view.wallet.id));

  const todayPct = (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;
  const data = series('portfolio', range, BALANCE, range === '1D' ? todayPct : undefined);
  const delta = BALANCE - data[0];
  const pct = (delta / data[0]) * 100;
  const down = delta < 0;
  const period = RANGE_LABEL[range][0].toUpperCase() + RANGE_LABEL[range].slice(1);

  const share = async () => {
    tap();
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        showErrorToast('Sharing unavailable');
        return;
      }
      const uri = await captureRef(card, { format: 'png', quality: 1 });
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: 'Share your portfolio',
        UTI: 'public.png',
      });
    } catch {
      showErrorToast('Couldn’t create image');
    } finally {
      setSharing(false);
    }
  };

  // A wallet with nothing in it has no performance to share.
  if (view.empty) {
    return (
      <SheetScreen title="Share portfolio">
        <EmptyState
          icon="chart"
          title="Nothing to share yet"
          hint="Once you've added money, you can share how your portfolio is doing."
          action={{
            label: 'Add money',
            onPress: () => router.replace({ pathname: '/buy-cash', params: { symbol: 'USDC' } }),
          }}
        />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      title="Share portfolio"
      footer={
        <PillButton
          label={sharing ? 'Preparing…' : 'Share'}
          disabled={sharing || loading}
          onPress={share}
        />
      }
    >
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <SkeletonBar width={28} height={28} radius={14} />
              <SkeletonBar width={110} height={14} />
            </View>
            <View style={styles.skeletonFigures}>
              <SkeletonBar width={70} height={12} />
              <SkeletonBar width={150} height={36} radius={10} />
            </View>
            <View style={styles.chart}>
              <SkeletonChart height={70} />
            </View>
            <View style={styles.skeletonFootnote}>
              <SkeletonBar width={100} height={10} />
            </View>
          </View>
        }
      >
        {/* The card captured into the image; collapsable keeps it a real native view. */}
        <View ref={card} collapsable={false} style={styles.card}>
          <View style={styles.cardHead}>
            <Avatar name={profile.name} size={28} uri={profile.photo} seed={profile.avatarSeed} />
            <Text style={styles.cardName} numberOfLines={1}>
              {profile.name}
            </Text>
            <HoneyLogo variant="mark" height={22} />
          </View>
          <Text style={styles.period}>{period}</Text>
          <View style={styles.pctRow}>
            <Icon name={down ? 'down' : 'up'} size={16} color={down ? c.error : c.success} />
            <Text style={[styles.pct, { color: down ? c.error : c.success }]}>
              {Math.abs(pct).toFixed(2)}%
            </Text>
          </View>
          {showAmounts && (
            <Text style={styles.amounts}>
              {down ? '−' : '+'}
              {formatUsd(Math.abs(delta))} · {formatUsd(BALANCE)} total
            </Text>
          )}
          <View style={styles.chart}>
            <Sparkline data={data} width={CARD_WIDTH - 40} height={70} />
          </View>
          {SHOW_DEMO_LABELS ? (
            <Text style={styles.footnote}>
              Sample data · illustrative values, not wallet performance
            </Text>
          ) : null}
        </View>
      </SkeletonReveal>

      <SheetRow
        title="Show amounts"
        subtitle="Include dollar values, not just the percentage"
        accessory={
          <Toggle
            accessibilityLabel="Show amounts"
            value={showAmounts}
            onValueChange={(on) => {
              tap();
              setShowAmounts(on);
            }}
          />
        }
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    alignSelf: 'center',
    width: CARD_WIDTH,
    marginBottom: 12,
    padding: 20,
    ...radius(24),
    backgroundColor: c.card,
    // In dark mode the card matched the sheet behind it; a hairline gives it an edge.
    borderWidth: 1,
    borderColor: c.divider,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardName: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  period: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 15,
  },
  pctRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pct: {
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -1,
  },
  amounts: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  chart: {
    marginTop: 16,
  },
  footnote: {
    marginTop: 14,
    color: c.textSecondary,
    fontSize: 12,
  },
  // Period line plus the 40pt percentage, so the card keeps its height on reveal.
  skeletonFigures: {
    marginTop: 18,
    height: 70,
    gap: 10,
  },
  skeletonFootnote: {
    marginTop: 14,
    height: 15,
    justifyContent: 'center',
  },
}));
